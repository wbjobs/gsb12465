'use strict';

const MAX_ITEMS = 100;
const MAX_OPS = 200;
const LOCK_NAME = 'scq-mutation-lock';

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

async function withLock(fn) {
  if (navigator.locks && navigator.locks.request) {
    return navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, fn);
  }
  return fn();
}

const SharedQueue = {
  db: null,
  onChanged: null,

  init(db, onChanged) {
    this.db = db;
    this.onChanged = onChanged || (() => {});
  },

  async _mutate(tab, type, body) {
    const result = await withLock(async () => {
      const tx = this.db.transaction(['items', 'ops', 'meta'], 'readwrite');
      const itemsStore = tx.objectStore('items');
      const opsStore = tx.objectStore('ops');
      const metaStore = tx.objectStore('meta');

      const metaRows = await reqToPromise(metaStore.getAll());
      const meta = {};
      for (const row of metaRows) meta[row.key] = row.value;
      const revision = meta.revision || 0;

      const ctx = { tx, itemsStore, opsStore, metaStore, seq: meta.seq || 0, skipOp: false, detail: '' };
      const value = await body(ctx);

      metaStore.put({ key: 'seq', value: ctx.seq });
      metaStore.put({ key: 'revision', value: revision + 1 });

      if (!ctx.skipOp) {
        opsStore.put({
          id: newId(),
          tabId: tab.id,
          tabName: tab.name,
          type,
          detail: ctx.detail,
          ts: Date.now(),
        });
        await this._truncateOps(opsStore);
      }

      await txDone(tx);
      return { value, revision: revision + 1 };
    });
    this.onChanged(result.revision);
    return result.value;
  },

  async _truncateOps(opsStore) {
    const count = await reqToPromise(opsStore.count());
    if (count <= MAX_OPS) return;
    const cursorReq = opsStore.index('ts').openCursor();
    let toDelete = count - MAX_OPS;
    await new Promise((resolve, reject) => {
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || toDelete <= 0) return resolve();
        cursor.delete();
        toDelete -= 1;
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  },

  async _truncateItems(itemsStore) {
    const count = await reqToPromise(itemsStore.count());
    if (count <= MAX_ITEMS) return 0;
    let toDelete = count - MAX_ITEMS;
    let removed = 0;
    const cursorReq = itemsStore.index('seq').openCursor();
    await new Promise((resolve, reject) => {
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || toDelete <= 0) return resolve();
        if (!cursor.value.pinned) {
          cursor.delete();
          toDelete -= 1;
          removed += 1;
        }
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
    return removed;
  },

  async enqueue(tab, text, source) {
    const cleaned = String(text == null ? '' : text).replace(/\s+$/g, '');
    if (!cleaned.trim()) return null;
    return this._mutate(tab, source === 'copy' ? 'copy' : 'add', async (ctx) => {
      ctx.detail = snippet(cleaned);
      const all = await reqToPromise(ctx.itemsStore.getAll());
      const dup = all.find((it) => it.text === cleaned);
      let pinned = false;
      if (dup) {
        pinned = !!dup.pinned;
        ctx.itemsStore.delete(dup.id);
      }
      ctx.seq += 1;
      const item = {
        id: newId(),
        text: cleaned,
        pinned,
        seq: ctx.seq,
        createdAt: Date.now(),
        tabId: tab.id,
        tabName: tab.name,
      };
      ctx.itemsStore.put(item);
      const removed = await this._truncateItems(ctx.itemsStore);
      if (removed > 0) {
        ctx.opsStore.put({
          id: newId(), tabId: 'system', tabName: '系统',
          type: 'truncate', detail: `队列超长，截断 ${removed} 条最旧未固定项`, ts: Date.now(),
        });
      }
      return item;
    });
  },

  async takeNext(tab) {
    return this._mutate(tab, 'take', async (ctx) => {
      const all = await reqToPromise(ctx.itemsStore.getAll());
      all.sort((a, b) => a.seq - b.seq);
      const target = all.find((it) => !it.pinned);
      if (!target) {
        ctx.skipOp = true;
        return null;
      }
      ctx.itemsStore.delete(target.id);
      ctx.detail = snippet(target.text);
      return target;
    });
  },

  async remove(tab, id) {
    return this._mutate(tab, 'remove', async (ctx) => {
      const item = await reqToPromise(ctx.itemsStore.get(id));
      if (!item) {
        ctx.skipOp = true;
        return false;
      }
      ctx.itemsStore.delete(id);
      ctx.detail = snippet(item.text);
      return true;
    });
  },

  async togglePin(tab, id) {
    let pinnedNow = null;
    await this._mutate(tab, 'pin', async (ctx) => {
      const item = await reqToPromise(ctx.itemsStore.get(id));
      if (!item) {
        ctx.skipOp = true;
        return;
      }
      item.pinned = !item.pinned;
      pinnedNow = item.pinned;
      ctx.itemsStore.put(item);
      ctx.detail = snippet(item.text);
    });
    return pinnedNow;
  },

  async clear(tab) {
    return this._mutate(tab, 'clear', async (ctx) => {
      const all = await reqToPromise(ctx.itemsStore.getAll());
      let removed = 0;
      for (const it of all) {
        if (!it.pinned) {
          ctx.itemsStore.delete(it.id);
          removed += 1;
        }
      }
      if (removed === 0) {
        ctx.skipOp = true;
        return 0;
      }
      ctx.detail = `清空 ${removed} 条（固定项保留）`;
      return removed;
    });
  },

  async dedupe(tab) {
    return this._mutate(tab, 'dedupe', async (ctx) => {
      const all = await reqToPromise(ctx.itemsStore.getAll());
      all.sort((a, b) => b.seq - a.seq);
      const seen = new Set();
      let removed = 0;
      for (const it of all) {
        if (seen.has(it.text)) {
          ctx.itemsStore.delete(it.id);
          removed += 1;
        } else {
          seen.add(it.text);
        }
      }
      if (removed === 0) {
        ctx.skipOp = true;
        return 0;
      }
      ctx.detail = `去除 ${removed} 条重复`;
      return removed;
    });
  },
};

function snippet(text) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > 40 ? oneLine.slice(0, 40) + '…' : oneLine;
}
