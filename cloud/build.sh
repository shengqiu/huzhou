#!/usr/bin/env bash
# 打一个能直接上传到腾讯云 SCF / 阿里云 FC 的 zip 包。
#
# 依赖必须打 Linux 平台的二进制（requests/bs4 有 C 扩展），
# 在 Mac/Windows 上打包要加 --platform，否则云函数 import 会失败。
#
#   ./cloud/build.sh           → cloud/dist/huzhou-scrape.zip
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="cloud/dist/huzhou-scrape.zip"
STAGE="cloud/dist/_stage"

rm -rf "$STAGE" cloud/dist/huzhou-scrape.zip
mkdir -p "$STAGE"

cp monitor.py "$STAGE/"
cp cloud/main.py "$STAGE/"

echo "▶ 装 Linux 版依赖"
PY="${PYTHON:-python3}"
case "$(uname -s)" in
  Darwin|MINGW*|MSYS*|CYGWIN*)
    echo "  非 Linux 主机 → 指定 manylinux 平台"
    "$PY" -m pip install --quiet --target "$STAGE" \
      --platform manylinux2014_x86_64 \
      --python-version 3.10 \
      --only-binary=:all: --upgrade \
      requests beautifulsoup4
    ;;
  *)
    "$PY" -m pip install --quiet --target "$STAGE" --upgrade \
      requests beautifulsoup4
    ;;
esac

# 云函数跑在只读目录，data/ 用不上，但 monitor.py 顶层会算路径，留个空壳保险
mkdir -p "$STAGE/data" "$STAGE/reports"

cd "$STAGE"
zip -qr "../huzhou-scrape.zip" . -x '*.pyc' -x '__pycache__/*'
cd - >/dev/null

SIZE=$(du -h "$OUT" | cut -f1)
echo "✅ $OUT（$SIZE）"
echo
echo "腾讯云：控制台 → 云函数 → 新建 → 事件函数 Python 3.10"
echo "        执行方法填 main.main_handler，内存 512MB，超时 300s"
echo "        对外用「函数 URL」（API 网关已 2025-06-30 停服），授权类型选「开放」"
echo "阿里云：函数计算 → 创建函数 → HTTP 函数 → 运行环境 Python 3.10"
echo "        上传 zip → 入口 handler"
