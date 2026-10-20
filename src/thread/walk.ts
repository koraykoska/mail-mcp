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

/**
 * Header closure. `search` returns messages in one folder whose Message-ID,
 * References, or In-Reply-To contains one of the ids. `outside` returns
 * out-of-scope messages for the same ids. Those messages contribute ids and
 * are returned for excluded counts; they are not items and do not use a cap
 * slot. The walk repeats until no new ids appear or a bound is hit.
 * Ids an out-of-scope hit adds are searched in that same round, so a uid seed
 * does not spend a round only learning the next id.
 * A placeholder seed (empty mailbox, uid 0) records its ids without using a slot.
 */
export async function closeByHeaders(options: {
  seed: ConversationMessage;
  folders: readonly string[];
  maxMessages: number;
  maxRounds: number;
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
  const counted = new Set<string>();
  const outsideMessages: ConversationMessage[] = [];
  const outsideSeen = new Set<string>();
  let truncated = false;
  const remember = (message: ConversationMessage): void => {
    const key = messageKey(message);
    if (byKey.has(key)) {
      return;
    }
    // The Trash/Junk placeholder is not an item. Counting it would hide the
    // last in-scope message under the cap, and the scope filter drops it later.
    const placeholder = message.mailbox === '' && message.uid === 0;
    if (!placeholder) {
      // Copies of one Message-ID are one message. The cap is applied after that,
      // so a second folder does not consume a slot and hide a different message.
      const id = normalizeMessageId(message.messageId);
      const capKey = id || key;
      if (!counted.has(capKey) && counted.size >= options.maxMessages) {
        truncated = true;
        return;
      }
      counted.add(capKey);
    }
    byKey.set(key, { ...message, linked: message.linked || 'header' });
    for (const id of idsOf(message)) {
      known.add(id);
    }
  };
  const searchIds = async (pendingIds: readonly string[]): Promise<void> => {
    for (const folder of options.folders) {
      for (let offset = 0; offset < pendingIds.length && !truncated; offset += 8) {
        const batch = pendingIds.slice(offset, offset + 8);
        const found = await options.search(folder, batch);
        for (const message of found) {
          remember({ ...message, linked: 'header' });
        }
      }
    }
    if (!options.outside || truncated) {
      return;
    }
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
  let rounds = 0;
  for (let round = 0; round < options.maxRounds && !truncated; round += 1) {
    const pending = [...known].filter((id) => !searched.has(id)).sort();
    if (pending.length === 0) {
      break;
    }
    rounds += 1;
    for (const id of pending) {
      searched.add(id);
    }
    await searchIds(pending);
    // An outside hit can add the next hop's id. Search it before the round
    // ends so a uid seed and a Message-ID seed stay inside the same budget.
    const learned = [...known].filter((id) => !searched.has(id)).sort();
    if (learned.length > 0 && !truncated) {
      for (const id of learned) {
        searched.add(id);
      }
      await searchIds(learned);
    }
  }
  if ([...known].some((id) => !searched.has(id))) {
    truncated = true;
  }
  return { messages: [...byKey.values()], outside: outsideMessages, rounds, truncated };
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
