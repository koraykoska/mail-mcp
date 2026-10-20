import { MailError } from './errors.js';

/**
 * Reject when `work` does not settle within `ms`.
 * `onTimeout` should drop the socket or abort the request so the work cannot finish later and be retried.
 */
export async function withTimeout<T>(
  ms: number,
  label: string,
  work: Promise<T>,
  onTimeout?: () => void,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return work;
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // The timeout result is what the caller handles.
      }
      reject(
        new MailError(
          'TIMEOUT',
          `${label} timed out after ${ms}ms.`,
          'Retry, or raise the account timeoutMs setting.',
        ),
      );
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
