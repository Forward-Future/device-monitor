// JSON files that survive a crash or power cut mid-write: the new version goes to a temporary file
// that is then swapped in, and the previous good version is kept as .bak. Reads fall back to the
// .bak if the file is missing or damaged.
const fs = require('fs');

function parse(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }

function readJson(file, fallback) {
  try { return parse(file); } catch {}
  try { return parse(file + '.bak'); } catch {}
  return fallback;
}

function writeJson(file, data, indent = 2) {
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, indent));
    try { parse(file); fs.copyFileSync(file, file + '.bak'); } catch {}   // only back up a good version
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.error('could not save', file, e.message);
    return false;
  }
}

module.exports = { readJson, writeJson };
