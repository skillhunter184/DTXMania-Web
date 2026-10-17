# dtxcreator-edit

# DTXCreator: score data model and edit operations (behavioral spec)

Source root: `DTXmaniaNX\`. Files are cited by name only; every file name below is unique in the tree.
- `DTXCreator\Code\05.Score\`:
  - CChip.cs (225 lines), CLane.cs (131), CMeasure.cs (100), ScoreManager.cs (1062)
  - CEditModeManager.cs (331), CSelectionModeManager.cs (843)
  - CClipBoard.cs (127), CClipCell.cs (15)
  - CChipLocationUndoRedo.cs, CChipPositionUndoRedo.cs, CLaneAllocationUndoRedo.cs, CMeasureUndoRedo.cs
  - CChangeMeasureLengthDialog.{cs,Designer.cs,resx,ja-JP.resx}, CNumericInputDialog.*, CReplaceDialog.*, CSearchDialog.*
- `DTXCreator\Code\01.UndoRedo\`: CUndoRedoManager.cs (123), CUndoRedoDirectory.cs (59), CUndoRedoCell.cs (48), CUndoRedoCellAbstract.cs (38).
- `DTXCreator\Code\00.App\`:
  - CMainForm.cs (4855): scenarios (tシナリオ_*), mouse and keyboard dispatch, guide, zoom.
  - CMainForm.Designer.cs: event wiring.
  - CMainForm.resx / CMainForm.ja-JP.resx: menu texts and ShortcutKeys.
  - CDTXInputOutput.cs: cited only where load or save defines in-memory invariants.
- `DTXCreator\Properties\Resources(.ja-JP).resx` (message strings), `FDK\Code\00.Common\CConversion.cs` (base-36 helpers), `DTXCreator\Code\03.Options\COptionsManager.cs` (lane visibility).

Conventions:
- **grid** is DTXCreator's internal time unit: 192 grid per 4/4 measure (`CMeasure.n基準の高さgrid = 0xc0`, CMeasure.cs:12). This is half of the 384 ticks used by NX, vid2dtx and the web app.
- **abs grid** = grid counted from the chart start = the sum of the heights of the preceding measures + the in-measure position.
- **dot** = a pixel in `pictureBox譜面パネル`. Screen y grows downward and time grows upward, so measure 0 is at the bottom.
- C# `int /` truncates toward zero.
- Items marked **INFERRED** are my reasoning from the code. Everything else is read directly from the cited lines.

---

## 1. Data model

### 1.1 `CChip` (CChip.cs:9-224)
| field | meaning | cite |
|---|---|---|
| `nチャンネル番号00toFF` | DTX channel. The setter throws `値が範囲(0～255)を超えています。` when the value is outside 0..255 | 21-35 |
| `nレーン番号0to` | index into `listレーン`. Setter throws if < 0 | 36-50 |
| `n位置grid` | position inside its measure, 0..height-1 (no range check) | 51-61 |
| `n値_整数1to1295` | chip number (WAV/BMP/AVI/BPx id). Setter allows **0**..1295 | 62-76 |
| `f値_浮動小数` | float value. Used only by BPM chips (the BPM) | 15 |
| `b裏` | placed as a "裏" (back) chip, i.e. with the lane's 裏 channel | 14 |
| `bドラッグで選択中` / `b確定選択中` | rubber-band tentative selection / committed selection | 11, 13 |
| `b移動済` | "already moved in this drag step" scratch flag | 12 |
| `n移動開始時の小節番号0to / レーン番号0to / 小節内の位置grid` | drag origin, used for the move undo record | 16-18 |
| `n読み込み時の解像度` (default 0xc0) | cell count of the source line at load. Used once to rescale (§1.9) | 19 |
| `n枠外レーン数` | ≠0 while dragged past the left (<0) or right (>0) end of the lane list | 20 |

- `nチップの高さdot = 9` (77).
- `CompareTo` compares by `n位置grid` only (79-82).
- `tコピーfrom` copies every field (89-105). Undo records and the clipboard store such copies.

### 1.2 `CMeasure` (CMeasure.cs:7-99)
- `f小節長倍率 = 1f` (9) and `listチップ` (10). Chips are owned by the measure object, so renumbering a measure carries its chips along.
- Height:
  - `n小節長倍率を考慮した現在の小節の高さgrid = (int)(192 * f小節長倍率)` (27-33). The cast truncates, so ratio 0.333 gives 63 grid.
  - Height in dots = `(int)(n基準の高さdot * ratio)` (20-26).
  - `n１グリッドの高さdot = n基準の高さdot / 192` (13-19). `n基準の高さdot` is static and equals `192 * (zoomIndex+1)` (CMainForm.cs:4775), so one grid is (zoomIndex+1) dots.
- `n小節番号0to3599`: the setter throws outside 0..0xe0f (3599) (34-48). The constructor bypasses the check (50-53).
- Helpers:
  - `n位置変換dot2grid(d) = d*192/n基準の高さdot` and `grid2dot` (62-73).
  - `count2grid` / `grid2count` (384-based) exist (58-69) but have no callers (INFERRED, from a grep of the tree).
- Measure numbers are written as 3 characters: a base-36 hundreds digit + 2 decimal digits, `Z99` = 3599 (CConversion.cs:147-159).

### 1.3 `ScoreManager` state (ScoreManager.cs:13-23)
- `dic小節 : Dictionary<int,CMeasure>`. Invariant: keys are contiguous 0..Count-1. Many loops index `dic小節[i]` for i < Count (e.g. CSelectionModeManager.cs:386-388, 544-546).
- `dicBPx : Dictionary<int,float>`: #BPMxx key → BPM.
- `listレーン`.
- `n現在のガイド幅grid`: initial value 192/16 = 12.
- `n現在の譜面表示下辺の譜面先頭からの位置grid` (the "bottomGrid" of the view).
- A new chart has measures 0..9 (`t初期化_小節を１０個まで作成する`, 857-863). Opening a file first re-initializes (CMainForm.cs:813) and then loads (827).

### 1.4 Coordinate functions (ScoreManager.cs)
```
laneAtX(x): x<0 → -1; acc=0; for i: acc += lane[i].n幅dot; if x < acc → i;  else -1        (72-89)
            # zero-width (hidden) lanes are never returned
absGridAtY(y) = (ClientHeight - y) / gridDot + bottomGrid        # full resolution    (102-106)
snapGridAtY(y):                                                   # "ガイド幅単位"      (90-101)
    g = absGridAtY(y); m = measureContaining(g) ?? measure[maxMeasure]
    s = measureStart(m); return s + ((g - s) / guide) * guide     # truncation = floor toward measure start
yOfAbsGrid(g) = ClientHeight - (g - bottomGrid) * gridDot                              (159-163)
measureStart(n) = Σ_{i<n} height(i);  -1 if n<0 or n>max                                (164-180)
measureContaining(g): first i in 0..max with g < Σ_{k≤i} height(k); null past the end  (242-259)
chipAtXY(x,y): lane=laneAtX(x); g=absGridAtY(y); m=measureContaining(g)                 (193-216)
    first chip in m.listチップ (list order) with chip.lane==lane && abs <= g <= abs + dot2grid(9)
    # tolerance = 9/zoom grid (9 at Default zoom, 0 at x10)
chipAt(measure, lane, pos): first chip with exact pos and lane                          (217-232)
```
Snapping is floor, not nearest. The chip is drawn in the 9 dots above its grid line (§2), so the cursor cell is the guide line at or below the pointer.

### 1.5 Lanes (`CLane`, CLane.cs; list built in ScoreManager.cs:746-848)

`CLane` fields (CLane.cs:51-72):

| field | meaning |
|---|---|
| `b左側の線が太線` | thick left separator |
| `col背景色` | lane color; alpha 0x19 for every lane (ScoreManager.cs:750) |
| `eレーン種別 : E種別` | lane kind: BPM, WAV, BMP, AVI, FI, GtV/R/G/B/Y/P/W, BsV/R/G/B/Y/P/W, GtL, BsL (12-35) |
| `nチャンネル番号_表00toFF` / `_裏00toFF` | front (表) / back (裏) channel |
| `nレーン割付チップ_表0or1to1295` / `_裏…` | lane-bound default chip number per side |
| `n位置Xdot` | lane x, recomputed as a running sum (714-723) |
| `n幅dot` | 30 = `LANEWIDTH` when visible, 0 when hidden (10, 59) |
| `strレーン名` | lane name |
| `eLaneType : ELaneType` | group: BPM, Drums, BGM, SE1_5, SE6_32, Guitar, Bass, AVI1_2, BGA1_5, BGA6_8, END (36-49) |
| `bIsVisible` | ≡ `n幅dot > 0`; the setter writes 30 or 0 (62-72) |

`bパターンレーンである()` is true for GtR, GtG, GtB, GtY, GtP and BsR, BsG, BsB, BsY, BsP only (126-129).

Full lane list (index = order of `listレーン.Add`). "thick" = thick left separator. Colors are RGB. Width is 30 unless marked hidden (width 0). Lines are ScoreManager.cs.

| idx | name | E種別 | 表 ch | 裏 ch | thick | color | ELaneType | line |
|---|---|---|---|---|---|---|---|---|
| 0 | BPM | BPM | 08 | 03 | ✓ | 160,160,160 | BPM | 752 |
| 1 | LC | WAV | 1A | 1A | ✓ | 223,95,127 | Drums | 754 |
| 2 | HH | WAV | **11 (HHC)** | **18 (HHO)** | | 0,255,255 | Drums | 755 |
| 3 | LP | WAV | 1B | 1B | | 255,159,207 | Drums | 756 |
| 4 | LB | WAV | 1C | 1C | | 255,159,207 | Drums | 757 |
| 5 | SD | WAV | 12 | 12 | | 255,255,0 | Drums | 758 |
| 6 | HT | WAV | 14 | 14 | | 0,255,0 | Drums | 759 |
| 7 | BD | WAV | 13 | 13 | | 191,191,255 | Drums | 760 |
| 8 | LT | WAV | 15 | 15 | | 255,0,0 | Drums | 761 |
| 9 | FT | WAV | 17 | 17 | | 255,127,0 | Drums | 762 |
| 10 | CY | WAV | 16 | 16 | | 159,159,255 | Drums | 763 |
| 11 | RD | WAV | 19 | 19 | | 0,255,255 | Drums | 764 |
| 12 | FI | FI | 53 | 53 | ✓ | 255,255,0 | Drums | 765 |
| 13-16 | BN1..BN4 | FI | 4F, 4E, 4D, 4C (表 = 裏) | | | 255,255,0 | Drums | 766-769 |
| 17 | MLC | WAV | 87 | 87 | ✓ | 223,95,127 | Drums | 771 |
| 18 | MHH | WAV | 84 | 84 | | 0,255,255 | Drums | 772 |
| 19 | MCY | WAV | 85 | 85 | | 159,159,255 | Drums | 773 |
| 20 | MRD | WAV | 86 | 86 | | 0,255,255 | Drums | 774 |
| 21 | BGM | WAV | 01 | 01 | ✓ | gray | BGM | 776 |
| 22-26 | SE1..SE5 | WAV | 61..65 | = | SE1 ✓ | gray | SE1_5 | 778-782 |
| 27-53 | SE6..SE9, S10..S32 | WAV | 66..69, 70..79, 80..89, 90..92 | = | SE6 ✓ | gray | SE6_32, **hidden** | 785-811 |
| 54 | GtV | GtV | 00 | 00 | ✓ | gray | Guitar | 813 |
| 55-59 | GtR, GtG, GtB, GtY, GtP | GtR..GtP | 00 | 00 | | R 255,0,0 / G 0,255,0 / B 0,128,255 / Y 255,255,0 / P 255,0,255 | Guitar | 814-818 |
| 60 | GtW | GtW | 28 | 28 | ✓ | gray | Guitar | 819 |
| 61 | GtL | GtL | 2C | 2C | | 240,192,160 | Guitar | 820 |
| 62-69 | BsV, BsR..BsP, BsW, BsL | Bs* | 00 ×6, A8, 2D | = | BsV ✓, BsW ✓ | same as Gt | Bass | 822-829 |
| 70 | AVI | AVI | 54 | 54 | ✓ | gray | AVI1_2 | 831 (AVI2 0x55 commented out, 832) |
| 71-75 | BG1..BG5 | BMP | 04, 07, **0x100**, 56, 57 | C4, C7, D5, D6, D7 | BG1 ✓ | gray | BGA1_5 | 834-838 |
| 76-78 | BG6..BG8 | BMP | 58, 59, 60 | D8, D9, E0 | | gray | BGA6_8, **hidden** | 841-843 |

That is 79 lanes. "gray" = 160,160,160.

### 1.6 Lane visibility and groups
- `tCollapseLanes(ELaneType)` and `tExpandLanes(ELaneType)` toggle every lane of a group (668-701). `tRefreshDisplayLanes` then recomputes x, the background strip and the horizontal scrollbar (707-712).
- Users toggle visibility per ELaneType group in the Options dialog's checked list (COptionsManager.cs:80-86). The setting is persisted as `LanesInfo` and re-applied by lane name at startup (CMainForm.cs:371-383). It survives "new file" (CMainForm.cs:594-605).
- The picture box width equals the sum of the lane widths (ScoreManager.cs:864-883).
- Hidden lanes keep their index, so index arithmetic crosses them (see §5.4, §11).

### 1.7 表 / 裏 (front / back) chips
- A chip placed with `b裏` gets the lane's 裏 channel (ScoreManager.cs:333).
- The 裏 side is meaningful only where 表 ≠ 裏:
  - HH: 11 HHC / 18 HHO
  - BPM: 08 / 03
  - BG1..BG8: BGA / BGA-swap channels
  - all other lanes have identical channels.
- 裏 chips are drawn inset (§2). On load, the lane is found by the first lane whose 表 or 裏 channel matches, scanning lanes in order. `b裏` is true only on a 裏-only match (CDTXInputOutput.cs:2483-2503, 2197-2221).
- INFERRED: the 裏 flag of a chip on a lane with 表 == 裏 is therefore lost on reload.
- Each lane has two **lane-bound default numbers** (`レーン割付チップ` 表 and 裏), edited in the header strip (§4.6). They are saved as `#DTXC_LANEBINDEDCHIP: {lane index 00} {表 b36} {裏 b36}` (CDTXInputOutput.cs:2775-2786).

### 1.8 Guitar and bass in the model
- A guitar note is several chips at the same grid:
  - a **GtV** chip holding the WAV number,
  - plus pattern chips on GtR/G/B/Y/P with value 1,
  - or an **OPEN** = a GtR chip with value 2 (`bOPENチップである`, ScoreManager.cs:29-33). Bass works the same way with BsR.
- Pattern chips and GtV/BsV chips carry channel 0.
- Load: channels 0x20-0x27 / 0x93-0x9F / 0xA9-0xAF / 0xD0-0xD3 produce a GtV chip plus pattern chips (CDTXInputOutput.cs:1006-1195). Bass is analogous.
- Save: the GtV value and a pattern bitmask are combined per grid. The bits are R=0x04, G=0x02, B=0x01, Y=16, P=32, and OPEN = 0xFF, which becomes channel 0x20 (2876-2916).
- A grid that lacks either the GtV value or any pattern bit is **dropped on save** (2917-2924). Channel-0 chips are skipped by the generic writer (~2830).

### 1.9 BPM chips
- The BPM lane's 表 channel is 08. `n値` is a key into `dicBPx` and `f値` is the BPM.
- On load, every ch 03 chip becomes ch 08. Its integer BPM goes into the smallest free `dicBPx` key 1..1295 (CDTXInputOutput.cs:198-228).
- On save, `#BPMxx: value` is written for every `dicBPx` entry, used or not (2640-2647).

### 1.10 Load and save facts that constrain editing
- Load position rescale: `pos = i * height / nCells`, where i is the cell index in the line (truncation) (CDTXInputOutput.cs:2540).
  - INFERRED: data at 384-cell resolution loses odd cells, which collide with their neighbors.
- Bar length persists into following measures on load (2524-2543). It is written only where it changes (2797-2810).
- Save compresses each measure's cell array by dividing by primes (`arr素数リスト`, 3298+).
- Lines the parser doesn't recognize are appended to the free-text box `textBox自由入力欄` and re-emitted (CDTXInputOutput.cs:91-103, 2787-2796).

---

## 2. Rendering details that matter to editing (ScoreManager.cs:624-1058)
- Measures are walked from 0 upward and only those in the visible band are drawn (632-657).
- Per measure, in this order (884-892):
  1. measure number: `strConvertNumberTo3DigitMeasureNumber`, MS UI Gothic 50pt, white alpha 80, centered in the visible part (987-990)
  2. guide lines every `n現在のガイド幅grid`, RGB(50,50,50), only when guide > 1 (893-904)
  3. beat lines every 48 grid, gray (991-999)
  4. lane separators: gray 1px, or white 2px if thick (971-980)
  5. measure lines: white 2px at the bottom and top (981-986)
  6. chips
- Chips:
  - The list is re-sorted on every paint with `listチップ.Sort()` (907).
  - Skipped when `n枠外レーン数 ≠ 0` or the lane is hidden (911-920).
  - Rect: x = lane x, y = measureBottom − pos·gridDot − 9, w = lane width, h = 9 (921-924). The chip sits *above* its grid line.
  - 表 chip: fill at alpha 0x80; top and left edges opaque; bottom and right at alpha 0x40. The number is 2-digit base 36 spaced as `"0 1"`, MS Gothic 8pt bold, white with a black shadow (CChip.cs:112-130, 160-188).
  - 裏 chip: inset 4 px on each side and 1 px vertically; alpha 80 / 180 / 0x2c (CChip.cs:204-221).
  - BPM chips show `f値.ToString()`. Pattern-lane chips show no number. OPEN is drawn 5 lanes wide with the text `O    P    E    N` (927-955, CChip.cs:83-88).
  - Selected chips (drag-selected or committed) get a 2 px white border (965-968).
- Header strips are drawn on top of everything:
  - lane-bound numbers in y 0..10, gradient (0,0,100)→(100,100,255). 表 at x+1, 裏 at x + width/2, MS UI Gothic 7pt (1000-1036)
  - lane names in y 10..42 (658-661, 1037-1058)

---

## 3. Modes
- Exactly one mode is active, tracked by the checked toolbar button: `b選択モードである` / `b編集モードである` (CMainForm.cs:56-77).
- `t選択モードにする` only flips the buttons (1837-1843). `t編集モードにする` first calls `t全チップの選択を解除する()` (1844-1852), which is undoable and commits pending moves (§5.5).
- Entry points:
  - Toolbar buttons and the Edit menu: 選択モード(&S), 編集モード(&E), モード切替(&M) with **Ctrl+Space** (CMainForm.cs:4540-4558; CMainForm.resx:1992).
  - The initial mode comes from the setting `InitialOperationMode` (true = select) (CMainForm.cs:385-394; COptionsManager.cs:78).
- Mouse dispatch (CMainForm.cs:2318-2367): MouseClick and MouseMove go to the active manager. MouseDown goes only to the select manager. MouseLeave goes only to edit mode.
- There is **no MouseUp handler** (CMainForm.Designer.cs:836-842).
- MouseClick first focuses the panel (2322). With the `AutoFocus` setting, MouseEnter also focuses it (2341-2349).

---

## 4. Edit mode (`CEditModeManager`)

### 4.1 Chip cursor (CEditModeManager.cs:68-96, 127-172)
- On MouseMove: cursorLane = `laneAtX(x)`, cursorGrid = `snapGridAtY(y)`.
- If y < 20 (`nレーン割付チップ番号表示高さdot + 10`), the cursor is hidden (rect 0).
- Otherwise rect = (lane x, `yOfAbsGrid(cursorGrid) − 9`, lane width, 9).
- A refresh happens only when the rect changes.
- Cursor drawing:
  - 裏 style if Ctrl is held, else 表 style. Lane color, plus the 2 px white border.
  - Number shown: none (−1) for pattern and BPM lanes. Otherwise `selectedRow+1`, replaced by the lane-bound number of the current side (Ctrl ⇒ 裏) when that number is non-zero and Shift is not held.
- MouseLeave hides the cursor (60-67).
- INFERRED: pressing or releasing Ctrl or Shift without moving the mouse doesn't redraw the cursor.

### 4.2 Guide interval (ガイド間隔) (CMainForm.cs:2184-2272, 4582-4647, 4779-4819)
- `tガイド間隔を変更する(n分)`: `n現在のガイド幅grid = (n分==0) ? 1 : 192/n分`.

| menu / combo | n分 | grid |
|---|---|---|
| 1/&4 | 4 | 48 |
| 1/&8 | 8 | 24 |
| 1/1&2 | 12 | 16 |
| 1/1&6 (default) | 16 | 12 |
| 1/24 | 24 | 8 |
| 1/&32 | 32 | 6 |
| 1/48 | 48 | 4 |
| 1/64 | 64 | 3 |
| フリー / Free | 0 | 1 |

- Combo items, index 0..8: `1/4 … 1/64, Free` (CMainForm.resx:2416-2440).
- Menu ガイド間隔(&G):
  - `拡大(&W)` **F3** steps coarser along 0→64→48→32→24→16→12→8→4 and stops at 4.
  - `縮小(&N)` **F4** steps finer along 4→8→…→64→0 and stops at Free.
- A new file resets the guide to 16 (CMainForm.cs:619). Startup restores `GuideIndex` (341-347).

### 4.3 Left / right click on the score (CEditModeManager.cs:173-303)
Nothing happens unless the cursor rect is non-empty. `g` = cursorGrid, `row` = `n現在選択中のWAV_BMP_AVIリストの行番号0to1294`. `row` is one shared index across the WAV, BMP and AVI lists and the chip palette (CMainForm.cs:2016-2026; CChipPalette.cs:187-193).
```
Left:
  ctrl = Ctrl held; shift = Shift held
  if lane is GtV / BsV:
      v = ctrl ? lane.割付裏 : lane.割付表;  if v==0 || shift: v = row+1
      transaction { place(lane, g, v, 0, ctrl)
                    if no chip at g on lanes lane+1, lane+2, lane+3 (R, G, B only):
                        place(lane+1, g, 2 /*OPEN on R*/, 0, false) }                 (184-198)
  elif lane is Gt R..P:  ctrl ? place(GtR, g, 2, 0, false)   # OPEN
                              : place(lane, g, 1, 0, false)                            (199-217)
  elif lane is Bs R..P:  same with BsR                                                 (218-236)
  elif lane is BPM:      §4.5
  else (all drums, FI/BN, M*, BGM, SE, GtW/GtL/BsW/BsL, AVI, BG):
      v = ctrl ? 割付裏 : 割付表;  if v==0 || shift: v = row+1
      place(lane, g, v, 0, ctrl)          # ctrl ⇒ 裏 chip / 裏 channel                (237-245)
  if setting PlaySoundOnWAVChipAllocated and lane.E種別 ∈ {WAV, GtV, BsV}:
      preview WAV v (same rule), unless NoPreviewBGM and that WAV is BGM               (284-296)
Right:  delete(lane, g)                                                                 (298-301)
```
- All drum lanes are `E種別.WAV`, so they get the preview sound.
- MouseClick fires on button release (WinForms). Other mouse buttons do nothing.
- There is no click-and-drag painting.

### 4.4 `tチップを配置または置換する(lane, g, value, float, b裏)`: place or replace (ScoreManager.cs:319-357)
```
m = measureContaining(g); if null → return (no-op past the last measure)
transaction {
  delete(lane, g)                                    # an occupied cell is REPLACED, not refused
  if lane ∈ {GtR, BsR} and value == 2: delete(lane+1, g); delete(lane+2, g)   # OPEN clears G and B only
  chip = { ch: b裏 ? lane.裏 : lane.表, lane, pos: g − measureStart(m), value, float, b裏 }
  m.listチップ.Add(chip); record 配置 cell
  if m is the last measure: add measures max+1 .. max+4, each with a 小節挿入 cell
}
b未保存 = true
```
Placed chips are not selected.

### 4.5 BPM lane (CEditModeManager.cs:247-283)
1. The chip palette is hidden temporarily.
2. A `CNumericInputDialog` opens:
   - title `数値入力`, message `BPM値を設定して下さい。` (Resources `strBPM選択ダイアログの説明文`)
   - range 0.0001..1000, 4 decimal places (CNumericInputDialog.Designer.cs:44-60; CNumericInputDialog.cs:23-30)
   - placed with its horizontal center at the click and its top 4 px below it
   - Enter = OK, Esc = Cancel (32-42)
   - initial value = `dc譜面先頭からの位置gridにおけるBPMを返す(g)`: the last ch-08 chip with abs ≤ g scanning measures 0..m, else the header BPM `numericUpDownBPM` (ScoreManager.cs:48-71)
3. Cancel → nothing.
4. Key: reuse the `dicBPx` key whose value is exactly equal (float `==`). Otherwise add the smallest free key 1..1295.
5. `place(BPM, g, key, bpm, false)`: always 表 / ch 08.

### 4.6 Lane-bound number header (y < 20) (CEditModeManager.cs:20-53)
- Ignored on pattern lanes.
- Side = 裏 with Ctrl, else 表.
- Left click: new number = `row+1`. Other buttons: new number = 0 (clear).
- If the number changed: a `CLaneAllocationUndoRedo` cell is recorded and the number is set.

### 4.7 Delete one cell: `tチップを削除する(lane, g)` (ScoreManager.cs:260-318)
```
m = measureContaining(g); if null return; pos = g − measureStart(m)
transaction { repeat until a pass removes nothing:
    for chip in m with chip.pos == pos:
        if chip.lane == lane: remove (削除 cell); break
        if lane ∈ Gt R..P and chip is on GtR with value 2: remove; break   # OPEN removed from any Gt pattern lane
        if lane ∈ Bs R..P and chip is on BsR with value 2: remove; break }
```
- Exact-grid only: a chip off the current guide can't be right-click-deleted unless the guide is finer (INFERRED).
- Duplicates in the cell are all removed.

---

## 5. Selection mode (`CSelectionModeManager`)

### 5.1 Dispatch
- Right MouseClick opens the context menu at (x, y) (171-177, CMainForm.cs:1882-1922). The menu items (CMainForm.Designer.cs:1474-1487; ja / en from the resx files) are:
  1. 選択チップの切り取り(&T)
  2. 選択チップのコピー(&C)
  3. 選択チップの貼り付け(&P)
  4. 選択チップの削除(&D)
  5. (separator)
  6. すべてのチップの選択(&A)
  7. `レーン内のすべてのチップの選択(&L) [lane]`
  8. `小節内のすべてのチップの選択(&R) [nnn]`
  9. (separator)
  10. 小節長の変更(&B)
  11. (separator)
  12. 小節の挿入(&I)
  13. 小節の削除(&D)
- Items 7 and 8 get the lane name and 3-digit measure number substituted into `[...]` by regex. The click position is stored in `pt選択モードのコンテクストメニューを開いたときのマウスの位置`.
- Left MouseDown (178-196):
```
cc = chipAtXY(x, y)
if cc == null or !cc.b確定選択中 → start rubber band
elif !Ctrl                       → start move (all committed chips)
else                             → deselect cc alone (選択解除 cell)        (25-31)
```
- MouseMove (197-222): with the left button held, the band or move continues. **Without it, the band or move ends.** A drag therefore finishes on the first mouse-move event after release (INFERRED consequence of having no MouseUp).

### 5.2 Rubber band
- Start (788-798): anchor = end = e. Without Ctrl, `t全チップの選択を解除する()` runs first (commit, §5.5). With Ctrl, the band adds to the selection. The band rect is evaluated immediately.
- Evaluation (373-422):
  - dot rect → lanes `[laneAtX(left), laneAtX(right)]` and grids `[absGridAtY(bottom), absGridAtY(top)]` (full resolution, not snapped)
  - for every chip, `bドラッグで選択中 = laneInRange && abs <= gTop && abs + dot2grid(9) >= gBottom`
  - for OPEN chips the lane test uses lanes lane..lane+2 (396-399)
- A plain click on an unselected chip is a zero-size band that selects that chip (INFERRED from the formula).
- Continue (799-805): updates end, auto-scrolls (§5.6), re-evaluates.
- End (806-839): one transaction with a `選択` cell for each newly selected chip; then drag flags are promoted to `b確定選択中`.
- The band is drawn with fill RGBA(55,55,255, alpha 80) and a LightBlue outline (635-657).

### 5.3 Move
- Start (423-444): `prev = (laneAtX(x), snapGridAtY(y))`. The origin (measure, lane, pos) of every committed chip is recorded.
- Each MouseMove (445-451, 530-568):
  - `cur = (laneAtX(end.x), snapGridAtY(end.y))`, `d = cur − prev`.
  - If d ≠ 0: clear `b移動済`. Every committed, not-yet-moved chip gets `moveH(dx)` and/or `moveV(dy)`. The scan restarts from measure 0 after each vertical move. Then `prev = cur`.
  - The vertical delta comes from two snapped positions, so chips keep any off-guide offset (INFERRED).
- `moveH` (242-273): `newLane = lane + dx`. Results < 0 or ≥ laneCount are kept in `n枠外レーン数`; the lane field is left unchanged. Such chips aren't drawn (ScoreManager.cs:911). Moving back in range restores them.
- `moveV` (274-324): `p = pos + dy`.
  - p < 0: walk to previous measures, adding their heights. **If there is no previous measure, return without moving this chip.**
  - p ≥ height: walk forward, **creating missing measures** (no undo cell).
  - When a chip crosses measures, it is replaced by a copy in the new measure.
- Hidden lanes count in dx (they're in the index space), so chips can land in invisible lanes (INFERRED).

### 5.4 Move end (452-488)
- For each committed chip that is in range:
  - `channel = b裏 ? lane.裏 : lane.表`
  - if the lane is a pattern lane and the value ∉ {1, 2}, the value becomes 1
  - neither change is recorded for undo
- Then one transaction with a `移動` cell (origin → current) for each committed chip whose (measure, lane, pos) changed.
- Overlaps at the destination are **not** resolved here.

### 5.5 Commit / deselect all: `t全チップの選択を解除する` (32-96)
One transaction, in order:
1. delete every chip with `n枠外レーン数 ≠ 0`
2. for every selected chip (drag-selected or committed), delete any other non-committed chip at the same (measure, lane, pos). **The moved or pasted chip wins.**
3. a `選択解除` cell for each committed chip, then all flags are cleared

It runs on:
- a band start without Ctrl
- entering edit mode
- cancelling Replace when Replace had auto-selected everything (§9)

### 5.6 Auto-scroll while dragging (489-529)
- y < 70: `Value += −(70−y)/2`.
- y > pictureBox.Height − 50: `Value += (y − H + 50)/2`.
- Both are clamped to [Min, Max+1−LargeChange]. The band anchor is shifted by `grid2dot(applied delta)`.
- It runs only on mouse-move events, with no timer (INFERRED).

### 5.7 Bulk select
- `t全チップを選択する` (97-119): Edit menu `すべて選択(&A)` **Ctrl+A** or the context menu. It switches to select mode first (CMainForm.cs:4528-4539, 2615-2626).
- `tレーン上の全チップを選択する(lane)` (120-144) and `t小節上の全チップを選択する(n)` (145-164) are reached from the context menu (CMainForm.cs:2627-2680).
- Each newly selected chip gets a `選択` cell. Hidden-lane chips are included (INFERRED).
- Copy, Cut and Delete are enabled iff any chip is committed-selected. Paste is enabled iff the clipboard is non-empty (CMainForm.cs:1853-1881, 2078-2092).

---

## 6. Clipboard (`CClipBoard`, CClipCell)
- It is internal (not the OS clipboard). It is created once at startup (CMainForm.cs:190-194) and not cleared on new or open (INFERRED: absent from `t譜面を初期化する`).
- Cell: `{pチップ (copy), nレーン番号, n位置grid (ABS grid)}`. `b貼り付け済` and `nグループID` are unused (CClipCell.cs:9-13).
- **Copy** `tシナリオ_コピー` (CMainForm.cs:1376-1401; requires panel focus): clear the board, then add every committed chip with its abs grid (CClipBoard.cs:103-118).
- **Cut** = copy + delete (CMainForm.cs:1355-1375).
- **Delete** `tシナリオ_削除` (1443-1536; focus required; menu `削除(&D)` **Del**): one transaction removing all committed chips (`削除` cells).
- **Paste** `tチップを指定位置から貼り付ける(m0, p0)` (CClipBoard.cs:26-93):
```
cells' grid := grid − min(grid over cells) + p0          # p0 is relative to m0's start
transaction: for each cell: walk forward from m0 subtracting heights until 0 <= grid < height(m)
             (creating missing measures, no undo); add copy with pos=grid,
             b確定選択中 = true (pasted chips arrive selected); 配置 cell
```
  - Lane and channel are preserved: no horizontal offset.
  - Existing selection is not cleared.
  - There is no occupancy check. Underlying chips are deleted at the next commit (§5.5 step 2) (INFERRED interplay).
- **Paste target**: `tシナリオ_貼り付け(g)` → m0 = measureContaining(g), p0 = g − start (CMainForm.cs:1402-1442).
  - Edit menu `貼り付け(&P)` **Ctrl+V** and the toolbar: g = `snapGridAtY(mouse y)` if the mouse is inside the visible score area, else `bottomGrid`, the view's bottom edge (4503-4523, 4729-4749).
  - Context menu: g = `snapGridAtY` of the *menu's own top-left* converted to client coordinates (2598-2609). Other context items use the stored click point instead (2638, 2667, 2688).
- Shortcuts: **Ctrl+X / Ctrl+C / Ctrl+V** (CMainForm.resx:1920-1945).

---

## 7. Undo / Redo

### 7.1 Manager (CUndoRedoManager.cs, CUndoRedoDirectory.cs)
- Structure: a tree of `CUndoRedoDirectory` nodes. Each has `listノード`, a cursor `n次にノードが追加される位置0to`, and a parent. `nUndo = cursor` and `nRedo = Count − cursor` (CUndoRedoDirectory.cs:9-25).
- `tノードを追加する(cell)` (47-57): append to the *current* directory after truncating its redo tail; cursor++.
- `tトランザクション記録を開始する` (58-72): truncate the tail, append a new child directory, cursor++, descend. Transactions **nest**: place → delete opens a nested one.
- `…終了する` (73-87): ascend. An **empty directory is removed**, so no-op ops leave no entry.
- Undo and Redo work on the **root only** (18-37):
  - Undo: cursor--, then the node's `tUndoを実行する`. A directory undoes its children in reverse (CUndoRedoDirectory.cs:51-57).
  - Redo: execute forward (44-50), cursor++.
  - Scenario wrappers refresh the GUI (CMainForm.cs:1766-1821).
- Menu `元に戻す(&U)` **Ctrl+Z** and `やり直す(&R)` **Ctrl+Y**, plus toolbar buttons. Enabled iff nUndo / nRedo > 0 (2055-2060).
- **No depth limit** (plain List). The manager is replaced on new or open (CMainForm.cs:628).
- `CUndoRedoCell<T>{owner, undo, redo, before, after}`. Running it nulls the owner (CUndoRedoCell.cs:13-38).
- The owner is used only for text boxes: consecutive TextChanged on the same box updates the top cell's `変更後の値`; Leave releases ownership (CMainForm.cs:2778-2825).
- The static flag `bUndoRedoした直後` suppresses recording of the next programmatic UI change (CUndoRedoManager.cs:12; CMainForm.cs:2172-2179).
- Most handlers set `b未保存 = true`. Undo never clears it. The title shows `DTXC NX *[name]` (CMainForm.cs:105-147).

### 7.2 Chip and measure cells
| cell | payload | undo | redo | recorded at |
|---|---|---|---|---|
| 配置 (place) | `CChipLocationUndoRedo(measure, chip copy)` | remove first chip in that measure with the same pos and lane (ScoreManager.cs:429-445) | re-add copy (418-428) | ScoreManager.cs:340-343; CClipBoard.cs:69-72 |
| 削除 (delete) | same | re-add copy, *including its selection flags* (375-385) | remove first match (358-374) | ScoreManager.cs:280-309; CSelectionModeManager.cs:43-46, 66-69; CMainForm.cs:1153-1163, 1277-1286, 1485-1494 |
| 選択 / 選択解除 | `CChipPositionUndoRedo(measure, lane, pos, value)` | toggle `b確定選択中` on `chipAt` (386-417) | toggle | band end, select-all/lane/measure, search, deselect |
| 移動 (move) | before / after positions | find the **committed** chip at "after", move to "before" (CSelectionModeManager.cs:349-372) | inverse (325-348) | 478-483 |
| 番号置換 (number replace) | before / after value | value = before (ScoreManager.cs:455-463) | after (446-454) | CSelectionModeManager.cs:674-679 |
| 表裏反転 (flip) | position | flip channel and `b裏` (482-499) | flip (464-481) | CSelectionModeManager.cs:708-711 |
| 小節挿入 (insert measure) | int | shift down (553-568) | shift up + new CMeasure (538-552) | ScoreManager.cs:347-351; CMainForm.cs:1197-1202 |
| 小節削除 (delete measure) | int | shift up + **new** CMeasure (523-537) | remove + shift down (507-522) | CMainForm.cs:1300-1305 |
| 小節長変更 (bar length) | `CMeasureUndoRedo(measure, ratio)` | ratio = before (578-586) | after (569-577) | CMainForm.cs:1121-1129 |
| レーン割付 (lane-bound number) | `CLaneAllocationUndoRedo(lane ref, n, b裏)` | restore (CEditModeManager.cs:316-327) | (304-315) | 34-36, 46-48 |

- Selection changes are undoable steps.
- Not recorded:
  - measures auto-created by a vertical move or paste
  - the channel and value rewrite at move end
  - `dicBPx` additions
  - the measure 0 recreated after deleting the last measure
  - guide, zoom, mode and lane visibility

---

## 8. Measure operations
All are reached from the select-mode context menu only. The target measure is `measureContaining(snapGridAtY(stored click y))`. If the click x isn't on a lane, nothing happens (CMainForm.cs:2682-2765).
- **Insert** `tシナリオ_小節を挿入する(n)` (1191-1249):
  - One cell, no transaction.
  - Measures ≥ n are renumbered +1 from the top down. A new empty `CMeasure(n)` with ratio 1.0 is added.
  - The new measure appears at the clicked position and the clicked measure moves up (later). The code comment calls this 該当小節の下へ新しい小節を挿入する.
  - Chips move with their measure objects.
- **Delete** `tシナリオ_小節を削除する(n)` (1250-1350), in one transaction:
  1. record and remove every chip of measure n
  2. add the 小節削除 cell
  3. remove the measure; renumber later measures −1
  4. if no measures remain, add `CMeasure(0)` (unrecorded)
- **Change length** `tシナリオ_小節長を変更する` (1055-1098):
  - Dialog `CChangeMeasureLengthDialog`, title `小節長変更`:
    - read-only `小節番号` showing the 3-digit number
    - `小節長の倍率(&R)` NumericUpDown, 3 decimals, increment 0.05, min 0.001, max not set (WinForms default 100, INFERRED), initialized from the current ratio (CChangeMeasureLengthDialog.Designer.cs:44-61)
    - checkbox `後続の小節の倍率もすべて変更する(&F)`, default off
    - Enter = OK, Esc = Cancel (CChangeMeasureLengthDialog.cs:41-62)
  - With the checkbox on, measures n..max each get the same ratio.
  - Each measure is processed by `t小節長を変更する_小節単位` in **its own top-level transaction** (1099-1190): record the ratio change, set it, delete chips with `pos >= new height`.
  - **Chips are not rescaled.** They keep their grid offset from the measure start. Shortening cuts the tail, lengthening appends empty space, and later measures shift implicitly because abs positions are sums of heights.

---

## 9. Search / Replace
Both are available in either mode and do not switch modes (CMainForm.cs:1043-1050).

### Search (`検索(&F)`, Ctrl+F)
Dialog CSearchDialog: title `検索`, label `以下の条件に合うチップを選択します。`, OK button `検索実行`.

| control | values |
|---|---|
| `レーン指定(&L)` | checked list of all lane names (hidden ones too), ALL / NONE buttons |
| `チップ範囲指定(&C)` | start..end, 1-2 chars base 36 |
| `小節範囲指定(&S)` | start..end, **decimal** int ≥ 0 |
| `表チップから検索する(&F)` / `裏チップから検索する(&B)` | front / back side |

- If only one end of a range is filled in, it is used for both ends (CSearchDialog.cs:67-166).
- Invalid input shows `チップ番号に誤りがあります。` / `小節番号に誤りがあります。` and keeps the dialog open (222-289).
- The checkbox states persist in static fields for the session (13-19, 275-283).
- Unchecked ranges default to numbers 0..1295 and measures 0..max (CSelectionModeManager.cs:584-597).
- A matching chip (lane ∧ range ∧ side) is **added** to the selection with a 選択 cell each, in one transaction.
- The result box says `{n} 個のチップが選択されました。` or `該当するチップはありませんでした。`, title `検索結果` (569-634).
- The number test uses `n値`. For BPM chips that is the BPx key, not the BPM.

### Replace (`置換(&Q)`, Ctrl+H)
Dialog CReplaceDialog: title `置換`, label `現在選択中のチップを対象に置換を行います。`, OK `置換実行`.
- Mode radio buttons: `チップの置き換え(&R)` (default; `[元] を [先] に置き換える`) or `チップの表裏を反転(&A)`.
- If nothing is selected, everything is selected first (undoable) and deselected again if the dialog is cancelled. `元` is pre-filled when all selected chips share one value (CSelectionModeManager.cs:735-787).
- Replace: every selected chip with value == 元 gets 先 (番号置換 cells) (658-697).
- Flip: every selected chip toggles `b裏` and its channel between the lane's 表 and 裏 (698-734).
- Messages: `{n} 個のチップを置換しました。` / `該当するチップはありませんでした。`, title `置換結果`. The flip shows no message when n = 0.

---

## 10. Keyboard, scrolling, zoom
- Shortcuts (CMainForm.resx:1848-2173):

| key | action |
|---|---|
| Ctrl+N / O / S | file |
| Ctrl+Z / Y | undo / redo |
| Ctrl+X / C / V | cut / copy / paste |
| Del | delete |
| Ctrl+A | select all |
| Ctrl+Space | toggle mode |
| Ctrl+F / Ctrl+H | search / replace |
| F3 / F4 | guide coarser / finer |
| F5 / F6 / F7 | play from top / play from current position / stop (viewer) |
| F1 | manual |

  There are no arrow-key edit operations.
- PageUp / PageDown move ±192 grid (2445-2491).
- Wheel: `lines = −delta·MouseWheelScrollLines/120`, 16 grid per line. Shift+wheel scrolls horizontally 16 px per line (2493-2566). With the Windows default of 3 lines, one notch is 48 grid = 1 beat. The source comment "１行＝１拍（64/4=16グリッド）" (2542) is stale.
- Vertical scrollbar: SmallChange 12, LargeChange 192 (ScoreManager.cs:587-601). `bottomGrid = (Max+1−LargeChange) − Value`.
- Zoom combo `Default, x2..x10` sets `n基準の高さdot = 192·(index+1)` (CMainForm.cs:4773-4778; resx:2380-2407).

---

## 11. Quirks (code-verified unless marked INFERRED)
1. **BG3 表 channel is `0x100`** (ScoreManager.cs:836). Placing a 表 chip there hits the CChip setter throw (CChip.cs:29-32) inside an open transaction. INFERRED: unhandled exception. The real DTX BGA3 channel 0x55 is commented out as AVI2 (832).
2. **Channels 0x84-0x87 belong to both MHH/MCY/MRD/MLC and S24-S27** (771-774 vs 803-806). On load the first match (the M* lanes) wins (CDTXInputOutput.cs:2483-2503). INFERRED: S24-S27 chips reload into M* lanes.
3. OPEN placement clears only G and B (ScoreManager.cs:326-330). The GtV auto-OPEN check looks only at R, G, B (CEditModeManager.cs:193). The OPEN band hit test spans 3 lanes (CSelectionModeManager.cs:396). These are leftovers from 3-button guitar, while OPEN is drawn 5 lanes wide.
4. **Move undo doesn't restore the channel or value** rewritten at move end (CSelectionModeManager.cs:459-468 vs 349-372). INFERRED: after undoing a cross-lane move the chip keeps the destination lane's channel and would be saved in the wrong channel.
5. Undo of a measure delete recreates the measure with ratio 1.0; the old ratio is lost (ScoreManager.cs:535). Undo after the "last measure deleted → measure 0 recreated" case leaves an extra measure (INFERRED).
6. "後続" bar-length change = one undo step per measure (CMainForm.cs:1088-1089 with the transaction inside 1117/1184).
7. Ratios below 1/192 give a 0-grid measure: nothing can be placed and all chips are deleted (INFERRED from CMeasure.cs:27-33, ScoreManager.cs:242-259). A loaded ratio > 100 would throw when it is assigned to the dialog (INFERRED).
8. Measures created by a vertical move or paste aren't undoable. The 4-measure auto-extension is undoable.
9. Undo handlers pick "the first chip with the same (lane, pos)". Lists are re-sorted on every paint with an unstable `List.Sort`. INFERRED: with stacked duplicates (after paste, before commit), undo may remove the other chip.
10. `dicBPx` keys are never freed. A 1296th distinct BPM leaves key −1 and the `n値` setter throws (CEditModeManager.cs:261-282; CChip.cs:70). Float `==` matching: 120 vs 120.0001 makes two keys.
11. Replace on BPM chips changes the key but not `f値`, so the display differs from the saved file. Flipping a BPM chip makes ch 03, and the save writes the key as hex (CDTXInputOutput.cs:2846-2870) (INFERRED).
12. A drag ends on the first mouse move after release (no MouseUp). INFERRED: release followed by a keypress without moving leaves the band uncommitted, so its chips are drag-selected but not committed and are invisible to Copy and Delete.
13. A selection or move spanning hidden lanes includes and moves chips in them (INFERRED from index arithmetic).
14. A chip at the chart start can't move below measure 0: it silently stays while the others move (CSelectionModeManager.cs:282-289).
15. Context-menu Paste uses the menu's top-left position, not the click point (CMainForm.cs:2602-2608).
16. Search measure ranges are decimal, while file measure numbers use base-36 hundreds.

---

## Key facts
- Resolution is 192 grid per 4/4 measure. Measure height = `(int)(192·ratio)`. One grid = (zoomIndex+1) px. Chips are 9 px tall and drawn above their grid line.
- Chips belong to measures (`dic小節`, contiguous keys 0..N; numbers 0..3599 written as base-36 hundreds + 2 decimals). A chip = channel, lane index, in-measure grid, int value 0..1295, float (BPM only), 表/裏 flag, and selection/move scratch fields.
- There are 79 lanes, each with a 表 and 裏 channel and two lane-bound default numbers. Width is 30 or 0; visibility is toggled per ELaneType group.
- Drum lanes: LC 1A, HH 11/18, LP 1B, LB 1C, SD 12, HT 14, BD 13, LT 15, FT 17, CY 16, RD 19. FI 53, BN1-4 4F-4C, MLC/MHH/MCY/MRD 87/84/85/86, BGM 01, SE1-SE5 visible, SE6-S32 hidden, BPM 08/03, AVI 54, BG1-8.
- Guitar and bass = a V lane (WAV) + R/G/B/Y/P pattern lanes (value 1) + OPEN (R lane value 2), combined on save; a grid missing either part is dropped.
- Guide choices are 1/4, 1/8, 1/12, 1/16 (default), 1/24, 1/32, 1/48, 1/64 and Free → 48, 24, 16, 12, 8, 6, 4, 3, 1 grid. Snapping is floor relative to the measure start. F3 is coarser, F4 is finer.
- Edit mode:
  - Left click places or replaces using the lane-bound number of the current side, with Shift or a 0 binding falling back to the shared WAV/BMP/AVI/palette row + 1. Ctrl = 裏 chip.
  - Right click deletes the exact cell, plus OPEN on guitar lanes.
  - The BPM lane opens a 0.0001..1000 dialog and allocates a #BPMxx key.
  - Placing in the last measure appends 4 measures.
  - Clicks in the top 20 px set lane-bound numbers.
- Select mode:
  - A click or band on empty space (or an unselected chip) starts a band; without Ctrl it clears first.
  - Dragging a selected chip moves all selected chips by snapped lane and grid deltas, across measures. Ctrl+click on a selected chip deselects it.
  - Overlaps and out-of-lane chips are resolved only at deselect/commit time, where the selected chip wins.
  - Right click opens the context menu: cut/copy/paste/delete, select all/lane/measure, bar length, insert/delete measure.
- The clipboard is internal and stores absolute grids + lanes. Paste goes to the snapped mouse grid, or the view's bottom edge when the mouse is outside; lanes are kept and pasted chips arrive selected.
- Undo is unlimited: a root list of cells and nested transaction directories, with empty directories dropped. Chip ops, selection changes, moves, replace and flip, lane bindings, measure insert/delete/length and header fields are undoable.
- Insert measure = an empty 1.0 measure at the clicked number, with the rest shifted later. Delete = remove the chips + shift down. Length change keeps chip grids (no rescale) and deletes overflow chips.
- Search selects chips by lanes, base-36 number range, decimal measure range and 表/裏 side. Replace acts on the selection (or everything): number replace or 表裏 flip.

## Open questions / porting notes
- **Resolution:** the web parser works in 384 ticks with `pos = (measure+1)·384 + tick` (js/core/dtx.js:1-5, 18). DTXCreator's 192 is lossy on load (CDTXInputOutput.cs:2540). Recommendation: keep 384 internally and offer guide divisions of 384 (1/4..1/64 → 96..6; Free → 1). DTXCreator's measures are 192·ratio tall, while the web model always spans 384 ticks per measure and scales time by bar length. Convert with `tick384 = grid·384/height`.
- **Snapping:** DTXCreator floors to the guide line at or below the pointer; vid2dtx rounds to nearest (vid2dtx-edit.md §4.3). Pick one; nearest is friendlier with a ghost cursor.
- **Occupied cells:** DTXCreator replaces, vid2dtx silently no-ops. Occupancy is also per lane in DTXCreator (HH 表/裏 share a lane) vs per channel in vid2dtx.
- **Lane model mismatch:** DTXCreator has separate LP (1B) and LB (1C) lanes and puts HHC/HHO on one lane via 表/裏. The web app has 10 lanes with LP ⊃ {1B, 1C} and HH ⊃ {11, 18} (CHANNEL_TO_LANE). A port needs a "variant" toggle, the 表/裏 analogue (e.g. Ctrl or a palette choice), for HH and LP. Decide whether BPM, BGM, SE, BGA and guitar lanes are in scope (drums-only is far simpler; guitar needs the V+pattern+OPEN coupling and the save rule).
- **Browser key conflicts:**
  - F5 = reload, F3 = find, F1 = help, Ctrl+N / Ctrl+W are browser shortcuts.
  - The project rule says Space is BD and must not be a decision key; Ctrl+Space for mode toggle also collides with IME switching on Windows.
  - Del, Ctrl+Z/Y/X/C/V/A are usable if handled on the editor canvas with `preventDefault`. Ctrl+F/H would override browser find.
  - New UI strings must go through `js/i18n.js` STRINGS; the DTXCreator resx files give ja/en pairs.
- **No MouseUp:** use pointerup + pointer capture so drags end on release (fixes quirk 12) and auto-scroll on a timer while the pointer is near the edges.
- **Undo design:** DTXCreator's transaction tree maps well to a JS command stack with grouped commands. Decide whether selection changes are undoable steps (DTXCreator: yes; vid2dtx: no undo of selection). Fix quirk 4 by storing the full chip before/after state, and quirk 5 by storing the measure ratio. Make a "following measures" bar-length change a single step. Use object identity rather than "first chip at (lane, pos)" matching.
- **Measure insert/delete:** in the web model this means shifting `measure` on every following chip and on the bar-length (02) and BPM (03/08) events. Decide whether a new measure inherits the bar length (DTXCreator always uses 1.0, but persistent ch-02 semantics in the web parser would make a 1.0 measure inserted after a 3/4 section actually inherit 3/4 unless an explicit `#xxx02: 1` is written).
- **Bar-length change:** DTXCreator keeps chip grid offsets (no rescale) and deletes overflow; in a 384-per-measure model "keep offsets" means rescaling ticks by oldLen/newLen. Choose explicitly.
- **BPM editing:** decide on #BPMxx key allocation (reuse equal values; garbage-collect unused keys on save, unlike DTXCreator) versus writing integer BPMs to ch 03 when possible.
- **Save strategy:** vid2dtx rewrites only drum object lines and keeps everything else verbatim. DTXCreator regenerates the whole file and loses unknown-but-parsed state into the free-text box. The web app keeps `rawLines` (js/core/dtx.js:14, 481), so the vid2dtx approach fits better.
- The web parser reads the measure field with `parseInt(…, 10)` (js/core/dtx.js:373), so base-36 hundreds (`A00`+, measure ≥ 1000) are skipped. Consider fixing this if the editor allows long charts.
- **Hidden lanes, OPEN width, pasting into hidden lanes:** avoid the index-arithmetic leaks of quirks 3 and 13 by moving chips only among visible lanes, or by refusing moves into incompatible lane kinds (e.g. a drum chip onto the BPM lane, which DTXCreator allows and then silently re-channels).
