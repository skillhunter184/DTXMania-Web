# vid2dtx-edit

# vid2dtx 譜面プレビュー / 編集 — Behavioral Specification (merged + corrected)

Source files (absolute):
- `vid2dtx\vid2dtx\preview.py` (855 lines) — window, rendering, editing, save, audio orchestration
- `vid2dtx\vid2dtx\emit.py` (303 lines) — `render_channel_line` (129-141), `LANE_CHANNEL` (23-34), `copy_playable` (163-183), pipeline DTX writer (241-268)
- `vid2dtx\vid2dtx\dtx.py` (228 lines) — parser, `Chip`, `DRUM_CHANNELS`, `LANE_OF_CHANNEL`, base36 helpers
- `vid2dtx\vid2dtx\audio.py` (145 lines) — premix / gain / play / latency probe
- `vid2dtx\vid2dtx\gui.py` — preview button (118-120), `open_preview` (355-368), `copy_to_song` (370-391)
- `vid2dtx\vid2dtx\audio2dtx.py:69, 770-787` — `.conf.json` writer
- `vid2dtx\README.md:48-84` — 譜面プレビュー / 音声再生 / 音ズレ補正 / 編集機能

Conventions: "1080p space" = the 1920x1080 skin coordinate system. "display space" = 1080p × `DISPLAY_SCALE` (0.58) = the Tk canvas pixels. ALL per-frame cv2 drawing in `compose()` (lines, text, rects, chip blits) happens in display space, so thickness 1/2, font scale 0.4, ±3 marker padding, ±4 fallback half-height are DISPLAY pixels. The static base (`render_base`, fallback rects, fallback judge line) is drawn in 1080p space and then downscaled. Colors in source are BGR (cv2); this spec gives RGB everywhere and marks conversions. `int()` = truncation toward zero; Python `round()` = half-to-even; `//` = floor division.

---

## 1. Highway layout constants

### 1.1 Canvas & lane geometry (preview.py:57-63)
```
CANVAS_W, CANVAS_H = 1920, 1080   # drum_bg2.png coordinate space
LANE_X0, LANE_W    = 539, 778     # lane strip left x and width (lane_a.png is 778 wide)
LANE_Y0, LANE_Y1   = 100, 940     # visible highway rows (lane_a rows 100..939 are blitted)
JUDGE_Y            = 845          # judge line y
PADS_Y             = 855          # pads row top y
DISPLAY_SCALE      = 0.58
```
Display canvas (preview.py:233-237, 354-355): `W_s = int(1920*0.58) = 1113`, `H_s = int(1080*0.58) = 626`; Tk Canvas with `highlightthickness=0`, `bg="black"` (so mouse event.x/y are exact display pixels, no border offset). Derived display constants (preview.py:549-551, 558, 577): `judge_s = 490.1`, `lx0 = int(539*0.58) = 312`, `lw = int(778*0.58) = 451` (lane right edge = 763), `y_lo = 58.0`, `y_hi = 545.2`, `y_min = 40.6`, `y_max = 501.7`.

### 1.2 Lane order & display mapping (preview.py:65-67)
```
LANE_ORDER = ["LC","HH","LP","SD","HT","BD","LT","FT","CY"]   # left→right (BD = 6th, wide slot)
DRAW_ON = {name: name for name in LANE_ORDER} | {"RD": "CY"}   # RD chips are drawn on the CY column
```
`Chip.lane` = `LANE_OF_CHANNEL[DRUM_CHANNELS[channel]]` (dtx.py:21-42, 84-87):
```
0x11 HHC→HH, 0x12 SD→SD, 0x13 BD→BD, 0x14 HT→HT, 0x15 LT→LT, 0x16 CY→CY,
0x17 FT→FT, 0x18 HHO→HH, 0x19 RD→RD, 0x1A LC→LC, 0x1B LP→LP, 0x1C LBD→LP
```
Only channels 0x11..0x1C are "drum chips" (`DTXChart.drum_chips()`, dtx.py:103-104). `DRAW_ON.get(c.lane)` is None only for non-drum lanes (never, for drum chips); such chips are skipped (preview.py:582-584).

### 1.3 Lane slots (preview.py:71-73) and derived display values
`LANE_SLOT[name] = (x0, x1)` local to the lane strip; absolute 1080p x = 539 + x. Ranges are contiguous and half-open `[x0, x1)`; boundary pixel 104 belongs to HH, not LC. Dict iteration order = LC,HH,LP,SD,HT,BD,LT,FT,CY.

| lane | x0 | x1 | width | center abs 1080p | `lane_cx_s` (display, preview.py:398-400: `int((539+(x0+x1)/2)*0.58)`) | bar width display (`max(2,int((x1-x0-4)*0.58))`, preview.py:405) | fallback `half` (`int((x1-x0)*0.58/2)-2`, preview.py:593) | ghost x0..x1 display (`(539+x)*0.58`, preview.py:790-792) |
|---|---|---|---|---|---|---|---|---|
| LC | 1 | 104 | 103 | 591.5 | 343 | 57 | 27 | 313.2..372.94 |
| HH | 104 | 181 | 77 | 681.5 | 395 | 42 | 20 | 372.94..417.6 |
| LP | 181 | 258 | 77 | 758.5 | 439 | 42 | 20 | 417.6..462.26 |
| SD | 258 | 344 | 86 | 840 | 487 | 47 | 22 | 462.26..512.14 |
| HT | 344 | 422 | 78 | 922 | 534 | 42 | 20 | 512.14..557.38 |
| BD | 422 | 520 | 98 | 1010 | 585 | 54 | 26 | 557.38..614.22 |
| LT | 520 | 595 | 75 | 1096.5 | 635 | 41 | 19 | 614.22..657.72 |
| FT | 595 | 672 | 77 | 1172.5 | 680 | 42 | 20 | 657.72..702.38 |
| CY | 672 | 776 | 104 | 1263 | 732 | **57** (not 58: `100*0.58 = 57.999…` truncates) | 28 | 702.38..762.7 |
| RD | (uses CY slot) | | | | 732 | 57 | 28 (uses CY slot; color RD) | — |

Bar height in display = `max(2, int(15*0.58)) = 8` for every lane (preview.py:406).

### 1.4 Skin assets (preview.py:49-55, 143-183)
Asset dir: first existing of [`<package>/assets/DrumGame`, a second folder on the author's machine], else the first candidate (preview.py:49-55). Files (verified from PNG headers, all 8-bit RGBA): `drum_bg2.png` 1920x1080, `lane_a.png` 778x1080, `lane_assist_a.png` 778x1080, `drum_chips.png` 770x302, `drum_icons.png` 780x206. Loaded with `cv2.IMREAD_UNCHANGED` via `np.fromfile` (unicode-safe path). If any of bg/lane/chips/icons fails to load → `skin.ok=False` and message `NOTE: skin assets not found in {dir}; using flat-color fallback` printed (preview.py:155-158); `lane_assist_a` is optional (None → guide simply not drawn). If bg is 3-channel it is converted to BGRA (preview.py:159-160); other assets are used as loaded (a 3-channel source is blitted opaquely by `over`).

- `bg_top    = drum_bg2[rows 0:220]`   (220 x 1920 RGBA) — preview.py:162
- `bg_bottom = drum_bg2[rows 900:1080]` (180 x 1920) — preview.py:163
- `lane      = lane_a.png` (full); only rows `100:940` blitted at (539,100) — preview.py:334
- `assist    = lane_assist_a.png`; rows `100:940` blitted at (539,100) after `lane` when the レーンガイド checkbox is on — preview.py:335-337
- `judge     = drum_icons[rows 0:9]` (9 x **780** — 2 px wider than the lane strip; spans x 539..1318) blitted at (539, JUDGE_Y-4 = 841), i.e. rows 841..849 — preview.py:165, 360
- pads source row = `drum_icons[rows 23:107]` (84 x 780) — preview.py:168

**PAD_SRC** `(x, width)` boxes in the pads source row (preview.py:77-79), dict order LC,HH,LP,SD,BD,HT,LT,FT,CY (note BD before HT — the skin's own row has the pedal pad 5th):
`LC (0,88), HH (105,62), LP (179,68), SD (261,76), BD (349,88), HT (447,67), LT (526,70), FT (602,67), CY (693,82)`.
Pads buffer rebuilt as 84 x 778 RGBA, zero-initialised (preview.py:169-177):
```
for name,(sx,sw) in PAD_SRC (dict order):
    x0,x1 = LANE_SLOT[name]
    dx = (x0+x1)//2 - sw//2 ; dx = clamp(dx, 0, 778-sw)
    sprite = row[:, sx:sx+sw]
    per pixel: if sprite.alpha > pads.alpha (strict): copy all 4 channels (no blending)
```
Resulting dx (and x range): LC 8..96, HH 111..173, LP 185..253, SD 263..339, BD 427..515, HT 350..417, LT 522..592, FT 600..667, CY 683..765 — no overlaps, so the copy rule never actually competes. Pads blitted at (539, 855) → rows 855..938.

**CHIP_BOX** `lane → (bar box (x,y,w,h), icon box (x,y,w,h))` in drum_chips.png (preview.py:82-93):
```
LC: bar (0,42,98,15)   icon (5,108,87,88)
HH: bar (102,42,71,15) icon (104,120,67,63)
LP: bar (176,42,74,15) icon (193,117,40,70)
SD: bar (255,42,83,15) icon (272,145,50,15)
BD: bar (346,42,92,15) icon (361,111,56,84)
HT: bar (442,42,72,15) icon (445,228,66,48)
LT: bar (517,42,72,15) icon (520,228,66,48)
FT: bar (593,42,72,15) icon (596,228,66,48)
CY: bar (669,42,99,15) icon (675,112,83,78)
RD: bar (669,42,99,15) icon (602,125,53,53)
```
All bars 15 px tall, all at source row 42. Both boxes are copied into `skin.bar[lane]` / `skin.icon[lane]` (preview.py:178-182) but **icons are never drawn** — `compose()` only draws bars (preview.py:585-597). RD uses the same bar as CY.

Bar sprites pre-scaled once (preview.py:401-408): for each lane in CHIP_BOX (10 entries incl. RD), `col = DRAW_ON.get(lane, lane)`, `w = max(2, int((slot_x1-slot_x0-4)*0.58))`, `h = 8`; `cv2.resize(bar, (w,h), INTER_AREA)` — RGBA including alpha is area-resampled. The bar is stretched/squeezed to (lane width − 4) regardless of its source width (see table in 1.3).

### 1.5 Fallback colors (preview.py:111-116) — source BGR; **RGB** here
```
LC (236,146,188)  HH (146,193,236)  LP (236,146,187)  SD (236,228,146)  BD (187,174,238)
HT (151,236,145)  LT (236,145,149)  FT (209,146,236)  CY (145,193,235)  RD (145,193,235)
```
Keyed by chip lane (RD has its own entry, same color as CY).

### 1.6 Speed
`speed_var` IntVar default **560 px/s in 1080p space** (preview.py:241); ttk.Spinbox `from_=200, to=2000, increment=40, width=6` (preview.py:254-257). Display px/s = `speed*0.58` (preview.py:549). The spinbox `command=self.redraw` fires only on arrow clicks; a typed value takes effect at the next redraw of any kind. A non-integer typed value makes `speed_var.get()` raise (uncaught) — no validation.

---

## 2. Static base & per-frame composition

### 2.1 Alpha blend primitive `over(dst_bgr, src, x, y)` (preview.py:127-140)
Clipped to dst. If src has 4 channels: `a = alpha/255 (float32); dst = (src_rgb*a + dst*(1-a)).astype(uint8)` (truncation). If src has 3 channels: opaque copy. Used for every blit (base, strips, bars).

### 2.2 Static base (built in `prepare_display`, once at open and again whenever レーンガイド toggles via `rebase()`) — preview.py:331-366, 410-415
Skin mode, in this order on a black 1920x1080 BGR canvas:
1. `lane_a[100:940]` at (539,100)
2. if guide on and assist loaded: `lane_assist_a[100:940]` at (539,100)
3. `bg_top` at (0,0)                (rows 0..219 — covers the top of the lane strip)
4. `bg_bottom` at (0,900)           (rows 900..1079)
5. `judge` (9x780) at (539,841)
6. `pads` (84x778) at (539,855)     (over bg_bottom)
Then `cv2.resize` to 1113x626 with INTER_AREA → `base_s`.

Fallback mode (skin.ok False): fill RGB (16,16,16); for each lane in LANE_ORDER draw a 1-px outline rect RGB (40,40,40) from (539+x0,100) to (539+x1,940) [in 1080p space, so ~0.58 px after downscale]; judge line RGB (230,230,0) [BGR (0,230,230)] thickness 3 from (539,845) to (1317,845) (preview.py:338-343, 362-364). No strips are prepared (`top_piece = bot_piece = None`), `bar_s` stays empty.

### 2.3 Overlay strips re-blended after chips ("chips slide under the frame") — preview.py:368-393 (skin mode only)
Strip x-range in 1080p: `x0 = LANE_X0-4 = 535`, `x1 = LANE_X0+LANE_W+70 = 1387` (width 852; the +70 keeps the measure-number margin under the frame). `piece_x = int(535*0.58) = 310`.
- `top_piece = bg_top[:, 535:1387]` (220x852 RGBA) → resize to `(int(852*.58), int(220*.58)) = 494 x 127` → drawn at display (310, 0), covering x 310..803, y 0..126.
- `bot_piece`: RGBA canvas `h = 1080-855 = 225` rows x 852 cols, zeros. Place `bg_bottom[:, 535:1387]` (180 rows) at rows `900-855 = 45 .. 225`. Then blend the 84x778 pads onto rows 0..84, columns `px = 539-535 = 4 .. 782`: `rgb = pads_rgb*a + canvas_rgb*(1-a)` (truncated), `alpha = max(canvas_alpha, pads_alpha)`. Resize to `494 x int(225*.58) = 130` → drawn at (310, `piece_bot_y = int(855*0.58) = 495`), covering y 495..624.
Consequence: rows 855..899 (1080p) of the bottom piece are transparent except where pads are, so chips between the judge line and the frame (y ≤ 865) show around the pads. The judge strip is in the base, i.e. chips draw OVER the judge line; only the top frame and bottom frame+pads cover chips.

### 2.4 Per-frame `compose(t_view)` — preview.py:547-613
```
S = 0.58; pxps_s = speed*S; judge_s = 845*S = 490.1
lx0 = 312 ; lw = 451
img = base_s.copy()
y_of(t) = judge_s - (t - t_view) * pxps_s          # display px, float; future chips are ABOVE the judge line

# (a) beat / measure lines — drawn BEFORE chips (chips cover lines)
y_lo, y_hi = 58.0, 545.2                            # 100*S, 940*S
for m in range(0, chart.last_measure + 2):          # measures 0 .. last_measure+1 (all have measure_start)
    t0 = measure_start.get(m); if None: continue
    mlen = measure_len.get(m, 0)
    for b in 0..3:
        y = y_of(t0 + mlen*b/4)                     # beats always quarter the measure (ignores mid-measure BPM changes and bar length ratio)
        if not (y_lo <= y <= y_hi): continue
        color = RGB(200,200,200) if b==0 else RGB(70,70,70)
        cv2.line((lx0, int(y)) → (lx0+lw, int(y)), color, thickness 2 if b==0 else 1, non-AA)
        if b==0: cv2.putText(f"{m:03d}", origin (lx0+lw+5 = 768, int(y)+4) [bottom-left baseline],
                             FONT_HERSHEY_SIMPLEX, scale 0.4, RGB(220,220,220), thickness 1, LINE_AA)
                 # Hershey Simplex at scale 0.4 ≈ 9 px cap height, ≈ 8 px per digit (approximate)
# No grid lines exist beyond measure last_measure+1 (extrapolated region has no lines, though chips can be added there).

# (b) chips — sort by time DESCENDING (stable: equal times keep list order), so higher/later chips draw first, nearer chips on top
y_min, y_max = 40.6, 501.7                          # (100-30)*S .. (845+20)*S
for c in sorted(chips, key=time, reverse=True):
    y = y_of(c.time); if not (y_min <= y <= y_max): continue
    col = DRAW_ON.get(c.lane); if None: continue
    cx = lane_cx_s[col]
    bar = bar_s.get(c.lane)                         # keyed by chip lane ("RD" has its own entry)
    if bar: over(img, bar, cx - bw//2, int(y) - bh//2); bw,bh = bar size (see table; bh=8)
    else (fallback): half = int((x1-x0)*S/2) - 2
                     cv2.rectangle((cx-half, int(y)-4) → (cx+half, int(y)+4), FALLBACK_COLOR[c.lane], filled)
                     # corners inclusive → drawn size (2*half+1) x 9
                     bw,bh = half*2, 8
    # (c) confidence marker (only if sidecar loaded AND 確信度 checkbox on)
    cf = conf.get((c.measure, c.tick, c.channel))
    if cf is not None and cf < 0.7:
        color = RGB(255,0,0) if cf < 0.4 else RGB(255,150,0)          # BGR (0,0,255) / (0,150,255)
        cv2.rectangle((cx-bw//2-3, int(y)-bh//2-3) → (cx+bw//2+3, int(y)+bh//2+3), color, thickness 2 outline)

# (d) strips back on top (skin mode only)
if top_piece: over(img, top_piece, 310, 0); over(img, bot_piece, 310, 495)
```
Visibility summary: chips that have passed the judge line remain visible until 20 px (1080p) below it (y_1080 ≤ 865), then vanish; chips are culled 30 px above LANE_Y0 (y_1080 ≥ 70) and are partially hidden by the top strip (rows 0..219). Markers are drawn before the strips, so they are also covered.

The composed BGR image is encoded as PPM and shown as a Tk PhotoImage at (0,0) anchor nw (preview.py:615-624). `snapshot(path, t_view)` writes `compose(t_view)` with `cv2.imwrite` (preview.py:640-641; API only, no UI).

### 2.5 Info label after each redraw — preview.py:626-638
`m_now = max{m ∈ measure_start : measure_start[m] <= t_view}` (0 if none; can be last_measure+1 at the end). Text: `f"t={t_view:6.2f}s  小節 {m_now:03d}  チップ総数 {len(chips)}"` (`6.2f` pads to width 6, e.g. `t=  1.50s`), plus `f"  要確認 {n_sus}"` when a sidecar is loaded, where `n_sus = count(chips with conf.get(key, 1.0) < 0.7)`.
The same label doubles as the status line: `append_status(msg)` (preview.py:830-831) replaces its text; the next `redraw()` replaces it again with the `t=` text. `begin_audio_build` sets it to `音声を準備中...` (preview.py:472); when the build finishes `poll_audio_build` sets it to `""` (success) or `音源ファイルが見つかりません(無音)` (preview.py:493-495) — this clears the `t=` text until the next redraw.

---

## 3. y_of(t) and thresholds (1080p space summary)
```
y_1080(t) = 845 - (t - t_view) * speed
beat/measure lines drawn iff 100 <= y <= 940
chips drawn iff 70 <= y <= 865
click accepted iff 80 <= y <= 865
```
Display = ×0.58; `int()` truncation is applied to y in display space when drawing.

---

## 4. EDIT feature semantics

### 4.1 Canvas → (lane, time) — `canvas_to_lane_time(cx, cy)` preview.py:669-679
```
x = cx / 0.58 - 539            # lane-local 1080p x
y = cy / 0.58
if not (80 <= y <= 865): return (None,None)          # LANE_Y0-20 .. JUDGE_Y+20 (display 46.4..501.7)
for col,(x0,x1) in LANE_SLOT (dict order):
    if x0 <= x < x1:
        t = t_view + (845 - y) / speed               # y below the judge line → t < t_view (past)
        return (col, t)
return (None,None)              # x<1 or x>=776 → no lane
```
There is no clamp on t; t may be negative near the start (handled by `time_to_mt` → None).

### 4.2 Snap grid (preview.py:95, 285-289)
Label `スナップ:`; ttk.Combobox readonly, width 5, values in order `"16分","24分","32分","48分"`, default `"16分"`.
`SNAP_TICKS = {"16分":24, "24分":16, "32分":12, "48分":8}` (ticks of 384 per measure).

### 4.3 `time_to_mt(t)` — preview.py:681-704
`measure_start`/`measure_len` exist for m in `0 .. last_measure+1` (dtx.py:186-203), contiguous (start[m+1] = start[m]+len[m]); `last = max(measure_start) = last_measure+1`.
```
if t < 0: return None
m = first mm in ascending order with ms[mm] <= t < ms[mm] + ml.get(mm,0)
if m is None:                                  # t beyond ms[last]+ml[last]: extrapolate with the last measure length
    length = ml[last] or 1.0
    extra  = int((t - ms[last]) // length)     # floor
    m      = last + extra
    start  = ms[last] + extra*length
    length = ml[last]                          # NOTE: if ml[last]==0 this then raises ZeroDivisionError (never in practice; BPM>0)
else: start, length = ms[m], ml[m]
snap = SNAP_TICKS[snap_var]
tick = round((t - start)/length * 384 / snap) * snap      # Python round = half-to-even; result int
if tick >= 384: m, tick = m+1, 0
return (m, tick)
```
Linear within the measure — mid-measure BPM changes (channel 03/08 events at tick>0) are ignored here, unlike the parser's `time_of` (dtx.py:205-217).

### 4.4 `mt_to_time(m, tick)` — preview.py:706-711
```
if m in ms: return ms[m] + ml[m]*tick/384
else:       return ms[last] + (m-last)*ml[last] + ml[last]*tick/384
```
Also linear within the measure; a chip added into a measure with a mid-measure BPM change gets a slightly different `time` than the parser will compute on reload (visual-only difference; the saved (measure,tick) is what matters).

### 4.5 `find_chip_at(col, t, tol_px=14)` — preview.py:713-722
`tol = 14 / speed` seconds (14 px in 1080p space, 1080p speed). Among chips with `DRAW_ON.get(c.lane) == col` (so RD chips are hit-tested on the CY column, HHC/HHO both on HH, LP/LBD both on LP), pick the one minimizing `|c.time - t|` with strict `d < best_d` (initial best_d = tol; ties keep the earliest in list order). Returns None if none within tolerance.

### 4.6 Click handling — `on_click(event, delete_only)` preview.py:316-317, 724-754
Bindings on the canvas: `<Button-1>` → `delete_only=False`; `<Button-3>` (right) → `delete_only=True`.
```
(col, t) = canvas_to_lane_time(x, y); if col None: return           # no redraw
hit = find_chip_at(col, t)
if hit:                                    # toggle → delete (both buttons)
    chips.remove(hit)                      # list.remove uses dataclass equality (time,measure,tick,channel,chip_id) → removes first equal chip
    undo_stack.push(("del", hit))
    audio_dirty=True; audio_gen++; mark_modified(True)
elif not delete_only:                      # add (left button only)
    mt = time_to_mt(t); if None: return    # t<0 → no-op, no redraw
    (m, tick) = mt
    (channel, chip_id) = lane_default[col]
    chip = Chip(time=mt_to_time(m,tick), m, tick, channel, chip_id)
    if any(c.measure==m and c.tick==tick and c.channel==channel for c in chips): return   # occupied: silent no-op, no redraw
    chips.append(chip)                     # appended at end; list is NOT re-sorted (draw order handles it)
    undo_stack.push(("add", chip))
    audio_dirty=True; audio_gen++
    if chip.time > duration - 1: duration = chip.time + 2.0; slider.config(to=duration)
    mark_modified(True)
redraw()                                   # also runs for a right-click on empty lane space
```
Occupancy is per (measure, tick, channel): a chip on the same column but a different channel (HHC vs HHO on HH, CY vs RD on CY) does not block. Deleting never shrinks `duration`; undo never changes it.

### 4.7 Lane default (channel, chip id) — preview.py:97-101, 212-223
For each display column, count `(channel, chip_id)` over the chips whose `DRAW_ON[lane] == col`; default = `Counter.most_common(1)` (ties → first inserted, i.e. first encountered in load order). If the column has no chips: `(CANONICAL_CHANNEL[col], 1)`:
`CANONICAL_CHANNEL = {LC:0x1A, HH:0x18, LP:0x1B, SD:0x12, HT:0x14, BD:0x13, LT:0x15, FT:0x17, CY:0x16}`.
Because counting is per display column, the CY column's default can be `(0x19, id)` (RD) when RD chips outnumber CY chips; likewise HH may default to 0x11 (HHC) and LP to 0x1C (LBD). Computed once at load; NOT updated after edits (README:75: 追加ノーツの音色はそのレーンで最も使われているWAV/チャンネルを自動採用).

### 4.8 Undo — preview.py:314, 756-767
Stack of `(op, chip)`; `<Control-z>` (window-wide, lowercase z keysym) or 「元に戻す」 pops the top: `"add"` → `chips.remove(chip)` (first equal); `"del"` → `chips.append(chip)` (at end). Then `audio_dirty=True; gen++; mark_modified(len(stack)>0); redraw()`. Empty stack → no-op. Save does NOT clear the stack. Quirk: edit → save → undo makes `modified=False` (stack empty) although memory now differs from disk.

### 4.9 Modified flag — `mark_modified(flag=True)` preview.py:769-775
`modified=flag`; `base = current_title.lstrip("*")` (strips ALL leading asterisks); title = (`"*"` if flag else `""`) + base; 「保存」 enabled iff flag; 「元に戻す」 enabled iff stack non-empty. Base title at open: `f"譜面プレビュー - {headers.get('TITLE', filename)}"` (preview.py:229-230) — `dict.get`, so an empty `#TITLE:` yields `譜面プレビュー - ` (not the filename); the filename is used only when the header is absent.

### 4.10 Ghost cursor — preview.py:318-319, 778-802
On `<Motion>` over the canvas: `(col,t) = canvas_to_lane_time`; if col None → hide. `mt = time_to_mt(t)`; if None → hide. `ts = mt_to_time(*mt)`; `y = (845 - (ts - t_view)*speed)*0.58`; `x0 = (539+slot.x0)*0.58`, `x1 = (539+slot.x1)*0.58` (full slot width, floats — see table 1.3); Tk canvas rectangle `(x0, y-4, x1, y+4)`, `outline="#00ff88"`, `width=2`, no fill. It is a separate Tk canvas item drawn ABOVE the composed image (so above the frame strips), not clamped to the highway, and only repositioned on mouse motion (not on scroll/redraw). `<Leave>` hides it (state hidden; the item is reused).

### 4.11 Duration & slider
`duration = max(chip.time) + 2.0` at load (preview.py:195); ttk.Scale `from_=0.0, to=duration` bound to `t_var` (preview.py:249-252); `to` extended on add as in 4.6.

### 4.12 Close — preview.py:320, 833-844
`WM_DELETE_WINDOW`: if modified → `askyesnocancel(title "vid2dtx", "編集内容が保存されていません。保存しますか?")`: Cancel/None → abort close; Yes → `save()` then close; No → close without saving. Then `playing=False; stop_audio(); destroy()`.

---

## 5. Save (`<Control-s>` / 「保存」) — preview.py:315, 805-828
```
if not modified: return
text = path.read_text(encoding="cp932")                   # STRICT (parser uses errors="replace"); undecodable bytes → uncaught UnicodeDecodeError
kept = [ln for ln in text.splitlines() if not is_drum_object_line(ln)]   # splitlines: \r\n, \n, \r (and other Unicode line breaks)
while kept and kept[-1].strip()=="" : kept.pop()           # trim trailing blank lines
by_mc: (measure, channel) -> [(tick, chip_id)...] in current chips list order (NOT tick-sorted)
lines = kept + [""] + [render_channel_line(m, ch, tc) for (m,ch),tc in sorted(by_mc.items())]   # sorted by (measure, channel)
if not backup_done:                                        # once per window session
    bak = path.with_suffix(".dtx.bak")                     # "generated.dtx" -> "generated.dtx.bak"; "a.b.dtx" -> "a.b.dtx.bak"
    if not bak.exists(): shutil.copy2(path, bak)           # never overwrites an existing .bak
    backup_done = True
path.write_text("\n".join(lines) + "\n", encoding="cp932", newline="\r\n")   # every \n → CRLF; file ends with CRLF
mark_modified(False); append_status(f"保存しました: {path.name}")            # no redraw → status stays until next redraw
```
`is_drum_object_line(line)` (preview.py:103-108): `OBJ_LINE = ^#([0-9A-Za-z]\d\d)([0-9A-Fa-f]{2})\s*:` matched against `line.strip()` (leading whitespace tolerated), AND `int(channel,16) ∈ DRUM_CHANNELS` (0x11..0x1C). Everything else is kept verbatim in original order: headers, `#WAVxx/#VOLUMExx/#PANxx`, `#BGMWAV`, `#00001` BGM, `#xxx02` bar length, `#xxx03/#xxx08` BPM, other non-drum channels, `;` comment lines, blank lines. Edge cases: (a) a drum object line written with a space instead of a colon (`#00112 0202`) is parsed by `dtx.parse` (dtx.py:120-123) but NOT matched by OBJ_LINE → kept verbatim AND regenerated → duplicated on reload; (b) trailing `;comments` on drum object lines are lost; (c) `measure_str` raises `ValueError` for m > 3599 → save fails (uncaught) if a chip was added that far; (d) saving is idempotent (re-saving strips the regenerated block again).

### `render_channel_line(measure, channel, ticks_chips)` — emit.py:129-141
```
g = 384; for (t,_) in ticks_chips: g = gcd(g, t)      # gcd(384,0)=384 → single tick-0 chip gives 1 cell
n = 384 // g ; cells = ["00"]*n
for (t, chip) in ticks_chips:                         # input order
    if cells[t//g] != "00": print(f"WARNING: duplicate chip at measure {measure} tick {t} channel {channel:02X}; keeping one")
    cells[t//g] = to_b36(chip)                        # last one wins
return f"#{measure_str(measure)}{channel:02X}: {''.join(cells)}"
```
`to_b36(n) = BASE36[n//36] + BASE36[n%36]` (dtx.py:57-58; valid for n < 1296; chip id 0 would emit "00" = empty). `measure_str(m) = BASE36[m//100] + f"{m%100:02d}"`, ValueError unless 0 ≤ m ≤ 3599 (dtx.py:61-65). Channel is 2-digit uppercase hex. Examples: ticks {0,96,192,288} chip 2 → `#00112: 02020202`; single tick 0 → `#00112: 02`; a tick not on the 24/16/12/8 grid (e.g. loaded from a file with tick 5) → gcd 1 → 384 cells (768 chars).

### DTX file written by the pipeline (emit.py:241-268), for reference
`; Created by vid2dtx`, ``, `#TITLE: {title}`, `#COMMENT: auto-generated from play video`, `#BPM: {bpm}` (round 2 decimals; integer when within 0.02 of one), `#DLEVEL: 50`, ``, then per lane in LANE_CHANNEL order `#WAVxx: file\t;label`, `#VOLUMExx: vol`, `#PANxx: pan` (omitted when 0), then `#WAV0B: bgm.ogg\t;BGM`, `#BGMWAV: 0B`, ``, `#00001: 0B`, object lines sorted by (measure, channel), ``, + final `\n`; cp932 + CRLF.
`LANE_CHANNEL` (emit.py:23-34) lane → (channel, wav id, file, label, vol, pan): LC (0x1A, 5, "049_lc_.ogg", "Left Crash", 80, -30); HH (0x18, 3, "101_hh_op_2.ogg", "Hi-Hat", 70, -30); LP (0x1B, 4, "106_LP_2.ogg", "Hi-Hat Pedal", 50, -30); SD (0x12, 2, "038_sn3_center_strong_2.ogg", "Snare", 90, -10); HT (0x14, 7, "045_tom1_.ogg", "High Tom", 90, 0); BD (0x13, 1, "036_kick1_2.ogg", "Bass Drum", 100, 0); LT (0x15, 8, "043_tom2_.ogg", "Low Tom", 90, 20); FT (0x17, 9, "041_tom3_.ogg", "Floor Tom", 90, 40); CY (0x16, 6, "055_rc_2.ogg", "Right Crash", 80, 30); RD (0x19, 10, "051_Ride_Cymbal.ogg", "Ride", 80, 50). `BGM_ID = 11` ("0B"). audio2dtx adds `EXTRA_LANES HHC (0x11, 12, "104_hh_cl_2.ogg", "Hi-Hat Close", 60, -30)` (audio2dtx.py:72).

### Export to song folder (gui.py:370-391; emit.py:163-183 `copy_playable`)
Enabled only after a successful run. Directory dialog title `書き出し先の曲フォルダ (ドラム音源oggが入っているフォルダ)`; dst = `<song>/vid2dtx.dtx`; if it exists → askyesno `"{dst}\nは既に存在します。上書きしますか?"`. Reads `generated.dtx` (cp932), replaces every `bgm.ogg` → `vid2dtx_bgm.ogg`, writes cp932/CRLF; copies `bgm.ogg` → `vid2dtx_bgm.ogg` if present; copies `generated.dtx.conf.json` → `vid2dtx.dtx.conf.json` if present. OSError → `書き出しに失敗しました:\n{e}`; success → log `曲フォルダへ書き出しました: {out}` and info box `書き出しました:\n{out}\n\n注意: 譜面が参照するドラム音源oggが同じフォルダに必要です (README参照)`.

---

## 6. Audio preview (audio.py)
Premix: decode the BGM and every drum WAV referenced by the current chips (ffmpeg → float32 stereo 44100 Hz), mix at chart times into one buffer, play from any position. `AVAILABLE` = `import sounddevice` succeeded (audio.py:17-22); `SR = 44100`.

### `decode_pcm(path)` — audio.py:27-38
Requires ffmpeg (`find_ffmpeg`) and an existing file; runs `ffmpeg -v error -i <path> -f f32le -ac 2 -ar 44100 -`; returns `(n,2)` float32 or None if returncode ≠ 0 or output < 8 bytes.

### `ChartAudio.build(chart, chips)` — audio.py:49-103 (chart dir = chart file's parent)
```
vol_pan(wav_id):
    sfx = to_b36(wav_id)                                       # uppercase base36
    vol = float(headers.get("VOLUME"+sfx, headers.get("WAVVOL"+sfx, 100)))   # header keys are uppercased by the parser
    pan = float(headers.get("PAN"+sfx,    headers.get("WAVPAN"+sfx, 0)))
    g = clamp(vol,0,100)/100 ; p = clamp(pan,-100,100)/100
    return (g, g*min(1, 1-p), g*min(1, 1+p))                   # (mono, left, right): pan>0 attenuates left, pan<0 attenuates right
used = {chip_id of chips passed in (drum chips snapshot)} ∪ {chip_id of chart.chips with channel 0x01 (BGM; from the ORIGINAL parse, unaffected by edits)}
pcm[wid] = decode_pcm(chart_dir / chart.wavs[wid]) for each used id with a #WAV entry that decodes
end = 1.0; for c in chips ∪ bgm_chips with pcm: end = max(end, c.time + len(pcm)/SR)
buf = zeros((int(end*SR) + SR, 2), float32)                    # +1 s tail
for c in bgm_chips + chips:                                    # BGM first, then drums, additive
    data = pcm.get(c.chip_id); skip if None; (_, gl, gr) = vol_pan(c.chip_id)
    i0 = int(c.time*SR); i1 = min(i0+len(data), len(buf)); skip if i1 <= i0
    buf[i0:i1,0] += data[:i1-i0,0]*gl ; buf[i0:i1,1] += data[:i1-i0,1]*gr
peak = max|buf| ; if peak > 1.0: buf /= peak*1.05              # normalize only when clipping (peak → ≈0.952)
return len(pcm) > 0                                            # False → status "音源ファイルが見つかりません(無音)"
```
A non-numeric `#VOLUMExx` raises inside the worker thread (uncaught) — original quirk: `_audio_building` stays True and audio never starts.

### `play(t, ahead_s)` / `stop()` — audio.py:105-130
`i = max(0, int((t + ahead_s)*SR))`; if `i >= len(buf)` → no playback; else `sd.play(buf[i:], 44100, latency="low")` (sounddevice's `play` implicitly stops any previous playback, so re-anchoring is a seamless restart). `ahead_s = offset_ms/1000` (preview.py:451-457): a positive offset starts further into the buffer → sound arrives earlier relative to the visuals → label `+で音が早く`. Near t=0 a negative offset clamps to index 0 (audio cannot be delayed below the buffer start). `stop()` calls `sd.stop()` only if this object's `playing` flag is set.

### Latency offset UI (preview.py:267-272, 290-294, 459-466)
Label `音ズレ補正(ms):`; ttk.Spinbox `from_=-300, to=300, increment=5, width=5`; trailing label `+で音が早く`. Initial value: `int(prefs["audio_offset_ms"])` if present, else `int(round(output_latency_ms()/5)*5)` (half-to-even, e.g. 92.5 → 90). `output_latency_ms()` (audio.py:133-145): if unavailable → 90.0; else open `sd.OutputStream(samplerate=44100, channels=2, latency="low")`, start, read `stream.latency*1000`, stop/close; any exception → 90.0. On spinbox arrow click (`command`, not on typing): `save_prefs({"audio_offset_ms": int(value)})` (the prefs file is REPLACED with just this key), then if `playing and audio is not None and not audio_dirty` → `play_audio_now()` (restart at current position with new offset = instant audible feedback). A typed value is used at the next play start (`play_audio_now` reads the var; unparsable → 0) but is not persisted until an arrow click.
Prefs file: `~/.vid2dtx_preview.json`, UTF-8 JSON `{"audio_offset_ms": <int>}`; read errors → `{}`; write errors ignored (preview.py:31-47).

### Build/play orchestration (preview.py:326-328, 410-415, 435-513)
- At open: if `AVAILABLE and audio_var`: create `ChartAudio` and `begin_audio_build()` (prefetch). `audio_dirty` starts True.
- `start_audio()`: if audio checkbox off or unavailable → nothing. Create ChartAudio if None. If `audio_dirty or _audio_building` → `_want_audio=True; begin_audio_build()`; else `play_audio_now()`.
- `begin_audio_build()`: no-op if already building or `self.audio is None`; set building; info `音声を準備中...`; snapshot `gen = _audio_gen` and `list(chips)`; worker thread runs `build(chart, snapshot)`, records `_audio_build_ok`, `_audio_built_gen = gen`, clears building; poll every 100 ms via `after`.
- `poll_audio_build()`: when done: `audio_dirty = (_audio_built_gen != _audio_gen)` (edits during the build keep it dirty); info `""` or `音源ファイルが見つかりません(無音)`; if `_want_audio and playing and audio_var`: dirty → `begin_audio_build()` and return (keeps `_want_audio`), else `play_audio_now()` (joins at the then-current position). Finally `_want_audio=False`.
- Every add/delete/undo: `audio_dirty=True; _audio_gen += 1`.
- `rebase()` (レーンガイド toggle): re-prepare display, redraw, and if audio on: create a NEW `ChartAudio` and `begin_audio_build()`. Quirk: a stream started by the old object keeps playing and the new object's `stop()` is a no-op (its `playing` is False) until the next `play()`.
- 「音声」 checkbox (`on_audio_toggle`): default on iff sounddevice available (disabled otherwise); if not playing → nothing; if playing: on → `start_audio()`, off → `stop_audio()`.
- README:59-64: mix built on first play (~1 s), follows seeks, auto-remixed at the next play start after edits; silent preview when no audio device.

---

## 7. Playback controls & UI (preview.py:238-320, 417-545)
Control bar (pack left→right, padx 6 / pady 4): Button `▶ 再生` / `⏸ 停止` (width 8); Label `位置:`; horizontal ttk.Scale 0..duration (fill x, expand); Label `速度:`; Spinbox 200..2000 step 40 (default 560, width 6); Checkbutton `レーンガイド` (default on, command `rebase`); Checkbutton `音声`; info Label (padx 8).
Edit bar: Label `スナップ:` + Combobox; Label `音ズレ補正(ms):` + Spinbox + Label `+で音が早く`; Button `保存` (width 8, disabled until modified); Button `元に戻す` (width 9, disabled until stack non-empty); if a sidecar was loaded: Checkbutton `確信度` (default on, command redraw), Button `次の要確認 ▼` (width 12), key `<Key-n>` bound on the window; hint Label `左クリック: ノーツ追加 / ノーツ上で削除　右クリック: 削除　Ctrl+Z: 元に戻す　Ctrl+S: 保存` (full-width ideographic spaces between the three groups).

Bindings: window `<MouseWheel>` → `scroll(-delta/120)` (anywhere in the window, not only the canvas); window `<Control-z>` → undo; `<Control-s>` → save; canvas `<Button-1>`, `<Button-3>`, `<Motion>`, `<Leave>`; `WM_DELETE_WINDOW` → `on_close`.

```
toggle_play():                                            # preview.py:515-524
    playing = !playing ; button text = "⏸ 停止" if playing else "▶ 再生"
    if playing:
        if t >= duration - 0.05: t = 0                    # replay from the top
        reanchor()                                        # anchor=(monotonic_now, t); start_audio() because playing
        after(16 ms, play_tick)
    else: stop_audio()

play_tick():                                              # preview.py:526-544
    if !playing or window destroyed: return
    frame_start = now
    t = anchor_t + (frame_start - anchor_wall)
    if t >= duration: t = duration; playing=False; button "▶ 再生"; stop_audio()
    set slider/t_var = t with _from_play guard (so on_slider does not re-anchor); redraw()
    if playing: after(max(1, int(16.7 - elapsed_ms)), play_tick)     # ~60 fps

on_slider() (user scrub; ttk.Scale command):              # preview.py:424-428
    if _from_play: return
    reanchor()   # restarts audio from the new position if playing
    redraw()

reanchor(): _anchor = (monotonic(), t_var); if playing: start_audio()      # preview.py:430-433

scroll(steps): t = clamp(t + steps*0.15, 0, duration); reanchor(); redraw()   # preview.py:417-421
    # Windows wheel delta = ±120 per notch → wheel down (delta −120) = +0.15 s, wheel up = −0.15 s
```
Initial state: t=0, not playing, one `redraw()` at open.

---

## 8. Confidence sidecar
Path: `str(chart_path) + ".conf.json"` (e.g. `generated.dtx.conf.json`), UTF-8 JSON (preview.py:196-208; writer audio2dtx.py:770-787):
```
{"version": 1, "chips": [ {"m": <measure int>, "tick": <0..383>, "ch": <channel as int, e.g. 18 for 0x12>, "conf": <float 0..1>, "why": <string>}, ... ]}
```
Preview reads only `m`, `tick`, `ch`, `conf` (each cast with int()/float()) into `conf[(m, tick, ch)] = conf`; any exception while parsing → `conf = {}` (no sidecar UI). A chip with no entry is treated as conf 1.0 (never flagged). Writer: rows in (m, tick) order, one per emitted chip; synthesized chips get `SYNTH_CONF = 0.35` (audio2dtx.py:69). Export copies the sidecar alongside the chart (emit.py:180-182).

Markers (preview.py:598-606): drawn only when `conf < 0.7`; **red RGB(255,0,0)** if `conf < 0.4`, else **orange RGB(255,150,0)**; 2-px outline rect padded 3 display px around the bar (`(cx-bw//2-3, y-bh//2-3)` → `(cx+bw//2+3, y+bh//2+3)`, inclusive corners). Toggle via `確信度` (redraw on change). Lookup key = (measure, tick, channel) of the chip, so an added chip is never flagged and a re-added chip at the same cell is.

`goto_next_suspect()` (preview.py:643-666; button or key `n`, only when sidecar loaded):
```
sus = sorted((conf[key], c.time) for chips with conf.get(key,1.0) < 0.7)   # ascending: least confident first, then earliest
if empty: append_status("要確認チップはありません"); return
prev = _sus_key (None on first call)
idx = bisect_right(sus, prev) if prev is not None else 0 ; if idx >= len(sus): idx = 0   # wrap
_sus_key = sus[idx]; (cf, t) = sus[idx]
t_var = min(t, duration); reanchor(); redraw(); append_status(f"要確認 {idx+1}/{len(sus)}  確信度 {cf:.2f}")
```
(README:82-84: 低確信チップに橙/赤の枠、「次の要確認 ▼」(nキー) で確信度の低い順に巡回.)

---

## 9. GUI invocation & CLI (gui.py:118-120, 355-368; preview.py:847-855)
Button `譜面プレビュー...` (always enabled). If the last pipeline run succeeded (`run_ok and gen_dir`) → open `<gen_dir>/generated.dtx` directly; else `askopenfilename(title="プレビューするDTXを選択", filetypes=[("DTX譜面","*.dtx"),("すべて","*.*")])` (cancel → return). `PreviewWindow(root, path)` as a Toplevel; `except Exception as e` → `showerror("vid2dtx", f"プレビューを開けません:\n{e}")`. `PreviewWindow` raises `SystemExit("chart has no drum chips")` when the chart has no drum chips (preview.py:192-193) — `SystemExit` is not an `Exception`, so it escapes the handler and the Tk mainloop, terminating the GUI process (original quirk). CLI: `python -m vid2dtx.preview <chart.dtx>` (own Tk root; missing arg → `usage: python -m vid2dtx.preview <chart.dtx>`). README:52-57 describes the highway: スピーカーフレーム+レーン+判定ライン+パッド, チップをレーン色の横バーで描画, BDは6番目の広いレーン; skin loaded from `vid2dtx/assets/DrumGame/` (not in git), fallback = 単色矩形 (README:78-79).

## 10. Parser facts the preview relies on (dtx.py:110-222)
- Read cp932 with `errors="replace"`; per line: cut at first `;`, strip; must start with `#`; split at first `:` if present else at first space; `cmd`/`param` stripped.
- Object lines `^([0-9A-Za-z]\d\d)([0-9A-Fa-f]{2})$` on cmd: measure = base36(first char)*100 + int(next two); channel hex. Channel 0x02 → `bar_length_changes[measure] = float(param with ',' → '.')`. Others: `_` removed from data; `n = len(data)//2` pairs; chip i at `tick = (384*i)//n`; pair value = hex for channel 0x03 else base36 (case-insensitive); `00`/invalid pairs skipped. Channel 0x03 → BPM event `basebpm + value`; 0x08 → `basebpm + bpm_table[value]` if defined; anything else → note (channel, chip id) — including non-drum channels (kept in `chart.chips`, excluded by `drum_chips()`).
- Headers: `#WAVxx` (5-char key) → `wavs[b36(xx)] = param`; `#BPM`/`#BPM00` → `base_bpm` and `headers["BPM"]`; `#BASEBPM` → `basebpm`; `#BPMxx` → `bpm_table`; everything else → `headers[UPPER(cmd)] = param` (so `VOLUME0B`, `PAN0B`, `TITLE`, `BGMWAV`, …).
- `last_measure` = max over note measures, BPM-event measures, bar-length-change measures, and 0.
- Timing walk for m in 0..last_measure+1: `barlen` persists across measures (`bar_length_changes.get(m, barlen)`, initial 1.0); `measure_start[m] = t`; `sec_per_tick0 = barlen*4*60/384`; segments start with `(0, current_bpm)`; a BPM event at tick 0 replaces it, at tick>0 appends; `measure_len[m] = Σ (end-start)*sec_per_tick0/bpm`; the bpm carries over.
- Chip time `time_of(measure, tick)` walks the segments (respects mid-measure BPM changes). `chart.chips` sorted by `(time, channel)`; `drum_chips()` keeps that order.

## 11. Corrections / additions relative to the colleague's draft (all verified against source)
1. CY and RD bar display width is **57**, not 58 (`int(100*0.58)` = 57 because 100*0.58 = 57.999…; preview.py:405). Full per-lane derived table added (1.3).
2. Window title uses `headers.get("TITLE", filename)` (preview.py:229): an empty `#TITLE:` gives an empty title; the draft's `or filename` was wrong. `mark_modified` strips ALL leading `*` (`lstrip`).
3. `chips.remove()` / undo removal use dataclass value-equality (first equal chip), not identity (preview.py:730, 761).
4. `lane_default` is per display column, so CY-column additions may become RD (0x19) chips, HH may become HHC (0x11), LP may become LBD (0x1C) (preview.py:214-223).
5. `time_to_mt`/`mt_to_time` are linear within a measure and ignore mid-measure BPM changes, unlike the parser's `time_of`.
6. Save reads cp932 strictly (parser is lenient); space-separated object lines are not stripped (duplicate on reload); comments on drum lines are lost; `measure_str` raises above 3599.
7. Deletion never shrinks `duration`; undo never touches it.
8. Speed/offset spinbox `command` fires only on arrow clicks; typed values apply at next redraw / next play start; offset prefs persisted only via arrows; `save_prefs` replaces the whole prefs file with the single key.
9. Info label doubles as the status line: `append_status` text persists until the next redraw; build completion clears it to `""`.
10. Ghost cursor is a Tk canvas item above the composed image (above the strips), full slot width, unclamped, updated only on mouse motion.
11. Wheel binding is window-wide; Ctrl+Z/Ctrl+S window-wide; `n` only when a sidecar loaded.
12. Judge strip is 780 px wide (x 539..1318); pads dx values listed; strip display sizes: top 494x127 at (310,0), bottom 494x130 at (310,495).
13. Fallback filled rect is `(2*half+1) x 9` px (inclusive corners) while `bw,bh = 2*half, 8` are used for the marker.
14. `sorted(..., reverse=True)` is stable → equal-time chips draw in list order.
15. Right-click on empty lane space still redraws; left-click at t<0 or on an occupied cell returns without redraw.
16. Audio: BGM chips come from the original `chart.chips` (edits never affect BGM); `end` counts only decodable wavs; `sd.play` implicitly stops the previous stream; `rebase()` recreates `ChartAudio` (stop quirk); worker exceptions leave the build flag stuck.
17. GUI: `SystemExit` from a chart with no drum chips escapes `except Exception` and kills the mainloop.
18. Default offset rounding uses Python half-to-even (92.5 → 90).

## Key facts

- Canvas 1920x1080; LANE_X0=539, LANE_W=778, LANE_Y0=100, LANE_Y1=940, JUDGE_Y=845, PADS_Y=855, DISPLAY_SCALE=0.58 → display 1113x626; display lane strip x 312..763, judge_s=490.1
- LANE_ORDER = LC,HH,LP,SD,HT,BD,LT,FT,CY; RD draws/hit-tests on the CY column; LANE_SLOT (local x0,x1 half-open): LC 1-104, HH 104-181, LP 181-258, SD 258-344, HT 344-422, BD 422-520, LT 520-595, FT 595-672, CY 672-776
- Display lane centers lane_cx_s: LC 343, HH 395, LP 439, SD 487, HT 534, BD 585, LT 635, FT 680, CY/RD 732; bar display widths: LC 57, HH 42, LP 42, SD 47, HT 42, BD 54, LT 41, FT 42, CY 57, RD 57 (CY/RD = 57 not 58: int(100*0.58)=57); bar height 8
- Skin PNGs (RGBA): drum_bg2 1920x1080, lane_a/lane_assist_a 778x1080, drum_chips 770x302, drum_icons 780x206. bg_top = rows 0:220, bg_bottom = rows 900:1080, judge = icons rows 0:9 (780 wide) at (539,841), pads = icons rows 23:107 rebuilt 84x778 at (539,855) with pad dx LC 8, HH 111, LP 185, SD 263, BD 427, HT 350, LT 522, FT 600, CY 683
- CHIP_BOX bars all at source row 42, height 15: LC(0,98) HH(102,71) LP(176,74) SD(255,83) BD(346,92) HT(442,72) LT(517,72) FT(593,72) CY/RD(669,99); icons loaded but never drawn
- Compose order: base_s copy → beat/measure lines (m in 0..last_measure+1, 4 lines per measure, visible iff 58<=y<=545.2 display; measure RGB(200,200,200) thick 2, beat RGB(70,70,70) thick 1; label f'{m:03d}' at (768, int(y)+4) Hershey Simplex 0.4 RGB(220,220,220) AA) → chips sorted by time DESC (stable) visible iff 40.6<=y<=501.7 display (70..865 in 1080p) → conf markers → top strip 494x127 at (310,0) and bottom strip 494x130 at (310,495) re-blended (1080p x-range 535..1387)
- y_display(t) = 490.1 - (t - t_view)*speed*0.58 (1080p: 845 - (t-t_view)*speed); future chips above the judge line
- FALLBACK_COLOR RGB: LC(236,146,188) HH(146,193,236) LP(236,146,187) SD(236,228,146) BD(187,174,238) HT(151,236,145) LT(236,145,149) FT(209,146,236) CY/RD(145,193,235); fallback bg (16,16,16), lane outlines (40,40,40), judge line RGB(230,230,0) thick 3; fallback chip = filled rect half-width int(w*0.58/2)-2, ±4 px
- Default speed 560 px/s (1080p), spinbox 200..2000 step 40 (command only on arrows); wheel 0.15 s per notch (window-wide, down=forward); duration = last chip time + 2.0 (never shrinks); play restarts from 0 when t >= duration-0.05; tick interval max(1, int(16.7 - elapsed_ms)); reanchor on scrub/scroll restarts audio
- Click mapping: x=cx/0.58-539, y=cy/0.58, accepted iff 80<=y<=865, lane by x0<=x<x1, t = t_view + (845-y)/speed; find_chip_at tolerance 14/speed s (strict <, per display column); left click toggles delete/add, right click delete only; occupied (measure,tick,channel) → silent no-op without redraw
- SNAP_TICKS: 16分→24, 24分→16, 32分→12, 48分→8; tick = round((t-start)/len*384/snap)*snap (half-to-even); tick>=384 → next measure tick 0; t<0 → None; beyond max(measure_start)=last_measure+1 extrapolate with the last measure length; both time_to_mt and mt_to_time are linear within the measure (ignore mid-measure BPM changes)
- New chip channel/id = most common (channel, chip_id) on that display column at load time (so CY column may add RD 0x19, HH may add HHC 0x11) else CANONICAL_CHANNEL {LC 1A, HH 18, LP 1B, SD 12, HT 14, BD 13, LT 15, FT 17, CY 16} with chip id 1; duration extended to time+2 if time > duration-1
- Undo stack ('add'|'del', chip): undo add → remove first equal chip; undo del → append; modified = stack non-empty after undo; save does not clear the stack; title '*' prefix via lstrip('*'); title = '譜面プレビュー - ' + headers.get('TITLE', filename) (empty #TITLE gives empty title)
- Save: strict cp932 read; keep every line whose strip() does not match ^#[0-9A-Za-z]\d\d[0-9A-Fa-f]{2}\s*: with channel 0x11..0x1C; trim trailing blanks; append '' then render_channel_line per (measure, channel) sorted; ticks in chip-list order; .dtx.bak copied once per session only if absent; write cp932 CRLF with trailing newline; status '保存しました: {name}'
- render_channel_line: g=gcd(384, all ticks) (gcd(384,0)=384), n=384//g cells '00', cell[t//g]=to_b36(chip) (duplicate → WARNING, last wins), line = '#' + measure_str(m) + f'{ch:02X}' + ': ' + cells; measure_str raises outside 0..3599
- Audio: premix BGM (channel 0x01 chips from the original parse) + drum chips at 44100 Hz stereo; g=clamp(VOLUMExx|WAVVOLxx default 100,0,100)/100, p=clamp(PANxx|WAVPANxx default 0,-100,100)/100, L=g*min(1,1-p), R=g*min(1,1+p); buffer int(end*SR)+SR with end=max(1, last sample end); divide by peak*1.05 only if peak>1; play from index max(0,int((t+offset_ms/1000)*SR)) so + offset = sound earlier ('+で音が早く'); offset spinbox -300..300 step 5; prefs ~/.vid2dtx_preview.json {"audio_offset_ms": int}; default = round(measured latency/5)*5 (fallback 90)
- Confidence sidecar <chart>.dtx.conf.json = {"version":1,"chips":[{"m","tick","ch"(int),"conf","why"}]}; marker if conf<0.7: red RGB(255,0,0) when <0.4 else orange RGB(255,150,0), 2 px outline padded 3 px around the bar; missing entry = 1.0; 'n' / 次の要確認 ▼ cycles sorted (conf, time) ascending via bisect_right on the previous key, wraps; status '要確認 {i}/{n}  確信度 {cf:.2f}' or '要確認チップはありません'
- UI strings: ▶ 再生 / ⏸ 停止, 位置:, 速度:, レーンガイド, 音声, スナップ:, 音ズレ補正(ms):, +で音が早く, 保存, 元に戻す, 確信度, 次の要確認 ▼, hint '左クリック: ノーツ追加 / ノーツ上で削除　右クリック: 削除　Ctrl+Z: 元に戻す　Ctrl+S: 保存', info 't={t:6.2f}s  小節 {m:03d}  チップ総数 {n}[  要確認 {k}]', 音声を準備中..., 音源ファイルが見つかりません(無音), close dialog '編集内容が保存されていません。保存しますか?'
- Ghost cursor: Tk canvas rect above the composed image, x = (539+slot.x0)*0.58 .. (539+slot.x1)*0.58, y = snapped chip y ± 4, outline #00ff88 width 2; hidden off-lane, on Leave, or when t<0

## Open questions

- Should the browser port draw icons from CHIP_BOX (loaded but never rendered by compose()) or stay faithful and draw bars only?
- cv2 line/text/rect drawing happens in 0.58 display space while the static base (fallback rects/judge line) is drawn in 1080p and downscaled; a native-1080p Canvas port must decide whether to scale thickness/font (x1/0.58) or render at 0.58 and upscale.
- Python round() is half-to-even for snap ticks and for the default latency offset; JS Math.round is half-up — decide whether exact parity matters at .5 boundaries.
- time_to_mt/mt_to_time are linear within a measure and ignore mid-measure BPM changes, so an added chip's preview time can differ from the parser's time_of on reload — replicate or use the segment-aware mapping?
- Skin PNGs are present locally (vid2dtx/assets/DrumGame) but not in git; the port needs a plan for shipping them or fallback-only rendering.
- time_to_mt divides by ml[last] after the `or 1.0` guard only applies to `extra`; a zero-length last measure would raise ZeroDivisionError in the original — decide whether to guard.
- Saving after a prior save then undoing leaves modified=False while memory differs from disk (original quirk) — replicate or fix?
- lane_default is frozen at load; should the port recompute the most common (channel, chip id) after edits, and should the CY column ever default to RD (0x19) as the original can?
- Save keeps space-separated drum object lines (`#00112 0202`) verbatim (regex requires a colon) and drops `;` comments on drum lines — replicate exactly or normalize?
- Chip removal uses value equality (first equal chip); if the port keeps object identity instead, behavior differs only when two identical chips exist (possible after undo of a del following an add at the same cell).

---

## 12. Changes since this spec was written (vid2dtx 2026-10, after kitgen)

This section was added when the browser chart editor was built (DTXMania Web, 2026-10). It records what changed in
vid2dtx's preview editor after sections 1-11 were written. The sections above describe preview.py at commit 07f0de4
(855 lines); the line numbers below refer to the current preview.py (932 lines, commit 2e84251).

Root of every path below: `vid2dtx\`. Paths are shortened to `preview.py`, `gui.py`, `emit.py`, `audio.py`, `dtx.py`, `audio2dtx.py`, `kitgen/pipeline.py` (all under `vid2dtx\`), plus `README.md` and `experiments/kitgen_prod_checks.py`. Lines marked **INFERRED** are my own conclusions; everything else was read from the code.

### 0. Which versions are being compared

- **What the spec describes.** The spec's 855-line `preview.py` is the file as of commit `07f0de4` (2026-07-19). That file stayed unchanged through `1910c39`. Its `audio2dtx.py` citations (`SYNTH_CONF` at :69, the writer at 770-787) match commit `6aa27d9` (2026-08-12). So the spec describes roughly `6aa27d9`.
- **What I read.** The current worktree (clean) is at merge `2e84251`.
- **Commits since then that matter for the editor:**
  - `132fb84` "Add vid2dtx.kitgen" (2026-10-16). This is the only commit that touched `preview.py`: 932 lines now, a 155-line diff. It also changed `audio.py`, `emit.py` and `gui.py`.
  - `1910c39` (2026-10-02). Changes to `audio2dtx.py`: the confidence sidecar file and the LBD lane.
  - `466f833` only moves data paths (`paths.OUT`). It has no effect on the editor.
- **`dtx.py` is unchanged** since the first commit (`159fdd5`). Spec §10 still holds word for word.
- **Code that did not change:** the edit math, the drawing and the save algorithm. All of it is still in the same functions with the same bodies; only the line numbers moved (§1).

### 1. Where the spec's `preview.py` citations moved (function by function)

| function / block | spec (old) | now |
|---|---|---|
| constants, `Skin`, `PreviewWindow.__init__` up to `SystemExit` | 1-195 | 1-195 (same) |
| conf sidecar (was inline) | 196-208 | call at 196; `load_conf` 312-326 |
| `lane_default` (was inline) | 212-223 | call at 204; `lane_defaults` 328-342 |
| window title | 229-230 | `update_title()` at 210; method 384-389 |
| control bar / speed / guide / audio / offset | 238-272 | 218-261 |
| edit bar | 283-311 | 264-292 |
| bindings | 313-320 | 294-301 |
| `render_base` / `prepare_display` / `rebase` | 331-415 | 399-483 |
| `scroll`, `on_slider`, `reanchor`, `start_audio`, `play_audio_now`, `on_offset_change` | 417-466 | 485-534 |
| `begin_audio_build` / `poll_audio_build` | 468-501 | 536-579 (logic changed, §2.5) |
| `stop_audio`, `on_audio_toggle`, `toggle_play`, `play_tick` | 503-544 | 581-622 |
| `compose` / `redraw` / `snapshot` / `goto_next_suspect` | 547-666 | 625-744 |
| `canvas_to_lane_time` / `time_to_mt` / `mt_to_time` / `find_chip_at` | 669-722 | 747-800 |
| `on_click` | 724-754 | 802-834 |
| `undo` | 756-767 | 836-847 |
| `mark_modified` | 769-775 | 849-852 (body changed) |
| `on_motion` / `hide_ghost` | 778-802 | 855-879 |
| `save` / `append_status` / `on_close` / `main` | 805-855 | 882-932 |
| **new:** `reload`, `set_locked`, `update_edit_buttons` | — | 344-372, 374-382, 391-396 |

Other files:
- **`emit.py`** (303 → 403 lines):
  - `LANE_CHANNEL` 24-35
  - `render_channel_line` 136-148 (body unchanged)
  - `copy_playable` 252-283
  - pipeline writer 341-368
- **`audio.py`** (145 → 149 lines): `build` 49-107, `play` 109-125, `stop` 128-134, `output_latency_ms` 137-149.
- **`gui.py`**: preview button 322-324, `open_preview` 795-811, `copy_to_song` 813-857.
- **`audio2dtx.py`**: `SYNTH_CONF` :75, `EXTRA_LANES` :79-80, sidecar writer 1126-1150.
- **`README.md`**: 譜面プレビュー section 51-86 (編集機能 77-84, unchanged text); sidecar note 102-104.

### 2. What changed in `preview.py`

#### 2.1 Read-only lock (new)

- **State.** `self.locked = False` and `self.lock_note = ""` (preview.py:198-201). The comment says the window is read-only "while the GUI rewrites the chart on disk (chart generation, vid2dtx.kitgen)".
- **`set_locked(locked, note="")`** (preview.py:374-382):
  - sets `locked`, and `lock_note = note if locked else ""`;
  - calls `hide_ghost()`, `update_title()` and `update_edit_buttons()`;
  - if `lock_note` is non-empty, calls `append_status(lock_note)`.
- **Guards added while locked:**
  - `on_click` returns at once (preview.py:803-804);
  - `undo` returns if locked or the stack is empty (preview.py:837);
  - `save` returns if not modified or locked (preview.py:883);
  - `on_motion` hides the ghost when `col is None or self.locked` (preview.py:857-859).
- **Not guarded (still works while locked):**
  - play/stop, slider, wheel, speed;
  - レーンガイド toggle (`rebase`, preview.py:478-483, which builds a new `ChartAudio`);
  - 音声 toggle, 音ズレ補正, 確信度 toggle;
  - `次の要確認 ▼` / `n` (`goto_next_suspect`, preview.py:721-744, has no lock check);
  - the close button.

  The Ctrl+Z / Ctrl+S bindings stay registered but do nothing.
- **Status-line lifetime.** The lock note is written to the status label. **INFERRED:** it lasts only until the next `redraw()` (redraw rewrites the label, preview.py:709-716), so during playback it is overwritten within about one frame. The title suffix (§2.2) is what keeps showing the lock.

#### 2.2 Title and button state (replaces spec §4.9)

- **`update_title()`** (preview.py:384-389):
  - `title = headers.get("TITLE", path.name)`;
  - `text = f"譜面プレビュー - {title}"`;
  - if locked, append `f"  [{lock_note or '編集できません'}]"` (two spaces before `[`);
  - window title = `("*" if modified else "") + text`.
- **`update_edit_buttons()`** (preview.py:391-396):
  - 「保存」 is enabled iff `not locked and modified`;
  - 「元に戻す」 is enabled iff `not locked and undo_stack`.
- **`mark_modified(flag)`** (preview.py:849-852) now just sets `modified` and calls those two methods.
- **Effect on spec quirks:**
  - The `title().lstrip("*")` behavior (spec §4.9, §11.2) is gone. The title is rebuilt from the headers every time, so a `#TITLE` that itself starts with `*` is no longer damaged.
  - The quirk "edit → save → undo gives `modified=False`" is still there: undo still calls `mark_modified(bool(undo_stack))` (preview.py:846).

#### 2.3 `reload(note="")` (new; preview.py:344-372)

The docstring says it re-reads the chart from disk "after the GUI rewrote it (a new chart, or a new drum kit …: other #WAV ids, channels and sounds)", and only for a window with no unsaved edits ("the GUI checks first"). Steps, in order:

1. `chart = dtx.parse(path)`. If the chart has no drum chips, raise `SystemExit("chart has no drum chips")` (349-352). This happens before any state changes.
2. If playing, `toggle_play()`. Playback stops and the button returns to `▶ 再生` (353-354); the user has to press play again.
3. Replace `chart`/`chips`; `conf = load_conf()` re-reads the sidecar; `lane_default = lane_defaults()` (355-357). **This is new:** spec §4.7 says the defaults are computed only once at load. They are now also recomputed on reload, but still not after individual edits.
4. Clear `undo_stack`; `duration = max(chip time) + 2.0`; `slider.config(to=duration)`; `t_var = min(t, duration)`, with no reanchor (358-361). Unlike edits, a reload can make `duration` shorter.
5. `mark_modified(False)`; `audio_dirty = True`; `_audio_gen += 1`; `audio = None` (362-365).
6. If sound is available and the 音声 box is on: create a new `ChartAudio`, set `_refetch = _audio_building`, call `begin_audio_build()` (366-369).
7. `redraw()`, then `append_status(note)` if a note was given (370-372).

**Not reset by `reload`:**
- `backup_done` (preview.py:202). **INFERRED:** after one save in the session, a reloaded chart gets no new `.dtx.bak`. Even when `backup_done` is still False, `.bak` is never overwritten (preview.py:897-901), so the backup keeps the first chart's text.
- `_sus_key`: the 要確認 tour continues from the old (conf, time) key via `bisect` (preview.py:735-736).
- `_want_audio`, the ghost item, the skin.

**INFERRED:** the reload note is wiped as soon as the audio build finishes, because `poll_audio_build` sets the label to `""` or to `音源ファイルが見つかりません(無音)` unconditionally (preview.py:566-568).

#### 2.4 Refactors that do not change behavior

`load_conf()` (preview.py:312-326) and `lane_defaults()` (preview.py:328-342) are the old inline code moved into methods. The sidecar format, the "most common (channel, chip_id) per display column, else `(CANONICAL_CHANNEL[col], 1)`" rule and the tie-breaking are unchanged (spec §4.7, §8).

#### 2.5 Audio build orchestration (changes spec §6 "Build/play orchestration")

- **Snapshot.** `begin_audio_build` now captures `au, chart = self.audio, self.chart` together with the chips snapshot (preview.py:542-544). The comment: "reload() may swap the chart and the ChartAudio meanwhile". The worker calls `au.build(chart, chips_snapshot)`.
- **Exception safety.** The worker body is `try: ok = au.build(...) finally: _audio_build_ok = ok; _audio_built_gen = gen; _audio_building = False` (preview.py:546-553).
  - This fixes the spec §6 / §11.16 quirk where a non-numeric `#VOLUME` left the build flag stuck. Now the flag clears, `ok=False`, and the status says `音源ファイルが見つかりません(無音)`, which is misleading. The exception still propagates out of the thread.
  - **INFERRED:** `ChartAudio.buf` is assigned only at the end of `build` (audio.py:106), and `audio_dirty` becomes False because the generations match. So after a failed rebuild the previous, stale mix plays, or nothing if there was none.
- **`_refetch`** (new flag; preview.py:259, 368, 569-573). `reload()` sets it when a build of the *old* chart is still running; `begin_audio_build()` is then a no-op because a build is already in progress. When that stale build finishes, `poll_audio_build` sees `_refetch`, clears it, and if `audio_dirty and audio is not None` calls `begin_audio_build()` and returns. This happens before the `_want_audio` branch.
- **Unchanged:** the `rebase()` behavior (spec §6) of leaving an old stream playing.
  - **INFERRED, already present before:** if `rebase()` runs while a build is in progress, the new `ChartAudio` is never built. `rebase` does not bump `_audio_gen`, so when the old build ends `audio_dirty` is False and `play()` on the new object (`buf is None`) is silent until the next edit or reload.

### 3. Audio mixing (`audio.py`)

- **Decode each file once.** `build` now decodes each referenced file a single time, keyed by `name.lower()`. Every `#WAV` id that points to that file shares the same PCM (audio.py:66-80). The comment: "a kitgen kit plays one sample under several #WAV ids, one per volume".
- Per-id `#VOLUME`/`#PAN` is still applied per chip (audio.py:55-64, 95), so kitgen's per-chip volumes are audible in the preview.
- Everything else in spec §6 still holds (`decode_pcm`, `end`, the +1 s tail, normalization, `play`/`stop`, latency) with the new line numbers.

### 4. Save and `render_channel_line`

- **The save algorithm is identical** to spec §5 (preview.py:882-905): strict cp932 read, the same `OBJ_LINE` filter (preview.py:103-108), lines grouped by (measure, channel) and sorted, `.dtx.bak` once per session, CRLF. The only addition is the `locked` guard.
- **`render_channel_line`** is unchanged, now at emit.py:136-148.
- **INFERRED, saving a kitgen chart:**
  - kitgen's mark line `; kitgen: <mode> (vid2dtx.kitgen)` (kitgen/pipeline.py:187, 1609-1610) is a `;` comment, so the save keeps it;
  - kitgen's per-(file, volume) `#WAV`/`#VOLUME`/`#PAN` lines (kitgen/pipeline.py:1597-1602) are kept verbatim;
  - chips keep their `chip_id`s.
- **Parser difference.** kitgen splits drum lines with dtx.parse syntax, which also accepts a space instead of a colon (`_split_cmd`, kitgen/pipeline.py:368-382). The preview's `OBJ_LINE` requires a colon, so spec §5 edge case (a) still applies to the preview.

### 5. GUI integration (`gui.py`; replaces most of spec §9)

- **Window registry.** The GUI keeps every preview window it opens: `previews` list, `locked_chart`, `locked_stamp` (gui.py:221-225). `open_preview` appends the new window (gui.py:808-809).
- **No previews during a run.** `open_preview` returns while busy (gui.py:796-797), and `set_busy` disables 譜面プレビュー... (gui.py:420-424).
- **SystemExit quirk on open is still there.** `open_preview` still only catches `except Exception` (gui.py:810-811), so a chart with no drum chips still kills the GUI on open (spec §9).
- **Unsaved edits block a rewrite.** `previews_saved(chart, regenerate)` (gui.py:442-461) finds preview windows of the same file (`os.path.samefile`, gui.py:173-178, 430-440) that are `modified`. If any exist, it raises the first one and shows a warning:
  - before a regeneration (gui.py:545, 624): `譜面プレビューに未保存の編集があります。\n\n譜面を生成し直すと generated.dtx は新しい譜面に置き換わります。編集を残すなら保存して「曲フォルダへ書き出し」で書き出してから、残さないならプレビューを閉じてから、もう一度実行してください。`
  - before ドラム音だけ作り直す (gui.py:675): `…プレビューで保存 (Ctrl+S) してから「ドラム音だけ作り直す」を押してください。保存した編集は、作り直したドラム音の譜面にもそのまま残ります。`
  - Only `modified` is checked. A window with a non-empty undo stack but `modified=False` passes.
- **Locking.** `lock_previews(chart, note)` records the file's (mtime_ns, size) and calls `set_locked(True, note)` on matching windows (gui.py:463-468). Notes:
  - `譜面を生成中のため編集できません` (gui.py:549, 628)
  - `ドラム音を作り直し中のため編集できません` (gui.py:679)
- **Release and reload.** `release_previews(note)` (gui.py:470-487) unlocks each window. If the file stamp changed it calls `w.reload(note)` and logs `譜面プレビューを読み込み直しました: {chart}`. If the reload fails, including the `SystemExit` it explicitly catches, it logs `譜面プレビューを閉じました ({e})` and calls `w.on_close()`. Notes:
  - `新しい譜面を読み込みました` (after generation, gui.py:743)
  - `ドラム音を作り直したので読み込み直しました ({label})` (after a re-kit, gui.py:757-758)
  - `譜面が書き換わったので読み込み直しました` (after an error, gui.py:773)
- **Re-kit status.** After a re-kit the status reads `ドラム音を作り直しました ({label}、プレビューで保存した編集を反映)` when kit.json has `source == "edited"`; otherwise it ends at `({label})`. On failure: `REKIT_FAILED` (gui.py:54, 685-688, 744-756).
- **Export.**
  - `copy_to_song` returns while busy (gui.py:814).
  - It reads the chart from disk and does **not** check for unsaved preview edits (gui.py:813-857).
  - With a kit present, the dialog title is `書き出し先の曲フォルダ (ドラム音キットも一緒にコピー)` (gui.py:819), the kit WAVs are copied as `<dtx stem>_kit_*.wav` (kitgen's content hash removed; `vid2dtx_2_kit_*` on a name clash), and the `#WAV` names are rewritten (emit.py:39-42, 170-283).
  - There are new info boxes for kit exports, with extra notes for match/synth (gui.py:840-857).

### 6. How kitgen reads a chart saved by the editor (new)

- **Edit detection.** kitgen compares the chart's multiset of `(measure, tick, channel, chip_id)` with what it wrote last time (`kitwork/state.json`). Each entry is `[m, tick, ch, id, source ch]` (kitgen/pipeline.py:533-534, 671-682, 857-864). The result is one of:
  - `"fresh"`: the chart has no mark line;
  - `"kitgen"`: same chips as kitgen wrote;
  - `"edited"`: chips differ (kitgen/pipeline.py:634-699).
- **Rebuilding from edits.** For `"edited"` charts, the source is rebuilt from the *current* chips (`_rebuild_source`, kitgen/pipeline.py:730-847):
  - video charts fold hats back to HH and the left foot back to LP;
  - audio charts put chips kitgen wrote and the user left alone back on their transcription lanes;
  - chip ids become the source's most common id per channel (787-805);
  - sidecar rows of deleted chips are dropped (819-846).
- **Text edits.** Lines kitgen does not own (title, BPM, BGM, comments) are always taken from the current chart (`_merge_text`, kitgen/pipeline.py:717-727).
- **Pins.** A hat/foot chip is pinned to its family (`pins.json`, kitgen/pipeline.py:694-697, 702-714, 775-786) only when:
  - its cell's pad held chips kitgen wrote, and
  - none of those chips had the chip's current channel (it was "moved to the other channel of their pad").

  Further rules:
  - Chips added in the editor on a new cell are not pinned: "the editor gives them the column's most common channel, not a type the user chose" (kitgen/pipeline.py:743-745).
  - A cell holding two chips of the same pad keeps their source lanes (kitgen/pipeline.py:1728-1739).
  - kit.json records `source`, `text_edited` and `pinned` (kitgen/pipeline.py:1885-1899).
- **Hat/foot type change (no UI for it).** README:328-331 says chips whose open/closed hat or LP/LBD type was changed ("付け替えた") in the preview keep that type.
  - `preview.py` has **no channel-change action**: its only canvas bindings are add/delete/ghost (preview.py:297-300).
  - The check harness fakes the change by rewriting the channel directly (`editor_save`, experiments/kitgen_prod_checks.py:253-306, flips at 285-296).
  - **INFERRED:** the only way to do it inside the preview is to delete the chip and re-add one at the same cell, where the column default has the other channel. kitgen then sees a "moved" chip and pins it.
- **What kitgen writes (and the editor then edits)** (kitgen/pipeline.py:1589-1611, 1792-1907):
  - one `#WAV` id per (file, volume) pair, with labels `;<lane label> [<tier>]`;
  - hat/foot channels split into HHC 11 / HHO 18 / LP 1B / LBD 1C;
  - content-hashed `kit_<lane>[_n]_<hash>.wav`;
  - the sidecar's channels updated so confidence markers stay on their chips (`_update_sidecar`, 1614-1630).
  - **INFERRED:** because each id carries a volume, `lane_defaults` picks the most common (channel, **volume variant**) of the column. An added chip plays at that volume.

### 7. audio2dtx sidecar changes (`1910c39`; extends spec §8)

- **New top-level keys.** The sidecar is now `{"version": 1, "origin_s": grid_origin, "t_meas": t_meas, "chips": [...]}` (audio2dtx.py:1147-1150). The preview reads only `chips[].m/tick/ch/conf` (preview.py:321-323) and ignores the new keys.
- **Head-only chips.** Chips proposed only by the head model, with no backbone onset on the same tick, get `conf = min(conf, SYNTH_CONF = 0.35)`, so they show a red marker. Their `why` text gets the head note appended after `"; "` (audio2dtx.py:75, 1060-1069, 1086-1088, 1131-1136).
- **LBD lane.** `EXTRA_LANES` now includes `LBD (0x1C, 13, "036_kick1_2.ogg", "Left Bass Drum", 100, 0)` (audio2dtx.py:79-80). Audio charts can therefore put LBD chips on the LP column, which can make the LP column default 0x1C (spec §4.7).

### 8. Current editing features (complete list)

- **Add:** left-click an empty spot in a lane (1080p y 80..865). The position snaps to the 16分/24分/32分/48分 grid. Channel and id are the column default, computed at load and at reload. A cell already holding that (measure, tick, channel) is a silent no-op. The chart length grows to the new chip's time + 2 s. Spec §4.1-4.7, §4.11.
- **Delete:** left-click on a chip (toggle) or right-click. Hit tolerance is 14 px (1080p) divided by the speed, on the display column. Spec §4.5-4.6.
- **Undo:** Ctrl+Z or 「元に戻す」, an unlimited stack of add/delete. Saving does not clear it; reload does. There is no redo.
- **Ghost cursor:** a `#00ff88` rectangle at the snapped cell. It hides off-lane, on Leave, at t<0, and while locked.
- **Save:** Ctrl+S or 「保存」. Only drum lines 11-1C are regenerated. `.dtx.bak` is written once per window session and never overwritten. cp932 + CRLF. Status `保存しました: {name}`.
- **Modified state:** `*` prefix on the title, 保存/元に戻す buttons enabled only when allowed (and never while locked), and a save prompt on close (`編集内容が保存されていません。保存しますか?`).
- **Confidence review:** orange/red frames, a `確信度` toggle, `次の要確認 ▼` or `n` tours suspects lowest confidence first. Spec §8.
- **Audio follows edits:** each edit bumps a generation counter, and the mix is rebuilt at the next play start or seek. Spec §6.
- **New:** read-only lock with a title suffix `[note]`; reload from disk (playback stops, undo cleared, column defaults and sidecar re-read, length recomputed); the GUI refuses to rewrite a chart that has unsaved preview edits.
- **Not available:** moving or dragging chips, multi-select, copy/paste, redo, changing a chip's channel/type, id or volume, editing BPM/bar length/measures/headers. Saving does not update the sidecar.

### Key facts

- Only commit `132fb84` (kitgen) changed `preview.py` since the spec; it went from 855 to 932 lines. `dtx.py` is unchanged. `render_channel_line` is unchanged, now at emit.py:136-148.
- New state `locked`/`lock_note`. While locked, these all return early: `on_click`, `undo`, `save`, and the ghost cursor (`on_motion`) (preview.py:803, 837, 883, 857). Playback, scrolling, レーンガイド, 確信度, `n` and close still work.
- Title = `"*"?` + `譜面プレビュー - {TITLE or filename}` + `  [{lock_note or 編集できません}]` when locked. It is rebuilt each time, so the `lstrip("*")` quirk is gone.
- 保存 is enabled iff `not locked and modified`; 元に戻す iff `not locked and undo_stack`.
- `reload()`:
  - raises `SystemExit` before changing anything if the chart has no drum chips;
  - stops playback;
  - replaces chart, chips, sidecar and column defaults;
  - clears undo;
  - recomputes length (it can shrink);
  - sets modified False;
  - rebuilds the audio mix (`_refetch` if a build was in progress);
  - shows the note.

  `backup_done` and `_sus_key` are not reset.
- The audio worker now snapshots `(ChartAudio, chart, chips)` and clears its flags in `finally`, so the old stuck-flag quirk is fixed. A failed build shows `音源ファイルが見つかりません(無音)`.
- `audio.py` decodes each sample file once (case-insensitive name) even when several `#WAV` ids share it.
- GUI notes:
  - lock: `譜面を生成中のため編集できません`, `ドラム音を作り直し中のため編集できません`;
  - reload: `新しい譜面を読み込みました`, `ドラム音を作り直したので読み込み直しました ({label})`, `譜面が書き換わったので読み込み直しました`;
  - a dirty preview blocks generation and re-kit with the two warning texts in §5.
- Export (`copy_to_song`) does not check for unsaved preview edits. A kit is copied as `<stem>_kit_*.wav` and the `#WAV` names are rewritten.
- kitgen edit detection uses the multiset of (m, tick, ch, id). A user-changed hat/foot channel is pinned; chips added on new cells are not. Text edits survive a re-kit. kit.json `source` is `"edited"` after a preview save with chip changes.
- kitgen charts carry `; kitgen: <mode> (vid2dtx.kitgen)`, one `#WAV` id per (file, volume), and HHC/HHO/LP/LBD split. The preview keeps all of these on save, and its column default picks the most common (channel, volume-variant id).
- The sidecar gained `origin_s` and `t_meas` (ignored by the preview). Head-only chips are capped at conf 0.35 (red). audio2dtx now emits LBD 0x1C.
- There is no channel/type-change UI in `preview.py`, although README:328-331 describes type changes made in the preview. The test harness simulates them.

### Open questions / porting notes (browser)

- **Lock/reload in the browser.** When a chart is replaced from outside (re-import, another tab, a future generator), the web editor needs the same contract:
  - refuse if there are unsaved edits;
  - otherwise block edits, stop playback, clear undo, and recompute column defaults and length.

  Should the `.bak` / "first save" state reset on reload? (vid2dtx does not reset it.)
- **Hat/foot type change.** Should the port add it (open/closed hat, LP/LBD, maybe CY/RD), e.g. like DTXCreator's? vid2dtx's README implies it but its UI has no such action. If added, put it on the undo stack as its own operation (not delete+add) and make sure the occupancy check stays per (m, tick, channel).
- **Column default with kitgen charts.** The "most common (channel, chip_id)" rule makes an added chip take a particular volume. Options: keep that, or pick the channel first and then the most common id within it. kitgen's own rebuild uses the most common id per channel (kitgen/pipeline.py:787-790).
- **Sample decoding.** Decode/cache by lowercased file name, not by `#WAV` id. kitgen charts can have up to 1295 ids pointing at a handful of files.
- **Failed audio build.** Show a real error (vid2dtx reports a decode exception as "file not found") and do not play a stale mix.
- **Status line lifetime.** vid2dtx status notes vanish on the next redraw or when the audio build finishes. A Canvas port probably wants a separate toast/status area that stays put.
- **Preserving kitgen data.** If the web editor saves charts that vid2dtx's kitgen may re-kit later, it must keep:
  - the `; kitgen:` line in the first 5 lines;
  - drum `#WAV`/`#VOLUME`/`#PAN` lines verbatim;
  - chip ids;
  - the `<chart>.conf.json` sidecar beside the chart.

  kitgen detects edits by cells, not text, so re-rendering object lines is safe.
- **Export of unsaved edits.** vid2dtx's export reads from disk and silently drops unsaved edits. The port should either save first or warn.
- **Rounding parity.** Python `round()` rounds half-to-even, JS `Math.round` rounds half-up. This still applies to snapping (spec open question); nothing changed here.
- **Sidecar keys.** The port should ignore unknown sidecar keys (`origin_s`, `t_meas`) and treat `why` as free text that may contain `"; "`-joined notes.
