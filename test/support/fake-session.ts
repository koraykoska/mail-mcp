import {
  capabilityMatches,
  hasExactCapability as exactCapability,
} from '../../src/imap/capabilities.js';
import { MailError } from '../../src/errors.js';
import type { CompiledSearch } from '../../src/imap/search.js';
import type { SortKey } from '../../src/imap/sort.js';
import type { ThreadNode } from '../../src/mime/thread.js';
import type {
  AclEntry,
  BodyNode,
  FetchedPart,
  FlagUpdate,
  ImapSession,
  MailboxChange,
  MailboxInfo,
  MailboxTree,
  MessageSummary,
  OpenMailbox,
  QuotaInfo,
  StatusInfo,
  WaitResult,
} from '../../src/imap/session.js';

export interface StoredMessage {
  uid: number;
  raw: Buffer;
  flags: string[];
  internalDate: string;
  subject?: string;
  from?: string;
  size: number;
}

export interface StoredMailbox {
  path: string;
  flags: string[];
  specialUse?: string;
  subscribed: boolean;
  uidValidity: string;
  uidNext: number;
  messages: StoredMessage[];
}

export class FakeSession implements ImapSession {
  readonly capabilities = new Map<string, boolean | number>();
  readonly boxes = new Map<string, StoredMailbox>();
  serverInfo: Record<string, string> | null = { name: 'fake', version: '1' };
  greetingText = 'fake ready';
  failNext = false;
  connected = false;
  idleSupported = true;
  changes: MailboxChange[] = [];

  constructor(
    capabilities: string[] = [
      'IMAP4rev1',
      'MOVE',
      'UIDPLUS',
      'SORT',
      'IDLE',
      'QUOTA',
      'NAMESPACE',
      'ID',
    ],
  ) {
    for (const capability of capabilities) {
      this.capabilities.set(capability, true);
    }
    this.ensure('INBOX');
    this.ensure('Sent', '\\Sent');
    this.ensure('Trash', '\\Trash');
    this.ensure('Drafts', '\\Drafts');
  }

  hasCapability(name: string): boolean {
    return capabilityMatches(this.capabilities.keys(), name);
  }

  hasExactCapability(name: string): boolean {
    return exactCapability(this.capabilities.keys(), name);
  }

  condstoreEnabled(): boolean {
    return this.hasCapability('CONDSTORE') || this.hasCapability('QRESYNC');
  }

  serverId(): Record<string, string> | null {
    return this.hasCapability('ID') ? this.serverInfo : null;
  }

  greeting(): string | undefined {
    return this.greetingText;
  }

  async connect(): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new MailError('CONNECTION_FAILED', 'fake connection refused');
    }
    this.connected = true;
  }

  async logout(): Promise<void> {
    this.connected = false;
  }

  close(): void {
    this.connected = false;
  }

  async namespaces() {
    return {
      personal: [{ prefix: '', delimiter: '/' }],
      other: [],
      shared: [],
    };
  }

  async quota(): Promise<QuotaInfo | null> {
    if (!this.hasCapability('QUOTA')) {
      return null;
    }
    return { path: '', resources: [{ name: 'STORAGE', used: 10, limit: 100 }] };
  }

  async listMailboxes(options?: { subscribedOnly?: boolean }): Promise<MailboxInfo[]> {
    return [...this.boxes.values()]
      .filter((box) => (options?.subscribedOnly ? box.subscribed : true))
      .map((box) => this.info(box));
  }

  async listTree(): Promise<MailboxTree> {
    return {
      folders: [...this.boxes.values()].map((box) => ({
        path: box.path,
        name: box.path,
        delimiter: '/',
        flags: box.flags,
        specialUse: box.specialUse,
        subscribed: box.subscribed,
        folders: [],
      })),
    };
  }

  async status(path: string): Promise<StatusInfo> {
    const box = this.requireBox(path);
    return {
      path,
      messages: box.messages.length,
      recent: 0,
      unseen: box.messages.filter((message) => !message.flags.includes('\\Seen')).length,
      uidNext: box.uidNext,
      uidValidity: box.uidValidity,
    };
  }

  async createMailbox(path: string): Promise<{ path: string; created: boolean }> {
    if (this.boxes.has(path)) {
      return { path, created: false };
    }
    this.ensure(path);
    return { path, created: true };
  }

  async renameMailbox(from: string, to: string): Promise<void> {
    const box = this.requireBox(from);
    this.boxes.delete(from);
    box.path = to;
    this.boxes.set(to, box);
  }

  async deleteMailbox(path: string): Promise<void> {
    if (!this.boxes.delete(path)) {
      throw new MailError('NOT_FOUND', `Mailbox "${path}" was not found.`);
    }
  }

  async subscribe(path: string): Promise<void> {
    this.requireBox(path).subscribed = true;
  }

  async unsubscribe(path: string): Promise<void> {
    this.requireBox(path).subscribed = false;
  }

  async append(
    path: string,
    raw: Buffer,
    flags?: string[],
  ): Promise<{ uid?: number; uidValidity?: string; destination: string }> {
    const box = this.requireBox(path);
    const uid = box.uidNext;
    box.uidNext += 1;
    box.messages.push({
      uid,
      raw,
      flags: [...(flags ?? [])],
      internalDate: new Date().toISOString(),
      subject: header(raw, 'subject'),
      from: header(raw, 'from'),
      size: raw.length,
    });
    return { uid, uidValidity: box.uidValidity, destination: path };
  }

  async withMailbox<T>(
    path: string,
    _mode: 'read' | 'write',
    fn: (box: OpenMailbox) => Promise<T>,
  ): Promise<T> {
    const stored = this.requireBox(path);
    return fn(new FakeBox(stored, this));
  }

  async getAcl(): Promise<AclEntry[]> {
    if (!this.hasCapability('ACL')) {
      throw new MailError('CAPABILITY_UNSUPPORTED', 'The server does not advertise ACL.');
    }
    return [{ identifier: 'user', rights: 'lrswipkxtecdan' }];
  }

  async setAcl(): Promise<void> {
    if (!this.hasCapability('ACL')) {
      throw new MailError('CAPABILITY_UNSUPPORTED', 'The server does not advertise ACL.');
    }
  }

  async getMetadata(_path: string, entries: string[]): Promise<Record<string, string | null>> {
    if (!this.hasCapability('METADATA')) {
      throw new MailError('CAPABILITY_UNSUPPORTED', 'The server does not advertise METADATA.');
    }
    return Object.fromEntries(entries.map((entry) => [entry, null]));
  }

  async setMetadata(): Promise<void> {
    if (!this.hasCapability('METADATA')) {
      throw new MailError('CAPABILITY_UNSUPPORTED', 'The server does not advertise METADATA.');
    }
  }

  async waitForChanges(path: string, _timeoutMs: number): Promise<WaitResult> {
    const status = await this.status(path);
    const changes = this.changes.splice(0);
    return {
      timedOut: changes.length === 0,
      idleSupported: this.idleSupported && this.hasCapability('IDLE'),
      changes,
      status,
    };
  }

  ensure(path: string, specialUse?: string): StoredMailbox {
    const existing = this.boxes.get(path);
    if (existing) {
      return existing;
    }
    const box: StoredMailbox = {
      path,
      flags: specialUse ? [specialUse] : [],
      subscribed: true,
      uidValidity: '100',
      uidNext: 1,
      messages: [],
    };
    if (specialUse) {
      box.specialUse = specialUse;
    }
    this.boxes.set(path, box);
    return box;
  }

  private requireBox(path: string): StoredMailbox {
    const box = this.boxes.get(path);
    if (!box) {
      throw new MailError('NOT_FOUND', `Mailbox "${path}" was not found.`);
    }
    return box;
  }

  private info(box: StoredMailbox): MailboxInfo {
    const info: MailboxInfo = {
      path: box.path,
      name: box.path.split('/').pop() ?? box.path,
      delimiter: '/',
      flags: box.flags,
      subscribed: box.subscribed,
      listed: true,
      parentPath: '',
    };
    if (box.specialUse) {
      info.specialUse = box.specialUse;
      info.specialUseSource = 'extension';
    }
    return info;
  }
}

class FakeBox implements OpenMailbox {
  readonly path: string;
  readonly uidValidity: string;
  readonly uidNext: number;
  readonly exists: number;

  constructor(
    private readonly box: StoredMailbox,
    private readonly session: FakeSession,
  ) {
    this.path = box.path;
    this.uidValidity = box.uidValidity;
    this.uidNext = box.uidNext;
    this.exists = box.messages.length;
  }

  async search(compiled: CompiledSearch): Promise<number[]> {
    return this.box.messages
      .filter((message) => matches(message, compiled.query))
      .map((message) => message.uid);
  }

  async fetchSummaries(
    uids: number[],
    _options: { snippet: boolean; snippetChars: number },
  ): Promise<MessageSummary[]> {
    return uids.flatMap((uid) => {
      const message = this.box.messages.find((item) => item.uid === uid);
      if (!message) {
        return [];
      }
      const summary: MessageSummary = {
        uid: message.uid,
        flags: [...message.flags],
        size: message.size,
        internalDate: message.internalDate,
        date: message.internalDate,
        from: message.from ? [{ address: message.from }] : [],
        to: [],
        cc: [],
        replyTo: [],
        hasAttachments: message.raw.includes(Buffer.from('Content-Disposition: attachment')),
      };
      if (message.subject) {
        summary.subject = message.subject;
      }
      summary.snippet = message.raw.toString('utf8').slice(0, 80);
      return [summary];
    });
  }

  async fetchSource(uid: number): Promise<Buffer | null> {
    return this.box.messages.find((message) => message.uid === uid)?.raw ?? null;
  }

  async fetchHeaders(uid: number): Promise<Buffer | null> {
    const raw = await this.fetchSource(uid);
    if (!raw) {
      return null;
    }
    const text = raw.toString('utf8');
    const split = text.indexOf('\r\n\r\n');
    return Buffer.from(split >= 0 ? text.slice(0, split + 4) : text);
  }

  async fetchParts(
    uid: number,
    parts: Array<{ key: string; maxLength?: number }>,
  ): Promise<FetchedPart[]> {
    const raw = await this.fetchSource(uid);
    if (!raw) {
      return [];
    }
    return parts.map((part) => {
      const content = raw.subarray(0, part.maxLength ?? raw.length);
      return { partId: part.key, content: Buffer.from(content), contentType: 'text/plain' };
    });
  }

  async fetchStructure(): Promise<BodyNode | null> {
    return {
      type: 'text',
      subtype: 'plain',
      parameters: { charset: 'utf-8' },
      dispositionParameters: {},
      children: [],
      part: '1',
    };
  }

  async setFlags(
    uids: number[],
    flags: string[],
    operation: 'add' | 'remove' | 'set',
    unchangedSince?: string,
  ): Promise<FlagUpdate> {
    const missing: number[] = [];
    const modified: number[] = [];
    const updated: number[] = [];
    for (const uid of uids) {
      const message = this.box.messages.find((item) => item.uid === uid);
      if (!message) {
        missing.push(uid);
        continue;
      }
      if (unchangedSince === '0') {
        modified.push(uid);
        continue;
      }
      if (operation === 'set') {
        message.flags = [...flags];
      } else if (operation === 'add') {
        for (const flag of flags) {
          if (!message.flags.includes(flag)) {
            message.flags.push(flag);
          }
        }
      } else {
        message.flags = message.flags.filter((flag) => !flags.includes(flag));
      }
      updated.push(uid);
    }
    return { updated, modified, missing };
  }

  async setLabels(): Promise<void> {
    if (!this.session.hasCapability('X-GM-EXT-1')) {
      throw new MailError(
        'CAPABILITY_UNSUPPORTED',
        'Gmail labels require the X-GM-EXT-1 extension.',
      );
    }
  }

  async copy(uids: number[], destination: string): Promise<Record<string, number>> {
    const dest = this.session.ensure(destination);
    const map: Record<string, number> = {};
    for (const uid of uids) {
      const message = this.require(uid);
      const next = dest.uidNext;
      dest.uidNext += 1;
      dest.messages.push({
        ...message,
        uid: next,
        flags: [...message.flags],
        raw: Buffer.from(message.raw),
      });
      map[String(uid)] = next;
    }
    return map;
  }

  async move(uids: number[], destination: string): Promise<Record<string, number>> {
    if (!this.session.hasCapability('MOVE') && !this.session.hasCapability('UIDPLUS')) {
      throw new MailError('PROTOCOL_ERROR', 'MOVE unavailable');
    }
    const map = await this.copy(uids, destination);
    this.box.messages = this.box.messages.filter((message) => !uids.includes(message.uid));
    return map;
  }

  async expunge(uids?: number[]): Promise<void> {
    if (uids && uids.length > 0) {
      this.box.messages = this.box.messages.filter((message) => !uids.includes(message.uid));
      return;
    }
    this.box.messages = this.box.messages.filter((message) => !message.flags.includes('\\Deleted'));
  }

  async serverSort(
    compiled: CompiledSearch,
    _keys: SortKey[],
    _window?: { start: number; count: number },
  ): Promise<number[] | null> {
    if (!this.session.hasCapability('SORT')) {
      return null;
    }
    const uids = await this.search(compiled);
    return uids.sort((left, right) => right - left);
  }

  async serverThread(
    _algorithm: 'REFERENCES' | 'ORDEREDSUBJECT' | 'REFS',
    _compiled: CompiledSearch,
  ): Promise<ThreadNode[] | null> {
    if (!this.session.hasCapability('THREAD')) {
      return null;
    }
    return this.box.messages.map((message) => ({ uid: message.uid, children: [] }));
  }

  private require(uid: number): StoredMessage {
    const message = this.box.messages.find((item) => item.uid === uid);
    if (!message) {
      throw new MailError('NOT_FOUND', `Message UID ${uid} was not found.`);
    }
    return message;
  }
}

function matches(message: StoredMessage, query: Record<string, unknown>): boolean {
  if (query.all === true && Object.keys(query).length === 1) {
    return true;
  }
  if (typeof query.not === 'object' && query.not) {
    return !matches(message, query.not as Record<string, unknown>);
  }
  if (Array.isArray(query.or)) {
    return query.or.some((item) => matches(message, item as Record<string, unknown>));
  }
  if (query.seen === true && !message.flags.includes('\\Seen')) {
    return false;
  }
  if (query.seen === false && message.flags.includes('\\Seen')) {
    return false;
  }
  if (typeof query.uid === 'string' && !query.uid.split(',').includes(String(message.uid))) {
    return false;
  }
  if (typeof query.from === 'string' && !(message.from ?? '').includes(String(query.from))) {
    return false;
  }
  if (
    typeof query.subject === 'string' &&
    !(message.subject ?? '').includes(String(query.subject))
  ) {
    return false;
  }
  const text = message.raw.toString('utf8');
  if (typeof query.text === 'string' && !text.includes(String(query.text))) {
    return false;
  }
  return true;
}

function header(raw: Buffer, name: string): string | undefined {
  const match = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(raw.toString('utf8'));
  return match?.[1]?.trim();
}

export class FakePool {
  constructor(readonly session: FakeSession) {}

  async use<T>(_accountId: string, fn: (session: FakeSession) => Promise<T>): Promise<T> {
    await this.session.connect();
    return fn(this.session);
  }

  async close(): Promise<void> {
    await this.session.logout();
  }
}
