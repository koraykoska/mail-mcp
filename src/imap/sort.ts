export interface SortKey {
  field: 'arrival' | 'date' | 'from' | 'to' | 'cc' | 'subject' | 'size';
  reverse?: boolean;
}

export interface SortableMessage {
  uid: number;
  arrival?: string;
  date?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  size?: number;
}

/**
 * IMAP SORT is a stable multi-key sort. The first key is the most significant.
 * Missing values sort last for ascending order and first for descending order
 * so undated messages do not jump ahead of real dates when sorting newest-first.
 */
export function sortMessages<T extends SortableMessage>(
  messages: readonly T[],
  keys: readonly SortKey[],
): T[] {
  const decorated = messages.map((message, index) => ({ message, index }));
  decorated.sort((left, right) => {
    for (const key of keys) {
      const compared = compareField(left.message, right.message, key.field);
      if (compared !== 0) {
        return key.reverse ? -compared : compared;
      }
    }
    return left.index - right.index;
  });
  return decorated.map((item) => item.message);
}

function compareField(
  left: SortableMessage,
  right: SortableMessage,
  field: SortKey['field'],
): number {
  if (field === 'size') {
    return compareNumber(left.size, right.size);
  }
  if (field === 'arrival' || field === 'date') {
    return compareNumber(dateValue(left[field]), dateValue(right[field]));
  }
  return compareString(left[field], right[field]);
}

function dateValue(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

function compareNumber(left: number | undefined, right: number | undefined): number {
  if (left === undefined && right === undefined) {
    return 0;
  }
  if (left === undefined) {
    return 1;
  }
  if (right === undefined) {
    return -1;
  }
  return left - right;
}

function compareString(left: string | undefined, right: string | undefined): number {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return 1;
  }
  if (!right) {
    return -1;
  }
  return left.localeCompare(right, undefined, { sensitivity: 'base' });
}

export function sortKeyToImap(key: SortKey, display = false): string {
  let name = key.field === 'arrival' ? 'ARRIVAL' : key.field.toUpperCase();
  if (display && (key.field === 'from' || key.field === 'to' || key.field === 'subject')) {
    name = `DISPLAY${name}`;
  }
  return key.reverse ? `REVERSE ${name}` : name;
}
