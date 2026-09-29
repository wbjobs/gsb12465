// 核心状态层：
// - 所有写操作先经 Web Locks 串行化，再写入 IndexedDB（同一事务内记录操作日志），
//   最后通过 BroadcastChannel 通知其它标签页“重新读库”。
// - 广播消息只是“触发器”，不携带业务状态；接收方总是从 IndexedDB 全量重读，
//   因此消息乱序 / 重复 / 丢失都不会造成数据不一致。
// - 离线期间的操作直接落库，恢复在线后一次 sync 即完成合并，无需额外冲突处理。

import { openDB, runTx, reqp, getAllItems, getAllOps } from './db.js';
import {
  MAX_ITEMS, MAX_OPS, hashText, normalizeText,
  idsToTrim, idsToDedup, uuid, preview,
} from './utils.js';

const LOCK_NAME = 'shared-clipboard-queue-mutation';
const CHANNEL_NAME = 'shared-clipboard-queue-sync';

export class QueueStore {
  constructor({ tabId, tabName, onChange, onPresence, onToast }) {
    this.tabId = tabId;
    this.tabName = tabName;
    this.onChange = onChange;     // ({ items, ops }) => void
    this.onPresence = onPresence; // (tabs: Map) => void
    this.onToast = onToast ?? (() => {});
    this.items = [];
    this.ops = [];
    this.peers = new Map();       // tabId -> { tabName, lastSeen }
    this._refreshScheduled = false;
  }

  async init() {
    this.db = await openDB();
    this.channel = 'BroadcastChannel' in window
      ? new BroadcastChannel(CHANNEL_NAME)
      : null;
    if (this.channel) {
      this.channel.onmessage = (e) => this._onMessage(e.data);
    }
    // 页面重新可见 / 获得焦点时全量重读，覆盖离线与后台期间的变更
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.refresh();
    });
    window.addEventListener('focus', () => this.refresh());
    window.addEventListener('beforeunload', () => {
      this._post({ kind: 'bye', tabId: this.tabId });
    });
    this._post({ kind: 'hello', tabId: this.tabId, tabName: this.tabName });
    this._presenceTimer = setInterval(() => this._heartbeat(), 3000);
    await this.refresh();
  }

  // ---------- 广播与在线状态 ----------

  _post(msg) {
    try { this.channel?.postMessage(msg); } catch (_) { /* 忽略 */ }
  }

  _onMessage(msg) {
    if (!msg || msg.tabId === this.tabId) return;
    if (msg.kind === 'sync') {
      this._scheduleRefresh();
    } else if (msg.kind === 'hello') {
      this.peers.set(msg.tabId, { tabName: msg.tabName, lastSeen: Date.now() });
      // 回应自己的存在，让新标签页立刻看到我们
      this._post({ kind: 'presence', tabId: this.tabId, tabName: this.tabName });
      this.onPresence?.(this.peers);
    } else if (msg.kind === 'presence') {
      this.peers.set(msg.tabId, { tabName: msg.tabName, lastSeen: Date.now() });
      this.onPresence?.(this.peers);
    } else if (msg.kind === 'bye') {
      this.peers.delete(msg.tabId);
      this.onPresence?.(this.peers);
    }
  }

  _heartbeat() {
    this._post({ kind: 'presence', tabId: this.tabId, tabName: this.tabName });
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.peers) {
      if (now - p.lastSeen > 10000) { this.peers.delete(id); changed = true; }
    }
    if (changed) this.onPresence?.(this.peers);
  }

  _scheduleRefresh() {
    if (this._refreshScheduled) return;
    this._refreshScheduled = true;
    queueMicrotask(async () => {
      this._refreshScheduled = false;
      await this.refresh();
    });
  }

  async refresh() {
    const [items, ops] = await Promise.all([
      getAllItems(this.db),
      getAllOps(this.db),
    ]);
    this.items = items;
    this.ops = ops;
    this.onChange?.({ items, ops });
  }

  // ---------- 写操作（全部经 Web Lock 串行化） ----------

  async _mutate(work) {
    const exec = () => runTx(this.db, 'readwrite', work);
    let result;
    if (navigator.locks?.request) {
      result = await navigator.locks.request(LOCK_NAME, exec);
    } else {
      result = await exec(); // 降级：无 Web Locks 时尽力而为
    }
    this._post({ kind: 'sync', tabId: this.tabId });
    await this.refresh();
    return result;
  }

  async _logOp(ops, type, text) {
    await reqp(ops.add({
      id: uuid(),
      tabId: this.tabId,
      tabName: this.tabName,
      type,
      preview: text ? preview(text) : '',
      ts: Date.now(),
    }));
    // 操作记录截断
    const all = await reqp(ops.getAll());
    if (all.length > MAX_OPS) {
      const sorted = all.sort((a, b) => a.ts - b.ts);
      for (const old of sorted.slice(0, all.length - MAX_OPS)) {
        await reqp(ops.delete(old.id));
      }
    }
  }

  // 添加文本（复制事件 / 手动输入 / 读取剪贴板共用）
  // dedup=true 时，队列中已存在相同文本则跳过
  async add(text, { dedup = true } = {}) {
    const clean = normalizeText(text);
    if (!clean) return { added: false, reason: 'empty' };
    return this._mutate(async (items, ops) => {
      const hash = hashText(clean);
      if (dedup) {
        const dup = await reqp(items.index('hash').getAll(hash));
        if (dup.length > 0) {
          await this._logOp(ops, 'dedup-skip', clean);
          return { added: false, reason: 'duplicate' };
        }
      }
      const item = {
        id: uuid(),
        text: clean,
        hash,
        pinned: false,
        tabId: this.tabId,
        tabName: this.tabName,
        createdAt: Date.now(),
      };
      await reqp(items.add(item));
      // 队列截断：超长时删除最旧的未固定项
      const all = await reqp(items.getAll());
      for (const id of idsToTrim(all, MAX_ITEMS)) {
        await reqp(items.delete(id));
      }
      await this._logOp(ops, 'add', clean);
      return { added: true, item };
    });
  }

  // 取出：返回文本（调用方负责写入剪贴板），成功后从队列删除
  async take(id) {
    return this._mutate(async (items, ops) => {
      const item = await reqp(items.get(id));
      if (!item) return { ok: false, reason: 'gone' };
      await reqp(items.delete(id));
      await this._logOp(ops, 'take', item.text);
      return { ok: true, text: item.text };
    });
  }

  // 取出队首（最新的未固定项）
  async takeNext() {
    return this._mutate(async (items, ops) => {
      const all = await reqp(items.getAll());
      const next = all
        .filter((it) => !it.pinned)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!next) return { ok: false, reason: 'empty' };
      await reqp(items.delete(next.id));
      await this._logOp(ops, 'take', next.text);
      return { ok: true, text: next.text };
    });
  }

  async remove(id) {
    return this._mutate(async (items, ops) => {
      const item = await reqp(items.get(id));
      if (!item) return { ok: false };
      await reqp(items.delete(id));
      await this._logOp(ops, 'remove', item.text);
      return { ok: true };
    });
  }

  async togglePin(id) {
    return this._mutate(async (items, ops) => {
      const item = await reqp(items.get(id));
      if (!item) return { ok: false };
      item.pinned = !item.pinned;
      await reqp(items.put(item));
      await this._logOp(ops, item.pinned ? 'pin' : 'unpin', item.text);
      return { ok: true, pinned: item.pinned };
    });
  }

  // 清空：保留固定项
  async clear() {
    return this._mutate(async (items, ops) => {
      const all = await reqp(items.getAll());
      let removed = 0;
      for (const item of all) {
        if (!item.pinned) {
          await reqp(items.delete(item.id));
          removed++;
        }
      }
      await this._logOp(ops, 'clear', `删除 ${removed} 条（固定项保留）`);
      return { removed };
    });
  }

  // 对现有队列去重
  async dedupAll() {
    return this._mutate(async (items, ops) => {
      const all = await reqp(items.getAll());
      const drop = idsToDedup(all);
      for (const id of drop) await reqp(items.delete(id));
      await this._logOp(ops, 'dedup', `去除 ${drop.length} 条重复`);
      return { removed: drop.length };
    });
  }

  destroy() {
    clearInterval(this._presenceTimer);
    this._post({ kind: 'bye', tabId: this.tabId });
    this.channel?.close();
  }
}
