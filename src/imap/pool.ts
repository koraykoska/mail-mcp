import { MailError, isRetryableConnectionError, mapTransportError } from '../errors.js';
import type { Logger } from '../log.js';
import { delay } from '../timeout.js';
import type { ImapSession } from './session.js';

export interface ImapPool {
  use<T>(
    accountId: string,
    fn: (session: ImapSession) => Promise<T>,
    timeoutMs?: number,
  ): Promise<T>;
  close(): Promise<void>;
}

interface Waiter {
  resolve: (session: ImapSession) => void;
  reject: (error: MailError) => void;
  timer?: NodeJS.Timeout;
}

/**
 * Small pool of IMAP sessions per account.
 * A slot is reserved before connect, so parallel callers cannot all pass the size check.
 * A command that already started is never run a second time. Connection setup may retry.
 */
export class ImapConnectionPool implements ImapPool {
  private readonly idle = new Map<string, ImapSession[]>();
  private readonly all = new Map<string, Set<ImapSession>>();
  private readonly opening = new Map<string, number>();
  private readonly waiters = new Map<string, Waiter[]>();
  private closed = false;

  constructor(
    private readonly factory: (accountId: string) => Promise<ImapSession>,
    private readonly size: number,
    private readonly logger: Logger,
  ) {}

  async use<T>(
    accountId: string,
    fn: (session: ImapSession) => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    const session = await this.acquire(accountId, timeoutMs);
    let dropped = false;
    try {
      return await this.runBounded(session, fn, timeoutMs);
    } catch (error) {
      if (isTerminalSessionError(error)) {
        dropped = true;
        await this.drop(accountId, session);
      }
      throw error;
    } finally {
      if (!dropped) {
        this.release(accountId, session);
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [accountId, queue] of this.waiters) {
      for (const waiter of queue) {
        if (waiter.timer) {
          clearTimeout(waiter.timer);
        }
        waiter.reject(new MailError('CONNECTION_FAILED', 'The mail client is shutting down.'));
      }
      this.waiters.delete(accountId);
    }
    const sessions: ImapSession[] = [];
    for (const set of this.all.values()) {
      sessions.push(...set);
    }
    this.all.clear();
    this.idle.clear();
    this.opening.clear();
    await Promise.all(sessions.map((session) => session.logout().catch(() => session.close())));
  }

  private async runBounded<T>(
    session: ImapSession,
    fn: (session: ImapSession) => Promise<T>,
    timeoutMs: number | undefined,
  ): Promise<T> {
    if (!timeoutMs || timeoutMs <= 0) {
      return fn(session);
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
          session.close();
          reject(
            new MailError(
              'TIMEOUT',
              `IMAP timed out after ${timeoutMs}ms.`,
              'The connection was closed so the command is not retried.',
            ),
          );
        }, timeoutMs);
        timer.unref?.();
        fn(session).then(
          (value) => {
            if (timer) {
              clearTimeout(timer);
            }
            resolve(value);
          },
          (error: unknown) => {
            if (timer) {
              clearTimeout(timer);
            }
            reject(error);
          },
        );
      });
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async acquire(accountId: string, timeoutMs?: number): Promise<ImapSession> {
    if (this.closed) {
      throw new MailError('CONNECTION_FAILED', 'The mail client is shutting down.');
    }
    const available = this.idle.get(accountId);
    while (available && available.length > 0) {
      const session = available.pop();
      if (!session) {
        continue;
      }
      try {
        await session.connect();
        return session;
      } catch (error) {
        await this.drop(accountId, session);
        if (!isRetryableConnectionError(error)) {
          throw mapTransportError(error);
        }
      }
    }
    if (this.reserved(accountId) < this.size) {
      this.opening.set(accountId, (this.opening.get(accountId) ?? 0) + 1);
      try {
        const session = await this.factory(accountId);
        try {
          await this.connectWithBackoff(session);
        } catch (error) {
          session.close();
          throw error;
        }
        const set = this.all.get(accountId) ?? new Set<ImapSession>();
        set.add(session);
        this.all.set(accountId, set);
        return session;
      } finally {
        const left = (this.opening.get(accountId) ?? 1) - 1;
        if (left <= 0) {
          this.opening.delete(accountId);
        } else {
          this.opening.set(accountId, left);
        }
      }
    }
    return this.waitForSlot(accountId, timeoutMs);
  }

  private reserved(accountId: string): number {
    return (this.all.get(accountId)?.size ?? 0) + (this.opening.get(accountId) ?? 0);
  }

  private waitForSlot(accountId: string, timeoutMs?: number): Promise<ImapSession> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (timeoutMs && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.removeWaiter(accountId, waiter);
          reject(
            new MailError(
              'TIMEOUT',
              'Timed out waiting for a free IMAP connection.',
              'Raise poolSize or lower the number of overlapping calls.',
            ),
          );
        }, timeoutMs);
        waiter.timer.unref?.();
      }
      const queue = this.waiters.get(accountId) ?? [];
      queue.push(waiter);
      this.waiters.set(accountId, queue);
    });
  }

  private removeWaiter(accountId: string, waiter: Waiter): void {
    const queue = this.waiters.get(accountId);
    if (!queue) {
      return;
    }
    this.waiters.set(
      accountId,
      queue.filter((item) => item !== waiter),
    );
  }

  private release(accountId: string, session: ImapSession): void {
    if (this.closed || !this.all.get(accountId)?.has(session)) {
      return;
    }
    const queue = this.waiters.get(accountId);
    const waiter = queue?.shift();
    if (waiter) {
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      waiter.resolve(session);
      return;
    }
    const list = this.idle.get(accountId) ?? [];
    if (!list.includes(session)) {
      list.push(session);
    }
    this.idle.set(accountId, list);
  }

  private async drop(accountId: string, session: ImapSession): Promise<void> {
    this.all.get(accountId)?.delete(session);
    const idle = this.idle.get(accountId);
    if (idle) {
      this.idle.set(
        accountId,
        idle.filter((item) => item !== session),
      );
    }
    try {
      await session.logout();
    } catch {
      session.close();
    }
    const waiter = this.waiters.get(accountId)?.shift();
    if (waiter && !this.closed && this.reserved(accountId) < this.size) {
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      this.acquire(accountId)
        .then((fresh) => waiter.resolve(fresh))
        .catch((error: unknown) =>
          waiter.reject(error instanceof MailError ? error : mapTransportError(error)),
        );
    }
  }

  private async connectWithBackoff(session: ImapSession): Promise<void> {
    const delays = [0, 200, 600];
    let last: unknown;
    for (const wait of delays) {
      if (wait > 0) {
        await delay(wait);
      }
      if (this.closed) {
        throw new MailError('CONNECTION_FAILED', 'The mail client is shutting down.');
      }
      try {
        await session.connect();
        return;
      } catch (error) {
        last = error;
        if (!isRetryableConnectionError(error)) {
          throw error;
        }
        this.logger.debug('imap connect retry', {
          message: error instanceof Error ? error.message : 'connect failed',
        });
      }
    }
    throw mapTransportError(last);
  }
}

function isTerminalSessionError(error: unknown): boolean {
  if (error instanceof MailError) {
    return error.code === 'TIMEOUT' || error.code === 'CONNECTION_FAILED';
  }
  return isRetryableConnectionError(error);
}
