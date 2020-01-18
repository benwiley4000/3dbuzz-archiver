const cheerio = require('cheerio');
const cliProgress = require('cli-progress');
const colors = require('colors');
const requestAnimationFrame = require('raf');
const mkdirp = require('mkdirp');
const fs = require('fs');
const path = require('path');
const smartTruncate = require('smart-truncate');

const ZipWithDisc = require('./zipWithDisc');
const {
  getViewsForArrayBuffer,
  getArrayBufferFromTypedArrays,
  promisePool,
  formatBytes,
  request,
  timeout,
  sanitizeFilename
} = require('./utils');
const {
  PAGE_URL,
  ARCHIVE_URL_PREFIX,
  OUTPUT_ZIP_DIRECTORY,
  OUTPUT_ZIP_NAME,
  CACHE_FOLDER_LOCATION,
  FAILED_FETCHES_FILENAME,
  HTML_FILENAME,
  ROOT_DIR_NAME,
  MAX_CONCURRENT,
  VERBOSE_OUTPUT
} = require('../constants');

const outputZipPath = path.join(OUTPUT_ZIP_DIRECTORY, OUTPUT_ZIP_NAME);

let cacheCreationFailed = false;
const failedFetches = [];
const returnedWith404 = [];
let totalBytes = 0;

const arbitraryProgressBarLength = 10000;

const startTime = Date.now();

console.log(`Fetching data from ${PAGE_URL}...`);

let pageQuery;

request(PAGE_URL)
  .catch(err => {
    console.error(err);
    console.error(`Failed to load ${PAGE_URL}.`);
    process.exit(1);
  })
  .then(removeWaybackToolbar)
  .then(text => pageQuery = cheerio.load(text))
  .then($ => $('a[href$=".zip"]').map((_, a) => a.attribs.href).get().slice(0, 1))
  .then(removeDuplicates)
  .then(zipUrls => {
    const outZip = new ZipWithDisc();
    const rootDir = outZip.folder(ROOT_DIR_NAME);
    const loadingProgressBar = progress(`Loading files...`, zipUrls.length * 2);
    const urlsMappedToFolderNames = {};
    promisePool(
      zipUrls.map(url => (() => {
        const zipName = url.slice(url.lastIndexOf('/') + 1);
        const cacheFileLocation = path.join(CACHE_FOLDER_LOCATION, zipName);
        let arrayBufferFetchPromise;
        let loadingFromCache = false;

        if (fs.existsSync(cacheFileLocation)) {
          loadingFromCache = true;
          arrayBufferFetchPromise = new Promise((resolve, reject) => {
            fs.stat(cacheFileLocation, (err, stats) => {
              if (err) {
                console.error(`Failed to read stats for ${cacheFileLocation}.`);
                process.exit(1);
              }
              const cacheLoadProgressBar = progress(
                `[CACHE] ${zipName}`,
                stats.size
              );
              const buffers = [];
              let byteLength = 0;
              const readStream = fs.createReadStream(cacheFileLocation);
              readStream.on('error', reject);
              readStream.on('data', buffer => {
                buffers.push(buffer);
                byteLength += buffer.length;
                cacheLoadProgressBar.increment(buffer.length);
              });
              readStream.on('end', () => {
                loadingProgressBar.increment();
                if (VERBOSE_OUTPUT) {
                  console.log(
                    `[CACHE] Successfully loaded ${zipName} (${formatBytes(byteLength)}).`
                  );
                }
                totalBytes += byteLength;
                resolve(getArrayBufferFromTypedArrays(buffers));
              });
            });
          });
        } else {
          arrayBufferFetchPromise = requestArrayBuffer();
          function requestArrayBuffer(tries = 3) {
            const bufferFetchProgressBar = progress(
              `[NTWRK] ${zipName}`,
              arbitraryProgressBarLength
            );
            return request(url, {
              encoding: null,
              onProgress(p) {
                bufferFetchProgressBar.update(p * arbitraryProgressBarLength);
              }
            }).then(arrayBuffer => {
              // make sure we didn't get an error message from the server
              if (arrayBuffer.byteLength < 50000) {
                try {
                  const errorObject = JSON.parse(
                    new Buffer(arrayBuffer).toString()
                  );
                  // if this didn't fail, we have an error
                  if (tries === 1) {
                    // it's the last try.. so we'll error out.
                    returnedWith404.push(url);
                  }
                  return Promise.reject(errorObject);
                } catch(e) {
                  // don't care if wasn't JSON
                }
              }

              loadingProgressBar.increment();
              const { byteLength } = arrayBuffer;
              if (VERBOSE_OUTPUT) {
                console.log(
                  `[NETWORK] Successfully loaded ${zipName} (${formatBytes(byteLength)}).`
                );
              }
              totalBytes += byteLength;

              return arrayBuffer;
            }).catch(err => {
              bufferFetchProgressBar.stop();
              const triesLeft = tries - 1;
              if (triesLeft > 0) {
                const wait = triesLeft === 1 ? 7000 : 3000;
                return timeout(wait).then(() => requestArrayBuffer(triesLeft));
              }
              return Promise.reject(err);
            });
          }
        }

        return arrayBufferFetchPromise.then(arrayBuffer => {
          let folderName = zipName.slice(0, -4);
          const partStringIndex = folderName.search(/-part-[0-9]+$/);
          if (partStringIndex > -1) {
            folderName = folderName.slice(0, partStringIndex);
          }
          folderName = sanitizeFilename(folderName);
          urlsMappedToFolderNames[url] = folderName;
          let loadZipPromise;
          try {
            loadZipPromise = rootDir.folder(folderName).loadAsync(arrayBuffer, {
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
              loadingProgressBar.increment();
              if (VERBOSE_OUTPUT) {
                console.log(`${zipName} included in output zip.`);
              }

              if (!loadingFromCache && !cacheCreationFailed) {
                mkdirp(CACHE_FOLDER_LOCATION, err => {
                  if (err) {
                    console.error('Failed to create cache directory');
                    cacheCreationFailed = true;
                    return;
                  }
                  appendBuffers(getViewsForArrayBuffer(arrayBuffer), true);
                  function appendBuffers(buffers, deletePrevious = false) {
                    if (!buffers.length) {
                      return;
                    }
                    fs[deletePrevious ? 'writeFile' : 'appendFile'](
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
          loadingProgressBar.increment(2);
        });
      })),
      MAX_CONCURRENT
    ).then(() => {
      clearProgressPool();
      let failedFetchesLog = '';
      if (failedFetches.length) {
        failedFetchesLog +=
          'Warning! Failed to include the following archives:\n';
        for (const url of failedFetches) {
          failedFetchesLog += `  ${url}\n`;
        }
      }
      if (returnedWith404.length) {
        failedFetchesLog += 'The following urls seem to be unavailable:\n';
        for (const url of returnedWith404) {
          failedFetchesLog += `  ${url}\n`;
        }
      }
      if (failedFetchesLog) {
        rootDir.file(FAILED_FETCHES_FILENAME, failedFetchesLog);
      }

      // rewrite links in html page
      const $ = pageQuery;
      $('.c-series ol a[href$=".zip"]').each((_, elem) => {
        const $elem = $(elem);
        if ($elem.attr('href').endsWith('-part-01.zip')) {
          const folderName = urlsMappedToFolderNames[$elem.attr('href')];
          $elem.text(`${folderName}/`);
          $elem.attr('href', folderName);
        } else {
          $elem.parent('li').remove();
        }
      });
      $('link[href*="/http"]').each((_, link) => {
        const $link = $(link);
        const href = $link.attr('href');
        $link.attr('href', href.slice(href.indexOf('http')));
      });
      $('.l-body')
        .append(
          '<h2>Note: links have been re-written to direct to local files on your machine.</h2>'
        );
      rootDir.file(HTML_FILENAME, $.root().html());

      const writingMessage = `Writing ${outputZipPath} to file...`;
      console.log(writingMessage);
      const writeProgressBar = progress(
        writingMessage,
        // just setting a high number so we can be relatively precise
        arbitraryProgressBarLength
      );
      outZip.writeToFileStream(
        outputZipPath,
        ({ percent, currentFile }) => {
          writeProgressBar.update(arbitraryProgressBarLength * percent / 100, {
            description: `[WRITE] ${currentFile}`
          });
        },
        () => {
          writeProgressBar.update(arbitraryProgressBarLength);
          console.log(`${outputZipPath} written to file.`);
          if (failedFetchesLog) {
            console.log(failedFetchesLog);
          }
          console.log(`Finished in ${(Date.now() - startTime) / 1000}s.`);
          const { size } = fs.statSync(outputZipPath);
          console.log(
            `Final size of ${outputZipPath}: ${formatBytes(size)}.`
          );
          process.exit(0);
        });
    })
    .catch(err => {
      console.error(err);
      console.error(`Failed to write ${outputZipPath} to file.`);
      process.exit(1);
    });
  });

let multibar;
let progressPool;

function clearProgressPool() {
  if (multibar) {
    multibar.stop();
  }
  multibar = new cliProgress.MultiBar({
    //clearOnComplete: true,
    hideCursor: true,
    barsize: 12,
    format: `{description} ${colors.cyan('{bar}')} {percentage}% {duration_formatted} (eta {eta_formatted})`
  }, cliProgress.Presets.shades_classic);
  progressPool = [];
}
clearProgressPool();

function progress(description, total) {
  if (progressPool.length < MAX_CONCURRENT + 1) {
    const bar = multibar.create(total, 0, {
      description: formatDescription(description)
    });
    const entry = { bar, available: false };
    progressPool.push(entry);
    bar.update = function(value, params) {
      this.constructor.prototype.update.call(
        this,
        value,
        params && {
          ...params,
          description: formatDescription(params.description)
        }
      );
    };
    bar.on('update', (total, value) => {
      if (value >= total) {
        entry.available = true;
      }
    });
    return bar;
  }
  const entry = progressPool.find(({ available }) => available);
  entry.available = false;
  const { bar } = entry;
  bar.setTotal(total);
  bar.update(0, { description });
  return bar;

  function formatDescription(description) {
    const length = 35;
    return description && smartTruncate(description, length, {
      position: length - 8
    });
  }
}

function removeWaybackToolbar(html) {
  const part1 = html.split('<!-- BEGIN WAYBACK TOOLBAR INSERT -->')[0];
  const part2 = html.split('<!-- END WAYBACK TOOLBAR INSERT -->')[1];
  return (part1 + part2).replace(new RegExp(ARCHIVE_URL_PREFIX, 'g'), '');
}

function removeDuplicates(list) {
  const newList = [];
  for (const item of list) {
    if (newList.indexOf(item) === -1) {
      newList.push(item);
    }
  }
  return newList;
}
