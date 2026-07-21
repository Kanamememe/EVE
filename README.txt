EVEChat v0.6 Stable
===================

這一版先完善現有核心，不新增社群等大型功能。

修正與加固：
- adapter.js 重寫為 v0.6.0
- 主動聊天預設不自動開啟，避免剛部署就自行發訊息
- Gemini fetch 支援字串 body 與 Request 物件
- 支援一般 JSON 與串流回覆解析
- 防止 Prompt 背景重複注入
- Prompt 背景設置最大長度，避免請求過大
- 使用者訊息事件去重，避免按鈕與 Enter 重複計算
- localStorage 失敗時不讓整個模組崩潰
- 統一目前聊天室 scope
- 新增 healthcheck.js 自動檢查核心模組

部署：
將整個資料夾內容上傳到 GitHub Pages，必須保留 js 資料夾。

Console 測試：
EVEHealth.print()
EVEAdapter.getDiagnostics()
EVEMemory.getStats()
EVETimeline.getStats()
EVERelationship.getStats()

主動聊天預設關閉。確認普通聊天正常後再開啟：
EVEAdapter.configure({ autoEnableProactive: true })

關閉：
EVEAdapter.configure({ autoEnableProactive: false })
