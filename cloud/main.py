# -*- coding: utf-8 -*-
"""
湖州环评公示采集 —— 云函数入口（腾讯云 SCF / 阿里云 FC 通用）

为什么要有这层：hbj.huzhou.gov.cn 拒绝境外 IP，GitHub Actions 和 Cloudflare
都抓不到。把抓取放到境内云函数里，Actions 只负责调度、合并和发布。

设计要点：
  * 云函数不保存状态。已处理的公告 id 由调用方（Actions）通过请求体带过来，
    处理完再带回去 —— 所以函数可以随便冷启动、随便扩缩容，不用接 COS/OSS。
  * 只返回「本次新解析的公告」，不是全量 —— 日常增量只有几十 KB。

请求体 (POST JSON)：
    {"seen": {"<art_id>": "2026-09-29 17:19", ...},   # 已处理过的公告
     "limit": 12,        # 每栏目取最新几条，默认 12
     "max_new": 60}      # 单次最多解析几条新公告，默认 60

响应 (JSON)：
    {"ok": true, "new": [<公告对象>...], "seen": {...更新后的...},
     "scanned": 192, "parsed": 3, "failed": 0, "elapsed_sec": 21.4,
     "columns_ok": 16, "columns_failed": 0}

鉴权：环境变量 SCRAPE_TOKEN；调用方在 query `?token=xxx` 或头 `X-Token` 里带上。
没设 SCRAPE_TOKEN 时不鉴权（调试用，别在生产这么干）。
"""

import os
import json
import time
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed

from monitor import COLUMNS, fetch_list, parse_detail, now_cst


# ------------------------------------------------------------------ 业务

def do_scrape(body):
    t0 = time.time()
    seen = dict(body.get("seen") or {})
    limit = int(body.get("limit") or 12)
    max_new = int(body.get("max_new") or 60)

    sess = _session()
    candidates, col_ok, col_fail = [], 0, 0
    for col_id in COLUMNS:
        try:
            candidates.extend(fetch_list(col_id, limit, session=sess))
            col_ok += 1
        except Exception as e:
            col_fail += 1
            print(f"[skip] col{col_id}: {e!r}")

    uniq = {}
    for c in candidates:
        uniq.setdefault(c["art_id"], c)

    targets = [v for k, v in uniq.items() if k not in seen][:max_new]

    new_items, failed = [], 0
    if targets:
        with ThreadPoolExecutor(max_workers=6) as ex:
            futs = {ex.submit(parse_detail, t): t for t in targets}
            for fu in as_completed(futs):
                t = futs[fu]
                try:
                    detail = fu.result()
                except Exception as e:
                    failed += 1
                    print(f"[fail] {t['title'][:30]}: {e!r}")
                    continue
                new_items.append(detail)
                seen[t["art_id"]] = now_cst().strftime("%Y-%m-%d %H:%M")

    new_items.sort(key=lambda x: (x.get("发布日期") or ""), reverse=True)
    return {
        "ok": True,
        "new": new_items,
        "seen": seen,
        "scanned": len(uniq),
        "parsed": len(new_items),
        "failed": failed,
        "columns_ok": col_ok,
        "columns_failed": col_fail,
        "elapsed_sec": round(time.time() - t0, 1),
    }


def _session():
    import requests
    s = requests.Session()
    s.keep_alive = False
    return s


# ------------------------------------------------------------------ HTTP 层

def _check_auth(query, headers):
    token = os.environ.get("SCRAPE_TOKEN", "").strip()
    if not token:
        return True
    got = ""
    if query:
        got = query.get("token") or query.get("Token") or ""
    if not got and headers:
        got = (headers.get("x-token") or headers.get("X-Token")
               or headers.get("X_TOKEN") or "")
    return got == token


def _parse_body(event):
    raw = event.get("body")
    if raw is None:
        return {}
    if event.get("isBase64Encoded") or (isinstance(event.get("headers"), dict)
            and "application/json" not in str(event["headers"].get("content-type", ""))
            and event.get("isBase64Encoded")):
        raw = base64.b64decode(raw)
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {}


def _resp(code, obj):
    return {
        "statusCode": code,
        "headers": {"Content-Type": "application/json; charset=utf-8",
                    "Cache-Control": "no-store"},
        "body": json.dumps(obj, ensure_ascii=False),
    }


# ---- 腾讯云 SCF（API 网关触发器 / HTTP 触发） ----

def main_handler(event, context):
    try:
        query = event.get("queryStringParameters") or {}
        if not isinstance(query, dict):
            query = {}
        if not _check_auth(query, event.get("headers") or {}):
            return _resp(403, {"ok": False, "error": "bad token"})

        path = event.get("path") or ""
        body = _parse_body(event)
        method = (event.get("httpMethod") or event.get("requestContext", {}).get("httpMethod") or "").upper()

        if path.rstrip("/").endswith("/health") or method == "GET":
            return _resp(200, {"ok": True, "service": "huzhou-epi-scrape",
                               "columns": len(COLUMNS),
                               "auth": bool(os.environ.get("SCRAPE_TOKEN"))})
        return _resp(200, do_scrape(body))
    except Exception as e:
        import traceback
        traceback.print_exc()
        return _resp(500, {"ok": False, "error": repr(e)})


# ---- 阿里云函数计算（HTTP 函数，WSGI 风格） ----

def handler(environ, start_response):
    from urllib.parse import parse_qs, urlparse
    try:
        qs = parse_qs(urlparse(environ.get("PATH_INFO", "") or environ.get("RAW_URI", "")).query)
        query = {k: v[0] for k, v in qs.items()}
        headers = {}
        for k, v in environ.items():
            if k.startswith("HTTP_"):
                headers[k[5:].lower().replace("_", "-")] = v
        if not _check_auth(query, headers):
            start_response("403 Forbidden", [("Content-Type", "application/json")])
            return [json.dumps({"ok": False, "error": "bad token"}).encode()]

        length = int(environ.get("CONTENT_LENGTH") or 0)
        raw = environ["wsgi.input"].read(length) if length else b""
        body = json.loads(raw.decode("utf-8", "replace")) if raw else {}

        if (environ.get("REQUEST_METHOD") or "").upper() == "GET":
            out = {"ok": True, "service": "huzhou-epi-scrape", "columns": len(COLUMNS)}
        else:
            out = do_scrape(body)

        payload = json.dumps(out, ensure_ascii=False).encode()
        start_response("200 OK", [("Content-Type", "application/json; charset=utf-8"),
                                  ("Content-Length", str(len(payload)))])
        return [payload]
    except Exception as e:
        import traceback
        traceback.print_exc()
        payload = json.dumps({"ok": False, "error": repr(e)}, ensure_ascii=False).encode()
        start_response("500 Internal Server Error", [("Content-Type", "application/json")])
        return [payload]


# 本地试跑：python3 cloud/main.py
if __name__ == "__main__":
    print(json.dumps(do_scrape({"limit": 3, "max_new": 3}),
                     ensure_ascii=False)[:800])
