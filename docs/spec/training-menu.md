# training-menu

# Training Menu — Behavioral Specification (merged + corrected, for browser re-implementation)

Sources (all under `DTXManiaAI\`):
- `Assets\Scripts\Stages\TrainingMenu.cs` (TM, 511 lines)
- `Assets\Scripts\Core\TrainingSettings.cs` (TS, 211 lines)
- `Assets\Scripts\Core\Counter.cs` (CT)
- `Assets\Scripts\Core\GameTimer.cs` (GT)
- `Assets\Scripts\Config\ConfigIni.cs` (CI)
- `Assets\Scripts\Core\UIFactory.cs` (UF)
- `Assets\Scripts\Input\InputManager.cs` (IM)
- `Assets\Scripts\Audio\SoundManager.cs` (SM)
- `Assets\Scripts\Song\DtxChart.cs` (DC) — note: path is `Song\`, not `Chart\`
- `Assets\Scripts\Stages\PerformanceStage.cs` (PS) — menu-facing parts only
- `docs\19_training-mode.md` (DOC)

Tags: **[CORRECTION]** = the colleague's spec was wrong; **[ADDED]** = missing from the colleague's spec; **[BUG]** = behaviour of the source that contradicts its own stated intent.

---

## 0. Overall model

- The menu is a pure view+input layer over a shared `TrainingSettings` object (TM:16-18, 87-88). It never applies settings to the performance; `PerformanceStage.ApplyTrainingSettings` re-reads them every frame (PS:1552-1572) and the menu only returns an `ECommand` per frame (TM:236-266).
- Exception: **演奏速度 (play speed)** stretches chart times, so the menu calls the stage-owned callback `PlaySpeedStep(delta)` (TM:90-91, 362-365; PS:1682-1695).
- Two pages: `Main` (15 items) and `AutoDetail` (12 items) (TM:40, 58, 72). `EPage { Main, AutoDetail }`.
- All numeric values are integers; **no wrap-around** on any value (all `Mathf.Clamp`). The **cursor wraps** (modulo) (TM:134-146).
- Disabled/grey items remain **navigable and editable**; "disabled" only affects colour (TM:424-431, 444-459).
- **[ADDED] Initial state**: constructor sets `_page = Main`, `_cursor = 0` (自動演奏), `Playing = false`, `Paused = false`, `StateText = ""` (TM:97-98, 104-110). `Build()` ends with `Refresh()` (TM:221), so before the stage's first update the state line is empty and item 11 reads `演奏開始`.
- **[ADDED] The settings object is `ConfigIni.Training`** (a single `readonly` instance, CI:341; PS:589), so menu edits persist across songs within a session even before saving, and are written to `Config.ini` when leaving the performance stage in training mode (PS:1830-1831), when leaving the Config screen (ConfigStage.cs:807), and on application quit (GameMain.cs:238-242). If `Config` is null, a fresh `TrainingSettings` is used (PS:589).

---

## 1. Main page items (index → label → value string → ←/→ → Enter)

Item indices and labels (TM:43-65):

| idx | const | Label (exact) |
|---|---|---|
| 0 | ItemAuto | `自動演奏` |
| 1 | ItemAutoDetail | `自動演奏詳細` |
| 2 | ItemNoteOffset | `ノーツ表示調整` |
| 3 | ItemJudgeOffset | `判定タイミング調整` |
| 4 | ItemHiSpeed | `ハイスピード` |
| 5 | ItemPlaySpeed | `演奏速度` |
| 6 | ItemStartWait | `開始待ち時間` |
| 7 | ItemLoop | `ループ演奏` |
| 8 | ItemLoopUnit | `ループ位置単位` |
| 9 | ItemLoopEnd | `ループ終了位置` |
| 10 | ItemLoopBegin | `ループ開始位置` |
| 11 | ItemStartStop | `演奏開始` when `Playing==false`, `演奏停止` when `Playing==true` (TM:469) |
| 12 | ItemRestart | `リスタート` |
| 13 | ItemPause | `一時停止` when `Paused==false`, `再開` when `Paused==true` (TM:470) |
| 14 | ItemQuit | `トレーニング終了` |

Order note: 終了位置 (9) is ABOVE 開始位置 (10); ループ位置単位 (8) is one above 終了位置 (TM:42; DOC:44-45).

### 1.1 Value strings (TM:474-498) — .NET `string.Format` semantics

| idx | Format | Examples |
|---|---|---|
| 0 自動演奏 | `AutoPlay ? "ON" : "OFF"` | `ON`, `OFF` |
| 1 自動演奏詳細 | `AutoLaneSummary()` (TM:501-509): n = count of `AutoLanes[0..9]` true. `n==0 → "なし"`, `n==10 → "すべて"`, else `n + " レーン"` (ASCII digits, one space) | `なし`, `3 レーン`, `すべて` |
| 2 ノーツ表示調整 | `"{0:+0;-0;0} ms"` of NoteOffsetMs | `+12 ms`, `-5 ms`, `0 ms` (zero has NO sign; no zero padding) |
| 3 判定タイミング調整 | `"{0:+0;-0;0} ms"` of JudgeOffsetMs | `+99 ms`, `-99 ms`, `0 ms` |
| 4 ハイスピード | `"x{0:0.0}"` of `ScrollSpeed * 0.5f` (TS:84) | 1→`x0.5`, 2→`x1.0`, 3→`x1.5`, 2000→`x1000.0` |
| 5 演奏速度 | `"x{0:0.00}"` of `PlaySpeed / 20f` (TS:81) | 5→`x0.25`, 20→`x1.00`, 21→`x1.05`, 40→`x2.00` |
| 6 開始待ち時間 | `"{0:0.0} s"` of `StartWaitMs / 1000f` | 0→`0.0 s`, 1000→`1.0 s`, 5000→`5.0 s` |
| 7 ループ演奏 | `!Loop ? "OFF" : (LoopRangeValid ? "ON" : "ON (無効)")` | `OFF`, `ON`, `ON (無効)` (ASCII space + ASCII parentheses) |
| 8 ループ位置単位 | `LoopUnit==Measure ? "小節" : "秒"` | `小節`, `秒` |
| 9 ループ終了位置 | `FormatLoopTime(LoopEndMs, LoopUnit, measureTimes)` (§4.7) | `012 小節` or `24.5 s` |
| 10 ループ開始位置 | `FormatLoopTime(LoopBeginMs, ...)` | `000 小節` or `0.0 s` |
| 11–14 (actions) | `""` (empty) | |

The DOC (line 37) and the TS:203 comment write `012小節`/`24.5s` without spaces; the CODE (TS:207-208) has a space: `"{0:000} 小節"` and `"{0:0.0} s"`. Code wins.

**[ADDED] Float formatting rule for the port.** All `{0:0.0}`/`{0:0.00}` operands are `float` (single). .NET/Mono formats a `float` with a custom format by first producing 7 significant decimal digits and then rounding half-away-from-zero at the requested decimals. Consequence: values that are exact multiples of the display step (all of items 4, 5, 6) are unaffected, but arbitrary values (loop positions in seconds after a play-speed rescale, and the `START IN` countdown, §5.5) differ from JS `toFixed`: e.g. 950 ms → `0.95f` → .NET `"1.0"`, JS `(0.95).toFixed(1)` → `"0.9"`; 12350 ms → .NET `"12.4"`, JS `"12.3"`. Emulate with: `s = Number(x.toPrecision(7))` then round half-away-from-zero on the decimal string of `s` at the requested number of decimals.

### 1.2 ←/→ behaviour: `ChangeValue(delta)` (TM:316-397)

`delta = ±StepAmount`, `StepAmount = CtrlHeld ? 10 : 1` (TM:149). `CtrlHeld = LeftCtrl.isPressed || RightCtrl.isPressed` (IM:129). Left → `ChangeValue(-StepAmount)`, Right → `ChangeValue(+StepAmount)` (TM:151-152).

```
ChangeValue(delta):
  if delta == 0: return                                                  // TM:318 (never happens from the menu)
  if page == AutoDetail: (see §2)                                        // TM:321-340
  switch cursor:
    0  Auto:        AutoPlay = !AutoPlay                                 // toggle, sign/magnitude ignored (TM:344-346)
    1  AutoDetail:  return                                               // ←→ do NOTHING, no sound (TM:347-350)
    2  NoteOffset:  NoteOffsetMs = clamp(NoteOffsetMs + delta, -999, 999)          // TM:351-354
    3  JudgeOffset: JudgeOffsetMs = clamp(JudgeOffsetMs + delta, -99, 99)          // TM:355-358
    4  HiSpeed:     ScrollSpeed = clamp(ScrollSpeed + delta, 1, 2000)              // TM:359-361
    5  PlaySpeed:   if PlaySpeedStep != null: PlaySpeedStep(delta)      // delegated, §7.2 (TM:362-365)
    6  StartWait:   StartWaitMs = clamp(StartWaitMs + delta*100, 0, 5000)          // TM:366-369
    7  Loop:        Loop = !Loop                                         // toggle (TM:370-372)
    8  LoopUnit:    LoopUnit = (LoopUnit==Measure) ? Second : Measure    // toggle (TM:373-375)
    9  LoopEnd:     v = StepLoopEnd(LoopEndMs, LoopBeginMs, delta, LoopUnit, measureTimes, DurationMs)
                    if v == LoopEndMs: return                            // cannot move → NO sound (TM:380-381)
                    LoopEndMs = v
    10 LoopBegin:   v = StepLoopBegin(LoopBeginMs, LoopEndMs, delta, ...)
                    if v == LoopBeginMs: return                          // NO sound (TM:388-389)
                    LoopBeginMs = v
    default (11-14 actions): return                                      // no sound (TM:393-394)
  PlayCursorThrottled()                                                  // TM:396 (see §3.2 for the [BUG])
```

Nuances:
- For items 2, 3, 4, 6 the cursor sound is requested **even when already at the clamp limit** (value unchanged). Only LoopEnd/LoopBegin suppress it when unchanged.
- Item 5: sound is requested regardless of whether the stage actually changed the value, and even if `PlaySpeedStep` is null.
- Ctrl×10 applies to every numeric item including loop positions (delta=±10 → 10 measures or 5.0 s) and StartWait (±1000 ms).
- Toggles (0, 7, 8) ignore sign and magnitude: Ctrl+← still toggles once per fire.
- `DurationMs` passed to the step functions is `chart != null ? chart.DurationMs : 0` (TM:172).
- With Ctrl held, Enter still uses delta=+1 (§1.3), NOT +10.

### 1.3 Enter: `Decide()` (TM:268-300)

```
Decide():
  if page == AutoDetail:                                   // TM:270-277
      if cursor == 11 (戻る): BackToMain() else ChangeValue(+1)
      return None
  switch cursor:
    1  AutoDetail: OpenAutoDetail(); return None      // page=AutoDetail, cursor=0, PlayDecide (TM:302-307)
    11 StartStop:  PlayDecide(); return StartStop
    12 Restart:    PlayDecide(); return Restart
    13 Pause:      PlayDecide(); return PauseResume   // returned EVEN in standby (grey); stage ignores it (§7.2)
    14 Quit:       PlayCancel(); return Quit
    default:       ChangeValue(+1); return None       // value items: Enter == → with step 1 (TM:296-298)
```
**[ADDED]** Enter on loop positions can therefore only move them forward (+1 step); on toggles it toggles.

### 1.4 Disabled (grey) conditions (TM:444-459)

- 8 ループ位置単位, 9 ループ終了位置, 10 ループ開始位置: disabled when `!Loop`.
- 13 一時停止/再開: disabled when `!Playing`.
- Everything else: never disabled. AutoDetail page: nothing disabled (TM:446-447).
- Disabled only changes colour when NOT selected (§5.4). Editing and activation still work.

### 1.5 Action items (TM:435-441)

Main: 11, 12, 13, 14. AutoDetail: only 戻る (index 11). Action items get `ColorAction` when not selected and not disabled.

---

## 2. AUTO lanes submenu (page `AutoDetail`)

Item order and labels (TM:69-72, 461-467, 474-479). `DtxChart.LaneCount = 10` (DC:73); `AutoDetailAll = 10`, `AutoDetailBack = 11`, `AutoDetailCount = 12`.

| idx | Label | Value |
|---|---|---|
| 0 | `LC` | `AUTO` if `AutoLanes[0]` else `手動` |
| 1 | `HH` | `AutoLanes[1]` |
| 2 | `LP` | `AutoLanes[2]` |
| 3 | `SD` | `AutoLanes[3]` |
| 4 | `HT` | `AutoLanes[4]` |
| 5 | `BD` | `AutoLanes[5]` |
| 6 | `LT` | `AutoLanes[6]` |
| 7 | `FT` | `AutoLanes[7]` |
| 8 | `CY` | `AutoLanes[8]` |
| 9 | `RD` | `AutoLanes[9]` |
| 10 | `すべて` | `""` |
| 11 | `戻る` | `""` |

LBD (`AutoLanes[10]`) is deliberately NOT shown and never touched by the menu (TM:67-68; DOC:180-181), though the stage does read it (`_lbdAuto = AutoLanes[10]`, PS:1565).

Header on this page: `TRAINING - 自動演奏詳細` (ASCII hyphen with spaces; TM:408). Rows 12-14 are hidden (TM:412-422).

Behaviour (TM:270-277, 302-314, 321-340):
```
Open (Enter on Main item 1): page=AutoDetail; cursor=0 (LC); PlayDecide.
←/→ or Enter on lane i (0..9): AutoLanes[i] = !AutoLanes[i]; cursor sound (throttled). Sign/Ctrl ignored.
←/→ or Enter on すべて (10):
    allOn = AutoLanes[0..9] all true
    for i in 0..9: AutoLanes[i] = !allOn        // any lane manual → all AUTO; all AUTO → all manual
    cursor sound (throttled)
←/→ on 戻る (11): nothing, no sound (TM:323-324).
Enter on 戻る, or Esc anywhere on this page: BackToMain()
BackToMain: page=Main; cursor=1 (自動演奏詳細); PlayCancel (TM:309-314).
All of the above return ECommand.None.
```
The submenu can only be opened with Enter (not ←/→) so that key-repeat does not immediately toggle LC (TM:348-349).

---

## 3. Input handling per frame (`HandleInput`, TM:236-266)

```
HandleInput() -> ECommand:
  if _root == null: return None                    // not built / destroyed: arrow counters NOT updated (TM:238-239)
  // 4 independent repeat counters, evaluated in this order, all BEFORE Enter/Esc
  ctUp.RepeatKey(UpArrow.isPressed,    MoveCursorUp)      // TM:243
  ctDown.RepeatKey(DownArrow.isPressed, MoveCursorDown)   // TM:244
  ctLeft.RepeatKey(LeftArrow.isPressed, ChangeValueLeft)  // TM:245
  ctRight.RepeatKey(RightArrow.isPressed, ChangeValueRight) // TM:246
  cmd = None
  if Enter.wasPressedThisFrame || NumpadEnter.wasPressedThisFrame: cmd = Decide()   // TM:250-251
  if Escape.wasPressedThisFrame:                                                     // TM:253-264
      if page == AutoDetail: BackToMain()
      else: PlayCancel(); cmd = Quit        // overrides any cmd from Decide in the same frame
  return cmd
```

- Only keyboard keys: `Key.UpArrow/DownArrow/LeftArrow/RightArrow/Enter/NumpadEnter/Escape` (no gamepad). `Pressing` = `isPressed` (held), `Pressed` = `wasPressedThisFrame` (edge) (IM:51-62).
- Cursor movement (TM:134-146): `Up: cursor = (cursor-1+count)%count`, `Down: cursor = (cursor+1)%count`, count = 15 (Main) or 12 (AutoDetail); both request the throttled cursor sound.
- **[ADDED] Same-frame ordering**: arrow fires happen before `Decide`, so Down+Enter in one frame activates the item *below* the previous cursor. Up and Down both pressed in one frame: Up fires first, then Down (net zero, two sound requests).
- **[ADDED] Same-frame Enter+Esc on AutoDetail with cursor on 戻る**: `Decide` → `BackToMain` (page=Main) and then the Esc branch sees `page == Main` → `PlayCancel` + `Quit`. Enter on 自動演奏詳細 + Esc in one frame: opens then immediately closes (cursor stays 1, two sounds).
- **[ADDED]** Repeat-counter state is per key and is NOT reset on page change or on Build/Destroy; only key release resets it.

### 3.1 Key repeat: `Counter.RepeatKey` (CT:96-138)

Per-key state machine; `CurrentValue ∈ {0 first, 1 second, 2 third}`, `CurrentElapsedMs` timestamp, clock = `GameTimer.NowMs` = `Stopwatch.ElapsedMilliseconds` (real wall time since app start, never pauses, always ≥ 0; GT:13-19). Counters are constructed `new Counter(0, 0, 0, g.Timer)` (TM:124-127) → `Start()` sets `CurrentValue = 0`, `CurrentElapsedMs = NowMs` (CT:42-50). `Update()` is never called for these counters.

```
RepeatKey(pressing, onFire):
  if pressing:
    case 0: onFire(); state=1; stamp=now; return                              // CT:110-114
    case 1: if (now - stamp) > 200: onFire(); stamp=now; state=2; return      // CT:116-123 (strictly greater)
    case 2: if (now - stamp) > 30:  onFire(); stamp=now; return               // CT:125-131 (strictly greater)
  else:
    state = 0                                                                  // CT:134-137
```
- Fire immediately on press; second fire on the first frame where >200 ms have elapsed since the first fire; then on every frame where >30 ms have elapsed since the *previous fire* (stamp is reset at each fire, no catch-up/accumulation). Effective period = smallest multiple of the frame interval strictly greater than the threshold: at 60 fps → 2 frames ≈ 33.3 ms (second fire after 13 frames ≈ 216.7 ms); at 120 fps → 4 frames ≈ 33.3 ms; at 144 fps → 5 frames ≈ 34.7 ms; at 30 fps → 66.7 ms. Releasing resets instantly.
- Each of the four arrow keys has its own counter; Ctrl is sampled at each fire (a fire while Ctrl is down steps by 10).

### 3.2 Cursor-sound throttling (TM:116-118, 154-162)

Intended behaviour (per comments TM:116, 154 and DOC:151):
```
CursorSoundIntervalMs = 60
lastCursorSoundMs = -infinity
PlayCursorThrottled():
  now = Timer.NowMs
  if now - last < 60: return
  last = now
  Sound.PlayCursor()
```
**[BUG] Actual behaviour of the source**: `_lastCursorSoundMs` is initialised to `long.MinValue` (TM:118) and the test is `now - _lastCursorSoundMs < 60` (TM:158). In C# unchecked arithmetic `now - long.MinValue` overflows to a large *negative* value, so the condition is always true, the method returns before updating `_lastCursorSoundMs`, and **the cursor sound never plays anywhere in the training menu** (cursor moves and value changes are silent; only PlayDecide/PlayCancel are audible). DOC:191-197 lists "操作音が潰れないこと" as *unverified on real hardware*, consistent with this going unnoticed. The port should implement the stated intent (initialise `last = -Infinity` or `null`, which in JS yields `now - (-Infinity) = Infinity`, not `< 60`) — see Open Questions.

Applies to cursor moves and value changes. `PlayDecide` / `PlayCancel` are NOT throttled.

**[ADDED] Sound plumbing** (SM:17-19, 92-96, 341-349, 368): all three system sounds go through `PlaySystem(clip)` → `_system.PlayOneShot(clip)` on a dedicated `AudioSource`: overlapping plays are allowed (no cut-off), unaffected by the chip pitch change from 演奏速度, and not paused by `PausePerformance`. `PlayDecide` = `ClipDecide` (silent if the clip is missing); `PlayCursor` = `ClipCursor`; `PlayCancel` = `ClipCancel`, falling back to `ClipCursor` if missing. `StopAll` (SM:324-326, called on leaving the stage) also stops the system source.

---

## 4. `TrainingSettings` (TS)

### 4.1 Fields, defaults, ranges, steps

| Field | Type | Default | Min | Max | Step (menu) | Saved? |
|---|---|---|---|---|---|---|
| AutoPlay | bool | false | | | toggle | yes |
| AutoLanes | bool[11] | all false | | | toggle per lane (0-9 only via menu) | yes |
| NoteOffsetMs | int | 0 | -999 | 999 | 1 (Ctrl 10) | yes |
| JudgeOffsetMs | int | 0 | -99 | 99 | 1 (Ctrl 10) | yes |
| ScrollSpeed | int | 2 | 1 | 2000 | 1 (Ctrl 10) | yes |
| PlaySpeed | int | 20 | 5 | 40 | 1 (Ctrl 10) | yes |
| StartWaitMs | int | 1000 | 0 | 5000 | 100 (Ctrl 1000) | yes |
| Loop | bool | false | | | toggle | yes |
| LoopUnit | enum | Measure(0) | 0 | 1 | toggle | yes |
| LoopBeginMs | int | 0 (set at stage entry) | 0 | DurationMs | 1 measure / 500 ms | NO |
| LoopEndMs | int | max(0, DurationMs) (stage entry) | 0 | DurationMs | 1 measure / 500 ms | NO |

Constants: `NoteOffsetMin=-999, NoteOffsetMax=999` (TS:31); `JudgeOffsetMin=-99, JudgeOffsetMax=99` (TS:34); `StartWaitMin=0, StartWaitMax=5000, StartWaitStep=100` (TS:37); `LoopSecondStepMs=500` (TS:40); `ConfigIni.ScrollSpeedMin=1, ScrollSpeedMax=2000` (CI:38); `ConfigIni.PlaySpeedMin=5, PlaySpeedMax=40` (CI:621); `ConfigIni.AutoLaneCount=11, AutoLaneLBD=10` (CI:216-217); `AutoLanes = new bool[11]` (TS:46).

`ELoopUnit { Measure = 0, Second = 1 }` (TS:7-13).

Derived: `HiSpeedRatio = ScrollSpeed * 0.5f` (TS:84); `PlaySpeedRatio = PlaySpeed / 20f` (TS:81); `LoopRangeValid = LoopEndMs > LoopBeginMs` (TS:78).

Loop positions are initialised on entering the performance stage: `LoopBeginMs = 0; LoopEndMs = max(0, chart.DurationMs)` (PS:1483-1484). `DurationMs` is the max chip/long-note time in the chart (DC:236, 499-570).

### 4.2 `Clamp()` (TS:87-97) — applied only after loading Config (CI:712), never by the menu

```
NoteOffsetMs  = clamp(NoteOffsetMs, -999, 999)
JudgeOffsetMs = clamp(JudgeOffsetMs, -99, 99)
ScrollSpeed   = clamp(ScrollSpeed, 1, 2000)
PlaySpeed     = clamp(PlaySpeed, 5, 40)
StartWaitMs   = clamp(StartWaitMs, 0, 5000)
StartWaitMs   = (StartWaitMs / 100) * 100        // integer division → truncates DOWN to a multiple of 100 (1250→1200, 4999→4900)
if LoopUnit not in {0,1}: LoopUnit = Measure
```

### 4.3 AutoLanes string round-trip (TS:99-115)

- `AutoLanesToString()`: 11 chars, `'1'` for true, `'0'` for false, index order LC,HH,LP,SD,HT,BD,LT,FT,CY,RD,LBD (CI:220). Default `00000000000`.
- `AutoLanesFromString(s)`: null/empty → no change. For `i in 0 .. min(11, s.length)-1`: `AutoLanes[i] = (s[i] != '0')` — any character other than `'0'` is true. Shorter strings only set leading lanes (the rest keep current values); longer strings are truncated to 11.

### 4.4 Measure list: `BuildMeasureTimes(chart)` (TS:125-141)

```
times = [0]
if chart != null:
  for b in chart.BarLines:                      // sorted ascending by TimeMs at parse time (DC:582)
    if b.IsBeat: continue                       // skip beat lines (ch 0x51); keep bar lines (0x50) (DC:439-447)
    if b.TimeMs <= times[last]: continue         // drops the 0 ms bar line and duplicates / non-increasing
    times.append(b.TimeMs)
return times
```
`Visible` (0xC2 hidden bar lines) is ignored — hidden bars still count. `BarLine.Measure` is not used. The list is never empty (always contains 0), even for a null chart. Must be rebuilt whenever play speed changes because `ScaleChartTimes` rescales `BarLines[].TimeMs` and `DurationMs` (PS:1258, 1282) — `TrainingMenu.SetChart` does this (TM:165-169; PS:1487, 1694).

**[ADDED]** Before `SetChart` is ever called, `_measureTimes` is an empty list (TM:101); in that state Measure-unit stepping and formatting fall back to the seconds behaviour (TS:167, 206). In practice `SetChart` precedes `Build` (PS:1487-1489).

The displayed measure number is the **0-based index into `times`**, not `BarLine.Measure`; index 0 always corresponds to 0 ms.

### 4.5 `MeasureIndexAt(times, t)` (TS:144-156)

Binary search returning the largest `i` with `times[i] <= t`; returns 0 for null/empty list or `t < times[0]`; returns the last index for `t` beyond the last head.

### 4.6 Stepping loop positions

`StepLoopTime(currentMs, delta, unit, measureTimes, durationMs)` (TS:164-176):
```
maxMs = max(0, durationMs)
if unit == Measure && measureTimes non-empty:
    idx = MeasureIndexAt(measureTimes, currentMs)
    if delta < 0 && currentMs > measureTimes[idx]:
        delta += 1            // mid-measure: first "-" snaps to the head of the current measure (consumes one step)
    idx = clamp(idx + delta, 0, measureTimes.length - 1)
    return clamp(measureTimes[idx], 0, maxMs)
else:  // Second unit, or no measure list
    return clamp(currentMs + 500 * delta, 0, maxMs)
```
Notes: with Ctrl (delta=-10) mid-measure, delta becomes -9. "+" from mid-measure jumps to the NEXT measure head (idx+1), never snaps to the current head. If the target head exceeds `durationMs`, the result is `durationMs` (may not be a measure head). Mid-measure positions arise from Second-unit edits, `LoopEndMs = DurationMs`, or play-speed rescale. With `durationMs = 0` (no chart) everything clamps to 0.

`StepLoopEnd(currentEndMs, beginMs, delta, ...)` (TS:183-189):
```
v = StepLoopTime(currentEndMs, delta, ...)
if v <= beginMs:
    v = StepLoopTime(beginMs, +1, ...)          // one step AFTER the begin position
return (v > beginMs) ? v : currentEndMs          // still not after begin (song too short) → unchanged
```

`StepLoopBegin(currentBeginMs, endMs, delta, ...)` (TS:195-201):
```
v = StepLoopTime(currentBeginMs, delta, ...)
if v >= endMs:
    v = StepLoopTime(endMs, -1, ...)             // one step BEFORE the end position
return (v < endMs) ? v : currentBeginMs
```
Non-overlap rule: begin and end can never become equal via the menu; trying to cross stops one step on the other side of the partner. If even that is impossible the value is unchanged and the menu plays no sound (TM:380-381, 388-389). The range can still become invalid (e.g. play-speed rescale truncation, short charts, `DurationMs = 0`) → displayed as `ON (無効)` and the stage treats loop as off (PS:1569-1571).

### 4.7 `FormatLoopTime(timeMs, unit, measureTimes)` (TS:204-209)
```
if unit == Measure && measureTimes non-empty: return format("{0:000} 小節", MeasureIndexAt(measureTimes, timeMs))   // zero-padded 3 digits (4+ digits shown in full), 0-based, e.g. "000 小節", "012 小節"
else: return format("{0:0.0} s", timeMs / 1000f)                                                                    // one decimal (see §1.1 float rule), e.g. "0.0 s", "24.5 s", "123.4 s"
```

---

## 5. Visual layout (`Build`, TM:77-85, 179-222)

Coordinate system: virtual 1920×1080, top-left origin, y down (UF:49-51, 119-126: anchors/pivot (0,1), `anchoredPosition = (x, -y)`, `sizeDelta = (w, h)`). The panel is created as a new child appended last under the stage root → drawn on top of everything (semi-transparent overlay; DOC:169). Rows and labels are children of the panel, positioned relative to its top-left.

### 5.1 Frame
- Default rect: `x=1400, y=340, w=500, h=700` (TM:78).
- Override: if the stage prefab contains a `RectTransform` named `training_menu` (found by exact path or by name at **any depth**, UF:279-319) whose `rect.size` has `x > 100 && y > 100` (strict), use `GetTopLeftXY(slot)` (stage-space top-left, UF:367-381) and `rect.size` instead (TM:183-192). The slot itself is not drawn or reparented.
- Background: `Image` filling the frame, colour `rgba(0.04, 0.05, 0.09, 0.82)` ≈ `rgba(10, 13, 23, 0.82)`, no sprite (solid), `raycastTarget=false` (TM:194; UF:59-74).

### 5.2 Elements (positions relative to frame top-left; `w` = frame width, default 500)

| Element | x | y | width | height | font px | align | colour | text |
|---|---|---|---|---|---|---|---|---|
| Header | 16 | 10 | w−32 (=468) | 36 | 30 | middle-left | (0.6,0.9,1) = #99E6FF | `TRAINING` (Main) / `TRAINING - 自動演奏詳細` (AutoDetail) |
| State line | 16 | 52 | w−32 | 32 | 24 | middle-left | (1,0.85,0.4) = #FFD966 | `StateText` (§5.5) |
| Row i name (i=0..14) | 16 | 96 + i·36 | 300 | 32 | 25 | middle-left | §5.4 | `"> " + label` if selected, else `"   " + label` (3 ASCII spaces) |
| Row i value | 316 | 96 + i·36 | 168 | 32 | 25 | middle-right | §5.4 | value string |
| Footer | 16 | 96 + 15·36 + 6 = 642 | w−32 | 52 | 19 | upper-left | (0.7,0.7,0.7) = #B3B3B3 | `↑↓ 選択   ←→ 変更(Ctrl:x10)\nEnter 決定   Esc 終了` (3 ASCII spaces between groups, one `\n`) |

Constants: `RowTopY=96, RowPitch=36, RowHeight=32, NameX=16, NameW=300, ValueX=316, ValueW=168` (TM:79-80). Row rects: row 0 y=96..128, row 14 y=600..632. Footer bottom = 694 < 700. Value column right edge = 316+168 = 484 = w−16.

Text (UF:201-216): Unity builtin `LegacyRuntime.ttf` (fallback `Arial.ttf`, UF:15-27); `fontSize` in virtual px; horizontal and vertical overflow allowed (no wrapping/clipping); `raycastTarget=false`; default font style (normal), default line spacing 1, rich text on by default (no tags are used). All text colours are fully opaque (alpha 1).

### 5.3 Row visibility
15 row slots (`RowCount = MainCount = 15`, TM:75) are created; each frame `used = row < ItemCount`, and `SetActive(used)` is applied only when `activeSelf != used` (TM:412-422). On AutoDetail rows 12–14 disappear. No scrolling.

### 5.4 Row colours (TM:82-85, 424-431)

```
ColorSelected = (1.00, 0.95, 0.40)  = #FFF266
ColorNormal   = (0.92, 0.92, 0.92)  = #EBEBEB
ColorAction   = (0.60, 0.90, 1.00)  = #99E6FF
ColorDisabled = (0.55, 0.55, 0.55)  = #8C8C8C

c = selected ? Selected : (IsAction(row) ? Action : Normal)
if !selected && IsDisabled(row): c = Disabled
name.color = value.color = c
```
Precedence: Selected > Disabled > Action > Normal. E.g. 一時停止 in standby, unselected → grey (not cyan); selected → yellow.

### 5.5 State line text (PS:1668-1677; assigned every frame PS:1546)
```
if standby:
    if waiting: format("START IN {0:0.0}", max(0f, (waitUntilMs - nowMs) / 1000f))   // e.g. "START IN 0.7" (float rule §1.1)
    else: "STANDBY"
else: clock.IsPaused ? "PAUSED" : "PLAYING"
```
Shown in the State label directly under the header (y=52). `nowMs`/`waitUntilMs` are `GameTimer.NowMs` (real time).

`Refresh()` (TM:402-433) is a no-op when not built; otherwise it rewrites header, state, all row texts and colours. Called at the end of `Build` and every frame after input (PS:1547).

**[ADDED] Stage-level hints shown during training (outside the menu panel)**: the bottom hint line reads `TRAINING   ↑↓: select   ←→: change   Enter: decide   F1: AUTO   F11: HELP   Esc: quit` (PS:2644-2645). The F11 help lists: `↑ / ↓: メニューの項目を選ぶ`, `← / →: 設定を変える（Ctrl 併用で 10 段ずつ）`, `Enter: 決定（演奏開始・リスタート・一時停止・サブメニュー）`, `Esc: サブメニューから戻る／トレーニング終了（選曲へ）`, `F1: AUTO 切替（メニューの「自動演奏」と同じ）        F11: このヘルプ`, `待機中にパッドを叩くと音だけ鳴る（ウォーミングアップ）`, blank, `※ トレーニングの演奏は記録されません（records.json / score.ini とも更新しない）`, `※ トレーニングの設定は通常演奏とは別に保存されます` (PS:2657-2671). Training also hides `movie_frame`, the movie RawImages and the debug `Info` label (which sits at (36,948) 1848×120 and would overlap the menu) (PS:1496-1503, 6138-6139).

---

## 6. Decide/cancel keys

- Decide = `Key.Enter` OR `Key.NumpadEnter`, edge-triggered (TM:250). **Space and gamepad South are deliberately excluded** because Space is the default BD (bass drum) key and South may be bound to a pad; accepting them would fire a drum hit and a menu action simultaneously (TM:12-14, 249; DOC:47-52). `InputManager.DecidePressed` (IM:147-155, includes Space/South) is NOT used.
- Esc = `Key.Escape` edge only; gamepad East is NOT a cancel in training mode (the stage's `CancelPressed` check at PS:876-877 is only in the non-training branch). On AutoDetail → back to Main (cursor → 自動演奏詳細, cancel sound); on Main → cancel sound + `ECommand.Quit` (TM:253-264).
- Ctrl modifier: LeftCtrl or RightCtrl held (IM:129).
- Shortcuts outside the menu in training mode (PS:826-842): `F1` without Shift toggles `Training.AutoPlay` (evaluated *before* the menu each frame; `ShiftHeld` = LeftShift||RightShift, IM:126); `F11` toggles the help panel. F2/F5–F10 and the realtime ↑↓←→ adjustments are disabled in training mode (PS:828-829; DOC:174-175).

---

## 7. `ECommand` and stage integration

### 7.1 Enum (TM:27-38)
`None=0, StartStop=1, Restart=2, PauseResume=3, Quit=4`.

Returned from `HandleInput()`:
- `StartStop`: Enter on item 11 on Main.
- `Restart`: Enter on item 12 on Main.
- `PauseResume`: Enter on item 13 on Main — even when greyed (standby).
- `Quit`: Enter on item 14 on Main, OR Esc on Main (also Esc in the same frame as Enter-on-戻る, §3).
- `None`: everything else.

### 7.2 Stage-side consumption (PS:1520-1549) and per-frame order (PS:826-861)
```
OnUpdate (training branch):
  if F1 pressed && !Shift: Training.AutoPlay = !Training.AutoPlay          // PS:830-831
  UpdateTrainingMenu():                                                    // PS:1520-1549
    if standby && waiting && NowMs >= waitUntilMs: BeginPlaying()           // countdown check BEFORE input
    switch menu.HandleInput():
      StartStop:   standby ? StartTraining() : EnterStandby(false)         // stop keeps stats; next start resets
      Restart:     StartTraining()
      PauseResume: ToggleTrainingPause()                                    // NO-OP while standby (PS:1651-1652); else toggles clock pause + audio pause/resume
      Quit:        return 1  → stage returns 1 → song selection (PS:832-834); Refresh not run that frame
    menu.Playing = !standby            // false during the START IN countdown too
    menu.Paused  = !standby && clock.IsPaused
    menu.StateText = TrainingStateText()
    menu.Refresh()
  ApplyTrainingSettings()              // PS:1552-1572: copies AutoPlay/JudgeOffset/NoteOffset/ScrollSpeed/AutoLanes[0..10]; loop active only if Loop && LoopRangeValid
  SyncStandbyPosition()                // PS:1589-1598: while STANDBY (not waiting), if (Loop && LoopRangeValid ? max(0,LoopBeginMs) : 0) != current standby position → jump there (notes at that position become visible). Not during countdown/playing.
  if standby: freeze song time at _trainStartMs, process warm-up hits, render
  else if paused: render only
```
Because `Playing = !standby` and the countdown happens while still in standby, during `START IN x.x` item 11 still reads `演奏開始` and 一時停止 is grey; pressing 演奏開始 again restarts the countdown (and resets stats). Pressing 一時停止 in standby plays the decide sound but does nothing.

State transitions (PS:1604-1646): `EnterStandby(reset)`: standby=true, waiting=false, startMs = standby position, optional stats reset, jump (also un-pauses). `StartTraining()` = `EnterStandby(true)` + `BeginStartWait()`. `BeginStartWait()`: if not standby, startMs = max(0, SongMs); standby=true; waiting=true; `waitUntilMs = NowMs + max(0, StartWaitMs)`; stop chip sounds; resume clock if paused. With `StartWaitMs == 0` the countdown still exists for one frame (`START IN 0.0`) and `BeginPlaying` fires at the top of the next update. `BeginPlaying()`: standby=false, waiting=false, clock jumps to startMs, auto sounds resync. Loop wrap (PS:892-913): when `songMs > loopEnd`, jump to loopBegin, reset counts/combo/score, and **only if `StartWaitMs > 0`** enter `BeginStartWait` (so `START IN` also shows at each wrap; with 0 there is no wait). Song end in training → `EnterStandby(false)` (PS:929-932), no result screen.

Setup (PS:1480-1493, 586-600, 709-710): on stage entry `_playSpeed`, `_auto`, offsets, scroll speed and lanes are seeded from `Training`; `LoopBeginMs=0; LoopEndMs=max(0,DurationMs)`; `new TrainingMenu(g, settings)`; `SetChart(chart)`; `PlaySpeedStep = TrainingPlaySpeedStep`; `Build(root)`; hide movie/Info; `EnterStandby(true)`. Teardown (PS:1818-1831): resume+stop all audio, pitch reset to 1, `menu.Destroy()`, and `Config.Save()` in training mode.

`PlaySpeedStep(delta)` (PS:1682-1695 → 1225-1246, 1249-1286):
```
before = playSpeed
ChangePlaySpeed(delta):
  playSpeed = clamp(playSpeed + delta, 5, 40)         // delta may be ±10 with Ctrl
  k = (before/20.0) / (playSpeed/20.0)                 // == before / playSpeed (double)
  scale every chart time (notes, hidden, BGM/SE/cheer/movie/BGA events, BarLines, fill-ins, guitar/bass, BPM changes, DurationMs) by k with (int) truncation
  stage-internal _loopBeginMs/_loopEndMs scaled if != -1
  Training.PlaySpeed = playSpeed; chip pitch = playSpeed/20
  JumpInSong((int)(SongMs * k)); ShowStatus("PLAY SPEED x{0:0.00}")   // [CORRECTION] these run even when clamped (k = 1)
if playSpeed == before: return                          // at limit: no loop/measure rescale
Training.LoopBeginMs = (int)(LoopBeginMs * k); LoopEndMs likewise; trainStartMs likewise   // truncation toward zero
menu.SetChart(chart)                                    // rebuild measure list
```
The menu plays the cursor sound (subject to §3.2) regardless of whether the value changed.

---

## 8. Config.ini `[Training]` section (CI:689-712, 809-817, 1088-1094, 1133)

Read (`ApplyTraining`, CI:694-712). `TryGetRaw("Training", key, qualifiedOnly=false, out v)` looks up `"Training/<key>"` first, then the bare `<key>` (CI:435-443; `ParseLine` stores both forms, CI:423-427):
```
TrainingAutoPlay    → ParseBool
TrainingAutoLanes   → AutoLanesFromString
TrainingNoteOffset  → ParseInRange(-999, 999)
TrainingJudgeOffset → ParseInRange(-99, 99)
TrainingScrollSpeed → ParseInRange(1, 2000)
TrainingPlaySpeed   → ParseInRange(5, 40)
TrainingStartWait   → ParseInRange(0, 5000)
TrainingLoop        → ParseBool
TrainingLoopUnit    → (ELoopUnit) ParseInRange(0, 1)
then Training.Clamp()
```
`ParseBool(v, cur)` (CI:446-451): empty → cur; else `v[0] != '0' && !equalsIgnoreCase(v, "false")` (so `1`, `true`, `yes` → true; `0`, `false`, `0abc` → false). `ParseInRange(v, min, max, cur)` (CI:454-460): `int.TryParse` failure or out of range → keep `cur` (NOT clamped); `+5`, surrounding whitespace accepted by TryParse.

Write (`KnownKey` list order, CI:809-817): `TrainingAutoPlay` `0|1`, `TrainingAutoLanes` 11-char string, `TrainingNoteOffset`, `TrainingJudgeOffset`, `TrainingScrollSpeed`, `TrainingPlaySpeed`, `TrainingStartWait` (ms), `TrainingLoop` `0|1`, `TrainingLoopUnit` `0|1`, each written as `Key=Value` (CI:946). When the file is generated from scratch, `[Training]` follows `[AutoPlay]` preceded by these comment lines (CI:1088-1093): `; トレーニングモード専用設定（本アプリ独自。通常演奏の設定とは独立）`, `; TrainingScrollSpeed: ハイスピード（表示倍率 = 値 x 0.5）/ TrainingPlaySpeed: 演奏速度（値/20 が倍率）`, `; TrainingNoteOffset: ノーツ表示調整 ms（判定は動かさない）/ TrainingJudgeOffset: 判定タイミング調整 ms`, `; TrainingStartWait: 演奏開始・ループ折り返しの待ち時間 ms（0〜5000、100 刻み）`, `; TrainingLoopUnit: ループ位置の単位（0=小節, 1=秒）。ループ位置自体は譜面ごとなので保存しない`. When updating an existing file, known keys are replaced in place and any missing ones are appended as a blank line + `[Training]` + `Key=Value` lines (CI:951-963, 1133). File is UTF-8 with BOM (CI:1137-1139). Loop begin/end are never saved. The `TrainingMode` on/off flag (F4 in song select) is session-only (DOC:179).

`ConfigIni.AutoLanes` (normal play) for reference: `AutoLaneKeys = {LC,HH,LP,SD,HT,BD,LT,FT,CY,RD,LBD}`, count 11, LBD index 10 (CI:216-223); normal-play values live in `[AutoPlay]` as `LC=0/1` … `LBD=0/1` with `qualifiedOnly=true` (CI:668-675, 778-779). Training lanes use the same index order but are stored as the single 11-char string.

---

## 9. Edge cases checklist
- Both Enter and Esc in one frame on Main: Decide runs (sound + side effects) then Esc sets cmd=Quit (TM:250-264).
- Enter on 戻る + Esc in one frame → quits (BackToMain first, then Esc sees Main).
- Holding ← on ループ終了位置 when it cannot move: no value change, no sound request each repeat.
- Holding → on ノーツ表示調整 at +999: no change but a cursor-sound request every fire (intended: ≥60 ms throttle; actual source: silent, §3.2).
- AutoDetail "すべて" with 9 AUTO + 1 manual → all AUTO; with 10 AUTO → all manual.
- Measure-unit stepping when the target measure head > DurationMs: result clamped to DurationMs (may not be a head).
- Second-unit at 0 ms with ← on 開始位置: stays 0 → unchanged → no sound.
- 終了位置 with ← when begin=0 and end is at measure 1 head: v = head 0 = begin → retry from begin +1 = head 1 = current → unchanged, no sound.
- Cursor is preserved across frames, reset to 0 on submenu open and to 1 on submenu close; never reset by state changes (start/stop/pause).
- `Refresh()` writes texts every frame; rows keep their objects, only `activeSelf` toggles.
- Editing ループ開始位置 or toggling ループ演奏 while `STANDBY` (not counting down) moves the displayed chart position (PS:1589-1598); not during `START IN`, `PLAYING`, `PAUSED`.
- `PauseResume` in standby: decide sound, no effect.
- Play-speed at a limit: chart re-jump + `PLAY SPEED x…` status still shown; loop positions/measure list untouched.
- Menu not built (`_root == null`): `HandleInput` returns None without touching repeat counters; `Refresh` no-op.

## Key facts

- Main menu order (idx 0-14): 自動演奏, 自動演奏詳細, ノーツ表示調整, 判定タイミング調整, ハイスピード, 演奏速度, 開始待ち時間, ループ演奏, ループ位置単位, ループ終了位置, ループ開始位置, 演奏開始/演奏停止, リスタート, 一時停止/再開, トレーニング終了 (TrainingMenu.cs:43-65); initial page Main, cursor 0, Playing=false, Paused=false, StateText="" (TrainingMenu.cs:97-110)
- AutoDetail submenu (12 items): LC,HH,LP,SD,HT,BD,LT,FT,CY,RD, すべて, 戻る; lane values 'AUTO'/'手動'; header 'TRAINING - 自動演奏詳細'; LBD (index 10) never shown or touched by the menu but read by the stage (TrainingMenu.cs:69-72, 408, 479; PerformanceStage.cs:1565)
- Value formats: '{0:+0;-0;0} ms' (+12 ms / -5 ms / 0 ms); 'x{0:0.0}' of ScrollSpeed*0.5; 'x{0:0.00}' of PlaySpeed/20; '{0:0.0} s' of StartWaitMs/1000; Loop: OFF / ON / 'ON (無効)'; unit: 小節/秒; loop pos: '{0:000} 小節' (0-based index into measure list) or '{0:0.0} s' (with space); summary なし / 'N レーン' / すべて (TrainingMenu.cs:484-509, TrainingSettings.cs:207-208)
- Float formatting: operands are single-precision; .NET rounds on a 7-significant-digit decimal string, half away from zero (950 ms → '1.0', JS toFixed → '0.9'); emulate with toPrecision(7) then half-away-from-zero rounding — matters for START IN and second-unit loop positions after a play-speed rescale
- Step = Ctrl held ? 10 : 1 for ←/→ (LeftCtrl||RightCtrl); Enter on value items always ChangeValue(+1); Mathf.Clamp everywhere (no wrap); cursor wraps modulo item count; toggles ignore sign/magnitude; ←/→ on 自動演奏詳細 and on action items do nothing (TrainingMenu.cs:134-152, 297, 316-397)
- Ranges/defaults: NoteOffset 0 [-999,999]; JudgeOffset 0 [-99,99]; ScrollSpeed 2 [1,2000]; PlaySpeed 20 [5,40]; StartWaitMs 1000 [0,5000] step 100; Loop false; LoopUnit Measure(0)/Second(1); LoopSecondStepMs=500; LoopRangeValid = End > Begin; LoopBegin=0 / LoopEnd=max(0,DurationMs) at stage entry, never saved (TrainingSettings.cs:31-84; PerformanceStage.cs:1483-1484)
- Key repeat (Counter.RepeatKey): fire immediately on press → next fire on first frame with elapsed > 200 ms → then on every frame with > 30 ms since the previous fire (strict >, stamp reset each fire, no catch-up; ≈33.3 ms at 60 fps); release resets; real-time Stopwatch clock; one counter per arrow key evaluated Up, Down, Left, Right before Enter/Esc (Counter.cs:100-138, TrainingMenu.cs:243-251)
- BUG: PlayCursorThrottled initialises last=long.MinValue and tests now-last<60; the subtraction overflows negative in unchecked C#, so the cursor sound never plays in the source; intended behaviour (comments/docs) is a 60 ms throttle — the port should implement the intent (TrainingMenu.cs:117-118, 155-162; docs 19:151)
- Sounds: PlayDecide (open submenu, StartStop, Restart, Pause), PlayCancel (back from submenu, Quit via Enter or Esc; falls back to cursor clip), PlayCursor (moves/changes, throttled); all via a dedicated AudioSource PlayOneShot — overlapping allowed, not pitch-shifted, not paused (SoundManager.cs:17-19, 341-349, 368)
- Decide keys: Enter or NumpadEnter only (Space = default BD key, gamepad South may be a drum); Esc (keyboard only; gamepad East ignored in training): submenu→Main with cursor=1 + cancel sound, Main→ECommand.Quit + cancel sound; Esc overrides Decide's command in the same frame (TrainingMenu.cs:250-264)
- ECommand: None=0, StartStop=1, Restart=2, PauseResume=3, Quit=4; PauseResume is returned even when greyed and the stage ignores it in standby; Playing = !standby so during START IN countdown item 11 still reads 演奏開始 and 一時停止 is grey (TrainingMenu.cs:27-38; PerformanceStage.cs:1528-1546, 1649-1652)
- StepLoopTime measure mode: idx=MeasureIndexAt; if delta<0 && mid-measure then delta+=1 (snap to current head first); idx=clamp(idx+delta,0,n-1); result clamp(times[idx],0,max(0,duration)). Second mode: clamp(cur+500*delta,0,duration). StepLoopEnd: v=step(end); if v<=begin then v=step(begin,+1); return v>begin ? v : end. StepLoopBegin: v=step(begin); if v>=end then v=step(end,-1); return v<end ? v : begin. Unchanged result → no value change and no sound (TrainingSettings.cs:164-201, TrainingMenu.cs:379-391)
- BuildMeasureTimes: [0] + each non-beat BarLine.TimeMs strictly greater than previous (BarLines pre-sorted; Visible ignored); never empty; rebuilt via SetChart after every effective play-speed change because BarLines and DurationMs are rescaled (TrainingSettings.cs:125-141; PerformanceStage.cs:1258, 1282, 1694)
- Layout: frame (1400,340) 500x700 in 1920x1080 (prefab 'training_menu' at any depth overrides if size strictly >100x100); bg rgba(0.04,0.05,0.09,0.82); header 'TRAINING' 30px at (16,10,468,36) #99E6FF; state line 24px at (16,52,468,32) #FFD966; rows 25px at y=96+i*36 h=32, name x=16 w=300 left, value x=316 w=168 right; footer 19px upper-left at (16,642,468,52) #B3B3B3 text '↑↓ 選択   ←→ 変更(Ctrl:x10)\nEnter 決定   Esc 終了'; rows ≥ ItemCount hidden (TrainingMenu.cs:78-85, 194-219, 412-422)
- Row colours: Selected #FFF266 > Disabled #8C8C8C > Action #99E6FF > Normal #EBEBEB; selected name prefixed '> ', others 3 spaces; disabled = loop unit/end/begin when Loop OFF, 一時停止 when !Playing; disabled only affects colour when unselected, still editable (TrainingMenu.cs:82-85, 424-459)
- State text: 'STANDBY' | 'START IN {0:0.0}' (max(0, remaining)/1000f) | 'PLAYING' | 'PAUSED'; countdown ends at the top of UpdateTrainingMenu before input; StartWaitMs=0 still shows START IN 0.0 for one frame; loop wrap re-enters START IN only when StartWaitMs>0; song end → STANDBY (PerformanceStage.cs:1525-1526, 1623-1637, 1668-1677, 907-913, 929-932)
- Play speed: menu calls PlaySpeedStep(delta); stage clamps to [5,40], scales all chart times by k=old/new with int truncation, always re-jumps and shows status 'PLAY SPEED x{0:0.00}' (even at the limit); only if changed: rescales LoopBegin/End/startMs by k (truncation) and rebuilds the measure list; menu requests the cursor sound regardless (PerformanceStage.cs:1225-1246, 1682-1695)
- Per-frame stage order in training: F1 toggles AutoPlay → UpdateTrainingMenu (countdown check → HandleInput → dispatch → Playing/Paused/StateText → Refresh) → ApplyTrainingSettings → SyncStandbyPosition (STANDBY only: jump to Loop&&Valid ? LoopBegin : 0) (PerformanceStage.cs:826-861, 1589-1598)
- Clamp() (config load only): StartWaitMs = clamp then (v/100)*100 truncation; invalid LoopUnit → Measure (TrainingSettings.cs:87-97)
- Config [Training] keys in order: TrainingAutoPlay(0/1), TrainingAutoLanes(11 chars '0'/'1', order LC,HH,LP,SD,HT,BD,LT,FT,CY,RD,LBD), TrainingNoteOffset, TrainingJudgeOffset, TrainingScrollSpeed, TrainingPlaySpeed, TrainingStartWait, TrainingLoop(0/1), TrainingLoopUnit(0/1); lookup 'Training/Key' then bare 'Key'; out-of-range/unparsable keep current (not clamped); ParseBool = v[0]!='0' && v!='false'; saved on leaving the performance stage in training mode, on Config screen exit, and on app quit (ConfigIni.cs:435-460, 694-712, 809-817; PerformanceStage.cs:1830-1831)
- AutoLanesFromString: any char != '0' is true; reads min(11, len) leading chars; null/empty → no change (TrainingSettings.cs:109-115)
- すべて: if all 10 lanes AUTO → set all manual, else set all AUTO; Enter or ←/→ both toggle (TrainingMenu.cs:325-333)

## Open questions

- Cursor-sound throttle: the source as written never plays the cursor sound (signed-overflow bug at TrainingMenu.cs:118/158). Should the port reproduce the silence (bit-for-bit parity) or the documented intent (60 ms throttle)? This spec recommends the intent.
- Float display rounding: .NET formats float operands via 7 significant digits then half-away-from-zero; JS toFixed differs on values like 0.95 or 12.35. The spec gives an emulation; confirm whether exact parity of 'START IN x.x' and second-unit loop positions after rescale is required.
- Whether the browser port should keep the doc's space-less strings ('012小節'/'24.5s') or the code's spaced strings ('012 小節'/'24.5 s'); this spec follows the code.
- Whether the Space/South exclusion should also apply in a browser build where BD is not bound to Space — the original excludes them unconditionally.
- Prefab override 'training_menu' has no browser equivalent; the port presumably uses the default (1400,340,500,700) frame unless a configurable rect is desired.
- Font metrics: the original uses Unity's LegacyRuntime.ttf with overflow enabled; the browser font will differ in width, so whether the 300/168 px name/value columns need adjusting for CJK glyphs at 25 px should be verified visually.
