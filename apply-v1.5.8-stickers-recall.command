#!/bin/bash
set -euo pipefail

VERSION="1.5.8"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PATCH_DIR="$SCRIPT_DIR/www"

echo "EVE v${VERSION} 表情包／撤回修复工具"
echo "此工具使用压缩包内文件，不会从 GitHub 下载。"

if [ ! -s "$PATCH_DIR/js/eve-reliability-v158.js" ] || [ ! -s "$PATCH_DIR/js/healthcheck.js" ]; then
  echo "错误：修复包不完整，请确认没有只移动 .command 文件。"
  read -r -p "按 Enter 结束…"
  exit 1
fi

PROJECT="$(osascript -e 'POSIX path of (choose folder with prompt "选择 EVE iOS 项目资料夹（里面有 www、ios、package.json）")')"
PROJECT="${PROJECT%/}"

for required in "www" "ios" "package.json" "capacitor.config.ts"; do
  if [ ! -e "$PROJECT/$required" ]; then
    echo "错误：所选资料夹缺少 $required"
    read -r -p "按 Enter 结束…"
    exit 1
  fi
done

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$PROJECT/backups/runtime-before-v${VERSION}-$STAMP"
mkdir -p "$BACKUP/js"

for file in "js/eve-reliability-v158.js" "js/healthcheck.js"; do
  if [ -f "$PROJECT/www/$file" ]; then
    cp "$PROJECT/www/$file" "$BACKUP/js/$(basename "$file")"
  fi
done

mkdir -p "$PROJECT/www/js"
ditto "$PATCH_DIR" "$PROJECT/www"

for file in "js/eve-reliability-v158.js" "js/healthcheck.js"; do
  if [ ! -s "$PROJECT/www/$file" ]; then
    echo "错误：更新后缺少 $file"
    read -r -p "按 Enter 结束…"
    exit 1
  fi
done

cd "$PROJECT"
echo "正在同步 iOS 项目…"
npx cap sync ios

# 强制用完整 www 重建最终 App 资源，避免 Capacitor 漏复制嵌套文件。
rm -rf "$PROJECT/ios/App/App/public"
mkdir -p "$PROJECT/ios/App/App/public"
ditto "$PROJECT/www" "$PROJECT/ios/App/App/public"

for file in "js/eve-reliability-v158.js" "js/healthcheck.js" "js/stickers.js" "js/sticker-storage.js" "js/recall.js"; do
  if [ ! -s "$PROJECT/ios/App/App/public/$file" ]; then
    echo "错误：最终 App 资源缺少 $file"
    read -r -p "按 Enter 结束…"
    exit 1
  fi
done

echo "✓ v${VERSION} 已同步"
echo "✓ 表情包 JSON／占位文字会转换为图片或安全表情"
echo "✓ 表情包从保险库自动恢复"
echo "✓ 撤回提示不再显示原文"
echo "备份位置：$BACKUP"

if [ -d "$PROJECT/ios/App/App.xcworkspace" ]; then
  open "$PROJECT/ios/App/App.xcworkspace"
elif [ -d "$PROJECT/ios/App/App.xcodeproj" ]; then
  open "$PROJECT/ios/App/App.xcodeproj"
fi

read -r -p "Xcode 已打开。按 Enter 结束…"
