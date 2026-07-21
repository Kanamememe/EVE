EVE Chat v0.2 - Adapter Build
=============================

本版本完成：
- weather.js
- proactive.js
- adapter.js v0.2
- Adapter Map
- index.html 保持原 UI 與核心程式不變

部署：
將整個 EVEChat-v0.2 資料夾內容上傳到 GitHub Pages 專案根目錄。
必須保留 js 資料夾與三個 JS 檔案。

快速檢查：
在瀏覽器 Console 輸入：
  EVEAdapter.getDiagnostics()

手動測試主動訊息：
  EVEAdapter.triggerProactiveNow()

注意：
主動訊息需要先開啟一個角色聊天室，並完成 Gemini API 設定。
