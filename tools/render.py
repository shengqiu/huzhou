# -*- coding: utf-8 -*-
"""
只渲染看板，不采集。

境外 runner 拿到境内云函数传回来的数据后，用这个把 reports/index.html 生成出来。

用法：
    python3 tools/render.py                 # 用 data/items.json 重刷看板
    python3 tools/render.py --new-since 3   # 最近 3 天的标 NEW
"""

import os
import sys
import json
import argparse
import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from monitor import build_html, ITEMS_PATH, HTML_PATH   # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--new-since", type=int, default=2,
                    help="最近 N 天入库的公告标 NEW，默认 2")
    args = ap.parse_args()

    if not os.path.exists(ITEMS_PATH):
        sys.exit(f"没有 {ITEMS_PATH}，先采集")

    with open(ITEMS_PATH, encoding="utf-8") as f:
        items = json.load(f)

    cutoff = (datetime.datetime.now() - datetime.timedelta(days=args.new_since)).strftime("%Y-%m-%d")
    new_ids = {i["art_id"] for i in items if (i.get("发布日期") or "") >= cutoff}

    html = build_html(items, new_ids, {"total": len({i["art_id"] for i in items})})
    os.makedirs(os.path.dirname(HTML_PATH), exist_ok=True)
    with open(HTML_PATH, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"✅ 看板已生成：{HTML_PATH}（{len(html)} 字节，{len(items)} 条，"
          f"标 NEW {len(new_ids)} 条）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
