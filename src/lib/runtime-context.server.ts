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

export function keepRuntimeAlive(promise: Promise<unknown>): boolean {
  const waitUntil = runtimeContext.getStore()?.waitUntil;
  if (!waitUntil) return false;
  waitUntil(promise);
  return true;
}