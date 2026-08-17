# HSHH-robot · Brand Spec
> Captured: 2026-08-14
> Source: <https://www.hshhrobotie.space>, repository expression assets, README, and PRD
> Completeness: partial; live web identity exists, physical product photography is still missing

## Core assets

### Logo
- Live identity: CSS-rendered two-part mark plus `Robotie` wordmark, taken directly from the user-provided site header.
- Companion App treatment: the same mark and wordmark, followed by the descriptor `COMPANION APP`.
- No standalone SVG/PNG logo exists in the repository; export an official SVG before print or third-party distribution.

### Product photography
- No robot render or prototype photograph exists in `hardware/photos/`.
- The interface does not invent a hardware silhouette. It uses the real device expression screen assets as the product anchor.

### UI and expression assets
- Expression source: `assets/expressions/<state>/<state>_01.png` through `_05.png`.
- Coverage: 9 states × 5 frames, 332 × 252 RGBA PNG.
- Intended uses: live device-face preview, expression picker, and interaction-state feedback.
- Existing asset quality: repository-authored, current for PRD v0.4, clean RGBA files; suitable for screen-scale use but not for large-format print.

## Auxiliary assets

### Color palette
- Screen cyan: `#8AF8FF` (sampled from the repository expression PNGs).
- Screen ink: `#0B2528` (sampled from the idle expression background range).
- App paper: `#F5F0E6` (live Robotie CSS).
- App ink: `#242624` (live Robotie CSS).
- Muted ink: `#686B66` (live Robotie CSS).
- Warm accent: `#A96550` (live Robotie CSS).
- Soft yellow: `#F2DDA0` (live Robotie CSS).
- Soft lilac: `#D8CBE6` (live Robotie CSS).
- Interface line: `#D8D0C0` (live Robotie CSS).

### Typography
- Display: native Apple product stack / PingFang SC, strong weights, matching the live Robotie hero.
- Body: Satoshi / Noto Sans SC / PingFang SC.
- Data labels: SFMono-Regular / Menlo.

### Vibe keywords
- 温暖但不黏人
- 有生命感
- 先征得同意
- 实体安全可信
- 轻微顽皮

## Completeness notes
- Missing: standalone exportable logo file, physical prototype photography, and an existing app design system.
- Existing web identity is treated as the marketing facet; this deliverable extends it into a companion-app facet without changing the live site.
- Fallback: use the actual expression frames, official live wordmark treatment, and a clearly labeled front-end prototype. No fake robot render or fake generated pet result is presented as production output.
