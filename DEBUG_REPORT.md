# DEBUG_REPORT — Cyberpunk Megapolis 部署启动可靠性修复

## 一、根因分析

### 1. 页面永久停留在加载层（核心问题）
- **直接原因**：独立站部署后 `input.js` 返回 404。
- **放大机制**：`main.js` 通过**静态 `import`** 依赖 `input.js`。ES Module 规范下，模块图中任何一个静态依赖加载失败，整幅模块图会在 `main.js` 执行**之前**中止。项目自己编写的错误处理（`window error` / `unhandledrejection` 监听）也定义在 `main.js` 内，同样不会执行——于是加载层永远停在那里，没有任何可读提示。
- **缓存混用**：CDN 缓存下旧版 `main.js` 与新模块可能交叉引用（v6/v7 混用），进一步加剧模块图失败概率。
- **非项目因素**：`contentscript.js` 的 `MaxListenersExceededWarning`、`ObjectMultiplex orphaned data / malformed chunk` 均来自浏览器扩展（如 MetaMask 类注入脚本），与游戏代码无关，本次不做任何针对它们的修改。

### 2. 静态资源完整性疑虑
- 重点文件 `textures/CP_Plaster_N.webp` 经核对**真实存在**（119,854 字节，RIFF/WEBP 魔数校验通过），部署后返回 HTTP 200。该文件的 404 属于旧交付包上传不完整（只覆盖了 index.html / main.js，未整体上传目录），而非项目缺文件。

## 二、修改内容（仅 main.js / index.html，玩法与视觉零改动）

| # | 修改 | 说明 |
|---|---|---|
| 1 | **Input 类内联进 main.js** | 原样合并（键盘/鼠标/Pointer Lock/WASD/Space/Shift/E/R/T/H 行为逐行一致），删除对 `input.js` 的 import；`input.js` 作为源文件保留在项目中，运行时**零请求**。 |
| 2 | **HTML 启动兜底** | `index.html` 不再用 `<script type="module" src>`，改为动态 `import('./main.js?v=7')`。catch 中：`console.error` 原始错误、更新 `loadMsg`、显示项目现有 `#err` 错误层（标题"启动失败"，正文含"请检查部署文件" + 浏览器返回的原始错误内容）、绑定"重试"按钮 `location.reload()`。`#err` z-index 40 高于加载层 30，不会被遮挡。 |
| 3 | **缓存版本统一 v7** | `index.html` 动态 import、`main.js` 内全部本地模块（player/controller/cameraRig/cityBoxes）、`cameraRig.js → cityBoxes.js` 全部 `?v=7`；`BUILD = '2026-07-16v7'`；全项目 grep 确认无 v6 残留、无混合引用。 |
| 4 | **资源完整性全量审计** | 按代码引用 + `materials.json` + `chars/data/materials.json` + `textures_webp.json` 清单 + vendor/draco/fonts 全量核对：5 个 JS 模块、15 个 vendor 文件（含 addons 依赖闭包）、3 个 Draco 解码文件、9+2+10 个 GLB、9 个 JSON、245+56 张纹理、字体、环境图——**0 缺失、0 空文件、0 内容损坏**（WebP RIFF、GLB 魔数、WASM/WOFF2 魔数逐一校验）。未删除任何资源。 |
| 5 | **容错保持** | 单张非关键纹理失败 → `loadMgr.onError` 记录并跳过，不阻菜单；角色资源失败 → 仅禁用对应卡片（半透明+红字），另一角色正常进入，选失败角色有提示且不软锁；关键 JS/JSON/GLB 失败 → 错误层显示 URL + HTTP 状态码；`J()` 在 `finally` 中 `itemEnd`，队列永不卡死；30 秒防卡死保留——它只在模块成功执行后才调度，关键模块失败走 `#err`，不存在掩盖。 |

沿用上版保留的可靠性机制：`safeRequestPointerLock()`（指针锁失败仅 toast，phase 保持 play）、`unhandledrejection` 分级（进入游戏后只 toast 不覆盖）、H 操作表、触屏提示、高/中/低画质分级与自动降级、`?q / norender / frames / clean / noclutter` 测试参数。

## 三、测试结果（真实 HTTP 服务 + Playwright，非双击文件）

| 用例 | 结果 |
|---|---|
| 正常加载进入角色选择界面 | ✅ 菜单可达，5 个 v7 模块全部 200，0 个 HTTP≥400 |
| **Network 中 input.js 请求数** | ✅ **0** |
| **`textures/CP_Plaster_N.webp`** | ✅ HTTP 200，119,854 字节 |
| 页面不存在永久加载 | ✅ 加载层按真实 LoadingManager 进度淡出 |
| 模拟 `main.js` 404 | ✅ `#err` 显示"启动失败 / 请检查部署文件 / Failed to fetch dynamically imported module: …/main.js?v=7"（含浏览器原始错误），重试按钮已绑定 |
| 模拟静态依赖 `player.js` 404 | ✅ 同上走启动兜底错误层 |
| 模拟 `data/scene.json` 404 | ✅ 错误层显示 `加载失败: ./data/scene.json (HTTP 404)`（文件 + 状态码） |
| 两角色可选；man 正常进入 | ✅ girl 卡片可选中；man 高空俯冲→落地主街 |
| 进入游戏后 HUD 持续更新 | ✅ 速度表 0 → 31 km/h 随跑动变化 |
| Pointer Lock 被拒绝 | ✅ 仅显示"鼠标未锁定，点击游戏画面重试"非阻断 toast，游戏继续运行，无 `#err` |
| 项目自身未处理 Promise rejection | ✅ 0 条（`preventDefault` + 已捕获指针锁拒绝） |
| 扩展警告（contentscript/ObjectMultiplex/MaxListeners） | 已识别为浏览器扩展注入，**不计入项目错误**，未做处理 |
| 交付压缩包完整性 | ✅ `unzip -t` 无错误；包内 0 空文件、0 损坏文件 |

## 四、部署须知

1. **必须将 `cyberpunk-megapolis` 目录内的全部内容整体作为网站根目录上传**（含 glb/、textures/、chars/、vendor/、data/、fonts/ 全部子目录），不能只覆盖 index.html 和 main.js——旧站的 404 正源于此。
2. 本次交付使用全新版本参数 `?v=7` 与新 BUILD `2026-07-16v7`，并生成了**新的独立站版本链接**，不会命中旧 CDN 缓存。
3. 若仍见 `contentscript.js` / `ObjectMultiplex` 字样，请在无扩展的干净浏览器配置下复测——那些输出与站点无关。
