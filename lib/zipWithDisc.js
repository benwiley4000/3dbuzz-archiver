const { EasyZip } = require('easy-zip2');
const CompressedObject = require('jszip/lib/compressedObject');
const utf8 = require('jszip/lib/utf8');
const utils = require('jszip/lib/utils');
const ZipEntries = require('jszip/lib/zipEntries');
const DataReader = require('jszip/lib/reader/DataReader');
const ArrayReader = require('jszip/lib/reader/ArrayReader');
const GenericWorker = require('jszip/lib/stream/GenericWorker');
const DataLengthProbe = require('jszip/lib/stream/DataLengthProbe');
const mkdirp = require('mkdirp');
const rimraf = require('rimraf');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  getViewsForArrayBuffer,
  readFile,
  timeout,
  sanitizeFilename
} = require('./utils');
const { UINT8_VIEW_SIZE, TEMP_ZIP_WORK_DIR } = require('../constants');

const hashCounts = {};

class FileSequenceWorker extends GenericWorker {
  constructor(md5HashesP) {
    super('FileSequenceWorker');
    this.eventualBytes = 0;
    this.streamStarted = false;
    this.readStream = null;
    this.promise = md5HashesP.then(md5Hashes => {
      return new Promise((resolve, reject) => {
        const filenames = md5Hashes
          .map(hash => path.join(TEMP_ZIP_WORK_DIR, hash));
        let filesLeftToStat = filenames.length;
        for (const filename of filenames) {
          fs.stat(filename, (err, { size }) => {
            if (err) {
              reject(new Error(`Unable to stat ${filename}.`));
              return;
            }
            this.eventualBytes += size;
            if (--filesLeftToStat === 0) {
              resolve(md5Hashes);
            }
          });
        }
      });
    });
  }

  pause() {
    super.pause();
    this.promise.then(() => {
      this.readStream.pause();
    });
  }

  resume() {
    super.resume();
    if (this.streamStarted) {
      this.promise.then(() => {
        this.readStream.resume();
      });
    } else {
      let bytesStreamed = 0;
      const streamFileSequence = md5Hashes => {
        if (!md5Hashes.length) {
          this.end();
          return;
        }
        const md5Hash = md5Hashes[0];
        const filename = path.join(TEMP_ZIP_WORK_DIR, md5Hash);
        const stream = this.readStream = fs.createReadStream(filename);
        stream.on('error', err => {
          this.error(err);
        });
        stream.on('data', data => {
          bytesStreamed += data.length;
          this.push({
            data,
            meta: {
              percent: 100 * bytesStreamed / this.eventualBytes
            }
          });
        });
        stream.on('end', () => {
          if (--hashCounts[md5Hash] === 0) {
            // in other cases this would be unwise but to save disc space
            // we should remove the cached file, and we assume we won't
            // need to read it again.
            fs.unlink(filename, () => null);
            delete hashCounts[md5Hash];
          }
          // otherwise there were multiple files with this same
          // content... which is weird, but we need to wait for them
          // all to be written.

          streamFileSequence(md5Hashes.slice(1));
        });
      };
      this.promise = this.promise.then(streamFileSequence);
      this.streamStarted = true;
    }
  }
}

class CompressedObjectOnDisc extends CompressedObject {
	get compressedContent() {
    return new Promise(async (resolve, reject) => {
      let tries = 3;
      const waitPeriod = 1500;
      // since the setter operates asynchronously we might have to retry on get
      const attemptRead = async () => {
        tries--;
        try {
          if (!this.md5Hashes) {
            throw new Error('We cannot read before writing compressedContent.');
            return;
          }
          // we actually just return an array of hashes as the "content"...
          // our FileSequenceWorker will convert this into a read stream.
          resolve(this.md5Hashes);
        } catch(err) {
          if (tries) {
            await timeout(waitPeriod);
            attemptRead();
          } else {
            reject(err);
          }
        }
      }
      attemptRead();
    });
	}

	set compressedContent(data) {
    mkdirp(TEMP_ZIP_WORK_DIR, err => {
      if (err) {
        console.error('Failed to create zip work directory.');
        process.exit(1);
      }
      let views;
      if (utils.getTypeOf(data) === 'arraybuffer') {
        views = getViewsForArrayBuffer(data);
      } else if (Array.isArray(data)) {
        views = data;
      } else {
        views = [data];
      }
      this.md5Hashes = [];
      for (const view of views) {
        let md5Hash;
        {
          const h = crypto.createHash('md5');
          h.update(view);
          md5Hash = h.digest('hex');
          this.md5Hashes.push(md5Hash);
        }
        if (!hashCounts[md5Hash]) {
          hashCounts[md5Hash] = 1;
          fs.writeFile(path.join(TEMP_ZIP_WORK_DIR, md5Hash), view, err => {
            if (err) {
              console.error(`Failed to write temp data for zip (${md5Hash}).`);
              process.exit(1);
            }
          });
        } else {
          hashCounts[md5Hash] += 1;
        }
      }
    });
	}

  // mostly copied but with a different DataWorker subclass
  getContentWorker() {
    const worker = new FileSequenceWorker(this.compressedContent)
      .pipe(this.compression.uncompressWorker())
      .pipe(new DataLengthProbe('data_length'));
    worker.on('end', () => {
      if (worker.streamInfo['data_length'] !== this.uncompressedSize) {
        throw new Error("Bug : uncompressed data size mismatch");
      }
    });
    return worker;
  }

  // mostly copied but with a different DataWorker subclass
  getCompressedWorker() {
    return new FileSequenceWorker(this.compressedContent)
      .withStreamInfo('compressedSize', this.compressedSize)
      .withStreamInfo('uncompressedSize', this.uncompressedSize)
      .withStreamInfo('crc32', this.crc32)
      .withStreamInfo('compression', this.compression);
  }
}

class ArrayBufferReader extends DataReader {
  constructor(data) {
    super(data);
    // we need to assign this because DataReader tries to read data.length
    this.length = data.byteLength;
    this.views = getViewsForArrayBuffer(data, this.zero);
  }

  byteAt(i) {
    return this.views[Math.floor(i / UINT8_VIEW_SIZE)][i % UINT8_VIEW_SIZE];
  }

  lastIndexOfSignature(sig) {
    const sig0 = sig.charCodeAt(0),
      sig1 = sig.charCodeAt(1),
      sig2 = sig.charCodeAt(2),
      sig3 = sig.charCodeAt(3);
    for (let i = this.length - 4; i >= 0; --i) {
      if (
        this.byteAt(i) === sig0 &&
        this.byteAt(i + 1) === sig1 &&
        this.byteAt(i + 2) === sig2 &&
        this.byteAt(i + 3) === sig3
      ) {
        return i - this.zero;
      }
    }

    return -1;
  }

  readAndCheckSignature(sig) {
    return ArrayReader.prototype.readAndCheckSignature.call(this, sig);
  }

  readData(size) {
    this.checkOffset(size);
    if (size === 0) {
      // in IE10, when using subarray(idx, idx), we get the array [0x00] instead of [].
      return new Uint8Array(0);
    }
    const views = getViewsForArrayBuffer(
      this.data,
      this.zero + this.index,
      size
    );
    this.index += size;
    if (views.length === 1) {
      return views[0];
    }
    // if the data is large we assume it will be read into a
    // CompressedObjectOnDisc instance which will know what to do with an array
    // of TypedArrays. if for some reason we have other segments of data
    // larger than UINT8_VIEW_SIZE then our assumption will be invalid.
    return views;
  }

  readInt(size) {
    // convert 32-bit signed value to 64-bit unsigned value
    return super.readInt(size) >>> 0;
  }
}

class DiscZipEntries extends ZipEntries {
  prepareReader(data) {
    const type = utils.getTypeOf(data);
    if (type === 'arraybuffer') {
      return this.reader = new ArrayBufferReader(data);
    } else {
      return super.prepareReader(data);
    }
  }
}

class ZipWithDisc extends EasyZip {
  constructor(...args) {
    super(...args);
    // recreate the clone method without hardcoding the constructor name
    const { constructor } = this;
    this.clone = function() {
      const newObj = new constructor();
      for (const i in this) {
        if (typeof this[i] !== 'function') {
          newObj[i] = this[i];
        }
      }
      return newObj;
    };
  }

  file(_name, data, o) {
    const name = sanitizeFilename(_name);
    if (data && data instanceof CompressedObject) {
      const _data = new CompressedObjectOnDisc(
        data.compressedSize,
        data.uncompressedSize,
        data.crc32,
        data.compression,
        data.compressedContent
      );
      return super.file(name, _data, o);
    } else {
      return super.file(name, data, o);
    }
  }

  loadAsync(data, options = {}) {
    // just copying what they had
    options = {
      base64: false,
      checkCRC32: false,
      optimizedBinaryString: false,
      createFolders: false,
      decodeFileName: utf8.utf8decode,
      ...options
    };

    // unlike the default implementation we want to keep our data
    // as an ArrayBuffer, not convert it to Uint8Array.
    // we also don't care about the CRC32 check.

    const zipEntries = new DiscZipEntries(options);
    zipEntries.load(data);
    for (const input of zipEntries.files) {
      this.file(input.fileNameStr, input.decompressed, {
        binary: true,
        optimizedBinaryString: true,
        date: input.date,
        dir: input.dir,
        comment : input.fileCommentStr.length ? input.fileCommentStr : null,
        unixPermissions : input.unixPermissions,
        dosPermissions : input.dosPermissions,
        createFolders: options.createFolders
      });
    }
    if (zipEntries.zipComment.length) {
        this.comment = zipEntries.zipComment;
    }

    return Promise.resolve(this);
  }
}

module.exports = ZipWithDisc;
