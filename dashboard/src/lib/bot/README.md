# `bot` — vector morphing engine

Upstream: [bloub](https://github.com/jeremy-prt/bloub) by Jérémy Perret (MIT).
Vendored **unmodified** — see `THIRD_PARTY_NOTICES.md`. Comments are in French;
this file is the Chinese orientation guide so you don't have to read all 2900
lines to make a safe change.

## 为什么用它

宠物角色 `bot` 和菜单栏 `bot` 图标模式共用这一个引擎。它的价值在于**一份纯 TS
逻辑 + 声明式数据**，而不是我们原来 Clawd 的三套手工镜像渲染器
（SwiftUI `Canvas` / 内联 SVG + CSS keyframes / AppKit `NSBezierPath`）。

## 核心设计（读改动前必须知道的）

**一切形状都是同 64 个角度上采样的径向函数 r(θ)**（`PROFILE_SAMPLES = 64`，
`profiles.ts`）。于是任意两个形状的点天然一一对应，形变退化成半径的线性插值
——不需要任何 path morphing 库。这也是 macOS 端能只做插值播放、不必移植引擎
逻辑的原因（见下）。

```
Silhouette { radii[64], rot, cx, cy, sx, sy }   // shape.ts
  → blend(a, b, t)       64 次 lerp + 最短路径旋转
  → toPoints(s, scale)   极坐标 → 旋转 → squash → 平移
  → closedPath(pts)      Catmull-Rom → 三次贝塞尔 path 字符串
```

**`engine.sample(t)` 是纯函数** —— 无内部时钟、不调 `Date.now()`、不碰 DOM。
调用方负责推进时间。这是可测试性和可预渲染的前提，**不要在引擎里引入时间源**。

**眼睛是 `<mask>` 里挖的洞，不是叠在身体上的白色形状。** 所以眼球滑到边缘会被
silhouette 自动裁掉，零裁剪代码。代价：洞会透出身体后面画的东西（轨道环的后半
段、爆炸粒子），所以渲染时必须在身体下面垫一层同形状的 `paper` 底色。

**眼位补偿是构建期算好的查表**（`eyefit.ts`）。不要改成逐帧求解——上游注释说明
那会产生视觉抖动。

## 坐标系

`repere.ts`：`RAYON = 100`（静止球半径，工作单位），`DEMI_VIEWBOX = 158`
（viewBox 半边长，多出的余量给轨道环）。SVG viewBox = `-158 -158 316 316`。

## 状态

`states.ts` 的 15 个 `StateId`：`idle` `thinking` `wink` `wide` `alert`
`notify` `exclaim` `sleep` `egg` `hexagon` `play` `orbit` `burst` `comet`
`swirl`。我们的宠物状态 → StateId 的映射在 `../bot-appearance.js`（`SCENES`）。

`StateDef.pose(local)` **是真函数**（含条件、easing、三角函数），不是数据表。
所以 macOS 端**不能**把它导出成 JSON 直接翻译成 Swift。

## 造型是配置，不是硬编码

`skins.ts` 的 8 个形状（`cercle/galet/squircle/capsule/triangle/hexagone/
nuage/goutte`）、12 个颜色、`expressions.ts` 的 16 个表情都是普通数据表。
我们用自己的默认组合，见 `../bot-appearance.js`（形状/调色板/paper 都在那里）。

## 三端怎么消费

| 端 | 做法 |
|---|---|
| Web / Windows | 直接 `import`，实时 `sample(t)`，见 `ui/foundation/BotAnimated.jsx`（懒加载，不进 dashboard 主 chunk） |
| Linux | 无桌宠、无动画托盘（平台限制，见 `TokenTrackerLinux/src-tauri/src/tray.rs`）；Pet 设置页仍可预览 |
| macOS（宠物 + 菜单栏） | 构建期 `scripts/gen-bot-frames.cjs` 跑本引擎导出点序列 JSON，Swift 只做播放 + 64 点 lerp |

macOS 走预渲染是**刻意的**：手抄 `states`/`decor`/`face`/`expressions`/`eyefit`
约 1900 行逻辑会重造我们想消除的双份镜像。改了引擎或状态映射后**必须重跑生成
脚本**，否则 macOS 端会停在旧帧数据上。

## 升级上游

`dashboard/src/lib/bot/` 是未修改的 vendor 副本，请保持这一点——需要定制就在
外面包一层。上游有 94 个测试（`*.test.ts`），跑 `npx vitest run src/lib/bot`。
