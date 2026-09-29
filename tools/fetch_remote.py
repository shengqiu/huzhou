# -*- coding: utf-8 -*-
"""
从境内云函数拉新公告，合并进本地 data/items.json。

云函数只返回「本次新解析的公告」，已处理的 id 名单（seen）由本脚本带上再带回来，
所以云函数本身不用存任何状态。

用法：
    export SCRAPE_URL="https://service-xxxx.gz.apigw.tencentcs.com/release/scrape"
    export SCRAPE_TOKEN="你自己设的口令"
    python3 tools/fetch_remote.py

    python3 tools/fetch_remote.py --limit 20 --max-new 100   # 抓得更狠一点
    python3 tools/fetch_remote.py --dry-run                  # 只探活，不落盘
"""

import os
import sys
import json
import argparse
import datetime

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
ITEMS_PATH = os.path.join(DATA_DIR, "items.json")
STATE_PATH = os.path.join(DATA_DIR, "state.json")
KEEP_DAYS = 550          # 历史库只留 18 个月，和 monitor.py 保持一致


def load_json(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[warn] {path} 读不出来（{e!r}），按空处理")
        return default


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=12)
    ap.add_argument("--max-new", type=int, default=60)
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--dry-run", action="store_true", help="只探活，不写文件")
    args = ap.parse_args()

    url = os.environ.get("SCRAPE_URL", "").strip()
    token = os.environ.get("SCRAPE_TOKEN", "").strip()
    if not url:
        sys.exit("缺少环境变量 SCRAPE_URL（境内云函数的 HTTP 地址）")

    sep = "&" if "?" in url else "?"
    if token:
        url = f"{url}{sep}token={token}"

    state = load_json(STATE_PATH, {"initialized": True, "seen": {}})
    seen = dict(state.get("seen") or {})
    items = load_json(ITEMS_PATH, [])
    print(f"本地在库 {len(items)} 条，已处理标记 {len(seen)} 个")

    print(f"→ 调用云函数（limit={args.limit}, max_new={args.max_new}）")
    r = requests.post(url,
                      json={"seen": seen, "limit": args.limit, "max_new": args.max_new},
                      timeout=args.timeout)
    print(f"← HTTP {r.status_code}, {len(r.content)} 字节")
    if r.status_code != 200:
        sys.exit(f"云函数返回 {r.status_code}：{r.text[:500]}")
    try:
        data = r.json()
    except Exception:
        sys.exit(f"响应不是 JSON：{r.text[:300]}")
    if not data.get("ok"):
        sys.exit(f"云函数报错：{data.get('error')}")

    print(f"   扫描 {data.get('scanned')} 条 / 新解析 {data.get('parsed')} 条 / "
          f"失败 {data.get('failed')} 条 / 耗时 {data.get('elapsed_sec')}s / "
          f"栏目 {data.get('columns_ok')} 成功 {data.get('columns_failed')} 失败")

    fresh = data.get("new") or []
    if args.dry_run:
        print("--dry-run：不写文件")
        for i in fresh[:10]:
            print(f"   {i.get('发布日期')} [{i.get('unit')}] {i.get('title')[:40]}")
        return 0

    known = {i["art_id"] for i in items}
    added = 0
    for it in fresh:
        if it.get("art_id") in known:
            continue
        items.append(it)
        known.add(it["art_id"])
        added += 1

    # 清理过期 + 去重，和 monitor.py 的规则一致
    cutoff = (datetime.datetime.now() - datetime.timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d")
    dedup, seen_keys = [], set()
    for i in sorted(items, key=lambda x: x.get("发布日期", ""), reverse=True):
        if i.get("发布日期", "") < cutoff or i["art_id"] in seen_keys:
            continue
        seen_keys.add(i["art_id"])
        dedup.append(i)
    dropped = len(items) - len(dedup)
    items = dedup

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(ITEMS_PATH, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=1)
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump({"initialized": True, "seen": data.get("seen") or seen},
                  f, ensure_ascii=False, indent=1)

    att = sum(len(p.get("附件链接", [])) for i in items for p in i.get("项目", []))
    print(f"✅ 在库 {len(items)} 条（新增 {added}，清理 {dropped}） / 附件 {att} 个")
    print(f"::notice::公告 {len(items)} 条 / 新增 {added} / 附件 {att} 个")
    return 0


if __name__ == "__main__":
    sys.exit(main())
