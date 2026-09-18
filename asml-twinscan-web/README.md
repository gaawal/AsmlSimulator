# ASML TwinScan Lab · Web

独立的 Three.js + Vite 网页光刻实验室。复用上级 Godot 项目的 Blender GLB 与 `parts_manifest.json`，以当前双台并行流程为依据移植为浏览器版本。原 Godot 工程和 Blender 母版不需要改动。

## 运行

Windows 双击 **start-web.cmd**。首次会安装锁定版本的 npm 依赖，然后打开浏览器。

也可以在此目录执行：

```powershell
npm ci
npm run dev
```

访问 `http://127.0.0.1:5173`。需要 Node.js 22.12+ 和支持 WebGL 2 的桌面浏览器。GLB、标识与脚本均随项目提供，运行时不请求 CDN 或外部账户。

```powershell
npm run build
npm run preview
```

生产文件输出到本项目的 `dist/`，预览地址 `http://127.0.0.1:4173`。将整个 `dist/` 放在任意静态 HTTP 服务下即可；不能直接双击 HTML 通过 `file://` 加载 GLB。

### 部署到 Vercel

本仓库只收录这个网页项目，但它位于仓库的 **`asml-twinscan-web/` 子目录**，所以导入 Vercel 时必须在项目设置里把 **Root Directory 指到 `asml-twinscan-web`**，否则 Vercel 在仓库根目录找不到 `package.json`，构建会直接失败。

| 配置项 | 取值 |
| --- | --- |
| Framework Preset | Vite |
| Root Directory | `asml-twinscan-web` |
| Build Command | `npm run build`（默认） |
| Output Directory | `dist`（默认） |
| Install Command | `npm ci`（默认 `npm install` 也可以） |
| Node.js Version | 22.x 或更高 |

`vite.config.js` 的 `base` 是 `'./'`（相对路径），因此在 Vercel 的任意域名 / 子路径下都能正常加载 GLB 与样式，无需额外配置。仓库根目录另有一个 `.gitignore` 白名单，只跟踪 `asml-twinscan-web/`。

## 操作与功能

| 功能 | 网页操作 |
|---|---|
| 芯片设计 | 刷新后直接进入光刻机界面；点击「开始光刻」时才弹出 16 张随机教学版图，选一张即开始批次 |
| 批量双台流水 | 设置 1–12 片，量测端下片、上片、预对准和调平量测，同时另一台曝光。启动顺序为「建立工作真空 → 双台归零校准 → 稳态流水」：工件台与干涉仪都在真空腔内工作，真空未到位时量测基准不稳定，所以先抽真空再归零 |
| 连续 / 单步 | 默认自动连续执行；开启单步后在动作边界暂停，保持 A/B 两端并行时钟 |
| 时间控制 | 开始、暂停、继续、重新开始、0.5×–4× 倍速；空格启动/暂停 |
| 三维交互 | 左键拖动旋转、右键/中键平移、滚轮缩放；悬停仅显示白色部件名，点击高亮 |
| 相机 | 正视、整机、光学、双台和机械手视角；可自动跟随当前工序；F 聚焦选择，Home 正视 |
| 场景开关 | 「白光/黄光环境」与「跟随特写」放在三维视图右上角，点按即切换（替代原来的常驻指示灯） |
| 画质 | 原生分辨率渲染 + 多重采样（MSAA，按硬件上限取 4× 或 8×）+ 收紧的 Bloom（只让高能量芯发光）；像素比拉满 2.0，阴影贴图 4096。界面不提供画质档位，恒定走这条最高画质路径 |
| 量测叠加层 | 两条路径，由模型清单切换：① 清单驱动（`education_metrology`，配合授权 Blender 硬件）—— 4 组固定干涉仪（双轴单回程、干涉相位模型）、4 面台侧平面镜、6 个角锥、6 组 PSD，光线只在真正落在移动镜面上时才绘制；② 几何叠加层（回退实现）—— 4 组固定干涉仪本体 + L 形长条平面镜 + 台底角锥（弦面朝下）+ 工位下方 PSD（感光窗朝上，检测光自下而上），X 轴接力全程无测量盲区、Z 轴工位全覆盖。两者共用掩模台光栅尺（标尺固定、读数头随滑台） |
| 环境 | 洁净厂房、工业材料与阴影，白光/黄光切换（开关在场景右上角）；曝光时默认紫色教学光路与持续轰击晶圆的粒子流；机壳上的 ASML 字样为蓝色文字，不用图片贴图 |
| HUD | A/B 工位、晶圆号、动作进度、流程链、同步状态、25 颗芯片电路图、节拍及事件 |
| 结果 | 已下片晶圆、25 颗芯片选择、目标/实际版图、模拟缺陷类型与批次统计；点击装载端口也可打开 |
| 结构查看 | 中文部件树、搜索、选择、聚焦、独立显隐、外壳开关、隔离、0–100% 爆炸展开和恢复 |

进入结构模式会暂停工艺。观察操作和模型变换不修改工艺数据。返回流程模式后点击继续即可恢复原批次。

## 资产与结构

- `public/assets/models/`：原 Blender 导出的 GLB 和 92 部件清单，保留部件层级及稳定 `part_id`。
- `public/assets/branding/`：用户提供的 ASML SVG。
- `public/assets/asset-provenance.json`：资源来源、文件大小和 SHA-256，验证复制未改变资产。
- `src/simulation/`：纯数据仿真和可复现随机设计，不依赖 Three.js 或 DOM。
- `src/scene/`：模型、观察变换、运动枢轴、光路及洁净室，只消费仿真快照。
- `src/ui/`：操作界面、设计选择、结果和部件树，通过命令接口操作仿真/场景。
- `tests/fixtures/godot-pipeline.json`：实际运行当前 Godot 版本生成的流程对照记录。

更新 Blender 资产后，从网页项目执行：

```powershell
npm run sync-assets
npm test
npm run build
```

同步脚本默认从上级原工程复制白名单资源，也可 `node tools/sync-assets.mjs D:/path/to/native-project` 指定来源。修改外观时保留部件 ID、父子关系与枢轴约定，不需要修改批次数据。

## 验证

```powershell
npm test
npm run test:browser
```

单元测试校验流程、帧率独立性、Godot 时序对照、资产哈希和层级（`npm test`，13 项）。浏览器端校验由上面的画质诊断工具承担：它们在真实 Chromium WebGL 页面上运行、输出可对比截图与量化指标。`playwright.config.js` 预留了 `tests/browser/` 目录用于交互回归，该目录尚未落地（`npm run test:browser` 会提示找不到测试）。Windows 已安装 Chrome 时优先复用；其他机器请先执行 `npx playwright install chromium`。

光效对比截图可用 `node tools/capture-scene.mjs <子目录> [标签]`（需 `npm run dev` 已启动）。

量测叠加层与光效的行为验证（同样需要 `npm run dev`）：

| 工具 | 用途 |
| --- | --- |
| `node tools/verify-metrology.mjs [步长] [总时长]` | 自动识别当前生效的量测实现并套用对应规则：清单驱动路径校验 4 组干涉仪命中率与归零标定；几何叠加层路径校验 X 轴全程无盲区、Z 轴仅换台滑移途中脱锁、归零时 PSD 命中角锥 |
| `node tools/probe-optics.mjs` | 校验刷新后不弹设计面板、点「开始光刻」才弹出；并推进到曝光阶段检查粒子流、命中反馈与页面报错 |
| `node tools/capture-metrology.mjs [标签]` | 归零校准态下的双台 / 掩模台 / 整机视角截图，输出到 `artifacts/metrology/` |
| `node tools/probe-bounds.mjs` | 打印关键部件的世界包围盒，用于给叠加层选址 |

画质管线的量化诊断（都在冻结场景下测「帧间差异」与「拉普拉斯清晰度」，都需要 `npm run dev`）：

| 工具 | 用途 |
| --- | --- |
| `node tools/analyze-render.mjs` | 逐档位测量帧间差异（画面是否在抖）与清晰度，并给出相对原生档的百分比 |
| `node tools/compare-quality.mjs` | 生成各档位 1:1 细节裁切图到 `artifacts/compare/`，用于肉眼对比清晰度 |
| `node tools/probe-gates.mjs` | 读取 TAA 内部判定（重投影是否越界、深度是否一致、历史帧权重）与历史帧缓冲稳定性 |
| `node tools/verify-presets.mjs` | 校验档位表与运行时状态一致 |

> 时间重建档位（`dlaa` / `quality` / `balanced` / `performance`）**不在界面上暴露**，仅作为内部诊断/压测入口保留，
> 由 `?qa=1` 下的 `window.__twinscan.action('renderMode', '<档位>')` 触发。生产路径恒为原生高画质（`off`）。

冻结场景（进入曝光后暂停仿真）后，原生高画质档位帧间差应为 0.000（无时间累积，天然不抖）；内部时间重建档位在 1% 以下，若明显升高说明重投影或历史帧裁剪出了问题。

验收详情见 [ACCEPTANCE.md](ACCEPTANCE.md)。`?qa=1` 是自动检查入口，额外提供可控时钟和只读快照诊断；普通入口没有跳时操作。

## 教学边界

这是一款非官方教学模拟器。用户提供的商标用于设备展示。内部布局、放大后的电路线条、紫色光束、运动幅度及秒级节拍均为示意。真实 EUV 不可见；此关卡展示光刻曝光与潜像，不宣称模拟显影、刻蚀设备或真实成品良率。网页使用 PBR、灯光与阴影，画质走原生分辨率渲染 + 多重采样，不做时间超分或时域抗锯齿。

网页与 Godot 的批次顺序、动作时长、台交换和晶圆归属使用相同规则。JavaScript 的随机生成器独立实现，种子在网页内可复现，同一个数字种子不会保证与 Godot 生成逐点相同的随机版图或缺陷。

技术参考：[Three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)、[OrbitControls](https://threejs.org/docs/pages/OrbitControls.html)、[Vite](https://vite.dev/guide/)。
