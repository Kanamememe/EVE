#!/bin/bash
set -euo pipefail

VERSION="1.5.7"
REPO_RAW="https://raw.githubusercontent.com/Kanamememe/EVE/main"

# Packaged for direct download in ChatGPT.
echo "EVE 日记系统 v${VERSION} 更新工具"
echo "此脚本只更新日记自然写作模块，不改动聊天、行程、角色贴合或其他功能。"

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
BACKUP="$PROJECT/backups/diary-before-v${VERSION}-$STAMP"
mkdir -p "$BACKUP/js" "$BACKUP/plugins/diary"

for file in \
  "www/js/diary-humanizer.js" \
  "www/js/diary-humanizer-ui.js" \
  "www/plugins/diary/core.js"; do
  if [ -f "$PROJECT/$file" ]; then
    mkdir -p "$BACKUP/$(dirname "${file#www/}")"
    cp "$PROJECT/$file" "$BACKUP/${file#www/}"
  fi
done

mkdir -p "$PROJECT/www/js" "$PROJECT/www/plugins/diary"

echo "正在下载日记自然写作模块…"
curl -fL --retry 3 "$REPO_RAW/js/diary-humanizer.js?v=$VERSION" -o "$PROJECT/www/js/diary-humanizer.js"
curl -fL --retry 3 "$REPO_RAW/js/diary-humanizer-ui.js?v=$VERSION" -o "$PROJECT/www/js/diary-humanizer-ui.js"
curl -fL --retry 3 "$REPO_RAW/plugins/diary/core.js?v=$VERSION" -o "$PROJECT/www/plugins/diary/core.js"

for file in \
  "$PROJECT/www/js/diary-humanizer.js" \
  "$PROJECT/www/js/diary-humanizer-ui.js" \
  "$PROJECT/www/plugins/diary/core.js"; do
  if [ ! -s "$file" ]; then
    echo "错误：文件下载失败：$file"
    read -r -p "按 Enter 结束…"
    exit 1
  fi
done

cd "$PROJECT"
echo "正在同步 iOS 原生项目…"
npx cap sync ios

# Capacitor 某些环境可能漏复制嵌套插件，强制用完整 www 重建最终 public。
rm -rf "$PROJECT/ios/App/App/public"
mkdir -p "$PROJECT/ios/App/App/public"
ditto "$PROJECT/www" "$PROJECT/ios/App/App/public"

for file in \
  "js/diary-humanizer.js" \
  "js/diary-humanizer-ui.js" \
  "plugins/diary/core.js"; do
  if [ ! -s "$PROJECT/ios/App/App/public/$file" ]; then
    echo "错误：最终 App 资源缺少 $file"
    read -r -p "按 Enter 结束…"
    exit 1
  fi
done

echo "✓ 日记 v${VERSION} 已更新"
echo "备份位置：$BACKUP"

if [ -d "$PROJECT/ios/App/App.xcworkspace" ]; then
  open "$PROJECT/ios/App/App.xcworkspace"
elif [ -d "$PROJECT/ios/App/App.xcodeproj" ]; then
  open "$PROJECT/ios/App/App.xcodeproj"
fi

read -r -p "Xcode 已打开。按 Enter 结束…"
