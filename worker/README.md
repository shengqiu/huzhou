# 湖州环评公示监测 · Cloudflare Worker **免费计划版**

不用付费，全部跑在 Workers Free 上。核心难点是：**免费计划每次调用只有 10ms CPU**
（HTTP 请求和 Cron Trigger 都一样），而这个采集任务一次跑完要几百毫秒 CPU。
本版本通过「**拆分到极小的单元任务 + 高频 cron 逐个消化**」绕开了这个限制。

```
每分钟 cron 触发一次（占账号 5 个 cron 名额中的 1 个）
    │
    ├─ 本轮还没扫过？→ 把 16 个栏目写成 16 个 list 任务入队
    │
    └─ 出队 1 个任务执行（CPU < 5ms）
         ├─ list 任务：抓 1 个栏目，把没见过的公告写成 detail 任务入队
         └─ detail 任务：抓 1 条公告详情，解析项目表格，写进当月 KV 分片
    │
    └─ 队列空 → 直接返回，什么都不做

浏览器访问 GET /  →  Worker 返回静态 HTML 外壳（0 CPU）
                     ↓ 浏览器自己拉 /api/items
                     ↓ 前端渲染出看板
```

---

## 一、这个版本做了哪些取舍

| 常规做法 | 免费版做法 | 原因 |
|---|---|---|
| 一次 cron 抓完所有栏目 | 每分钟 cron 只处理 1 个任务 | 单次 CPU 必须 < 10ms |
| 数据存成一个大 JSON | 按月份分片存 `m:2026-09` | 避免每次 parse/stringify 300KB |
| 服务端渲染 HTML 看板 | Worker 只吐静态外壳，浏览器渲染 | 渲染同样吃 CPU |
| 并存list.{role}一次 XMLHTTP对比去重 | 先按月份查已入库再决定是否解析 | 减少无效 fetch |

实测数据（同一份解析逻辑）：

| 动作 | CPU 耗时 |
|---|---|
| 纯详情页解析（`parseProjects`） | **0.1 ~ 0.23 ms** |
| 详情任务整体（含 fetch + KV 读写） | 约 2 ~ 4 ms |
| 单个栏目列表任务 | 约 1 ~ 3 ms |

每个任务离 10ms 都还有安全余量。

---

## 二、部署步骤

### 1. 装依赖并登录

```bash
cd /workspace/worker
npm install
npx wrangler login
```

### 2. 创建 KV 命名空间

**不用手动建**——`wrangler.toml` 里的 `[[kv_namespaces]]` 故意只写了 `binding` 没写 `id`，
部署时 wrangler 会自己创建（官方叫 automatic provisioning）。这样账号资源 ID 就不会进仓库。

想固定用某个已存在的 namespace 也可以，补上 id 即可：

```toml
[[kv_namespaces]]
binding = "EPI_KV"
id = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
```

### 3. 运行期变量放到 dashboard（不要写进仓库）

去 **Workers & Pages → huzhou → Settings → Variables and Secrets** 添加：

| 名称 | 类型 | 值 |
|---|---|---|
| `ADMIN_TOKEN` | **Secret（加密）** | 一串随机字符串，例如 `e9af75ca5bc64361ee495d9e2ad65e31` |
| `STEP_SIZE` | 明文 | `1`（免费计划别调大） |
| `LIST_LIMIT` | 明文 | `12` |

`wrangler.toml` 里已经设了 `keep_vars = true`，否则**下一次 CI 部署会把 dashboard 上配的 var 全清掉**
（wrangler 默认行为是部署前删除所有已存在的 var）。Secret 不受影响，部署永远不会删 Secret。

代码里都有兜底：`STEP_SIZE` 缺省 1、`LIST_LIMIT` 缺省 12、`ADMIN_TOKEN` 为空时管理接口自动关闭。

### 4.（强烈建议）先灌历史数据

不然第一次要慢慢跑好几个小时才能看到东西。

```bash
cd /workspace
python3 monitor.py            # 本地采集，产出 data/items.json
python3 tools/export_kv.py    # 按月份分片打包成 kv-bulk.json
cd worker
npx wrangler kv bulk put ../kv-bulk.json --binding=EPI_KV
```

灌完之后 Worker 的 `idx.meta.lastScan` 已经标记为当天扫过，
下一次 cron 只会从队列为空直接返回，直到明天再扫一轮 —— 那时只会发现几条新公告。

### 5. 部署

```bash
npx wrangler deploy
```

### 6. 手动触发一次看看

```bash
DOMAIN=huzhou-epi-monitor.<你的子域>.workers.dev

# 立即扫一轮并处理 2 个任务
curl -X POST -H "X-Admin-Token: 你的token" "https://$DOMAIN/api/start?n=2"

# 看进度
curl "https://$DOMAIN/api/status"

# 想快点消化完，手动多踢几脚
for i in $(seq 1 30); do
  curl -s -X POST -H "X-Admin-Token: 你的token" "https://$DOMAIN/api/step?n=1" > /dev/null
done
```

然后浏览器打开 `https://$DOMAIN/`。

---

## 三、KV 数据字典

| Key | 类型 | 说明 |
|---|---|---|
| `m:2026-09` | JSON array | 该月的公告（含项目明细、原文链接、附件下载链接）。按月分片，单次读写都是小对象 |
| `idx` | JSON object | `months` 月份清单 + `meta` 运行状态（`lastScan` / `lastTaskAt` / `runs` / `lastError`） |
| `pending` | JSON array | 任务队列，元素形如 `{t:'list', col}` 或 `{t:'detail', e:{...}}` |

**写入次数估算**：一条公告 ≈ 2 次写入（`pending` + 当月分片），偶尔多 1 次 `idx`。
首日全量导入约 500 次写入，之后每天十几二十次 —— KV 免费额度是**每天 1000 次写入**，够用。

---

## 四、配额核算（免费计划 vs 本任务）

| 项目 | 免费额度 | 本任务消耗 |
|---|---|---|
| 请求数 | 100,000 / 天 | cron 每分钟 1 次 = 1440/天 ✓ |
| CPU | 10 ms / 次 | 实测 2~5 ms ✓ |
| KV 读取 | 100,000 / 天 | 约 5,000/天 ✓ |
| KV 写入 | 1,000 / 天 | 日常约 20/天，首日导入约 500 ✓ |
| KV 存储 | 1 GB | 约 180 KB ✓ |
| Cron Trigger | 账号级 5 个 | 用 1 个 ✓ |

唯一需要留意的是**首次全量导入当天**会吃掉一半写入额度，别在同一天反复重灌。

---

## 五、端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 看板页面（静态外壳 + 前端渲染：搜索 / 按单位筛选 / 按类型筛选 / 只看本轮新增 / 按月切换 / 原文链接 / 附件下载） |
| GET | `/api/items` | JSON 数据，`?months=2026-09,2026-08` 指定月份，不传则取最近 3 个月 |
| GET | `/api/status` | 队列长度、各月条数、运行状态 |
| POST | `/api/start` | 强制扫一轮栏目并处理 `?n=` 个任务，需 `X-Admin-Token` |
| POST | `/api/step` | 处理 `?n=` 个任务，需 `X-Admin-Token`。手动加速用 |

---

## 六、关于附件下载（很重要）

每条公告里挂的**环境影响报告书/报告表全本、公众参与说明**才是真正有价值的东西，
看板上每个项目最后一列就是「下载」按钮，直连官网，无需鉴权。

但它们的体量必须提前知道，实测：

```
81 个附件（分布在 59 条公告里）     合计 ~1 GB
    最大单个   137.5 MB   湖州芯屏半导体 Micro-LED 芯片项目.zip
    典型体积    20~40 MB   环境影响报告表.zip / .rar
    最小        349 KB     环境影响登记表.pdf
```

**结论：绝对不要让 Worker 去下载这些文件。**

| 限制 | 数值 | 后果 |
|---|---|---|
| Workers 内存 | 128 MB | 137 MB 的单个文件直接撑爆 |
| KV 单值上限 | 25 MB | 多数报告书存不进去 |
| KV 命名空间总量 | 1 GB | 所有附件加起来正好塞满，没有余地 |

云端存附件得用 **R2**（免费 10 GB），但那又是另一个话题了。

分工建议保持现状：**Worker 负责元数据和下载链接，本地脚本负责把文件真正抓下来**。

```bash
python3 tools/download.py --dry-run            # 先看清楚有哪些、合计多大
python3 tools/download.py --keyword 化工        # 按项目名/单位/文件名过滤
python3 tools/download.py --max-size 50        # 跳过超过 50MB 的大块头
python3 tools/download.py --since 2026-09-01   # 只要某天之后的
```

文件按 `files/<日期>_<单位>/<项目名>/<文件名>` 归档，附 `manifest.csv` 清单，
支持断点续传、重复运行自动跳过。细节见主 [README](../README.md)。

---

## 七、排错

| 现象 | 原因 & 处理 |
|---|---|
| `Worker exceeded CPU time limit`（Error 1102） | 单次塞了太多任务。把 `STEP_SIZE` 保持 `1`，`/api/step?n=` 也别超过 2 |
| `/api/status` 里 `pendingTasks` 一直是 0 但没数据 | 先 `POST /api/start` 触发一轮扫描 |
| 队列消化很慢 | 每分钟 1 条是设计如此（受限于 10ms CPU）。想快手动循环 `/api/step`，或直接本地灌 `kv-bulk.json` |
| 列表一直抓到 0 条 | 官网改版导致 `tplSetId` 变了。浏览器打开栏目页，DevTools Network 搜 `jpaas-publish-server`，把新参数填回 `src/index.js` 顶部的 `LIST_API` |
| 看板空白/一直加载中 | 打开浏览器控制台看 `/api/items` 是否报错；多半是 `idx.months` 为空（还没灌数据） |
| KV 写入超限 `429` | 当天导入次数太多，等北京时间 0 点重置（UTC 16:00）再试 |

---

## 八、什么时候该考虑升级到 Paid（$5/月）

如果下面任何一条戳中你：

- 希望**每天固定时间点**（比如早上 8:30）一次性抓完，而不是靠每分钟爬
- 想同时监控更多城市 / 更多栏目，任务量上去了
- 想做服务端渲染、邮件推送、Webhook 通知

那就把 `wrangler.toml` 里的 cron 换成 `30 0 * * 1-5`、`STEP_SIZE` 调到 `25`，
再加一段 `[limits] cpu_ms = 30000` 即可，代码逻辑基本不用动。
