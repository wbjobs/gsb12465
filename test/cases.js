'use strict';

async function main() {
  const db = new FakeDB();
  SharedQueue.init(db, () => {});
  const tabs = [1, 2, 3, 4].map((i) => ({ id: 'tab' + i, name: 'T' + i }));

  // 1. 基本入队与顺序
  await SharedQueue.enqueue(tabs[0], 'hello', 'manual');
  await SharedQueue.enqueue(tabs[1], 'world', 'copy');
  let s = await readState(db);
  assert.equal(s.items.length, 2, '入队数量');
  assert.equal(s.items[0].text, 'hello', 'FIFO 顺序');
  assert.equal(s.revision, 2, '版本号递增');

  // 2. 入队去重：相同文本移到最新，不重复
  await SharedQueue.enqueue(tabs[2], 'hello', 'copy');
  s = await readState(db);
  assert.equal(s.items.length, 2, '重复文本不产生新条目');
  assert.equal(s.items[1].text, 'hello', '重复文本移到队尾（最新）');

  // 3. 固定后 take 跳过固定项
  const world = s.items.find((it) => it.text === 'world');
  await SharedQueue.togglePin(tabs[0], world.id);
  const taken = await SharedQueue.takeNext(tabs[1]);
  assert.equal(taken.text, 'hello', 'take 跳过固定项取最旧未固定');
  s = await readState(db);
  assert.equal(s.items.length, 1, 'take 后移除');
  assert.ok(s.items[0].pinned, '固定项保留');

  // 4. 空队列 take 返回 null
  await SharedQueue.clear(tabs[0]);
  await SharedQueue.remove(tabs[0], s.items[0].id);
  const none = await SharedQueue.takeNext(tabs[0]);
  assert.equal(none, null, '空队列 take 返回 null');

  // 5. clear 保留固定项
  await SharedQueue.enqueue(tabs[0], 'keep', 'manual');
  s = await readState(db);
  await SharedQueue.togglePin(tabs[0], s.items[0].id);
  await SharedQueue.enqueue(tabs[0], 'tmp1', 'manual');
  await SharedQueue.enqueue(tabs[0], 'tmp2', 'manual');
  const cleared = await SharedQueue.clear(tabs[1]);
  assert.equal(cleared, 2, 'clear 只清未固定');
  s = await readState(db);
  assert.equal(s.items.length, 1, '固定项在 clear 后保留');
  assert.equal(s.items[0].text, 'keep');
  await SharedQueue.clear(tabs[0]);
  await SharedQueue.remove(tabs[0], s.items[0].id);

  // 6. 并发：4 个标签页同时各入队 25 条，共 100 条不丢不重
  await Promise.all(
    tabs.flatMap((t) =>
      Array.from({ length: 25 }, (_, i) =>
        SharedQueue.enqueue(t, `${t.id}-msg-${i}`, 'copy')
      )
    )
  );
  s = await readState(db);
  assert.equal(s.items.length, 100, '并发入队 100 条不丢');
  const seqs = new Set(s.items.map((it) => it.seq));
  assert.equal(seqs.size, 100, 'seq 全局唯一（锁内分配）');

  // 7. 并发 take：100 次并发取出，结果互不重复且总数一致
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, i) => SharedQueue.takeNext(tabs[i % 4]))
  );
  const takenTexts = results.filter(Boolean).map((r) => r.text);
  assert.equal(takenTexts.length, 100, '并发 take 全部命中');
  assert.equal(new Set(takenTexts).size, 100, '并发 take 无重复');
  s = await readState(db);
  assert.equal(s.items.length, 0, 'take 后队列清空');

  // 8. 截断：超过 MAX_ITEMS 时丢弃最旧未固定项
  for (let i = 0; i < MAX_ITEMS + 10; i++) {
    await SharedQueue.enqueue(tabs[0], `bulk-${i}`, 'manual');
  }
  s = await readState(db);
  assert.equal(s.items.length, MAX_ITEMS, '队列截断到上限');
  assert.equal(s.items[0].text, 'bulk-10', '最旧的被截断');
  assert.ok(s.ops.some((op) => op.type === 'truncate'), '截断写入操作记录');
  await SharedQueue.clear(tabs[0]);

  // 9. 固定项免于截断
  await SharedQueue.enqueue(tabs[0], 'pinned-survivor', 'manual');
  s = await readState(db);
  await SharedQueue.togglePin(tabs[0], s.items[0].id);
  for (let i = 0; i < MAX_ITEMS + 5; i++) {
    await SharedQueue.enqueue(tabs[0], `flood-${i}`, 'manual');
  }
  s = await readState(db);
  assert.equal(s.items.length, MAX_ITEMS, '截断后仍在上限内');
  assert.ok(s.items.some((it) => it.text === 'pinned-survivor'), '固定项免于截断');
  await SharedQueue.clear(tabs[0]);
  const survivor = s.items.find((it) => it.text === 'pinned-survivor');
  await SharedQueue.remove(tabs[0], survivor.id);

  // 10. dedupe 操作：直接构造重复数据后去重
  const tx = db.transaction(['items'], 'readwrite');
  const store = tx.objectStore('items');
  for (let i = 0; i < 3; i++) {
    store.put({ id: 'dup-' + i, text: 'same', pinned: false, seq: 1000 + i, createdAt: Date.now(), tabId: 'x', tabName: 'X' });
  }
  store.put({ id: 'uniq-1', text: 'unique', pinned: false, seq: 2000, createdAt: Date.now(), tabId: 'x', tabName: 'X' });
  await txDone(tx);
  const deduped = await SharedQueue.dedupe(tabs[0]);
  assert.equal(deduped, 2, '去重删除 2 条');
  s = await readState(db);
  assert.equal(s.items.length, 2, '去重后数量正确');
  assert.equal(s.items.find((it) => it.text === 'same').seq, 1002, '去重保留最新一条');

  // 11. 操作记录包含来源标签页
  s = await readState(db);
  assert.ok(s.ops.length > 0, '操作有记录');
  assert.ok(s.ops.some((op) => op.type === 'dedupe' && op.tabName === 'T1'), '记录含类型与来源标签页');
  assert.ok(s.ops.every((op) => op.tabName && op.type), '每条记录都有来源与类型');
  assert.ok(s.ops.length <= MAX_OPS, '操作记录截断到上限');

  console.log('全部 11 组断言通过 ✔');
}

main().then(
  () => process.exit(0),
  (err) => { console.error('测试失败:', err); process.exit(1); }
);
