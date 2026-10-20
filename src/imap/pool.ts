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
  /**
   * Run `fn` on another session when one is free. Returns undefined instead of
   * waiting when the pool has no spare slot.
   */
  tryUse?<T>(
    accountId: string,
    fn: (session: ImapSession) => Promise<T>,
    timeoutMs?: number,
  ): Promise<T | undefined>;
  /**
   * Open a session that is not kept in the pool. The caller does not reserve a slot.
   * Returns undefined when the pool is closed or the server rejects the connection.
   */
  useTransient?<T>(
    accountId: string,
    fn: (session: ImapSession) => Promise<T>,
  ): Promise<T | undefined>;
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
  private readonly idleTimers = new Map<ImapSession, NodeJS.Timeout>();
  private readonly dropping = new WeakSet<ImapSession>();
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
    return this.finishUse(accountId, session, fn, timeoutMs);
  }

  async tryUse<T>(
    accountId: string,
    fn: (session: ImapSession) => Promise<T>,
    timeoutMs?: number,
  ): Promise<T | undefined> {
    if (this.closed) {
      return undefined;
    }
    const session = await this.acquire(accountId, timeoutMs, false);
    if (!session) {
      return undefined;
    }
    return this.finishUse(accountId, session, fn, timeoutMs);
  }

  async useTransient<T>(
    accountId: string,
    fn: (session: ImapSession) => Promise<T>,
  ): Promise<T | undefined> {
    if (this.closed) {
      return undefined;
    }
    let session: ImapSession | undefined;
    try {
      session = await this.factory(accountId);
      await this.connectWithBackoff(session);
    } catch {
      session?.close();
      return undefined;
    }
    const connected = session as ImapSession;
    try {
      return await fn(connected);
    } finally {
      await connected.logout().catch(() => {
        connected.close();
      });
    }
  }

  private async finishUse<T>(
    accountId: string,
    session: ImapSession,
    fn: (session: ImapSession) => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
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
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
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

  private acquire(
    accountId: string,
    timeoutMs: number | undefined,
    wait: false,
  ): Promise<ImapSession | undefined>;
  private acquire(accountId: string, timeoutMs?: number, wait?: true): Promise<ImapSession>;
  private async acquire(
    accountId: string,
    timeoutMs?: number,
    wait = true,
  ): Promise<ImapSession | undefined> {
    if (this.closed) {
      throw new MailError('CONNECTION_FAILED', 'The mail client is shutting down.');
    }
    const available = this.idle.get(accountId);
    while (available && available.length > 0) {
      const session = available.pop();
      if (!session) {
        continue;
      }
      this.clearIdleTimer(session);
      if (session.hasFailed?.()) {
        await this.drop(accountId, session);
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
        session.bindDisconnect?.(() => {
          void this.drop(accountId, session);
        });
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
    if (!wait) {
      return undefined;
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
    if (session.hasFailed?.()) {
      void this.drop(accountId, session);
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
    this.armIdleEviction(accountId, session);
  }

  private async drop(accountId: string, session: ImapSession): Promise<void> {
    this.clearIdleTimer(session);
    this.all.get(accountId)?.delete(session);
    const idle = this.idle.get(accountId);
    if (idle) {
      this.idle.set(
        accountId,
        idle.filter((item) => item !== session),
      );
    }
    if (this.dropping.has(session)) {
      return;
    }
    this.dropping.add(session);
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
        .then((fresh) => {
          waiter.resolve(fresh);
        })
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

  private armIdleEviction(accountId: string, session: ImapSession): void {
    this.clearIdleTimer(session);
    const delayMs = idleEvictDelay(session.idleBudgetMs?.() ?? 0);
    if (delayMs <= 0) {
      return;
    }
    // Log out before ImapFlow's socket timer fires. A quiet pooled socket emits
    // 'error' (ETIMEOUT) once that timer elapses, including after a wait restores
    // the shorter account timeout. The session error listener is the backstop.
    const timer = setTimeout(() => {
      this.idleTimers.delete(session);
      void this.drop(accountId, session);
    }, delayMs);
    timer.unref?.();
    this.idleTimers.set(session, timer);
  }

  private clearIdleTimer(session: ImapSession): void {
    const timer = this.idleTimers.get(session);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.idleTimers.delete(session);
  }
}

/** How long an idle session may sit before the pool closes it. Always inside the socket budget. */
export function idleEvictDelay(budgetMs: number): number {
  if (budgetMs <= 0) {
    return 0;
  }
  const slack = Math.min(1_000, Math.max(50, Math.floor(budgetMs / 2)));
  return Math.max(1, budgetMs - slack);
}

function isTerminalSessionError(error: unknown): boolean {
  if (error instanceof MailError) {
    return error.code === 'TIMEOUT' || error.code === 'CONNECTION_FAILED';
  }
  return isRetryableConnectionError(error);
}
