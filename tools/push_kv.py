#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 kv-bulk.json 通过 Cloudflare REST API 写进 KV 命名空间。

为什么要有这个：Cloudflare Worker 的出网可能访问不到湖州市生态环境局（境外节点被拦），
采集放在 GitHub Actions 上跑，再用这个脚本把结果推到 KV，Worker 只负责读和展示。

用法：
    export CF_ACCOUNT_ID=<账号ID>
    export CF_KV_NAMESPACE_ID=<命名空间ID>
    export CF_API_TOKEN=<API Token>
    python3 tools/push_kv.py                 # 写入
    python3 tools/push_kv.py --dry-run       # 只看看要写什么，不发请求

需要的 Token 权限：Account → Workers KV Storage: Edit
生成器：https://dash.cloudflare.com/profile/api-tokens
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"


def load(path):
    if not os.path.exists(path):
        sys.exit(f"找不到 {path}，请先运行 python3 tools/export_kv.py")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default="kv-bulk.json", help="待推送的 bulk 文件")
    ap.add_argument("--dry-run", action="store_true", help="只统计不发送")
    ap.add_argument("--verify", action="store_true", help="先验证 token 是否有效")
    args = ap.parse_args()

    data = load(args.file)
    items = sum(
        len(json.loads(x["value"])) if x["key"].startswith("m:") else 0
        for x in data
        if isinstance(json.loads(x["value"]), list)
    ) if not args.dry_run else 0

    print(f"[push_kv] {args.file} 共 {len(data)} 个键"
          + (f"，其中 {items} 条公告" if items else ""))

    if args.dry_run:
        for x in data:
            v = x["value"]
            n = len(json.loads(v)) if x["key"].startswith("m:") else None
            print(f"  {x['key']:<12} {len(v):>8,}B" + (f"  ({n} 条)" if n is not None else ""))
        print("[push_kv] --dry-run，未发送任何请求")
        return 0

    acct = os.environ.get("CF_ACCOUNT_ID")
    ns = os.environ.get("CF_KV_NAMESPACE_ID")
    tok = os.environ.get("CF_API_TOKEN")
    missing = [k for k, v in (("CF_ACCOUNT_ID", acct), ("CF_KV_NAMESPACE_ID", ns), ("CF_API_TOKEN", tok)) if not v]
    if missing:
        sys.exit("缺少环境变量：" + " / ".join(missing))

    if args.verify:
        req = urllib.request.Request(
            f"{API}/user/tokens/verify",
            headers={"Authorization": f"Bearer {tok}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                res = json.load(r)
            print("[push_kv] token 状态:", res.get("result", {}).get("status"),
                  "| 账号:", res.get("result", {}).get("issuing_account_name"))
        except urllib.error.HTTPError as e:
            sys.exit(f"[push_kv] token 验证失败: HTTP {e.code} {e.read()[:200]}")

    url = f"{API}/accounts/{acct}/storage/kv/namespaces/{ns}/bulk"
    body = json.dumps(data, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="PUT",
        headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            res = json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"[push_kv] 写入失败: HTTP {e.code} {e.read()[:400]}")

    if not res.get("success"):
        sys.exit(f"[push_kv] 写入失败: {json.dumps(res.get('errors'), ensure_ascii=False)}")
    print(f"[push_kv] 写入成功：{len(data)} 个键已推送到 KV 命名空间 {ns[:8]}…")
    return 0


if __name__ == "__main__":
    sys.exit(main())
