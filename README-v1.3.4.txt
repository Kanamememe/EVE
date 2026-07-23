EVE Chat v1.3.4 - 表情包持久化与动态图片上传修复
====================================================

基线：EVE Chat v1.3.2 network/CORS hotfix

修复 1：表情包导入成功后消失
- 新增 js/sticker-storage.js
- 使用独立 IndexedDB 保险库保存个人表情包
- 保存后重新读取验证，失败时不会显示假成功
- 原生 EVE 表情包数据库与保险库双向同步
- 页面重新打开、恢复前台或 bfcache 恢复时自动修复
- 浏览器支持时申请持久储存权限

修复 2：动态无法上传图片
- 新增 js/moment-image-upload.js
- 使用附着在 DOM 中的持久 file input，改善 iOS Safari 与 WKWebView 兼容性
- 一次最多选择 9 张图片
- 静态图片逐张解码并压缩为 WebP
- GIF 保持动图，单张最大 8MB
- HEIC/HEIF 无法解码时显示清楚提示
- 单张失败不会拖垮整批上传

App-ready
- 新增 js/app-runtime.js
- Capacitor 原生模式自动全屏
- 原生模式停用 Service Worker，避免网页缓存冲突
- 当前 ZIP 仍可直接部署到 GitHub Pages

部署网站版：
将全部文件覆盖到 EVE 仓库根目录，再使用：
https://kanamememe.github.io/EVE/?v=1.3.4
