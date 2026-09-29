'use strict';

class FakeRequest {
  constructor(tx) {
    this._tx = tx;
    this.result = undefined;
    this.error = null;
    this._onsuccess = null;
  }
  set onsuccess(fn) { this._onsuccess = fn; }
  get onsuccess() { return this._onsuccess; }
  set onerror(fn) { this._onerror = fn; }
  get onerror() { return this._onerror; }
  _fire() {
    this._tx._pending += 1;
    queueMicrotask(() => {
      try {
        if (this._onsuccess) this._onsuccess();
      } finally {
        this._tx._settle();
      }
    });
  }
}

class FakeCursor {
  constructor(entries, store, req) {
    this._entries = entries;
    this._idx = 0;
    this._store = store;
    this._req = req;
  }
  get value() { return this._entries[this._idx] ? this._entries[this._idx].value : undefined; }
  get key() { return this._entries[this._idx] ? this._entries[this._idx].key : undefined; }
  delete() {
    this._store._map.delete(this._entries[this._idx].value.id);
    return this._store._request(undefined);
  }
  continue() {
    this._idx += 1;
    this._req.result = this._entries[this._idx] ? this : null;
    this._req._fire();
  }
}

class FakeIndex {
  constructor(store, keyPath) {
    this._store = store;
    this._keyPath = keyPath;
  }
  openCursor() {
    const req = new FakeRequest(this._store._tx);
    const entries = [...this._store._map.values()]
      .map((v) => ({ key: v[this._keyPath], value: v }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const cursor = new FakeCursor(entries, this._store, req);
    req.result = entries.length ? cursor : null;
    req._fire();
    return req;
  }
}

class FakeStore {
  constructor(name, tx) {
    this._name = name;
    this._tx = tx;
    this._map = tx.db._data[name];
  }
  _request(value) {
    const req = new FakeRequest(this._tx);
    req.result = value;
    req._fire();
    return req;
  }
  get(key) { return this._request(this._map.get(key)); }
  getAll() { return this._request([...this._map.values()]); }
  put(value) { this._map.set(value[this._tx.db._keyPaths[this._name]], value); return this._request(undefined); }
  delete(key) { this._map.delete(key); return this._request(undefined); }
  count() { return this._request(this._map.size); }
  index(name) { return new FakeIndex(this, this._tx.db._indexes[this._name][name]); }
}

class FakeTransaction {
  constructor(db, storeNames) {
    this.db = db;
    this._stores = {};
    for (const n of storeNames) this._stores[n] = new FakeStore(n, this);
    this._pending = 0;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
  }
  objectStore(name) { return this._stores[name]; }
  _settle() {
    this._pending -= 1;
    if (this._pending > 0) return;
    setTimeout(() => {
      if (this._pending === 0 && this.oncomplete) this.oncomplete();
    }, 0);
  }
}

class FakeDB {
  constructor() {
    this._data = { items: new Map(), ops: new Map(), meta: new Map() };
    this._keyPaths = { items: 'id', ops: 'id', meta: 'key' };
    this._indexes = { items: { seq: 'seq' }, ops: { ts: 'ts' }, meta: {} };
  }
  transaction(storeNames) { return new FakeTransaction(this, storeNames); }
}

function makeNavigatorLocks() {
  let tail = Promise.resolve();
  return {
    request(name, opts, fn) {
      if (typeof opts === 'function') { fn = opts; }
      const run = tail.then(() => fn());
      tail = run.catch(() => {});
      return run;
    },
  };
}

module.exports = { FakeDB, makeNavigatorLocks };
