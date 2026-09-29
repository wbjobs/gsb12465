// 入口：标签页身份、剪贴板交互、事件绑定。

import { QueueStore } from './store.js';
import {
  renderQueue, renderOps, renderPeers, renderStats, updateTabFilter,
} from './ui.js';

// 标签页身份：sessionStorage 保证每个标签页唯一、刷新后保持不变
function getTabIdentity() {
  let id = sessionStorage.getItem('scq-tab-id');
  let name = sessionStorage.getItem('scq-tab-name');
  if (!id) {
    id = crypto.randomUUID();
    const seq = Math.floor(Math.random() * 9000) + 1000;
    name = `标签页-${seq}`;
    sessionStorage.setItem('scq-tab-id', id);
    sessionStorage.setItem('scq-tab-name', name);
  }
  return { id, name };
}

const els = {
  tabName: document.getElementById('tab-name'),
  stats: document.getElementById('stats'),
  queueList: document.getElementById('queue-list'),
  opsList: document.getElementById('ops-list'),
  peersList: document.getElementById('peers-list'),
  input: document.getElementById('add-input'),
  addBtn: document.getElementById('add-btn'),
  readClipBtn: document.getElementById('read-clip-btn'),
  takeNextBtn: document.getElementById('take-next-btn'),
  clearBtn: document.getElementById('clear-btn'),
  dedupBtn: document.getElementById('dedup-btn'),
  dedupToggle: document.getElementById('dedup-toggle'),
  search: document.getElementById('search-input'),
  tabFilter: document.getElementById('tab-filter'),
  toast: document.getElementById('toast'),
};

let toastTimer;
function toast(msg, isError = false) {
  els.toast.textContent = msg;
  els.toast.classList.toggle('error', isError);
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2500);
}

const { id: tabId, name: tabName } = getTabIdentity();
els.tabName.textContent = tabName;

let currentOps = [];
let tabFilter = '';

const store = new QueueStore({
  tabId,
  tabName,
  onToast: toast,
  onChange: ({ items, ops }) => {
    currentOps = ops;
    renderQueue(els.queueList, items, {
      search: els.search.value,
      handlers: {
        onTake: (itemId) => takeItem(itemId),
        onTogglePin: (itemId) => store.togglePin(itemId),
        onRemove: (itemId) => store.remove(itemId),
      },
    });
    renderStats(els.stats, items);
    tabFilter = updateTabFilter(els.tabFilter, ops, tabFilter);
    renderOps(els.opsList, ops, { tabFilter });
  },
  onPresence: (peers) => renderPeers(els.peersList, tabName, peers),
});

// 复制到系统剪贴板，带降级方案
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // 降级：隐藏 textarea + execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
    return ok;
  }
}

async function takeItem(itemId) {
  const res = await store.take(itemId);
  if (!res.ok) {
    toast(res.reason === 'gone' ? '该条目已被其它标签页取走' : '取出失败', true);
    return;
  }
  const copied = await copyToClipboard(res.text);
  toast(copied ? '已取出并复制到剪贴板' : '已取出，但剪贴板写入被拒绝', !copied);
}

// 监听本页复制事件：任何复制动作都入队
document.addEventListener('copy', () => {
  const text = window.getSelection()?.toString();
  if (text && text.trim()) {
    store.add(text, { dedup: els.dedupToggle.checked }).then((res) => {
      if (res.added) toast('已加入共享队列');
    });
  }
});

els.addBtn.addEventListener('click', async () => {
  const res = await store.add(els.input.value, { dedup: els.dedupToggle.checked });
  if (res.added) {
    els.input.value = '';
    toast('已加入队列');
  } else if (res.reason === 'duplicate') {
    toast('队列中已存在相同文本，已跳过');
  }
});

els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.addBtn.click();
});

els.readClipBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      toast('剪贴板为空');
      return;
    }
    const res = await store.add(text, { dedup: els.dedupToggle.checked });
    toast(res.added ? '已从剪贴板加入' : '队列中已存在相同文本，已跳过');
  } catch (_) {
    toast('剪贴板读取权限被拒绝', true);
  }
});

els.takeNextBtn.addEventListener('click', async () => {
  const res = await store.takeNext();
  if (!res.ok) {
    toast('队列中没有可取出的条目', true);
    return;
  }
  const copied = await copyToClipboard(res.text);
  toast(copied ? '已取出队首并复制' : '已取出，但剪贴板写入被拒绝', !copied);
});

els.clearBtn.addEventListener('click', async () => {
  if (!confirm('确定清空队列？固定的条目会保留。')) return;
  const { removed } = await store.clear();
  toast(`已清空 ${removed} 条`);
});

els.dedupBtn.addEventListener('click', async () => {
  const { removed } = await store.dedupAll();
  toast(removed ? `已去除 ${removed} 条重复` : '没有重复条目');
});

els.search.addEventListener('input', () => {
  renderQueue(els.queueList, store.items, {
    search: els.search.value,
    handlers: {
      onTake: (itemId) => takeItem(itemId),
      onTogglePin: (itemId) => store.togglePin(itemId),
      onRemove: (itemId) => store.remove(itemId),
    },
  });
});

els.tabFilter.addEventListener('change', () => {
  tabFilter = els.tabFilter.value;
  renderOps(els.opsList, currentOps, { tabFilter });
});

store.init().catch((err) => {
  console.error(err);
  toast('初始化失败：' + err.message, true);
});
