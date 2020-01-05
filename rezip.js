const cheerio = require('cheerio');
const fetch = require('node-fetch');
const { EasyZip } = require('easy-zip2');
const ProgressBar = require('progress');
const requestAnimationFrame = require('raf');
const mkdirp = require('mkdirp');
const fs = require('fs');
const path = require('path');

const pageUrl = 'https://www.3dbuzz.com/';
const outputZipfileName = '3dbuzz.zip';
const cacheFolderLocation = '.cache';
const failedFetchLogLocation = 'failed-fetches.log';

let cacheCreationFailed = false;
const failedFetches = [];
const returnedWith404 = [];

const startTime = Date.now();

console.log(`Fetching data from ${pageUrl}...`);

fetch(pageUrl)
  .then(res => res.text())
  .catch(err => {
    console.error(err);
    console.error(`Failed to load ${pageUrl}.`);
    process.exit(1);
  })
  .then(text => cheerio.load(text))
  .then($ => $('a[href$=".zip"]').map((_, a) => a.attribs.href).get())
  .then(zipUrls => {
    const outZip = new EasyZip();
    const loadingProgressBar = progress(
      `Loading files...`,
      zipUrls.length * 2
    );
    promisePool(
      zipUrls.map(url => (() => {
        const zipName = url.slice(url.lastIndexOf('/') + 1);
        const cacheFileLocation = path.join(cacheFolderLocation, zipName);
        let bufferFetchPromise;
        if (fs.existsSync(cacheFileLocation)) {
          loadingProgressBar.interrupt(`[CACHE] Loading ${zipName}...`);
          bufferFetchPromise = new Promise((resolve, reject) => {
            fs.readFile(cacheFileLocation, (err, data) => {
              if (err) {
                reject(err);
              } else {
                loadingProgressBar.tick();
                loadingProgressBar.interrupt(
                  `[CACHE] Successfully loaded ${zipName} (${formatBytes(data.byteLength)}).`
                );
                resolve(data);
              }
            });
          });
        } else {
          loadingProgressBar.interrupt(`[NETWORK] Loading ${zipName}...`);
          bufferFetchPromise = fetch(url).then(res => res.buffer())
            .then(buffer => {
              // make sure we didn't get an error message from the server
              if (buffer.byteLength < 50000) {
                try {
                  const errorObject = JSON.parse(buffer.toString());
                  // if this didn't fail, we have an error
                  returnedWith404.push(url);
                  return Promise.reject(errorObject);
                } catch(e) {
                  // don't care if wasn't JSON
                }
              }

              loadingProgressBar.tick();
              loadingProgressBar.interrupt(
                `[NETWORK] Successfully loaded ${zipName} (${formatBytes(buffer.byteLength)}).`
              );

              if (!cacheCreationFailed) {
                mkdirp(cacheFolderLocation, err => {
                  if (err) {
                    printError('Failed to create cache directory');
                    cacheCreationFailed = true;
                    return;
                  }
                  fs.writeFile(
                    path.join(cacheFolderLocation, zipName),
                    buffer,
                    err => {
                      if (err) {
                        printError(`Failed to cache ${zipName}`);
                      }
                    }
                  );
                  function printError(message) {
                    if (progress.curr >= progress.total) {
                      console.error(message);
                    } else {
                      progress.interrupt(message);
                    }
                  }
                });
              }

              return buffer;
            });
        }

        return bufferFetchPromise.then(buffer => {
          let folderName = zipName.slice(0, -4);
          const partStringIndex = folderName.search(/-part-[0-9]+$/);
          if (partStringIndex > -1) {
            folderName = folderName.slice(0, partStringIndex);
          }
          return outZip
            .folder(folderName)
            .loadAsync(buffer, { createFolders: true })
            .then(() => {
              loadingProgressBar.tick();
              loadingProgressBar.interrupt(
                `${zipName} included in output zip.`
              );
            })
            .catch(err => {
              console.error(err);
              console.error(`Failed to include ${url} in output zip.`);
              process.exit(1);
            });
        })
        .catch(err => {
          console.error(err);
          console.error(`Failed to load ${zipName}.`);
          failedFetches.push(url);
          // once for load and once for zip include
          loadingProgressBar.tick();
          loadingProgressBar.tick();
        });
      })),
      // max 5 at a time (larger seems to take up too much memory)
      5
    ).then(() => {
      const writeProgressBar = progress(
        `Writing ${outputZipfileName} to file...`,
        // just setting a high number so we can be relatively precise
        10000
      );
      let lastFile;
      outZip.writeToFileStream(
        outputZipfileName,
        ({ percent, currentFile }) => {
          writeProgressBar.update(percent / 100);
          if (lastFile !== currentFile) {
            writeProgressBar.interrupt(`Writing ${currentFile}...`);
            lastFile = currentFile;
          }
        },
        () => {
          writeProgressBar.update(1);
          console.log(`${outputZipfileName} written to file.`);
          if (failedFetches.length) {
            console.warn('Warning! Failed to include the following archives:');
            for (const url of failedFetches) {
              console.warn(`  ${url}`);
            }
          }
          if (returnedWith404.length) {
            console.warn(
              'The following urls seem to be permanently unavailable:'
            );
            for (const url of returnedWith404) {
              console.warn(`  ${url}`);
            }
          }
          console.log(`Finished in ${(Date.now() - startTime) / 1000}s.`);
          const { size } = fs.statSync(outputZipfileName);
          console.log(
            `Final size of ${outputZipfileName}: ${formatBytes(size)}.`
          );
        });
    })
    .catch(err => {
      console.error(err);
      console.error(`Failed to write ${outputZipfileName} to file.`);
      process.exit(1);
    });
  });

function progress(description, total) {
  let frame;
  const bar = new ProgressBar(
    `${description} [:bar] :percent :elapseds elapsed :etas remaining`,
    {
      width: 39,
      total,
      width: 60 - description.length,
      renderThrottle: 100,
      callback: () => {
        requestAnimationFrame.cancel(frame);
      }
    }
  );
  function renderEachFrame() {
    bar.render();
    frame = requestAnimationFrame(renderEachFrame);
  }
  renderEachFrame();
  return bar;
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
