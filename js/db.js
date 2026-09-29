// IndexedDB 持久层：队列的唯一事实来源（source of truth）。
// 标签页关闭 / 刷新 / 离线后，状态都从这里恢复。

const DB_NAME = 'shared-clipboard-queue';
const DB_VERSION = 1;

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('items')) {
        const items = db.createObjectStore('items', { keyPath: 'id' });
        items.createIndex('createdAt', 'createdAt');
        items.createIndex('hash', 'hash');
      }
      if (!db.objectStoreNames.contains('ops')) {
        const ops = db.createObjectStore('ops', { keyPath: 'id' });
        ops.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function reqp(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 在一个事务里执行 work(itemsStore, opsStore)，事务完成后 resolve。
// work 内部只允许 await IDB 请求（reqp），不能 await 其它异步源，
// 否则事务会提前提交。
export function runTx(db, mode, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['items', 'ops'], mode);
    const items = tx.objectStore('items');
    const ops = tx.objectStore('ops');
    let result;
    Promise.resolve()
      .then(() => work(items, ops))
      .then((r) => { result = r; })
      .catch((err) => {
        try { tx.abort(); } catch (_) { /* 已结束 */ }
        reject(err);
      });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export function getAllItems(db) {
  return runTx(db, 'readonly', async (items) => {
    const all = await reqp(items.getAll());
    return all.sort((a, b) => b.createdAt - a.createdAt);
  });
}

export function getAllOps(db) {
  return runTx(db, 'readonly', async (_items, ops) => {
    const all = await reqp(ops.getAll());
    return all.sort((a, b) => b.ts - a.ts);
  });
}
