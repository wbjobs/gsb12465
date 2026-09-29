// 纯工具函数，不依赖浏览器 API，可在 Node 中直接测试。

export const MAX_ITEMS = 100; // 队列上限，超出后截断最旧的未固定项
export const MAX_OPS = 300; // 操作记录上限

// FNV-1a 32bit，用于文本去重
export function hashText(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

// 截断：保留固定项 + 最新的未固定项，返回需要删除的 id 列表
export function idsToTrim(items, max = MAX_ITEMS) {
  if (items.length <= max) return [];
  const pinned = items.filter((it) => it.pinned);
  const unpinned = items
    .filter((it) => !it.pinned)
    .sort((a, b) => b.createdAt - a.createdAt);
  const keepUnpinned = unpinned.slice(0, Math.max(0, max - pinned.length));
  const keep = new Set([...pinned, ...keepUnpinned].map((it) => it.id));
  return items.filter((it) => !keep.has(it.id)).map((it) => it.id);
}

// 队列去重：相同 hash 只保留一条（优先保留固定项，其次保留最新的）
export function idsToDedup(items) {
  const byHash = new Map();
  const sorted = [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
  const drop = [];
  for (const item of sorted) {
    if (byHash.has(item.hash)) {
      drop.push(item.id);
    } else {
      byHash.set(item.hash, item.id);
    }
  }
  return drop;
}

export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function preview(text, len = 60) {
  const t = normalizeText(text);
  return t.length > len ? t.slice(0, len) + '…' : t;
}
