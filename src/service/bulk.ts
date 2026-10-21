import { MailError } from '../errors.js';

/** UIDs per STORE, COPY, MOVE, or EXPUNGE. Small enough to stop between commands. */
export const BULK_CHUNK_SIZE = 25;

/**
 * Highest bulkBudgetMs. A call that starts its last command at this mark still
 * finishes inside the 60 second MCP request limit.
 */
export const MAX_BULK_BUDGET_MS = 50_000;

/** Default for limits.bulkBudgetMs. */
export const DEFAULT_BULK_BUDGET_MS = 20_000;

export interface UidResult {
  uid: number;
  ok: boolean;
  code?: string;
  message?: string;
  value?: unknown;
}

export type BulkStop = 'budget' | 'cancelled' | 'connection' | null;

export interface ChunkProgress {
  results: UidResult[];
  remaining: number[];
  complete: boolean;
  stopped: BulkStop;
}

/**
 * Apply `onChunk` to successive UID slices until the list, the budget, or the
 * abort signal runs out. A chunk that is already running is allowed to finish.
 * A timeout puts that slice back into `remaining` with `stopped: 'budget'`.
 * A dropped connection does the same with `stopped: 'connection'`. A retry must
 * not assume the server applied that slice.
 */
export async function runInChunks(options: {
  uids: number[];
  budgetMs: number;
  signal?: AbortSignal;
  chunkSize?: number;
  beforeChunk?: () => void;
  onChunk: (uids: number[]) => Promise<UidResult[]>;
}): Promise<ChunkProgress> {
  const budget = Math.min(Math.max(0, options.budgetMs), MAX_BULK_BUDGET_MS);
  const deadline = Date.now() + budget;
  const size = options.chunkSize ?? BULK_CHUNK_SIZE;
  const results: UidResult[] = [];
  const pending = [...options.uids];
  let stopped: ChunkProgress['stopped'] = null;
  while (pending.length > 0) {
    if (options.signal?.aborted) {
      stopped = 'cancelled';
      break;
    }
    if (Date.now() >= deadline) {
      stopped = 'budget';
      break;
    }
    options.beforeChunk?.();
    const chunk = pending.splice(0, size);
    try {
      const rows = await options.onChunk(chunk);
      results.push(...rows);
    } catch (error) {
      const mapped =
        error instanceof MailError
          ? error
          : new MailError('PROTOCOL_ERROR', 'The UID operation failed.');
      if (mapped.code === 'TIMEOUT' || mapped.code === 'CONNECTION_FAILED') {
        pending.unshift(...chunk);
        stopped = mapped.code === 'CONNECTION_FAILED' ? 'connection' : 'budget';
        break;
      }
      if (!results.some((item) => item.ok)) {
        throw mapped;
      }
      for (const uid of chunk) {
        results.push({ uid, ok: false, code: mapped.code, message: mapped.message });
      }
      break;
    }
  }
  return {
    results,
    remaining: pending,
    complete: pending.length === 0 && stopped === null,
    stopped,
  };
}

/**
 * Run a UID set, and split it when the server says one UID is missing.
 * The success path stays one command. A missing UID does not fail its neighbours.
 */
export async function isolateNotFound(
  uids: number[],
  run: (uids: number[]) => Promise<UidResult[]>,
): Promise<UidResult[]> {
  try {
    return await run(uids);
  } catch (error) {
    if (!(error instanceof MailError) || error.code !== 'NOT_FOUND' || uids.length < 2) {
      throw error;
    }
    const mid = Math.ceil(uids.length / 2);
    const left = await isolateNotFound(uids.slice(0, mid), run);
    const right = await isolateNotFound(uids.slice(mid), run);
    return [...left, ...right];
  }
}
