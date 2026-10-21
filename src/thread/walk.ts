import { createHash } from 'node:crypto';
import type { AddressParts } from '../imap/session.js';
import { normalizedSubject } from '../mime/thread.js';

export type LinkKind = 'header' | 'gmail-thrid' | 'objectid' | 'subject';

export interface ConversationMessage {
  mailbox: string;
  uid: number;
  uidValidity: string;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  subject?: string;
  from: AddressParts[];
  to: AddressParts[];
  cc: AddressParts[];
  date?: string;
  internalDate?: string;
  flags: string[];
  snippet?: string;
  hasAttachments: boolean;
  threadId?: string;
  linked: LinkKind;
  alsoIn?: Array<{ mailbox: string; uid: number; uidValidity: string }>;
  listUnsubscribe?: string;
  listId?: string;
  autoSubmitted?: string;
}

export interface ConversationNode {
  mailbox: string;
  uid: number;
  uidValidity: string;
  messageId?: string;
  linked: LinkKind;
  children: ConversationNode[];
}

export function normalizeMessageId(value: string | undefined): string {
  if (!value) {
    return '';
  }
  return value.trim().replace(/^<|>$/g, '').toLowerCase();
}

export function messageKey(message: Pick<ConversationMessage, 'mailbox' | 'uid'>): string {
  return `${message.mailbox}\0${message.uid}`;
}

/**
 * One key for the whole conversation. It is the earliest message that has no
 * parent in the set: its Message-ID when it has one, otherwise mailbox, UIDVALIDITY, and UID.
 * A later reply does not change it, and neither does newest-first versus oldest-first.
 */
export function conversationThreadKey(
  messages: readonly Pick<
    ConversationMessage,
    | 'messageId'
    | 'inReplyTo'
    | 'references'
    | 'date'
    | 'internalDate'
    | 'mailbox'
    | 'uid'
    | 'uidValidity'
  >[],
): string {
  const present = new Set(
    messages.map((item) => normalizeMessageId(item.messageId)).filter((item) => item.length > 0),
  );
  const roots = messages.filter((message) => {
    const parents = [message.inReplyTo, ...message.references]
      .map((item) => normalizeMessageId(item))
      .filter((item) => item.length > 0 && item !== normalizeMessageId(message.messageId));
    return !parents.some((item) => present.has(item));
  });
  const pool = roots.length > 0 ? roots : [...messages];
  const earliest = [...pool].sort((left, right) => {
    const leftDate = left.date || left.internalDate || '';
    const rightDate = right.date || right.internalDate || '';
    if (leftDate < rightDate) {
      return -1;
    }
    if (leftDate > rightDate) {
      return 1;
    }
    if (left.mailbox < right.mailbox) {
      return -1;
    }
    if (left.mailbox > right.mailbox) {
      return 1;
    }
    return left.uid - right.uid;
  })[0];
  if (!earliest) {
    return 'uid:::0';
  }
  return threadKeyFor(earliest);
}

export function threadKeyFor(
  root: Pick<ConversationMessage, 'messageId' | 'mailbox' | 'uid' | 'uidValidity'>,
): string {
  const id = normalizeMessageId(root.messageId);
  if (id) {
    return `mid:${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
  }
  return `uid:${root.mailbox}:${root.uidValidity}:${root.uid}`;
}

function preferenceIndex(mailbox: string, prefer: readonly string[]): number {
  const index = prefer.findIndex((item) => item === mailbox);
  if (index >= 0) {
    return index;
  }
  if (mailbox.toUpperCase() === 'INBOX') {
    return prefer.length;
  }
  return prefer.length + 1;
}

/**
 * Collapse copies that share a Message-ID. Messages without a Message-ID stay separate.
 * The kept copy prefers the caller's mailbox, then the preference list, then the lowest UID.
 */
export function dedupeMessages(
  messages: readonly ConversationMessage[],
  prefer: readonly string[],
): ConversationMessage[] {
  const groups = new Map<string, ConversationMessage[]>();
  const singles: ConversationMessage[] = [];
  for (const message of messages) {
    const id = normalizeMessageId(message.messageId);
    if (!id) {
      singles.push(message);
      continue;
    }
    const group = groups.get(id);
    if (group) {
      group.push(message);
    } else {
      groups.set(id, [message]);
    }
  }
  const merged: ConversationMessage[] = [...singles];
  for (const group of groups.values()) {
    const ranked = [...group].sort((left, right) => {
      const pref = preferenceIndex(left.mailbox, prefer) - preferenceIndex(right.mailbox, prefer);
      if (pref !== 0) {
        return pref;
      }
      const path = left.mailbox < right.mailbox ? -1 : left.mailbox > right.mailbox ? 1 : 0;
      if (path !== 0) {
        return path;
      }
      return left.uid - right.uid;
    });
    const kept = ranked[0];
    if (!kept) {
      continue;
    }
    const alsoIn = ranked.slice(1).map((item) => ({
      mailbox: item.mailbox,
      uid: item.uid,
      uidValidity: item.uidValidity,
    }));
    merged.push(alsoIn.length > 0 ? { ...kept, alsoIn } : kept);
  }
  return merged;
}

function idsOf(message: ConversationMessage): string[] {
  const ids = [message.messageId, message.inReplyTo, ...message.references]
    .map((item) => normalizeMessageId(item))
    .filter((item) => item.length > 0);
  return [...new Set(ids)];
}

function participants(message: ConversationMessage): Set<string> {
  const values = [...message.from, ...message.to, ...message.cc]
    .map((item) => item.address?.trim().toLowerCase() ?? '')
    .filter(Boolean);
  return new Set(values);
}

function overlaps(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
}

/** How many id searches one round may spend. */
export const THREAD_SEARCHES_PER_ROUND = 8;

/**
 * Search budget for a walk. Each round allows 8 searches.
 * The default of 4 rounds is 32 searches. A higher maxRounds raises that
 * ceiling by the same 8, up to the tool maximum of 8 rounds (64 searches).
 */
export function threadSearchCap(maxRounds: number): number {
  const rounds = Math.max(1, Math.floor(maxRounds));
  return rounds * THREAD_SEARCHES_PER_ROUND;
}

/**
 * Earliest id the seed already names. A parent uid and a reply that cites
 * that parent both start here, so the pass budget does not depend on which
 * of those seeds opened the walk.
 */
function closureStartIds(message: ConversationMessage): string[] {
  const referenced = message.references
    .map((item) => normalizeMessageId(item))
    .filter((item) => item.length > 0);
  const first = referenced[0];
  if (first) {
    return [first];
  }
  const reply = normalizeMessageId(message.inReplyTo);
  if (reply) {
    return [reply];
  }
  const own = normalizeMessageId(message.messageId);
  return own ? [own] : [];
}

/**
 * Header closure. `search` returns messages in one folder whose Message-ID,
 * References, or In-Reply-To contains one of the ids. `outside` returns
 * out-of-scope messages for the same ids. Those messages contribute ids and
 * are returned for excluded counts; they are not items and do not use a cap
 * slot. Hitting maxMessages does not skip that scan.
 * Ids an out-of-scope hit adds are searched before the walk moves on, repeating
 * until no new id appears or `threadSearchCap` is reached. Unless `countFrom`
 * is `ids`, passes are counted from the earliest id the seed already names.
 * Two seeds that name the same start therefore see the same ids and the same
 * truncated value, including when the cap stops the walk. A placeholder seed
 * (empty mailbox, uid 0) records its message without using a slot.
 */
export async function closeByHeaders(options: {
  seed: ConversationMessage;
  folders: readonly string[];
  maxMessages: number;
  maxRounds: number;
  /**
   * `start` counts from the earliest id on the seed. `ids` counts from every
   * id on the seed, which is how a fast path keeps messages the cap dropped.
   */
  countFrom?: 'start' | 'ids';
  search: (folder: string, ids: readonly string[]) => Promise<ConversationMessage[]>;
  outside?: (ids: readonly string[]) => Promise<ConversationMessage[]>;
}): Promise<{
  messages: ConversationMessage[];
  outside: ConversationMessage[];
  rounds: number;
  truncated: boolean;
}> {
  const byKey = new Map<string, ConversationMessage>();
  const known = new Set<string>();
  const searched = new Set<string>();
  const outsideMessages: ConversationMessage[] = [];
  const outsideSeen = new Set<string>();
  let truncated = false;
  const remember = (message: ConversationMessage): void => {
    const key = messageKey(message);
    if (!byKey.has(key)) {
      byKey.set(key, { ...message, linked: message.linked || 'header' });
    }
    for (const id of idsOf(message)) {
      known.add(id);
    }
  };
  const searchIds = async (pendingIds: readonly string[]): Promise<void> => {
    for (const folder of options.folders) {
      for (let offset = 0; offset < pendingIds.length; offset += 8) {
        const batch = pendingIds.slice(offset, offset + 8);
        const found = await options.search(folder, batch);
        for (const message of found) {
          remember({ ...message, linked: 'header' });
        }
      }
    }
    if (!options.outside) {
      return;
    }
    // The message cap does not apply here. Out-of-scope hits are counts, not items.
    const found = await options.outside(pendingIds);
    for (const message of found) {
      const key = messageKey(message);
      if (!outsideSeen.has(key)) {
        outsideSeen.add(key);
        outsideMessages.push(message);
      }
      for (const id of idsOf(message)) {
        known.add(id);
      }
    }
  };
  remember({ ...options.seed, linked: 'header' });
  if (options.countFrom !== 'ids') {
    const start = closureStartIds(options.seed);
    if (start.length > 0) {
      known.clear();
      for (const id of start) {
        known.add(id);
      }
    }
  }
  let rounds = 0;
  const passCap = threadSearchCap(options.maxRounds);
  while (rounds < passCap) {
    const pending = [...known].filter((id) => !searched.has(id)).sort();
    if (pending.length === 0) {
      break;
    }
    rounds += 1;
    for (const id of pending) {
      searched.add(id);
    }
    await searchIds(pending);
  }
  if ([...known].some((id) => !searched.has(id))) {
    truncated = true;
  }
  const kept = keepWithinCap([...byKey.values()], options.maxMessages);
  if (kept.dropped) {
    truncated = true;
  }
  return { messages: kept.messages, outside: outsideMessages, rounds, truncated };
}

/**
 * Keep the earliest messages, up to maxMessages distinct Message-IDs.
 * Copies of one id share a slot. A placeholder seed does not use one.
 * The order does not depend on which seed started the walk.
 */
export function keepWithinCap(
  messages: readonly ConversationMessage[],
  maxMessages: number,
): { messages: ConversationMessage[]; dropped: boolean } {
  const placeholders: ConversationMessage[] = [];
  const real: ConversationMessage[] = [];
  for (const message of messages) {
    if (message.mailbox === '' && message.uid === 0) {
      placeholders.push(message);
    } else {
      real.push(message);
    }
  }
  real.sort(byAge);
  const seen = new Set<string>();
  const kept: ConversationMessage[] = [];
  let dropped = false;
  for (const message of real) {
    const id = normalizeMessageId(message.messageId);
    const capKey = id || messageKey(message);
    if (!seen.has(capKey) && seen.size >= maxMessages) {
      dropped = true;
      continue;
    }
    seen.add(capKey);
    kept.push(message);
  }
  return { messages: [...placeholders, ...kept], dropped };
}

function byAge(left: ConversationMessage, right: ConversationMessage): number {
  const leftDate = left.date || left.internalDate || '';
  const rightDate = right.date || right.internalDate || '';
  if (leftDate < rightDate) {
    return -1;
  }
  if (leftDate > rightDate) {
    return 1;
  }
  if (left.mailbox < right.mailbox) {
    return -1;
  }
  if (left.mailbox > right.mailbox) {
    return 1;
  }
  return left.uid - right.uid;
}

/** Add messages that share a normalized subject and at least one participant. Opt-in only. */
export function applySubjectHeuristic(
  messages: readonly ConversationMessage[],
  candidates: readonly ConversationMessage[],
  maxMessages: number,
): { messages: ConversationMessage[]; truncated: boolean } {
  const have = new Set(messages.map((item) => messageKey(item)));
  const ids = new Set(
    messages.map((item) => normalizeMessageId(item.messageId)).filter((item) => item.length > 0),
  );
  const seed = messages[0];
  const seedParticipants = seed ? participants(seed) : new Set<string>();
  const seedSubject = normalizedSubject(seed?.subject);
  const out = [...messages];
  let truncated = false;
  if (!seedSubject) {
    return { messages: out, truncated };
  }
  const ranked = [...candidates].sort((left, right) => {
    if (left.mailbox < right.mailbox) {
      return -1;
    }
    if (left.mailbox > right.mailbox) {
      return 1;
    }
    return left.uid - right.uid;
  });
  for (const candidate of ranked) {
    if (have.has(messageKey(candidate))) {
      continue;
    }
    const id = normalizeMessageId(candidate.messageId);
    if (id && ids.has(id)) {
      continue;
    }
    if (normalizedSubject(candidate.subject) !== seedSubject) {
      continue;
    }
    if (!overlaps(seedParticipants, participants(candidate))) {
      continue;
    }
    if (out.length >= maxMessages) {
      truncated = true;
      break;
    }
    out.push({ ...candidate, linked: 'subject' });
    have.add(messageKey(candidate));
  }
  return { messages: out, truncated };
}

export function buildTree(messages: readonly ConversationMessage[]): ConversationNode[] {
  const nodes = messages.map((message) => {
    const node: ConversationNode = {
      mailbox: message.mailbox,
      uid: message.uid,
      uidValidity: message.uidValidity,
      linked: message.linked,
      children: [],
    };
    if (message.messageId) {
      node.messageId = normalizeMessageId(message.messageId);
    }
    return node;
  });
  const byId = new Map<string, ConversationNode>();
  for (const node of nodes) {
    if (node.messageId && !byId.has(node.messageId)) {
      byId.set(node.messageId, node);
    }
  }
  const linked = new Set<ConversationNode>();
  messages.forEach((message, index) => {
    const node = nodes[index];
    if (!node) {
      return;
    }
    const parentId = parentOf(message, byId, node.messageId);
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent && parent !== node) {
      parent.children.push(node);
      linked.add(node);
    }
  });
  return nodes.filter((node) => !linked.has(node));
}

function parentOf(
  message: ConversationMessage,
  byId: Map<string, ConversationNode>,
  selfId: string | undefined,
): string | undefined {
  const ordered = [message.inReplyTo, ...[...message.references].reverse()];
  const seen = new Set<string>();
  for (const raw of ordered) {
    const id = normalizeMessageId(raw);
    if (!id || seen.has(id) || id === selfId) {
      continue;
    }
    seen.add(id);
    if (byId.has(id)) {
      return id;
    }
  }
  return undefined;
}

export function chronological(
  messages: readonly ConversationMessage[],
  newestFirst: boolean,
): ConversationMessage[] {
  const ordered = [...messages].sort((left, right) => {
    const leftDate = left.date || left.internalDate || '';
    const rightDate = right.date || right.internalDate || '';
    if (leftDate < rightDate) {
      return -1;
    }
    if (leftDate > rightDate) {
      return 1;
    }
    if (left.mailbox < right.mailbox) {
      return -1;
    }
    if (left.mailbox > right.mailbox) {
      return 1;
    }
    return left.uid - right.uid;
  });
  return newestFirst ? ordered.reverse() : ordered;
}
