# WorkBuddy Project · 湖州环保环评公示监测

> 给未来的会话看：先读这个文件，再决定动哪里的代码。

## 这个项目在干什么

自动盯 **湖州市生态环境局**（`hbj.huzhou.gov.cn`）的环评公示栏目，把 **16 个栏目**（市局 + 吴兴/南太湖新区/南浔/德清/长兴/安吉/长合分局 × 非辐环评审批、辐射项目审批，外加全市建设项目环评信息公示）的新公告抓下来，提取出**项目表格**（项目名称、建设地点、建设单位、环评机构、受理日期）+ **附件链接**（环评报告书 / 报告表 / 公参说明），存起来并出成一个可搜索的 HTML 看板，同时支持把附件本体下载到本地。

用户原始需求：**工作日每天早上**看一次 **湖州全市、全类型**的环评公示，产出 **HTML 看板**；下载页面里的附件是「非常重要」的一环。

## 当前状态（2026-09-29）

| 项 | 值 |
|---|---|
| 本地路径 | `/workspace/huzhou-epi-monitor` |
| GitHub | https://github.com/shengqiu/huzhou （private，提交 `ee29620`） |
| 采集结果 | 229 条公告，其中 59 条带附件，共 81 个附件 ≈ 1 GB |
| Cloudflare Worker | 代码就绪，**尚未部署**（需用户本地 `wrangler login` + 建 KV namespace） |
| WorkBuddy 定时任务 | 未创建（被 Worker 的原生 cron 取代） |

## 两条运行路线

**本地一次性采集**（主力，跑完整历史）
```bash
python3 monitor.py                 # ~30 秒，写 data/items.json + data/state.json + reports/index.html
python3 tools/download.py --dry-run          # 看看有哪些附件、多大
python3 tools/download.py --unit 南浔分局     # 按单位下载
python3 tools/download.py --resolve          # 解析全部附件的 OSS 直链 → files/direct_links.csv
```

**Cloudflare Workers**（免费计划，自动增量）
```bash
cd worker && npm i
npx wrangler login
npx wrangler kv namespace create EPI_KV      # 把返回的 id 填进 wrangler.toml
npx wrangler kv bulk put ../kv-bulk.json --binding EPI_KV   # 灌种子数据（可选但推荐）
npx wrangler deploy
```
详细部署说明见 [`worker/README.md`](worker/README.md)。

## 目录

```
monitor.py           采集器，纯 HTTP（不用浏览器）
tools/export_kv.py   本地数据 → KV bulk 格式（按月分片）
tools/download.py    附件下载 + OSS 直链解析
worker/              Cloudflare Workers（src/index.js + wrangler.toml + README）
worker/README.md     部署手册 / KV 字典 / 配额计算
docs/                本项目的完整技术文档（见下）
data/  reports/  files/  kv-bulk.json   ← 都是生成物，已 gitignore
```

## 读过再动手：三个不能破的约束

1. **Workers Free 每次调用只有 10ms CPU**（HTTP 请求和 Cron Trigger 都一样）。所以 `worker/src/index.js` 才被拆成「每次 cron 只消费 1 个单元任务」的架构。别把它改回「一次请求跑完整个流程」，别调大 `STEP_SIZE`。
2. **`fileUrl` 是服务端加密的**。下载链接长这样 `download?fileUrl=<密文>&fileName=<文件名>.zip`，base64 解开是 128 字节密文，**算不出真实路径**，只能跟随 302 → 301 重定向到 OSS 直链。
3. **附件总规模约 1 GB**，单个最大 137.5 MB。Worker 绝对不能下载附件本体（128 MB 内存上限 / KV 单值 25 MB / 命名空间 1 GB）。分工是：Worker 只存元数据和链接，本体下载交给本地 `tools/download.py`。

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/01-会话全记录.md`](docs/01-会话全记录.md) | 整个对话的演进过程：需求、反复、踩坑、结论 |
| [`docs/02-技术决策.md`](docs/02-技术决策.md) | 为什么不用浏览器、为什么拆单元任务、KV 为什么按月分片 |
| [`docs/03-数据源清单.md`](docs/03-数据源清单.md) | 16 个栏目的 colId、隐藏 JSON 接口、TagId 坑 |
| [`docs/04-附件下载.md`](docs/04-附件下载.md) | 81 个附件的统计、OSS 直链机制、命令行用法 |

## 待办 / 下一步

- [ ] Worker 实际部署（需用户在本地执行 wrangler 命令）
- [ ] 加 GitHub Actions：工作日早上定时采集 + 自动 `wrangler deploy`（需 Cloudflare API Token）
- [ ] `files/direct_links.csv` 是否纳入仓库（81 条 OSS 直链，配合 `aria2 -i` 可整包拉 1 GB）
- [ ] 给 WorkBuddy 提 bug：GitHub 连接器令牌只有 contents 只读权限，导致无法推送到用户自己的仓库
