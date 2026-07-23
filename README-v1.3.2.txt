EVEChat v1.3.2 网络请求修复版

本版本直接基于 v1.3.1 制作，不包含 v1.4 多模型路由。
主要用于修复 Gemini、DeepSeek、硅基流动等请求都被诊断为 network 的共享前端请求层问题。

部署：将压缩包内全部文件覆盖到 EVE 仓库根目录，之后使用 ?v=1.3.2 打开。

若修复后 Gemini 正常、但某个其他服务商仍显示 HTTP 0 / Failed to fetch，则该服务商可能不允许从 GitHub Pages 浏览器直接跨域调用，需要使用支持 CORS 的代理或日后 App 原生网络层。
