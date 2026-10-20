import { readFileSync } from 'node:fs';
import {
  ImapFlow,
  type FetchMessageObject,
  type ImapFlowOptions,
  type ListResponse,
  type MessageStructureObject,
} from 'imapflow';
import { MailError, mapTransportError } from '../errors.js';
import type { ResolvedAccount } from '../config/schema.js';
import type { Logger } from '../log.js';
import { decodeBody } from '../charset.js';
import { findTextPart } from '../mime/parse.js';
import { makeSnippet, htmlToRoughText } from '../mime/snippet.js';
import type { ThreadNode } from '../mime/thread.js';
import type { CompiledSearch } from './search.js';
import { sortKeyToImap, type SortKey } from './sort.js';
import { flagsToList, normalizeFlags } from './flags.js';
import {
  bigintToString,
  toIso,
  uidList,
  type AddressParts,
  type BodyNode,
  type FetchedPart,
  type ImapSession,
  type MailboxInfo,
  type MailboxTree,
  type MessageSummary,
  type OpenMailbox,
  type QuotaInfo,
  type StatusInfo,
  type WaitResult,
  type MailboxChange,
} from './session.js';

interface ImapAttr {
  type?: string;
  value?: string | number;
  attributes?: ImapAttr[];
}

interface RawClient {
  exec(
    command: string,
    attributes: unknown,
    options?: {
      untagged?: Record<string, (untagged: { attributes?: ImapAttr[] }) => void | Promise<void>>;
    },
  ): Promise<{ next: () => IteratorResult<unknown> | void }>;
  preCheck?: (() => Promise<void>) | false;
}

/**
 * One IMAP connection backed by ImapFlow.
 * Mailbox names are passed as Unicode; ImapFlow encodes modified UTF-7 unless UTF8=ACCEPT is on.
 */
export class ImapFlowSession implements ImapSession {
  private client: ImapFlow | undefined;
  private connecting: Promise<void> | undefined;
  readonly capabilities = new Map<string, boolean | number>();

  constructor(
    private readonly account: ResolvedAccount,
    private readonly accessToken: string | undefined,
    private readonly logger: Logger,
  ) {}

  hasCapability(name: string): boolean {
    const upper = name.toUpperCase();
    for (const key of this.capabilities.keys()) {
      if (key.toUpperCase() === upper) {
        return true;
      }
    }
    return false;
  }

  serverId(): Record<string, string> | null {
    const info = this.requireClient().serverInfo;
    if (!info) {
      return null;
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(info)) {
      if (value !== undefined && value !== null) {
        out[key] = String(value);
      }
    }
    return out;
  }

  greeting(): string | undefined {
    return this.requireClient().greeting;
  }

  async connect(): Promise<void> {
    if (this.client?.usable) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }
    this.connecting = this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async logout(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (!client) {
      return;
    }
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }

  close(): void {
    const client = this.client;
    this.client = undefined;
    client?.close();
  }

  async namespaces(): Promise<{
    personal: Array<{ prefix: string; delimiter: string | null }>;
    other: Array<{ prefix: string; delimiter: string | null }>;
    shared: Array<{ prefix: string; delimiter: string | null }>;
  }> {
    const client = this.requireClient();
    const namespaces = client.namespaces;
    const mapGroup = (
      group: { prefix: string; delimiter?: string | null }[] | false | undefined,
    ): Array<{ prefix: string; delimiter: string | null }> => {
      if (!group) {
        return [];
      }
      return group.map((item) => ({
        prefix: item.prefix,
        delimiter: item.delimiter ?? null,
      }));
    };
    return {
      personal: mapGroup(namespaces?.personal),
      other: mapGroup(namespaces?.other),
      shared: mapGroup(namespaces?.shared),
    };
  }

  async quota(path?: string): Promise<QuotaInfo | null> {
    const client = this.requireClient();
    if (!this.hasCapability('QUOTA')) {
      return null;
    }
    try {
      const quota = await client.getQuota(path);
      if (!quota) {
        return null;
      }
      const resources: QuotaInfo['resources'] = [];
      const pushResource = (
        name: string,
        resource: { usage?: number; limit?: number } | undefined,
      ): void => {
        if (!resource) {
          return;
        }
        resources.push({ name, used: resource.usage ?? 0, limit: resource.limit ?? 0 });
      };
      pushResource('STORAGE', quota.storage);
      pushResource('MESSAGE', quota.message);
      for (const [name, value] of Object.entries(quota)) {
        if (name === 'path' || name === 'quotaRoot' || name === 'storage' || name === 'message') {
          continue;
        }
        if (value && typeof value === 'object' && ('usage' in value || 'limit' in value)) {
          const resource = value as { usage?: number; limit?: number };
          pushResource(name.toUpperCase(), resource);
        }
      }
      const info: QuotaInfo = { path: quota.path || path || '', resources };
      if (quota.quotaRoot) {
        info.quotaRoot = quota.quotaRoot;
      }
      return info;
    } catch (error) {
      throw mapTransportError(error);
    }
  }

  async listMailboxes(options?: { subscribedOnly?: boolean }): Promise<MailboxInfo[]> {
    const client = this.requireClient();
    try {
      const list = await client.list();
      return list
        .filter((item) => (options?.subscribedOnly ? item.subscribed : true))
        .map(toMailboxInfo);
    } catch (error) {
      throw mapTransportError(error);
    }
  }

  async listTree(): Promise<MailboxTree> {
    const client = this.requireClient();
    try {
      const tree = await client.listTree();
      return toTree(tree);
    } catch (error) {
      throw mapTransportError(error);
    }
  }

  async status(path: string): Promise<StatusInfo> {
    const client = this.requireClient();
    try {
      const status = await client.status(path, {
        messages: true,
        recent: true,
        unseen: true,
        uidNext: true,
        uidValidity: true,
        highestModseq: true,
        size: this.hasCapability('STATUS=SIZE') || this.hasCapability('IMAP4REV2'),
      });
      if (!status) {
        throw new MailError('NOT_FOUND', `Mailbox "${path}" was not found.`);
      }
      return toStatus(status);
    } catch (error) {
      throw mapTransportError(error);
    }
  }

  async createMailbox(path: string): Promise<{ path: string; created: boolean }> {
    try {
      const created = await this.requireClient().mailboxCreate(path);
      return { path: created.path, created: created.created };
    } catch (error) {
      throw mapTransportError(error);
    }
  }

  async renameMailbox(from: string, to: string): Promise<void> {
    try {
      const result = await this.requireClient().mailboxRename(from, to);
      if (!result) {
        throw new MailError('NOT_FOUND', `Mailbox "${from}" could not be renamed.`);
      }
    } catch (error) {
      throw mapTransportError(error);
    }
  }

  async deleteMailbox(path: string): Promise<void> {
    try {
      await this.requireClient().mailboxDelete(path);
    } catch (error) {
      throw mapTransportError(error);
    }
  }

  async subscribe(path: string): Promise<void> {
    try {
      await this.requireClient().mailboxSubscribe(path);
    } catch (error) {
      throw mapTransportError(error);
    }
  }

  async unsubscribe(path: string): Promise<void> {
    try {
      await this.requireClient().mailboxUnsubscribe(path);
    } catch (error) {
      throw mapTransportError(error);
    }
  }

  async append(
    path: string,
    raw: Buffer,
    flags?: string[],
    date?: Date,
  ): Promise<{ uid?: number; uidValidity?: string; destination: string }> {
    try {
      const result = await this.requireClient().append(
        path,
        raw,
        flags ? normalizeFlags(flags) : undefined,
        date,
      );
      if (!result) {
        throw new MailError('PROTOCOL_ERROR', `APPEND to "${path}" did not return a result.`);
      }
      const appended: { uid?: number; uidValidity?: string; destination: string } = {
        destination: result.destination,
      };
      if (result.uid !== undefined) {
        appended.uid = result.uid;
      }
      const validity = bigintToString(result.uidValidity);
      if (validity) {
        appended.uidValidity = validity;
      }
      return appended;
    } catch (error) {
      throw mapTransportError(error);
    }
  }

  async withMailbox<T>(
    path: string,
    mode: 'read' | 'write',
    fn: (box: OpenMailbox) => Promise<T>,
  ): Promise<T> {
    const client = this.requireClient();
    let lock: { release: () => void } | undefined;
    try {
      lock = await client.getMailboxLock(path, { readOnly: mode === 'read' });
      const mailbox = client.mailbox;
      if (!mailbox) {
        throw new MailError('NOT_FOUND', `Mailbox "${path}" could not be opened.`);
      }
      const box = new FlowMailbox(client, this, path, mailbox);
      return await fn(box);
    } catch (error) {
      throw mapTransportError(error);
    } finally {
      lock?.release();
    }
  }

  async waitForChanges(path: string, timeoutMs: number): Promise<WaitResult> {
    const client = this.requireClient();
    const changes: MailboxChange[] = [];
    const onExists = (event: { path: string; count: number; prevCount: number }): void => {
      changes.push({
        kind: 'exists',
        path: event.path,
        count: event.count,
        prevCount: event.prevCount,
      });
    };
    const onExpunge = (event: { path: string; uid?: number; seq?: number }): void => {
      const change: MailboxChange = { kind: 'expunge', path: event.path };
      if (event.uid !== undefined) {
        change.uid = event.uid;
      }
      if (event.seq !== undefined) {
        change.seq = event.seq;
      }
      changes.push(change);
    };
    const onFlags = (event: {
      path: string;
      uid?: number;
      seq?: number;
      flags: Set<string>;
    }): void => {
      const change: MailboxChange = {
        kind: 'flags',
        path: event.path,
        flags: flagsToList(event.flags),
      };
      if (event.uid !== undefined) {
        change.uid = event.uid;
      }
      if (event.seq !== undefined) {
        change.seq = event.seq;
      }
      changes.push(change);
    };
    client.on('exists', onExists);
    client.on('expunge', onExpunge);
    client.on('flags', onFlags);
    let lock: { release: () => void } | undefined;
    try {
      lock = await client.getMailboxLock(path, { readOnly: true });
      let stop = (): void => undefined;
      const idleSupported = this.hasCapability('IDLE');
      const done = new Promise<void>((resolve) => {
        stop = () => resolve();
      });
      const timer = setTimeout(() => stop(), timeoutMs);
      const breakIdle = (): void => {
        const raw = client as unknown as RawClient;
        if (typeof raw.preCheck === 'function') {
          void raw.preCheck().catch(() => undefined);
        }
        stop();
      };
      const early = (): void => {
        if (changes.length > 0) {
          breakIdle();
        }
      };
      client.on('exists', early);
      client.on('expunge', early);
      client.on('flags', early);
      const idleResult = client.idle();
      await Promise.race([idleResult, done]);
      clearTimeout(timer);
      breakIdle();
      await idleResult.catch((error: unknown) => {
        this.logger.debug('idle ended', {
          error: error instanceof Error ? error.message : 'idle failed',
        });
      });
      const status = toStatus(
        (await client.status(path, {
          messages: true,
          recent: true,
          unseen: true,
          uidNext: true,
          uidValidity: true,
          highestModseq: true,
        })) || { path },
      );
      return { timedOut: changes.length === 0, idleSupported, changes, status };
    } catch (error) {
      throw mapTransportError(error);
    } finally {
      lock?.release();
      client.off('exists', onExists);
      client.off('expunge', onExpunge);
      client.off('flags', onFlags);
    }
  }

  private async open(): Promise<void> {
    const previous = this.client;
    this.client = undefined;
    previous?.close();
    const endpoint = this.account.imap;
    const tls: ImapFlowOptions['tls'] = {
      rejectUnauthorized: endpoint.tls.rejectUnauthorized,
    };
    if (endpoint.tls.servername) {
      tls.servername = endpoint.tls.servername;
    }
    if (endpoint.tls.caFile) {
      tls.ca = readFileSync(endpoint.tls.caFile);
    }
    const options: ImapFlowOptions = {
      host: endpoint.host,
      port: endpoint.port,
      secure: endpoint.secure,
      tls,
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: endpoint.timeoutMs,
      greetingTimeout: Math.min(endpoint.timeoutMs, 16_000),
      socketTimeout: endpoint.timeoutMs,
      clientInfo: { name: 'mail-mcp', version: '0.1.0' },
      auth: this.authOptions(),
    };
    if (!endpoint.secure) {
      options.doSTARTTLS =
        endpoint.starttls === 'required'
          ? true
          : endpoint.starttls === 'disabled'
            ? false
            : undefined;
    }
    const client = new ImapFlow(options);
    try {
      await client.connect();
    } catch (error) {
      client.close();
      throw mapTransportError(error);
    }
    this.client = client;
    this.capabilities.clear();
    for (const [key, value] of client.capabilities) {
      this.capabilities.set(key, value);
    }
    this.logger.debug('imap connected', {
      account: this.account.id,
      host: endpoint.host,
      capabilities: [...this.capabilities.keys()],
    });
  }

  private authOptions(): ImapFlowOptions['auth'] {
    if (this.account.auth.type === 'password') {
      return { user: this.account.user, pass: this.account.auth.password };
    }
    if (!this.accessToken) {
      throw new MailError('AUTH_FAILED', `Account "${this.account.id}" has no OAuth access token.`);
    }
    return { user: this.account.user, accessToken: this.accessToken };
  }

  private requireClient(): ImapFlow {
    if (!this.client?.usable) {
      throw new MailError('CONNECTION_FAILED', 'IMAP session is not connected.');
    }
    return this.client;
  }
}

class FlowMailbox implements OpenMailbox {
  readonly path: string;
  readonly uidValidity: string;
  readonly uidNext: number;
  readonly exists: number;
  readonly highestModseq?: string;

  constructor(
    private readonly client: ImapFlow,
    private readonly session: ImapFlowSession,
    path: string,
    mailbox: { uidValidity: bigint; uidNext: number; exists: number; highestModseq?: bigint },
  ) {
    this.path = path;
    this.uidValidity = mailbox.uidValidity.toString();
    this.uidNext = mailbox.uidNext;
    this.exists = mailbox.exists;
    const modseq = bigintToString(mailbox.highestModseq);
    if (modseq) {
      this.highestModseq = modseq;
    }
  }

  async search(compiled: CompiledSearch): Promise<number[]> {
    const result = await this.client.search(compiled.query, { uid: true });
    if (!result) {
      return [];
    }
    return result;
  }

  async fetchSummaries(
    uids: number[],
    options: { snippet: boolean; snippetChars: number },
  ): Promise<MessageSummary[]> {
    if (uids.length === 0) {
      return [];
    }
    const rows = await this.client.fetchAll(
      uidList(uids),
      {
        uid: true,
        flags: true,
        size: true,
        envelope: true,
        internalDate: true,
        bodyStructure: true,
        labels: this.session.hasCapability('X-GM-EXT-1'),
        threadId:
          this.session.hasCapability('OBJECTID') || this.session.hasCapability('X-GM-EXT-1'),
      },
      { uid: true },
    );
    const summaries = rows.map((row) => toSummary(row));
    if (!options.snippet) {
      return summaries;
    }
    await this.fillSnippets(summaries, options.snippetChars);
    return summaries;
  }

  async fetchSource(uid: number, maxBytes?: number): Promise<Buffer | null> {
    const row = await this.client.fetchOne(
      String(uid),
      { uid: true, source: maxBytes ? { maxLength: maxBytes } : true },
      { uid: true },
    );
    if (!row || !row.source) {
      return null;
    }
    return Buffer.from(row.source);
  }

  async fetchHeaders(uid: number): Promise<Buffer | null> {
    const row = await this.client.fetchOne(
      String(uid),
      { uid: true, headers: true },
      { uid: true },
    );
    if (!row || !row.headers) {
      return null;
    }
    return Buffer.from(row.headers);
  }

  async fetchParts(
    uid: number,
    parts: Array<{ key: string; maxLength?: number }>,
  ): Promise<FetchedPart[]> {
    if (parts.length === 0) {
      return [];
    }
    const row = await this.client.fetchOne(
      String(uid),
      {
        uid: true,
        bodyStructure: true,
        bodyParts: parts.map((part) =>
          part.maxLength ? { key: part.key, maxLength: part.maxLength } : part.key,
        ),
      },
      { uid: true },
    );
    if (!row) {
      return [];
    }
    const structure = toBodyNode(row.bodyStructure);
    const out: FetchedPart[] = [];
    for (const part of parts) {
      const content = row.bodyParts?.get(part.key);
      if (!content) {
        continue;
      }
      const meta = findNode(structure, part.key);
      const fetched: FetchedPart = { partId: part.key, content: Buffer.from(content) };
      if (meta) {
        const type = meta.subtype ? `${meta.type}/${meta.subtype}` : meta.type;
        fetched.contentType = type;
        const charset = meta.parameters.charset;
        if (charset) {
          fetched.charset = charset;
        }
        const filename = meta.dispositionParameters.filename || meta.parameters.name;
        if (filename) {
          fetched.filename = filename;
        }
        if (meta.disposition) {
          fetched.disposition = meta.disposition;
        }
        if (meta.encoding) {
          fetched.encoding = meta.encoding;
        }
      }
      out.push(fetched);
    }
    return out;
  }

  async fetchStructure(uid: number): Promise<BodyNode | null> {
    const row = await this.client.fetchOne(
      String(uid),
      { uid: true, bodyStructure: true },
      { uid: true },
    );
    if (!row) {
      return null;
    }
    return toBodyNode(row.bodyStructure);
  }

  async setFlags(
    uids: number[],
    flags: string[],
    operation: 'add' | 'remove' | 'set',
    unchangedSince?: string,
  ): Promise<void> {
    if (uids.length === 0) {
      return;
    }
    const normalized = normalizeFlags(flags);
    const options = {
      uid: true,
      ...(unchangedSince ? { unchangedSince: BigInt(unchangedSince) } : {}),
    };
    const range = uidList(uids);
    const ok =
      operation === 'add'
        ? await this.client.messageFlagsAdd(range, normalized, options)
        : operation === 'remove'
          ? await this.client.messageFlagsRemove(range, normalized, options)
          : await this.client.messageFlagsSet(range, normalized, options);
    if (!ok) {
      throw new MailError('PROTOCOL_ERROR', 'The server rejected the flag update.');
    }
  }

  async setLabels(
    uids: number[],
    labels: string[],
    operation: 'add' | 'remove' | 'set',
  ): Promise<void> {
    if (!this.session.hasCapability('X-GM-EXT-1')) {
      throw new MailError(
        'CAPABILITY_UNSUPPORTED',
        'Gmail labels require the X-GM-EXT-1 extension.',
      );
    }
    const range = uidList(uids);
    const options = { uid: true, useLabels: true };
    const ok =
      operation === 'add'
        ? await this.client.messageFlagsAdd(range, labels, options)
        : operation === 'remove'
          ? await this.client.messageFlagsRemove(range, labels, options)
          : await this.client.messageFlagsSet(range, labels, options);
    if (!ok) {
      throw new MailError('PROTOCOL_ERROR', 'The server rejected the label update.');
    }
  }

  async copy(uids: number[], destination: string): Promise<Record<string, number>> {
    const result = await this.client.messageCopy(uidList(uids), destination, { uid: true });
    if (!result) {
      throw new MailError('PROTOCOL_ERROR', `COPY to "${destination}" failed.`);
    }
    return uidMapToRecord(result.uidMap);
  }

  async move(uids: number[], destination: string): Promise<Record<string, number>> {
    const result = await this.client.messageMove(uidList(uids), destination, { uid: true });
    if (!result) {
      throw new MailError('PROTOCOL_ERROR', `MOVE to "${destination}" failed.`);
    }
    return uidMapToRecord(result.uidMap);
  }

  async expunge(uids?: number[]): Promise<void> {
    if (uids && uids.length > 0) {
      const ok = await this.client.messageDelete(uidList(uids), { uid: true });
      if (!ok) {
        throw new MailError('PROTOCOL_ERROR', 'EXPUNGE of the requested UIDs failed.');
      }
      return;
    }
    const raw = this.client as unknown as RawClient;
    const response = await raw.exec('EXPUNGE', false);
    response.next();
  }

  async serverSort(compiled: CompiledSearch, keys: SortKey[]): Promise<number[] | null> {
    if (!this.session.hasCapability('SORT') || keys.length === 0) {
      return null;
    }
    if (!isMatchAll(compiled.query)) {
      return null;
    }
    const criteria: unknown[] = [];
    for (const key of keys) {
      const imap = sortKeyToImap(key);
      if (imap.startsWith('REVERSE ')) {
        criteria.push({ type: 'ATOM', value: 'REVERSE' });
        criteria.push({ type: 'ATOM', value: imap.slice('REVERSE '.length) });
      } else {
        criteria.push({ type: 'ATOM', value: imap });
      }
    }
    const numbers: number[] = [];
    try {
      const raw = this.client as unknown as RawClient;
      const response = await raw.exec(
        'UID SORT',
        [criteria, { type: 'ATOM', value: 'UTF-8' }, { type: 'ATOM', value: 'ALL' }],
        {
          untagged: {
            SORT: (untagged) => {
              for (const attribute of untagged.attributes ?? []) {
                const value = Number(attribute.value);
                if (Number.isInteger(value)) {
                  numbers.push(value);
                }
              }
            },
          },
        },
      );
      response.next();
      return numbers;
    } catch (error) {
      this.sessionHasSortFallback(error);
      return null;
    }
  }

  async serverThread(
    algorithm: 'REFERENCES' | 'ORDEREDSUBJECT',
    compiled: CompiledSearch,
  ): Promise<ThreadNode[] | null> {
    if (!this.session.hasCapability('THREAD') || !isMatchAll(compiled.query)) {
      return null;
    }
    const nodes: ThreadNode[] = [];
    try {
      const raw = this.client as unknown as RawClient;
      const response = await raw.exec(
        'UID THREAD',
        [
          { type: 'ATOM', value: algorithm },
          { type: 'ATOM', value: 'UTF-8' },
          { type: 'ATOM', value: 'ALL' },
        ],
        {
          untagged: {
            THREAD: (untagged) => {
              for (const attribute of untagged.attributes ?? []) {
                nodes.push(parseThreadNode(attribute));
              }
            },
          },
        },
      );
      response.next();
      return nodes;
    } catch {
      return null;
    }
  }

  private sessionHasSortFallback(error: unknown): void {
    const message = error instanceof Error ? error.message : 'sort failed';
    void message;
  }

  private async fillSnippets(summaries: MessageSummary[], snippetChars: number): Promise<void> {
    const groups = new Map<string, number[]>();
    const kindByUid = new Map<number, 'plain' | 'html'>();
    for (const summary of summaries) {
      const row = summary;
      const structure = summaryStructure.get(row);
      const part = findTextPart(structure ?? null);
      if (!part) {
        continue;
      }
      kindByUid.set(row.uid, part.kind);
      const list = groups.get(part.part) ?? [];
      list.push(row.uid);
      groups.set(part.part, list);
    }
    const textByUid = new Map<number, string>();
    for (const [part, partUids] of groups) {
      const rows = await this.client.fetchAll(
        uidList(partUids),
        { uid: true, bodyParts: [{ key: part, maxLength: Math.max(512, snippetChars * 8) }] },
        { uid: true },
      );
      for (const row of rows) {
        const content = row.bodyParts?.get(part);
        if (!content) {
          continue;
        }
        const charset = summaryStructure.get(
          summaries.find((item) => item.uid === row.uid) ?? summaries[0]!,
        )?.parameters.charset;
        const decoded = decodeBody(Buffer.from(content), charset);
        const kind = kindByUid.get(row.uid);
        textByUid.set(row.uid, kind === 'html' ? htmlToRoughText(decoded) : decoded);
      }
    }
    for (const summary of summaries) {
      const text = textByUid.get(summary.uid);
      if (text) {
        summary.snippet = makeSnippet(text, snippetChars);
      }
    }
  }
}

const summaryStructure = new WeakMap<MessageSummary, BodyNode | null>();

function toSummary(row: FetchMessageObject): MessageSummary {
  const envelope = row.envelope;
  const structure = toBodyNode(row.bodyStructure);
  const summary: MessageSummary = {
    uid: row.uid,
    seq: row.seq,
    flags: flagsToList(row.flags),
    from: mapAddresses(envelope?.from),
    to: mapAddresses(envelope?.to),
    cc: mapAddresses(envelope?.cc),
    replyTo: mapAddresses(envelope?.replyTo),
    hasAttachments: structure ? treeHasAttachment(structure) : false,
  };
  if (row.size !== undefined) {
    summary.size = row.size;
  }
  const internalDate = toIso(row.internalDate);
  if (internalDate) {
    summary.internalDate = internalDate;
  }
  const date = toIso(envelope?.date);
  if (date) {
    summary.date = date;
  }
  if (envelope?.subject) {
    summary.subject = envelope.subject;
  }
  if (envelope?.messageId) {
    summary.messageId = envelope.messageId;
  }
  if (envelope?.inReplyTo) {
    summary.inReplyTo = envelope.inReplyTo;
  }
  if (row.labels) {
    summary.labels = [...row.labels];
  }
  if (row.threadId) {
    summary.threadId = row.threadId;
  }
  if (row.emailId) {
    summary.emailId = row.emailId;
  }
  const modseq = bigintToString(row.modseq);
  if (modseq) {
    summary.modseq = modseq;
  }
  summaryStructure.set(summary, structure);
  return summary;
}

function mapAddresses(
  addresses: Array<{ name?: string; address?: string }> | undefined,
): AddressParts[] {
  if (!addresses) {
    return [];
  }
  return addresses.map((item) => {
    const mapped: AddressParts = {};
    if (item.name) {
      mapped.name = item.name;
    }
    if (item.address) {
      mapped.address = item.address;
    }
    return mapped;
  });
}

function toMailboxInfo(item: ListResponse): MailboxInfo {
  const info: MailboxInfo = {
    path: item.path,
    name: item.name,
    delimiter: item.delimiter,
    flags: [...item.flags],
    subscribed: item.subscribed,
    listed: item.listed,
    parentPath: item.parentPath,
  };
  if (item.specialUse) {
    info.specialUse = item.specialUse;
  }
  if (item.specialUseSource) {
    info.specialUseSource = item.specialUseSource;
  }
  return info;
}

function toTree(node: {
  path?: string;
  name?: string;
  delimiter?: string;
  flags?: Set<string>;
  specialUse?: string;
  subscribed?: boolean;
  disabled?: boolean;
  folders?: unknown[];
}): MailboxTree {
  const tree: MailboxTree = {
    folders: (node.folders ?? []).map((folder) => toTree(folder as typeof node)),
  };
  if (node.path) {
    tree.path = node.path;
  }
  if (node.name) {
    tree.name = node.name;
  }
  if (node.delimiter) {
    tree.delimiter = node.delimiter;
  }
  if (node.flags) {
    tree.flags = [...node.flags];
  }
  if (node.specialUse) {
    tree.specialUse = node.specialUse;
  }
  if (node.subscribed !== undefined) {
    tree.subscribed = node.subscribed;
  }
  if (node.disabled !== undefined) {
    tree.disabled = node.disabled;
  }
  return tree;
}

function toStatus(status: {
  path: string;
  messages?: number;
  recent?: number;
  unseen?: number;
  uidNext?: number;
  uidValidity?: bigint;
  highestModseq?: bigint;
  size?: number;
}): StatusInfo {
  const info: StatusInfo = { path: status.path };
  if (status.messages !== undefined) {
    info.messages = status.messages;
  }
  if (status.recent !== undefined) {
    info.recent = status.recent;
  }
  if (status.unseen !== undefined) {
    info.unseen = status.unseen;
  }
  if (status.uidNext !== undefined) {
    info.uidNext = status.uidNext;
  }
  const validity = bigintToString(status.uidValidity);
  if (validity) {
    info.uidValidity = validity;
  }
  const modseq = bigintToString(status.highestModseq);
  if (modseq) {
    info.highestModseq = modseq;
  }
  if (status.size !== undefined) {
    info.size = status.size;
  }
  return info;
}

function toBodyNode(node: MessageStructureObject | undefined): BodyNode | null {
  if (!node) {
    return null;
  }
  const [type, subtype] = node.type.split('/');
  const body: BodyNode = {
    type: type || node.type,
    parameters: node.parameters ?? {},
    dispositionParameters: node.dispositionParameters ?? {},
    children: (node.childNodes ?? [])
      .map((child) => toBodyNode(child))
      .filter((child): child is BodyNode => child !== null),
  };
  if (node.part) {
    body.part = node.part;
  }
  if (subtype) {
    body.subtype = subtype;
  }
  if (node.id) {
    body.id = node.id;
  }
  if (node.encoding) {
    body.encoding = node.encoding;
  }
  if (node.size !== undefined) {
    body.size = node.size;
  }
  if (node.disposition) {
    body.disposition = node.disposition;
  }
  if (node.lineCount !== undefined) {
    body.lineCount = node.lineCount;
  }
  return body;
}

function findNode(node: BodyNode | null, part: string): BodyNode | null {
  if (!node) {
    return null;
  }
  if (node.part === part) {
    return node;
  }
  for (const child of node.children) {
    const found = findNode(child, part);
    if (found) {
      return found;
    }
  }
  return null;
}

function treeHasAttachment(node: BodyNode): boolean {
  if (node.disposition?.toLowerCase() === 'attachment') {
    return true;
  }
  const type = `${node.type}/${node.subtype ?? ''}`.toLowerCase();
  if (
    node.children.length === 0 &&
    node.disposition?.toLowerCase() !== 'inline' &&
    !type.startsWith('text/') &&
    !type.startsWith('multipart/')
  ) {
    return true;
  }
  return node.children.some((child) => treeHasAttachment(child));
}

function uidMapToRecord(map: Map<number, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!map) {
    return out;
  }
  for (const [from, to] of map) {
    out[String(from)] = to;
  }
  return out;
}

function isMatchAll(query: Record<string, unknown>): boolean {
  const keys = Object.keys(query);
  return keys.length === 1 && keys[0] === 'all' && query.all === true;
}

export function parseThreadNode(attribute: ImapAttr): ThreadNode {
  if (
    attribute.value !== undefined &&
    (attribute.attributes === undefined || attribute.attributes.length === 0)
  ) {
    const uid = Number(attribute.value);
    return { uid: Number.isInteger(uid) ? uid : undefined, children: [] };
  }
  const items = attribute.attributes ?? [];
  let uid: number | undefined;
  const children: ThreadNode[] = [];
  items.forEach((item, index) => {
    if (
      index === 0 &&
      item.value !== undefined &&
      !(item.attributes && item.attributes.length > 0)
    ) {
      const parsed = Number(item.value);
      if (Number.isInteger(parsed)) {
        uid = parsed;
        return;
      }
    }
    children.push(parseThreadNode(item));
  });
  return { uid, children };
}
