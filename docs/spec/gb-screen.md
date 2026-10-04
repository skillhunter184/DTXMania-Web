# gb-screen

# Guitar/bass performance screen: layout and drawing (NX GuitarScreen and DTXManiaAI GR mode)

**Sources and abbreviations.** NX paths are relative to `DTXmaniaNX/DTXMania/Code/`. DTXManiaAI paths are relative to `DTXManiaAI/Assets/Scripts/`.

**NX**
- `GS` = `Stage/07.Performance/GuitarScreen/CStagePerfGuitarScreen.cs`
- `PC` = `Stage/07.Performance/CStagePerfCommonScreen.cs`
- `LF` = `…/GuitarScreen/CActPerfGuitarLaneFlushGB.cs`; `LFC` = `…/CActPerfCommonLaneFlushGB.cs`
- `RGB` = `…/GuitarScreen/CActPerfGuitarRGB.cs`; `RGBC` = `…/CActPerfCommonRGB.cs`
- `CF` = `…/GuitarScreen/CActPerfGuitarChipFire.cs`; `CFC` = `…/CActPerfChipFireGB.cs`
- `WB` = `…/GuitarScreen/CActPerfGuitarWailingBonus.cs`; `WBC` = `…/CActPerfCommonWailingBonus.cs`
- `JS` = `…/GuitarScreen/CActPerfGuitarJudgementString.cs`; `JSC` = `…/CActPerfCommonJudgementString.cs`
- `CB` = `…/GuitarScreen/CActPerfGuitarCombo.cs`; `CBC` = `…/CActPerfCommonCombo.cs`
- `SC` = `…/GuitarScreen/CActPerfGuitarScore.cs`; `SCC` = `…/CActPerfCommonScore.cs`
- `GA` = `…/GuitarScreen/CActPerfGuitarGauge.cs`; `GAC` = `…/CActPerfCommonGauge.cs`
- `DA` = `…/GuitarScreen/CActPerfGuitarDanger.cs`; `BO` = `…/GuitarScreen/CActPerfGuitarBonus.cs`
- `CH` = `Score,Song/CChip.cs`; `SS` = `Stage/07.Performance/CActPerfScrollSpeed.cs`; `CL` = `Stage/04.Config/CActConfigList.cs`; `CI` = `App/CConfigIni.cs`; `APP` = `App/CDTXMania.cs`
- `CTexture` = `DTXmaniaNX/FDK/Code/04.Graphics/CTexture.cs`; `CCounter` = `DTXmaniaNX/FDK/Code/00.Common/CCounter.cs`
- "Skin" = `DTXmaniaNX/Runtime/System/Graphics/`. Image sizes and pixel colours below were measured from these files.

**DTXManiaAI**
- `GPS` = `Stages/GuitarPerformanceStage.cs`
- `NGL` = `Stages/NxGuitarLayout.cs`
- `NSL` = `Skin/NxStageLayouts.Guitar.cs`
- `AIdoc20` = `DTXManiaAI/docs/20_guitar-bass-mode.md`

**Units.** All NX coordinates are 720p. Values in **[brackets]** are the 1080p values DTXManiaAI uses (`S = 1.5`, NGL:13,19). `d` = `nDistanceFromBar[part]`, the 720p px distance of a chip from the bar (≥0 means the chip is in the future).

**Markers.** **[NX-only]** NX behaviour DTXManiaAI does not reproduce. **[AI-CHG]** / **[AI-ADD]** DTXManiaAI changed / added something. **[QUIRK]** an NX bug; do not port. **PROPOSAL** not spec. **[FIX]** corrected from the draft, **[ADD]** added by verification.

**Licensing.** All NX skin images are third-party art, listed only for geometry. The web app must synthesize its own (CLAUDE.md).

**[ADD] When the guitar screen is used at all.** NX uses `CStagePerfGuitarScreen` only when `bGuitarRevolutionMode = !bDrumsEnabled && bGuitarEnabled` (CI:895-899; APP:1164-1200). So on this screen `bDrumsEnabled == false` always. This matters for §4.6.

---

## 0. Screen model

### 0.1 What NX draws and in which order
- One screen shows **guitar on the left and bass on the right at the same time**. Each part's panel, frames, hit-bar, gauge and score are drawn only if the chart has chips for that part (`bチップがある[part]`; LF:45-58, RGB:105,152, GS:461,471, GA:82,112, SC:83). **[ADD]** The flush/string (LF:62-128) and the "+100" bonus (BO:65-68) are not gated directly. They only start from input handling, which returns early when the part has no chips (PC:4877-4880).
- Drum chips are not drawn. They are auto-played when they cross the bar (GS:552-560).
- Draw order, from `GS:OnUpdateAndDraw` (GS:180-216):
  1. background (GS:180). **[FIX]** Priority is `#BACKGROUND_GR` > `#BACKGROUND` > default `7_background_Guitar.jpg` (GS:523-542). The default file is absent from the default skin.
  2. AVI (GS:181), then MIDI BGM (no drawing, GS:182)
  3. **LaneFlushGB**: lane panel, then flush, then lane string (GS:187)
  4. DANGER (GS:189)
  5. **WailingBonus** pillar (GS:191)
  6. ScrollSpeed smoothing (GS:192)
  7. chip-animation counters (GS:193)
  8. **BarLines** (GS:194)
  9. LoopLines (GS:195)
  10. **Chips** (GS:196)
  11. **RGB frames / shutters** (GS:197)
  12. **hit-bar** (judge line, GS:198)
  13. **JudgementString** (GS:199)
  14. ProgressBar (GS:200)
  15. Gauge (GS:201)
  16. StatusPanel, only if `nInfoType==1` (GS:202-203)
  17. Score, only if `bShowScore` (GS:204-205)
  18. Graph (GS:207)
  19. **Combo** (GS:208)
  20. PerfInfo (GS:209)
  21. PlaySpeed (GS:211)
  22. **ChipFire** (GS:213)
  23. **Bonus100** (GS:214)
  24. STAGE FAILED (GS:215)
  25. fades (GS:216)
- `tUpdateAndDraw_WailingFrame` is commented out (GS:210), so `ScreenPlay wailing cursor.png` is never drawn.
- **Layering consequences.** [FIX] The draft said the judge string sits over everything; it does not.
  - Flush, string, wailing pillar and bar lines sit **under** the chips.
  - The RGB frames and the hit-bar sit **over** the chips.
  - The judge string is drawn over chips, frames and hit-bar, but **under** the progress bar, gauge, status panel, score, graph and combo.
  - Fire and "+100" are drawn last.

### 0.2 Skin images (measured)

| File | Size | Use / measured content |
|---|---|---|
| `7_Paret_guitar.png` (code: `7_Paret_Guitar.png`, LF:24) | 277×678 | Lane panel. Opaque only at x 19..264, rows 0..633. Rows 0..61 are plain black; rows 62..633 hold the lanes. Rows 634..677 are transparent **[ADD]** |
| `7_Paret_Guitar_Dark.png` (LF:25) | 277×678 | Dark panel: solid black at x 13..264, all rows, no separators |
| `7_Chips_Guitar.png` (GS:110) | 196×90 | Chips (§3.1) |
| `7_RGB buttons.png` (RGBC:56) | 277×178 | Top/bottom frames (§4.1) |
| `7_guitar line.png` (LF:26) | 197×566 | Lane "string" glow (§4.2) |
| `ScreenPlay lane flush {red,green,blue,yellow,purple}[ reverse].png` (LFC:58-68) | 37×256 | Flush (§4.2) |
| `ScreenPlay chip fire {red,green,blue,yellow,purple}.png` (CFC:59-83) | 80×80 | Fire |
| `ScreenPlayDrums hit-bar.png` (GS:112) | 8×8 | Judge line. The draw rect is wider than the image, so it repeats horizontally (§1.3) |
| `ScreenPlay wailing bonus.png` (WBC:41) | 52×122 | Wailing pillar |
| `7_judge strings.png` (PC:480) | 1500×4080 | 6 cols × 24 rows of 250×170. Row 23 is empty in all columns except Good **[ADD]** |
| `ScreenPlayGuitar combo.png` | 450×294 | Combo digits and label |
| `7_score numbersGD.png` | 360×78 | Score digits and label |
| `7_Gauge_Guitar.png` / `7_Gauge_Bass.png` | 290×136 | Gauge frames. The back layer (rows 0..67) is **fully opaque** **[ADD]** |
| `7_gauge_bar.png` / `7_gauge_bar.jpg` | 480×31 / 504×31 | Gauge bar / full bar |
| `7_Bonus_100.png` | 117×88 | LN hold bonus |
| `7_shutter_GB.png` | 252×720 | Shutter |
| `7_panel_icons.jpg` (code `7_Panel_icons.jpg`, GA:48) | 42×1008 | HS icon, 21 rows of 48 |

- These files are **absent from the default skin**, so their draw calls are skipped:
  - `7_background_Guitar.jpg`
  - `7_WailingFlush.png`, `7_WailingFire.png` (WBC:42-43)
  - `ScreenPlayGuitar danger.png` (DA:17)
  - **[ADD]** `7_lanes_Guitar.png`. It is loaded into `GS.txLane` (GS:111), which is never drawn anyway.

---

## 1. Lane geometry

### 1.1 Panel, lanes, x positions

| Element | Guitar 720p | Bass 720p | Guitar [×1.5] | Bass [×1.5] | Source |
|---|---|---|---|---|---|
| Lane panel 277×678 | (67,42) | (937,42) | (100.5,63) 415.5×1017 | (1405.5,63) | LF:48,55 |
| Lane separators, 2 px, rgb(63,61,59) | x = 86,125,164,203,242,281 | 956,995,1034,1073,1112,1151 | 129,187.5,246,304.5,363,421.5 | 1434,1492.5,1551,1609.5,1668,1726.5 | measured |
| Lane centre guide, 1 px, rgb(30,30,30) on black, with a 0..10 grey gradient either side | 107,146,185,224,263 | 977,1016,1055,1094,1133 | 160.5,219,277.5,336,394.5 | 1465.5,1524,1582.5,1641,1699.5 | measured |
| Lane interior (opaque black) | y [104,676) | same | y [156,1014) | same | measured |
| Panel top band, plain black, no separators **[ADD]** | y [42,104) | same | [63,156) | same | measured |
| Wailing column (black, no separators) | x [283,325) | [1153,1195) | [424.5,487.5) | [1729.5,1792.5) | measured; WB:113 comment "XG wailing lane 42 px" |
| Chip left x R,G,B,Y,P; sheet cell 38×10 | 88,127,166,205,244 | 959,998,**1036**,1076,1115 | 132,190.5,249,307.5,366 (57×15) | 1438.5,1497,1554,1614,1672.5 | PC:4219-4225 |
| OPEN bar 196×10 | x 88 | 959 | 132 (294×15) | 1438.5 | PC:4201-4202 |
| Bar line 193×2 | x 88 | 959 | 132 (289.5×3) | 1438.5 | GS:969,983 |
| Wailing chip 54×68 | x 287 | 1155 | 430.5 (81×102) | 1732.5 | GS:703,900 |
| Hit-bar 252×6 | x 80 | 950 | 120 (378×9) | 1425 | GS:466,476 |
| Chip-fire centre x | 107,146,185,224,**264** | 978,1017,1056,1095,1134 | 160.5,219,277.5,336,396 | 1467,1525.5,1584,1642.5,1701 | CF:46 |

Notes:
- **Lane pitch.** [FIX] The lane pitch is 39 px: a 2-px separator plus a 37-px interior [58.5].
  - Each chip-sheet cell is 38 px wide, but **its last column (x = 38i+37) is fully transparent** (measured). The visible chip is 37 px.
  - Each chip therefore exactly fills its lane interior: R covers 88..124, between separators 86..87 and 125..126. There is **no overlap** with the next separator.
- **[ADD]** The lane centre is 106 (centre pixel of 88..124). The centre guide, string core and fire centre are at 107, 1 px right of it. The guitar P fire centre is 264, but its guide is at 263 (CF:46) **[QUIRK]**.
- **Horizontal extents:**
  - Bar line: 88..280, the 5 lanes.
  - Hit-bar: 80..331, the lanes plus the wailing column.
  - The panel's right decorative edge is at panel x 258..264, i.e. screen 325..331.
- **[QUIRK] Bass offsets are irregular.** [FIX] The bass panel, separators, wailing column, hit-bar (950) and pillar (1163) are guitar **+870**. Relative to that, the other bass elements are shifted:
  - Chips R,G,Y,P, OPEN and bar line: +871. Chip B (1036, PC:4222): +870.
  - Flush base 958 (LF:70): +870.
  - Strings 957,995,1034,1073,1112 (LF:111-127): +871 for R, +870 for G..P.
  - Fire centres: +871, except P (+870).
  - Wailing chip 1155 (GS:900): +868.
  - **Use the guitar geometry when only one part is shown.**
- **LEFT** (`bLeft`, default false, CI:1391) mirrors:
  - the chip x array (PC:4227-4235)
  - the flush offsets (LF:68,139)
  - the string x values; B stays at 164 (LF:91-127)
  - the fire centres (CF:30-33)
  - the top frame, which switches to its LEFT row (RGB:129,176)
  - the bass strings too (957..1112 swapped, B stays at 1034; LF:111-127)
  - OPEN, wailing and the bar line are not mirrored. **[ADD]** Neither are the lane panel (so the wailing column stays at the right, next to R), the hit-bar, the bottom frame, the shutters and the judge string.
  - **[ADD]** Drawing only: input, judging, AUTO and key assignment never read bLeft (PCS:5308-5455). The option is `GuitarLeft` / `BassLeft` in [PlayOption] (CI:2027-2049), CONFIG "Left" (CL:1266-1269, 1476-1479).
  - **[NX-only]** DTXManiaAI fixes `Left=false` (GPS:439).

### 1.2 3-lane vs 5-lane charts
- NX has **no 3-lane runtime layout**. The 5-lane panel and positions are always used. A 3-lane chart (channels 0x20..0x27 only) leaves the Y and P lanes empty.
- `bチップがある.YPGuitar/YPBass` (`Score,Song/CDTX.cs:6741,6768`) only feeds the CLASSIC level display, under `nSkillMode==0 || (bCLASSIC譜面判別を有効にする && !YP && !b強制的にXG譜面にする)` (`…/GuitarScreen/CActPerfGuitarStatusPanel.cs:376-378`). It does not affect drawing.
- The legacy 3-lane drawing code (x 26/480, 32×8 chips, judge y 40) is compiled out with `#if false` (GS:566-677, 783-874).
- DTXManiaAI behaves the same (AIdoc20:135-136).
- The test pack's guitar and bass MASTER charts use Y/P, OPEN, wailing and LN, so all of §3 is needed.

### 1.3 Judge line and scroll direction

```
nJudgeLine ∈ [0,100] (nRoundToRange), default 0         // CI:3346, CI:1262
JL(normal)  = 154 + nJudgeLine      [231]               // PC:348-349
JL(reverse) = 611 − nJudgeLine      [916.5]
chip centre yc = normal ? (JL+1) + d : (JL+1) − d       // GS:564 (barYNormal = barYReverse = JL+1), PC:4173-4174
hit-bar top   = normal ? JL − 1 + Δ : JL + Δ            // GS:463,473; drawn at x 80/950, rect (0,0,252,6), GS:466,476
Δ = JudgeLinePosOffset ∈ [−99,99], default 0           // CI:3103-3111, PC:364-366; moves ONLY the drawn hit-bar
```

- **Direction.**
  - Default (`bReverse=false`, CI:1387): the judge line is at the **top** (y 154) and chips **rise from the bottom**, GuitarFreaks style.
  - REVERSE: the judge line is at y 611 and chips fall from the top.
  - DTXManiaAI describes the direction the same way (NGL:10-11).
- **Alignment.** These use half-open pixel spans.
  - Normal mode at d=0: the chip spans [150,160), centre 155 [232.5]. The hit-bar spans [153,159), centre 156. They are 1 px apart.
  - **[ADD]** Reverse mode: the chip centre is 612 and the hit-bar spans [611,617), centre 614. They are 2 px apart.
- The hit-bar is drawn only if `bGuitarEnabled`, the part has chips, the texture exists, and `bJudgeLineDisp` is on (default on, CI:1317) (GS:459-466).
- **Hit-bar pixels.** The 8×8 image is drawn with a 252×6 rect. U = rect/textureSize (`CTexture`:410-413), so the image tiles under the default wrap addressing.
  - Rows 0..5 ≈ (255,255,229), (255,255,96), (255,255,45), (255,255,43), (255,255,22), (≈233,≈251,0): a yellow line, brightest at the top.
- With performance info on, the `nJudgeLine` value is printed at (y−20) in normal mode or (y+8) in reverse. x is 310 for guitar (GS:468-469) and **[ADD] 1180 for bass** (GS:478-479).
- The guitar screen ignores in-game judge-line moves: `tJudgeLineMovingUpandDown` is empty (GS:504-507).

### 1.4 Where chips appear and disappear
- **Processing horizon.** The chip loop stops at the first chip with `min(dDrums, dGuitar, dBass) > 600` (PC:2882-2885).
  - Chips are time-ordered and min ≤ dG, so every guitar chip with dG ≤ 600 is always processed.
  - That is 6713/HS ms at guitar speed.
- **No y clip on chips.** `showRangeY0=104` and `showRangeY1=670` are passed (GS:564), but the range check is commented out (PC:4193).
- **Visible window.** [FIX] The covers are measured from the images and drawn after the chips (§0.1):
  - **Gauge back layer:** opaque 290×68 at (80|950, 0) (GA:84,114). It covers y 0..67, x 80..369 | 950..1239.
  - **Top RGB frame:** only rows 26..61 of its 64-row rect are non-transparent. It covers y **68..103**, x 80..289 | 950..1159.
  - **Bottom RGB frame:** covers y 670..719, x 80..331 | 950..1201.
  - So the effective lane window is **y [104,670) [156,1005)** in both directions.
  - Normal mode: a chip starts to show at d ≤ 519 and is fully visible at d ≤ 510.
  - Reverse mode: a chip enters the panel area at the processing horizon (y ≈ 12), but stays hidden under the gauge and frame. It starts to show at d ≤ 512 and is fully visible at d ≤ 503.
- **Hit chips** vanish because drawing requires `!bHit || isLN` (PC:4171).
- **Missed chips** keep moving past the line until `e指定時刻からChipのJUDGEを返す == Miss`, i.e. beyond the Poor window. That check runs before the draw dispatch, so a chip is marked hit as a Miss and is not drawn in that frame (PC:2914-2918).
  - Guitar/bass use `stGuitarHitRanges` / `stBassHitRanges` (PC:1007-1008). The default Poor window is 117 ms (CI:1440 → `App/STHitRanges.cs:48`).
  - At HS x1.0 the overrun is ≈10.5 px [15.7].
- LN bodies: §3.4. Wailing chips: §3.5.

### 1.5 Display options that change the lanes
- **`nLaneDisp`**, default 0 (CI:1308-1310); option names CL:1200-1207. Applied at LF:47-50, GS:966,980, GS:1014,1027. The ini parser accepts 0..4 (CI:3456).
  - 0 = ALL ON: panel and bar lines
  - 1 = LANE OFF: dark panel, bar lines kept
  - 2 = LINE OFF: panel, no bar lines
  - 3 = ALL OFF
- **Shutters** (`ShutterIn` 0..100, `ShutterOut` −100..100; CI:3350-3354):
  - Bottom shutter top-left y = 720 − 50 − n·6.14.
  - Top shutter top-left y = 108 − shutterImageHeight(720) + n·6.14.
  - Reverse swaps In and Out (RGB:78-100). Drawn at x 80/950 (RGB:136,143,183,190).
  - A non-zero shutter replaces the corresponding frame (RGB:125-129,172-176).
  - **[ADD]** The shutter variables are refreshed only while `7_shutter_GB.png` is loaded (RGB:76).
  - **[QUIRK]** The `BassShutterOut` parse uses the guitar value as its fallback (CI:3366).
- **HID-SUD** (`nHidSud`: 0 OFF, 1 Hidden, 2 Sudden, 3 HidSud, 4 Stealth; UI CL:1177-1186; the ini accepts 0..5, CI:3278). Processed in PC:3800-3844. Distances are guitar d in 720p px (×1.5 for 1080p d):
  - Sudden (2,3):
    - d < 250 → visible, α255
    - 250 ≤ d < 300 → α = 255 − (d−250)·255/75
    - d ≥ 300 → invisible, α0
  - Hidden (1,3):
    - d < 150 → invisible
    - 150 ≤ d < 200 → α = (d−150)·255/75
    - d ≥ 200 → α not touched (`CChip.nTransparency` defaults to 255, CH:23)
  - **[ADD][QUIRK]** Both ramps divide by 75 over a 50-px band, so they are discontinuous:
    - Sudden fades in from α85 to 255 (a jump from 0 to 85 at d=300).
    - Hidden fades from α170 to 0 (a jump to 170 at d=200).
  - Stealth: always invisible.
  - [FIX] The alpha applies to lane chip heads (PC:4265) **and to the OPEN bar**: PC:3842 sets `txChip.nTransparency` at function entry, and the OPEN draw does not override it. LN bodies use a fixed 128/64 (§3.4).
  - **[ADD]** Wailing chips get the same HidSud logic in the base method (PC:4540-4583). It runs **after** GS has already drawn the chip, so the wailing chip uses the previous frame's `bVisible`.
- **[NX-only]** DTXManiaAI fixes LaneDisp, shutters, HidSud and LaneFlush to their defaults (GPS:437-445). The code paths exist but are unreachable.

---

## 2. Scroll speed

```
const speed = 286                                                       // CH:577
ScrollSpeedDrums  = (raw + 1.0) * 0.5       * 37.5 * speed / 60000      // CH:579
ScrollSpeedGuitar = (raw + 1.0) * 0.5 * 0.5 * 37.5 * speed / 60000      // CH:580 (Bass identical, CH:581)
d = (int)((chip.nPlaybackTimeMs − now) * ScrollSpeedGuitar)             // CH:584, truncation toward 0; LN end chip too (CH:588-591)
displayed HS = (raw + 1) * 0.5      (same for D/G/B)                     // CL:2772-2776
raw = nScrollSpeed ∈ [0,1999], default 1 → x1.0                          // CI:3302, CI:1393
⇒ guitar/bass px/ms = HS × 0.089375 (720p) = HS × 0.1340625 [1080p]
  drums           px/ms = HS × 0.17875  (720p) = HS × 0.268125  [1080p]
```

- **At the same HS setting, guitar and bass scroll at half the drum speed** (one extra ×0.5).
- **Visible look-ahead** in normal mode (chip centre 155 to bottom frame 670 = 515 px) is 5762/HS ms:

  | HS | Look-ahead |
  |---|---|
  | x1.0 | 5762 ms |
  | x2.0 | 2881 ms |
  | x3.0 | 1921 ms |
  | x4.0 | 1441 ms |
  | x5.0 | 1152 ms |

- **Smoothing.** The current raw value starts at `nScrollSpeed` (SS:29). Every 2 ms it moves ±0.012 raw toward the target (SS:44-75): 6 raw/s = 3.0 HS/s.
  - **[ADD][QUIRK]** The direction test compares the *previous settled target* `db譜面スクロール速度` with the new target, not the current value (SS:53,63). That variable updates only when a ramp completes (SS:57-60, 67-70).
  - Example: change the target and change it back to the old value mid-ramp. Neither branch fires, so the current speed freezes mid-ramp until the next change.
  - Do not port this. Ramp the current value toward the target.
- **In-game change:**
  - Pad: Decide+B adds +1 and Decide+R adds −1, per part, clamped to 0..1999 (PC:4867-4874).
  - Keyboard ↑/↓ (PC:2381-2388) call `ScrollSpeedUp/Down`. **[ADD][QUIRK]** These change only `nScrollSpeed.Guitar`, even for bass (GS:509-516).
- **Loop lines** use the same formula, computed inline from the smoothed speed (GS:999-1004).
- **Web equivalent** of `SCROLL_BASE_PX_PER_MS = 37.5*286/60000*1.5` (js/game/player.js:28):

  ```
  GB_SCROLL_BASE_PX_PER_MS = 37.5 * 286 / 60000 * 0.5 * 1.5 = 0.1340625 px/ms (1080p, HS x1.0) = SCROLL_BASE_PX_PER_MS / 2
  ```

- **[AI-CHG] DTXManiaAI speed.** It uses `BasePixelsPerMs = 0.45*0.5*S = 0.3375` (GPS:48) and `PixelsPerMs = Base·(scroll·0.5)`, with scroll = NX raw+1, default 2 (GPS:425-426; Config/ConfigIni.cs:108-110).
  - That is 0.3375·HS px/ms [1080p], **2.52× NX**. This is the same error the web app already fixed for drums (docs/architecture.md:24).
  - It is computed once, with no smoothing and no in-play change in GR mode (AIdoc20:123-124).

---

## 3. Chip appearance

### 3.1 Sprite sheet `7_Chips_Guitar.png` (196×90)

| Rect | Content | Code |
|---|---|---|
| (38i, 0, 38, 10), i = 0..4 | R red, G green, B cyan-blue, Y yellow/orange, P pink. Bright gradient bars with dark top/bottom rows, e.g. R row 8 = rgb(126,83,84). **[ADD]** Column 37 of each cell is transparent, so the visible chip is 37×10 | PC:4237-4243 |
| (38i, 3, 38, 5) | LN body slice (chip rows 3..7) | PC:4271-4273 |
| (0, 10, 196, 10) | OPEN: magenta bar with white "OPEN" lettering. **[ADD]** Row 0 of the rect (sheet y 10) is transparent, so the visible bar is 9 rows | PC:4202 |
| (0, 20, 193, 2) | Bar line: row 0 rgb(169,169,169), row 1 rgb(116,115,115) | GS:969 |
| (0, 22, 54, 68) | Wailing: green up-arrow plus a guitar silhouette (content at x 2..52, y 2..66 inside the cell) | GS:699-702,713 |
| (54..195, 22..89) | Opaque white filler, never drawn **[ADD]** | — |

- **No animation.** `ctChipPatternAnimation` (0..23 at 20 ms) and `ctWailingChipPatternAnimation` (0..4 at 50 ms) are created (GS:143-147) and ticked (PC:4629-4641). Their values are read into unused locals (PC:4197; GS:712).
- **Draw call.** `tDraw2D` scales from the top-left draw origin (`CTexture`:422-447). The alpha is the texture-wide `txChip.nTransparency` (`CTexture`:414).

### 3.2 Normal chips and chords (PC:3847-4166 flag decode, 4253-4267 draw)
- The channel is decoded into flags R, G, B, Y, P, OPEN and W. The bit tables are in docs/spec/dtx-audio.md §9.3.
- For each set flag `i ∈ R..P`, if `!bHit`: draw rect i at `(laneX[i], yc − 5)` with α = `pChip.nTransparency` (PC:4263-4266).
- **Chords** are independent chips at the same y. There is no connector and no chord frame.
- **Draw order.** Chips are visited in ascending time (PC:2874), so later chips overdraw earlier ones. Within one chip the lanes are drawn R→P, and each lane's LN body is drawn right after that lane's head.

### 3.3 OPEN (PC:4198-4203)
- Drawn at `(88 | 959, yc − 2)` with rect (0,10,196,10).
  - Its **top is yc−2**, so it sits **3 px lower** than lane chips (top yc−5). Its centre is yc+3 [+4.5]. The visible rows are yc−1..yc+7.
- It spans all 5 lanes (88..283) and is not mirrored by LEFT.
- **Draw condition** is `(!bHit || isLN) && bVisible` (PC:4171). The OPEN head of an **OPEN LN keeps being drawn after the hit**:
  - while held: at the judge line (`yc = yBarPos`, PC:4185-4188)
  - after release or miss: at its moving y, until `dEnd ≤ 0`.
- Alpha: the HidSud value from PC:3842 (see §1.5).

### 3.4 Long-note body (PC:4177-4191, 4268-4282; the LN end chip ch 0x2C/0x2D is never drawn, PC:3359-3375)

```
if chip.isLN:
    if dEnd <= 0: return                    // end reached the line → nothing drawn (head included); also skips the AUTO block below
    len = dEnd − dHead
    if chip.bHit && holding: yc = JL+1; len = dEnd      // body pinned to the judge line
for each flag i in R..P:
    if !bHit: draw head (§3.2)
    body: src (38i,3,38,5), vcScaleRatio.Y = len/5 → height len,
          top-left (laneX[i], yc) normal | (laneX[i], yc − len) reverse
    α = 128; if bHit && !holding (released / missed after hit): α = 64
```

- The body starts at the head centre and is drawn after the head. It overdraws the head's **lower half in normal mode** and **[ADD] upper half in reverse** at α128.
- **There is no body for OPEN LNs**: only the R..P flags are iterated.
- HidSud alpha is not applied to the body.
- **[ADD] When holding ends.**
  - Manual hold: ends when the pressed lanes no longer match and the end chip is outside its Poor window (PC:5407-5417).
  - Otherwise: ends when the end chip is marked hit, at `dDrums ≤ 0` (PC:3362-3372).

### 3.5 Wailing chip (GS:678-744 guitar, 875-941 bass; logic PC:4535-4610)

```
y = reverse ? 611 − dG : 154 + dG           // fixed: no nJudgeLine, no +1 (GS:696,706)   [231/916.5 base]
drawn while !bHit && bVisible, if −34 < y < 743
sprite (0,22,54,68) top-left (287 | 1155, y − 34) → centred on y;
crop: part above screen y=0 and below y=709 removed (GS:710-728)
```

- The chip (287..340) overhangs the 42-px wailing column (283..324) by 16 px to the right.
- **When it disappears:**
  - when wailed successfully (`DoWailingFromQueue` sets bHit, PC:5539), or
  - once `dG < −234` (PC:4591-4594).
  - **[ADD]** The PC:4591 comment says "234 px per 1 s", but at guitar HS x1.0, 234 px is **2.6 s**.
  - So an unwailed chip keeps moving past the line. In normal mode it is culled at y ≤ −34 (d ≤ −188); in reverse at y ≥ 743 (d ≤ −132). Either happens before it is marked hit.
- **[QUIRK] Alpha inheritance.**
  - The GS override draws without setting `nTransparency` (GS:724-728). The base method sets `txChip.nTransparency = pChip.nTransparency` only **after** the GS draw (PC:4582, called from GS:743/939).
  - So the wailing chip inherits the alpha last set on `txChip`, e.g. 128/64 from an LN body drawn earlier in the loop.
- **[ADD][QUIRK]** Bar lines and loop lines (GS:968-969, 1016-1018) also never set `nTransparency`. Bar lines are drawn before the chips, so they inherit the alpha of the **previous frame's** last `txChip` use (an LN body 128/64, a HidSud value, or a wailing chip's alpha). Do not port; draw bar lines at full alpha.

### 3.6 After judgment (summary)
- Hit chips vanish immediately.
- Missed chips overrun the line by the Poor window, then vanish (§1.4).
- Held LNs keep their body from the judge line to the end.
- Released or missed LNs keep a moving body at α64 until the end crosses the line. An OPEN LN also keeps its head (§3.3).
- There is no "ghost" or hit marker on the lane. Feedback comes only from fire, flush/string and the judge string (§4).

### 3.7 Bar lines, loop lines, measure numbers (GS:949-1035)
- **Bar lines:**
  - Only channel 0x50 bar lines are drawn on guitar/bass lanes. Beat lines (0x51) are drawn only on the drum screen (PC:3584).
  - `y = normal ? JL + dG : JL − dG` (no +1). The sprite top is at y and it is 2 px tall (GS:963,977).
  - Drawn only if all of these hold: `bVisible` (0xC2 show/hide), `bGuitarEnabled`, the part has chips, `104 < y < 670`, and `nLaneDisp ∈ {0,1}` (GS:961-970).
  - Bar lines are drawn from `tUpdateAndDraw_BarLines` before the chips (GS:194; PC:3503-3605).
- **Measure number** `pos/384 − 1` is printed at (60, y−16) for guitar or (930, y−16) for bass, when performance info is on (GS:971-975, 987-991).
  - This is just left of the panel.
  - It is printed even when `nLaneDisp` hides the line.
- **Loop lines** (training loop):
  - Two bar-line sprites at y−1 and y+1, with the same `nLaneDisp` gate.
  - Text "Begin loop"/"End loop" at (60|930, y−16). **[ADD]** The text is printed always, not gated by performance info or LaneDisp.
  - Same 104..670 clip (GS:1006-1033).

---

## 4. Feedback and HUD

### 4.1 RGB(YP) frames: NX draws no pressed state
- `Push(lane)` sets `bPressedState` (RGBC:36-39). `CActPerfGuitarRGB` never reads it (its pressed-state code is commented out, RGB:107-121, 154-168) and clears all 10 entries every frame (RGB:198-201).
- What it does draw (`7_RGB buttons.png`, RGBC:56; drawn only when `bGuitarEnabled`, RGB:24):
  - **Bottom frame**: rect (0,128,277,50) at (67|937, 670) [(100.5|1405.5, 1005) 415.5×75], when the bottom shutter value is 0.
    - Content: five pickup panels plus a tremolo-arm cell.
    - Non-transparent at x 13..264 (screen 80..331), all 50 rows.
  - **Top frame**: rect (0, LEFT?64:0, 277, 64) at (67|937, 42) [(100.5,63) 415.5×96], when the top shutter value is 0. The top shutter value is ShutterIn normally and ShutterOut in reverse.
    - Content: five knobs labelled R G B Y P. The LEFT row reads P Y B G R (RGB:123-130, 170-177).
    - **[FIX]** Only rows 26..61 are non-transparent: screen y 68..103, x 80..289 (measured). It does not cover 42..67.
- The frames do not move with Reverse.
- Pressed feedback is given only by §4.2.

### 4.2 Lane flush and lane "string" (LF:62-128, LFC:26-33)

`Start(lane)` creates a `CCounter(0,70,1 ms)` (LFC:32). Lane indices are 0..4 for guitar and 5..9 for bass (PC:4882-4886).

Triggers:
- **Manual:** every frame while the neck button is **held**. This uses `bPressing`, a level not an edge (PC:5308-5352). The counter restarts each frame, so the effect is at full strength while held and decays over **70 ms after release**.
- **AUTO lanes:** every frame while the part's next unhit chip, or the held LN, contains that colour (PC:4905, 5241-5292). AUTO lanes therefore look "held" ahead of the chip.
  - **[ADD]** "Next chip" means the nearest unhit chip of the part within **±800 ms**, past-first (PC:2294-2306, 1984-2042).

Flush drawing (only if `bLaneFlush`, default on, CI:1321). The counter is drawn, then ticked, then stopped at 70 (LF:74-84):

```
ct  = 0..69
tex = "ScreenPlay lane flush <colour>[ reverse].png"  (37×256)
x   = (88 | 958) + off[i] + 19·ct/70 (int),   off = {0,39,78,117,156} (LEFT: reversed)     [132|1437 + {0,58.5,117,175.5,234} + 28.5ct/70]
y   = reverse ? 414 : 100                                                                  [621 : 150]
src = (37, 0, 37·(70−ct)/70, 256)     // width shrinks while x shifts right ⇒ collapses toward the lane centre
```

- **Texture content [ADD].**
  - Each flush texture is horizontally uniform. The alpha falls from 165 on the judge-line side to 0 at the far end. The normal textures are bright at the top; the reverse textures are bright at the bottom.
  - Colours: red (255,0,0), green (13,94,13), blue (13,54,94), yellow (94,74,13), purple (94,13,80).
- **[QUIRK] Source rect.** The rect starts at U = 1.0 of a 37-px texture (`CTexture`:410-413), so it relies on wrap addressing.
  - **[FIX]** Because the texture is horizontally uniform, the visible result is simply a bar of width `37·(70−ct)/70`.
  - DTXManiaAI draws it as a left-anchored horizontal fill plus the x shift (GPS:2801-2804, 2374-2377).
- **String** (`7_guitar line.png`): per lane, a 13-px vertical line.
  - Look: bright core plus edges fading α255→38; core rgb(255,160,160)/(122,235,122)/(121,179,236)/(236,207,121)/(236,121,216). It is centred at src x 21+39i.
  - Drawn on/off with no fade while the counter runs, from src (39i,0,41,566).
  - Positions: guitar 86,125,164,203,242 (LEFT mirrored); bass 957,995,1034,1073,1112; all at y 104 [129,187.5,246,304.5,363 / y 156, 61.5×849] (LF:89-128).
  - The string core lands at x 107+39i.
- Both flush and string are drawn under the chips.

### 4.3 Chip fire (CF:20-46, CFC:24-32, 101-123)
- **Triggers:**
  - Successful manual pick: each lane of the chip that is pressed or AUTO. The lane mask must match and the judgement must not be Miss. A successful OPEN pick fires **all 5** lanes (PC:5450-5477).
  - AUTO pick at bar crossing, only when `autoPick` (PC:4348-4371).
  - **LN hold:** every frame while held and matching (PC:5360-5387). The counter restarts every frame, so the fire is **frozen at its first frame** (scale 2.12, α255) for the whole hold.
- **Centre:** `(ptCentre[idx].X, reverse ? 611 − nJudgeLine : 155 + nJudgeLine)`, with idx mirrored for LEFT [y 232.5 / 916.5] (CF:30-35).
- Disabled when `eAttackEffect == EType.B` (OFF). The default is EType.A (CF:37, CI:1283-1284).

```
counter v = tStart(28, 56, 8 ms); drawn for v = 28..55 → 224 ms        // CFC:30, 105-115
scale(v) = 3·cos(π(90 − 90v/56)/180) = 3·sin(πv/112)   : 2.121 → 3.0     // CFC:117
α(v)     = 255 − 255·cos(π(90 − 90(v−28)/28)/180) = 255 − 255·sin(π(v−28)/56) : 255 → 0   // CFC:120
top-left = centre − 80·scale/2 ; additive blending (SrcAlpha, One)        // CFC:118-122, 59-83; CTexture:784-788
```

The sprite is 170→240 px wide in 720p [255→360].

### 4.4 Wailing bonus (WB:29-200)
- `Start(part)` runs on a successful wail: the wail must come within 1000 ms after the chip time (PC:5537-5540).
- It takes the first free of **4 slots**. Each slot runs `CCounter(0,300,2 ms)`, i.e. **600 ms** (WB:33-51).
- The pillar uses `ScreenPlay wailing bonus.png`: the left half (0,0,26,122) is drawn on top and the right half (26,0,26,122) below it, forming a 26×244 column.

```
x = 160+133 = 293 (Gt) | 1030+133 = 1163 (Bs)                     [439.5 | 1744.5]
v = 0..300
top = v<100 ? 120 + 290·cos(π/2·v/100)                // 410 → 120  (rise)
    : v<150 ? 120 + (150−v)·sin(π((v−100) mod 25)/25)  // damped downward bounce
    : v<200 ? 64                                       // [ADD] 56-px jump up at v=150
    :         64 − 290(v−200)/100                      // 64 → −226  (leaves at the top)
reverse: top = (670 − top) − 244
upper at (x, top), lower at (x, top+122); clipped to 0..720         // WB:114-168
```

- The lower half is drawn only when `WailingFireFrames == 0`, the default (WB:165, CI:1340).
- These are not drawn in the default skin, because they have no images:
  - the 13-tile `7_WailingFlush` column at x 283/1153 (WB:170-179)
  - `7_WailingFire` (WB:182-195)
- The pillar is drawn **under** the chips (GS:191).

### 4.5 LN hold bonus "+100" (BO)
- Every 1/6 of the LN length while held, up to 5 times, NX adds +100 points and calls `startBonus` (PC:5389-5404).
- Animation: `CCounter(0,500,1 ms)` (BO:78).
- `7_Bonus_100.png` is drawn at `(333|885, 45 − v/25)` while v < 500. It rises 20 px over 500 ms [(499.5|1327.5, 67.5), 30 px] (BO:65-68, 83-88).
- Only drawn if `bShowScore` (default on, CI:1486).

### 4.6 Judgement string (JS, JSC)
- **Slots.**
  - Guitar uses slot 13 and bass slot 14 (PC:1449,1457).
  - A BAD (wrong pick with Light OFF) uses the same slot (PC:1968-1975).
  - `Start` is ignored when the part's position is OFF (JSC:117).
  - The whole draw runs only if `bDisplayJudge.Guitar || .Bass` (JS:104; default on, CI:1311-1314).
- **Default type 1, frame sheet:** `nJudgeAnimeType=1`, 24 frames at 14 ms, cell 250×170 (CI:1329-1333). The sheet is loaded only for type 1 (PC:479-480).
  - Counter (0,23,14 ms) (JSC:121).
  - **[FIX]** The update loop stops the counter as soon as it reaches 23, before drawing (JS:113-120; `CCounter`:46-49). So frames **0..22** are shown, for **322 ms**. Frame 23 is never drawn, and is blank in the sheet anyway.
  - Columns: Perfect 0, Great 1, Good 2, Poor 3, Miss 4, Auto 5. Row = frame (JS:1375-1406).
  - **BAD has no column, so no sprite is drawn.** **[ADD]** But `Start` restarts the slot, so a BAD **blanks a judgement already on screen**. If lag display is on, only the lag digits "999" appear.
- **Position.**
  - **[FIX]** At runtime `xc = num5` (the draft's `+55` is not applied). The derivation:
    1. The JS constructor fills `stレーンサイズ[13|14] = {26,111} / {480,111}` (JS:21-95).
    2. JSC.OnActivate replaces the array with zeroed entries (JSC:175, 183-185). It refills it only `if (bDrumsEnabled)` (JSC:186-217), and that is always false on this screen (see the top note).
    3. So `w = 0` and `xc = num5 + n相対X座標 + 0` (JS:1369). Type 1 never changes `n相対X座標` from 0 (JSC:131).
  - `num5`: P-A = 180 (Gt) / 1060 (Bs); P-B = 420 / 770 (JS:1346,1359).
  - `cy`: P-A and P-B = 300 (reverse 450); P-C = 80 (reverse 650); OFF = not drawn (JS:1339-1364). The default is P-A (CI:1392). Position names per CI:2072: 0 OnTheLane, 1 beside lane, 2 on judge line, 3 OFF.
  - Top-left = (xc − 110 − (250−225)/2, cy − 70 − (170−135)/2) = **(xc − 122, cy − 87)** (JS:1370-1371).
  - **Guitar P-A:** xc 180, top-left (58, 213), sprite centre (183, 298). In 1080p: xc 270, cy 450, top-left (87, 319.5), 375×255.
  - **Bass P-A:** xc 1060, top-left (938, 213). In 1080p: xc 1590, top-left (1407, 319.5).
  - The guitar sprite centre (183) sits on the lane-block centre (lanes 88..280, centre 184.5). cy is 146 px past the judge line in normal mode, 161 px before it in reverse.
- **[FIX] Type 0 (classic) on the guitar screen.** The classic textures (`ScreenPlay judge strings 1..3.png`) are loaded **only** when `nJudgeAnimeType` is neither 1 nor 2 (JSC:234-250). So under type 1 with the sheet missing, nothing is drawn; there is no fallback.
  - **[QUIRK]** With type 0 selected, guitar/bass type 0 is broken:
    - The classic update loop runs only for slots `i < 12` (JS:1254). Slots 13/14 are never ticked, so they never animate and never expire. The sprite stays at scale 1 at `(xc − 64, cy − 21)` (JS:1410-1415) until the next judgement.
    - With the default `nJudgeFrames=24`, `num4 = 0` for every judgement (JS:1336). Poor/Miss/Bad/Auto then show the Perfect/Great/Good rects of image 1.
  - Do not port type 0. The 300-ms classic curves (JS:1253-1326) apply only to the drum lanes.
- **Lag digits.**
  - Shown if ShowLag is ON, or GREAT_POOR and the judgement is not Perfect; never for Auto.
  - 15×19 cells at `x = xc − len·15/2 + 15k`, `y = top + 34` (top = cy − 87 for type 1).
  - Positive and negative values use different colour sets (JS:1419-1439; JSC:161-173).
  - Default OFF (CI:1472).
- Type 2 (XG) uses `num5` = 160 / 1020 (JS:1458,1469) and is not described here.

### 4.7 Combo (CB, CBC)
- Base position: guitar (560,220), bass (845,220) (CB:13-14, 23-24) [(840,330) / (1267.5,330)].
- **Visibility.** The combo is shown when combo ≥ `n表示可能な最小コンボ数` (default 2; CI:1360-1361). 0 means display off (CBC:406, 508).
  - Each increase resets the jump index to 0 (CBC:753-757).
  - A drop switches to "afterimage" mode, which **draws nothing**, so the combo disappears instantly. It becomes fully hidden after 1000 ms (CBC:673-797, 787).
- **Jump:** `j(k) = (int)(−15·sin(πk/180))` for k ∈ [0,180) (CBC:220-221). k advances +3 every 2 ms (CBC:700-712), so one jump lasts 120 ms.
- **Sprite sheet** `ScreenPlayGuitar combo.png`:
  - digit d at ((d%5)·90, (d/5)·115, 90, 115)
  - the "COMBO" label at (0,230,200,64) (CBC:118-122, 469, 498)

```
n = digit count, x,y = base
label     top-left (x − 100 [Bs: x − 95], y + j(k − n))                         // CBC:429-452, 467-469, 568-570
digit i   (0 = ones) left = x + 45n − 84(i+1) − 45 ; top = y − 115 + j(k − (n−i−1))   // CBC:473-499
```

The number is centred on x and sits above y. The label sits below y. The digit pitch is 84 (= 90 − 6) [126]. Digit size [135×172.5]; label [300×96].

### 4.8 Score (SC, SCC)
- Position: X = 373 (Gt) / 665 (Bs), Y = 12 (SC:24-27).
- Digits: 7 digits formatted `{0,7:######0}`, with leading blanks skipped. Each uses rect (d·36,0,36,50) at (X+34i, 40) (SC:81-103).
- Label: rect (0,50,86,28) at (X, 12), drawn after the digits (SC:104-107).
- [Label at (559.5|997.5, 18); digits 54×75 at y 60, pitch 51.]
- **Count-up:** every 10 ms, `shown += inc`, clamped to the true score. `inc = max(1, (true − shown)/20)` is computed when the true score changes (SCC:36-47, SC:64-79).
- **[ADD][QUIRK] Training mode.** In NX training mode the count-up is skipped (SC:58-61). The displayed guitar/bass score stays at 0, its activation value (SCC:130).
- **Hiding.** The score is hidden for the all-auto part when the graph is on (SC:30-40). It is drawn only if `bShowScore` (GS:204-205).

### 4.9 Gauge and HS icon (GA:25-127)
- **Frame** `7_Gauge_{Guitar,Bass}.png` (290×136) has two layers: back (0,0,290,68), fully opaque, and front (0,68,290,68).
  - Guitar frame at x 80. Bass frame at x = 1240 − 290 = 950. Both at y 0 [(120|1425, 0) 435×102].
- **Bar** `7_gauge_bar.png`: rect (0,0,242,30) at (86 | 992, 31), x-scaled by the gauge value [(129|1488, 46.5) 363×45].
  - It is anchored left, so the **bass bar also fills left to right**.
  - **[FIX]** `7_gauge_bar.jpg` (full) is used only when the value is **exactly 1.0**. Below 0, no bar is drawn (GA:88-96, 118-126).
- **Draw order:** back layer, then HS icon, then bar, then front layer.
- **HS icon** `7_Panel_icons.jpg`:
  - Row `min(nScrollSpeed,20)·48` (the target value, not the smoothed one), cell 42×48.
  - Scaled (0.762, 0.667) to 32×32.
  - Drawn at (334 | 954, 30) [(501|1431, 45) 48×48] (GA:85-87, 115-117).
- **Gauge constants:** initial 2/3, minimum −0.1, danger at ≤ 0.3 (GAC:42-46, 71-86).

### 4.10 DANGER (DA)
- `ScreenPlayGuitar danger.png` at (168 | 328, 0) [(252|492, 0)], shown while `IsDanger` (GS:438-442).
- α = 20 + (d<20 ? 160d/20 : 160(40−d)/20). d loops 0..40 at 8 ms, a 328-ms period (DA:49, 63-65, 78-81).
- The image is missing from the default skin, so nothing is drawn by default.

### 4.11 Other HUD positions
- **Progress bar:** (334,85) for guitar / (1204,85) for bass, 20×540. Its background is at (x−2, 15) (`Stage/07.Performance/CActPerfProgressBar.cs:32-34, 227`) [(501|1806, 127.5) 30×810]. [FIX line refs]
- **Status panel:** `7_SkillPanel` at (373|665, 254), 257×439, when `nInfoType==1` (default 1) (`…/GuitarScreen/CActPerfGuitarStatusPanel.cs:173-176`, CI:1280). The panel of a part without chips is hidden (StatusPanel:178-188).
- **Skill graph:** y 110.
  - **[FIX]** x = 356 (Gt) / 647 (Bs) only when `nInfoType != 1`.
  - With the default `nInfoType==1`, x = **638 (Gt) / 403 (Bs)** (`Stage/07.Performance/CActPerfSkillMeter.cs:171-180`).
- **[ADD]** PerfInfo text at (500,257) (GS:493). PlaySpeed image at (600,687) (GS:500).

---

## 5. What DTXManiaAI changed or simplified

1. **[AI-CHG] Scroll speed is 2.52× NX.** It is 0.3375·HS vs 0.1340625·HS px/ms [1080p], with no 0.012/2 ms smoothing and no in-play change (§2; GPS:48, 425-426; AIdoc20:123-124).
2. **[AI-CHG] Old NX offsets.** DTXManiaAI keeps the offsets NX used before commit `0effabe` "Fix Guitar/Bass visual judge line alignment" (2026-06-28).
   - Chip centre: normal `JudgeY + 10·S + d`; **[FIX]** reverse `JudgeY + 1·S − d`, which already equals NX (NGL:30-32, 117; GPS:1914-1919).
   - Bar line: normal `JudgeY + d + 9·S`; reverse `JudgeY − d`, also equal to NX (NGL:118-119; GPS:1892-1894).
   - Current NX uses **+1 / +0** in both modes (GS:564, 963, 977, 1008, 1021). The same NX commit also added Δ to the hit-bar.
   - Result: in **normal mode only**, DTXManiaAI chips cross the hit-bar 9 px [13.5] late (low), and its hit-bar ignores `JudgeLinePosOffset` Δ (GPS:1795).
3. **[FIX] Judge-string centre x: no difference.** DTXManiaAI uses 180/1060 (NGL:71-73, GPS:2477-2479). That is NX's runtime value, because NX's `stレーンサイズ` widths are zeroed on activation (§4.6). The top-left offset (−122, −87) also matches (NGL:160).
   - **[AI-CHG]** It shows sheet frames 0..23 for 336 ms (GPS:2918-2926; `Stages/NxPerfLayout.cs:91`). NX shows 0..22 for 322 ms.
4. **[NX-only] `nJudgeLine` (0..100) is not supported.** `JudgeY` is fixed at 154/611 (GPS:434-435).
5. **[NX-only] Fixed options.** LEFT, HID-SUD, LaneDisp, shutters and the LaneFlush toggle are fixed to their defaults (GPS:437-445; AIdoc20:116-118).
6. **[AI-CHG] AUTO-lane flush and string** light only when the chip is hit, via `StartFire` (GPS:1803-1809, 2788-2792). NX keeps AUTO lanes lit while the nearest chip within ±800 ms contains that colour (PC:5241-5292, 2298).
7. **[AI-ADD] OPEN LN body.** DTXManiaAI draws a 196-wide band from rect (0,13,196,5) (GPS:1954-1966, 2441). NX draws none (§3.4).
   - Conversely, **[NX-only]** NX keeps drawing the OPEN head of a hit OPEN LN; DTXManiaAI skips judged heads (GPS:1998-1999).
8. **[AI-ADD] CUSTOM layout** (Layout=0, used when the NX skin is off; GPS:1533-1643, 2081-2247):
   - flat-colour boxes. Lane colours R(0.95,0.3,0.3), G(0.35,0.9,0.4), B(0.35,0.55,1), Y(0.95,0.85,0.25), P(0.85,0.4,0.95), OPEN(0.9,0.55,0.2), Wail(0.4,0.9,0.9) (GPS:70-79)
   - flush at α0.55 while held, fading over 70 ms (GPS:2083-2101)
   - judge text shown for 500 ms with a 60-ms pop (GPS:2124-2134)
   - wailing pillar as a single 600-ms cosine rise plus a linear fade to α0.4 (GPS:2158-2171)
   - text score and combo; the LN band is a single band on the first lane (AIdoc20:131-133; GPS:1984-1995)
9. **[FIX] BAD display.**
   - In the **CUSTOM** layout, DTXManiaAI shows BAD as MISS (GPS:1080-1083; AIdoc20:120).
   - In the NX layout it draws nothing for BAD, as NX does. **[AI-CHG]** But it does not restart the slot, so a judgement already shown stays visible; NX blanks it (§4.6).
10. Judgements are based on frame time rather than input-event timestamps (AIdoc20:119). This is outside the drawing topic, but it affects when the judge string appears.
11. **[ADD][AI-CHG] Smaller differences:**
    - No 600-px processing horizon. Chips are culled at y > 1120 (normal) or y < −40 (reverse) (GPS:1943-1944).
    - The wailing chip is culled at −34·S/743·S without the 709 crop (GPS:2046).
    - Fire and flush use continuous time instead of 8-ms / 1-ms counter steps (GPS:2801, 2820).

---

## 6. PROPOSAL (not spec): one part at a time on the web 1920×1080 canvas

Existing web layout:
- Drum band at x 539..1317, centre 928 (js/ui/skin.js:18-19). `JUDGE_Y = 975` (skin.js:22).
- SCORE DETAILED panel at (177,610) (skin.js:72). SONG INFO at (1432,186). Training menu at (1400,340, 500×700) (skin.js:69-74).
- Portrait mode crops x 459..1397 (js/ui/renderer.js:17, 62-65).

**P-1 Geometry: uniform ×1.5, with the NX lane block centred on the drum band.**
- `X(nx) = 1.5·nx + 620`, `Y(ny) = 1.5·ny`. The NX lanes-plus-wailing block 86..325 has centre 205.5, which maps to 928.
- **Use the guitar's NX x values for bass too** (drop the irregular bass offsets, §1.1).
- All the ×1.5 sizes in §1–§4 apply unchanged, and the HS look-ahead matches NX exactly.

| Item | Web value |
|---|---|
| Panel | [720.5, 1136) × [63, 1080); lanes y [156, 1014) |
| Separators | 749, 807.5, 866, 924.5, 983, 1041.5 |
| Lane centres (= fire centres; NX's P fire is 1 px right, at 1016) | 780.5, 839, 897.5, 956, 1014.5 |
| Chip left x | 752, 810.5, 869, 927.5, 986 (visible 55.5×15) |
| OPEN | 752 (294×15), top = yc − 3 |
| Bar line | 752 (289.5×3) |
| Wailing column | [1044.5, 1107.5); wailing chip at 1050.5 (81×102) |
| Hit-bar | 740 (378×9) |
| Flush | x 752 + 58.5i + 28.5·ct/70, width 55.5·(70−ct)/70, y 150 (rev 621), h 384 |
| String | x 749 + 58.5i, y 156, 61.5×849 |
| Top frame / button row | (720.5, 63, 415.5, 96); visible content only y [102,156), x [740,1055) |
| Bottom frame | (720.5, 1005, 415.5, 75) |
| Wailing pillar | x 1059.5 (39×366) |
| "+100" | (1119.5, 67.5) |

**P-2 Direction.**
- The default should be NX normal: `JL = 231`, chip centre `yc = 232.5 + d`, chips rising from under the bottom frame at 1005.
- REVERSE: `JL = 916.5`, `yc = 918 − d`.
- Optional "drum-like reverse": `JL = JUDGE_Y = 975`, `yc = 976.5 − d`. The button row would go in the pads band 985..1074. Flush y = 975 − 295.5 = 679.5; fire y = 975.
- Keep the visible window y [156, 1005) and mask the strip above the lanes, as the NX gauge and top frame do (§1.4). Otherwise reverse chips pop in high above the panel.

**P-3 Scroll.**

```
GB_SCROLL_BASE_PX_PER_MS = SCROLL_BASE_PX_PER_MS * 0.5      // 0.1340625
ppm = GB_SCROLL_BASE_PX_PER_MS * hsRatio                    // hsRatio = displayed HS, smoothed with SCROLL_RAMP_STEP 0.006/2 ms (player.js:31) == NX 0.012 raw/2 ms (without NX's stuck-ramp quirk, §2)
d(t) = ((t − drawMs) / ratio) * ppm                          // same clock model as renderer.js:162 (float, no int truncation)
yc   = reverse ? JL + 1.5 − d : JL + 1.5 + d
```

Process chips while `d ≤ 900` [NX 600·1.5].

**P-4 Chips and effects.** Follow §3–§4 literally:
- draw order, the LN α 128/64 rules, the OPEN +3 offset, OPEN LN without a body (head kept after the hit), wailing base 231/916.5 with no +1
- bar lines at full alpha (do not reproduce the alpha-inheritance quirk)
- lane flush and string follow the "held = always restart" rule, including AUTO-lane pre-lighting within ±800 ms
- the fire uses CFC's exact curves with additive blending (`globalCompositeOperation = 'lighter'`, as the drum fire already does at renderer.js:216-219)
- **Web addition (label it as such in code):** light the matching knob on the top button row while a lane is held. NX never shows a pressed state (§4.1).

**P-5 HUD.** NX's two-part HUD positions collide with the web's right column. For example, the NX combo would land at X(560)=1460, y 157..426, overlapping SONG INFO and the training menu. Therefore:
- **Combo:** reuse the drum position, centre (301, 330), with a jump of −15·1.5·sin. Use NX's guitar timing: 120 ms, and disappear immediately on break (renderer.js:386-397).
- **Score / achievement / SPEED:** keep SCORE DETAILED at (177,610) unchanged. NX freezes the guitar score at 0 in training mode (§4.8); do not copy that.
- **Gauge and progress:** vertical bars at panel-left −42 and −78, i.e. x 678.5 / 642.5. These are the same offsets the drum renderer uses from `LANE_X0` (renderer.js:503-506).
- **Measure numbers:** at panel-right + 6 = 1142, mirroring the drums' `LANE_X0+LANE_W+6` (renderer.js:189), instead of NX's left-side x=60.
- **Judge string:** a single slot per part.
  - [FIX] NX-faithful: xc = X(180) = 890. The sprite is 375×255 with top-left (X(58), cy − 130.5) = (707, cy − 130.5); its visual centre ≈ 894.5 sits over the 5 lanes (lane-block centre X(184.5) ≈ 896.75).
  - cy = JL + 219 (normal) / JL − 241.5 (reverse).
  - A BAD should blank the slot (NX behaviour).
  - Animation: either the NX type-1 timing (23 frames × 14 ms = 322 ms) with synthesized frames, or the classic 300-ms one already used for drums (renderer.js:338-…). NX's own type 0 is broken on this screen (§4.6).
- **DANGER:** reuse the drum gauge's danger colouring.
- **Portrait:** no change needed. The crop x 459..1397 contains the panel, the gauge/progress bars and the measure numbers.

**P-6 Assets.**
- Do not copy NX images (third-party; CLAUDE.md).
- Add the guitar parts either as procedural drawing, or as new `SKIN_PARTS` entries generated by `tools/skinart/` (and update `skins/README.md`): 5 chip colours (37-px visible width), OPEN bar, wailing glyph, lane panel, flush gradient (α165→0), string glow, fire.
- The DTXManiaAI CUSTOM colours (GPS:70-79) are a usable neutral palette.

```
        x: 642 678  720.5        752 ... 1041.5 1107.5  1136 1142
y   63 ┌──────────── top frame / button row (R G B Y P), visible 102..156 ─┐
   231 ├──────────── hit-bar (normal) ───────────────────────────────────────┤  ← chips rise to here
       │ prog gauge │ R │ G │ B │ Y │ P │ wail │                             │ 012 (measure no.)
       │            │   chips enter from below ↑                            │
  1005 ├──────────── bottom frame ───────────────────────────────────────────┤
SCORE DETAILED (177,610) left; SONG INFO / training menu (x ≥ 1400) right; combo at (301,330)
judge string centre ≈ (894.5, 450)
```
