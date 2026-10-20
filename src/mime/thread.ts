export interface ThreadableMessage {
  uid: number;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  subject?: string;
  date?: string;
}

export interface ThreadNode {
  uid?: number;
  messageId?: string;
  children: ThreadNode[];
}

/**
 * Client-side threading using In-Reply-To and References (a simplified JWZ pass).
 * Messages with no ids are grouped by a normalized subject when `bySubject` is set.
 */
export function threadMessages(messages: ThreadableMessage[], bySubject = false): ThreadNode[] {
  const byId = new Map<string, ThreadNode>();
  const nodes: ThreadNode[] = [];
  for (const message of messages) {
    const node: ThreadNode = { uid: message.uid, children: [] };
    if (message.messageId) {
      node.messageId = normalizeId(message.messageId);
      byId.set(node.messageId, node);
    }
    nodes.push(node);
  }
  const roots: ThreadNode[] = [];
  const linked = new Set<ThreadNode>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const node = nodes[index];
    if (!message || !node) {
      continue;
    }
    const parentId = parentReference(message, byId, node);
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent && parent !== node) {
      parent.children.push(node);
      linked.add(node);
    }
  }
  for (const node of nodes) {
    if (!linked.has(node)) {
      roots.push(node);
    }
  }
  if (!bySubject) {
    return roots;
  }
  return groupRootsBySubject(roots, messages);
}

/**
 * Nearest ancestor that is actually in this mailbox.
 * In-Reply-To is tried first, then References from the end, skipping ids that are not present.
 */
function parentReference(
  message: ThreadableMessage,
  byId: Map<string, ThreadNode>,
  self: ThreadNode,
): string | undefined {
  const ordered: string[] = [];
  if (message.inReplyTo) {
    ordered.push(message.inReplyTo);
  }
  const refs = message.references ?? [];
  for (let index = refs.length - 1; index >= 0; index -= 1) {
    const ref = refs[index];
    if (ref) {
      ordered.push(ref);
    }
  }
  const seen = new Set<string>();
  for (const raw of ordered) {
    const id = normalizeId(raw);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const parent = byId.get(id);
    if (parent && parent !== self) {
      return id;
    }
  }
  return undefined;
}

function normalizeId(id: string): string {
  return id.trim().replace(/^<|>$/g, '').toLowerCase();
}

function subjectKey(subject: string | undefined): string {
  return (subject ?? '')
    .replace(/^(re|fwd|fw|aw|sv)\s*(\[\d+\])?\s*:\s*/gi, '')
    .trim()
    .toLowerCase();
}

function groupRootsBySubject(roots: ThreadNode[], messages: ThreadableMessage[]): ThreadNode[] {
  const byUid = new Map(messages.map((message) => [message.uid, message]));
  const groups = new Map<string, ThreadNode>();
  const ordered: ThreadNode[] = [];
  for (const root of roots) {
    const message = root.uid !== undefined ? byUid.get(root.uid) : undefined;
    const key = subjectKey(message?.subject);
    if (!key) {
      ordered.push(root);
      continue;
    }
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, root);
      ordered.push(root);
      continue;
    }
    existing.children.push(root);
  }
  return ordered;
}

/** Flatten a thread tree to a list of UIDs, parent before children. */
export function flattenThread(nodes: ThreadNode[]): number[] {
  const uids: number[] = [];
  const visit = (node: ThreadNode): void => {
    if (node.uid !== undefined) {
      uids.push(node.uid);
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  for (const node of nodes) {
    visit(node);
  }
  return uids;
}
