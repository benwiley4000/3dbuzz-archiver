const ARCHIVE_URL_PREFIX = 'https://web.archive.org/web/20200109023732/';
const PAGE_URL = 'https://www.3dbuzz.com/';

module.exports = {
  ARCHIVE_URL_PREFIX,
  PAGE_URL,
  // override PAGE_URL for now since the official link removed the links
  PAGE_URL: ARCHIVE_URL_PREFIX + PAGE_URL,
  OUTPUT_ZIP_NAME: '3dbuzz.zip',
  CACHE_FOLDER_LOCATION: '.cache',
  FAILED_FETCHES_FILENAME: 'FAILED_FETCHES.log',
  // split arraybuffers into 500MB views
  UINT8_VIEW_SIZE: 1000 * 1000 * 500
};
