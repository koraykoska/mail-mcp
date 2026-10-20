import type { CompiledSearch } from './search.js';
import type { SortKey } from './sort.js';
import type { ThreadNode } from '../mime/thread.js';

export interface AddressParts {
  name?: string;
  address?: string;
}

export interface MailboxInfo {
  path: string;
  name: string;
  delimiter: string;
  flags: string[];
  specialUse?: string;
  specialUseSource?: string;
  subscribed: boolean;
  listed: boolean;
  parentPath: string;
}

export interface MailboxTree {
  path?: string;
  name?: string;
  delimiter?: string;
  flags?: string[];
  specialUse?: string;
  subscribed?: boolean;
  disabled?: boolean;
  folders: MailboxTree[];
}

export interface StatusInfo {
  path: string;
  messages?: number;
  recent?: number;
  unseen?: number;
  uidNext?: number;
  uidValidity?: string;
  highestModseq?: string;
  size?: number;
}

export interface QuotaInfo {
  path: string;
  quotaRoot?: string;
  resources: Array<{ name: string; used: number; limit: number }>;
}

export interface MessageSummary {
  uid: number;
  seq?: number;
  flags: string[];
  size?: number;
  internalDate?: string;
  date?: string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  from: AddressParts[];
  to: AddressParts[];
  cc: AddressParts[];
  replyTo: AddressParts[];
  hasAttachments: boolean;
  snippet?: string;
  labels?: string[];
  threadId?: string;
  emailId?: string;
  modseq?: string;
}

export interface FetchedPart {
  partId: string;
  content: Buffer;
  contentType?: string;
  charset?: string;
  filename?: string;
  disposition?: string;
  encoding?: string;
  /** True when maxLength cut the part before it was returned. */
  truncated?: boolean;
  cid?: string;
}

export interface FlagUpdate {
  updated: number[];
  modified: number[];
  missing: number[];
}

export interface AclEntry {
  identifier: string;
  rights: string;
}

export interface BodyNode {
  part?: string;
  type: string;
  subtype?: string;
  parameters: Record<string, string>;
  id?: string;
  encoding?: string;
  size?: number;
  disposition?: string;
  dispositionParameters: Record<string, string>;
  children: BodyNode[];
  lineCount?: number;
}

export interface ServerSortResult {
  uids: number[];
  /** Matches for this SORT. Larger than `uids` when `partial` is a page window. */
  total: number;
  /** True when `uids` is only the requested window, not the whole ordered match. */
  partial: boolean;
}

export interface OpenMailbox {
  path: string;
  uidValidity: string;
  uidNext: number;
  exists: number;
  highestModseq?: string;
  search(compiled: CompiledSearch): Promise<number[]>;
  fetchSummaries(
    uids: number[],
    options: { snippet: boolean; snippetChars: number },
  ): Promise<MessageSummary[]>;
  fetchSource(uid: number, maxBytes?: number): Promise<Buffer | null>;
  fetchHeaders(uid: number): Promise<Buffer | null>;
  fetchParts(
    uid: number,
    parts: Array<{ key: string; maxLength?: number }>,
  ): Promise<FetchedPart[]>;
  fetchStructure(uid: number): Promise<BodyNode | null>;
  setFlags(
    uids: number[],
    flags: string[],
    operation: 'add' | 'remove' | 'set',
    unchangedSince?: string,
  ): Promise<FlagUpdate>;
  setLabels(uids: number[], labels: string[], operation: 'add' | 'remove' | 'set'): Promise<void>;
  copy(uids: number[], destination: string): Promise<Record<string, number>>;
  move(uids: number[], destination: string): Promise<Record<string, number>>;
  expunge(uids?: number[]): Promise<void>;
  /** Null when the server has no SORT extension. A refused SORT throws. */
  serverSort(
    compiled: CompiledSearch,
    keys: SortKey[],
    window?: { start: number; count: number },
  ): Promise<ServerSortResult | null>;
  /** Null when THREAD is unavailable. */
  serverThread(
    algorithm: 'REFERENCES' | 'ORDEREDSUBJECT' | 'REFS',
    compiled: CompiledSearch,
  ): Promise<ThreadNode[] | null>;
}

export interface MailboxChange {
  kind: 'exists' | 'expunge' | 'flags';
  path: string;
  uid?: number;
  seq?: number;
  count?: number;
  prevCount?: number;
  flags?: string[];
}

export interface WaitResult {
  timedOut: boolean;
  idleSupported: boolean;
  changes: MailboxChange[];
  status: StatusInfo;
}

export interface ImapSession {
  readonly capabilities: ReadonlyMap<string, boolean | number>;
  hasCapability(name: string): boolean;
  hasExactCapability(name: string): boolean;
  /** True only after ENABLE recorded CONDSTORE, not merely because it was advertised. */
  condstoreEnabled(): boolean;
  serverId(): Record<string, string> | null;
  namespaces(): Promise<{
    personal: Array<{ prefix: string; delimiter: string | null }>;
    other: Array<{ prefix: string; delimiter: string | null }>;
    shared: Array<{ prefix: string; delimiter: string | null }>;
  }>;
  greeting(): string | undefined;
  quota(path?: string): Promise<QuotaInfo | null>;
  listMailboxes(options?: { subscribedOnly?: boolean }): Promise<MailboxInfo[]>;
  listTree(): Promise<MailboxTree>;
  status(path: string): Promise<StatusInfo>;
  createMailbox(path: string): Promise<{ path: string; created: boolean }>;
  renameMailbox(from: string, to: string): Promise<void>;
  deleteMailbox(path: string): Promise<void>;
  subscribe(path: string): Promise<void>;
  unsubscribe(path: string): Promise<void>;
  append(
    path: string,
    raw: Buffer,
    flags?: string[],
    date?: Date,
  ): Promise<{ uid?: number; uidValidity?: string; destination: string }>;
  withMailbox<T>(
    path: string,
    mode: 'read' | 'write',
    fn: (box: OpenMailbox) => Promise<T>,
  ): Promise<T>;
  waitForChanges(path: string, timeoutMs: number): Promise<WaitResult>;
  getAcl(path: string): Promise<AclEntry[]>;
  setAcl(path: string, identifier: string, rights: string, action: 'set' | 'remove'): Promise<void>;
  getMetadata(path: string, entries: string[]): Promise<Record<string, string | null>>;
  setMetadata(path: string, entries: Record<string, string | null>): Promise<void>;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  /**
   * The pool calls this once, after the session is tracked.
   * Invoke the handler when the socket fails or closes on its own so the slot can be dropped.
   */
  bindDisconnect?(handler: () => void): void;
  /** True when this connection failed and must not be returned to the idle pool. */
  hasFailed?(): boolean;
  /** Inactivity budget of the underlying socket. The pool drops an idle session before this elapses. */
  idleBudgetMs?(): number;
}

export function uidList(uids: number[]): string {
  if (uids.length === 0) {
    throw new Error('uid list is empty');
  }
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0] ?? 0;
  let prev = start;
  for (let index = 1; index <= sorted.length; index += 1) {
    const current = sorted[index];
    if (current === prev + 1) {
      prev = current;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}:${prev}`);
    if (current !== undefined) {
      start = current;
      prev = current;
    }
  }
  return parts.join(',');
}

export function toIso(value: Date | string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
}

export function bigintToString(value: bigint | number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.toString();
}
