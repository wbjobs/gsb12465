// DOM 渲染层：只负责把状态画出来，事件回调由 app.js 注入。

import { preview } from './utils.js';

const OP_LABELS = {
  add: '复制入队',
  take: '取出',
  remove: '删除',
  clear: '清空',
  pin: '固定',
  unpin: '取消固定',
  dedup: '去重',
  'dedup-skip': '重复跳过',
};

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

export function renderQueue(listEl, items, { search, handlers }) {
  const kw = search.trim().toLowerCase();
  const visible = kw
    ? items.filter((it) => it.text.toLowerCase().includes(kw))
    : items;

  listEl.replaceChildren();
  if (visible.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = kw ? '没有匹配的条目' : '队列为空，复制一些文本试试';
    listEl.append(empty);
    return;
  }

  for (const item of visible) {
    const li = document.createElement('li');
    li.className = 'item' + (item.pinned ? ' pinned' : '');

    const main = document.createElement('div');
    main.className = 'item-main';

    const text = document.createElement('div');
    text.className = 'item-text';
    text.textContent = item.text;
    text.title = item.text;

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = `${item.tabName} · ${fmtTime(item.createdAt)}`;

    main.append(text, meta);

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const takeBtn = document.createElement('button');
    takeBtn.textContent = '取出';
    takeBtn.title = '复制到剪贴板并从队列移除';
    takeBtn.addEventListener('click', () => handlers.onTake(item.id));

    const pinBtn = document.createElement('button');
    pinBtn.textContent = item.pinned ? '取消固定' : '固定';
    pinBtn.addEventListener('click', () => handlers.onTogglePin(item.id));

    const delBtn = document.createElement('button');
    delBtn.textContent = '删除';
    delBtn.className = 'danger';
    delBtn.addEventListener('click', () => handlers.onRemove(item.id));

    actions.append(takeBtn, pinBtn, delBtn);
    li.append(main, actions);
    listEl.append(li);
  }
}

export function renderOps(listEl, ops, { tabFilter }) {
  const visible = tabFilter
    ? ops.filter((op) => op.tabName === tabFilter)
    : ops;

  listEl.replaceChildren();
  if (visible.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = '暂无操作记录';
    listEl.append(empty);
    return;
  }

  for (const op of visible.slice(0, 100)) {
    const li = document.createElement('li');
    li.className = 'op';
    const label = OP_LABELS[op.type] ?? op.type;
    li.textContent = `[${fmtTime(op.ts)}] ${op.tabName} ${label}`
      + (op.preview ? `：${preview(op.preview, 40)}` : '');
    listEl.append(li);
  }
}

export function renderPeers(listEl, selfName, peers) {
  listEl.replaceChildren();
  const self = document.createElement('li');
  self.textContent = `${selfName}（当前）`;
  listEl.append(self);
  for (const [, p] of peers) {
    const li = document.createElement('li');
    li.textContent = p.tabName;
    listEl.append(li);
  }
}

export function renderStats(el, items) {
  const pinned = items.filter((it) => it.pinned).length;
  el.textContent = `共 ${items.length} 条 · 固定 ${pinned} 条`;
}

export function updateTabFilter(selectEl, ops, current) {
  const names = [...new Set(ops.map((op) => op.tabName))];
  selectEl.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = '全部标签页';
  selectEl.append(all);
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    selectEl.append(opt);
  }
  selectEl.value = names.includes(current) ? current : '';
  return selectEl.value;
}
