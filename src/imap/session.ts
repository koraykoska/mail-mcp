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
  ): Promise<void>;
  setLabels(uids: number[], labels: string[], operation: 'add' | 'remove' | 'set'): Promise<void>;
  copy(uids: number[], destination: string): Promise<Record<string, number>>;
  move(uids: number[], destination: string): Promise<Record<string, number>>;
  expunge(uids?: number[]): Promise<void>;
  /** Null when the server has no SORT extension or the command failed closed. */
  serverSort(compiled: CompiledSearch, keys: SortKey[]): Promise<number[] | null>;
  /** Null when THREAD is unavailable. */
  serverThread(
    algorithm: 'REFERENCES' | 'ORDEREDSUBJECT',
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
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
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
