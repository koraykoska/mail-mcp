import {
  capabilityMatches,
  hasExactCapability as exactCapability,
} from '../../src/imap/capabilities.js';
import { MailError } from '../../src/errors.js';
import {
  evaluateSearch,
  isClientQuery,
  mentionsUidOrSeq,
  type CompiledSearch,
} from '../../src/imap/search.js';
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
  ServerSortResult,
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
  structure: BodyNode | null = null;
  sourceMissing = false;
  /** UIDs that SEARCH and SORT still return, but FETCH omits. */
  ghostUids = new Set<number>();
  partBodies = new Map<string, { content: Buffer; contentType: string; filename?: string }>();
  /** Wait before each mailbox command. Used to trip the bulk time budget. */
  latencyMs = 0;
  /** Called after each mailbox command's latency, before the command returns. */
  afterCommand: (() => void) | undefined;
  /**
   * Treat `NOT UID` / `NOT <seq>` as an empty set, and reject a NOT that mixes
   * a text test with a flag or UID test, matching iCloud.
   */
  emulateIcloud = false;
  /** COPY succeeds and stores the messages, but omits COPYUID. */
  suppressCopyUid = false;
  /** Plain queries handed to the matcher, after client-side AND/NOT resolution. */
  readonly searchLog: Record<string, unknown>[] = [];

  async pace(): Promise<void> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
    this.afterCommand?.();
  }

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

  moveSupported(): boolean {
    return this.hasCapability('MOVE');
  }

  uidPlusSupported(): boolean {
    return this.hasCapability('UIDPLUS');
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
    if (
      stored.flags.some((flag) => {
        const name = flag.toLowerCase();
        return name === '\\noselect' || name === '\\nonexistent';
      })
    ) {
      throw new MailError(
        'MAILBOX_NOT_SELECTABLE',
        `Mailbox "${path}" cannot be selected.`,
        'The folder is marked \\Noselect or \\NonExistent. Open a mailbox that can hold messages.',
      );
    }
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
    await this.session.pace();
    return evaluateSearch(compiled.query, async (query) => {
      this.session.searchLog.push(query);
      if (this.session.emulateIcloud) {
        const fault = icloudSearchFault(query);
        if (fault === 'unavailable') {
          throw new MailError(
            'PROTOCOL_ERROR',
            'The mail server returned an error: NO [UNAVAILABLE] Unexpected exception',
          );
        }
        if (fault === 'empty') {
          return [];
        }
      }
      return this.box.messages
        .map((message, index) => ({ message, seq: index + 1 }))
        .filter(({ message, seq }) => matches(message, query, seq))
        .map(({ message }) => message.uid);
    });
  }

  async fetchSummaries(
    uids: number[],
    _options: { snippet: boolean; snippetChars: number },
  ): Promise<MessageSummary[]> {
    return uids.flatMap((uid) => {
      const message = this.box.messages.find((item) => item.uid === uid);
      if (!message || this.session.ghostUids.has(uid)) {
        return [];
      }
      const messageId = headerIds(message.raw, 'message-id')[0];
      const inReplyTo = headerIds(message.raw, 'in-reply-to')[0];
      const references = headerIds(message.raw, 'references');
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
        ...(messageId ? { messageId } : {}),
        ...(inReplyTo ? { inReplyTo } : {}),
        ...(references.length > 0 ? { references } : {}),
      };
      const threadId = header(message.raw, 'x-gm-thrid');
      if (threadId) {
        summary.threadId = threadId;
      }
      if (message.subject) {
        summary.subject = message.subject;
      }
      summary.snippet = message.raw.toString('utf8').slice(0, 80);
      return [summary];
    });
  }

  async fetchSource(uid: number): Promise<Buffer | null> {
    if (this.session.sourceMissing) {
      return null;
    }
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
      const canned = this.session.partBodies.get(part.key);
      if (canned) {
        const content = canned.content.subarray(0, part.maxLength ?? canned.content.length);
        const fetched: FetchedPart = {
          partId: part.key,
          content: Buffer.from(content),
          contentType: canned.contentType,
        };
        if (canned.filename) {
          fetched.filename = canned.filename;
        }
        return fetched;
      }
      const content = raw.subarray(0, part.maxLength ?? raw.length);
      return { partId: part.key, content: Buffer.from(content), contentType: 'text/plain' };
    });
  }

  async fetchStructure(): Promise<BodyNode | null> {
    if (this.session.structure) {
      return this.session.structure;
    }
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
    await this.session.pace();
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

  async setLabels(uids: number[]): Promise<void> {
    await this.session.pace();
    if (!this.session.hasCapability('X-GM-EXT-1')) {
      throw new MailError(
        'CAPABILITY_UNSUPPORTED',
        'Gmail labels require the X-GM-EXT-1 extension.',
      );
    }
    for (const uid of uids) {
      this.require(uid);
    }
  }

  async copy(uids: number[], destination: string): Promise<Record<string, number>> {
    await this.session.pace();
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
      if (!this.session.suppressCopyUid) {
        map[String(uid)] = next;
      }
    }
    return map;
  }

  async move(
    uids: number[],
    destination: string,
  ): Promise<{ map: Record<string, number>; kept: number[] }> {
    await this.session.pace();
    if (this.session.moveSupported()) {
      const map = await this.copy(uids, destination);
      const moved = uids.filter((uid) => map[String(uid)] !== undefined);
      this.box.messages = this.box.messages.filter((message) => !moved.includes(message.uid));
      return { map, kept: uids.filter((uid) => map[String(uid)] === undefined) };
    }
    if (!this.session.uidPlusSupported()) {
      throw new MailError('CAPABILITY_UNSUPPORTED', 'This server has neither MOVE nor UIDPLUS.');
    }
    const map = await this.copy(uids, destination);
    const confirmed = uids.filter((uid) => map[String(uid)] !== undefined);
    this.box.messages = this.box.messages.filter((message) => !confirmed.includes(message.uid));
    return {
      map,
      kept: uids.filter((uid) => map[String(uid)] === undefined),
    };
  }

  async expunge(uids?: number[]): Promise<void> {
    await this.session.pace();
    if (uids && uids.length > 0) {
      this.box.messages = this.box.messages.filter((message) => !uids.includes(message.uid));
      return;
    }
    this.box.messages = this.box.messages.filter((message) => !message.flags.includes('\\Deleted'));
  }

  async serverSort(
    compiled: CompiledSearch,
    _keys: SortKey[],
    window?: { start: number; count: number },
  ): Promise<ServerSortResult | null> {
    if (!this.session.hasCapability('SORT') || isClientQuery(compiled.query)) {
      return null;
    }
    const uids = (await this.search(compiled)).sort((left, right) => right - left);
    if (!window) {
      return { uids, total: uids.length, partial: false };
    }
    const start = Math.max(0, window.start - 1);
    return {
      uids: uids.slice(start, start + window.count),
      total: uids.length,
      partial: true,
    };
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

function matches(message: StoredMessage, query: Record<string, unknown>, seq: number): boolean {
  if (query.all === true && Object.keys(query).length === 1) {
    return true;
  }
  for (const [key, value] of Object.entries(query)) {
    if (key === 'all') {
      continue;
    }
    if (key === 'not' && value && typeof value === 'object') {
      if (matches(message, value as Record<string, unknown>, seq)) {
        return false;
      }
      continue;
    }
    if (key === 'or' && Array.isArray(value)) {
      if (!value.some((item) => matches(message, item as Record<string, unknown>, seq))) {
        return false;
      }
      continue;
    }
    if (!matchesKey(message, key, value, seq)) {
      return false;
    }
  }
  return true;
}

function matchesKey(message: StoredMessage, key: string, value: unknown, seq: number): boolean {
  if (key === 'seen') {
    const seen = message.flags.includes('\\Seen');
    return value === true ? seen : value === false ? !seen : true;
  }
  if (key === 'flagged') {
    const flagged = message.flags.includes('\\Flagged');
    return value === true ? flagged : value === false ? !flagged : true;
  }
  if (key === 'answered') {
    const answered = message.flags.includes('\\Answered');
    return value === true ? answered : value === false ? !answered : true;
  }
  if (key === 'uid' && typeof value === 'string') {
    return uidInSet(message.uid, value);
  }
  if (key === 'seq' && typeof value === 'string') {
    return uidInSet(seq, value);
  }
  if (key === 'header' && value && typeof value === 'object') {
    const entry = Object.entries(value as Record<string, unknown>)[0];
    if (!entry) {
      return true;
    }
    const raw = header(message.raw, entry[0]);
    if (!raw) {
      return false;
    }
    if (typeof entry[1] === 'string' && !raw.toLowerCase().includes(entry[1].toLowerCase())) {
      return false;
    }
    return true;
  }
  if (key === 'from' && typeof value === 'string') {
    return (message.from ?? '').includes(value);
  }
  if (key === 'subject' && typeof value === 'string') {
    return (message.subject ?? '').includes(value);
  }
  if (key === 'text' && typeof value === 'string') {
    return message.raw.toString('utf8').includes(value);
  }
  if (key === 'threadId' && typeof value === 'string') {
    return header(message.raw, 'x-gm-thrid') === value;
  }
  return true;
}

const TEXT_KEYS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'body',
  'text',
  'header',
  'larger',
  'smaller',
]);
const FLAG_KEYS = new Set([
  'seen',
  'answered',
  'flagged',
  'deleted',
  'draft',
  'recent',
  'keyword',
  'unkeyword',
  'unKeyword',
]);

/**
 * iCloud's SEARCH faults, applied to a query object before it is matched.
 * `empty` is `NOT UID` / `NOT <sequence>` (the result is nothing).
 * `unavailable` is a NOT that mixes a text test with a flag or UID test.
 */
export function icloudSearchFault(query: unknown): 'empty' | 'unavailable' | null {
  return faultWalk(query);
}

function faultWalk(query: unknown): 'empty' | 'unavailable' | null {
  if (!query || typeof query !== 'object') {
    return null;
  }
  if (Array.isArray(query)) {
    for (const item of query) {
      const found = faultWalk(item);
      if (found) {
        return found;
      }
    }
    return null;
  }
  const record = query as Record<string, unknown>;
  if (record.not && typeof record.not === 'object') {
    const inner = record.not;
    const text = hasKey(inner, TEXT_KEYS);
    const flag = hasKey(inner, FLAG_KEYS);
    const uid = mentionsUidOrSeq(inner);
    if (text && (flag || uid)) {
      return 'unavailable';
    }
    if (uid) {
      return 'empty';
    }
  }
  for (const value of Object.values(record)) {
    const found = faultWalk(value);
    if (found) {
      return found;
    }
  }
  return null;
}

function hasKey(value: unknown, keys: Set<string>): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasKey(item, keys));
  }
  const record = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(record)) {
    if (keys.has(key)) {
      return true;
    }
    if (hasKey(nested, keys)) {
      return true;
    }
  }
  return false;
}

function uidInSet(uid: number, set: string): boolean {
  return set.split(',').some((piece) => {
    const trimmed = piece.trim();
    const range = /^(\d+|\*):(\d+|\*)$/.exec(trimmed);
    if (range) {
      const start = range[1] === '*' ? Number.MAX_SAFE_INTEGER : Number(range[1]);
      const end = range[2] === '*' ? Number.MAX_SAFE_INTEGER : Number(range[2]);
      return uid >= Math.min(start, end) && uid <= Math.max(start, end);
    }
    return trimmed === String(uid);
  });
}

function header(raw: Buffer, name: string): string | undefined {
  const match = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(raw.toString('utf8'));
  return match?.[1]?.trim();
}

function headerIds(raw: Buffer, name: string): string[] {
  const value = header(raw, name);
  if (!value) {
    return [];
  }
  return [...value.matchAll(/<[^<>]+>/g)].map((item) => item[0]);
}

export class FakePool {
  constructor(readonly session: FakeSession) {}

  async use<T>(_accountId: string, fn: (session: FakeSession) => Promise<T>): Promise<T> {
    await this.session.connect();
    return fn(this.session);
  }

  async tryUse(): Promise<undefined> {
    return undefined;
  }

  async close(): Promise<void> {
    await this.session.logout();
  }
}
