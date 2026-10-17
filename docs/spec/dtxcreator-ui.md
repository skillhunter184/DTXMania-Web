# dtxcreator-ui

# DTXCreator (DTXC NX) main window, UI and workflow: behavioral specification

Path roots (absolute):
- `DC/` = `DTXmaniaNX/DTXCreator/`
- `Code/` = `DC/Code/`. `MAN/` = `DC/マニュアル/_RESOURCE/` (Shift-JIS HTML; line numbers are raw HTML lines).
- `NX/` = `DTXmaniaNX/DTXMania/Code/`

Source files read:
- `Code/00.App/CMainForm.cs` (4855 lines): scenarios, GUI events, title and modified flag, viewer launch, settings load and save.
- `Code/00.App/CMainForm.Designer.cs` (1788 lines): control tree, toolbar order, combos, scroll bars.
- `Code/00.App/CMainForm.resx` (neutral and English text, shortcuts, layout) and `CMainForm.ja-JP.resx` (Japanese text).
- `DC/Properties/Resources.ja-JP.resx` and `Resources.resx`: message boxes and dialog titles.
- `Code/00.App/AppSetting.cs`, `MakeTempDTX.cs`, `Program.cs`.
- `Code/00.App/CDTXInputOutput.cs`: only the header, playback-related and WAV output parts.
- `Code/03.Options/*.cs` and the matching resx files.
- `Code/04.ChipPalette/*.cs` and resx.
- `Code/02.WAV_BMP_AVI/CWAVListManager.cs`, `CWAV.cs`, `CSoundPropertiesDialog.cs` and Designer/resx.
- `Code/05.Score/ScoreManager.cs`, `CMeasure.cs`, `CLane.cs`, `CChip.cs`, `CEditModeManager.cs`: needed for layout, colors and the placement number. Selection-mode internals are skimmed only.
- Viewer side: `NX/App/CCommandParse.cs`, `NX/Stage/07.Performance/DrumsScreen/CStagePerfDrumsScreen.cs:191-195`, `NX/Stage/07.Performance/CStagePerfCommonScreen.cs:5591-5606`, `NX/Score,Song/CDTX.cs:6626`.
- Manual: `MAN/画面構成/*.html`, `MAN/使い方/*.html`, `MAN/usage/*_e.html`.

Conventions:
- **grid** = DTXCreator's internal vertical unit. One standard (x1.0) measure is 192 grid (`CMeasure.n基準の高さgrid = 0xc0`, CMeasure.cs:12). This is not 384; DTX counts are converted on I/O.
- **dot** = a screen pixel of the score PictureBox.
- 表 = front channel, 裏 = back channel.
- resx citations point at the `<data name=…>` line; the value is on the next line.
- Statements are read from code unless marked **INFERRED**. "Manual says" marks a user-facing doc claim, which is sometimes outdated against the code.

---

## 1. Window composition

### 1.1 Form-level docking
- Main form controls are added in this order (Designer.cs:1575-1579): `splitContainerタブと譜面を分割` (Dock Fill, CMainForm.resx:121), `vScrollBar譜面用垂直スクロールバー` (Dock Right, width 17, resx:2596-2602), `toolStripツールバー` (resx:2572), `statusStripステータスバー`, `menuStripメニューバー` (resx:2193).
- Design ClientSize is 731x558 (resx:2707). Default title before init is `DTXCreator` (resx:3141). `AllowDrop = true` (Designer.cs:1572).
- The status strip is created and docked but never used in code. The only references are in the Designer (Designer.cs:107, 851-854, 1578), so it is always empty.
- The vertical score scroll bar lives on the form, outside the split container, and spans the full height between the toolbar and the status bar. The horizontal score scroll bar is inside Panel2 (Dock Bottom, resx:1758).

### 1.2 Split container
- Panel1 holds `tabControl情報パネル` (Dock Fill, resx:1695). Panel2 holds `pictureBox譜面パネル` plus `hScrollBar譜面用水平スクロールバー` (Designer.cs:227-233).
- The designer SplitterDistance is 286 (resx:1800). It is overridden at startup by `AppSetting.SplitterDistance` (default `0x128` = 296; AppSetting.cs:507, CMainForm.cs:318-319).

### 1.3 Left tabs
- `Eタブ種別`: 基本情報=0, WAV=1, BMP=2, AVI=3, 自由入力=4 (CMainForm.cs:1828-1835). Same order in Designer.cs:238-242.
- Japanese tab captions: `基本情報` (ja.resx:301). The others are not localized and show as `WAV` / `BMP` / `AVI` / `Free` (CMainForm.resx:1367, 1494, 1620, 1680).

### 1.4 Score panel geometry
- The PictureBox has a black background (Designer.cs:833) and Anchor Top|Bottom|Left (resx:1731). Its width is forced to the sum of all lane widths (ScoreManager.cs:864-883).
- The lane backgrounds are a 1-px-tall bitmap. Each visible lane is filled with its `col背景色` (alpha 25). The bitmap is set as `BackgroundImage` with `ImageLayout.Tile` (ScoreManager.cs:871-882).
- **Horizontal scroll** moves the whole PictureBox: `box.Location = (-value, 0)`. The bar has Max = box.Width-1, SmallChange 5, LargeChange = Panel2.Width, and is enabled only if Max > LargeChange (ScoreManager.cs:602-623).
- **Vertical scroll** works in grid units (ScoreManager.cs:587-601):
  - `Maximum = total grid - 1`, `SmallChange = 192/16 = 12`, `LargeChange = 192`. The designer's 64/4 values are overwritten (Designer.cs:1467-1469).
  - `n現在の譜面表示下辺の譜面先頭からの位置grid = (Max+1 - LargeChange) - Value`: the grid position of the panel's bottom edge, measured from the chart start.
  - So Value=0 (thumb at the top) shows the end of the chart, and the thumb at the bottom shows measure 000 at the panel bottom.
  - Initial Value = `(Max+1) - LargeChange`, i.e. the bottom edge is at grid 0 (ScoreManager.cs:849-856).
- **Orientation:** time runs bottom to top. Measure 0 is at the bottom and higher measures stack upward. For each measure: `rect = (0, H - (top_dot - bottomDot), W, measure_height_dot)` (ScoreManager.cs:632-657).
- When the total height changes (measures inserted or deleted, length changed), Paint shifts Value by the same delta so the bottom edge stays put, then recomputes the bottom edge (CMainForm.cs:2373-2412).

### 1.5 Constants and transforms
```
grid per x1.0 measure      = 192                      (CMeasure.cs:12)
measure height (grid)      = int(192 * f小節長倍率)    (CMeasure.cs:27-33)
n基準の高さdot             = 192 * (zoomIndex+1)       (CMainForm.cs:4775)
dot per grid               = n基準の高さdot / 192 = zoomIndex+1   (CMeasure.cs:13-19)
lane width                 = 30 px (LANEWIDTH); hidden lane = 0 px   (CLane.cs:10, 62-72)
chip height                = 9 px                     (CChip.cs:77)
measure number range       = 0..3599 (0xe0f) else exception           (CMeasure.cs:42-45)
x -> lane:    cumulative-width scan, -1 if x < 0 or beyond              (ScoreManager.cs:72-89)
y -> grid (full res):  (ClientHeight - y) / dotPerGrid + bottomEdgeGrid (ScoreManager.cs:102-106)
y -> grid (snapped):   m = measure containing g (or last measure); g' = mStart + floor((g-mStart)/guideGrid)*guideGrid
                                                                        (ScoreManager.cs:90-101)
grid -> y:   ClientHeight - (g - bottomEdgeGrid) * dotPerGrid           (ScoreManager.cs:159-163)
```
- Snapping is floor-based relative to the measure start. The guide line at or below the mouse wins.
- A chip's bottom edge sits on its grid line and the chip extends 9 px upward (ScoreManager.cs:922).
- Chip hit test (selection mode): the chip in the lane whose `[pos, pos + dot2grid(9)]` range contains the mouse grid (ScoreManager.cs:193-216).

### 1.6 Per-measure draw order and colors
Order is measure number, guide lines, beat lines, lane separators, measure lines, chips (ScoreManager.cs:884-892). Then two bands are drawn over everything at the top of the panel (ScoreManager.cs:658-661).

| element | spec | source |
|---|---|---|
| measure number | `CConversion.strConvertNumberTo3DigitMeasureNumber` (e.g. `000`…`Z99`), font "MS UI Gothic" 50pt, ARGB(80,255,255,255), centered H and V in the measure's visible rect (a big translucent watermark) | ScoreManager.cs:626-627, 733, 736, 987-990 |
| guide lines | RGB(50,50,50) 1 px, every `guideGrid` from the measure bottom; only when guideGrid > 1 (Free mode draws none) | 737, 893-904 |
| beat lines | Color.Gray 1 px, every 48 grid (192/4) from the measure bottom, independent of measure length | 741, 991-999; manual `MAN/画面構成/譜面.html:132` |
| lane separators | at each lane's left x; `penレーン区分線ペン太` White 2 px when `b左側の線が太線`, else Gray 1 px | 738-739, 971-980 |
| measure lines | White 2 px at both the top and bottom edge of each measure | 740, 981-986 |
| lane-bound-chip band | y 0..10, vertical gradient RGB(0,0,100) to (100,100,255); each lane shows its front binding at x+1 and its back binding at x+15, "MS UI Gothic" 7pt, white with black shadow | 19, 658-659, 1000-1036 |
| lane-name band | y 10..42 (height `0x20`), gradient (100,100,255) to (0,0,255, α0); name at x+2/y+2, font "MS US Gothic" 8pt (typo for UI, so the system falls back: **INFERRED**), RGB(220,220,220) with a black shadow offset 2 px | 20, 660-661, 1037-1058 |

There is **no playhead or current-position bar** in the score. "Current position" is implicit (§8.3).

### 1.7 Lane list (ScoreManager.cs:746-848)
Lane background alpha is `0x19` = 25 (line 750). "Thick" means a thick left separator. All lanes are 30 px unless hidden.

| lanes | E種別 | 表 ch / 裏 ch | thick | RGB | ELaneType | default visible |
|---|---|---|---|---|---|---|
| BPM | BPM | 08 / 03 | ✓ | 160,160,160 | BPM | ✓ |
| LC | WAV | 1A / 1A | ✓ | 223,95,127 | Drums | ✓ |
| HH | WAV | 11 / 18 | | 0,255,255 | Drums | ✓ |
| LP | WAV | 1B / 1B | | 255,159,207 | Drums | ✓ |
| LB | WAV | 1C / 1C | | 255,159,207 | Drums | ✓ |
| SD | WAV | 12 / 12 | | 255,255,0 | Drums | ✓ |
| HT | WAV | 14 / 14 | | 0,255,0 | Drums | ✓ |
| BD | WAV | 13 / 13 | | 191,191,255 | Drums | ✓ |
| LT | WAV | 15 / 15 | | 255,0,0 | Drums | ✓ |
| FT | WAV | 17 / 17 | | 255,127,0 | Drums | ✓ |
| CY | WAV | 16 / 16 | | 159,159,255 | Drums | ✓ |
| RD | WAV | 19 / 19 | | 0,255,255 | Drums | ✓ |
| FI, BN1, BN2, BN3, BN4 | FI | 53, 4F, 4E, 4D, 4C (表=裏) | FI only | 255,255,0 | Drums | ✓ |
| MLC, MHH, MCY, MRD | WAV | 87, 84, 85, 86 | MLC only | as LC / HH / CY / RD | Drums | ✓ |
| BGM | WAV | 01 / 01 | ✓ | 160 grey | BGM | ✓ |
| SE1–SE5 | WAV | 61–65 | SE1 | grey | SE1_5 | ✓ |
| SE6–SE9, S10–S32 | WAV | 66–69, 70–79, 80–89, 90–92 | SE6 | grey | SE6_32 | ✗ (width 0) |
| GtV, GtR, GtG, GtB, GtY, GtP | Gt* | 0 / 0 | GtV | grey; R 255,0,0; G 0,255,0; B 0,128,255; Y 255,255,0; P 255,0,255 | Guitar | ✓ |
| GtW, GtL | GtW, GtL | 28 / 28, 2C / 2C | GtW | grey, 240,192,160 | Guitar | ✓ |
| BsV…BsP, BsW, BsL | Bs* | 0…, A8, 2D | BsV, BsW | as Guitar | Bass | ✓ |
| AVI | AVI | 54 / 54 | ✓ | grey | AVI1_2 | ✓ |
| BG1–BG5 | BMP | 04/C4, 07/C7, **0x100**/D5, 56/D6, 57/D7 | BG1 | grey | BGA1_5 | ✓ |
| BG6–BG8 | BMP | 58/D8, 59/D9, 60/E0 | | grey | BGA6_8 | ✗ |

Lane-table caveats:
- 49 lanes are visible by default, so the score is 1470 px wide (**INFERRED** arithmetic).
- The manual's lane table is outdated. It lists no LP/LB/RD lanes and says CY 裏 = 19 (`MAN/画面構成/譜面.html:72-118`). In the code, RD is its own lane and CY's back channel is 16.
- Code observations: S24–S27 (0x84–0x87) collide with MHH, MCY, MRD and MLC (lines 772-774 vs 803-806). BG3's front channel is `0x100`, while the `CChip.nチャンネル番号00toFF` setter throws above 0xFF (CChip.cs:29-32). **INFERRED:** placing a front chip on BG3 throws.

### 1.8 Chip rendering (CChip.cs)
- **Front chip:** full lane rect, 30x9.
  - Fill: ARGB(128, laneRGB).
  - Top and left edges: alpha 255. Bottom and right edges: alpha 64 (lines 175-188).
  - Label: 2-digit base36 with a space between the digits (`0 1`), "MS Gothic" 8pt Bold, white over a black shadow offset +1,+1, centered (lines 112-121, 151, 160-174).
- **Back chip:** inset 4 px left and right, 1 px top and bottom, so it is 22x7 (manual: 左右が少し短く, `MAN/使い方/チップを置く、削除する.html:59`).
  - Fill alpha 80. Top and left edges alpha 180, bottom and right alpha 44 (lines 204-221).
- **BPM chips** show the float value via `ToString()` (lines 122-130). They are drawn from `f値_浮動小数` (ScoreManager.cs:948-950, 957-960).
- **OPEN chip:** the GtR or BsR chip with value 2. Drawn white across 5 lanes' width (`n幅dot*5`), labelled `O    P    E    N` (CChip.cs:83-88, ScoreManager.cs:939-946).
- **Selected chip** (`bドラッグで選択中 || b確定選択中`): white 2 px rectangle border (CChip.cs:106-111, ScoreManager.cs:965-968).
- Chips are sorted by grid within each measure before drawing (ScoreManager.cs:907). Chips in hidden lanes and chips with `n枠外レーン数 != 0` are skipped (911-920).
- **Edit-mode ghost cursor** (CEditModeManager.cs:68-96, 127-172):
  - Rect = (laneX, y(snappedGrid) - 9, laneWidth, 9).
  - Drawn as a front chip, or as a back chip while Ctrl is held at Paint time, plus the white 2 px border.
  - Label = the number that would be placed (§5.2). No number is shown on pattern or BPM lanes.
  - Hidden while the mouse is in the top 20 px (`e.Y < 10+10`) and on MouseLeave (60-67).
  - It is repainted only when the rect changes on MouseMove. **INFERRED:** pressing or releasing Ctrl without moving the mouse does not restyle it.

### 1.9 Measures
- New charts start with 10 empty measures (000–009) (ScoreManager.cs:857-863).
- Placing a chip into the current last measure appends 4 more measures. Each append is recorded as an undoable insert (ScoreManager.cs:344-352).

---

## 2. Menu bar
Labels are Japanese from `CMainForm.ja-JP.resx` (EN in parentheses). Shortcuts come from `CMainForm.resx`; the ja resx overrides none.

| menu | item (ja-JP.resx line) | EN | shortcut (resx line) | action / enabling |
|---|---|---|---|---|
| ファイル(&F) (448) | 新規(&N) (415) | &New | Ctrl+N (1848) | `tシナリオ_新規作成` (CMainForm.cs:4453) |
| | 開く(&O) (421) | &Open... | Ctrl+O (1857) | `tシナリオ_開く` |
| | 上書き保存(&S) (427) | &Save | Ctrl+S (1866) | enabled iff modified (CMainForm.cs:134-143) |
| | 名前を付けて保存(&A) (433) | Save &As ... | — | `tシナリオ_名前をつけて保存` |
| | 終了(&X) (442), then recent files (§13.6) | E&xit | — | `this.Close()` (1033-1038) |
| 編集(&E) (538) | 元に戻す(&U) (454) | &Undo | Ctrl+Z (1896) | enabled iff undo available (2055-2061) |
| | やり直す(&R) (460) | &Redo | Ctrl+Y (1905) | enabled iff redo available |
| | 切り取り(&T) (469) / コピー(&C) (475) / 削除(&D) (487) | Cu&t / &Copy / &Delete | Ctrl+X / Ctrl+C / **Del** (1920, 1932, 1956) | enabled iff any chip `b確定選択中` (1853-1881); no-op unless the score has focus (1361, 1382, 1449) |
| | 貼り付け(&P) (481) | &Paste | Ctrl+V (1944) | enabled iff clipboard cells > 0; pastes at the mouse grid if the mouse is over the score, else at the visible bottom edge (4503-4523) |
| | すべて選択(&A) (496) | Select &All | Ctrl+A (1968) | forces 選択モード, then selects all (4528-4539) |
| | 選択モード(&S) (505) / 編集モード(&E) (511) | &Select mode / &Edit mode | — | §5 |
| | モード切替(&M) (517) | Switch &Mode | **Ctrl+Space** (1992) | toggles (4548-4558) |
| | 検索(&F) (526) / 置換(&Q) (532) | &Find... / Replace(&Q) | Ctrl+F / Ctrl+H (2004, 2013) | always handled by the selection-mode manager (1043-1050) |
| 表示(&V) (601) | チップパレット(&P) (544), CheckOnClick | Chip &palette | — | show/hide the palette (4571-4581, Designer.cs:1050) |
| | ガイド間隔(&G) (595) submenu: 1/&4, 1/&8, 1/1&2, 1/1&6, 1/24, 1/&32, 1/48, 1/64, フリー (574), separator, 拡大(&W) (583), 縮小(&N) (589) | &Guide margin | 拡大 **F3**, 縮小 **F4** (2091, 2100) | §6 |
| 再生(&P) (631) | 先頭から再生(&T) (607) | Play from &top | **F5** (2121) | §12 |
| | 現在の位置から再生(&P) (613) | &Play from current part | **F6** (2130) | |
| | 現在の位置からBGMのみ再生(&B) (619) | Play &BGM from current part | — | |
| | 再生停止(&S) (625) | &Stop | **F7** (2145) | all four enabled iff the viewer exe exists (2094-2122) |
| ツール(&T) (643) | オプション(&O) (637) | &Option | — | options dialog, then `tRefreshDisplayLanes` (4672-4676) |
| ヘルプ(&H) (661) | DTXCreator マニュアル(&M) (649) | DTXCreator &Manual | **F1** (2172) | `Process.Start(exeDir + @"\Manual.chm")`; on exception the item is disabled (4681-4693) |
| | バージョン情報(&V) (655) | &Version | — | modal `CVersionInfo` (4694-4703) |

- Guide submenu items other than フリー are not localized: `1/&4`, `1/&8` etc. (CMainForm.resx:2037-2085).
- The manual lists different mnemonics in places, e.g. 置換(R) and 貼り付け(V) (`MAN/画面構成/メニューバー.html`). The code values above win.
- **INFERRED** (standard WinForms): enabled menu shortcuts are consumed at form level before a focused TextBox sees them. Examples: Del while chips are selected, Ctrl+Z/Y anywhere while undo is available, Ctrl+V while the clipboard holds chips.

---

## 3. Toolbar
Order (Designer.cs:1219-1244), with Japanese tooltips from ja.resx:667-721:
1. 新規作成 (`新しい譜面を作成します。`), 開く (`新しいDTXファイルを開きます。`), 上書き保存 (`上書き保存します。`). Separator.
2. 切り取り, コピー, 貼り付け, 削除. Separator.
3. アンドゥ (`作業を１つ元に戻します。`), リドゥ. Separator.
4. チップパレット (CheckOnClick, `チップパレットを表示します。`). Separator.
5. `toolStripComboBox譜面拡大率` (DropDownList, `譜面の縦方向の表示倍率を指定します。`).
6. `toolStripComboBoxガイド間隔` (DropDownList, `ガイド線の間隔を指定します。`).
7. 選択モード (icon 矢印ポインタ, `選択モードに切り替えます。`), 編集モード (icon 鉛筆, `編集モードに切り替えます。`). Separator.
8. 先頭から再生 (icon 最初から再生, `DTXViewerで先頭から再生します。`), 現在位置から再生 (icon 再生), 現在位置からBGMのみ再生 (icon BGMのみ再生), 再生停止.
9. `toolStripComboBox演奏速度` (`DTXViewerでの再生速度を指定します。 (#DTXVPLAYSPEED)`). Separator.

Enable states mirror the menus (CMainForm.cs:1869-1872, 2059-2060, 2100-2120). Toolbar Paste uses the same mouse-or-bottom rule as the menu (4729-4749).

---

## 4. Score context menu (selection mode only)
Opened by right-click in 選択モード (CSelectionModeManager.cs:171-176 → CMainForm.cs:1882-1922). Items (Designer.cs:1474-1487; ja.resx:733-796):
- 選択チップの切り取り(&T), 選択チップのコピー(&C), 選択チップの貼り付け(&P), 選択チップの削除(&D).
- Separator.
- すべてのチップの選択(&A); `レーン内のすべてのチップの選択(&L) []`; `小節内のすべてのチップの選択(&R) []`.
- Separator. 小節長の変更(&B). Separator. 小節の挿入(&I), 小節の削除(&D).

Behavior:
- On open, the `[...]` in the lane and measure items is regex-replaced with the clicked lane name and 3-digit measure, e.g. `[SD]`, `[003]` (CMainForm.cs:1904-1917).
- The mouse position at open is stored and reused by the lane, measure, length, insert and delete items. Paste instead uses the menu's own top-left (2598-2609).
- The three "select all" items force selection mode (2615-2680).
- 小節の挿入 inserts an empty measure at the clicked number and pushes it and all later measures up by +1 (1191-1249; manual `上に押し上げたい小節の中で`, `MAN/使い方/小節を挿入、削除する.html:27`).
- 小節の削除 deletes the measure's chips (undoable) and shifts later measures down. At least one measure always remains (1250-1350).
- 小節長の変更 opens `CChangeMeasureLengthDialog`: title `小節長変更`, fields `小節番号`, `小節長の倍率(&R)` (3 decimals, step 0.05, min 0.001) and `後続の小節の倍率もすべて変更する(&F)`. Chips at grid ≥ the new height are deleted (CMainForm.cs:1055-1190; Designer of the dialog lines 44-55; ja resx 127-143).

---

## 5. Modes: 選択モード and 編集モード

### 5.1 Switching
- The state lives in the toolbar buttons' CheckState (CMainForm.cs:56-77).
- `t選択モードにする` checks the select button and menu item and unchecks the edit ones (1837-1843).
- `t編集モードにする` first deselects all chips and repaints, then checks the edit items (1844-1852).
- Ways to switch: toolbar buttons (4820-4827), 編集 menu items (4540-4547), モード切替 Ctrl+Space (4548-4558). Select-all and the context-menu select items force selection mode.
- Initial mode on startup and on every New/Open: `AppSetting.InitialOperationMode` (false = 編集モード, the default) (CMainForm.cs:385-394, 640-647; AppSetting.cs:356-371, 50).
- Score mouse events dispatch to the active manager (CMainForm.cs:2318-2367). Click always focuses the PictureBox (2322). MouseDown is used only by selection mode. MouseLeave is used only by edit mode.

### 5.2 Edit-mode operations
Code is CEditModeManager.cs; the manual table is `MAN/使い方/編集モード.html:17-23`.
- **Top 20 px (`e.Y < 20`), lane binding:**
  - Left-click binds the current list number (row+1) as the lane's front binding. Ctrl+left-click binds the back binding.
  - Right-click (or Ctrl+right-click) sets the binding to 0.
  - Pattern lanes (GtR…BsP) are ignored. Each change is an undo cell (lines 22-53).
  - Bindings are saved as `#DTXC_LANEBINDEDCHIP: {lane:00} {front b36} {back b36}` (CDTXInputOutput.cs:2775-2786).
- **Left-click on a lane** places or replaces a chip at the snapped grid. Any existing chip on that lane and grid is removed first, whether front or back (ScoreManager.cs:319-339).
  - Ctrl places on the back channel.
- **The number placed** is the lane binding (front, or back with Ctrl) unless that binding is 0 or **Shift** is held. Otherwise it is `n現在選択中のWAV_BMP_AVIリストの行番号0to1294 + 1` (lines 239-244).
- **GtV / BsV lanes:** the chip is placed, and if no R/G/B chip exists at that grid in lanes +1..+3, an OPEN chip (value 2) is auto-placed in lane+1 inside one transaction (184-198).
- **Gt/Bs pattern lanes:** the value is 1. Ctrl places OPEN (value 2) on the GtR or BsR lane (199-236).
- **BPM lane:** opens `CNumericInputDialog` (title `数値入力`, message `BPM値を設定して下さい。`).
  - Initial value: the BPM in effect at that grid. Range 0.0001–1000. Placed below the cursor.
  - The float is mapped to an existing `#BPMxx` with an equal value, or else the first free key 1..1295 (249-283; Resources.ja-JP.resx:120).
- **Sound on placement:** if `PlaySoundOnWAVChipAllocated`, a WAV, GtV or BsV lane plays the placed WAV, except a BGM-flagged WAV when `NoPreviewBGM` is set (284-296).
- **Right-click on a lane** deletes the chip whose grid equals the snapped cursor grid **exactly** (298-301, ScoreManager.cs:260-318). Pattern-lane deletes also remove an OPEN chip at that grid.
- The manual's `Ctrl + Alt + 左クリック` 代替チャンネル has no implementation. There are no `Keys.Alt` references anywhere in `Code/`.

### 5.3 Selection-mode operations (manual `MAN/使い方/選択モード.html:17-25`; details belong to another spec)
- Click selects. Drag a box to select. Ctrl adds. Ctrl+right-click deselects. Dragging selected chips moves them. Right-click opens the context menu.
- While dragging, the score auto-scrolls when the mouse is within 70 px of the top (`-(70-y)/2` grid per move) or 50 px of the bottom (CSelectionModeManager.cs:489-529).

---

## 6. Guide (snap) division
- **Values:** `n分 ∈ {4, 8, 12, 16, 24, 32, 48, 64, 0 (Free)}`.
  - `n現在のガイド幅grid = (n分==0) ? 1 : 192/n分`, giving 48, 24, 16, 12, 8, 6, 4, 3, and 1 for Free (CMainForm.cs:2184-2195).
  - So 1/64 = 3 grid and Free = 1/192 of a measure.
- **Toolbar combo** items: `1/4, 1/8, 1/12, 1/16, 1/24, 1/32, 1/48, 1/64, Free`, at index 0–8 (CMainForm.resx:2415-2439; not localized). Index maps to n分 in CMainForm.cs:4779-4819.
- **Menu:** 表示 → ガイド間隔 radio-style check items (2202-2260; handlers 4582-4617).
- **拡大(&W) F3** makes the guide coarser: 64→48→32→24→16→12→8→4. Free goes to 64; 4 stays 4.
- **縮小(&N) F4** makes it finer: 4→8→…→64→Free; Free stays Free (4618-4647).
- **Default:**
  - Every `t譜面を初期化する` (startup, New, Open) calls `tガイド間隔を変更する(16)` (619). The field default is also 16 (2077).
  - At startup only, the persisted `GuideIndex` (default 3 = 1/16, range clamped 0..8) is applied afterwards (CMainForm.cs:341-347; AppSetting.cs:155-173, 496).
  - So New/Open resets the guide to 1/16 regardless of the saved setting.
- Guide changes are not undoable (343), unlike most property changes.
- The guide affects cursor snapping (§1.5), paste position, and right-click delete targeting. It does not quantize existing chips.
- Manual: guide lines keep a constant interval even when the measure length changes (`MAN/画面構成/譜面.html:136`).

---

## 7. Zoom (縦方向倍率)
- Combo items `Default, x2 … x10` at index 0–9 (CMainForm.resx:2379-2406; not localized).
- `CMeasure.n基準の高さdot = 192 * (index+1)`, then Refresh (CMainForm.cs:4773-4778). Only the vertical axis scales; lanes stay 30 px.
- Persisted as `HViewScaleIndex` (default 0, clamped 0..9) and applied at startup without undo (CMainForm.cs:334-340, 444-446; AppSetting.cs:189-207). It is not reset by New/Open.
- **INFERRED:** because scroll state is kept in grid units (the bottom-edge grid), zooming keeps the bottom edge anchored.

---

## 8. Navigation

### 8.1 Mouse wheel
The handler is attached to the split container (CMainForm.cs:180, 2493-2566).
- **Plain wheel:** `lines = (-Delta * SystemInformation.MouseWheelScrollLines)/120`, and `vScroll.Value += lines*16`, clamped to `[Min, Max+1-LargeChange]`.
  - Wheel-up (Delta>0) lowers Value, which raises the bottom edge and moves later into the song.
  - With the Windows default of 3 lines, one notch is 48 grid = one beat. The code comment `１行＝１拍（64/4=16グリッド）` is stale (from the old 64-grid measure).
- **Shift+wheel:** horizontal scroll by `lines*16` px.
- **INFERRED:** the wheel reaches the handler only when the focused control is inside the split container.

### 8.2 Keyboard
- Only `PreviewKeyDown` on the score PictureBox is handled (CMainForm.cs:2445-2491):
  - **PageUp** (`Keys.Prior`): Value -= 192 (one x1.0 measure later).
  - **PageDown**: Value += 192 (one measure earlier). Both are clamped.
- Arrow keys, Home and End are not handled anywhere in Code/ (grep: no other `Keys.*` navigation).
- The PictureBox has `TabStop=false` (Designer.cs:835). It gets focus by click (2322) or by mouse-enter when `AutoFocus` is on (2341-2349, default true).
- The WAV list likewise auto-focuses on mouse-enter (4066-4074). This makes the score/list keyboard target follow the mouse.

### 8.3 "Current position"
- Defined as the measure containing the **bottom edge** of the visible score: `p譜面先頭からの位置gridを含む小節を返す(n現在の譜面表示下辺…)` (CMainForm.cs:1609-1610, 1655).
- Used by play-from-current and by menu/toolbar paste when the mouse is not over the score (4515, 4741).
- Manual: `現在表示されている譜面の最下層の小節から` (`MAN/画面構成/ツールバー.html:84`) and `一番下から` (`MAN/使い方/チップを切り取り、コピー、貼り付けする.html:47`).

---

## 9. WAV tab

### 9.1 List
- `listViewWAVリスト`: VirtualMode, VirtualListSize 1295 (rows 01..ZZ), Details view, FullRowSelect, GridLines, MultiSelect=false, HideSelection=false (Designer.cs:554-577).
- Rows are produced from `CWAVCache`. A row is created on demand with defaults (CMainForm.cs:4075-4078; CWAVListManager.cs:31-34).

| col | ja header | EN | default width | content |
|---|---|---|---|---|
| 0 | ラベル (ja.resx:307) | Label | 80 | `strラベル名` |
| 1 | (No, not localized) | No | 28 | 2-digit base36 number |
| 2 | ファイル (310) | File | 80 | `strファイル名`, relative to the DTX folder |
| 3 | 音量 (313) | Vol. | 40 | 0..100, default 100 |
| 4 | 位置 (316) | Pos. | 40 (resx) / 60 (AppSetting default) | pan -100..100, default 0 |
| 5 | (BGM) | BGM | 34 | `o` if BGM-flagged |

- Widths come from CMainForm.resx:1198-1228 and AppSetting.cs:36-40. CWAV defaults and formatting: CWAV.cs:12-19, 77-94.
- Only 5 widths are persisted (`SoundListColumnWidth.Length != 5` resets the settings; CMainForm.cs:286, 324-325, 432-433). The BGM column width is not saved.

### 9.2 The "current chip number" for placement
- One shared row index `n現在選択中のWAV_BMP_AVIリストの行番号0to1294` exists for **all three lists** (CMainForm.cs:85).
- Any WAV, BMP or AVI `SelectedIndexChanged` calls `tWAV_BMP_AVIリストのカーソルを全部同じ行に合わせる(i)`. That selects and focuses row i in all three lists and stores i (2016-2026, 4079-4087).
- It is reset to row 0 (number 01) on every New/Open (559).
- The placed value is i+1 on any lane type (WAV, BMP, AVI), unless overridden by the lane binding (§5.2).
- Selecting a chip-palette entry also sets it, and switches to that entry's tab (CChipPalette.cs:187-196).

### 9.3 Preview
- **List click:** plays the clicked row if the preview switch is on (CMainForm.cs:4009-4020).
  - It does **not** check `NoPreviewBGM`, even though the option text and manual say BGM rows are not auto-previewed (`MAN/使い方/オプション.html:36`). The check exists only in edit-mode placement (CEditModeManager.cs:292).
  - Keyboard row changes do not preview, because preview lives in `Click` only.
- WAV toolbar, docked at the bottom of the tab (Designer.cs:605-614):
  - 上移動 / 下移動: `選択行を１つ上/下に移動します。`
  - 試聴 (`選択されている行のプレビュー音を再生します。`) / 試聴停止
  - 試聴有効・無効 toggle (`行をクリックしたときにプレビュー音を再生します。`), **default Checked** (Designer.cs:661-663).
  - Unchecking disables 試聴 and 試聴停止 and stops any playing preview (CMainForm.cs:4089-4126).
- Playback (CWAVListManager.cs:198-227):
  - Stop the previous preview.
  - `CSoundManager.tGenerateSound(absPath)` with `nVolume = 音量`, `nPosition = 位置`, then start.
  - Exceptions are swallowed. The path is resolved relative to the work folder unless absolute (CMainForm.cs:2027-2045).
  - A 300 ms timer pumps streaming (CWAVListManager.cs:26-29).

### 9.4 Row operations
- **Double-click or Enter** opens サウンドプロパティ for the selected row (CMainForm.cs:4021-4031, 4052-4065).
- **上移動 / 下移動** swap the row with its neighbor (row 0 and row 1294 are bounds). The swap also fixes up chip values on WAV/GtV/BsV lanes, lane bindings, and palette entries. It is undoable and sets modified (CMainForm.cs:4127-4154; CWAVListManager.cs:56-73, 266-351; manual `MAN/画面構成/WAVタブ.html:63`).
- **ItemDrag** starts a drag of `CDataForChipPaletteDragDrop {n種類=0, label, number, file, colors}` for dropping onto the chip palette (CMainForm.cs:4032-4051).

### 9.5 サウンドプロパティ dialog (`CSoundPropertiesDialog`)
- Title `サウンドプロパティ`, FixedDialog (ja.resx:285; Designer:266). Fields:
  - `WAV番号`: read-only textbox showing the number in the row's colors.
  - `背景色` / `文字色`: ColorDialog FullOpen, with custom colors shared statically across dialogs. `標準色に戻す` resets to Window/WindowText.
  - `ラベル`.
  - `ファイル名` + `参照...`: OpenFileDialog titled `サウンドファイルの選択`, filter `サウンドファイル(*.wav;*.ogg;*.mp3;*.xa)|…|すべてのファイル(*.*)|*.*`. The result is made relative to the work folder.
  - `このサウンドをBGMとして使用する`.
  - `音量`: textbox + scroll bar 0..100 (Maximum 109 with default LargeChange 10), labels `無音` / `原音`.
  - `位置`: textbox + scroll bar 0..200 mapped to -100..100, labels `左` / `中央` / `右`.
  - `試聴`, OK / `キャンセル`.
  - Sources: CSoundPropertiesDialog.cs; Designer:111, 136, 187-203; ja.resx:120-285; Resources.ja-JP.resx:141-144.
- Text values are clamped on Leave or Enter. Enter in any text field means OK; Esc means Cancel (CSoundPropertiesDialog.cs:25-60, 67-150).
- On OK, if anything differs, an undo cell is added, the cache and row are updated, and modified is set (CWAVListManager.cs:120-179).
- **Quirk:** `試聴` plays the **stored** cache entry by number (`dgサウンドを再生する(num)` goes to `tプレビュー音を再生する(int)`), not the unsaved dialog values (CSoundPropertiesDialog.cs:205-209; CWAVListManager.cs:216-220). The manual claims `現在の設定状態を試聴` (`MAN/画面構成/サウンドプロパティ.html:75`).

### 9.6 Serialization
For each number 1..1295 with a non-empty file, in tDTX出力_WAVリスト (CDTXInputOutput.cs:2648-2677):
```
#WAVxx: <file>[\t;<label>]
#VOLUMExx: <vol>     (only if != 100)
#PANxx: <pan>        (only if != 0)
#BGMWAV: xx          (if BGM-flagged)
```
- Non-default row colors are written as `#DTXC_WAVFORECOLOR: <decimal number> <#html>` and `#DTXC_WAVBACKCOLOR: …` (2678-2697).

---

## 10. Chip palette (`CChipPalette`)
- Floating window: SizableToolWindow, TopMost, not in the taskbar, AllowDrop (Designer:185-197). Title `チップパレット` (ja.resx:277).
- The list has columns Label / No / File and Details view by default.
- `表示形式(&V)` split button offers `大きいアイコン(&N) / 小さいアイコン(&S) / 一覧(&L) / 詳細(&D)`. Up/down buttons. Context menu `パレットから削除(&D)` (CChipPalette.cs:141-164, 197-204; ja.resx:124-271).
- Entries are added by dragging rows from the WAV, BMP or AVI list (DragDrop; CChipPalette.cs:110-121).
- Selecting an entry sets the shared current number and switches the tab (`ImageIndex+1`) (187-196).
- Reordering sets modified (79-101). Add and remove do **not** set modified.
- Closing only hides it (122-129). Show and hide are synced with the toolbar and menu checks (61-74).
- It is hidden at start: the toolbar and menu checks start unchecked; no Checked set in the Designer, **INFERRED**.
- It is recreated on each New/Open, centered on the main form, and shown if the toolbar check is on (CMainForm.cs:569-581).
- Every modal dialog temporarily hides it (`t一時的に隠蔽する` / `解除`).
- It is persisted in the DTX as `#DTXC_CHIPPALETTE:  {imageIndex},{number} …` (CDTXInputOutput.cs:2766-2774).
- Manual: `MAN/使い方/チップパレットを使う.html:30`.

---

## 11. 基本情報 tab and 自由入力 tab

### 11.1 Fields
Ja labels are from ja.resx; the header mapping is from CDTXInputOutput.cs:2698-2765 (output) and 734-867 (input).

| label | control | header | notes |
|---|---|---|---|
| 曲名 (283) | textBox | `#TITLE` | empty → writes `#TITLE: (no title)` |
| 製作者 (274) | textBox | `#ARTIST` | written if non-empty |
| コメント (262) | textBox | `#COMMENT` | |
| BPM (EN resx:934, not localized) | NumericUpDown, 2 decimals, 0..9999, default 120 | `#BPM` | written if != 0; on load an unparsable value becomes 120 (Designer.cs:503-517; CDTXInputOutput.cs:794-803) |
| DrumLv. / GuitarLv. / BassLv. (EN resx:844/753/663) | textBox + hScrollBar (Maximum 999) | `#DLEVEL` `#GLEVEL` `#BLEVEL` | written if != 0; new chart DLEVEL 50, G/B 0 (CMainForm.cs:533-538); on load reset to 0 first, then clamped 0..999 (CDTXInputOutput.cs:48-55, 805-866); typed values are validated only on Leave and clamped **0..100** (CMainForm.cs:3087-3116) |
| パネル文 (217) | textBox | `#PANEL` | a numeric `#PANEL` value is treated as a pan, not panel text (CDTXInputOutput.cs:754-763) |
| Preview音 (187) | textBox + `...` | `#PREVIEW` | `...` opens a sound dialog with a relative path (CMainForm.cs:3915-3932) |
| 選曲画像 (175) / Loading画像 (166) / 背景画像 (154) / 結果画像 (142) | textBox + `...` | `#PREIMAGE` / `#STAGEFILE` / `#BACKGROUND` (also reads `#WALL`) / `#RESULTIMAGE` | image filter `画像ファイル(*.bmp;*.jpg;*.jpeg;*.png)` (Resources.ja-JP.resx:201) |

- Tooltips for the level fields: `ドラムの難易度を、(易) 1～99 (難) で設定します。999まで設定することもできます。` (ja.resx:244-250).
- **INFERRED:** with the default LargeChange of 10, the level scroll bars stop at 990.
- The manual says `1～100` (`MAN/画面構成/基本情報タブ.html:47`).
- Also not written by the editor, but loaded: `#PATH_WAV` (temp only), and `#DTXVPLAYSPEED`, which feeds the speed combo (§12.4).

### 11.2 Edit semantics
- Each TextChanged adds an undo cell, or extends the top cell while the same control still "owns" it.
- Leave releases ownership, so consecutive keystrokes in one field become one undo step.
- Every change sets modified.
- Undo and redo switch to the 基本情報 tab and focus the field (CMainForm.cs:2772-2847, same pattern for every field).
- Loader-driven assignments suppress undo via `CUndoRedoManager.bUndoRedoした直後 = true`.

### 11.3 自由入力
- `textBox自由入力欄`: multiline, AcceptsReturn, AcceptsTab, Dock Fill (Designer.cs:823-828).
- Undo works as in §11.2 (CMainForm.cs:4369-4447).
- On load, every `#` command that the parser does not handle is appended as `#cmd: param[\t;comment]` (CDTXInputOutput.cs:93-101, 111-112).
- On save it is written verbatim near the top, after the title block (2787-2796; output order 28-45).
- Manual: `MAN/使い方/自由入力-未対応の命令を記述する.html:15-25`.

---

## 12. Playback (再生) via an external viewer
DTXCreator has no internal sequencer. It writes a temporary DTX and spawns the viewer process.

### 12.1 Viewer selection and gating
- Path = `ViewerInfo.bViewerIsDTXV ? ViewerInfo.PathDTXV : (DTXC folder + "DTXManiaNX.exe")`.
- Defaults: `bViewerIsDTXV = false`, `PathDTXV = CurrentDirectory + @"\dll\DTXV.exe"` (AppSetting.cs:380-411; CMainForm.cs:1554).
- The four play commands are enabled only if that file exists. This is evaluated on every chart init and after Options OK (CMainForm.cs:2094-2122, 613; COptionsManager.cs:141).
- Manual: these are usable only if DTXViewer is in the same folder (`MAN/使い方/DTXViewerで再生する.html:38`).

### 12.2 Temp file (`tViewer用の一時ファイルを出力する`, CMainForm.cs:1705-1757)
- **Reuse:** if `b前回から更新があった` is false and the previous temp file still exists, the old file is reused.
- **Otherwise:**
  1. Clear `b再生速度を変更した` and `bDTXファイルを開いた`.
  2. Get a new name from `MakeTempDTX.GetTempFileName()`: `Path.GetTempFileName()` (`%TEMP%\tmpXXXX.tmp`), deleting the previous temp (MakeTempDTX.cs:33-62).
  3. Set `strPATH_WAV = work folder`, so the temp gets `#PATH_WAV: <folder>` and relative paths resolve (CDTXInputOutput.cs:2757-2760).
  4. If the current culture's decimal separator is `,`, switch to `en-GB` for the write.
  5. Write cp932 (`0x3a4`) through the same `tDTX出力` as Save, with `bBGMのみ出力` passed through.
  6. Restore `strPATH_WAV = ""` in `finally`.
- The temp file is deleted at exit (`makeTempDTX.Dispose()`, CMainForm.cs:250-253).
- After every Save the temp name is cleared, which forces regeneration (937-939, 1758-1761).
- "Changed" flag per command:
  - Full play: `b未保存 | !b前回BGMありで再生した | b再生速度を変更した | bDTXファイルを開いた`, then sets `b前回BGMありで再生した = true` (1545-1546, 1590-1591).
  - BGM-only: `b未保存 | b前回BGMありで再生した | …`, then sets it to false (1637-1638).
  - `bDTXファイルを開いた` is set at every chart init (659-663).

### 12.3 Command lines
`Process.Start(path, args).WaitForInputIdle(20 s)`. Arguments are concatenated without separators (CMainForm.cs:1565-1568, 1612-1615, 1656-1659, 1686):

| command | args |
|---|---|
| 先頭から再生 (F5) | `PlayViewerOption + PlaySoundOption + "-N-1" + " \"" + temp + "\""` |
| 現在の位置から再生 (F6) | `PlayViewerOption + PlaySoundOption + "-N" + <measure number of the bottom-edge measure> + " \"temp\""` |
| 現在の位置からBGMのみ再生 | same as F6, but the temp is written with only BGM-flagged `#WAV` entries; other chips then reference undefined WAVs and are silent (**INFERRED**); manual `MAN/使い方/DTXViewerで再生する.html:32` |
| 再生停止 (F7) | `"-S"` alone, as a separate process launch (`停止のときは１回のプロセス起動で完結(BMSV仕様)`) |

How the options are built (AppSetting.cs:413-466):
- `PlayViewerOption` = `""` for DTXV, else `"-R" + ViewerHeightResolution` (default 360).
- `PlaySoundOption` = `""` for DTXV, else `"-D" + {D | WE | WS | A<n>} + GRmode(Y/N) + TimeStretch(Y/N) + VSyncWait(Y/N)`.
- Default sound type: Win10+ SharedWASAPI, Vista+ ExclusiveWASAPI, else DirectSound (AppSetting.cs:404-406).

Example with all defaults on Win10 (**INFERRED** assembly): `DTXManiaNX.exe -R360-DWSNNY-N-1 "C:\…\Temp\tmpA1B2.tmp"`.

Viewer-side parsing (NX):
- `-R<h>` is read up to the next `-` and sets width = h*16/9. `-D…` sets device and flags. `-N<int>` is read up to a space, with the rest taken as the quoted filename. `-S` means Stop (CCommandParse.cs:39-46, 83-90, 91-192, 193-219, 286-311).
- On stage start in DTXV mode, DTXMania calls `tJumpInSongToBar(nStartBar + 1)`. The +1 compensates for the parser's empty lead-in measure (`n小節番号++; // 先頭に空の1小節を設ける。`), so `-N-1` means the true top (CStagePerfDrumsScreen.cs:191-195; CDTX.cs:6626).
- The jump goes to the time of the first chip with position ≥ 384*bar (CStagePerfCommonScreen.cs:5591-5606). **INFERRED:** bar-line chips at every 384 (CDTX.cs:3661-3664) make that the measure start.
- A failed launch shows `プロセスの起動に失敗しました。` with title `エラー` (Resources.ja-JP.resx:165, 135; CMainForm.cs:1572-1582).

### 12.4 Play speed (`toolStripComboBox演奏速度`)
- Items `x1.5, x1.4, …, x1.0 (index 5), …, x0.5` (CMainForm.resx:2530-2560).
- Set to index 5 at startup; not persisted (CMainForm.cs:348-352).
- A change sets `b再生速度を変更した` (forces temp regeneration) but **not** modified (4850-4853).
- Written as `#DTXVPLAYSPEED: (1.5 - index*0.1)` (C# float formatting) whenever index ≠ 5, both to the temp **and to the saved DTX** (CDTXInputOutput.cs:2761-2764).
- On load, the value is clamped to 0.5..1.5 and mapped back to an index (868-896). An unparsable value becomes 0 → clamped to 0.5 → index 10.
- Not reset by New, since `t譜面を初期化する` never touches it. **INFERRED:** a speed loaded from one file carries into a new chart.

---

## 13. File operations

### 13.1 Modified flag and title (CMainForm.cs:102-147)
- `b未保存`'s setter acts only on a value change.
- Title is `"DTXC NX *[" + name + "]"` when modified, else `"DTXC NX [" + name + "]"`. Name = `strDTXファイル名` or `新規` (Resources.ja-JP.resx:153).
- 上書き保存 (menu and toolbar) is enabled iff modified.
- The initial backing value is `true` (2072). Init ends with `false`, so a fresh window shows `DTXC NX [新規]`.
- After any load, the code does `b未保存 = true; b未保存 = false;` to refresh the title (860-865).
- Undo and redo set modified (e.g. ScoreManager.cs:521, 536). There is no "saved point" tracking.

### 13.2 Unsaved-changes prompt (`t未保存なら保存する`, CMainForm.cs:2147-2171)
- Used by New, Open, drag-and-drop, recent-file click and close.
- If modified: MessageBox YesNoCancel, Question icon, text `編集中のデータを保存しますか？`, title `確認` (Resources.ja-JP.resx:210, 204).
- Yes runs 上書き保存. Cancel aborts the caller.
- Close: `FormClosing` cancels only on Cancel, else runs the exit routine (2298-2308).
- **Code fact:** on a never-saved chart, Yes followed by cancelling the Save dialog still returns Yes, so the window closes without saving.

### 13.3 New (484-520)
- Prompt, popup `初期化中です。` + `しばらくお待ち下さい。`, then `t譜面を初期化する` (521-664). It:
  - clears all 基本情報 fields (BPM 120, DLEVEL 50);
  - recreates the WAV/BMP/AVI managers and resets the current row to 01;
  - clears free input and recreates the palette;
  - builds a new ScoreManager, keeping lane visibility by index;
  - sets the guide to 1/16, resets undo, applies the initial mode, and sets modified=false.
- The work folder is **not** reset (only `strDTXファイル名 = ""`).

### 13.4 Open, drag-and-drop, command line (669-866, 2279-2297, 228-234)
- OpenFileDialog: title `読み込むDTXファイルの選択`, filter `DTXファイル (*.dtx;*.gda;*.g2d;*.bms;*.bme)|…|すべてのファイル(*.*)|*.*`, initial dir = work folder (Resources.ja-JP.resx:126-129).
- Drag-and-drop on the form takes the first file only. The first command-line argument is opened if it exists.
- Load steps:
  1. A missing file gives `ファイルが存在しません。`; an extension outside dtx/gda/g2d/bms/bme gives `DTXファイルではありません。`.
  2. Popup `読み込み中です。`.
  3. Init, then read the whole file as **cp932**, then parse.
  4. Set `strDTXファイル名 = ChangeExtension(name, ".dtx")` (forced) and work folder = the file's folder.
  5. Add to recent files, using the forced .dtx name.
- Non-DTX imports set modified=true (847-849), but it is then forced back to false (862-863). This is a quirk.

### 13.5 Save and Save As (871-1028)
- **上書き保存:**
  1. Popup `保存中です。`.
  2. If there is no file name yet, show the Save dialog.
  3. Deselect all if in selection mode.
  4. Write `<folder>\<name>` through `StreamWriter(…, false, cp932)`. **INFERRED:** CRLF newlines (the Windows default).
  5. Add to recent files, clear the viewer temp name, set modified=false.
- On the first save the dialog result sets the folder and name, and all WAV/BMP/AVI paths are made relative (886-907).
- **Code fact:** if that first-save dialog is cancelled, the method returns at 895 without closing the `保存中です` popup.
- **名前を付けて保存:** dialog, re-relativize the paths, then 上書き保存, then refresh the title (953-992).
  - The dialog title is hard-coded `名前をつけて保存` and the filter is `DTXファイル(*.dtx)|*.dtx`. It does not use the Resource strings. `.dtx` is appended when there is no extension (993-1028).
  - **INFERRED:** `tファイル名の相対パス化` builds `new Uri(file)`, which throws on already-relative paths, and the throw is swallowed. So only absolute paths are rebased, and existing relative paths keep pointing relative to the new folder.
- There is **no autosave, no backup (.bak), and no crash recovery**. Nothing in the read files writes any file except the save target, the temp DTX, and the settings XML.

### 13.6 Recent files (1923-2015, 4473-4482; AppSetting.cs:57-87)
- MRU list capped at 10 entries, most recent first, duplicates removed.
- Shown under 終了 after an auto-inserted separator, up to `RecentFilesNum` items, only if `ShowRecentFiles`.
- Item text is `&{i} {path}`. Items for missing files are disabled. A click prompts to save, then loads `Text.Substring(3)`.

---

## 14. Options dialog and persisted settings

### 14.1 Dialog (`COptionsDialog`, title `オプション`)
ControlBox off. Enter = OK, Esc = `キャンセル` (COptionsDialog.cs:48-66; Designer:395-426).
- **全般:**
  - `オートフォーカス(&F)`
  - `最近使用したファイルの一覧(&R)：` + NumericUpDown 1..10 + `個まで表示する(&T)`
  - `BGMサウンドのプレビューは自動再生しない`
  - `WAVチップを譜面に配置したときにチップの音を再生する`
  - group `初期モード` with `選択モード` / `編集モード`
  - Sources: COptionsDialog.ja-JP.resx:156-243; Designer:170-188.
- **使用レーン:** `使用するレーンを選択して下さい。` plus a CheckedListBox of ELaneType names, one per type: `BPM, Drums, BGM, SE1_5, SE6_32, Guitar, Bass, AVI1_2, BGA1_5, BGA6_8`.
  - Checked = visible. On OK each lane gets its type's state (COptionsDialog.cs:22-37; COptionsManager.cs:80-86).
- **Viewer:**
  - group `Viewerの設定`: `DTXViewerを使う(&V)` with a path box and `...`, or `DTXManiaGRを使う(&M)` (EN `Use DTX&ManiaNX.exe`).
  - `サウンド再生方式の設定 (*)`: `DirectSound(&D)`, `WASAPI排他(&W)`, `WASAPI共有(&H)`, `ASIO (ASIO対応デバイスで使用可)(&A)` + device combo. ASIO is disabled if the only device is "None".
  - `Window Size (*)`: 640x360 / 960x540 / 1280x720 / 1920x1080.
  - `他のDTXManiaGRの設定`: `ギター専用画面(&G)`, `TimeStretch使用(&T)` with the note `(WASAPI/ASIO使用時のみ、再生速度 x0.8 - x1.2 の範囲で使用可能です)`, `垂直同期待ちをする(&V)`.
  - Notice `(*) 設定変更時、Viewerの再起動が必要です。`
  - Choosing DTXViewer disables the sound and size groups (COptionsDialog.cs:68-92; COptionsManager.cs:32-66, 88-143; ja.resx:273-398).
- On OK: settings are stored, viewer gating is re-evaluated, the MRU menu is rebuilt, and lanes are refreshed (COptionsManager.cs:70-146; CMainForm.cs:4672-4676).

### 14.2 Persistence
- File: `<exe folder>\DTXCreatorSetting.config`, XmlSerializer of `AppSetting`.
- Loaded at startup (CMainForm.cs:255-395) and saved in the exit routine after a non-cancelled close (396-479, 2306).
- The settings reset to defaults on a deserialization error, wrong column-array lengths (5/4/3), or `ConfigVersion != 0x69` (CMainForm.cs:263-298; AppSetting.cs:105-108, 493).
- `Confirm()`: `RecentFilesNum ≤ 0` becomes 5 with ShowRecentFiles=false; `> 10` becomes 10 (109-120).

| key | default | applied |
|---|---|---|
| X, Y, Width (600), Height (0x1db=475), Maximized | — | `SetDesktopBounds`; minimized is normalized before saving |
| SplitterDistance | 296 | |
| Sound/Graphic/MovieListColumnWidth | [80,28,80,40,60] / [34,127,28,120] / [127,28,120] | |
| HViewScaleIndex | 0 (0..9) | zoom |
| GuideIndex | 3 (0..8) | guide, startup only |
| LastWorkFolder | current dir | becomes the current directory if it exists |
| LanesInfo | per-lane {Name, Checked} | visibility restored by name |
| RecentUsedFile / ShowRecentFiles / RecentFilesNum | [] / true / 5 | |
| AutoFocus / NoPreviewBGM / PlaySoundOnWAVChipAllocated | true / true / true | |
| InitialOperationMode | false (編集モード) | |
| ViewerInfo | see §12.3 | |

Defaults: AppSetting.cs:34-51, 490-513.

---

## 15. Startup and shutdown
- `Program.Main`: visual styles, then `Application.Run(new CMainForm())` (Program.cs:12-24).
- `Load` → `tアプリ起動時に一度だけ行う初期化処理` (CMainForm.cs:157-235, 2309-2313):
  1. Create the settings object; exe folder = current directory.
  2. Hook the wheel; create options, clipboard and MakeTempDTX.
  3. Init the chart, then load the settings (after the chart, because GUI events need the managers).
  4. Center the palette, build the MRU menu, open the command-line file.
- **Exit:** save the settings, release DirectSound and the timer, delete the temp DTX (236-254).
- Modal waits use `CMessagePopup`: a small modeless form centered on the owner, "MS PGothic" 10pt (CMessagePopup.cs).

---

## Key facts
- **Layout:** a left tab panel (`基本情報 / WAV / BMP / AVI / Free`) beside a right score panel. The score is a black PictureBox whose width is the sum of lane widths (30 px each, 0 if hidden).
  - The horizontal scroll bar shifts the PictureBox. The vertical scroll bar is in grid units, docked at the form's right edge.
  - Time runs bottom to top: measure 000 at the bottom, `Value=0` shows the chart end.
- **Units:** 192 grid per x1.0 measure; measure height = int(192 * length ratio).
  - Zoom index 0–9 gives `dotPerGrid = index+1` (192–1920 px per measure). Chip height 9 px; a chip's bottom edge is on its grid line.
  - y → grid uses floor; the snapped grid = measure start + floor(offset/guide)*guide.
- **Drawing:**
  - Big 50pt translucent measure-number watermark.
  - Guide lines RGB(50,50,50) every guide (none in Free). Beat lines gray every 48 grid. Lane separators gray, or white 2 px on group boundaries. Measure lines white 2 px.
  - Top bands: lane-bound numbers at y 0–10, lane names at y 10–42.
  - Lane background = lane RGB at alpha 25. Front chip fill alpha 128 with bright top/left edges. Back chip inset 4 px L/R, 1 px T/B, alpha 80.
  - Label `X Y` (base36 with a space), MS Gothic 8 bold, white with a black shadow. Selection = white 2 px border.
- **Lane colors (RGB):** LC 223,95,127; HH 0,255,255; LP/LB 255,159,207; SD 255,255,0; HT 0,255,0; BD 191,191,255; LT 255,0,0; FT 255,127,0; CY 159,159,255; RD 0,255,255; FI/BN 255,255,0; BPM/BGM/SE/AVI/BG/GtV/BsV/GtW/BsW 160,160,160; Gt/Bs R 255,0,0, G 0,255,0, B 0,128,255, Y 255,255,0, P 255,0,255, L 240,192,160.
- **Lane order:** BPM, LC, HH(11/18), LP, LB, SD, HT, BD, LT, FT, CY, RD, FI, BN1–4, MLC/MHH/MCY/MRD, BGM, SE1–5, (SE6–S32 hidden), GtV…GtL, BsV…BsL, AVI, BG1–5, (BG6–8 hidden).
- **Shortcuts:** Ctrl+N/O/S, Ctrl+Z/Y, Ctrl+X/C/V, Del, Ctrl+A, Ctrl+Space (mode toggle), Ctrl+F/H, F3 (coarser guide), F4 (finer), F5 play from top, F6 play from current, F7 stop, F1 manual. No shortcut for Save As or BGM-only play. PageUp/PageDown = ±1 measure (192 grid).
- **Wheel:** `(-Delta*lines/120)*16` grid (3-line default = 1 beat per notch, wheel-up moves later). Shift+wheel scrolls horizontally. Arrow keys do nothing.
- **Modes:** 編集モード (default, set by `InitialOperationMode`) and 選択モード.
  - Edit: left = place or replace (Ctrl = back channel, Shift = ignore lane binding); right = delete the chip at the exact snapped grid; the top 20 px bind/unbind lane chips; the BPM lane opens a numeric dialog (0.0001–1000).
  - Selection: right-click opens a context menu with cut, copy, paste, delete, select all/lane/measure, measure length, insert and delete measure.
- **Guide:** 1/4, 1/8, 1/12, 1/16 (default), 1/24, 1/32, 1/48, 1/64, Free = 48/24/16/12/8/6/4/3/1 grid.
  - Set by toolbar combo, menu or F3/F4. Persisted as GuideIndex but reset to 1/16 on every New/Open.
- **Current chip number:** one shared row index across the WAV, BMP and AVI lists (selecting a row in one selects the same row in all). Placed value = row+1 unless a lane binding overrides. Reset to 01 on New/Open.
- **WAV list:** 1295 virtual rows with columns ラベル / No / ファイル / 音量 (0–100, default 100) / 位置 (-100..100) / BGM(o).
  - Click previews (default on, ignores NoPreviewBGM). Double-click or Enter opens サウンドプロパティ. Up/down renumbering rewrites chips, bindings and palette.
  - Output: `#WAVxx: file\t;label`, `#VOLUMExx` if ≠100, `#PANxx` if ≠0, `#BGMWAV: xx`.
- **Header fields:**
  - TITLE (empty → `(no title)`), ARTIST, COMMENT, BPM (0–9999, 2 decimals, default 120).
  - DLEVEL/GLEVEL/BLEVEL (typed values clamped 0–100, scroll bar to 999; new = 50/0/0).
  - PANEL, PREVIEW, PREIMAGE, STAGEFILE, BACKGROUND, RESULTIMAGE.
  - Unknown `#` lines are moved to the 自由入力 text and written back verbatim.
- **Playback:** writes `%TEMP%\tmpXXXX.tmp` in cp932, with `#PATH_WAV: <work folder>` and optional `#DTXVPLAYSPEED`. It then runs `DTXManiaNX.exe -R360-D<WS|WE|D|An><GR><TS><VS>-N<bar|-1> "temp"`; DTXV gets just `-N… "temp"`.
  - Stop is a separate `-S` launch.
  - The viewer jumps to bar+1 (its lead-in measure). "Current" = the measure containing the visible bottom edge.
  - The temp is regenerated when unsaved, after a speed change, after a load, or after switching BGM-only/full; otherwise it is reused.
- **Files:**
  - Opens .dtx/.gda/.g2d/.bms/.bme and always renames to .dtx. Reads and writes cp932.
  - Title `DTXC NX *[name]` when modified, `DTXC NX [name]` otherwise (`新規` when unnamed).
  - Unsaved prompt `編集中のデータを保存しますか？` (YesNoCancel, title `確認`) on New, Open, drag-and-drop, MRU and close.
  - MRU up to 10 (shown 1–10, default 5). No autosave, no backup.
- **Settings:** `DTXCreatorSetting.config` (XML, schema 0x69) next to the exe; window bounds, splitter, column widths, zoom, guide, work folder, lane visibility, MRU, options, viewer config.
  - Play speed is not persisted (x1.0 at startup) but is written into the DTX when ≠ x1.0.

## Open questions / porting notes
- **Playback model.** DTXCreator delegates playback to an external viewer through a temp file. The browser port already plays charts itself.
  - Map 先頭から再生 / 現在の位置から再生 / BGMのみ / 停止 to in-app actions: serialize the edited chart in memory, load it into the existing player, and start at the bottom-edge measure.
  - DTXMania's `bar+1` lead-in offset (CDTX.cs:6626) is an implementation artifact; do not copy it.
  - Decide whether "BGM only" should mute non-BGM WAVs (DTXCreator does this by omitting them from the temp `#WAV` list).
- **Key conflicts with DTXMania Web conventions (CLAUDE.md).**
  - `Space` is BD's default key and Ctrl combos must not be lane-bound. DTXCreator's Ctrl+Space mode toggle is fine as an editor-only shortcut, but the editor must not run while gameplay key capture is active.
  - F1 and Enter are reserved by `js/ui/keybind.js`. DTXCreator's F1 = manual and F5 (browser reload) must not be taken as-is: F5 conflicts with the browser and should be remapped.
  - Ctrl+N, Ctrl+W, Ctrl+Tab cannot be intercepted reliably in browsers.
- **Shortcut scoping.** DTXCreator's form-level shortcuts swallow Del, Ctrl+Z and Ctrl+V even while a text box is focused (**INFERRED**). The port should scope chip shortcuts to score focus and leave text inputs native.
- **Orientation and units.** Keep bottom-to-top time with 192-grid measures and floor snapping (simple to port). Alternatively, align with the existing renderer and vid2dtx's 384-tick, time-based highway.
  - vid2dtx (docs/spec/vid2dtx-edit.md) snaps by rounding in ticks of 384 and scrolls by seconds. DTXCreator floors in grid of 192 and scrolls by measure-relative grid.
  - Pick one model. **INFERRED:** 1/64 = 3 grid and Free = 1 grid lose precision for 1/128 or triplet-of-64 content at 192 grid; consider 384 internally.
- **Exact-grid deletion.** Right-click delete in DTXCreator needs the cursor's snapped grid to equal the chip's grid, so chips off the current guide cannot be deleted in edit mode. vid2dtx uses a pixel tolerance. A pixel-tolerance hit test is likely better UX; document the deviation if adopted.
- **Lane set for a drum-only web app.** DTXCreator shows ~49 lanes (SE, Gt/Bs, BGA, AVI). The port probably needs BPM, the drum lanes (LC HH LP LB SD HT BD LT FT CY RD), maybe BGM and FI, plus a visibility toggle per ELaneType like 使用レーン. Also decide:
  - HH front 11 / back 18 versus separate lanes. DTXCreator has a single HH lane where Ctrl = open; CY and RD are separate lanes.
  - Whether to keep the LP/LB split (1B/1C) or vid2dtx's merged LP column.
- **Current chip number.** DTXCreator's placement number comes from list selection plus per-lane bindings (front/back). vid2dtx auto-picks the most common (channel, id) per column. The port could combine these: per-lane binding defaulting to the most common WAV, overridable from a WAV list. Decide whether a shared WAV/BMP/AVI row index makes sense when there are no BMP/AVI tabs.
- **WAV preview.** Implement list-click preview and placement preview with Web Audio (volume 0–100 to gain, pan -100..100 to a stereo panner). Decide whether to honor `NoPreviewBGM` on list click, which DTXCreator does not, even though its manual says it does. Make サウンドプロパティ 試聴 play the edited (unsaved) values, which also fixes the original quirk.
- **File I/O in the browser.**
  - There is no filesystem path model. `#PATH_WAV`, relative-path rebasing and the work folder become "the song folder or ZIP the chart came from". Saving means download, or the File System Access API where available; no overwrite-in-place otherwise.
  - Keep cp932 output for compatibility (js/core/encoding.js likely has the decoder; **INFERRED** from the file name) and CRLF.
  - The modified flag and title asterisk map to a `beforeunload` prompt. DTXCreator has no autosave; a localStorage or IndexedDB draft would be a new feature (`dojo.*` keys) and should be marked as added per CLAUDE.md.
- **Header editing.** DTXCreator edits TITLE, ARTIST, COMMENT, BPM, DLEVEL, GLEVEL, BLEVEL, PANEL, PREVIEW, PREIMAGE, STAGEFILE, BACKGROUND and RESULTIMAGE, and pushes everything else into free text.
  - The vid2dtx save strategy is different: keep all non-drum lines verbatim and regenerate only drum object lines. That preserves unknown headers and comments better. Recommended for the port; note the deviation.
  - Level range: the DTXCreator textbox clamps 0–100 while the scroll bar and loader allow 999. Choose one; NX supports up to 999 and DLEVEL ≥ 100 means a 2-digit decimal. Check against docs/spec.
- **Undo.** DTXCreator has a transaction-grouped undo/redo (Ctrl+Z/Ctrl+Y) covering chips, measures, header fields (coalesced per field focus), lane bindings and WAV edits, and it never tracks a "saved point". vid2dtx has undo only. Decide whether to add redo and whether undoing back to the saved state should clear the asterisk (DTXCreator does not clear it).
- **Measure operations.** Insert, delete and length change (with "change all following") exist in DTXCreator via the context menu; vid2dtx has none. Decide scope. Auto-appending 4 empty measures when placing into the last measure is a cheap way to grow the chart.
- **Zoom.** x1–x10 integer vertical zoom anchored at the bottom edge; maps directly to a Canvas scale. Persist like `HViewScaleIndex`.
- **Unresolved code quirks; decide whether to replicate:**
  - The first-save cancel leaves the `保存中です` popup open.
  - Yes followed by cancelling the Save dialog on close discards the data.
  - BMS import's modified flag is forced false.
  - MRU records the forced `.dtx` name even when it does not exist.
  - The play speed survives New and is written into the file without setting modified.
  - The BG3 front channel 0x100 throws.
  - SE24–27 channels duplicate MHH/MCY/MRD/MLC.
  - The manual's `Ctrl+Alt` 代替チャンネル is unimplemented.
- **Not covered here (other specs):** CDTXInputOutput count/grid conversion and channel mapping on load and save, the selection-mode drag and move algorithm, clipboard paste semantics, the search and replace dialogs, and undo internals (`Code/01.UndoRedo`).
