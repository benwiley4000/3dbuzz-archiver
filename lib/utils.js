const https = require('https');

const { UINT8_VIEW_SIZE } = require('../constants');

function getViewsForArrayBuffer(
  arrayBuffer,
  startIndex = 0,
  length = arrayBuffer.byteLength - startIndex
) {
  const views = [];
  let offset = 0;
  while (offset < length) {
    const size = Math.min(UINT8_VIEW_SIZE, length - offset);
    views.push(new Uint8Array(arrayBuffer, startIndex + offset, size));
    offset += UINT8_VIEW_SIZE;
  }
  return views;
}

function getArrayBufferFromTypedArrays(arrays) {
  const length = arrays.reduce((length, arr) => length + arr.length, 0);
  const arrayBuffer = new ArrayBuffer(length);
  let i = 0;
  for (const data of arrays) {
    const arr = new Uint8Array(arrayBuffer, i, data.length);
    arr.set(data, 0);
    i += data.length;
  }
  return arrayBuffer;
}

function promisePool(promiseReturningFunctions, maxConcurrent = 10) {
  return new Promise((resolve, reject) => {
    if (promiseReturningFunctions.length === 0) {
      resolve([]);
      return;
    }
    const results = [];
    let rejected = false;
    let nextPromiseIndex = 0;
    let resolvedCount = 0;
    while (
      nextPromiseIndex < maxConcurrent &&
      nextPromiseIndex < promiseReturningFunctions.length
    ) {
      addOneToPool();
    }
    function addOneToPool() {
      const index = nextPromiseIndex;
      promiseReturningFunctions[index]()
        .then(res => onResolve(res, index)).catch(onReject);
      nextPromiseIndex++;
    }
    function onResolve(data, index) {
      if (rejected) {
        return;
      }
      resolvedCount++;
      results[index] = data;
      if (nextPromiseIndex < promiseReturningFunctions.length) {
        addOneToPool();
      } else if (resolvedCount === promiseReturningFunctions.length) {
        resolve(results);
      }
    }
    function onReject(err) {
      rejected = true;
      reject(err);
    }
  });
}

// thanks https://stackoverflow.com/a/18650828/4956731
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// By using Uint8Array views on an ArrayBuffer
// we're able to get a buffer effectively of
// unlimited size (unlike Buffer which maxes
// out around 2GB).
function request(url, { encoding, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    https.request(url, res => {
      const data = [];
      const eventualLength = Number(res.headers['content-length']);
      let length = 0;
      res.on('data', chunk => {
        data.push(chunk);
        length += chunk.length;
        if (eventualLength && onProgress) {
          onProgress(length / eventualLength);
        }
      });
      res.on('end', () => {
        if (encoding === null) {
          resolve(getArrayBufferFromTypedArrays(data));
        } else {
          resolve(Buffer.concat(data).toString());
        }
      });
      res.on('error', err => {
        reject(err);
      });
    }).end();
  });
}

function readFile(pathname) {
  return new Promise((resolve, reject) => {
    fs.readFile(pathname, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
}

function timeout(t) {
  return new Promise(resolve => {
    setTimeout(resolve, t);
  });
}

module.exports = {
  getViewsForArrayBuffer,
  getArrayBufferFromTypedArrays,
  promisePool,
  formatBytes,
  request,
  readFile,
  timeout
};
