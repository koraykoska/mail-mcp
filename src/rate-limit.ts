import { MailError } from './errors.js';

interface Bucket {
  stamps: number[];
}

/**
 * Sliding-window counter used to cap SMTP submissions per account.
 */
export class SlidingWindowLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Record an attempt or throw {@link MailError} with code RATE_LIMITED.
   */
  consume(key: string, max: number, windowMs: number): void {
    if (max <= 0 || windowMs <= 0) {
      return;
    }
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { stamps: [] };
    bucket.stamps = bucket.stamps.filter((stamp) => now - stamp < windowMs);
    if (bucket.stamps.length >= max) {
      const oldest = bucket.stamps[0] ?? now;
      const retryIn = Math.max(0, windowMs - (now - oldest));
      throw new MailError(
        'RATE_LIMITED',
        `Send rate limit of ${max} message(s) per ${windowMs}ms has been reached for this account.`,
        `Wait about ${retryIn}ms before sending again, or raise sendRateLimit in the account configuration.`,
      );
    }
    bucket.stamps.push(now);
    this.buckets.set(key, bucket);
  }

  reset(): void {
    this.buckets.clear();
  }
}
