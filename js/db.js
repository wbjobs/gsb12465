'use strict';

const DB_NAME = 'shared-clipboard-queue';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('items')) {
        const items = db.createObjectStore('items', { keyPath: 'id' });
        items.createIndex('seq', 'seq', { unique: true });
      }
      if (!db.objectStoreNames.contains('ops')) {
        const ops = db.createObjectStore('ops', { keyPath: 'id' });
        ops.createIndex('ts', 'ts');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB 被其他连接阻塞'));
  });
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('事务被中止'));
  });
}

async function readState(db) {
  const tx = db.transaction(['items', 'ops', 'meta'], 'readonly');
  const [items, ops, revisionMeta] = await Promise.all([
    reqToPromise(tx.objectStore('items').getAll()),
    reqToPromise(tx.objectStore('ops').getAll()),
    reqToPromise(tx.objectStore('meta').get('revision')),
  ]);
  await txDone(tx);
  items.sort((a, b) => a.seq - b.seq);
  ops.sort((a, b) => b.ts - a.ts);
  return { items, ops, revision: revisionMeta ? revisionMeta.value : 0 };
}
