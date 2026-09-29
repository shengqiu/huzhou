#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把本地已经采集好的历史数据，打包成 wrangler 能直接灌进 KV 的 bulk 文件。

为什么需要这一步：
    Worker 免费版靠「每分钟 cron + 每次处理 1 个任务」慢慢跑，
    第一次上线要消化 200+ 条历史得花好几个小时。先把历史灌进去，
    之后 cron 每天只处理真正新出现的几条公告，非常省。

KV 结构（自由版）：
    m:2026-09   该月的公告数组（按月分片，避免每次全量读写一个大 JSON）
    idx         月份清单 + 运行状态
    pending     任务队列

用法：
    cd /workspace/huzhou-epi-monitor
    python3 monitor.py            # 先本地跑出 data/items.json
    python3 tools/export_kv.py    # 生成 kv-bulk.json
    cd worker && npx wrangler kv bulk put ../kv-bulk.json --binding=EPI_KV
"""

import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ITEMS = os.path.join(ROOT, "data", "items.json")
OUT = os.path.join(ROOT, "kv-bulk.json")
CST = timezone(timedelta(hours=8))

# 字段名：本地 Python 版用中文 key，Worker 版用简短英文 key
FIELD_MAP = {
    "art_id": "art_id",
    "title": "title",
    "url": "url",
    "发布日期": "date",
    "unit": "unit",
    "category": "category",
    "类型": "type",
    "区域": "area",
    "项目": "projects",
    "抓取时间": "fetched_at",
}
PROJECT_MAP = {
    "项目名称": "name",
    "地点": "loc",
    "单位": "org",
    "机构": "inst",
    "受理日期": "date",
    "附件链接": "files",
    "备注": "note",
}


def convert(item):
    out = {}
    for src, dst in FIELD_MAP.items():
        if src in item:
            out[dst] = item[src]
    out["projects"] = [
        {PROJECT_MAP.get(k, k): v for k, v in p.items()}
        for p in item.get("项目", [])
    ]
    out.setdefault("fetched_at", datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S"))
    return out


def main():
    if not os.path.exists(ITEMS):
        sys.exit(f"找不到 {ITEMS}，请先运行 python3 monitor.py")

    with open(ITEMS, encoding="utf-8") as f:
        items = json.load(f)

    by_month = defaultdict(list)
    for it in items:
        rec = convert(it)
        month = (rec.get("date") or datetime.now(CST).strftime("%Y-%m-%d"))[:7]
        by_month[month].append(rec)

    months = sorted(by_month.keys(), reverse=True)
    now = datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")
    today = now[:10]

    bulk = []
    for m in months:
        bulk.append({"key": f"m:{m}", "value": json.dumps(by_month[m], ensure_ascii=False)})
    bulk.append({"key": "pending", "value": "[]"})
    bulk.append({"key": "idx", "value": json.dumps({
        "months": months,
        "meta": {
            "lastScan": today,          # 让 Worker 今天不再重复扫一轮
            "lastTaskAt": now,
            "runs": len(items),
            "source": "local-seed",
        },
    }, ensure_ascii=False)})

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(bulk, f, ensure_ascii=False, indent=1)

    print(f"已生成 {OUT}")
    print(f"  {len(items)} 条公告 → {len(months)} 个月份分片：{', '.join(months)}")
    print(f"  文件大小 {os.path.getsize(OUT) / 1024:.0f} KB")
    print()
    print("导入命令：")
    print("  cd worker && npx wrangler kv bulk put ../kv-bulk.json --binding=EPI_KV")
    print()
    print("注意：KV 免费额度是每天 1000 次写入，")
    print(f"      本次导入 {len(bulk)} 个 key，加上每天 cron 的十几次写入，完全够用。")


if __name__ == "__main__":
    main()
