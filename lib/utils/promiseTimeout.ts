export const PROMISE_TIMEOUT_MESSAGE = 'promise timeout';

export class ExternalPromise<T> extends Promise<T> {
  reject_ex: (reason?: any) => void;

  resolve_ex: (value: T | PromiseLike<T>) => void;

  routingKey: string;
}

export function promiseTimeout(ms: number, promise: ExternalPromise<any>): Promise<Buffer> {
  let resolveTimer: (value: Buffer) => void;
  let id: NodeJS.Timeout;
  // Create a promise that rejects in <ms> milliseconds
  const timeout = new Promise<Buffer>((resolve, reject) => {
    resolveTimer = resolve;
    id = setTimeout(() => {
      clearTimeout(id);
      promise.reject_ex(PROMISE_TIMEOUT_MESSAGE);
      reject(PROMISE_TIMEOUT_MESSAGE);
    }, ms);
  });

  // Returns a race between our timeout and the passed in promise
  return Promise.race<Buffer>([
    promise,
    timeout,
  ]).then((res) => {
    clearTimeout(id);
    resolveTimer(Buffer.alloc(0));
    return res;
  });
}
