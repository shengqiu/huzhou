#!/usr/bin/env bash
# 一键：采集 → 生成看板 → 提交 → 推送 → GitHub Pages 自动发布
#
# 为什么必须在本地/沙箱跑采集：
#   hbj.huzhou.gov.cn 拒境外 IP。实测 GitHub Actions（美国机房）16 个栏目全部
#   超时，504 秒拿到 0 条；Cloudflare Workers 出口同样是 20s TimeoutError。
#   所以采集放国内跑，GitHub 只做发布（.github/workflows/pages.yml）。
#
# 用法：
#   ./tools/publish.sh              # 采集 + 推送（无新增就什么都不提交）
#   ./tools/publish.sh --force      # 无新增也提交（重刷看板样式/时间戳）
#   ./tools/publish.sh --no-push    # 只采集不推送
#   ./tools/publish.sh --kv         # 顺便同步到 Cloudflare KV（需 CF_* 环境变量）
set -euo pipefail

cd "$(dirname "$0")/.."

FORCE=0
PUSH=1
KV=0
for a in "$@"; do
  case "$a" in
    --force)   FORCE=1 ;;
    --no-push) PUSH=0 ;;
    --kv)      KV=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数: $a"; exit 1 ;;
  esac
done

before=$(python3 -c "import json;print(len(json.load(open('data/items.json',encoding='utf-8'))))" 2>/dev/null || echo 0)

echo "▶ 采集（境外跑不了，这一步必须在国内网络执行）"
python3 monitor.py

after=$(python3 -c "import json;print(len(json.load(open('data/items.json',encoding='utf-8'))))")
new=$((after - before))
echo "▶ 公告总数 $before → $after（新增 $new）"

att=$(python3 -c "
import json
d=json.load(open('data/items.json',encoding='utf-8'))
print(sum(len(p.get('附件链接',[])) for i in d for p in i.get('项目',[])))
")
echo "▶ 附件链接 $att 个"

python3 tools/export_kv.py

if [ "$KV" = "1" ]; then
  echo "▶ 同步到 Cloudflare KV"
  python3 tools/push_kv.py
fi

if [ "$PUSH" = "0" ]; then
  echo "● --no-push：已跳过推送，看板在 reports/index.html"
  exit 0
fi

git add data reports
if git diff --cached --quiet; then
  if [ "$FORCE" = "1" ]; then
    echo "▶ 无变化，但 --force：重刷一次提交"
    git commit --allow-empty -m "chore: 定时采集 $(date +%F)（无新增）"
  else
    echo "● 无新内容，跳过提交"
    exit 0
  fi
else
  git commit -m "data: 采集 $(date +%F)（共 ${after} 条，新增 ${new}）"
fi

echo "▶ 推送 → GitHub Pages 自动发布"
git push origin "$(git branch --show-current)"

echo "✅ 完成，稍等 1~2 分钟访问 https://shengqiu.github.io/huzhou/"
