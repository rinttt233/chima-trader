'use strict';
// Entry point executed by the embedded Node runtime (nodejs-mobile) on Android.
//
// The APK ships this folder (assets/nodejs-project) and copies it to the app's
// private files directory on first launch, so __dirname is
//   /data/data/<pkg>/files/nodejs-project
// Account data lives in the sibling `data` folder, which survives APK upgrades
// because NodeService rewrites only `nodejs-project`.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const projectDir = __dirname;
const dataDir = path.join(projectDir, '..', 'data');

// Must be set before app.mjs is imported: server.mjs reads them at module load.
process.env.CHIMATRADER_DATA_DIR = dataDir;
process.env.PORT = process.env.PORT || '8787';
process.env.HOST = process.env.HOST || '127.0.0.1';
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

try {
  fs.mkdirSync(dataDir, { recursive: true });
} catch (err) {
  console.error('[chima] cannot create data dir', dataDir, err && (err.stack || err));
}

const entry = path.join(projectDir, 'app.mjs');
console.log(
  `[chima] node ${process.versions.node} | project ${projectDir} | data ${dataDir} | intl ${typeof Intl}`,
);

import(pathToFileURL(entry).href)
  .then(() => console.log('[chima] server module loaded'))
  .catch((err) => console.error('[chima] server failed to start', err && (err.stack || err)));
