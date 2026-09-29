# 湖州环评公示监测

定时盯着湖州市生态环境局「行政审批（许可）公示」栏下的环评公告，把每条公告里藏的
**项目明细表格**（项目名称 / 建设地点 / 建设单位 / 环评机构 / 受理日期 / 附件下载）挖出来，
去重后做成可搜索的看板。

## ⚠️ 先看这条：采集只能在境内跑

`hbj.huzhou.gov.cn` 拒绝境外 IP，实测结果：

| 环境 | 结果 |
|---|---|
| 境内（本机 / 国内服务器） | ✅ 16 栏目 30 秒跑完，229 条 |
| Cloudflare Workers 出口 | ❌ `TimeoutError` 20s |
| GitHub Actions 托管 runner（美国机房） | ❌ 16 栏目全超时，504 秒 0 条 |

所以 **GitHub Actions 只负责发布，不负责采集**。看板发布在
**https://shengqiu.github.io/huzhou/**。

## 三种跑法

| | 手动一键 | GitHub Actions 定时（配自托管 runner） | Cloudflare Worker |
|---|---|---|---|
| 目录 | `tools/publish.sh` | `.github/workflows/daily.yml` | `worker/` |
| 触发 | 手动 | **每天 09:00 CST 自动** | Cron Trigger（每分钟） |
| 采集在哪跑 | 本机（境内） | 你自己的机器（境内） | Cloudflare 出口 ❌ 抓不到 |
| 看板 | `reports/index.html` → GitHub Pages | 同上 | Worker 渲染 |
| 成本 | 免费 | 免费 | 免费 |

### 1. 手动一键（最快）

```bash
cd /workspace
./tools/publish.sh          # 采集 → 生成看板 → 提交 → 推送 → Pages 自动发布
./tools/publish.sh --no-push  # 只采集不推送
```

### 2. 让「每天 09:00」真正抓到数据：装 self-hosted runner

`daily.yml` 的定时已经配好（UTC 01:00 = 北京 09:00）。默认跑在 GitHub 托管
runner 上，会被政务站拦住——流程会 fail-fast 并**跳过发布**，线上看板不受影响
（已验证）。要让它真正采到数据，在你境内常开的机器上装个 runner：

1. 仓库 → **Settings → Actions → Runners → New self-hosted runner**，选 Linux/macOS，
   复制页面上的 token
2. 在那台机器上：
   ```bash
   mkdir actions-runner && cd actions-runner
   curl -o r.tar.gz -L https://github.com/actions-runner/releases/download/v2.317.0/actions-runner-osx-arm64-2.317.0.tar.gz
   tar xzf r.tar.gz
   ./config.sh --url https://github.com/shengqiu/huzhou --token <页面给的TOKEN>
   ./run.sh          # 想常驻就 ./svc.sh install && ./svc.sh start
   ```
3. 仓库 → **Settings → Secrets and variables → Actions → Variables**
   → 新建变量 `RUNNER_LABEL` = `self-hosted`

之后每天 09:00 会自动在国内网络采集 + 提交 + 发布。机器关机时任务会 pending，
开机后补跑。

### 3. 还是只想要推送后的自动发布

`.github/workflows/pages.yml`：任何 `reports/` 或 `data/` 变更推到 main 都会
触发，并且**看板数据为 0 条时拒绝发布**（保险丝）。

## 采集范围

16 个栏目全量覆盖：

- **非辐环评审批**：市局、吴兴、南太湖新区、南浔、德清、长兴、安吉、长合分局
- **辐射项目审批**：市局、吴兴、南浔、德清、长兴、安吉、南太湖新区分局
- **建设项目环境影响评价信息公示**（全市）

公告类型会自动归类：受理公告 / 拟审批公示 / 审批决定公告 / 环评信息公示 / 其他。

## 数据源

栏目列表虽然是 JS 动态渲染的，但底层有个返回 JSON 的 HTTP 接口，所以两个版本**都不需要浏览器**：

```
GET https://hbj.huzhou.gov.cn/api-gateway/jpaas-publish-server/front/page/build/unit
    ?parseType=bulidstatic&webId=3630&tplSetId=5HrZiFGOR8vHklhTYqM4B
    &pageType=column&tagId=zw&editType=null&pageId=<栏目ID>
```

返回 `{ data: { html: "..." } }`，html 里就是带日期的列表。
（栏目 `1229858680` 用的是 `tagId=list`，代码里做了自动回退。）

采集全量一轮约 **30 秒**，当前在库 229 条公告 / 154 个建设项目。

## 本地快速开始

```bash
cd /workspace
python3 monitor.py            # 首次运行会建立历史基线
python3 monitor.py --limit 20 # 也可以让每个栏目多抓几条
open reports/index.html
```

需要 `requests` + `beautifulsoup4`。

## 导出到 KV（推荐第一步）

把本地攒好的历史一次性灌进 Worker 的 KV，Worker 之后就只处理真正的新公告：

```bash
python3 monitor.py            # 采集 → data/items.json
python3 tools/export_kv.py    # 按月份分片 → kv-bulk.json
cd worker && npx wrangler kv bulk put ../kv-bulk.json --binding=EPI_KV
```

## 下载公告里的附件

这才是最有价值的部分——环境影响报告书/报告表全本、公众参与说明。
每条带表格的公告都会把附件链接摘出来存在 `项目[].附件链接` 里。

实测规模：

```
81 个附件（分布在 59 条公告里）    合计 ~1 GB
    最大单个  137.5 MB     典型 20~40 MB     最小 349 KB
```

**别用 Cloudflare 下这些文件**——Workers 内存只有 128MB，KV 单值上限 25MB。
用本地脚本：

```bash
python3 tools/download.py --dry-run            # 先看清楚有哪些、多大
python3 tools/download.py --keyword 化工        # 按项目名/单位/文件名过滤
python3 tools/download.py --unit 南浔           # 只要某个单位的
python3 tools/download.py --since 2026-09-01   # 只要某天之后的
python3 tools/download.py --max-size 50        # 跳过超过 50MB 的
python3 tools/download.py --workers 5          # 提高并发
```

产物：

```
files/
  2026-08-13_南浔分局/
    年产电梯井架600台.../
      上尚电梯-环境影响登记表.pdf
  manifest.csv          # 清单：日期/单位/项目名称/建设单位/文件名/大小/原文链接
```

支持断点续传，重复跑会自动跳过已下好的。注意磁盘要留 1 GB 以上。
