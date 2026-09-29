'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { FakeDB, makeNavigatorLocks } = require('./fake-idb');

global.FakeDB = FakeDB;
Object.defineProperty(globalThis, 'navigator', {
  value: { locks: makeNavigatorLocks() },
  configurable: true,
});
global.assert = require('assert');

const root = path.join(__dirname, '..');
const src = [
  fs.readFileSync(path.join(root, 'js', 'db.js'), 'utf8'),
  fs.readFileSync(path.join(root, 'js', 'queue.js'), 'utf8'),
  fs.readFileSync(path.join(__dirname, 'cases.js'), 'utf8'),
].join('\n');

vm.runInThisContext(src, { filename: 'bundle.js' });
