# 《CYBERPUNK MEGAPOLIS》部署启动可靠性修复 · plan.md

约束：不改玩法/视觉/角色/城市/物理/操作/画质策略/指针锁容错；扩展警告(contentscript/ObjectMultiplex/MaxListeners)不属于项目，不做处理。

## 修复项
1. **Input 内联**：Input 类原样并入 main.js，删除 `import './input.js?v=6'`；input.js 保留在磁盘但运行时不请求。
2. **HTML 启动兜底**：index.html 改为动态 `import('./main.js?v=7')`，catch → console.error 原始错误 + loadMsg + 显示 #err（标题"启动失败"，errMsg 含"请检查部署文件"+浏览器原始错误内容），绑定重试按钮 reload。杜绝静默卡 0%。
3. **缓存统一 v7**：index.html 动态 import、main.js 全部本地 import（player/controller/cameraRig/cityBoxes）、cameraRig→cityBoxes 全 v7；BUILD='2026-07-16v7'；grep 保证无 v6 残留。
4. **资源完整性审计**：重点 textures/CP_Plaster_N.webp 必须存在且 HTTP 200；按代码引用+materials.json+chars materials+webp 清单+vendor/draco/fonts 全量核对，缺失从参考站补齐；不删资源规避 404。
5. **容错保持**：单纹理失败不阻菜单（loadMgr.onError 已有）；角色失败只禁用对应卡片（v3 已有）；关键 JS/JSON/GLB 失败显示 URL+HTTP 状态；加载队列 finally 结束；保留 30s 防卡死但不掩盖模块失败（模块失败走 #err，loader 不再干等）。

## 验收（真实 HTTP + Playwright）
- 菜单可达；input.js 请求数=0；全模块 200；CP_Plaster_N.webp 200
- 模拟 main.js/player.js/scene.json 404 → #err 含具体错误，无静默卡死
- 两角色可选、man 可进游戏、HUD 持续更新；指针锁 reject 仅 toast
- 无项目自身未处理 rejection；zip 完整性（unzip -t + 零字节检查）

## 交付
cyberpunk-megapolis-v7.zip（完整目录）+ 中文 DEBUG_REPORT.md + website_version_manager 新版本链接
