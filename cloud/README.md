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

## 2. 腾讯云 SCF

1. 控制台 → **云函数 → 新建函数 → 事件函数**，运行环境 **Python 3.10**
2. 函数代码：上传本地 zip 包（`huzhou-scrape.zip`）
3. 执行配置：
   - 内存 **512 MB**
   - **执行超时 300 秒** ← 默认 3 秒必超时
   - 入口函数 `main_handler`
4. 环境变量加 `SCRAPE_TOKEN` = 你自己编一个长随机串
5. 触发器 → **API 网关触发器**，记下公网访问路径，例如
   `https://service-xxxxxx-1234567890.gz.apigw.tencentcs.com/release/huzhou`
6. ⚠️ **API 网关的后端超时默认只有 15 秒，必须改**：
   API 网关控制台 → 该 API → 后端配置 → 后端超时改成 **300 秒**

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

## 免费额度够吗

每天 1 次调用，每次约 512 MB × 30 秒 ≈ 15 GBs：

| 项 | 免费额度 | 本项目月用量 |
|---|---|---|
| 调用次数 | 100 万次/月 | 30 次 |
| 资源使用量 | 40 万 GBs/月 | ~450 GBs |
| 出网流量 | 有限但够用 | ~1 MB/次（只回传新公告） |

用量是免费额度的零头。

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
