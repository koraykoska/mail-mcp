import { MailError, isRetryableConnectionError, mapTransportError } from '../errors.js';
import type { Logger } from '../log.js';
import { delay } from '../timeout.js';
import type { ImapSession } from './session.js';

export interface ImapPool {
  use<T>(accountId: string, fn: (session: ImapSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Small pool of IMAP sessions per account.
 * A failed connection is discarded and the operation is retried once on a new session.
 */
export class ImapConnectionPool implements ImapPool {
  private readonly idle = new Map<string, ImapSession[]>();
  private readonly all = new Map<string, Set<ImapSession>>();
  private readonly waiters = new Map<string, Array<(session: ImapSession) => void>>();
  private closed = false;

  constructor(
    private readonly factory: (accountId: string) => Promise<ImapSession>,
    private readonly size: number,
    private readonly logger: Logger,
  ) {}

  async use<T>(accountId: string, fn: (session: ImapSession) => Promise<T>): Promise<T> {
    const session = await this.acquire(accountId);
    try {
      return await fn(session);
    } catch (error) {
      if (!isRetryableConnectionError(error)) {
        throw error;
      }
      this.logger.warn('imap operation failed, opening a new connection', { accountId });
      await this.drop(accountId, session);
      const fresh = await this.acquire(accountId);
      try {
        return await fn(fresh);
      } finally {
        this.release(accountId, fresh);
      }
    } finally {
      this.release(accountId, session);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const sessions: ImapSession[] = [];
    for (const set of this.all.values()) {
      sessions.push(...set);
    }
    this.all.clear();
    this.idle.clear();
    await Promise.all(sessions.map((session) => session.logout().catch(() => session.close())));
  }

  private async acquire(accountId: string): Promise<ImapSession> {
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
    const existing = this.all.get(accountId)?.size ?? 0;
    if (existing < this.size) {
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
    }
    return new Promise((resolve) => {
      const queue = this.waiters.get(accountId) ?? [];
      queue.push(resolve);
      this.waiters.set(accountId, queue);
    });
  }

  private release(accountId: string, session: ImapSession): void {
    if (this.closed || !this.all.get(accountId)?.has(session)) {
      return;
    }
    const waiter = this.waiters.get(accountId)?.shift();
    if (waiter) {
      waiter(session);
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
  }

  private async connectWithBackoff(session: ImapSession): Promise<void> {
    const delays = [0, 200, 600];
    let last: unknown;
    for (const wait of delays) {
      if (wait > 0) {
        await delay(wait);
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
