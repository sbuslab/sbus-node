const ERROR_MESSAGE = 'promise timeout';

const promiseTimeout = (ms, promise) => {
  // Create a promise that rejects in <ms> milliseconds
  const timeout = new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      reject(ERROR_MESSAGE);
    }, ms);
  });

  // Returns a race between our timeout and the passed in promise
  return Promise.race([
    promise,
    timeout,
  ]);
};

module.exports = promiseTimeout;

module.exports.timeoutMessage = ERROR_MESSAGE;
