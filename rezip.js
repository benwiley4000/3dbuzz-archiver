const cheerio = require('cheerio');
const ProgressBar = require('progress');
const requestAnimationFrame = require('raf');
const mkdirp = require('mkdirp');
const fs = require('fs');
const path = require('path');

const ZipWithDisc = require('./zipWithDisc');
const {
  getViewsForArrayBuffer,
  getArrayBufferFromTypedArrays,
  promisePool,
  formatBytes,
  request
} = require('./utils');
const {
  PAGE_URL,
  OUTPUT_ZIP_NAME,
  CACHE_FOLDER_LOCATION,
  FAILED_FETCHES_FILENAME
} = require('./constants');

let cacheCreationFailed = false;
const failedFetches = [];
const returnedWith404 = [];
let totalBytes = 0;

const TOO_MANY_FOR_NOW = 1000 * 1000 * 1000 * 100;

const startTime = Date.now();

console.log(`Fetching data from ${PAGE_URL}...`);

request(PAGE_URL)
  .catch(err => {
    console.error(err);
    console.error(`Failed to load ${PAGE_URL}.`);
    process.exit(1);
  })
  .then(text => cheerio.load(text))
  .then($ => $('a[href$=".zip"]').map((_, a) => a.attribs.href).get())
  .then(zipUrls => {
    const outZip = new ZipWithDisc();
    const loadingProgressBar = progress(`Loading files...`, zipUrls.length * 2);
    promisePool(
      zipUrls.map(url => (() => {
        const zipName = url.slice(url.lastIndexOf('/') + 1);
        const cacheFileLocation = path.join(CACHE_FOLDER_LOCATION, zipName);
        let arrayBufferFetchPromise;
        let loadingFromCache = false;

        const bufferFetchProgressBar = progress(
          `Buffering ${zipName}...`,
          // just setting a high number so we can be relatively precise
          10000
        );

        if (fs.existsSync(cacheFileLocation)) {
          loadingFromCache = true;
          loadingProgressBar.interrupt(`[CACHE] Loading ${zipName}...`);
          loadingProgressBar.cancelRenderFrame();
          arrayBufferFetchPromise = new Promise((resolve, reject) => {
            fs.stat(cacheFileLocation, (err, stats) => {
              if (err) {
                console.error(`Failed to read stats for ${cacheFileLocation}.`);
                process.exit(1);
              }
              const buffers = [];
              let byteLength = 0;
              const readStream = fs.createReadStream(cacheFileLocation);
              readStream.on('error', reject);
              readStream.on('data', buffer => {
                buffers.push(buffer);
                byteLength += buffer.length;
              });
              readStream.on('end', () => {
                loadingProgressBar.renderEachFrame();
                loadingProgressBar.tick();
                loadingProgressBar.interrupt(
                  `[CACHE] Successfully loaded ${zipName} (${formatBytes(byteLength)}).`
                );
                totalBytes += byteLength;
                resolve(getArrayBufferFromTypedArrays(buffers));
              });
            });
          });
        } else {
          loadingProgressBar.interrupt(`[NETWORK] Loading ${zipName}...`);
          loadingProgressBar.cancelRenderFrame();
          arrayBufferFetchPromise = request(url, {
            encoding: null,
            onProgress(p) {
              bufferFetchProgressBar.update(p);
            }
          }).then(arrayBuffer => {
            loadingProgressBar.renderEachFrame();
            // make sure we didn't get an error message from the server
            if (arrayBuffer.byteLength < 50000) {
              try {
                const errorObject = JSON.parse(
                  new Buffer(arrayBuffer).toString()
                );
                // if this didn't fail, we have an error
                returnedWith404.push(url);
                return Promise.reject(errorObject);
              } catch(e) {
                // don't care if wasn't JSON
              }
            }

            loadingProgressBar.tick();
            const { byteLength } = arrayBuffer;
            loadingProgressBar.interrupt(
              `[NETWORK] Successfully loaded ${zipName} (${formatBytes(byteLength)}).`
            );
            totalBytes += byteLength;

            return arrayBuffer;
          });
        }

        if (totalBytes >= TOO_MANY_FOR_NOW) {
          console.error(`Oops: ${formatBytes(totalBytes)}.`);
          process.exit(1);
        }

        return arrayBufferFetchPromise.then(arrayBuffer => {
          let folderName = zipName.slice(0, -4);
          const partStringIndex = folderName.search(/-part-[0-9]+$/);
          if (partStringIndex > -1) {
            folderName = folderName.slice(0, partStringIndex);
          }
          let loadZipPromise;
          try {
            loadZipPromise = outZip.folder(folderName).loadAsync(arrayBuffer, {
              createFolders: true
            });
          } catch(err) {
            loadZipPromise = Promise.reject(err);
          }
          loadZipPromise
            .catch(err => {
              console.error(err);
              console.error(`Failed to include ${url} in output zip.`);
              console.error(
                `(Total bytes loaded so far: ${formatBytes(totalBytes)}`
              );
              process.exit(1);
            })
            .then(() => {
              loadingProgressBar.tick();
              loadingProgressBar.interrupt(
                `${zipName} included in output zip.`
              );

              if (!loadingFromCache && !cacheCreationFailed) {
                mkdirp(CACHE_FOLDER_LOCATION, err => {
                  if (err) {
                    console.error('Failed to create cache directory');
                    cacheCreationFailed = true;
                    return;
                  }
                  appendBuffers(getViewsForArrayBuffer(arrayBuffer));
                  function appendBuffers(buffers) {
                    if (!buffers.length) {
                      return;
                    }
                    fs.appendFile(
                      path.join(CACHE_FOLDER_LOCATION, zipName),
                      buffers[0],
                      err => {
                        if (err) {
                          console.error(`Failed to cache ${zipName}`);
                        } else {
                          appendBuffers(buffers.slice(1));
                        }
                      }
                    );
                  }
                });
              }
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
      // max 1 at a time (larger seems to take up too much memory)
      // TOOD: if we ever raise this again we will need to have a
      // different way of displaying file load progress
      1
    ).then(() => {
      const writeProgressBar = progress(
        `Writing ${OUTPUT_ZIP_NAME} to file...`,
        // just setting a high number so we can be relatively precise
        10000
      );
      let lastFile;
      outZip.writeToFileStream(
        OUTPUT_ZIP_NAME,
        ({ percent, currentFile }) => {
          writeProgressBar.update(percent / 100);
          if (lastFile !== currentFile) {
            writeProgressBar.interrupt(`Writing ${currentFile}...`);
            lastFile = currentFile;
          }
        },
        () => {
          writeProgressBar.update(1);
          console.log(`${OUTPUT_ZIP_NAME} written to file.`);
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
          const { size } = fs.statSync(OUTPUT_ZIP_NAME);
          console.log(
            `Final size of ${OUTPUT_ZIP_NAME}: ${formatBytes(size)}.`
          );
        });
    })
    .catch(err => {
      console.error(err);
      console.error(`Failed to write ${OUTPUT_ZIP_NAME} to file.`);
      process.exit(1);
    });
  });

class PauseableProgressBar extends ProgressBar {
  renderEachFrame() {
    this.cancelRenderFrame();
    this.render();
    this.animationFrame = requestAnimationFrame(() => {
      this.renderEachFrame();
    });
  }

  cancelRenderFrame() {
    requestAnimationFrame.cancel(this.animationFrame);
  }
}

function progress(description, total) {
  let frame;
  const bar = new PauseableProgressBar(
    `${description} [:bar] :percent :elapseds elapsed :etas remaining`,
    {
      width: 39,
      total,
      width: 60 - description.length,
      renderThrottle: 100,
      callback: () => {
        bar.cancelRenderFrame();
      }
    }
  );
  bar.renderEachFrame();
  return bar;
}
