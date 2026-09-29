# 湖州环评公示监测

定时盯着湖州市生态环境局「行政审批（许可）公示」栏下的环评公告，把每条公告里藏的
**项目明细表格**（项目名称 / 建设地点 / 建设单位 / 环评机构 / 受理日期 / 附件下载）挖出来，
去重后做成可搜索的看板。

## 两种跑法

| | 本地 Python 版 | Cloudflare Worker 版 |
|---|---|---|
| 目录 | `monitor.py` | `worker/` |
| 触发 | 手动 / crontab / WorkBuddy 定时任务 | Cloudflare Cron Trigger（原生，每分钟） |
| 存储 | `data/items.json` + `data/state.json` | Cloudflare KV（按月分片） |
| 看板 | `reports/index.html` | Worker 直接渲染，公网可访问 |
| 成本 | 需要常开的机器 | **Workers 免费计划即可** |
| 适合 | 调试解析规则、导出历史数据 | 长期无人值守、随时手机上打开 |

→ **部署到 Cloudflare Worker 看 [`worker/README.md`](worker/README.md)**，按免费计划 10ms CPU 限制专门设计过。

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
cd /workspace/huzhou-epi-monitor
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
