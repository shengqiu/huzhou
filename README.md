# 湖州环评公示监测

定时盯着湖州市生态环境局「行政审批（许可）公示」栏下的环评公告，把每条公告里藏的
**项目明细表格**（项目名称 / 建设地点 / 建设单位 / 环评机构 / 受理日期 / 附件下载）挖出来，
去重后做成可搜索的看板。

## ⚠️ 先看这条：采集只能在境内跑

`hbj.huzhou.gov.cn` 拒绝境外 IP，实测结果：

| 环境 | 结果 |
|---|---|
| 境内（本机 / 国内服务器 / 境内云函数） | ✅ 16 栏目 3~5 秒跑完，249 条 |
| GitHub Actions 托管 runner（美国机房） | ❌ 16 栏目全超时，504 秒 0 条 |

所以 **GitHub Actions 只负责调度和发布，不负责采集**。看板发布在
**https://shengqiu.github.io/huzhou/**。

## 三种跑法

| | 手动一键 | **云函数（推荐）** | Actions + 自托管 runner |
|---|---|---|---|
| 目录 | `tools/publish.sh` | `cloud/` | `.github/workflows/daily.yml` |
| 触发 | 手动 | **每天 09:00 CST 自动** | 每天 09:00 CST 自动 |
| 采集在哪跑 | 本机（境内） | 腾讯云/阿里云（境内） | 你自己常开的机器 |
| 要常开机器吗 | 否 | **否** | 是 |
| 看板 | GitHub Pages | GitHub Pages | GitHub Pages |

### 1. 手动一键（最快）

```bash
cd /workspace
./tools/publish.sh          # 采集 → 生成看板 → 提交 → 推送 → Pages 自动发布
./tools/publish.sh --no-push  # 只采集不推送
./tools/publish.sh --mail     # 顺便按「项目」逐封发邮件（默认发链接，详见 docs/05-邮件推送.md）
```

### 2. 云函数：不用常开机器也能全自动 ⭐

把抓取放进境内云函数（腾讯云 SCF / 阿里云 FC，都有免费额度），
GitHub Actions 只负责每天 09:00 调度、合并、发布：

```
Actions（境外无所谓） → POST seen → 境内云函数抓+解析 → 返回新公告 → 合并 → Pages
```

云函数**不存状态**：已处理公告的 id 名单随请求带来带去，所以不用接 COS/OSS，
一个纯函数就够。日常增量只传几十 KB。

完整部署步骤见 [`cloud/README.md`](cloud/README.md) —— 打包、上传、
开放函数 URL（腾讯云 API 网关已 2025-06-30 停服，改用函数 URL，不收费）、
配 `SCRAPE_URL`/`SCRAPE_TOKEN` 两个 secret。

### 3. 让「每天 09:00」真正抓到数据：装 self-hosted runner

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

### 4. 还是只想要推送后的自动发布

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

## 下载公告里的附件

这才是最有价值的部分——环境影响报告书/报告表全本、公众参与说明。
每条带表格的公告都会把附件链接摘出来存在 `项目[].附件链接` 里。

实测规模：

```
81 个附件（分布在 59 条公告里）    合计 ~1 GB
    最大单个  137.5 MB     典型 20~40 MB     最小 349 KB
```

**必须本地下载**——附件单文件最大 137.5 MB，远超任何 Serverless 环境的内存/存储上限。
用本地脚本（支持 Range 断点续传、并发、按条件过滤）：

```bash
python3 tools/download.py --dry-run            # 先看清楚有哪些、多大
python3 tools/download.py --keyword 化工        # 按项目名/单位/文件名过滤
python3 tools/download.py --unit 南浔           # 只要某个单位的
python3 tools/download.py --since 2026-09-01   # 只要某天之后的
python3 tools/download.py --max-size 50        # 跳过超过 50MB 的
python3 tools/download.py --workers 5          # 提高并发
```

## 按项目发邮件（默认只发链接）

每条公告有好几个项目，**一个项目一封邮件**：

```bash
export SMTP_USER="你的邮箱@qq.com"      # 密码填 16 位 SMTP 授权码
export SMTP_PASS="十六位授权码"
python3 tools/mailer.py --dry-run            # 先看清单，不发信
python3 tools/mailer.py --limit 3            # 试发 3 封确认排版
python3 tools/mailer.py --since 30 --yes     # 补发最近 30 天
python3 tools/mailer.py --attach             # 境内手动：把小附件打包进邮件
```

- **默认只发链接**：带附件的项目正文给政务网直链（境内可打开），不下载附件本体
- 加 `--attach` 才把小附件（≤ `--max-attach`，默认 30MB）下载并打包成 zip 随信；境外/Actions 下不动政务网，所以这步只在境内手动机跑
- 没附件的项目也发，正文只放项目信息
- 已发过的记在 `data/mail_state.json`，不会重复轰炸

### 已上 GitHub Actions（`.github/workflows/mail.yml`）

每 2 小时自动跑一次、每次 1 封，默认走链接模式（不下载附件），SMTP 凭证全在
**Settings → Secrets**（`SMTP_USER` / `SMTP_PASS` / `MAIL_TO` 等），仓库只留 `.env.example`。
发完把 `data/mail_state.json` 回写仓库，跨运行续传。

完整说明见 [`docs/05-邮件推送.md`](docs/05-邮件推送.md)。

产物：

```
files/
  2026-08-13_南浔分局/
    年产电梯井架600台.../
      上尚电梯-环境影响登记表.pdf
  manifest.csv          # 清单：日期/单位/项目名称/建设单位/文件名/大小/原文链接
```

支持断点续传，重复跑会自动跳过已下好的。注意磁盘要留 1 GB 以上。
