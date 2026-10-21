import { AsyncLocalStorage } from 'node:async_hooks';

const current = new AsyncLocalStorage<{ signal?: AbortSignal }>();

/** Run a tool call with the MCP abort signal for this request. */
export function runWithRequest<T>(
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return current.run({ signal }, fn);
}

/** The signal for the tool call on this async stack, if one was supplied. */
export function currentRequestSignal(): AbortSignal | undefined {
  return current.getStore()?.signal;
}
