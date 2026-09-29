# 境内云函数采集端点

GitHub Actions / Cloudflare 都在境外，访问不了 `hbj.huzhou.gov.cn`。
把抓取放进**中国大陆的云函数**里，境外只负责调度和发布：

```
GitHub Actions（每天 09:00，境外也无所谓）
   │  POST {seen: {...已处理的公告id...}}
   ▼
腾讯云 SCF / 阿里云 FC（境内）
   │  抓 16 个栏目 → 解析新公告详情
   │  返回 {new: [...], seen: {...更新后...}}
   ▼
Actions 合并进 data/items.json → 渲染看板 → 提交 → Pages 发布
```

## 为什么云函数不存状态

`seen`（已处理公告 id 名单，当前 13 KB）由调用方带过来、带回去。
所以函数随便冷启动、随便扩缩容，**不用接 COS/OSS/数据库**，一个纯函数就够。

只返回「本次新解析的公告」，日常增量只有几十 KB。

## 1. 打包

```bash
./cloud/build.sh          # → cloud/dist/huzhou-scrape.zip（约 3 MB）
```

脚本会自动处理依赖平台问题（Mac/Windows 上打包 Linux 二进制）。

## 先说钱：不是永久免费 ⚠️

腾讯云 SCF 的免费额度是**新用户前三个月**（含开通当月），
之后转按量计费。这不是我猜的，官方文档原话：

> 开通使用云函数三个月后的用户每月不再享受免费试用额度，采用按量计费模式。

第四个月起的实际开销（按本项目的用量算）：

| 计费项 | 单价 | 本项目月用量 | 月费用 |
|---|---|---|---|
| 资源使用量 | 0.00011108 元/GBs | 512MB × 30s × 30 次 ≈ 450 GBs | **0.050 元** |
| 调用次数 | 0.0133 元/万次 | 0.003 万次 | 0.00004 元 |
| 外网出流量 | 0.80 元/GB | ≈ 0.5 MB | 0.0004 元 |

**合计约 0.05 元/月，一年 6 毛钱。**

阿里云 FC 现在是 CU 计费，且有「每小时不足 0.01 元按 0.01 元计」的兜底规则，
按本项目用量大约 **0.3 元/月**——比腾讯云贵 6 倍，就因为这个最低计费。

所以：**前三个月 0 元，之后每月 5 分钱**。如果你要的是严格意义的永久 0 元，
那正解是定时任务在 WorkBuddy 沙箱里跑 `./tools/publish.sh`（沙箱在国内能访问政务站）。

## 2. 腾讯云 SCF —— 逐步操作

### 2.1 创建函数

<https://console.cloud.tencent.com/scf/list> → **新建** → **自定义创建**

| 字段 | 填什么 |
|---|---|
| 函数类型 | **事件函数**（不要选 Web 函数） |
| 函数名称 | `huzhou-epi-scrape` |
| 地域 | 国内任选，**上海 / 广州** 到湖州延迟低 |
| 运行环境 | **Python 3.10** |
| 创建方式 | 本地上传 zip 包 |
| 执行方法 | **`main.main_handler`** ← 两段式「文件名.函数名」，文件是 `main.py` |

> ⚠️ 执行方法是最容易填错的地方。腾讯云文档原话：
> "使用 Python 开发语言时，执行方法类似 `index.main_handler`，此处 index 表示
> 执行的入口文件为 index.py"。我们入口文件叫 `main.py`，所以填 `main.main_handler`。

### 2.2 函数配置

- **内存**：512 MB
- **执行超时**：**300 秒**（默认 3 秒，必超时）
- **公网访问**：保持「启用」（要访问政务站）

### 2.3 环境变量

函数配置 → 环境变量 → 新增：

| Key | Value |
|---|---|
| `SCRAPE_TOKEN` | 一个长随机串，比如 `openssl rand -hex 24` 的输出 |

### 2.4 加 API 网关触发器

触发管理 → 创建触发器 → **API 网关触发器**

- 请求方法：**ANY**（探活用 GET，采集用 POST）
- 鉴权方式：**免鉴权**（我们自己在函数里校验 token）
- 发布环境：发布

建好后记下「访问路径」，形如：

```
https://service-xxxxxxxx-1234567890.sh.apigw.tencentcs.com/release/huzhou-epi-scrape
```

> 从**云函数控制台**建的触发器默认开启「集成响应」，本仓库的返回格式已适配
> （`isBase64Encoded` / `statusCode` / `headers` / `body` 四件套）。

### 2.5 ⚠️ 改 API 网关的后端超时

**这一步不做就一定超时。** API 网关超时和函数超时是分别生效的：

- 网关超时 < 函数超时 → 网关先掐断，返回 5xx
- 网关超时 > 函数超时 → 函数先超时，返回 200 但内容是报错

网关默认后端超时通常只有 15 秒。去
**API 网关控制台 → 服务 → 对应 API → 后端配置 → 后端超时**，改成 **300 秒**。

日常增量其实只用 ~15 秒（列表 16 个请求 + 解析 1~3 条详情），
但如果网关就是不让改到 300，设 60 秒也能正常跑。

### 2.6 测试

```bash
# 探活
curl 'https://service-xxx.sh.apigw.tencentcs.com/release/huzhou-epi-scrape?token=你的TOKEN'
# → {"ok": true, "service": "huzhou-epi-scrape", "columns": 16, "auth": true}

# 真跑一次（不写文件）
SCRAPE_URL='https://service-xxx.../release/huzhou-epi-scrape' \
SCRAPE_TOKEN='你的TOKEN' \
python3 tools/fetch_remote.py --dry-run
```

看到 `栏目 16 成功 0 失败` 就成了。

## 3. 阿里云函数计算

1. 控制台 → **创建函数 → HTTP 函数**，运行环境 **Python 3.10**
2. 上传 zip，入口 `handler`（本仓库已提供 WSGI 适配）
3. 执行超时 **300 秒**、内存 **512 MB**
4. 环境变量 `SCRAPE_TOKEN`
5. 触发器 → HTTP 触发器，记下公网 URL

## 4. 配到 GitHub

Settings → Secrets and variables → Actions → **New repository secret**：

| Secret | 值 |
|---|---|
| `SCRAPE_URL` | 上面拿到的公网 URL |
| `SCRAPE_TOKEN` | 你设的口令 |

之后 `daily.yml` 每天 09:00 会自动走云函数路线。
没配 `SCRAPE_URL` 时该步骤自动跳过（不会失败）。

## 5. 先在本地验一遍

部署前用内置服务器模拟一遍，不花钱：

```bash
# 起服务
SCRAPE_TOKEN=test python3 - <<'PY'
import sys, os
sys.path.insert(0, '/workspace'); sys.path.insert(0, '/workspace/cloud')
from flask import Flask, request
from main import main_handler
app = Flask(__name__)
@app.route('/scrape', methods=['GET','POST'])
def s():
    r = main_handler({'body': request.get_data(as_text=True),
                      'httpMethod': request.method,
                      'headers': dict(request.headers),
                      'queryStringParameters': request.args.to_dict()}, None)
    return r['body'], r['statusCode'], {'Content-Type': 'application/json'}
app.run(port=8899, threaded=True)
PY

# 另开一个终端
curl 'http://127.0.0.1:8899/scrape?token=test'      # 探活
SCRAPE_URL=http://127.0.0.1:8899/scrape SCRAPE_TOKEN=test \
  python3 tools/fetch_remote.py --dry-run           # 看有没有新公告
```

部署后把 URL 换成真地址再跑一次同样的命令即可。

## 用量 vs 额度

腾讯云前三个月的免费额度（每月重置）：

| 项 | 免费额度 | 本项目月用量 |
|---|---|---|
| 调用次数 | 100 万次 | 30 次 |
| 资源使用量 | 100 万 GBs | ~450 GBs |
| 外网出流量 | 2 GB | ~0.5 MB |

用量是免费额度的零头。额度每月 1 号重置，不累积。

## 接口

**POST** `?token=<SCRAPE_TOKEN>` → body 见下

```jsonc
// 请求
{"seen": {"<art_id>": "2026-09-29 17:19"}, "limit": 12, "max_new": 60}

// 响应
{"ok": true,
 "new": [ /* 本次新解析的公告对象 */ ],
 "seen": { /* 更新后的 id 名单，原样存回 data/state.json */ },
 "scanned": 192,        // 列表层扫到多少条
 "parsed": 3,           // 本次解析成功几条
 "failed": 0,
 "columns_ok": 16,      // 16 个栏目成功几个
 "columns_failed": 0,
 "elapsed_sec": 21.4}
```

**GET** → 探活，返回 `{"ok":true,"columns":16,"auth":true}`
