# nx-docs

# DTXManiaAI Drum Performance Screen — Behavioral Spec (docs-only, merged & corrected)

Source root: `DTXManiaAI\docs\`. Citations are `NN:line` (file number prefix as listed in the docs folder; `24:` = the HTML controls guide). **No `.cs` file was read**; §11 lists documented-but-unverified items. Marks: **(ADDED)** = not in the colleague's spec; **(CORRECTED)** = colleague's statement fixed; **(INFERRED)** = my reading of ambiguous doc text — treat as open.

---

## 0. Coordinate / model conventions

- Design coordinate system is NX 1280×720, top-left origin (00:79, 01:99-101). NX `tDraw2D` x/y/rect/scale/alpha values are reused verbatim (01:101).
- **(ADDED)** Since M14 the shipped build renders at a fixed **1920×1080**; every 720p value is multiplied by `S = 1.5` at placement time (12:10-18). Runtime pixel constants were also scaled: scroll 0.45→0.675 px/ms, lane-flash y 700→34 range, pad bounce 15 px, combo jump 15 px (12:17-18). Sprite-sheet source rects stay in 720p texture pixels; only on-screen size is ×1.5 (12:19-20). Docs 21/23 quote 720p px and say "×1.5" (15:17-18, 21:12).
- **10-lane drum model** (index 0..9): `LC, HH, LP, SD, HT, BD, LT, FT, CY, RD` (05:18, 22:63). NX's 12 channels fold: HC/HO→HH, LP/LBD→LP (17:27). Drum channels 0x11–0x1C map to lanes (05:18); pedals are BD 0x13 / LP 0x1B / LBD 0x1C (18:65); RD = ch 0x19 = lane 9, CY = ch 0x16 = lane 8 (18:336).
- Chart timing (for a re-implementation): line `#mmmCC: data`, mmm = measure (3 decimal digits), CC = channel (2 hex), 2 chars per object, `00` = none (05:13). Tick `pos = (measure+1)*384 + 384*i/objCount` — one empty lead-in measure, 384 ticks/measure (05:14). `ms = currentMs + 625 × Δtick × barLength / bpm` (NX `tComputeChipPlayTimeMs`, 625 = 0x271); 120 BPM, barLen 1.0 → 2000 ms/measure (05:15-16). ch02 = bar length, ch03 = BPM (`#BASEBPM` + hex value — 17:13 fixed an earlier base36/`#BPM` bug), ch08 = extended BPM (`#BPMxx`), ch50 = bar line (05:17). Bar length persists until the next `#xxx02` (BMS/BME reset to 1.0 per measure) (18:94-99). Sweep updates base (lastPos/currMs) only on BPM/bar-length events (05:19).
- **(ADDED)** Other header/parse rules: `#WAVxx` ids are base36 (08:8); `#VOLUMExx` 0..100 (08:15); `#PANxx` −100..100 (16:25); `#BPM` accepts comma decimals, `#BPM00`, rejects ≤0, TAB separator (17:16); `#DLEVEL` + `#DLVDEC`/`#GLVDEC`/`#BLVDEC` (17:16); `#RANDOM/#IF/#ENDIF` (17:13); `#PREIMAGE`, `#AVIxx`, `#BMPxx` (08:7); `#SOUND_STAGEFAILED` (17:17), `#SOUND_NOWLOADING` (23:171).
- Other channels: 0x51 beat line, 0xC1 beat-line shift, 0xC2 display flag (01 = show, 02 = hide) (18:16, 18:272-273), 0x53 fill-in (values 1–6), 0x1F audience cheer, 0x61–0x92 SE (18:16); 0x31–0x3C hidden chips, 0x4C–0x4F bonus chips (17:17); BGA ch04 = layer 1, ch07 = layer 2, ch55–59 = layers 3–7 (16:31-32); BGM ch01 (05:37); movie ch54 (08:9, 08:26).
- **(ADDED) `7_chips_drums.png` (718×776) row map**: y=0 chip body row; y=64 bonus overlay row; y=128+64·frame pattern rows (8 frames, frame 0 at y=128 — the CUSTOM `nx_chip_*` sprites are this row only); y=640 scattering-fragment row; y=769 bar-line row; y=772 beat-line row; HHO (open hi-hat) cell at x=612 width 48 (11:21-23, 21:185, 18:204, 23:77-79, 23:227, 23:231). Cell height 64; NX draws the cell at (laneX−5, timeY−32) so the cell centre = chip time (11:23). Lanes with a pattern layer: LC/HH/LP/BD/FT/CY (indices 0,1,2,5,7,8); SD/HT/LT (3,4,6) have none/fully transparent (21:173-175, 23:78).

---

## 1. Drum performance screen — UI elements

### 1.1 CUSTOM layout (`Layout=0`, M13 NX-image port; 11_…)

Draw order (back → front) (11:85-88): `Background → MovieBGA → LanesPanel → Flush0-9 → ChipTemplates(hidden) → Notes → JudgeLine → Pad/PadFlush0-9 → ProgressBg/Fill → ScoreLabel/ScoreDigit0-6 → Gauge(3 layers) → ComboDigit0-3/ComboLabel → JudgeStr0-9 → Fire0-9(a/b) → [Stars container inserted right after Fire (11:174)] → Jacket → Info/Hint → Danger → NoNotes → StageFailed → Banner`. **(ADDED)** The shipped `PerformanceStage.prefab` is hand-edited and contains extra elements not in the generator (`score_detailed`, `song_info`, `movie_frame`, `drum_chips.png` art); their positions are not documented (19:161-162, 23:25). Bga0-3 exist too (16:33).

| Element | Spec (720p px unless noted) | Cite |
|---|---|---|
| Lane panel | `7_Paret.png` 558×720 at x=295 (single image = Type A) | 11:15-16 |
| Judge line | Y=561 (`nJudgeLinePosY.Drums`); chips fall top→bottom; `ScreenPlayDrums hit-bar.png` 8×8 tile rect (0,0,8,6) tiled to 560×6 (559 in NX mode); top edge = judge Y. 1080p prefab: Chip0 centre (495, 841.5) 111×96 | 11:17-18, 23:85, 12:68 |
| Lane centre X (Type A) | LC=298 HH=370 LP=419 SD=470 HT=527 BD=582 LT=645 FT=694 CY=748 RD=815 | 11:19-20 |
| Chip sprites | frame-0 row of chip sheet; widths LC/CY=74, BD=70, SD=64, HH/HT/LT/FT=56, LP=58, RD=48; height 64. Prefab `Chip{i}_icon` Animators animate the pattern for lanes 0,1,2,5,7,8 (RD/Chip9 still uses pattern frame 0 as body — known art gap) | 11:21-23, 21:172-179 |
| Pads | `7_pads.png` 384×288 (96×96 ×10) at **y=10 (top of screen)**; X: LC=263 HH=336 LP=396 SD=446 HT=510 BD=565 LT=622 FT=672 CY=735 RD=791. 1080p: Pad0 (394.5, 15) 144 px | 11:24-25, 12:68 |
| Gauge (horizontal) | `7_Gauge.png` 543×94 (two 47-px frame layers) at (294,626); bar `7_gauge_bar.png` 480×31 at (314,635), width scaled by gauge (`Image.type=Filled`, initial 0.667); full → `7_gauge_bar.jpg` same rect. Old prefab: vertical bar at right edge, red blink on DANGER (both supported) | 11:26-27, 11:91, 11:104, 11:120, 05:60, 23:84 |
| Score | `7_score numbersGD.png` digits 36×50 ×10 + "SCORE" label 86×28; digits at (40,41), label (40,13); pitch 34; leading zeros hidden; 7 digits | 11:28-29, 11:87 |
| Combo | `ScreenPlayDrums combo.png` digits 120×160 ×10 + "COMBO" 250×60; right-aligned from x=1275, pitch 114, y=60; **hidden when combo = 0** | 11:30-31 |
| Progress bar | `7_Drum_Progress_bg.png` 32×720 at x=853; `Image.type=Filled` (fill direction not documented) | 11:32, 11:91 |
| STAGE FAILED | `7_stage_failed.jpg` full-screen 1280×720 | 11:33, 11:103 |
| DANGER overlay | `7_Danger.png` 1280×720 (CUSTOM only) | 11:34 |
| Judge string (classic) | `ScreenPlay judge strings 1.png` (PERFECT/GREAT/GOOD) & `2.png` (POOR/MISS), 128×42 cells; at lane centre x, y=372 (= 561−189) | 11:48-50 |
| BGA | `Bga0-3` 4 layers, NX BGA area (990,0) 278×355 (×1.5); image swaps at event time; unknown id = clear layer; jacket hidden once BGA starts | 16:31-35 |
| Movie **(ADDED)** | full-screen `RawImage` behind lanes; file 0:00 = ch54 event time; prepared → played → paused immediately, then resumed (no seek) at event time; audio muted (Direct-mute API) only when the chart has BGM (ch01) events, else movie audio plays; jacket hidden when movie starts; decode failure → jacket fallback | 08:21, 08:34-35, 08:43-46 |
| Jacket / Info / Hint | Jacket top-right; Info = perf-info line (BPM etc., early/late counts); Hint = key help generated from current bindings; both `movie_frame` and `Info` hidden in training | 08:21, 11:88, 14:46, 21:145-146, 19:168 |
| BPM display | current BPM from `DtxChart.BpmChanges` × play speed (NX updates at every BPM chip) | 21:112-114 |
| Bar lines | white 2 px, α 0.35, full lane width (558×1.5), pool 24, behind notes, same scroll formula; pool not created when Dark=FULL | 15:23-26 |
| Beat lines | white α 0.16 (bar 0.35 / beat 0.16) instead of NX sheet rows 769/772 | 18:204-205 |
| Loop lines | begin = green thin line, end = red thin line (NX: chip-sheet stripes, 1 line begin / 7 lines end) | 18:202-203 |
| Hi-speed display | centred text (NX: `7_Panel_icons.jpg` icon beside gauge; image missing) | 18:218-219 |
| Lag numbers | `7_lag numbers.png` 15×19 cells in 4 columns (0-9,'-'); blue block origin (0,0), red block (64,64); centred under judge string at judge-string top +34; unscaled/opaque for 300 ms | 21:140-143 |
| Section progress | §6.4 | 21:151-158 |
| Skill meter | §6.5 | 21:217-228 |
| Shutter | `DrumsShutterIn` (top) / `DrumsShutterOut` (bottom) cover lane panel x=295 w=558; value 0–100 × 7.2 px; both 0 (default) → not created; `[PlayOption]`; NX numpad in-play adjustment NOT ported | 21:160-167 |
| No-notes notice | shown if chart has no drum notes (string not documented) | 05:28 |
| Banner | text banner for CLEAR (FAILED uses full-screen image); exact text not documented | 11:103, 05:59 |
| Training menu | right side, default frame top-left (1400,340) 500×700 in 1920×1080; override via RectTransform named `training_menu`; semi-transparent, front-most | 19:165-169 |
| Fallback | if sprites missing, notes are single-colour boxes; NoteTemplate pool = 80 | 11:98, 09:130 |

### 1.2 NX SKIN layout (`Layout=1`; 23:220-242, 24)
- Chip = 3 children per note: pattern row (`#icon0..7`, global 70 ms counter, behind) + body row + bonus overlay (`#bonus`) (23:226). Scatter fragment width = ChipW/2, X base −10 (23:227) — **(CORRECTED)** differs from CUSTOM's (w+10)/2 (21:185).
- Pads at **y=570** (Reverse: 70); bounce "dot2": +2 px/8 ms up to 11, then −1/8 ms; alpha steps of 50 every 18 ms; LaneType X table (23:228).
- Judge string: NX default `JudgeAnimeType=1` → `7_judge strings.png` 1500×4080 = 250×170 cells × 24 frames @14 ms, drawn at (xc−122, cy−87), `cy = 348 + 32·v` (v undocumented), RD xc=855, AUTO column exists; if sheet missing → classic 128×42 with vertical jitter, AUTO uses `strings 3.png`; lag numbers at y+34 (23:80-81, 23:229-230).
- Lanes: Reverse uses `* reverse.png` flash images (no decay; lanes without file not drawn); bar/beat lines from chip sheet rows 769/772 (x=295, w=559); loop lines 7 stripes + "Begin/End loop" console text at (830, y−17); judge-line top = JY; BGA 8 layers + black backing; fill-in end flash on ch53 = 02/05/06; chip fire **no rotation**, RD fire hidden if `chip fire_RD.png` missing; shutter swaps on Reverse; wave at (centre−40, JY+14) (23:231-234).
- HUD: status panel `7_SkillPanel.png` (judgment counts + percentages, achievement + `7_skill max` glyph when ≥100, Game Skill, XG level digits, difficulty cell, Early/Late); title/artist/jacket (long side 245); NX progress bar (bottom→top, 64 sections with density widths, gray/yellow/DeepSkyBlue, self-best band, hidden on Dark=FULL); skill-meter value; combo (**MinCombo 10, 120 ms jump**, per-digit delay, beat bounce); hi-speed icon row = `min(v,20)`; full gauge `7_gauge_bar.jpg`; STAGE FAILED = left/right split, cos wipe 200 ms → hold 2000 ms → black 500 ms; STAGE CLEAR 2000 ms; `NxStartFade` (6_FadeOut.jpg black curtain + diagonal jacket, 750 ms at start; not in training); score count-up (rate undocumented); `"Play Speed: x1.250"` at (25,200); DANGER image not drawn (as NX) (23:222-223, 23:235-239, 23:172-173, 24:333-335).
- Not supported (no config keys): JudgeLinePosOffsetDrums / DrumsJudgeLine / NumOfLanes / RDPosition / LaneDisp / MovieAlpha / HHOGraphics=B / LBDGraphics / ShowDebugStatus / XG judge strings Type 2 / nameplate; 4:3 movie window not placed; flash strength by velocity not implemented (InputManager exposes no velocity) (23:240-242, 23:272-276).
- Keys during play are identical in both layouts (24:178).

### 1.3 Reverse (`Reverse=` 0/1) **(ADDED)** (16:63-66)
Judge line moves to NX Y=159 (×1.5); notes and bar lines flow **bottom→top**; lane flash runs top→bottom; judge string below the judge line; chip fire centred on judge line; horizontal gauge relocates from y=626 to y=28 (`ApplyReverse()`). NX-mode: pads y=70, reverse flash images, shutter swap (23:228, 23:231, 23:233).

### 1.4 Hit effects (11:36-55, 11:155-175, 21:183-193)

```
// Lane flash (CActPerfDrumsLaneFlushD) — on every hit AND on empty hits (11:101-102)
ct: 0→90, 3 ms/step (~270 ms); y = 700 − ct×7.4 (720p; scaled ×1.5); alpha ∝ y (fades as it rises to y=34)
sprite 42×128; per-lane (x,width): LC=(298,64) HH=(370,46) LP=(419,48) SD=(470,54) HT=(528,46)
                                  BD=(582,60) LT=(645,46) FT=(694,46) CY=(748,64) RD=(815,38)
RD flash image absent in every skin (NX draws none; CUSTOM reuses CY image)          // 11:38-43, 23:86

// Chip fire (CActPerfDrumsChipFireD) — hit only (not MISS, not POOR)                // 11:47, 17:17
CUSTOM: 2 layers 128×128, random rotation + 90° offset; NX mode: no rotation         // 11:45, 23:233
at (laneCentre, y≈565); ct: 0→70, 3 ms/step (~210 ms); scale = 0.4 + 0.8×cos((ct/50)×π/2)
ADDITIVE (SrcAlpha, One) — source art nearly opaque (min α≈0.75) and very dark (max 47%, avg 4%)  // 11:133-152, 11:157-159
RD: CUSTOM reuses CY art (11:70); NX mode hides if chip fire_RD.png missing (23:233)
Bonus: `chip fire_Bonus.png` overlaid during chorus section (ch53 03/04)               // 18:275

// Chip stars (st青い星) — 16 stars 32×32 (max brightness 96%), STAR_MAX=240
spawn at (laneCentre, judgeY); v0 = 0.9 px/step random dir, +upward bias −0.1
7 ms/step × 40 steps (280 ms); each step: vy *= 1.010; vy −= 0.0204; additive
scale = r × cos(π/2 × step/100), r per star ∈ [0.3, 0.59]                            // 11:160-165

// Scattering chips (st飛び散るチップ) — 1 slot per hit = 2 fragments (left/right halves)
fragment = lane cell of chip-sheet row y=640, half width (CUSTOM (w+10)/2; NX mode w/2, x−10)
10 ms steps, 0..44 (440 ms):
  XL −= 2.5×ax; XR += 2.5×ax; Y += 8.66×ay − 0.532; ax *= 0.995; ay += 0.031
init ax = 1.2098614, ay = −0.7121183; rotation ±0.09 rad/step (opposite per half)
no scale/alpha change; additive; opacity 120/255                                     // 21:185-190, 23:227

// Gating: DrumsAttackEffect ([PlayOption], default 0):
//   fire: everything except "ALL OFF"; stars: "ALL ON" or "ChipOFF"; scattering: "ALL ON" only
//   fill-in stars/waves NOT gated. int→name mapping not documented (INFERRED: 0 = ALL ON, since
//   11:162 says stars are on by default)                                           // 21:191-193, 11:162

// Pad flash (CActPerfDrumsPad, CUSTOM): overlay `pads flush` same cell, fade 108 ms;
// pad bounces DOWN max 15 px (rise 37.5 ms / return 75 ms)                          // 11:52-53
// NX mode pad: dot2 bounce (+2/8 ms → 11 → −1/8 ms), alpha −50 per 18 ms             // 23:228

// Combo jump (CActPerfCommonCombo, CUSTOM): on combo++ each digit delayed 10 ms,
// offset = −15×sin(π×t/180), duration 180 ms (NX 120 ms; NX mode uses 120)            // 11:54-55, 17:32, 23:237
// 100-combo fireworks `7_combobomb.png` 14 frames / 20 ms, additive; 1000 combo → `combo_2.png`;
// 100-combo emphasis scale 1.22–1.30 + wider digit pitch; positions derived relative to the
// prefab's combo digits (pitch = NX 114); "fired" flag reset on Poor AND Miss (NX: Miss only)   // 17:15, 17:17, 17:32, 17:36

// Judge string classic anim 300 ms: 0–50 ms width 2×→1×, height 0→1; from 240 ms squash vertically;
// POOR/MISS: vertical open then from 200 ms whole shrinks                            // 11:50-51
// Passed chip: MISS shows judge string only (no fire); POOR: no fire                   // 17:17
// AUTO chip judge string: CUSTOM shows PERFECT (NX/NX-mode has AUTO string)           // 18:206, 23:229-230
```

### 1.5 Fill-in / chorus (ch53) **(expanded)**
Values 1–6 parsed (18:16). Fill-in section: every hit scatters blue stars; the **last chip** of the section spreads a wave; at section end the cheer `Audience.ogg` plays if `AudienceSound=1` and (combo > 0 or AUTO) (18:76, 18:273-274, 18:282). "Last chip" ≈ next drum chip ≥ 100 ms later (NX: ≥ 0x18 = 24 ticks; fill-in chip range ±32 ticks per NX CDTX 6915-6933) (18:222-223, 18:318). Values 03/04 = chorus (サビ) start/end → bonus fireworks overlay on chip fire; app gates 03/04 (like 05/06) by `FillInEffect` (default 1) — NX does not (18:75, 18:208-209, 18:275). NX-mode "fill-in end flash" fires on values 02/05/06 (23:233). **(INFERRED)** 01/02 = fill-in begin/end, 05/06 = alternate fill-in begin/end; exact per-value table not in docs.

### 1.6 Bar lines, beat lines, metronome **(ADDED)** (18:16, 18:74, 18:94-99, 18:266-273)
- Bar line per measure (ch50 synthesized at parse; `DtxChart.BarLineTimesMs`) (05:17, 15:23).
- Beat lines are generated internally at quarter-note spacing: 4/4 → 3 beat lines; bar length 0.75 → 2; 2.00 → 7 (18:268-270). **(INFERRED rule)** beat line at every k×96 ticks, k ≥ 1, while k×96 < barLen×384. 0xC1 shifts the beat lines right; lines pushed past the bar end are dropped (example: 3 → 2) (18:271; shift unit undocumented). 0xC2 = 02 hides bar+beat lines, 01 shows them again (18:272-273).
- `Metronome=` (0/1, default 0): `System/Sounds/Metronome.ogg`; bar line at normal volume, beat line at volume 40/127; keeps sounding while 0xC2 hides the lines (display flag affects drawing only) (18:74, 18:272, 18:280).
- Dark=FULL hides bar and beat lines (18:260, 15:13).

---

## 2. Hotkeys during drum play (normal play; not training-menu mode)

Table from 18:40-52, confirmed by 24:333.

| Key | Action | Notes |
|---|---|---|
| `F1` | toggle AUTO ↔ MANUAL (all lanes) | app-specific (05:25, 18:42) |
| `Shift+F1` / `Pause` | pause / resume | NX: BASS Help pad (18:43) |
| `F2` / `=` | RESTART: back to song start, **stats reset** (`ResetPlayStats`), training flag cleared (BGMAdjust-training persists) | NX default `=` (K052) (18:44, 18:54-56, 19:137) |
| `F5` | **rewind** by `SkipTimeMs` | NX default unassigned (18:45) |
| `F6` | **fast-forward** by `SkipTimeMs` | (18:45) |
| `F7` | loop: "ループ開始→終了を設定" (LoopCreate equivalent, captures current position) | (18:46, 19:206-207) |
| `F8` | loop clear (LoopDelete) | (18:46) |
| `F9` | play speed −0.05 | (18:47) |
| `F10` | play speed +0.05 | (18:47) |
| `↑` / `↓` | ScrollSpeed setting ±1 (= display multiplier ±0.5), with NX smoothing (`CActPerfScrollSpeed`, formula undocumented) | **(INFERRED sign)** ↑ = +1, ↓ = −1 by key order (18:48, 18:315) |
| `←` / `→` | InputAdjust ∓10 ms; with `Ctrl` ∓1 ms | **(INFERRED sign)** ← = −10, → = +10 by key order. "Ctrl の有無が逆なのも NX どおり" (18:49) most plausibly means: unlike menus where Ctrl = ×10 (24:204), during play Ctrl makes the step *smaller* (1 ms) — as in NX |
| `Shift+↑` / `Shift+↓` | BGMAdjust ±10 ms; with `Ctrl` ±1 ms | **(INFERRED sign)** ↑ = +10, ↓ = −10 (18:50) |
| `F11` | toggle help overlay (all controls + lane bindings) | NX F11 = perf-info toggle (18:51, 18:180) |
| `Esc` | abort → SongSelection (return 1, no Result) | (05:28, 06:19, 18:52) |
| `Alt+Enter` | fullscreen toggle (global); Enter suppressed while Alt held | (21:15-18, 24:205) |

Priority: NX's if/else-if chain order is reproduced → one action per frame; the order itself is not listed (18:12). **(ADDED)** In GR (guitar) mode none of the training hotkeys/realtime adjustments exist (F1–F5 = neck buttons); only Pause/Esc/F11 (20:56, 20:123-124).

```
// Semantics (documented)
SkipTimeMs: default 5000, range 100..20000 (parse-fail/out-of-range keeps current value)   // 18:69, 18:80-81
PlaySpeed:  int 5..40, multiplier = value/20 (x0.25..x2.00), default 20; F9/F10 = ±1 unit  // 18:70, 19:33
ShowPlaySpeed: 0=OFF, 1=always, 2=only when changed (default 2); display duration undocumented // 18:71
Text format (NX mode): "Play Speed: x1.250" (3 decimals) at (25,200)                    // 23:239

Pause: SongClock stops SongMs AND the effect timers follow the pause (18:30); in training-menu
  PAUSED the whole clock (WallMs too) stops                                            // 18:23, 19:78

on F5/F6 (JumpInSong):
  targetMs = songMs ∓ SkipTimeMs
  judged[i] = (note.ms < targetMs)   // before target = processed (NOT counted as MISS), after = un-hit
  score/combo/counts/gauge NOT restored (same as NX)                                    // 18:229-231
  movie stays stopped after a jump (seek unreliable)                                    // 18:200-201
  auto-play sounds resynced (resyncAudio=true; training standby passes false)           // 19:135-136
  GB accompaniment notes follow the jump too                                            // 20:96
  training = true → this play is not recorded                                           // 18:54

on F7: LoopCreate-style capture of the current position; INFERRED: 1st press = begin, 2nd = end
on F8: loop cleared
loop wrap (songMs >= loopEnd): jump to loopBegin; combo = 0 (NX); app ALSO clears the 100-combo
  fireworks flag (18:232-234). Doc 19:178 says counts/combo/score all reset on wrap — CONFLICT.
  In training-menu mode wrap additionally inserts the TrainingStartWait countdown       // 19:21, 19:65
on F9/F10 (ChangePlaySpeed): chart times, BpmChanges, loop positions, section-progress
  timestamps, GB notes all rescaled (ScaleChartTimes); audio pitch = speed (AudioSource.pitch;
  TimeStretch NOT implemented); system sounds unaffected; training = true               // 18:196-197, 21:113, 19:200, 23:292, 19:123-126
on F2 restart: internal reset only (no chart reload); play-speed stretch kept (NX keeps nPlaySpeed) // 18:198-199
recording (PerformanceResult.IsRecordable): NOT recorded if training (F5–F10 or BGMAdjust used),
  or global AUTO (17:29), or PlaySpeed != 20 unless SaveScoreIfModifiedPlaySpeed=1 (18:72);
  STAGE FAILED records only play count + section lamps, no score.ini (17:16, 17:30);
  `ScoreIni=` (default 1) / CONFIG "SaveScore" toggles score.ini output              // 16:21, 21:263-266
```
Sounds for F5–F10 / arrow adjustments: **not documented**. Training-menu mode disables F5–F10 and the arrow keys entirely (19:133-134, 19:174-175); menu decide = Enter/NumpadEnter only because Space = BD default key and pad South may be bound to a lane (19:47-52). Arrow repeat: immediate → 200 ms → every 30 ms (`Counter.RepeatKey` = NX `tRepeatKey`); operation sound at most every 60 ms (19:149-151, 01:112).

---

## 3. Judgment, scoring, gauge, combo, achievement/skill

### 3.1 Judgment windows & hit resolution
- NX default ±ms: **PERFECT 34 / GREAT 67 / GOOD 84 / POOR 117**, beyond → MISS (17:16, 17:81, 18:64). NX's 4th window is named "Ok" in `STHitRanges` (18:22). Superseded M5 approximation 25/50/100/150 with judge Y=600 (05:23-24).
- Config `[HitRange]`: `DrumPerfect/Great/Good/Poor` (non-pedal) and `DrumPedalPerfect/Great/Good/Poor` (BD 0x13 / LP 0x1B / LBD 0x1C), each 0–999; legacy unprefixed `Perfect/Great/Good/Poor` seed both; out-of-range keeps current (18:64-66, 18:80-81).
- **(ADDED)** Judgment uses the **frame time**, not the input event timestamp (NX uses event timestamps) (20:119); sound scheduling is frame-precision (~16 ms) (05:51).
- Nearest un-hit chip searched **only inside the POOR window** (NX: unlimited) (18:210-211). Passed chips → MISS (05:26) — exact moment (time + Poor window?) not stated.
- Manual input time: `inputMs = songMs + JudgeOffsetMs` (AUTO and rendering unaffected) (14:45); see §5 for the sign dispute.
- Chip grouping (`Core/DrumGroups.cs`): HHGroup/FTGroup/CYGroup/BDGroup with NX values & key names; auto-demotion when chart lacks LC/RD; candidate = nearest per channel → earliest chart time; same-time ties: only LC/CY/RD keys take one; BDGroup=1 restricts LBD via `Note.Channel`; empty hit borrows the nearest chip's sound (searched in the demoted group; NX uses raw settings) (17:14, 17:33). `MergeRide=1` (default 0; CONFIG "CY/RD Merge", placed after "CY Group") moves RD chips (visible & hidden) to CY lane after load; RD lane/pad still drawn; RD key hits CY chips via demotion; not reflected in `PerformanceResult.CYGroup` (18:329-338).
- Hidden chips (0x31–0x3C, `HiddenNotes`): participate in hit resolution (visible preferred over hidden at same time; NX consumes hidden first) (17:17, 17:33); whether they count in judgments is not documented.
- Lane AUTO (`[AutoPlay]` LC HH SD BD HT LT FT CY RD LP LBD, 0/1, default 0): AUTO chips are not counted in judgments, don't move combo, and move gauge/score only if `AutoAddGage=1` (default 0); AUTO-lane hits do count toward NX-mode section hit counts (18:67-68, 18:212-214, 23:291). Global AUTO (F1 / `AutoPlay=`): every chip auto-judged PERFECT at its time, score added (app-specific) (05:25, 18:212-213, 17:28). AutoPlay default: CONFIG mock shows `AutoPlay OFF` (24:219); M5 defaulted to AUTO (05:25) — treat default as OFF (INFERRED).

### 3.2 Score (drums)
- NX XG rule: 1,000,000 max, combo coefficient capped at 50, all-PERFECT full-score correction (17:13). App: <50 total chips all PERFECT → always 1,000,000; `_score` clamped 0..9,999,999; AUTO still adds score (NX: 0 unless AutoAddGage) (17:28). Bonus chips +500 each, applied before score calc (17:17). Per-chip formula for drums is **not written out**; the guitar formula `base = 1000000/(1275+50×(n−50))`, "no bonus deduction", all-Perfect correction (20:51-52) suggests the drum base deducts the bonus total from the 1,000,000 pool — **(INFERRED)**. Score display: 7 digits, leading zeros hidden (11:29); NX mode count-up (23:239).

### 3.3 Achievement / skill / rank
- `Achievement% = P%×0.85 + G%×0.35 + MaxCombo%×0.15` (17:13) — **(ADDED)** weights sum to 1.35, so the value can exceed 100; NX-mode shows `7_skill max.png` for ≥100 (23:184, 23:235). Displayed `100.00%` format (17:16). Song skill = `Achievement × levelCoef × 0.2` (17:13). AUTO: achievement shown, skill 0, nothing recorded (17:29). Lane-AUTO revise factor `dbCalcReviseValForDrGtBsAutoLanes` (18:313) — formula undocumented (guitar analogue: AutoPick ½, any neck AUTO ½ more, 20:125-127).
- Rank (NX `tCalculateRank`): ≥95 SS, ≥80 S, ≥73 A, ≥63 B, ≥53 C, ≥45 D, else E (06:14). NX-mode result: all-AUTO → SS, no chips → E (23:188). EXCELLENT = all PERFECT (priority over FULL COMBO) (11:111). NEW RECORD only for achievement-rate record (17:16). Judgment percentages = round(100·count/total), all-AUTO → 0 (23:183).

### 3.4 Gauge (NX `CActPerfCommonGauge`, drums XG)
```
init = 2/3; max = 1.0; min = −0.1; Danger threshold = 0.3 (comparison operator not stated)  // 05:56
delta: PERFECT +0.005 | GREAT +0.001 | GOOD 0 | POOR −0.017 | MISS rawMiss×damage           // 05:57, 21:103-104
rawMiss = −0.041 (drums) / −0.050 (GB); DamageLevel 0=EASY×0.25, 1=NORMAL×0.5, 2=HARD×0.75
  → default NORMAL Miss = −0.0205 (drums) / −0.025 (GB); Poor NOT scaled                   // 21:96, 21:103
Risky (0=OFF, 1..10 = remaining misses): POOR or MISS decrements; 0 → fail;
  gauge drops in equal parts per count                                                    // 21:97
StageFailed=OFF → never fail                                                              // 21:98
fail: gauge <= min → STAGE FAILED (accompaniment stops); reach last note + 2000 ms tail → CLEAR → Result (return 2) // 05:58, 06:19
EPlayState {Playing, Clearing, Failing}                                                    // 05:59
IsDanger under Risky: initial 1 → never; 2–3 → remaining <= 1; more → remaining <= 2      // 21:105-106
STAGE FAILED sound 200 ms after fail (chart #SOUND_STAGEFAILED overrides, exclusive);
  CUSTOM banner CLEAR 1.5 s / FAILED 2.2 s (Enter/Esc skips); NX-mode timings in §1.2       // 17:15, 17:17, 17:38, 05:59
Training-menu mode: gauge shown but never fails, no CLEAR                                  // 19:141, 19:176
Volumes: ChipVolume 100 (manual hits), AutoChipVolume 80 (BGM + AUTO chips), BGMSound=OFF mutes BGM chips // 21:99-101
All six gauge settings apply to drum and guitar screens                                    // 21:107
```

### 3.5 Dark / Hidden-Sudden (15:10-19)
```
Dark (0..2): 0 OFF | 1 HALF → hide lane panel 7_Paret | 2 FULL → also hide judge line, pads, bar/beat lines
             (and NX-mode progress bar 23:236)
HidSud (0..4): 0 OFF | 1 HIDDEN | 2 SUDDEN | 3 HID&SUD | 4 STEALTH
d = |chipY − judgeY| in 720p px (thresholds ×1.5 at 1080p)
HIDDEN:  d < 100 → invisible; 100..150 → fade; else visible
SUDDEN:  d < 200 → visible;   200..250 → fade; else invisible
HID&SUD: both (only the middle band visible)
STEALTH: all chips invisible
alpha == 0 → skip drawing entirely
```
(INFERRED: linear fade, HIDDEN α 0→1 with rising d, SUDDEN α 1→0.) Dark/HidSud historically only affected the drum screen (21:107).

### 3.6 Combo display
Hidden at 0 (CUSTOM) (11:31); NX mode MinCombo 10 (23:237); guitar screen ≥2 (20:131). Jump/fireworks per §1.4.

---

## 4. Default keyboard bindings & binding tokens

- Drum lanes LC HH LP SD HT BD LT FT CY RD = `A S W D F Space J K L ;` (05:26; Space = BD confirmed 19:50). `DrumKeys=` CSV in lane order (14:30, 14:34); tokens per lane: `A` (Unity `Key` enum name), `Pad:South` (`GamepadButton`, prefix mandatory), `Midi:38`, `Midi:38:12` (note:threshold), `A|Pad:LeftTrigger|Midi:38` multi (max **12** per lane — 22:64 raised it from 8; NX allows 16 per 18:190), `None` = intentionally unbound (never re-seeded with defaults; written when dedup empties a lane) (18:103-112, 22:65). `South`/`East` are reserved for menu decide/cancel and excluded (18:115).
- **(ADDED)** Key Assign UI: Enter = capture `< press any key >` and replace, Shift+Enter = add, Delete = remove; arrows/Enter not assignable, Esc cancels capture, Alt excluded from capture and global hotkeys suppressed during capture; a key already used by another lane is **swapped** into that lane (14:35-37, 18:114, 15:5-8, 21:18, 24:227). Hitting a MIDI pad during capture assigns that note (18:175).
- Menus: decide `Enter`/`Space` (pad South); cancel `Esc` (pad East); cursor `↑↓` (hold to repeat); values `←→` (`Ctrl` = ×10); fullscreen `Alt+Enter` (24:201-205). Song select: `X` difficulty, `F2` sort, `F3` search, `F4` training toggle (breadcrumb `[TRAINING]`), `Shift+F1` CONFIG (24:282-289, 21:86-90). Loading: Esc aborts; CUSTOM keeps a 3 s minimum wait, NX mode goes as soon as load + `Now loading` sound finish (24:332, 23:170).
- Guitar/Bass defaults: Guitar R–P = F1–F5, Pick = `]`/`:`, Wail = Right Ctrl; Bass R–P = Numpad 1–5, Pick = Numpad `.`/Enter, Wail = Numpad 0 (20:57-58).
- **(ADDED)** CONFIG item names (drum-relevant): ScrollSpeed, AutoPlay, MasterVolume, JudgeOffset, Key Assign, Reverse, Dark, Hid/Sud, HH/FT/CY/BD Group, CY/RD Merge, FullScreen, Layout, Skin (General), Skin (Box), SaveScore, Play Mode, EXIT; sub-pages Hit Range / Lane AUTO / Key Assign / MIDI Velocity / MIDI Setup (13:44-47, 14:24-31, 16:63, 15:12-15, 17:14, 18:32, 18:334, 21:19, 21:266, 23:17, 23:137, 23:157-158, 24:220-221). NX-mode CONFIG menu: System / Drums / Guitar/Bass / Exit, `<< ReturnTo Menu`, `<< Returnto List` (24:235-245).

---

## 5. Play speed / TimeStretch / BGMAdjust / JudgeOffset / ノーツ表示調整

| Item | Rule | Cite |
|---|---|---|
| ScrollSpeed **(CORRECTED)** | int, default 2 = ×1.0; multiplier = value × 0.5; CONFIG UI (M15) x0.5–x8.0 = int 1..16; Config.ini/training range 1..2000 (app value = NX raw + 1); base ×1.0 = **0.45 px/ms at 720p = 0.675 px/ms at 1080p** (NX 0.17875 px/ms ≈ 2.5× slower); `y = judgeY − Δms × 0.45 × mult` (Reverse flips) | 13:44, 12:17, 18:215-217, 19:91, 05:23, 16:64 |
| PlaySpeed | int 5..40, mult = /20, default 20; chart times stretched, audio via `AudioSource.pitch` (= NX TimeStretch OFF); BpmChanges scaled; BPM display = BPM × speed; system SFX on a separate source (unpitched, not paused) | 18:70, 18:196-197, 21:113-114, 19:123-126 |
| TimeStretch | key kept (0/1) but **not implemented** (needs phase-vocoder for 16 voices) | 18:73, 21:277-279 |
| BGMAdjust | Shift+↑/↓ ±10 ms (Ctrl ±1); flags play as training (not recorded), persists across restart; NX instead saves it in score.ini | 18:50, 18:235-237 |
| JudgeOffset (InputAdjust) | −99..+99 ms; CONFIG label: "NX InputAdjustTimeMs 相当. 正=入力を早めに扱う"; code-level formula `inputMs = songMs + JudgeOffsetMs` (manual hits only); ←/→ in play ∓10 (Ctrl ∓1), written back to ConfigIni (normal) or TrainingSettings (training) | 14:29, 14:45, 18:49, 19:130-132 |
| Training 判定タイミング調整 | ±99 ms, "judge itself earlier/later (audio-latency compensation)"; key `TrainingJudgeOffset` −99..99 | 19:31, 19:90 |
| ノーツ表示調整 | `TrainingNoteOffset` −999..999 ms; `drawMs = songMs − noteDrawOffsetMs` used ONLY for notes/bar lines/loop lines; judgment/score/progress use `songMs` ⇒ positive value draws notes as if earlier in the song (further from the judge line) | 19:30, 19:89, 19:139-140 |
| Lag display sign | negative = early, positive = late; `ShowLagTimeColor` TYPE-A early blue / late red, TYPE-B reversed; `ShowLagTime` 0 OFF / 1 ON / 2 GREAT- (non-PERFECT only); not on AUTO; `ShowLagHitCount` early/late counts on the info line; settings snapshotted at play start | 21:142-147 |
| Metronome | see §1.6 | 18:74 |

---

## 6. Lane order, RD placement, lane types, progress, skill meter

### 6.1 GITADORA vs DTX lanes
- GITADORA has **9 drum inputs**; docs list them in sq3 note order `bass / snare / hihat / hightom / lowtom / floortom / leftcymbal / rightcymbal / leftpedal` (22:30-32) — **not** screen order. The preset table lists pads in the order HT, LT, SD, FT, LC, CY, HH, LP, BD — an enum order (22:52-53). GITADORA's on-screen left→right order is **not documented** anywhere in these docs; the app's Type A order minus RD (LC HH LP SD HT BD LT FT CY) matches it by construction (not from docs). Cymbal reading crash(49)=left, ride(51/52/53)=right — unconfirmed (22:54-57).
- App keeps **10 lanes incl. RD** (DTX-specific); presets never touch RD (22:63). Applying a GITADORA preset empties RD's MIDI so one ride pad doesn't split between CY (bow) and RD (edge); to hit RD chips set `CY Group` = COMMON (22:90-94) or `MergeRide=1` (18:334-337).
- NX `NumOfLanes` / `RDPosition` (9-lane display / RD placement) — **not supported** (23:240, 23:272). Only lane types A–D.

### 6.2 Lane display types A–D (NX `DrumsLaneType`) — X only (21:195-213)
| Lane | B | C | D |
|---|---|---|---|
| LP | +57 | 0 | +106 |
| SD | −51 | 0 | −51 |
| HT | +69 | +69 | −51 |
| BD | −49 | −49 | 0 |
`7_Paret.png` is a Type-A atlas of 10 strips; for type ≠ A it is re-assembled into 10 strips and the single panel hidden; if re-assembly fails, positions revert to Type A (21:208-213). `7_ClipPanel{,B,C}.png` are movie-window frames, not lane panels (21:214-216).

### 6.3 Shutter — §1.1 row (21:160-167).

### 6.4 Section progress bar (21:151-158)
Section cells overlaid in front of the fill (NX draws blocks after fill); unreached = transparent, reached no-miss = green, reached with miss = red; self-best lamps (`ScoreRecord.SectionLamps`) 8 px right of the bar; hidden in training and for unplayed songs; **60 sections** (`ScoreRecord.ProgressSections`) vs NX 64; NX-mode samples 60→64 (23:186, 23:280).

### 6.5 Skill meter (`DrumGraph`, [PlayOption], default OFF) (21:217-228)
NX SmallGraph: BG (880,50); bars x=906 and 936, width 30, bottom y=527, max height 434; current achievement (yellow, NX `tCalculatePlayingSkill` = `PerformanceResult.AchievementRate`) vs self-best `ScoreRecord.BestRate` (cyan if current > best, pink if ≤); current bar hidden in training; 434-px band with Filled fill from bottom.

---

## 7. MIDI drum input (for a Web MIDI port)

```
open ALL input devices (NX-style; no single-device selection); Rescan on CONFIG "MIDI Device" Enter   // 18:126-127, 22:73, 22:113-114
accept iff (status & 0xF0) == 0x90 AND velocity != 0 (vel-0 note-on = note-off, ignored)   // 18:128-130
buffer on callback thread; Poll() at frame start; Pressed(note, velocityMin) = arrived this frame;
Pressing() is ALWAYS false for MIDI                                                     // 18:131-133
drop hit iff velocity <= threshold  (NX: nVelocity <= nVelocityMin.<PAD>, inclusive)     // 18:171-173
threshold = binding.Threshold (Midi:note:thr) ?? lane <PAD>VelocityMin (EffectiveThreshold) // 22:65, 22:106-107
lane VelocityMin [System] 0..127: default HH=20 (crosstalk), all others 0; LBD kept for NX
  compat but has no effect (LP/LBD merged); app applies it to 10 lanes (NX: 9 pads)       // 18:78, 18:171-172, 18:187-193
multiple hits on the same pad within one frame (~16 ms) collapse to one, strongest velocity // 18:183-185
velocity never affects volume (NX likewise)                                             // 18:186
StrongestHitNote(): when registering, take the strongest of simultaneous notes           // 22:104
monitor: per-device open state / total hits / last note+vel; RecentHits (last 6)         // 22:99-100
raising a per-note threshold from "unset" starts at the lane minimum (not 0)              // 22:134
```
GM default map seeded once (`MidiDefaultsSeeded=1`) into lanes lacking MIDI and not `None` (18:156-160):
LC 49 · HH 42,46 · LP 44 · SD 38,40,37 · HT 48,50 · BD 36,35 · LT 45,47 · FT 43,41 · CY 57,55 · RD 51,59,53 (18:163-169).

GITADORA presets (22:39-47), threshold 8 everywhere (not written by Apply); name = MIDI device-name match key, `DEFAULT` = fallback; **(CORRECTED)** matching = exact case-sensitive first, then case-insensitive prefix, tie → preset with more notes (22:37, 22:49-51, 22:136). Preset row shows `AUTO (TD-1)` (22:74).
| Preset | HT | LT | SD | FT | LC | CY | HH | LP | BD |
|---|---|---|---|---|---|---|---|---|---|
| DEFAULT | 50,48 | 47,45 | 38 | 41 | 49 | 51 | 46 | 44 | 36 |
| MIDI DRUM | 50 | 47 | 38 | 41 | 49 | 51 | 46 | 44 | 36 |
| TD-1 | 48 | 45 | 38 | 43 | 49 | 51 | 46 | 44 | 36 |
| DTX DRUMS | 48 | 47 | 38 | 43 | 49 | 51 | 46 | 44 | 36 |
| DTX Drums | 48 | 47 | 38 | 43 | 49 | 51 | 46,42 | 44 | 36 |
| DTX drums | 48 | 47 | 38 | 43 | 49,59 | 51,52,53 | 42,46,78,79,86 | 35,44 | 36 |
| Yamaha DTX700-1 | 15,48 | 19,47 | 38 | 23,43 | 59 | 51,52,53 | 46,78 | 33 | 36 |
Apply Preset: replaces MIDI notes only, keeps keyboard/gamepad, empties RD MIDI, writes no thresholds (22:90-96). CONFIG > MIDI Setup layout (22:72-85, verbatim): `MIDI Device      2 / 3 open`, `Preset           AUTO (TD-1)`, `Apply Preset     >`, `LC               1 note(s)` (Enter = 叩いて追加登録), `   note 49       velocity > 0 (lane)` (←→ per-note threshold, Delete removes), `BACK`; monitor `[1] TD-1   打鍵 12   最後 note 38 vel 112`, `入力: note 38 v112 →SD   note 46 v90 →HH` (`--` = unassigned).

---

## 8. Clock / pause / training-menu state machine (19:9-79)
```
SongClock: WallMs (monotonic, effects) vs SongMs (chart time; pausable, jumpable)         // 18:23
STANDBY --演奏開始/リスタート (ResetPlayStats)--> "START IN x.x" (TrainingStartWait 0..5000 ms, default 1000,
  rounded to 100 ms) --elapsed--> PLAYING <-> PAUSED; PLAYING --song end / 演奏停止--> STANDBY; loop wrap --> START IN
STANDBY/START IN: clock runs, SongMs pinned to _trainStartMs every frame (JumpTo) so pad/flash effects
  animate; hits play sound + pad effect only (no judgment/score)                          // 19:20, 19:75-78
PAUSED: whole clock stops; warm-up hits not accepted                                     // 19:78-79, 19:177
Standby view follows the loop-begin position (SyncStandbyPosition); loop OFF → back to song head // 19:142-144
No movie in training (not even loaded); score table resets at each 演奏開始                  // 19:14-16
Records: neither records.json nor score.ini updated                                       // 19:22
```
Menu (labels verbatim, 19:26-42): 自動演奏 (ON/OFF, = F1) / 自動演奏詳細 (Enter → LC〜RD 10 lanes + 「すべて」 + 「戻る」; LBD not shown) / ノーツ表示調整 (±ms) / 判定タイミング調整 (±ms, ±99) / ハイスピード (x0.5 steps) / 演奏速度 (x0.05 steps, x0.25〜x2.00) / 開始待ち時間 (0.0〜5.0 s) / ループ演奏 (ON / OFF / `ON (無効)`; OFF greys the next 3) / ループ位置単位 (小節 / 秒) / ループ終了位置 (`012 小節` / `24.5 s`; ←→ 1 bar or 0.5 s) / ループ開始位置 (same; begin/end clamped so they never overlap — stop one step short) / 演奏開始／演奏停止 / リスタート / 一時停止／再開 (greyed in standby) / トレーニング終了 (flag stays ON). ←→ with Ctrl = 10 steps (19:17). Loop positions are not saved; initialized to the whole song on each entry (19:97-98). `[Training]` keys: TrainingAutoPlay 0, TrainingAutoLanes `00000000000` (11 digits, 11th = LBD), TrainingNoteOffset 0 (−999..999), TrainingJudgeOffset 0 (−99..99), TrainingScrollSpeed 2 (1..2000), TrainingPlaySpeed 20 (5..40), TrainingStartWait 1000 (0..5000), TrainingLoop 0, TrainingLoopUnit 0 (0=小節, 1=秒) (19:85-95). `TrainingMode` flag is session-only (19:179).

---

## 9. Audio behaviour relevant to Web Audio
- Default drum kit WAVs (LC=LeftCrash, HH=HiHat_Close, LP=HiHat_Foot, SD=Snare, HT=Tom1, BD=Bass, LT=Tom2, FT=Tom3, CY=RightCrash, RD=Ride) as fallback when chart has no sound; synth (`DrumSynth`) as last fallback; empty hits produce a stick sound (05:39-45). Chart WAVs load async and replace fallbacks when ready (05:44); `.xa` decoded via bjxa (08:13-14).
- **(ADDED)** Volumes: `MasterVolume` 0..100 in 5 % steps → `AudioListener.volume` (14:28, 14:43); `#VOLUMExx` 0..100 per WAV (08:15); ChipVolume 100 / AutoChipVolume 80 / BGMSound (21:99-101); preview 80/127 (12:56).
- Auto-play chips (BGM, AUTO chips, SE, GB accompaniment) use a 16-voice pool (oldest cut; finished slots preferred) supporting mid-start, individual stop, pause and pitch; manual hits are unlimited `PlayOneShot` (18:34, 18:225-228, 20:94-96). Panned playback via a 16-source round-robin pool (16:26-27). System sounds (decide/cursor/cancel) on their own source — unpitched, unpaused (19:123-126).
- BGM waits up to 5 s for load; SE skipped if not loaded (18:224). SE24–SE29 (0x84–0x89) treated as ordinary auto SE (18:220-221). `SoundManager.StopAll()` on exit (05:46).
- Exclusive sounds: Title / Stage failed / Stage clear / `#SOUND_STAGEFAILED` vs BGM stop each other (17:15, 17:38). Fill-in cheer `Audience.ogg`; `Metronome.ogg` (18:274, 18:280).

---

## 10. Stale/superseded statements inside the target docs
- 05:24 windows 25/50/100/150 → 34/67/84/117 (17:16, 18:64). 05:23 judge Y=600 → 561 (11:17). 05:57 Miss −0.0205 → raw −0.041 × DamageLevel (21:103). 05:63-70 "gauge/skill/BGA/result unimplemented" → later implemented. 05:25 "AUTO default" → `AutoPlay=` config (13:45).
- 13:44 ScrollSpeed int 1..16 → 1..2000 (18:217). 14:54 "duplicates allowed / no MIDI" → swap (15:5-8), MIDI (18).
- 15:43-48 "MIDI not supported / additive blending impossible / chip pattern anim unnecessary because NX counter is null" → all wrong/stale (18; 11:133-152; 21:131-133, 21:169-176). 16:78 "lane types B–D not possible" → 21:195-213.
- 11:124-131 / 11:175 "pattern anim, bar lines, fill-in, shutter, bonus, waves unimplemented" → all implemented except RD `Chip9` art (21:134, 21:178-179).
- 06:13 achievement weights 1.0/0.5/0.2 → 17:13 formula. 17:35 "app clamps out-of-range config" vs 18:80-81 "keeps current value" for HitRange/SkipTimeMs/PlaySpeed/ShowPlaySpeed — per-key behaviour differs.
- 18:109/190 max 8 bindings → 12 (22:64).

## 11. Verification status
Everything above is **documented only**. Items the docs themselves flag as unverified on hardware: pause/jump audio drift, play-speed pitch/chart sync, loop wrap, beat lines/metronome, fill-in wave/cheer, gamepad, MIDI end-to-end, F11 help (18:285-289); the whole training-menu flow (19:191-201); fullscreen (21:122); all NX-mode layouts (23:267-269).

## Key facts

- Lane order (10 lanes, index 0-9): LC, HH, LP, SD, HT, BD, LT, FT, CY, RD; NX 12ch folded (HC/HO->HH, LP/LBD->LP) (05:18, 17:27). GITADORA has 9 pads (no RD); its on-screen order is NOT documented (22:30-32)
- Design coordinates are NX 1280x720; shipped build renders 1920x1080 with S=1.5 applied to every 720p value (00:79, 12:10-18)
- Default drum keys in lane order: A S W D F Space J K L ; (05:26); DrumKeys tokens A / Pad:South / Midi:38 / Midi:38:12 / '|' multi (max 12 per lane, 22:64) / None (18:103-112)
- Judgment windows +/-ms: PERFECT 34 / GREAT 67 / GOOD 84 / POOR 117, else MISS; pedal lanes (BD/LP/LBD) separate [HitRange] keys 0-999; chip search only inside POOR window; judging uses frame time not event timestamp (17:16, 18:64-66, 18:210-211, 20:119)
- Gauge: init 2/3, max 1.0, min -0.1, Danger 0.3; PERFECT +0.005, GREAT +0.001, GOOD 0, POOR -0.017, MISS = -0.041 x DamageLevel (EASY 0.25 / NORMAL 0.5 / HARD 0.75) = -0.0205 default; clear = last note + 2000 ms (05:56-58, 06:19, 21:96-106)
- Achievement% = P%*0.85 + G%*0.35 + MaxCombo%*0.15 (weights sum 1.35, can exceed 100 -> '7_skill max' glyph); skill = achievement * levelCoef * 0.2; rank SS>=95 S>=80 A>=73 B>=63 C>=53 D>=45 else E (17:13, 23:184, 06:14)
- Score: NX XG, 1,000,000 max, combo coefficient capped 50, all-PERFECT correction; bonus chips +500 pre-calc; clamp 0..9,999,999; per-chip drum formula not written (guitar base 1000000/(1275+50*(n-50)), 20:51) (17:13, 17:17, 17:28)
- Hotkeys: F1 AUTO; Shift+F1/Pause pause; F2 or '=' restart (stats reset); F5 rewind / F6 fast-forward by SkipTimeMs (5000, 100-20000); F7 loop begin->end (LoopCreate); F8 loop clear; F9 -0.05 / F10 +0.05 play speed (int 5..40, /20); Up/Down ScrollSpeed +-1 (=+-0.5x); Left/Right InputAdjust -/+10 ms (Ctrl 1 ms); Shift+Up/Down BGMAdjust +-10 ms (Ctrl 1 ms); F11 help; Esc abort (18:40-52, 18:69-70)
- F5-F10 or BGMAdjust => play not recorded; restart clears training flag except BGMAdjust; jump does NOT restore score/combo/counts/gauge and skipped chips are not MISSed; loop wrap combo=0 (+ fireworks flag) per 18:232 but 19:178 says counts+score reset too (18:54-56, 18:229-237)
- ScrollSpeed: int default 2 = x1.0, multiplier = value*0.5; UI range 1..16 (13:44), ini range 1..2000 (18:217); base x1.0 = 0.45 px/ms at 720p = 0.675 px/ms at 1080p (NX 0.17875); y = judgeY - dt*0.45*mult; Reverse flips direction, judge line Y=159, gauge to y=28 (12:17, 16:64-66)
- Judge line Y=561; lane centre X LC=298 HH=370 LP=419 SD=470 HT=527 BD=582 LT=645 FT=694 CY=748 RD=815; chip widths LC/CY=74 BD=70 SD=64 HH/HT/LT/FT=56 LP=58 RD=48, height 64; chip sheet rows: body y=0, bonus y=64, pattern y=128+64*frame (8 frames @70 ms), scatter y=640, bar y=769, beat y=772 (11:17-23, 23:77-79, 21:185, 18:204)
- CUSTOM pads 96x96 at y=10 (NX mode y=570), X LC=263 HH=336 LP=396 SD=446 HT=510 BD=565 LT=622 FT=672 CY=735 RD=791; gauge frame (294,626), bar 480x31 at (314,635); score digits (40,41) pitch 34, 7 digits; combo right-aligned from x=1275, y=60, pitch 114, hidden at 0 (NX mode MinCombo 10); progress bar x=853 (11:24-32, 23:228, 23:237)
- Lane flash: ct 0->90 @3 ms, y=700-ct*7.4, alpha proportional to y, fires on empty hits too; chip fire ct 0->70 @3 ms, scale=0.4+0.8*cos((ct/50)*pi/2), additive, hit-only; 16 stars 7 ms x40 steps, vy*=1.010, vy-=0.0204; scatter 10 ms x45 steps XL-=2.5ax, Y+=8.66ay-0.532, ax*=0.995, ay+=0.031; combo jump -15*sin(pi*t/180) 180 ms CUSTOM / 120 ms NX mode (11:38-55, 11:160-165, 21:185-190, 23:237)
- Dark 0/1/2 = OFF / HALF (hide lane panel) / FULL (+judge line, pads, bar/beat lines, NX progress bar); HidSud 0-4 = OFF/HIDDEN/SUDDEN/HID&SUD/STEALTH; HIDDEN <100 px invisible, 100-150 fade; SUDDEN <200 px visible, 200-250 fade (720p px, x1.5 at 1080p) (15:12-19, 23:236)
- JudgeOffset -99..+99 ms; CONFIG label says positive = 'treat input earlier' but the formula is inputMs = songMs + JudgeOffsetMs (manual only) (14:29, 14:45); lag display negative=early / positive=late (21:142); TrainingNoteOffset: drawMs = songMs - offset for notes/bar/loop lines only (19:139-140)
- TimeStretch key kept (0/1) but NOT implemented; play speed changes pitch via AudioSource.pitch; system sounds on a separate unpitched, unpaused source (18:73, 18:196-197, 19:123-126, 21:277-279)
- Beat lines: quarter-note spacing (4/4 -> 3, barLen 0.75 -> 2, 2.00 -> 7), 0xC1 shifts right (overflow dropped), 0xC2 01=show/02=hide (drawing only); Metronome=1: bar normal volume, beat 40/127, keeps sounding when lines hidden; Dark=FULL hides lines (18:266-273, 18:74, 18:260)
- Fill-in ch53: stars on each hit, wave on last chip (next drum chip >=100 ms later; NX >=24 ticks), Audience.ogg at section end if combo>0 or AUTO; 03/04 = chorus bonus fireworks (gated by FillInEffect in app); DrumsAttackEffect gates fire (all but ALL OFF) / stars (ALL ON, ChipOFF) / scatter (ALL ON) (18:222-223, 18:273-284, 21:191-193)
- MIDI: accept only 0x9n with velocity != 0; drop if velocity <= threshold (inclusive); per-note Midi:note:thr overrides lane VelocityMin (default HH=20, others 0, 0-127); Pressing always false; same-frame duplicates merged (strongest); velocity never affects volume; all devices opened (18:128-133, 18:171-173, 18:183-186, 22:65)
- GM default MIDI map: LC 49; HH 42,46; LP 44; SD 38,40,37; HT 48,50; BD 36,35; LT 45,47; FT 43,41; CY 57,55; RD 51,59,53 (18:163-169); 7 GITADORA presets, threshold 8 everywhere, device-name match exact -> case-insensitive prefix -> more notes wins; Apply empties RD MIDI (22:39-51, 22:90-96, 22:136)
- Lane types B/C/D shift X only: LP/SD/HT/BD = B (+57,-51,+69,-49), C (0,0,+69,-49), D (+106,-51,-51,0); NX NumOfLanes/RDPosition (9-lane display) NOT supported; MergeRide=1 moves RD chips into CY lane (21:201-206, 23:240, 18:334-337)
- Movie: full-screen behind lanes, file 0:00 = ch54 time, no seeking (play->pause->resume), audio muted only when chart has BGM, stays stopped after F5/F6 jump; BGA 4 layers CUSTOM / 8 NX mode at (990,0) 278x355; jacket hidden when either starts (08:21-46, 16:31-35, 18:200-201)
- Training menu (F4 in song select, Enter-only decide, Ctrl = 10 steps, repeat immediate->200 ms->30 ms): 15 items verbatim in spec sec.8; states STANDBY -> 'START IN x.x' (TrainingStartWait 0-5000 ms, default 1000) -> PLAYING <-> PAUSED; never STAGE FAILED, never recorded; F5-F10/arrows disabled (19:13-52, 19:54-79, 19:133-134)
- Audio: default kit LeftCrash/HiHat_Close/HiHat_Foot/Snare/Tom1/Bass/Tom2/Tom3/RightCrash/Ride, synth last fallback; ChipVolume 100 / AutoChipVolume 80 / MasterVolume 5% steps / #VOLUMExx / #PANxx; 16-voice pool for auto chips, unlimited PlayOneShot for hits; BGM waits <=5 s to load (05:39-45, 14:28, 08:15, 16:25-27, 18:224-228, 21:99-101)

## Open questions

- JudgeOffset sign: 14:29 says positive = '入力を早めに扱う' yet 14:45 gives inputMs = songMs + JudgeOffsetMs (stamps the hit later). Which is authoritative must be checked in PerformanceStage.cs / ConfigIni.cs.
- Arrow-key signs during play are only implied by key ordering: is Up = ScrollSpeed +1, Left = InputAdjust -10, Shift+Up = BGMAdjust +10? (18:48-50). And what exactly does 'Ctrl の有無が逆なのも NX どおり' (18:49) mean — Ctrl = 1 ms step (smaller) vs menus' Ctrl = x10 (24:204)?
- F7 loop-create exact semantics: single press captures begin, second captures end? What does a third press / F7 with loop already set do? Only 'ループ開始→終了を設定' (18:46) and 'LoopCreate 相当' (19:206) exist.
- Loop-wrap stat reset conflict: 18:232 says NX zeroes only combo (app also clears the 100-combo fireworks flag) while 19:178 says judgment counts, combo AND score reset on wrap.
- No sounds are documented for F5-F10 / arrow adjustments / restart (only training-menu operation sounds, 19:150).
- Exact hotkey priority order of the reproduced NX if/else-if chain (18:12) is not listed.
- Drum per-chip score formula is not written out; whether the guitar base 1000000/(1275+50*(n-50)) (20:51) applies and whether bonus-chip points are deducted from the pool ('ボーナス控除なし' is stated only for GB) is inferred.
- Achievement weights sum to 1.35 (17:13): is the result clamped, and what exactly are P%/G%/MaxCombo% denominators? 23:184 implies >=100 is displayable.
- HidSud fade direction/interpolation (linear? which end is 0/1) is inferred from 15:17-18.
- Gauge Danger: 05:56 gives 'Danger=0.3' without saying < or <=; 21:105 only covers the Risky case.
- NX 'scroll speed smoothing' (CActPerfScrollSpeed, 18:48, 18:315) formula is not documented.
- PlaySpeed on the F9/F10 path: clamped to 5..40 or 'kept if out of range' (18:80-81 covers ini parsing only)? Display duration for ShowPlaySpeed=2 and for the CUSTOM hi-speed text (18:218) are undocumented.
- DANGER visual: 05:60 (red blinking vertical bar, old prefab), 11:34 (7_Danger.png overlay, CUSTOM), 23:239 (NX mode draws nothing) — which applies per Layout/prefab; blink rate undocumented.
- GITADORA cymbal mapping (crash 49 = LC, ride 51/52/53 = CY) is explicitly unconfirmed (22:54-57); GITADORA on-screen lane order is not in any doc.
- AUTO-lane achievement revise factor (dbCalcReviseValForDrGtBsAutoLanes, 18:313) formula is not in any doc.
- Global AutoPlay default: 05:25 says AUTO was default in M5; 24:219 mock shows 'AutoPlay OFF'; no doc states the Config.ini default.
- Hidden chips (0x31-0x3C): are they judged/counted or only sound-triggers? Docs only say they participate in tie resolution (17:33) and are moved by MergeRide (18:335).
- ch53 fill-in values: 03/04 = chorus (18:208), 02/05/06 = end flash (23:233); the meaning of 01 vs 05 (begin variants) and 0xC1's shift unit are not documented.
- DrumsAttackEffect int -> name mapping (ALL ON / ChipOFF / ALL OFF) is not given; default 0 is presumably ALL ON since 11:162 says stars are on by default.
- When exactly is a passed chip declared MISS (chip time + Poor window elapsed?) — 05:26 and 17:80 only reference NX lines 2913-2918.
- CUSTOM progress bar fill direction (Image Filled, 11:91) and NX-mode score count-up rate (23:239) are undocumented.
- NX judge-string Type1 vertical formula cy = 348 + 32*v (23:229): what is v?
- Exact user-facing strings for the no-notes notice (05:28), CLEAR/FAILED banner (05:59), F11 help overlay (18:51) and the perf-info line (21:145) are not quoted.
- Hand-edited CUSTOM prefab elements (song_info, score_detailed, movie_frame, 19:161-162) have no documented positions; the generator layout in 11 may not match the shipped prefab.
- NX-mode combo MinCombo 10 / 120 ms vs CUSTOM hidden-at-0 / 180 ms (23:237, 11:31, 17:32): confirm both are intentional per layout.
- Metronome: is Metronome.ogg a single file played at two volumes (bar normal, beat 40/127) or two files? (18:74, 18:280)
- Config out-of-range handling is inconsistent across docs: 17:35 'clamp' vs 18:80-81 'keep current' — per-key behaviour needs code check.
