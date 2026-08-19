import { AsyncLocalStorage } from "node:async_hooks";

export type RuntimeExecutionContext = {
  waitUntil?: (promise: Promise<unknown>) => void;
};

const runtimeContext = new AsyncLocalStorage<RuntimeExecutionContext>();

export function runWithRuntimeContext<T>(
  context: RuntimeExecutionContext,
  callback: () => Promise<T>,
): Promise<T> {
  return runtimeContext.run(context, callback);
}

export function describeRuntimeContext(): Record<string, unknown> {
  const store = runtimeContext.getStore();
  let cfWaitUntil = "missing";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    cfWaitUntil = typeof g["__cfCtx"]?.waitUntil;
  } catch {
    cfWaitUntil = "error";
  }
  return {
    hasStore: Boolean(store),
    keys: store ? Object.keys(store) : [],
    protoKeys: store ? Object.getOwnPropertyNames(Object.getPrototypeOf(store) ?? {}) : [],
    waitUntilType: typeof store?.waitUntil,
    cfWaitUntil,
  };
}

/**
 * Ask the runtime to keep the invocation alive until `promise` settles.
 *
 * This is a compatibility hook, never the architecture: no runtime promises
 * minutes of background work after a response, so long jobs must also be
 * resumable (see monitoring/continuation.server.ts). What waitUntil buys is
 * that work already in flight is not cut off mid-call.
 */
export function keepRuntimeAlive(promise: Promise<unknown>): boolean {
  const waitUntil = resolveWaitUntil();
  if (!waitUntil) return false;
  try {
    waitUntil(promise);
    return true;
  } catch {
    return false;
  }
}

function resolveWaitUntil(): ((promise: Promise<unknown>) => void) | null {
  const store = runtimeContext.getStore();
  if (store?.waitUntil) return store.waitUntil.bind(store);
  // Some adapters expose the execution context globally instead of passing it
  // down; use it rather than silently detaching the work.
  const global = globalThis as { __cfCtx?: RuntimeExecutionContext };
  const fallback = global.__cfCtx;
  if (fallback?.waitUntil) return fallback.waitUntil.bind(fallback);
  return null;
}
