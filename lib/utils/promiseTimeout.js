const ERROR_MESSAGE = 'promise timeout';

const promiseTimeout = (ms, promise) => {
  let _resolve;
  let id;
  // Create a promise that rejects in <ms> milliseconds
  const timeout = new Promise((resolve, reject) => {
    _resolve = resolve;
    id = setTimeout(() => {
      clearTimeout(id);
      reject(ERROR_MESSAGE);
    }, ms);
  });

  // Returns a race between our timeout and the passed in promise
  return Promise.race([
    promise,
    timeout,
  ]).then((res) => {
    clearTimeout(id);
    _resolve();
    return res;
  });
};

module.exports = promiseTimeout;

module.exports.timeoutMessage = ERROR_MESSAGE;
