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

export function keepRuntimeAlive(promise: Promise<unknown>): boolean {
  const context = runtimeContext.getStore();
  if (!context?.waitUntil) return false;
  context.waitUntil(promise);
  return true;
}
