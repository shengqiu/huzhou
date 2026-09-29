# WorkBuddy Project · 湖州环保环评公示监测

> 给未来的会话看：先读这个文件，再决定动哪里的代码。
> 本目录（`/workspace`）已被设为 **WorkBuddy 项目工作区根目录**——新建任务时在输入框左下角「选择工作空间」选这个目录，就能接着这个项目继续。

## 这个项目在干什么

自动盯 **湖州市生态环境局**（`hbj.huzhou.gov.cn`）的环评公示栏目，把 **16 个栏目**（市局 + 吴兴/南太湖新区/南浔/德清/长兴/安吉/长合分局 × 非辐环评审批、辐射项目审批，外加全市建设项目环评信息公示）的新公告抓下来，提取出**项目表格**（项目名称、建设地点、建设单位、环评机构、受理日期）+ **附件链接**（环评报告书 / 报告表 / 公参说明），存起来并出成一个可搜索的 HTML 看板，同时支持把附件本体下载到本地。

用户原始需求：**工作日每天早上**看一次 **湖州全市、全类型**的环评公示，产出 **HTML 看板**；下载页面里的附件是「非常重要」的一环。**必须免费**。

## 当前状态（2026-09-29 晚）

| 项 | 值 |
|---|---|
| 工作空间根目录 | `/workspace`（**本目录本身就是项目根目录**，不是子目录） |
| GitHub | https://github.com/shengqiu/huzhou（**public**，Pages 要求免费计划必须公开） |
| 线上看板 | **https://shengqiu.github.io/huzhou/** ✅ 229 条 / 315 KB |
| 采集结果 | 229 条公告，其中 59 条带附件，共 81 个附件 ≈ 1 GB |
| Cloudflare Worker | 已部署但**采集功能废掉**——出口访问不了政务站（见下） |

## ⚠️ 头号约束：境外 IP 访问不了 hbj.huzhou.gov.cn

这是整个架构的决定性事实，**别再试图把采集搬到境外**：

| 环境 | 结果 |
|---|---|
| 本地 / 本沙箱（国内） | ✅ 16 栏目 30 秒跑完，229 条 |
| Cloudflare Workers 出口 | ❌ `TimeoutError` 20s（`/api/probe` 两种 tagId 全超时） |
| GitHub Actions（美国机房） | ❌ 16 栏目全部超时，**504 秒拿到 0 条**，还把线上看板刷成了空数组 |

所以现在的分工是：**采集在国内跑 → 把结果推到 GitHub → GitHub Pages 只负责发布**。
`pages.yml` 里有一道保险丝：看板数据为 0 条时**拒绝发布**，防止再次被空数据覆盖。

## 两条运行路线

**国内采集 + 发布（主力，唯一可行的自动路线）**
```bash
./tools/publish.sh               # 采集 → 生成看板 → 提交 → 推送 → Pages 自动发布
./tools/publish.sh --no-push     # 只采集不推送
./tools/publish.sh --force       # 无新增也提交
./tools/publish.sh --kv          # 顺便同步到 Cloudflare KV（需 CF_* 环境变量）
```

**单独跑采集 / 下附件**
```bash
python3 monitor.py                 # ~30 秒，写 data/items.json + data/state.json + reports/index.html
python3 tools/download.py --dry-run          # 看看有哪些附件、多大
python3 tools/download.py --unit 南浔分局     # 按单位下载
python3 tools/download.py --resolve          # 解析全部附件的 OSS 直链 → files/direct_links.csv
```

## 目录

```
monitor.py           采集器，纯 HTTP（不用浏览器）
tools/publish.sh     一键采集 + 推送（国内跑）
tools/export_kv.py   本地数据 → KV bulk 格式（按月分片）
tools/push_kv.py     kv-bulk.json → Cloudflare KV（需 CF_* 三个环境变量）
tools/download.py    附件下载 + OSS 直链解析
.github/workflows/pages.yml   只发布 reports/ 到 Pages（不采集）
worker/              Cloudflare Workers（已部署，但只能当只读壳子）
data/  reports/      ← 已入库：Pages 的发布源就是仓库里的看板
files/  kv-bulk.json ← gitignore
```

## 读过再动手：三个不能破的约束

1. **采集只能在境内跑**。别把 `monitor.py` 塞回 GitHub Actions 或 Worker 的 cron。要全自动就靠 **WorkBuddy 定时任务**在本沙箱触发 `tools/publish.sh`；或者在用户机器上装 self-hosted runner。
2. **`fileUrl` 是服务端加密的**。下载链接长这样 `download?fileUrl=<密文>&fileName=<文件名>.zip`，base64 解开是 128 字节密文，**算不出真实路径**，只能跟随 302 → 301 重定向到 OSS 直链。
3. **附件总规模约 1 GB**，单个最大 137.5 MB。Worker 绝对不能下载附件本体（128 MB 内存上限 / KV 单值 25 MB / 命名空间 1 GB）。本体下载永远交给本地 `tools/download.py`。

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/01-会话全记录.md`](docs/01-会话全记录.md) | 整个对话的演进过程：需求、反复、踩坑、结论 |
| [`docs/02-技术决策.md`](docs/02-技术决策.md) | 为什么不用浏览器、为什么拆单元任务、KV 为什么按月分片 |
| [`docs/03-数据源清单.md`](docs/03-数据源清单.md) | 16 个栏目的 colId、隐藏 JSON 接口、TagId 坑 |
| [`docs/04-附件下载.md`](docs/04-附件下载.md) | 81 个附件的统计、OSS 直链机制、命令行用法 |

## 待办 / 下一步

- [x] GitHub Pages 上线并恢复 229 条数据
- [ ] **建 WorkBuddy 定时任务**：工作日早上跑 `tools/publish.sh`
- [ ] 决定 Cloudflare Worker 的去留（现在是个只能读 KV 的空壳）
- [ ] `files/direct_links.csv` 是否纳入仓库（81 条 OSS 直链，配合 `aria2 -i` 可整包拉 1 GB）
- [ ] 换 fine-grained token：现在用的是 classic PAT（repo+workflow），权限过大，且明文写在 git remote 里
