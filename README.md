# 共享剪贴板队列

多个标签页共享一个剪贴板队列：任意标签页复制的文本都会进入队列，其他标签页可以取出。纯原生 Web API，无任何框架与构建步骤。

## 运行

```bash
cd B
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000 ，多开几个标签页即可
```

> 需要通过 http(s) 或 localhost 访问：BroadcastChannel / IndexedDB / Web Locks 在 `file://` 下行为不一致。

## 测试

```bash
node test/run-tests.js
```

用内存版 fake IndexedDB + 串行化锁跑 11 组断言，覆盖：入队顺序、入队去重、固定跳过、空队列取出、清空保留固定项、**4 标签页并发入队 100 条不丢不重**、**100 次并发取出互不重复**、超长截断、固定项免于截断、去重保留最新、操作记录含来源标签页。

## 技术栈与架构

- **IndexedDB（唯一事实源）**：`items`（队列条目，按全局 `seq` 排序）、`ops`（操作记录）、`meta`（`seq`/`revision` 计数器）三个 store。见 `js/db.js`。
- **Web Locks API（并发控制）**：所有写操作都在 `navigator.locks.request('scq-mutation-lock')` 排他锁内、单个 `readwrite` 事务中完成"读-改-写"，`seq` 在锁内分配，保证跨标签页全局有序。见 `js/queue.js`。
- **BroadcastChannel（实时同步）**：每次变更后广播 `{revision}`；收到通知的标签页**从 IndexedDB 全量重读**状态，而不是应用消息增量。见 `js/app.js`。
- **Clipboard API + `copy` 事件**：监听 `document` 的 `copy` 事件抓取选中文本入队；"取出"用 `navigator.clipboard.writeText` 写回剪贴板。
- **DOM**：队列与操作记录均为原生 DOM 渲染。

## 关键约束如何满足

| 约束 | 机制 |
| --- | --- |
| 同时复制和取出不能冲突 | Web Locks 排他锁 + 单事务读-改-写，跨标签页串行化 |
| 标签页关闭后队列不能丢 | 状态全部持久化在 IndexedDB，内存中不存权威数据 |
| 消息乱序不能导致重复或丢失 | 消息只是"有变化"的提示，接收方从 DB 全量重读，乱序/重复消息幂等 |
| 离线操作恢复后要合并正确 | 离线期间的操作照常写入本地 IndexedDB（同一 profile 即同一 DB）；`focus`/`visibilitychange`/`online` 时重读合并 |
| 队列过长要能截断 | `MAX_ITEMS = 100`，超出时删最旧未固定项，并写入系统操作记录 |
| 刷新后队列一致 | 加载时从 IndexedDB 重建全部状态；`sessionStorage` 保持标签页身份 |

## 边界与异常

- **同时操作**：锁内事务串行执行，并发 take 不会取到同一条（测试 7 验证）。
- **标签页关闭**：数据在 IndexedDB，关闭不影响；操作记录中保留其历史。
- **消息乱序**：重读模型天然免疫；另带 `revision` 计数器便于观察。
- **离线恢复**：重新上线/聚焦时自动重读最新状态。
- **队列过长**：自动截断最旧未固定项，固定项豁免。
- **刷新恢复**：刷新后队列、固定状态、操作记录完全一致。
- **权限被拒**：`clipboard.writeText` 失败时弹出手动复制框（文本已全选），条目已正常出队不丢失。

## 验收对照

- 4 个标签页同时操作队列一致 → 锁 + 单事实源 + 全量重读（测试 6、7）
- 标签页关闭后队列不丢 → IndexedDB 持久化
- 消息乱序不重复不丢失 → 消息仅作通知，状态以 DB 为准
- 离线恢复合并正确 → 本地 DB 即合并结果，聚焦时重读
- 队列截断正确 → 测试 8、9
- 刷新后一致 → 加载即重放 DB 状态

## 文件结构

```
index.html      页面结构
styles.css      样式
js/db.js        IndexedDB 打开/读取封装
js/queue.js     队列操作（锁内事务：入队/取出/删除/清空/固定/去重/截断）
js/app.js       UI、复制监听、BroadcastChannel 同步
test/           Node 逻辑测试（fake IndexedDB + 串行锁）
```
