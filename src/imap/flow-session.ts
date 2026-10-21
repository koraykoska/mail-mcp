import { readFileSync } from 'node:fs';
import {
  ImapFlow,
  type FetchMessageObject,
  type ImapFlowOptions,
  type ListResponse,
  type MessageStructureObject,
  type SearchObject,
} from 'imapflow';
import { searchCompiler } from 'imapflow/lib/search-compiler.js';
import { MailError, mapMailboxOpenError, mapTransportError, serverRefusal } from '../errors.js';
import { capabilityMatches, hasExactCapability as exactCapability } from './capabilities.js';
import { headerValue, messageIds } from '../mime/headers.js';
import { decodeTransfer, parseSequenceSet } from '../mime/transfer.js';
import { VERSION } from '../version.js';
import type { ResolvedAccount } from '../config/schema.js';
import { dialTarget } from '../net/connect.js';
import type { Logger } from '../log.js';
import { decodeBody } from '../charset.js';
import { findTextPart } from '../mime/parse.js';
import { makeSnippet, htmlToRoughText } from '../mime/snippet.js';
import type { ThreadNode } from '../mime/thread.js';
import { evaluateSearch, isClientQuery, isMatchAll, type CompiledSearch } from './search.js';
import { sortKeyToImap, type SortKey } from './sort.js';
import { flagsToList, normalizeFlags } from './flags.js';
import {
  bigintToString,
  toIso,
  uidList,
  type AddressParts,
  type BodyNode,
  type FetchedPart,
  type FlagUpdate,
  type ImapSession,
  type MailboxInfo,
  type MailboxTree,
  type MessageSummary,
  type OpenMailbox,
  type QuotaInfo,
  type ServerSortResult,
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
export type AccessTokenProvider = (options?: { force?: boolean }) => Promise<string | undefined>;

export class ImapFlowSession implements ImapSession {
  private client: ImapFlow | undefined;
  private connecting: Promise<void> | undefined;
  private dead = false;
  private literalOverflow = false;
  private onDead: (() => void) | undefined;
  /** Clients closed on purpose. Their error and close events must not evict the pool slot. */
  private readonly retiring = new WeakSet<ImapFlow>();
  /** Latest tagged NO or BAD captured from the IMAP logger. Search turns a refusal into false. */
  private lastRefusal = '';
  /** Socket or timeout failure seen in the IMAP logger. A dead session is not a NO/BAD. */
  private lastBreak: 'timeout' | 'connection' | null = null;
  readonly capabilities = new Map<string, boolean | number>();
  private readonly imapLogger = {
    trace: (): void => undefined,
    debug: (): void => undefined,
    info: (): void => undefined,
    error: (): void => undefined,
    fatal: (): void => undefined,
    warn: (entry: unknown): void => {
      const detail = refusalFromLog(entry);
      if (detail) {
        this.lastRefusal = detail;
        return;
      }
      const kind = breakFromLog(entry);
      if (kind) {
        this.lastBreak = kind;
      }
    },
  };

  constructor(
    private readonly account: ResolvedAccount,
    private readonly accessToken: AccessTokenProvider,
    private readonly logger: Logger,
  ) {}

  hasCapability(name: string): boolean {
    return capabilityMatches(this.capabilities.keys(), name);
  }

  hasExactCapability(name: string): boolean {
    return exactCapability(this.capabilities.keys(), name);
  }

  condstoreEnabled(): boolean {
    const client = this.client;
    if (!client) {
      return false;
    }
    return client.enabled.has('CONDSTORE') || client.enabled.has('QRESYNC');
  }

  /**
   * Same decision imapflow uses. ENABLE must have taken effect, or the greeting
   * must be rev2-only. Advertising IMAP4rev2 next to IMAP4rev1 does not count.
   */
  rev2Active(): boolean {
    const client = this.client;
    if (!client) {
      return false;
    }
    return (
      client.enabled.has('IMAP4REV2') ||
      (client.capabilities.has('IMAP4rev2') && !client.capabilities.has('IMAP4rev1'))
    );
  }

  moveSupported(): boolean {
    return this.hasCapability('MOVE') || this.rev2Active();
  }

  uidPlusSupported(): boolean {
    return this.hasCapability('UIDPLUS') || this.rev2Active();
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

  bindDisconnect(handler: () => void): void {
    this.onDead = handler;
  }

  hasFailed(): boolean {
    return this.dead || (this.client !== undefined && !this.client.usable);
  }

  idleBudgetMs(): number {
    return this.account.imap.timeoutMs;
  }

  /** Remember a parser-size failure even when the command later rejects with a follow-on error. */
  takeLiteralOverflow(): boolean {
    const overflow = this.literalOverflow;
    this.literalOverflow = false;
    return overflow;
  }

  /** Drop this connection so the pool opens a new one on the next call. */
  kill(): void {
    if (this.dead) {
      return;
    }
    this.dead = true;
    const client = this.client;
    this.client = undefined;
    if (client) {
      this.retiring.add(client);
      try {
        client.close();
      } catch {
        // The socket is already closing.
      }
    }
    this.onDead?.();
  }

  async connect(): Promise<void> {
    if (this.client?.usable && !this.dead) {
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
    this.dead = true;
    if (!client) {
      return;
    }
    this.retiring.add(client);
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }

  clearRefusal(): void {
    this.lastRefusal = '';
    this.lastBreak = null;
  }

  /** PROTOCOL_ERROR that keeps the server's NO or BAD text when the logger saw one. */
  refused(fallback: string, hint?: string): MailError {
    const detail = this.lastRefusal;
    this.lastRefusal = '';
    return new MailError(
      'PROTOCOL_ERROR',
      detail ? `The mail server returned an error: ${detail}` : fallback,
      hint,
    );
  }

  /**
   * A command that returned false or undefined. A logged NO/BAD on a live session
   * stays PROTOCOL_ERROR. A timeout, a logged socket error, or a session that is
   * no longer usable is not a per-UID failure.
   */
  commandFailure(fallback: string, hint?: string): MailError {
    return this.failureFromState(fallback, hint);
  }

  /** A command that threw. Connection loss and timeouts are not protocol refusals. */
  failTransport(error: unknown, fallback: string, hint?: string): MailError {
    if (error instanceof MailError) {
      return error;
    }
    const mapped = mapTransportError(error);
    if (mapped.code === 'TIMEOUT' || mapped.code === 'CONNECTION_FAILED') {
      this.lastBreak = null;
      this.lastRefusal = '';
      return mapped;
    }
    const fromState = this.failureFromState(fallback, hint);
    if (fromState.code === 'CONNECTION_FAILED' || fromState.code === 'TIMEOUT') {
      return fromState;
    }
    if (serverRefusal(error)) {
      return mapped;
    }
    return fromState;
  }

  private failureFromState(fallback: string, hint?: string): MailError {
    const kind = this.lastBreak;
    this.lastBreak = null;
    if (kind === 'timeout') {
      this.lastRefusal = '';
      return new MailError(
        'TIMEOUT',
        'The mail server did not respond in time.',
        'Increase imap.timeoutMs, and confirm the host and port are reachable.',
      );
    }
    if (kind === 'connection' || this.hasFailed()) {
      this.lastRefusal = '';
      return new MailError(
        'CONNECTION_FAILED',
        'The connection to the mail server failed or was closed.',
        'The command was not confirmed. Resume with the UIDs that were in flight.',
      );
    }
    return this.refused(fallback, hint);
  }

  setCommandTimeout(timeoutMs: number): void {
    const client = this.client;
    if (!client || timeoutMs <= 0) {
      return;
    }
    replaceSocketTimeout(client, timeoutMs);
  }

  close(): void {
    const client = this.client;
    this.client = undefined;
    this.dead = true;
    if (!client) {
      return;
    }
    this.retiring.add(client);
    client.close();
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
    if (!this.hasCapability('QUOTA') && !this.hasCapability('QUOTA=RES')) {
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
      throw mapMailboxOpenError(path, error);
    } finally {
      lock?.release();
    }
  }

  async waitForChanges(path: string, timeoutMs: number): Promise<WaitResult> {
    const client = this.requireClient();
    // ImapFlow arms socketTimeout from the account command budget. A wait is
    // allowed to run longer than that, so raise the watchdog for this call and
    // put the account timeout back afterwards.
    const previousSocketTimeout = replaceSocketTimeout(client, timeoutMs + 1_000);
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
    let early = (): void => undefined;
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
      early = () => {
        if (changes.length > 0) {
          breakIdle();
        }
      };
      client.on('exists', early);
      client.on('expunge', early);
      client.on('flags', early);
      const idleSupportedNow = this.hasCapability('IDLE');
      if (!idleSupportedNow) {
        const pollMs = Math.min(1_000, Math.max(250, Math.floor(timeoutMs / 3)));
        (client as ImapFlow & { maxIdleTime: number | false }).maxIdleTime = pollMs;
      }
      const beforeCount = client.mailbox ? client.mailbox.exists : 0;
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
      if (
        !idleSupported &&
        (status.messages ?? 0) > beforeCount &&
        !changes.some((change) => change.kind === 'exists')
      ) {
        changes.push({
          kind: 'exists',
          path,
          count: status.messages,
          prevCount: beforeCount,
        });
      }
      return { timedOut: changes.length === 0, idleSupported, changes, status };
    } catch (error) {
      throw mapTransportError(error);
    } finally {
      if (client.usable) {
        replaceSocketTimeout(client, previousSocketTimeout);
      }
      lock?.release();
      client.off('exists', onExists);
      client.off('expunge', onExpunge);
      client.off('flags', onFlags);
      client.off('exists', early);
      client.off('expunge', early);
      client.off('flags', early);
    }
  }

  async getAcl(path: string): Promise<Array<{ identifier: string; rights: string }>> {
    if (!this.hasCapability('ACL')) {
      throw new MailError('CAPABILITY_UNSUPPORTED', 'The server does not advertise ACL.');
    }
    const entries: Array<{ identifier: string; rights: string }> = [];
    const raw = this.requireClient() as unknown as RawClient;
    const response = await raw.exec('GETACL', [{ type: 'ATOM', value: path }], {
      untagged: {
        ACL: (untagged) => {
          const values = (untagged.attributes ?? []).map((item) => String(item.value ?? ''));
          for (let index = 1; index + 1 < values.length; index += 2) {
            const identifier = values[index];
            const rights = values[index + 1];
            if (identifier && rights) {
              entries.push({ identifier, rights });
            }
          }
        },
      },
    });
    response.next();
    return entries;
  }

  async setAcl(
    path: string,
    identifier: string,
    rights: string,
    action: 'set' | 'remove',
  ): Promise<void> {
    if (!this.hasCapability('ACL')) {
      throw new MailError('CAPABILITY_UNSUPPORTED', 'The server does not advertise ACL.');
    }
    const raw = this.requireClient() as unknown as RawClient;
    const command = action === 'remove' ? 'DELETEACL' : 'SETACL';
    const attributes =
      action === 'remove'
        ? [
            { type: 'ATOM', value: path },
            { type: 'ATOM', value: identifier },
          ]
        : [
            { type: 'ATOM', value: path },
            { type: 'ATOM', value: identifier },
            { type: 'ATOM', value: rights },
          ];
    const response = await raw.exec(command, attributes);
    response.next();
  }

  async getMetadata(path: string, entries: string[]): Promise<Record<string, string | null>> {
    if (!this.hasCapability('METADATA') && !this.hasCapability('METADATA-SERVER')) {
      throw new MailError('CAPABILITY_UNSUPPORTED', 'The server does not advertise METADATA.');
    }
    const found: Record<string, string | null> = {};
    for (const entry of entries) {
      found[entry] = null;
    }
    const raw = this.requireClient() as unknown as RawClient;
    const response = await raw.exec(
      'GETMETADATA',
      [{ type: 'ATOM', value: path }, entries.map((entry) => ({ type: 'ATOM', value: entry }))],
      {
        untagged: {
          METADATA: (untagged) => {
            const values = untagged.attributes ?? [];
            const pairs = values[1]?.attributes ?? values.slice(1);
            for (let index = 0; index + 1 < pairs.length; index += 2) {
              const key = String(pairs[index]?.value ?? '');
              const rawValue = pairs[index + 1]?.value;
              if (key) {
                found[key] = rawValue === undefined ? null : String(rawValue);
              }
            }
          },
        },
      },
    );
    response.next();
    return found;
  }

  async setMetadata(path: string, entries: Record<string, string | null>): Promise<void> {
    if (!this.hasCapability('METADATA') && !this.hasCapability('METADATA-SERVER')) {
      throw new MailError('CAPABILITY_UNSUPPORTED', 'The server does not advertise METADATA.');
    }
    const pairs = Object.entries(entries).map(([key, value]) => [
      { type: 'ATOM', value: key },
      value === null ? { type: 'ATOM', value: 'NIL' } : { type: 'STRING', value },
    ]);
    const raw = this.requireClient() as unknown as RawClient;
    const response = await raw.exec('SETMETADATA', [{ type: 'ATOM', value: path }, pairs]);
    response.next();
  }

  private async open(): Promise<void> {
    const previous = this.client;
    this.client = undefined;
    if (previous) {
      this.retiring.add(previous);
      previous.close();
    }
    const endpoint = this.account.imap;
    const dial = dialTarget(endpoint);
    const tls: ImapFlowOptions['tls'] = {
      rejectUnauthorized: endpoint.tls.rejectUnauthorized,
      servername: dial.servername,
    };
    if (endpoint.tls.caFile) {
      tls.ca = readFileSync(endpoint.tls.caFile);
    }
    const options: ImapFlowOptions = {
      host: dial.host,
      port: dial.port,
      servername: dial.servername,
      secure: endpoint.secure,
      tls,
      logger: this.imapLogger,
      disableAutoIdle: true,
      connectionTimeout: endpoint.timeoutMs,
      greetingTimeout: Math.min(endpoint.timeoutMs, 16_000),
      socketTimeout: endpoint.timeoutMs,
      clientInfo: { name: 'mail-mcp', version: VERSION },
      auth: await this.authOptions(),
      qresync: true,
    };
    if (!endpoint.secure) {
      options.doSTARTTLS =
        endpoint.starttls === 'required'
          ? true
          : endpoint.starttls === 'disabled'
            ? false
            : undefined;
    }
    let client = new ImapFlow(options);
    try {
      await client.connect();
    } catch (error) {
      client.close();
      const mapped = mapTransportError(error);
      if (mapped.code === 'AUTH_FAILED' && this.account.auth.type === 'oauth2') {
        options.auth = await this.authOptions({ force: true });
        client = new ImapFlow(options);
        try {
          await client.connect();
        } catch (retryError) {
          client.close();
          throw mapTransportError(retryError);
        }
      } else {
        throw mapped;
      }
    }
    this.dead = false;
    this.literalOverflow = false;
    this.client = client;
    this.watch(client);
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

  private async authOptions(options?: { force?: boolean }): Promise<ImapFlowOptions['auth']> {
    if (this.account.auth.type === 'password') {
      return { user: this.account.user, pass: this.account.auth.password };
    }
    const token = await this.accessToken(options);
    if (!token) {
      throw new MailError('AUTH_FAILED', `Account "${this.account.id}" has no OAuth access token.`);
    }
    // ImapFlow prefers AUTH=OAUTHBEARER when the server advertises it, and otherwise uses XOAUTH2.
    return { user: this.account.user, accessToken: token };
  }

  private requireClient(): ImapFlow {
    if (this.dead || !this.client?.usable) {
      throw new MailError('CONNECTION_FAILED', 'IMAP session is not connected.');
    }
    return this.client;
  }

  /**
   * ImapFlow emits 'error' for a quiet socket (ETIMEOUT) and for a literal the parser
   * refuses. With no listener, Node treats that as an uncaught exception and exits.
   * 'close' covers a peer that drops the TCP session without an error event.
   */
  private watch(client: ImapFlow): void {
    client.on('error', (error: unknown) => {
      this.noteFailure(client, error);
    });
    client.on('close', () => {
      this.noteFailure(client);
    });
  }

  private noteFailure(client: ImapFlow, error?: unknown): void {
    if (isOversizedLiteral(error)) {
      this.literalOverflow = true;
    }
    if (this.retiring.has(client) || this.client !== client || this.dead) {
      return;
    }
    this.dead = true;
    this.client = undefined;
    this.onDead?.();
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
    return evaluateSearch(compiled.query, (query) => this.searchPlain(query));
  }

  private async searchPlain(query: Record<string, unknown>): Promise<number[]> {
    const esearch = this.session.hasCapability('ESEARCH') || this.session.rev2Active();
    this.session.clearRefusal();
    const hint =
      'The mailbox was not empty; the search itself failed. Narrow the criteria or check capabilities.';
    let result: Awaited<ReturnType<ImapFlow['search']>>;
    try {
      result = esearch
        ? await this.client.search(query as SearchObject, {
            uid: true,
            returnOptions: ['ALL', 'COUNT'],
          })
        : await this.client.search(query as SearchObject, { uid: true });
    } catch (error) {
      throw this.session.failTransport(error, 'The server refused the SEARCH command.', hint);
    }
    // imapflow returns undefined when no mailbox is selected, and false when the
    // socket dies without a tagged NO/BAD. Neither one is an empty match.
    if (result == null || !this.client.usable || !this.client.mailbox) {
      throw new MailError(
        'CONNECTION_FAILED',
        'The connection to the mail server failed or was closed.',
        'The search did not finish on a selected mailbox, so no UID is reported missing.',
      );
    }
    if (result === false) {
      throw this.session.commandFailure('The server refused the SEARCH command.', hint);
    }
    if (Array.isArray(result)) {
      return result;
    }
    if (result.all) {
      if (result.all.includes('*')) {
        return this.uidsForStar(result.all);
      }
      return parseSequenceSet(result.all);
    }
    return [];
  }

  /**
   * ESEARCH ALL may use `*` for the highest UID. imapflow drops UID `*`, which
   * would make a client-side complement look empty. Resolve `*` to UIDNEXT-1
   * and FETCH that set, so only UIDs the server still has are returned.
   */
  private async uidsForStar(all: string): Promise<number[]> {
    const uidNext = this.uidNext;
    if (!Number.isFinite(uidNext) || uidNext <= 1) {
      return [];
    }
    const concrete = all.replace(/\*/g, String(uidNext - 1));
    if (!this.client.usable || !this.client.mailbox || this.session.hasFailed()) {
      throw new MailError(
        'CONNECTION_FAILED',
        'The connection to the mail server failed or was closed.',
        'The search did not finish on a selected mailbox, so no UID is reported missing.',
      );
    }
    let rows: Awaited<ReturnType<ImapFlow['fetchAll']>>;
    try {
      rows = await this.client.fetchAll(concrete, { uid: true }, { uid: true });
    } catch (error) {
      throw this.session.failTransport(
        error,
        'The server refused the SEARCH command.',
        'The mailbox was not empty; the search itself failed. Narrow the criteria or check capabilities.',
      );
    }
    if (!this.client.usable || !this.client.mailbox || this.session.hasFailed()) {
      throw new MailError(
        'CONNECTION_FAILED',
        'The connection to the mail server failed or was closed.',
        'The search did not finish on a selected mailbox, so no UID is reported missing.',
      );
    }
    return rows.map((row) => row.uid).filter((uid) => Number.isInteger(uid) && uid > 0);
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
        headers: ['REFERENCES', 'IN-REPLY-TO', 'MESSAGE-ID'],
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
    const client = this.client as ImapFlow & { streamer?: { maxLiteralSize: number } };
    const streamer = client.streamer;
    const previousLimit = streamer?.maxLiteralSize;
    // A server that ignores BODY.PEEK[]<0.n> would otherwise deliver the whole
    // message as one literal. Cap the parser so that literal is refused before
    // it is buffered, and the connection is closed.
    if (streamer && maxBytes !== undefined && maxBytes > 0) {
      streamer.maxLiteralSize = Math.min(previousLimit ?? maxBytes, maxBytes);
    }
    try {
      const row = await this.client.fetchOne(
        String(uid),
        { uid: true, source: maxBytes ? { maxLength: maxBytes } : true },
        { uid: true },
      );
      if (!row || !row.source) {
        return null;
      }
      return Buffer.from(row.source);
    } catch (error) {
      if (maxBytes !== undefined) {
        // LiteralTooLarge is emitted on the connection. The fetch promise then rejects
        // with "Connection not available", so give the error listener one turn first.
        await new Promise((resolve) => setImmediate(resolve));
        const overflow = this.session.takeLiteralOverflow();
        if (isOversizedLiteral(error) || overflow) {
          this.session.kill();
          throw new MailError(
            'SIZE_LIMIT',
            `The server sent more than ${maxBytes} bytes for UID ${uid}.`,
            'The partial body limit was ignored, so the connection was closed instead of buffering the message.',
          );
        }
      }
      throw error;
    } finally {
      if (streamer && previousLimit !== undefined) {
        streamer.maxLiteralSize = previousLimit;
      }
    }
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
    const structure = await this.fetchStructure(uid);
    const binary = this.session.hasCapability('BINARY') || this.session.hasCapability('IMAP4REV2');
    const out: FetchedPart[] = [];
    for (const part of parts) {
      const meta =
        findNode(structure, part.key) ??
        (part.key === '1' && structure && structure.children.length === 0 ? structure : null);
      let content: Buffer | undefined;
      let truncated = false;
      try {
        const downloaded = await this.client.download(String(uid), part.key, {
          uid: true,
          binary,
          ...(part.maxLength ? { maxBytes: part.maxLength + 1 } : {}),
        });
        if (downloaded.content) {
          const chunks: Buffer[] = [];
          for await (const chunk of downloaded.content) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          content = Buffer.concat(chunks);
        }
      } catch {
        content = undefined;
      }
      if (!content) {
        const row = await this.client.fetchOne(
          String(uid),
          {
            uid: true,
            bodyParts: [
              part.maxLength ? { key: part.key, maxLength: part.maxLength + 1 } : part.key,
            ],
          },
          { uid: true },
        );
        const raw = row ? row.bodyParts?.get(part.key) : undefined;
        if (raw) {
          content = decodeTransfer(Buffer.from(raw), meta?.encoding);
          if (meta?.parameters.charset && (meta.type ?? '').toLowerCase() === 'text') {
            content = Buffer.from(decodeBody(content, meta.parameters.charset), 'utf8');
          }
        }
      }
      if (!content) {
        continue;
      }
      if (part.maxLength !== undefined && content.length > part.maxLength) {
        content = content.subarray(0, part.maxLength);
        truncated = true;
      }
      const fetched: FetchedPart = { partId: part.key, content, truncated };
      if (meta) {
        const type = meta.subtype ? `${meta.type}/${meta.subtype}` : meta.type;
        fetched.contentType = type;
        if (meta.parameters.charset) {
          fetched.charset = meta.parameters.charset;
        }
        const filename = meta.dispositionParameters.filename || meta.parameters.name;
        if (filename) {
          fetched.filename = filename;
        }
        if (meta.disposition) {
          fetched.disposition = meta.disposition;
        }
        if (meta.id) {
          fetched.cid = meta.id;
        }
        fetched.encoding = 'binary';
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

  private async commandResult<T>(
    run: () => Promise<T>,
    fallback: string,
    hint?: string,
  ): Promise<Exclude<T, false | undefined | null | ''>> {
    let result: T;
    try {
      result = await run();
    } catch (error) {
      throw error instanceof MailError ? error : this.session.failTransport(error, fallback, hint);
    }
    if (!result) {
      throw this.session.commandFailure(fallback, hint);
    }
    return result as Exclude<T, false | undefined | null | ''>;
  }

  async setFlags(
    uids: number[],
    flags: string[],
    operation: 'add' | 'remove' | 'set',
    unchangedSince?: string,
  ): Promise<FlagUpdate> {
    if (uids.length === 0) {
      return { updated: [], modified: [], missing: [] };
    }
    const normalized = normalizeFlags(flags);
    const present = await this.search({ query: { uid: uids.join(',') }, requires: [] });
    const presentSet = new Set(present);
    const missing = uids.filter((uid) => !presentSet.has(uid));
    const targets = uids.filter((uid) => presentSet.has(uid));
    if (targets.length === 0) {
      return { updated: [], modified: [], missing };
    }
    if (unchangedSince) {
      if (!this.session.condstoreEnabled()) {
        throw new MailError(
          'CAPABILITY_UNSUPPORTED',
          'unchangedSince requires CONDSTORE to be enabled on this connection.',
          'The server must answer ENABLE with CONDSTORE. Advertising the token is not enough.',
        );
      }
      const modified = await this.storeConditional(targets, normalized, operation, unchangedSince);
      const modifiedSet = new Set(modified);
      return {
        updated: targets.filter((uid) => !modifiedSet.has(uid)),
        modified,
        missing,
      };
    }
    const options = { uid: true };
    const range = uidList(targets);
    this.session.clearRefusal();
    await this.commandResult(
      () =>
        operation === 'add'
          ? this.client.messageFlagsAdd(range, normalized, options)
          : operation === 'remove'
            ? this.client.messageFlagsRemove(range, normalized, options)
            : this.client.messageFlagsSet(range, normalized, options),
      'The server rejected the flag update.',
    );
    return { updated: targets, modified: [], missing };
  }

  private async storeConditional(
    uids: number[],
    flags: string[],
    operation: 'add' | 'remove' | 'set',
    unchangedSince: string,
  ): Promise<number[]> {
    const op =
      operation === 'remove'
        ? '-FLAGS.SILENT'
        : operation === 'set'
          ? 'FLAGS.SILENT'
          : '+FLAGS.SILENT';
    const raw = this.client as unknown as RawClient;
    const response = await raw.exec('UID STORE', [
      { type: 'SEQUENCE', value: uidList(uids) },
      [
        { type: 'ATOM', value: 'UNCHANGEDSINCE' },
        { type: 'ATOM', value: unchangedSince },
      ],
      { type: 'ATOM', value: op },
      flags.map((flag) => ({ type: 'ATOM', value: flag })),
    ]);
    const modified = modifiedFromResponse(response);
    response.next();
    return modified;
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
    if (uids.length === 0) {
      return;
    }
    // A UID STORE for an unknown UID is often a successful no-op. Search first,
    // the same way flag updates do, so a missing UID is NOT_FOUND.
    const present = await this.search({ query: { uid: uids.join(',') }, requires: [] });
    const presentSet = new Set(present);
    const missing = uids.filter((uid) => !presentSet.has(uid));
    if (missing.length > 0) {
      throw new MailError('NOT_FOUND', `UID ${missing[0]} was not in the mailbox.`);
    }
    const range = uidList(uids);
    const options = { uid: true, useLabels: true };
    this.session.clearRefusal();
    await this.commandResult(
      () =>
        operation === 'add'
          ? this.client.messageFlagsAdd(range, labels, options)
          : operation === 'remove'
            ? this.client.messageFlagsRemove(range, labels, options)
            : this.client.messageFlagsSet(range, labels, options),
      'The server rejected the label update.',
    );
  }

  async copy(uids: number[], destination: string): Promise<Record<string, number>> {
    this.session.clearRefusal();
    const result = await this.commandResult(
      () => this.client.messageCopy(uidList(uids), destination, { uid: true }),
      `COPY to "${destination}" failed.`,
    );
    return uidMapToRecord(result.uidMap);
  }

  async move(
    uids: number[],
    destination: string,
  ): Promise<{ map: Record<string, number>; kept: number[] }> {
    if (uids.length === 0) {
      return { map: {}, kept: [] };
    }
    // imapflow's fallback marks the whole range \Deleted and then expunges it,
    // including messages the COPY did not confirm. Do that ourselves.
    if (!this.session.moveSupported()) {
      if (!this.session.uidPlusSupported()) {
        throw new MailError(
          'CAPABILITY_UNSUPPORTED',
          'This server has neither MOVE nor UIDPLUS. Copying and then expunging would remove every \\Deleted message, not only the requested UIDs.',
          'Use a server with MOVE or UIDPLUS. allowPermanentDelete is not consent to expunge unrelated messages.',
        );
      }
      const copied = await this.copy(uids, destination);
      const confirmed = uids.filter((uid) => copied[String(uid)] !== undefined);
      const kept = uids.filter((uid) => copied[String(uid)] === undefined);
      if (confirmed.length > 0) {
        await this.expunge(confirmed);
      }
      const map: Record<string, number> = {};
      for (const uid of confirmed) {
        const destinationUid = copied[String(uid)];
        if (destinationUid !== undefined) {
          map[String(uid)] = destinationUid;
        }
      }
      return { map, kept };
    }
    this.session.clearRefusal();
    const result = await this.commandResult(
      () => this.client.messageMove(uidList(uids), destination, { uid: true }),
      `MOVE to "${destination}" failed.`,
    );
    return { map: uidMapToRecord(result.uidMap), kept: [] };
  }

  async expunge(uids?: number[]): Promise<void> {
    if (uids && uids.length > 0) {
      this.session.clearRefusal();
      await this.commandResult(
        () => this.client.messageDelete(uidList(uids), { uid: true }),
        'EXPUNGE of the requested UIDs failed.',
      );
      return;
    }
    const raw = this.client as unknown as RawClient;
    const response = await raw.exec('EXPUNGE', false);
    response.next();
  }

  async serverSort(
    compiled: CompiledSearch,
    keys: SortKey[],
    window?: { start: number; count: number },
  ): Promise<ServerSortResult | null> {
    if (!this.session.hasCapability('SORT') || keys.length === 0 || isClientQuery(compiled.query)) {
      return null;
    }
    const searchParts = sortSearchParts(this.client, compiled);
    const displayable = keys.some(
      (key) => key.field === 'from' || key.field === 'to' || key.field === 'subject',
    );
    const displays =
      this.session.hasCapability('SORT=DISPLAY') && displayable ? [true, false] : [false];
    let lastError: unknown;
    for (const display of displays) {
      const criteria: unknown[] = [];
      for (const key of keys) {
        const imap = sortKeyToImap(key, display);
        if (imap.startsWith('REVERSE ')) {
          criteria.push({ type: 'ATOM', value: 'REVERSE' });
          criteria.push({ type: 'ATOM', value: imap.slice('REVERSE '.length) });
        } else {
          criteria.push({ type: 'ATOM', value: imap });
        }
      }
      const plain = [criteria, { type: 'ATOM', value: 'UTF-8' }, ...searchParts];
      const attempts: Array<{ args: unknown[]; partial: boolean }> = [];
      if (this.session.hasCapability('ESORT') && window && !display) {
        const end = window.start + window.count - 1;
        // RFC 5267: RETURN is a command option, not a sort criterion.
        // UID SORT RETURN (PARTIAL x:y COUNT) (REVERSE ARRIVAL) UTF-8 ALL
        attempts.push({
          partial: true,
          args: [
            { type: 'ATOM', value: 'RETURN' },
            [
              { type: 'ATOM', value: 'PARTIAL' },
              { type: 'ATOM', value: `${window.start}:${end}` },
              { type: 'ATOM', value: 'COUNT' },
            ],
            ...plain,
          ],
        });
      }
      attempts.push({ args: plain, partial: false });
      for (const attempt of attempts) {
        const numbers: number[] = [];
        let count: number | undefined;
        try {
          const raw = this.client as unknown as RawClient;
          const response = await raw.exec('UID SORT', attempt.args, {
            untagged: {
              SORT: (untagged) => {
                for (const attribute of untagged.attributes ?? []) {
                  const value = Number(attribute.value);
                  if (Number.isInteger(value)) {
                    numbers.push(value);
                  }
                }
              },
              ESEARCH: (untagged) => {
                const parsed = esearchNumbers(untagged.attributes ?? []);
                numbers.push(...parsed.uids);
                if (parsed.count !== undefined) {
                  count = parsed.count;
                }
              },
            },
          });
          response.next();
          if (count === 0) {
            return { uids: [], total: 0, partial: attempt.partial };
          }
          if (attempt.partial && window) {
            const total =
              count !== undefined
                ? count
                : numbers.length < window.count
                  ? window.start - 1 + numbers.length
                  : window.start + numbers.length;
            return { uids: numbers, total, partial: true };
          }
          return { uids: numbers, total: count ?? numbers.length, partial: false };
        } catch (error) {
          lastError = error;
        }
      }
    }
    // A tagged NO on a live socket can fall back to a client scan. A socket that
    // died inside SORT must not be read again: that read comes back empty.
    await new Promise((resolve) => setImmediate(resolve));
    if (this.sortSocketDead(lastError)) {
      const cause = lastError instanceof Error ? lastError.message : 'SORT failed';
      throw new MailError(
        'CONNECTION_FAILED',
        `Server SORT failed and the IMAP session is no longer connected. ${cause}`,
        'Retry the call. The page was not returned from a dead socket.',
      );
    }
    return null;
  }

  private sortSocketDead(error: unknown): boolean {
    if (!this.client.usable) {
      return true;
    }
    const raw = this.client as unknown as { socket?: { destroyed?: boolean } | false };
    if (raw.socket && typeof raw.socket === 'object' && raw.socket.destroyed) {
      return true;
    }
    const message = error instanceof Error ? error.message : '';
    return /no connection|socket|ECONNRESET|EPIPE|ETIMEOUT|timed out|closed/i.test(message);
  }

  async serverThread(
    algorithm: 'REFERENCES' | 'ORDEREDSUBJECT' | 'REFS',
    compiled: CompiledSearch,
  ): Promise<ThreadNode[] | null> {
    const token = `THREAD=${algorithm}`;
    const bare = this.session.hasExactCapability('THREAD');
    if (!this.session.hasCapability(token) && !bare) {
      return null;
    }
    const nodes: ThreadNode[] = [];
    const searchKey = searchAttributes(this.client, compiled);
    try {
      const raw = this.client as unknown as RawClient;
      const response = await raw.exec(
        'UID THREAD',
        [{ type: 'ATOM', value: algorithm }, { type: 'ATOM', value: 'UTF-8' }, searchKey],
        {
          untagged: {
            THREAD: (untagged) => {
              for (const attribute of untagged.attributes ?? []) {
                nodes.push(parseThreadNode(asThreadAttr(attribute)));
              }
            },
          },
        },
      );
      response.next();
      return nodes;
    } catch (error) {
      throw mapTransportError(error);
    }
  }

  private async fillSnippets(summaries: MessageSummary[], snippetChars: number): Promise<void> {
    if (this.session.hasCapability('PREVIEW') || this.session.hasCapability('SNIPPET')) {
      const preview = await this.fetchPreview(summaries.map((item) => item.uid));
      if (preview.size > 0) {
        for (const summary of summaries) {
          const text = preview.get(summary.uid);
          if (text) {
            summary.snippet = makeSnippet(text, snippetChars);
          }
        }
        return;
      }
    }
    const limit = Math.max(512, snippetChars * 8);
    for (const summary of summaries) {
      const structure = summaryStructure.get(summary) ?? null;
      const part = findTextPart(structure);
      if (!part) {
        continue;
      }
      const node = findNode(structure, part.part);
      const fetched = await this.fetchParts(summary.uid, [{ key: part.part, maxLength: limit }]);
      const content = fetched[0]?.content;
      if (!content) {
        continue;
      }
      const charset = node?.parameters.charset ?? fetched[0]?.charset;
      const decoded =
        fetched[0]?.encoding === 'binary' ? content.toString('utf8') : decodeBody(content, charset);
      summary.snippet = makeSnippet(
        part.kind === 'html' ? htmlToRoughText(decoded) : decoded,
        snippetChars,
      );
    }
  }

  private async fetchPreview(uids: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (uids.length === 0) {
      return out;
    }
    try {
      const raw = this.client as unknown as RawClient;
      await raw
        .exec(
          'UID FETCH',
          [{ type: 'SEQUENCE', value: uidList(uids) }, [{ type: 'ATOM', value: 'PREVIEW' }]],
          {
            untagged: {
              FETCH: (untagged) => {
                let uid: number | undefined;
                let preview: string | undefined;
                const visit = (nodes: ImapAttr[] | undefined): void => {
                  if (!nodes) {
                    return;
                  }
                  for (let index = 0; index < nodes.length; index += 1) {
                    const node = nodes[index];
                    const token = String(node?.value ?? '').toUpperCase();
                    const next = nodes[index + 1];
                    if (token === 'UID' && next?.value !== undefined) {
                      uid = Number(next.value);
                    }
                    if (token === 'PREVIEW' && typeof next?.value === 'string') {
                      preview = next.value;
                    }
                    if (node?.attributes) {
                      visit(node.attributes);
                    }
                  }
                };
                visit(untagged.attributes);
                if (uid && preview) {
                  out.set(uid, preview);
                }
              },
            },
          },
        )
        .then((response) => response.next());
    } catch {
      return out;
    }
    return out;
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
  applyThreadingHeaders(summary, (row as { headers?: Buffer | string }).headers);
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

/** References and In-Reply-To come from HEADER.FIELDS. ENVELOPE omits them on some servers. */
function applyThreadingHeaders(
  summary: MessageSummary,
  headers: Buffer | string | undefined,
): void {
  if (!headers) {
    return;
  }
  const text = Buffer.isBuffer(headers) ? headers.toString('utf8') : headers;
  const messageId = headerValue(text, 'message-id');
  const inReplyTo = messageIds(headerValue(text, 'in-reply-to'))[0];
  const references = messageIds(headerValue(text, 'references'));
  if (messageId) {
    summary.messageId = messageId;
  }
  if (inReplyTo) {
    summary.inReplyTo = inReplyTo;
  }
  if (references.length > 0) {
    summary.references = references;
  }
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
  if (node.part === part || (!node.part && part === '1' && node.children.length === 0)) {
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

/**
 * Search keys for UID SORT. `1:*` is every message, and GreenMail hangs on the
 * parenthesized form `(UID 1:*)`. Send ALL for that range, and spread every
 * other key so a one-key search is not wrapped in an extra pair of parentheses.
 */
function sortSearchParts(client: ImapFlow, compiled: CompiledSearch): unknown[] {
  const keys = Object.keys(compiled.query);
  const normalized =
    keys.length === 1 && compiled.query.uid === '1:*'
      ? { query: { all: true }, requires: compiled.requires }
      : compiled;
  const key = searchAttributes(client, normalized);
  return Array.isArray(key) ? key : [key];
}

function searchAttributes(client: ImapFlow, compiled: CompiledSearch): unknown {
  if (isMatchAll(compiled.query)) {
    return { type: 'ATOM', value: 'ALL' };
  }
  return searchCompiler(client, compiled.query as SearchObject);
}

function modifiedFromResponse(response: unknown): number[] {
  const found: string[] = [];
  collectModified(response, found);
  return found.flatMap((value) => parseSequenceSet(value));
}

function collectModified(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      const item = node[index] as { value?: unknown } | undefined;
      if (
        item &&
        typeof item === 'object' &&
        String(item.value ?? '').toUpperCase() === 'MODIFIED'
      ) {
        const next = node[index + 1] as { value?: unknown } | undefined;
        if (next && next.value !== undefined) {
          out.push(String(next.value));
        }
      }
      collectModified(node[index], out);
    }
    return;
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) {
      collectModified(value, out);
    }
  }
}

function esearchNumbers(attributes: ImapAttr[]): { uids: number[]; count?: number } {
  const uids: number[] = [];
  let count: number | undefined;
  const visit = (nodes: unknown[]): void => {
    for (let index = 0; index < nodes.length; index += 1) {
      const current = nodes[index];
      if (Array.isArray(current)) {
        visit(current);
        continue;
      }
      const node = current as ImapAttr | undefined;
      const token = String(node?.value ?? '').toUpperCase();
      const next = nodes[index + 1];
      const nextAttr = Array.isArray(next) ? undefined : (next as ImapAttr | undefined);
      if (token === 'COUNT' && nextAttr?.value !== undefined) {
        count = Number(nextAttr.value);
      }
      if (token === 'ALL' && next !== undefined) {
        const text = sequenceText(next);
        if (text) {
          uids.push(...parseSequenceSet(text));
        }
      }
      if (token === 'PARTIAL' && next !== undefined) {
        // PARTIAL (1:1 4) is the window range followed by the UID set. The range is not UIDs.
        // ImapFlow represents that parenthesized list as an array.
        const pieces = partialPieces(next);
        const uidText = pieces.length > 1 ? pieces.slice(1).join(',') : '';
        if (uidText) {
          uids.push(...parseSequenceSet(uidText));
        }
      }
      if (nextAttr?.attributes) {
        visit(nextAttr.attributes);
      }
    }
  };
  visit(attributes);
  return { uids, ...(count !== undefined ? { count } : {}) };
}

function partialPieces(node: unknown): string[] {
  const list = Array.isArray(node)
    ? (node as ImapAttr[])
    : node && typeof node === 'object' && Array.isArray((node as ImapAttr).attributes)
      ? ((node as ImapAttr).attributes ?? [])
      : null;
  if (list && list.length > 0) {
    return list
      .map((item) => (item.value !== undefined ? String(item.value) : sequenceText(item)))
      .filter((item) => item.length > 0);
  }
  const text =
    node && typeof node === 'object' && (node as ImapAttr).value !== undefined
      ? String((node as ImapAttr).value).trim()
      : '';
  const match = /^(\d+:\d+)(?:\s+(.+))?$/.exec(text);
  if (!match) {
    return text ? [text] : [];
  }
  const range = match[1] ?? '';
  const rest = match[2]?.trim() ?? '';
  return rest ? [range, rest] : [range];
}

function sequenceText(node: unknown): string {
  if (Array.isArray(node)) {
    return node
      .map((item) => sequenceText(item))
      .filter(Boolean)
      .join(',');
  }
  const attr = node as ImapAttr | undefined;
  if (!attr) {
    return '';
  }
  if (attr.value !== undefined && !attr.attributes?.length) {
    return String(attr.value);
  }
  return (attr.attributes ?? [])
    .map((item) => (item.value !== undefined ? String(item.value) : ''))
    .filter(Boolean)
    .join(',');
}

function asThreadAttr(value: unknown): ImapAttr {
  if (Array.isArray(value)) {
    return { attributes: value.map((item) => asThreadAttr(item)) };
  }
  return value as ImapAttr;
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

function refusalFromLog(entry: unknown): string {
  if (!entry || typeof entry !== 'object') {
    return '';
  }
  const err = (entry as { err?: unknown }).err;
  return serverRefusal(err);
}

function breakFromLog(entry: unknown): 'timeout' | 'connection' | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const err = (entry as { err?: unknown }).err;
  if (!err || typeof err !== 'object' || serverRefusal(err)) {
    return null;
  }
  const like = err as { code?: unknown; message?: unknown };
  const code = typeof like.code === 'string' ? like.code : '';
  const message = typeof like.message === 'string' ? like.message.toLowerCase() : '';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || /timeout|timed out/.test(message)) {
    return 'timeout';
  }
  if (
    code === 'NoConnection' ||
    code === 'EConnectionClosed' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ECONNREFUSED' ||
    /connection not available|socket is already closed|socket closed|econnreset|epipe|connection closed/.test(
      message,
    )
  ) {
    return 'connection';
  }
  return null;
}

function replaceSocketTimeout(client: ImapFlow, timeoutMs: number): number {
  const raw = client as ImapFlow & {
    socketTimeout: number;
    socket?: { setTimeout?: (ms: number) => void } | false;
    writeSocket?: { setTimeout?: (ms: number) => void } | false;
  };
  const previous = raw.socketTimeout;
  raw.socketTimeout = timeoutMs;
  for (const socket of [raw.socket, raw.writeSocket]) {
    if (socket && typeof socket === 'object' && typeof socket.setTimeout === 'function') {
      socket.setTimeout(timeoutMs);
    }
  }
  return previous;
}

function isOversizedLiteral(error: unknown, seen?: Set<unknown>): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const visited = seen ?? new Set<unknown>();
  if (visited.has(error)) {
    return false;
  }
  visited.add(error);
  const like = error as { code?: unknown; message?: unknown; name?: unknown; cause?: unknown };
  const text = `${String(like.code ?? '')} ${String(like.name ?? '')} ${String(like.message ?? '')}`;
  if (/LiteralTooLarge|literal size/i.test(text)) {
    return true;
  }
  return isOversizedLiteral(like.cause, visited);
}
