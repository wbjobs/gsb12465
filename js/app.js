'use strict';

const CHANNEL_NAME = 'scq-sync-v1';

const tab = (() => {
  let id = sessionStorage.getItem('scq-tab-id');
  if (!id) {
    id = newId();
    sessionStorage.setItem('scq-tab-id', id);
  }
  return { id, name: '标签页-' + id.slice(0, 4).toUpperCase() };
})();

const state = {
  items: [],
  ops: [],
  revision: 0,
  search: '',
  opFilter: 'all',
};

let channel = null;
let db = null;

const $ = (sel) => document.querySelector(sel);

async function boot() {
  $('#tabName').textContent = tab.name;
  $('#tabName').dataset.tabId = tab.id.slice(0, 8);
  $('#maxItems').textContent = MAX_ITEMS;

  db = await openDB();

  if ('BroadcastChannel' in window) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (ev) => {
      const msg = ev.data || {};
      if (msg.type !== 'changed' || msg.tabId === tab.id) return;
      loadState();
    };
  } else {
    setInterval(loadState, 2000);
    $('#syncStatus').textContent = '降级轮询同步';
  }

  SharedQueue.init(db, (revision) => {
    state.revision = revision;
    if (channel) channel.postMessage({ type: 'changed', revision, tabId: tab.id });
    loadState();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadState();
  });
  window.addEventListener('focus', loadState);
  window.addEventListener('online', loadState);

  document.addEventListener('copy', () => {
    const sel = window.getSelection();
    const text = sel ? sel.toString() : '';
    if (text && text.trim()) {
      SharedQueue.enqueue(tab, text, 'copy').catch(showError);
    }
  });

  bindUI();
  await loadState();
}

async function loadState() {
  try {
    const { items, ops, revision } = await readState(db);
    state.items = items;
    state.ops = ops;
    state.revision = revision;
    render();
  } catch (err) {
    showError(err);
  }
}

function bindUI() {
  $('#addBtn').addEventListener('click', onManualAdd);
  $('#addInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onManualAdd();
  });
  $('#takeBtn').addEventListener('click', onTake);
  $('#dedupeBtn').addEventListener('click', async () => {
    try {
      const removed = await SharedQueue.dedupe(tab);
      toast(removed > 0 ? `已去重 ${removed} 条` : '没有重复项');
    } catch (err) { showError(err); }
  });
  $('#clearBtn').addEventListener('click', async () => {
    try {
      const removed = await SharedQueue.clear(tab);
      toast(removed > 0 ? `已清空 ${removed} 条（固定项保留）` : '队列已为空');
    } catch (err) { showError(err); }
  });
  $('#searchInput').addEventListener('input', (e) => {
    state.search = e.target.value.trim().toLowerCase();
    renderItems();
  });
  $('#opFilter').addEventListener('change', (e) => {
    state.opFilter = e.target.value;
    renderOps();
  });
  $('#closeManualBtn').addEventListener('click', () => {
    $('#manualCopy').hidden = true;
  });
}

async function onManualAdd() {
  const input = $('#addInput');
  const text = input.value;
  if (!text.trim()) return;
  input.value = '';
  try {
    await SharedQueue.enqueue(tab, text, 'manual');
  } catch (err) { showError(err); }
}

async function onTake() {
  try {
    const item = await SharedQueue.takeNext(tab);
    if (!item) {
      toast('队列中没有可取出的条目');
      return;
    }
    try {
      await navigator.clipboard.writeText(item.text);
      toast('已取出并写入剪贴板');
    } catch (err) {
      const box = $('#manualCopy');
      box.hidden = false;
      const area = $('#manualCopyText');
      area.value = item.text;
      area.focus();
      area.select();
      toast('剪贴板权限被拒，请手动复制', true);
    }
  } catch (err) { showError(err); }
}

function render() {
  renderItems();
  renderOps();
  const total = state.items.length;
  const pinned = state.items.filter((it) => it.pinned).length;
  $('#queueCount').textContent = `${total} / ${MAX_ITEMS}`;
  $('#pinnedCount').textContent = pinned;
  $('#revision').textContent = state.revision;
}

function renderItems() {
  const list = $('#queueList');
  list.textContent = '';
  const kw = state.search;
  const sorted = [...state.items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.seq - a.seq;
  });
  const visible = kw ? sorted.filter((it) => it.text.toLowerCase().includes(kw)) : sorted;
  $('#emptyHint').hidden = visible.length > 0;

  for (const item of visible) {
    const li = document.createElement('li');
    li.className = 'item' + (item.pinned ? ' pinned' : '');

    const pinBtn = document.createElement('button');
    pinBtn.className = 'icon-btn pin-btn';
    pinBtn.textContent = item.pinned ? '📌' : '📍';
    pinBtn.title = item.pinned ? '取消固定' : '固定';
    pinBtn.addEventListener('click', () => SharedQueue.togglePin(tab, item.id).catch(showError));

    const body = document.createElement('div');
    body.className = 'item-body';

    const textEl = document.createElement('div');
    textEl.className = 'item-text';
    textEl.textContent = item.text;

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = `${item.tabName} · ${formatTime(item.createdAt)} · #${item.seq}`;

    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn del-btn';
    delBtn.textContent = '✕';
    delBtn.title = '删除';
    delBtn.addEventListener('click', () => SharedQueue.remove(tab, item.id).catch(showError));

    body.appendChild(textEl);
    body.appendChild(meta);
    li.appendChild(pinBtn);
    li.appendChild(body);
    li.appendChild(delBtn);
    list.appendChild(li);
  }
}

const OP_LABELS = {
  copy: '复制入队', add: '手动添加', take: '取出', remove: '删除',
  pin: '固定', unpin: '取消固定', clear: '清空', dedupe: '去重', truncate: '截断',
};

function renderOps() {
  const list = $('#opList');
  list.textContent = '';
  const mine = state.opFilter === 'mine';
  const ops = mine ? state.ops.filter((op) => op.tabId === tab.id) : state.ops;
  $('#opEmpty').hidden = ops.length > 0;
  for (const op of ops.slice(0, 100)) {
    const li = document.createElement('li');
    li.className = 'op';

    const badge = document.createElement('span');
    badge.className = 'op-tab' + (op.tabId === tab.id ? ' mine' : '') + (op.tabId === 'system' ? ' system' : '');
    badge.textContent = op.tabId === tab.id ? '本页' : op.tabName;

    const type = document.createElement('span');
    type.className = 'op-type op-' + op.type;
    type.textContent = OP_LABELS[op.type] || op.type;

    const detail = document.createElement('span');
    detail.className = 'op-detail';
    detail.textContent = op.detail || '';
    detail.title = op.detail || '';

    const time = document.createElement('span');
    time.className = 'op-time';
    time.textContent = formatTime(op.ts);

    li.appendChild(badge);
    li.appendChild(type);
    li.appendChild(detail);
    li.appendChild(time);
    list.appendChild(li);
  }
}

function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

let toastTimer = null;
function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

function showError(err) {
  console.error(err);
  toast('操作失败：' + (err && err.message ? err.message : err), true);
}

boot().catch(showError);
