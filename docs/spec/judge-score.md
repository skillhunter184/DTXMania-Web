# judge-score

# DTXManiaAI PerformanceStage (Drums) — Hit Judgment / Scoring / Autoplay / Feedback Spec (REVIEWED + MERGED)

All paths under `DTXManiaAI\Assets\Scripts\`. `PS` = `Stages/PerformanceStage.cs` (6178 lines). Stage virtual resolution 1920×1080 (`Core/UIFactory.cs:50-51`); NX-derived constants are 720p values × `S = 1.5` (`Stages/NxPerfLayout.cs:17`). Lane indices: `0=LC 1=HH 2=LP 3=SD 4=HT 5=BD 6=LT 7=FT 8=CY 9=RD` (`Song/DtxChart.cs:77-93`). `EJudge { Perfect=0, Great=1, Good=2, Ok=3, Miss=4 }` (PS:31). "Ok" = NX "Poor" (combo-breaking).

Legend: **[FIX]** = colleague's spec was wrong; **[ADD]** = missing; **[LINE]** = line-number corrections. Unmarked = verified as-is.

---

## 0. Data model (Song/DtxChart.cs)

- `Note { int TimeMs; int Lane; string WavId; int Channel; int Pos; bool Bonus }` (DtxChart.cs:23-31). `Channel` = visible channel; hidden chips normalized to 0x11–0x1C (DtxChart.cs:536-541).
- Channel→lane (DtxChart.cs:77-91): `0x1A→0 LC | 0x11→1 HH(close) | 0x18→1 HH(open "HHO") | 0x1B→2 LP | 0x1C→2 LBD | 0x12→3 SD | 0x14→4 HT | 0x13→5 BD | 0x15→6 LT | 0x17→7 FT | 0x16→8 CY | 0x19→9 RD`.
- Hidden chips = channels `0x31..0x3C` (= visible+0x20) → `HiddenNotes` list; NOT in `Notes`; not counted in TotalNotes; do not extend `DurationMs` (DtxChart.cs:112, 186-188, 536-551).
- Bonus chips: channels `0x4C..0x4F`; `BonusChipCount++` unconditionally per bonus chip (even if it marks nothing); base36 value 1..10 → lane `{1→LC,2→HH,3→LP,4→SD,5→HT,6→BD,7→LT,8→FT,9→CY,10→RD}`; every visible `Note` with same `Pos` and that lane gets `Bonus=true` (DtxChart.cs:182-183, 484-491, 556-560).
- `Notes`, `HiddenNotes` sorted ascending by `TimeMs` (stable sort not guaranteed: `List.Sort` — DtxChart.cs:572-573). Every search loop relies on ascending order.
- **[ADD] Timing:** `TimeMs = round(currMs + 625·Δtick·barLen/bpm)` (DtxChart.cs:421-422); 384 ticks/measure; one empty leading measure (`basePos=(measure+1)*384`, DtxChart.cs:774). `LeadInMs = 0` (PS:44).
- `BarLine { TimeMs; IsBeat (true=0x51); Visible (0xC2 result); Measure }` (DtxChart.cs:54-60). **[ADD] Generation** (DtxChart.cs:669-719): bar line every 384 ticks from tick 0 through `endOfSong = ceil(maxPos/384)*384` inclusive; per measure beat lines at `tickBeat=(int)(384·i/(4·barLen))` for i=0.. until `tickBeat+shift ≥ 384`, skipping positions where `(tickBeat+shift)%384==0`; `shift` = in-measure tick position of the last 0xC1 chip in that measure; `barLen` = last 0x02 at/before that measure. 0xC2 value 1=show/2=hide applies to generated lines from that chip onward and retroactively to same-position lines (DtxChart.cs:725-751). Directly written 0x50/0x51 chips are always visible.
- `WavVolumes[id]` = `#VOLUMExx` clamped 0..100; `WavPans[id]` = `#PANxx` clamped −100..100; ids upper-cased (DtxChart.cs:364-383).
- `DurationMs` = max TimeMs over visible drum chips + GB chips (DtxChart.cs:499,506,549); `HasNotes = Notes.Count>0` (237).
- `MergeRideToCymbal` (ConfigIni.cs:196; Config key `MergeRide`): at stage start all lane-9 notes (visible+hidden) → lane 8 / channel 0x16 (DtxChart.cs:246-263; PS:644-645), before `_judged[]` arrays are built.

---

## 1. Pad press → chip search → judgment (manual mode, `_auto == false`) — PS:2106-2228

### 1.1 Windows (Core/HitRanges.cs)
```
HitRanges { PerfectMs, GreatMs, GoodMs, OkMs }  // inclusive ±ms
Default = 34/67/84/117                            // HitRanges.cs:28
Judge(abs): abs<=P→0; abs<=G→1; abs<=Gd→2; abs<=Ok→3; else 4   // HitRanges.cs:49-56 (first window that contains |dt|, even if misordered)
SearchWindowMs = max(P,G,Gd,Ok)                   // HitRanges.cs:59-69 (default 117)
```
Config: `[HitRange]` keys `DrumPerfect/DrumGreat/DrumGood/DrumPoor`, `DrumPedalPerfect/...Poor`; legacy un-prefixed `Perfect/Great/Good/Poor` are composed into all sets first, then prefixed keys override; each value 0..999, out-of-range/unparseable → keep current (ConfigIni.cs:206-210, 628-664). Pedal set applies iff `note.Channel ∈ {0x13, 0x1B, 0x1C}` (`RangesFor`, PS:2255-2258). Global `_searchWindowMs = max(drum.SearchWindowMs, pedal.SearchWindowMs)` (PS:610). Hidden chips always use `HitRanges.Default` regardless of config (PS:2267-2288).

### 1.2 Judge offset
```
inputMs = songMs + JudgeOffsetMs      // PS:2148; JudgeOffsetMs ∈ [-99,+99] (ConfigIni.cs:47, 491-496; PS:1036)
lagMs   = inputMs - chip.TimeMs       // PS:2185; negative = early, positive = late (PS:2771 doc)
```
Effect: a POSITIVE offset makes every hit register LATER (lag grows by +offset); a player who consistently hits early adds a positive value. (The ConfigIni.cs:46 doc-comment wording "正の値=入力を早めに扱う" is ambiguous; the formula above is authoritative.) In-play: `←` = −10 ms, `→` = +10 ms, with Ctrl ±1 ms (PS:1012-1019, 1034-1042); not accepted while paused; written back to Config (training mode: to `Training.JudgeOffsetMs`); status text `"INPUT ADJUST {0:+0;-0;0} ms"` (PS:1041). Training-mode `NoteOffsetMs` (±999) shifts DRAW time only, never judgment (PS:3195).

### 1.3 Grouping (Core/DrumGroups.cs)
Effective groups at stage entry: Config `HHGroup(0..3) FTGroup(0..1) CYGroup(0..1) BDGroup(0..3)` (defaults 0; ConfigIni.cs:184-199, 527-552), then `ApplyChartDowngrade(hasLC, hasRD)` over VISIBLE notes: no LC chip && hh∈{0,2} → hh=3; no RD chip && cy==0 → cy=1 (DrumGroups.cs:26-32; PS:670-680).
```
SearchLanes(pad):                       // DrumGroups.cs:40-63 — ARRAY ORDER MATTERS
  LC(0): (hh==1||hh==3) ? [HH, LC] : [LC]
  HH(1): (hh==1||hh==3) ? [HH, LC] : [HH]
  LP(2): bd==3 ? [LP, BD] : [LP]
  BD(5): (bd==1||bd==3) ? [BD, LP] : [BD]   // bd==1: LP lane restricted to channel 0x1C chips (PS:2156,2162)
  LT(6): ft==1 ? [LT, FT] : [LT]
  FT(7): ft==1 ? [FT, LT] : [FT]
  CY(8): cy==1 ? [CY, RD] : [CY]
  RD(9): cy==1 ? [CY, RD] : [RD]            // note: CY first even for RD pad
  SD(3)/HT(4): [pad]
TieHitsAll(pad) = pad ∉ {0, 8, 9}       // DrumGroups.cs:70-73
```
**[ADD] Consequence of tie order:** with CYGroup=1 and simultaneous CY+RD chips, BOTH the CY pad and the RD pad resolve to the CY chip (earliest-time tie → first array element), and TieHitsAll is false for pads 8/9, so the RD chip needs a second press. Same for LC pad on simultaneous HH+LC (→ HH chip; LC chip needs another press). HH pad (TieHitsAll true) hits both.

### 1.4 Per-frame pad algorithm (PS:2149-2218)
Edge detection: keyboard `wasPressedThisFrame`, gamepad `wasPressedThisFrame`, MIDI edge from polled snapshot with velocity > threshold (Input/InputManager.cs:58-62, 73-77, 92-111); `PressedAny(bindings[pad], velocityMin[pad])`. Pads processed in index order 0..9; each sees the `_judged[]` results of earlier pads in the same frame.
```
for pad in 0..9: if !PressedAny(pad): continue
  lanes = SearchLanes(pad); lbdOnlyLane = (pad==5 && bd==1) ? 2 : -1
  best=-1; bestAbs=0; bestHidden=-1; bestHiddenAbs=0
  for lane in lanes:
    filter = (lane==lbdOnlyLane) ? 0x1C : 0
    idx  = FindNearestNote(lane, inputMs, out abs, filter)
    hidx = FindNearestHiddenNote(lane, inputMs, out habs, filter)
    if hidx>=0 && (idx<0 || habs < abs):          // hidden strictly nearer → this lane contributes ONLY the hidden candidate
        if bestHidden<0 || hidden[hidx].TimeMs < hidden[bestHidden].TimeMs: bestHidden=hidx; bestHiddenAbs=habs
        continue
    if idx<0: continue
    if best<0 || notes[idx].TimeMs < notes[best].TimeMs: best=idx; bestAbs=abs   // ACROSS lanes: EARLIEST TimeMs wins (not nearest); tie → first lane in array
  if bestHidden>=0 && (best<0 || hidden[bestHidden].TimeMs < notes[best].TimeMs):  // strict: on equal time visible wins
      HitHiddenNote(bestHidden, bestHiddenAbs)                                     // §8
  elif best>=0:
      hitTime=notes[best].TimeMs; hitLane=notes[best].Lane
      Judge(best, RangesFor(notes[best].Channel).Judge(bestAbs), inputMs - hitTime)
      if TieHitsAll(pad):                                                          // PS:2186-2202
          for lane in lanes where lane != hitLane:
              idx = FindNearestNote(lane, inputMs, out abs, filter); if idx>=0 && notes[idx].TimeMs==hitTime: Judge(idx, RangesFor.Judge(abs), inputMs-hitTime)
              hidx = FindNearestHiddenNote(...);                       if hidx>=0 && hidden[hidx].TimeMs==hitTime: HitHiddenNote(hidx, habs)
  else: EMPTY HIT (§1.6)
```
`FindNearestNote(lane, inputMs, filter)` (PS:2232-2251):
```
best=-1; bestAbs=INT_MAX
for i in 0..Notes.Count-1:
  if judged[i] || Lane!=lane: continue
  if filter!=0 && Channel!=filter: continue
  dt = TimeMs - inputMs
  if dt > _searchWindowMs: break              // global max window (both sets)
  abs=|dt|
  if abs <= RangesFor(Channel).SearchWindowMs && abs < bestAbs: best=i; bestAbs=abs   // strict < → equal |dt| keeps the EARLIER chip
```
`FindNearestHiddenNote` identical over `HiddenNotes`/`_hiddenJudged` with fixed window 117 (`HitRanges.Default.SearchWindowMs`, PS:2267-2285). Future chips beyond the window are never grabbed. **[ADD]** Chips on a per-lane-AUTO lane are NOT excluded from manual search: a press within the window BEFORE the chip's time judges it manually via `Judge` (AutoJudge only fires once `songMs ≥ TimeMs`). **[ADD]** While `_auto == true`, pad presses do nothing at all (no sound, no flash) — the manual branch is skipped entirely (PS:2134-2143).

### 1.5 `Judge(noteIndex, j, lagMs=0)` (PS:2772-2846) — manual hits, misses, all-lanes AUTO
```
judged[i]=true; counts[j]++; countsIncAuto[j]++; lastJudge=j; judgeDisplay=0.5 (s)   // counts incremented BEFORE score calc
StartJudgeString(note.Lane, j, lagMs, isAuto=_auto)                                   // §6.2
if !_auto: (lagMs > 0) ? lateCount++ : earlyCount++     // lag 0 and negative → early; Miss (lag>0) → late
if j != Miss:
    laneFlash[lane]=0.12; StartLaneEffects(lane)         // flush + pad anim on the CHIP's lane (PS:3367-3372: flushStartMs=padHitMs=Now)
    PlayHit(note)                                        // ChipVolume even in AUTO mode (auto param defaults false) (§8)
    if j != Ok: StartChipFire(lane)                      // fire/stars/debris for P/G/Gd only; Ok = sound+flash+pad, no fire
    if j != Ok && inFillIn: StartFillInEffects(lane, IsLastChipOfFillIn(i))
switch j:
  P/G/Gd: combo++
          if note.Bonus && j != Good: score += 500 (no clamp yet); StartBonusEffect()   // BEFORE ScoreDelta
          score += ScoreDelta(j, combo /*incl. this chip*/, counts[0] /*incl. this chip*/, TotalNotes, score, BonusChipCount)
          clamp score to [0, 9999999]
  Ok/Miss: combo=0; clear comboBombFired[], comboHundredReached[]
maxCombo=max(maxCombo, combo)
if j in {P,G,Gd}: comboJumpMs=Now; pgSectionHits[NxSectionOf(TimeMs)]++   // 64-section NX bar
if j in {Ok,Miss}: MarkSectionMiss(TimeMs)                                 // 60-section lamps: sec=TimeMs*60/DurationMs clamped (PS:1789-1796; ScoreRecord.cs:14)
gauge += GaugeDeltaFor(j); gauge=min(gauge,1.0)                            // no lower clamp
if IsFailed() && state==Playing && !trainingMode && Config.StageFailedEnabled: EnterState(Failing,"STAGE FAILED",rgb(1,0.35,0.35))   // PS:2844-2845
```

### 1.6 Empty hit (no candidate in window) (PS:2204-2217)
- `laneFlash[pad]=0.12; StartLaneEffects(pad)` → flash/flush + pad animation on the PAD's lane (on a real hit the effects go to the CHIP's lane instead).
- No judgment string, no score/combo/gauge/count change, no fire, no early/late count.
- Sound ("空打ち" borrow): `borrow = FindNearestAnyNote(pad, lanes, inputMs)` (PS:2305-2342): pad's own lane first, then remaining `SearchLanes` in order; per lane `NearestInList(Notes)` then `NearestInList(HiddenNotes)` sharing one `bestAbs` (strict `<`), judged-or-not, any distance; **[FIX] tie → VISIBLE chip wins** (hidden replaces only if strictly nearer: PS:2323-2326, 2338). If found → `PlayHit(borrow)` (its WAV, #VOLUME/#PAN, ChipVolume). If no chip at all on those lanes → `Sound.Play(Fallback(pad), ChipVol)`; `Fallback` = built-in kit clip `StreamingAssets/System/Sounds/Drums/{LeftCrash,HiHat_Close,HiHat_Foot,Snare,Tom1,Bass,Tom2,Tom3,RightCrash,Ride}.wav` per lane (Core/GameMain.cs:63-71, 206-215), else `DrumSynth` tone (PS:2094-2102).
- Same borrow logic for training standby warm-up hits but keyed on `songMs` (no offset) (PS:1703-1718).

---

## 2. Miss detection (PS:2220-2226) — every frame after pad processing, manual mode only
```
for every note i (no break): if judged[i] continue
  if inputMs - notes[i].TimeMs > RangesFor(notes[i].Channel).SearchWindowMs: Judge(i, Miss, inputMs - notes[i].TimeMs)
```
Threshold = chip's own set max window (default 117), strictly greater, vs offset-adjusted `inputMs`. Effects via `Judge`: `counts[4]++`, `countsIncAuto[4]++`, per-lane "MISS" sprite on the chip's lane, center text "MISS" (CUSTOM), `lateCount++`, combo=0, bomb flags cleared, section 'B', `gauge += −0.041×DamageLevelFactor`, fail check. No sound/flash/pad/fire. The chip disappears the frame it is judged (renderers skip `judged[i]`: PS:2991, 3038), i.e. an unhit chip scrolls ~117 ms past the line (≈79 px at default speed) then vanishes. Hidden chips never Miss: consumed silently when `hidden[i].TimeMs < songMs` (strict, uses songMs not inputMs; PS:2113-2118). `ProcessJudgement` is not called while paused, in training standby, or in Clearing/Failing (PS:797-824, 846-860, 883-887). **[ADD]** `JumpInSong(t)` sets `judged[i] = TimeMs < t` for all notes/hidden — chips skipped by fast-forward are silently marked judged (no Miss), chips after a rewind become hittable again; score/combo/counts/gauge untouched (PS:1304-1313).

---

## 3. Autoplay

### 3.1 All-lanes AUTO (`_auto`; F1 toggles when Shift not held; initial `Config.AutoPlay` default true — ConfigIni.cs:41; PS:560, 872-873; training mode uses `Training.AutoPlay`, PS:592, 830-831, 1554)
```
for every note i (no break): if !judged[i] && songMs >= TimeMs: Judge(i, Perfect)   // lagMs=0 (PS:2134-2142)
```
Fires on the first frame `songMs ≥ TimeMs`, through the normal `Judge` path: `counts[0]++`, combo/score/gauge advance, bonus +500, sound at ChipVolume (`PlayHit(note)`), fire/stars, `judgeDisplay=0.5` → CUSTOM center text "PERFECT". Per-lane sprite: NX sheet column 5 (AUTO) / NX classic AUTO sprite (`ScreenPlay judge strings 3.png` (0,0,128,42)) / CUSTOM Perfect sprite (PS:3492-3503, 3680). No lag digits. Early/Late not counted. `_autoUsed` sticks true once AUTO was on at any moment (PS:652, 874-875; reset to `_auto` on Restart PS:1188) → result `Auto=true` → not recordable (PerformanceResult.cs:149-154). Hidden chips are NOT auto-played (consumed silently). Per-lane AUTO loop is skipped while `_auto` (PS:2122).

### 3.2 Per-lane AUTO (`Config.AutoLanes[0..9]`, `[AutoPlay] LC,HH,LP,SD,HT,BD,LT,FT,CY,RD,LBD`; ConfigIni.cs:216-223, 668-675; PS:2122-2131, 2720-2769), only when `!_auto`
```
for i in time order: if judged[i] continue; if songMs < TimeMs break; if laneAuto[Lane]: AutoJudge(i)
AutoJudge(i):
  judged[i]=true; countsIncAuto[0]++          // NOT counts[] → achievement rate & score_detailed exclude it; no lastJudge/judgeDisplay
  pgSectionHits[section]++
  StartJudgeString(lane, Perfect, 0, isAuto=true)   // AUTO sprite (Perfect sprite in CUSTOM); no lag digits
  laneFlash=0.12; StartLaneEffects(lane); PlayHit(note, auto:true)   // AutoChipVolume (default 80)
  StartChipFire(lane); if inFillIn: StartFillInEffects(lane, IsLastChipOfFillIn(i))
  if note.Bonus: StartBonusEffect(); if (!allLanesAuto || autoAddGage): score += 500 (clamp ≤ 9999999)
  if allLanesAuto: combo++; maxCombo=max; comboJumpMs=Now          // else combo neither grows nor breaks
  if autoAddGage (Config `AutoAddGage`, default false): score += ScoreDelta(0, combo, countsIncAuto[0], Total, score, BonusChipCount); clamp [0,9999999]; gauge += 0.005; cap 1.0
```
`_allLanesAuto` = all 10 lane flags true (LBD flag ignored) (PS:611-613; training: 1559-1564). F11 help lists such lanes as `AUTO` (PS:2691).

### 3.3 LBD special case
LBD (0x1C) chips live in lane 2 (LP) and are auto-hit iff `AutoLanes[2]`. `AutoLanes[10]` ("LBD", `_lbdAuto`) affects ONLY the achievement-rate revise factor (§4.4) and score.ini flags, never judgment (PS:584, 599; DrumGroups.cs:11-13; PerformanceResult.cs:108, 116-121). BD pad with BDGroup=1 hits LBD chips only (filter 0x1C) in lane 2; BDGroup=3 hits any lane-2 chip; LP pad always hits both 0x1B and 0x1C.

---

## 4. Score / achievement / skill / rank

### 4.1 Per-chip score `ScoreDelta(judge, combo, perfectCount, totalNotes, currentScore, bonusChipCount)` (PerformanceResult.cs:161-182)
```
if total<=0 || judge∉{0,1,2}: return 0
if judge==0 && combo>=total && perfectCount>=total: return (int)(1000000f - currentScore)   // all-Perfect final chip → exactly 1,000,000 (bonus +500 already added is absorbed)
base = (1000000f - 500f*bonusChipCount) / (1275f + 50f*(total - 50f))     // float32
delta = judge==0 ? (combo<total ? base : 0f) : judge==1 ? base*0.5f : base*0.2f   // FC-but-not-all-Perfect final Perfect adds 0
if combo < 50: delta *= combo
elif combo != total && perfectCount != total: delta *= 50f
return (int)delta   // truncate toward zero
```
Inputs from `Judge`: `combo` and `perfectCount=counts[0]` both ALREADY include the current chip (PS:2775, 2805, 2813). AutoAddGage path uses `countsIncAuto[0]` (PS:2763). Small charts (total < ~25) can make `base` negative/huge → clamp [0, 9,999,999] (PS:2814-2816). Score/counts/combo/maxCombo/pgSectionHits/bomb flags reset on loop wrap (PS:892-905; gauge, countsIncAuto, sectionMiss NOT reset) and on Restart (`ResetPlayStats` PS:1197-1218 resets everything incl. gauge=2/3, countsIncAuto, sectionMiss).

### 4.2 Displayed score
- CUSTOM text: `"SCORE  " + score.ToString("D7")` (PS:3262).
- NX digits: count-up `_scoreDisp` (PS:3912-3930): every 10 ms of wall clock `disp += max(1,(score−disp)/20)` (≤200 steps/frame); if score < disp → snap down immediately; training (`_training`) shows 0 (PS:3742); 7 digit sprites, leading zeros hidden except ones digit (PS:3744-3756).

### 4.3 Achievement rate % (PerformanceResult.cs:87-98; live copy PS:5315-5325)
```
if Total<=0: 0
comboRate = allLanesAuto ? 0 : 100*maxCombo/Total
rate = (100*counts[0]/Total)*0.85 + (100*counts[1]/Total)*0.35 + comboRate*0.15
rate *= AutoLaneRevise(laneAuto, lbdAuto, allLanesAuto)      // recomputed every frame in-play
```
### 4.4 AutoLaneRevise (PerformanceResult.cs:110-123)
```
if laneAuto==null || allLanesAuto: 1.0
bd=laneAuto[5]; lp=laneAuto[2]
if bd && !lp && !lbdAuto: 0.5
if (!bd && lp) || lbdAuto: 0.5
if bd && lp && lbdAuto: 0.25   // unreachable (NX operator-precedence quirk reproduced)
else 1.0                        // (bd && lp && !lbdAuto → 1.0)
```
### 4.5 Skill: `LevelFactor(level, dec) = level>=100 ? level/100 : level/10 + dec/100`; `Skill = (Total<=0 || Auto || AllLanesAuto) ? 0 : Rate × LevelFactor × 0.2` (PerformanceResult.cs:127-141). NX status panel: rate as `##0.00` (`(int)(rate*100)`), `7_skill max` image when rate ≥ 100 (digits hidden, '%' hidden); GameSkill `gs100=(int)(rate·LevelFactor·0.2·100)` as `##0.00`; training shows rate 0 (PS:4006-4027).
### 4.6 Rank (result screen only): SS ≥95, S ≥80, A ≥73, B ≥63, C ≥53, D ≥45, else E; "-" if Total≤0 (PerformanceResult.cs:246-260).
### 4.7 Result (PS:1742-1775): `FullCombo = counts[3]==0 && counts[4]==0 && Total>0 && Σcounts>0`; `Cleared`; `SectionLamps` 60 chars 'Y'/'B'/'-' with section s resolved when `playedMaxMs > Duration*(s+1)/60 + searchWindow − judgeOffset` (PS:1801-1815); `IsRecordable = !Training && !Auto && !AllLanesAuto && (PlaySpeed==20 || SaveScoreIfModifiedPlaySpeed)`. `_training` becomes true on skip (F5/F6), loop set (F7), play-speed change, BGM adjust, or training mode; NOT on loop clear (F8) or speed change at limit (PS:1101-1145, 1054).

---

## 5. Life gauge (PS:492-505, 2853-2891)
```
GaugeMax=1.0; GaugeInitial=2/3; GaugeMin=-0.1 (fail); GaugeDanger=0.3
GaugeDelta = { Perfect +0.005, Great +0.001, Good 0.000, Ok -0.017, Miss -0.041 }
GaugeDeltaFor(j):
  if risky (Config Risky 1..10):
      if j ∉ {Ok,Miss}: return 0
      d = (riskyTimes == 1) ? 0.0 : -1.0/(riskyInitial-1)     // [FIX] zero on the LAST remaining life (riskyTimes==1), not "initial==1"
      if riskyTimes >= 0: riskyTimes--
      return d
  d = GaugeDelta[j]; if j==Miss: d *= DamageLevelFactor[clamp(DamageLevel,0,2)]   // {0.25 Easy, 0.5 Normal(default), 0.75 Hard} → Normal Miss = -0.0205; Ok NOT scaled
IsFailed  = risky ? riskyTimes<=0 : gauge <= -0.1
IsDanger  = risky ? (riskyInitial==1 ? false : riskyInitial<=3 ? riskyTimes<=1 : riskyTimes<=2) : gauge <= 0.3
```
No per-chip-count scaling. Upper clamp 1.0 only (PS:2841). AUTO-lane chips affect gauge only with AutoAddGage (+0.005). STAGE FAILED suppressed in training mode and when Config `StageFailed=0`: `if (IsFailed() && _state == EPlayState.Playing && !_trainingMode && _g.Config.StageFailedEnabled)` (PS:2844-2845; ConfigIni.cs:271-272, 600).
Failing (PS:1720-1740, 797-824): `Sound.StopAll()` (one-shots, pan pool, chip pool, preview, screen BGM; NOT the exclusive channel), failed image (`StageFailed` object; NX: L/R halves wipe in `x=640·cos(π/2·ct/100)`, ct=t/2 ms, then black fade 500 ms after 2000 ms) or CUSTOM banner "STAGE FAILED"; `Stage failed.ogg` (or `#SOUND_STAGEFAILED`) via `PlayExclusive` at `shown ≥ 200 ms` or on skip; → Result when `shown > limit` (CUSTOM 2200 / NX 2500) or `DecidePressed||CancelPressed` (**[ADD]** Decide = Enter/NumpadEnter/**Space**/Gamepad South; Cancel = Esc/Gamepad East — InputManager.cs:147-156, so the BD default key Space skips the wait).
Clear (PS:929-935, 797-824): when `HasNotes && songMs > DurationMs + 2000 && loopEnd == -1`; training mode → back to standby instead. CUSTOM banner `"STAGE CLEAR"` rgb(0.4,1,0.6) for 1500 ms; NX: nothing drawn for 2000 ms. **[ADD]** A chart with no notes never auto-clears (only Esc exits); it shows `"No playable drum notes in this chart.\n(Header-only or non-drum DTX)\nPress Esc to return."` (PS:4095-4100, 6153-6163).
Gauge display: NX `fillAmount=clamp01(gauge)`, full-bar image only when `gauge == 1.0` exactly (PS:3305-3317); CUSTOM vertical bar: danger → rgb(1,0.25,0.25) alpha `0.55+0.45|sin(8·Time.time)|`; gauge ≥ 0.5 → rgb(0.3,0.9,0.5); else rgb(0.95,0.8,0.25); height = clamp01(gauge)·H bottom-anchored (PS:3318-3330). **[ADD]** CUSTOM full-screen `Danger` overlay: enabled iff `IsDanger() && state==Playing`, alpha `0.25+0.35|sin(6·Time.time)|`; NX never draws it (PS:3898-3908, 4324-4326).

---

## 6. Judgment display & combo display

### 6.1 Center text (CUSTOM/fallback only; `Judge` Text, 54 px, anchored center (0,+180), size 600×90 — PS:6130-6135): `lastJudge.ToString().ToUpperInvariant()` = `"PERFECT"|"GREAT"|"GOOD"|"OK"|"MISS"` while `_judgeDisplay>0` (0.5 s, decremented by `Time.deltaTime`), color `JudgeColor`: Perfect (1,0.95,0.3), Great (0.4,1,0.5), Good (0.4,0.8,1), Ok (0.8,0.5,1), Miss (1,0.4,0.4) (PS:3264-3273, 4069-4079). Set by `Judge` only (incl. Miss and all-lanes AUTO), not by `AutoJudge`.

### 6.2 Per-lane judgment sprite `JudgeStr{i}` (PS:3485-3512, 3663-3734)
- Start: `judgeStrStartMs[lane]=Now; judge; isAuto; jitter=0`. Sprite: NX sheet → frame chosen per frame; NX classic & isAuto → AUTO sprite; else `JudgeTemplates/{Perfect,Great,Good,Ok|Poor,Miss}` sprite (AUTO in CUSTOM = Perfect sprite).
- Classic animation (t = wall ms since start, hidden when t>300): non-bad: `t<50: sx=1+(1−t/50), sy=t/50`; `50≤t<240: 1,1`; `t≥240: sy=1−(t−240)/60`. Bad: `t<50: sy=t/50`; `t≥200: sx=sy=1−(t−200)/100`. "bad" = Miss only in NX; Ok AND Miss in CUSTOM (PS:3699-3700). Scales clamped ≥0. NX classic vertical jitter for non-bad, 50≤t<130: when `t%6==0` → `rand(0..5)−3` px (×S), else previous value; 0 otherwise.
- NX sheet mode (`Graphics/7_judge strings.png`): 6 columns (Perfect,Great,Good,Poor,Miss,Auto) × 24 frames × 14 ms = 336 ms, cell 250×170 (×S), top-left at (cx−122·S, cy−87·S), no scaling (PS:3670-3689, 4488-4499, 4579-4590).
- NX position: cx from `JudgeStrCenterXByType[laneType]` (Type-A `{330,390,442,497,551,612,668,717,780,855}`×S); cy = `(348 + 32·row)·S`, row = `{−1,1,2,1,0,2,0,1,−1,1}`; reverse: `(348 − 32·row)·S` (NxPerfLayout.cs:77-89; PS:4505-4510, 2587-2591). CUSTOM: prefab position; reverse moves top to `judgeY + 23·S` (PS:2543-2551).
- Lag digits (`ShowLagTime` 1=all judgments, 2=non-Perfect; never for isAuto; needs `7_lag numbers.png`): text = `clamp(lag,−999,999).ToString()`; glyphs 15×19 (×S), pitch 15·S, centered on lane: `x0 = cx − len·15·S/2`; **[ADD]** color block chosen by leading '-' (`s[0]=='-'` → early glyphs), so lag 0 uses the LATE color although counted as early; TYPE-A early=blue block origin (0,0), late=red block origin (64,64); TYPE-B swapped. Classic placement: `top = cy_img − 21.5·S·sy + 34·S`; NX sheet: `top = cy − 53·S` (PS:3505-3511, 3684-3686, 5698-5791).

### 6.3 Combo
- CUSTOM text (`Combo`, 60 px, anchored center (−495,+90)): `combo >= 2 ? combo + "\nCOMBO" : ""` (PS:3263, 6123-6128).
- Sprite digits (`ComboDigit0..3` right-to-left, `ComboLabel`): NX visible iff `combo >= 10` (`NxMinComboDrums`, PS:379, 3764); CUSTOM prefab iff `combo > 0`; `v = min(combo, 9999)`; only `digits` of v drawn. Jump per P/G/Gd hit: `jump = −15·S·sin(π·jt/180)` for `0≤jt<180`, where CUSTOM `jt = now−comboJumpMs − d·10` (digit d delayed 10 ms), NX `idxAll=(elapsed/2)·3; jt = idxAll − (digits−d−1)`. NX beat bounce `+8·S` if `1+((now/interval)%16) ≤ 3` else `+2·S`, `interval = 60000/BPM/16` ms (PS:3781-3788). 100-combo emphasis (needs `_comboUnit>0`, i.e. prefab has ≥2 digit slots): while `combo > (combo/100)+100 && !hundredReached[combo/100] && 0≤idxAll<180`: scale `1.22 + 15·sin(π·idxAll/180)/180` (≤1.303) on digits (not 1000+ sprites) and label; pitch 114→134 (1000+: 90→110); label drops 10·unit while `combo≥100 && combo>hundred·100 && !reached`. 1000+ combos use `combo_2.png` 96×128 cells, pitch 90, y+20·unit (PS:3760-3831).
- Combo bomb (PS:3855-3881; needs `_comboUnit>0`): trigger when `combo > (combo/100) + 100 && !fired[combo/100]` (i.e., combo 102, 202, …); 14 frames × 20 ms of `7_combobomb.png` at (rightEdge−406u, y−190u) 540u×510u additive; drawn only while `combo ≥ 100`; on completion `hundredReached[combo/100]=true`. Both flag arrays cleared on Ok/Miss and loop wrap.

---

## 7. Panels

### 7.1 `score_detailed` (PS:191-205, 3341-3363, 4376-4388)
Text elements by name: `perfect_hits/perfect_rate, great_hits/great_rate, good_hits/good_rate, ok_hits/ok_rate (aliases poor_hits/poor_rate), miss_hits/miss_rate, max_combo_hits, max_combo_rate`.
```
total = Σ counts[0..4]                       // manual judgments only (AUTO-lane chips excluded)
*_hits = counts[i].ToString()
*_rate = total<=0 ? "0%" : RoundToInt(100f*counts[i]/total) + "%"   // Mathf.RoundToInt (banker's rounding on .5)
max_combo_hits = maxCombo; max_combo_rate = total<=0 ? "0%" : RoundToInt(100f*maxCombo/total)+"%"
```
NX status panel (PS:3981-4038, 4615-4675; rows `Perfect, Great, Good, Poor, Miss, MaxCombo`): count = `counts[k]` (k<5) / `maxCombo`, drawn as `{0,4:###0}` right-aligned (clamped 0..9999); rate = `round(100·cnt/totalIncAuto)` (`Math.Round`, denominator Σ`countsIncAuto`), 3 chars + '%' glyph; SkillValue `##0.00` (+'%' or `7_skill max`), GameSkill `##0.00`, Early/Late 4-digit counts (only if `ShowLagHitCount`), Level `LEVEL/10 + LEVELDEC/100` as `0.00`, difficulty cell fixed "DTX", name plates empty.

### 7.2 `song_info` (PS:4393-4421): `song_name` = `SelectedSong.Title`; `song_artist` = `SelectedScore.ArtistName`; `Jacket` sprite from `ImageLoader.LoadJacket` (always shown; hidden in CUSTOM if none; NX keeps default preimage). NX also `SongTitle`/`SongArtist` texts and jacket long side 245·S centered (1089.2,458.7)·S (PS:4529-4543).

### 7.3 CUSTOM `Info` line (PS:3289-3302):
`"{Title}\nPERFECT {p}  GREAT {g}  GOOD {gd}  OK {ok}  MISS {m}\nMaxCombo {mc} / Notes {total}   BPM {bpm:0.##}   [{mode}]"` + (`ShowLagHitCount` ? `"   EARLY {e} / LATE {l}"` : "") where mode = `"AUTO"` (`_auto`) | `"ALL LANES AUTO"` | `"AUTO LANES x{n}"` (n = Σ countsIncAuto − Σ counts, >0) | `"MANUAL"`; BPM = current BPM at songMs × PlaySpeedRatio (PS:2897-2913). Hidden in training mode.

### 7.4 Other user strings
- Hint (PS:2642-2647): `"F11: HELP (key assign)   F1: AUTO   Shift+F1: PAUSE   Esc: back"`; training: `"TRAINING   ↑↓: select   ←→: change   Enter: decide   F1: AUTO   F11: HELP   Esc: quit"`.
- Status (1500 ms; PS:1463-1467, 3276-3287): `"SCROLL x{0:0.0}"` (setting×0.5), `"INPUT ADJUST {0:+0;-0;0} ms"`, **[ADD]** `"BGM ADJUST {0:+0;-0;0} ms"` (cumulative), `"PLAY SPEED x{0:0.00}"`, `"RESTART"`, `"PAUSE"` (shown constantly while paused), `"SKIP >>"`, `"<< SKIP"`, `"LOOP BEGIN"`, `"LOOP END"`, `"LOOP CLEARED"`; suffix `"   [LOOP]"` (both points) / `"   [LOOP BEGIN]"` (begin only); `"   TRAINING"` when `_training`; idle speed (CUSTOM, PlaySpeed≠20, ShowPlaySpeed≠0) `"x{0:0.00}"`; NX `"Play Speed: x{0:0.000}"` (PS:4055-4067). Training menu state: `"START IN {0:0.0}"`, `"STANDBY"`, `"PAUSED"`, `"PLAYING"` (PS:1668-1677).
- Banner: `"STAGE CLEAR"`, `"STAGE FAILED"` (108 px, center (0,+45)).
- F11 help (PS:2654-2709), verbatim: `"― 操作 ―"`; normal: `"F1: AUTO 切替        Shift+F1 / Pause: 一時停止"`, `"F2 または =: リスタート（成績もリセット）"`, `"F5 / F6: 巻き戻し / 早送り（{skipMs}ms ずつ）"`, `"F7 / F8: ループ開始→終了を設定 / ループ解除"`, `"F9 / F10: 演奏速度 -0.05 / +0.05（現在 x{0.00}）"`, `"↑ / ↓: スクロール速度        ← / →: 判定タイミング（Ctrl で 1ms 刻み）"`, `"Shift+↑ / Shift+↓: BGM タイミング（Ctrl で 1ms 刻み）"`, `"Esc: 中断して選曲へ        F11: このヘルプ"`, blank, `"※ スキップ・ループ・速度変更・BGM 調整を使うと、その演奏は記録されません"`; training: `"↑ / ↓: メニューの項目を選ぶ"`, `"← / →: 設定を変える（Ctrl 併用で 10 段ずつ）"`, `"Enter: 決定（演奏開始・リスタート・一時停止・サブメニュー）"`, `"Esc: サブメニューから戻る／トレーニング終了（選曲へ）"`, `"F1: AUTO 切替（メニューの「自動演奏」と同じ）        F11: このヘルプ"`, `"待機中にパッドを叩くと音だけ鳴る（ウォーミングアップ）"`, blank, `"※ トレーニングの演奏は記録されません（records.json / score.ini とも更新しない）"`, `"※ トレーニングの設定は通常演奏とは別に保存されます"`; then `"― レーン割り当て（Config 画面の Key Assign で変更）―"`, per lane `string.Format("  {0,-3} {1}", LaneName, _auto||laneAuto ? "AUTO" : bindingString)`, blank, `"MIDI デバイス: {n} 台（Midi:<ノート番号> で割り当て）"` + per device `"  {Name}{（開けません）?}  打鍵 {HitCount}"` or `"MIDI デバイス: 未検出（未接続か、この環境では MIDI 入力を利用できません）"`. Panel: black α0.82 at (260,90) 1400×900, text 26 px.

---

## 8. Chip sound playback (PS:2029-2050; Audio/SoundManager.cs)
```
PlayHit(note, auto=false):
  vol = auto ? AutoChipVolume/100 (default 0.8) : ChipVolume/100 (default 1.0)   // ConfigIni.cs:278-281
  id = note.WavId.ToUpperInvariant()
  if wavClips[id] loaded: Sound.PlayPanned(clip, WavVolume(id)*vol, WavPan(id))
  else: Sound.Play(Fallback(note.Lane), vol)      // kit sample (or synth) — no pan
WavVolume(id) = WavVolumes[id]/100 else 1.0;  WavPan(id) = WavPans[id]/100 else 0   (−1..+1)
```
- `PlayPanned` (SoundManager.cs:155-180): `|pan|≈0` → `_source.PlayOneShot(clip, volume)` (unbounded overlapping one-shots on one AudioSource); else round-robin pool of 16 AudioSources: `Stop(); clip; volume; panStereo=clamp; Play()` → 17th simultaneous panned voice cuts the oldest. Hit sounds are never cut by later hits; they ARE cut by `StopAll` (fail/exit) but not by `StopChips` (jump).
- **[ADD]** BGM (ch01) plays via chip pool at `WavVolume × AutoChipVolume` with pan, `protect:true`, priority 0, only if `BGMSound` on; SE (0x61–0x92) plays at `WavVolume` (NO AutoVol) with pan; SE01–05 stop the previous sound of the same channel first (PS:1842-1894). Chip pool 32 slots: free → oldest unprotected → oldest (Core/ChipVoicePool.cs:20-32). Guitar/bass chips (drum screen) auto-sound monophonic per part (PS:1381-1401).
- Pitch: `SetChipPitch(PlaySpeed/20)` (clamp 0.05..4) on `_source`, pan pool and chip pool (SoundManager.cs:260-268; PS:708, 1242); system sounds unaffected. Play speed ≠ 1 changes pitch (no time-stretch); chart times are scaled by `20/PlaySpeed` with int truncation instead of slowing the clock (PS:1249-1286; 699-700; SongClock.cs:12-13). PlaySpeed range 5..40 (ConfigIni.cs:621).
- Metronome (Config `Metronome`): on every bar/beat line pass (visible or not) `ClipMetronome` at 1.0 (bar) / 0.4 (beat) (PS:2000-2011).
- Hidden chips (0x31–0x3C): `HitHiddenNote(idx, abs)` (PS:2292-2301): consumed, `laneFlash=0.12`, `StartLaneEffects`, `PlayHit(n)` (ChipVolume), `StartChipFire` iff `Default.Judge(abs) != Ok` (i.e. abs ≤ 84); no judgment text/score/combo/gauge/counts/early-late. Passed hidden chips consumed silently; never auto-played.
- Bonus effect (`StartBonusEffect`, PS:5841-5848): `Sound.Play(ClipAudience)` at volume 1 (NOT gated by `AudienceSound`, unlike fill-in cheer PS:1990-1997), full-screen `7_Fillin Effect.png` 31 frames × 30 ms additive (if loaded), `7_Bonus.png` at (160,80)·S for 1020 ms.

---

## 9. Lane flash / pad / hit animations (wall clock `Now` = `SongClock.WallMs`: stops while paused, unaffected by jumps — SongClock.cs:30-33; PS:735)
- CUSTOM `Flash{i}` (fallback: full-lane-height box; LaneColors LC (0.9,0.3,0.9) HH (0.95,0.85,0.2) LP (0.8,0.5,1) SD (0.95,0.95,0.95) HT (0.95,0.4,0.4) BD (0.4,0.6,1) LT (0.4,0.9,0.5) FT (0.95,0.6,0.3) CY (0.3,0.85,0.95) RD (0.6,0.7,0.95); PS:530-542 **[LINE]**): `_laneFlash=0.12 s`, decays by `Time.deltaTime`, `alpha = clamp01(flash/0.12)×0.5` (PS:3197-3204).
- NX lane flush `Flush{i}` (PS:3519-3544): file `ScreenPlayDrums lane flush {leftcymbal,hihat,leftpedal,snare,hitom,bass,lowtom,floortom,cymbal,ridecymbal}[ reverse].png` (absent → no flush; RD usually absent); 270 ms; `ct=t/3`; `nomY = 700 − 7.4·ct` (reverse `32 + 7.4·ct`); drawn top = `judgeY + (nomY − 561)·S` (reverse −159); alpha: NX normal `clamp01(nomY/255)`, NX reverse 1, CUSTOM reverse `clamp01((734−nomY)/255)`.
- Pad `Pad{i}`+`PadFlush{i}` (PS:3547-3580): NX: `k=t/8`, `dot2 = k<5 ? 2+2k : max(0, 11−(k−5))` (2,4,6,8,10,11,10,…,0 at t≥128), offset `dot2·S` downward; `bright = 6 − t/18`, alpha = `min(255, bright·50)/255` (1.0,0.98,0.78,0.59,0.39,0.20,0 → invisible at t≥108). CUSTOM: for t≤130: alpha `clamp01((6−t/18)/6)`, offset `(t≤37.5 ? 0.4t : max(0, 15−0.2(t−37.5)))·S`. NX pad positions `PadXByType[lt]`, y 570·S (reverse 70·S).
- Chip fire `Fire{i}a/b` (additive) (PS:3379-3392, 3583-3623): gated by `DrumsAttackEffect` (0 ALL, 1 ChipOff, 2 EffectOnly, 3 OFF): fire unless OFF, stars for 0/1, debris for 0 only; 210 ms, `ct=t/3`, `scale=max(0, 0.4+0.8·cos((ct/50)·π/2))` (0.4 at 150 ms, 0 at ≈200 ms); CUSTOM rotates a by random 0–360°, b = a+90°; NX no rotation; NX RD fire absent unless `chip fire_RD.png`. Chorus (`_chorusSection`, fill-in value 3/5 on, 4/6 off) overlays `chip fire_Bonus.png` at same scale.
- Stars (PS:3401-3431, 3627-3655): 16 per hit from (laneCenterX, NX: judgeY−6·S (rev −3·S) / CUSTOM: judgeY), 7 ms/step, 40 steps (fill-in 100): normal `vx=0.9cosθ·S, vy=(0.9sinθ−0.1)·S, drag 1.010, gravity 0.0204·S, size 0.3+rand[0,0.29)`; fill-in `speed=0.9+rand[0,0.39), vx=speed·cosθ·S, vy=speed(sinθ−0.2)·S, drag 0.995, gravity 0.00355·S, size 0.5+rand[0,0.29)`; step: `x+=vx; y−=vy; vy*=drag; vy−=gravity`; scale `size·cos(π/2·steps/100)`; pool 240 (excess dropped). Fill-in stars are not gated by DrumsAttackEffect.
- Debris (attack 0 only; PS:5434-5563): 1 slot/hit (8 slots), 2 half-chip pieces (7_chips_drums.png y=640 row), 10 ms × 44 steps: `XL−=2.5ax; XR+=2.5ax; Y+=8.660254·ay−0.5319812·S; ax*=0.995; ay+=0.031·S`, ax0=1.2098614·S, ay0=−0.7121183·S; rotation ±0.09 rad/step; alpha 120/255 additive, no scale/fade. Start X = laneCenter + ChipW − 68·S (NX; 58·S CUSTOM), left piece +20·S (HH) / +10·S (others except LC/BD/CY +0).
- Fill-in last-chip waves (PS:3438-3464, 4878-4917): 4 big (start value 0,10,20,30; 10 ms/step) + 1 fine (8 ms/step), radius `(20−rand[0,40)+100)/100` (0.81–1.20), rotation start random + 60°·t, scale piecewise (`t<0.4: 2.5t; t<0.8: 1+10.1(1−cos(π/2·(t−0.4)·2.5)); else 11.1+12.5(t−0.8)`), alpha 55/255 until t=0.75 then linear to 0, ends at value 100. NX center (laneX−40·S, judgeY+14·S (rev 17)); CUSTOM (laneX, judgeY).
- Fill-in/cheer: value 1 → inFillIn on; 2 → off + cheer (`_cheerClip` or Audience.ogg, only if `AudienceSound` && (combo>0 || auto || allLanesAuto)) + NX full-screen flash; 3/5 chorus on; 4/6 off; 5/6 also cheer (PS:1922-1943, 1949-1959, 1990-1997). `IsLastChipOfFillIn`: next fill-in value-2 event time vs following chips within a fixed 100 ms gap (PS:2927-2953).

---

## 10. Default keyboard bindings (Unity InputSystem `Key` enum names, parsed case-insensitively via `Enum.TryParse`, `Key.None` rejected — Input/DrumBinding.cs:149-155)
| Lane | Key | Config `DrumKeys` default token (ConfigIni.cs:58-70; PS:50-62) |
|---|---|---|
| 0 LC | `A` | `A\|Midi:49` |
| 1 HH | `S` | `S\|Midi:42\|Midi:46` |
| 2 LP | `W` | `W\|Midi:44` |
| 3 SD | `D` | `D\|Midi:38\|Midi:40\|Midi:37` |
| 4 HT | `F` | `F\|Midi:48\|Midi:50` |
| 5 BD | `Space` | `Space\|Midi:36\|Midi:35` |
| 6 LT | `J` | `J\|Midi:45\|Midi:47` |
| 7 FT | `K` | `K\|Midi:43\|Midi:41` |
| 8 CY | `L` | `L\|Midi:57\|Midi:55` |
| 9 RD | `Semicolon` | `Semicolon\|Midi:51\|Midi:59\|Midi:53` |
**[ADD]** Token grammar (DrumBinding.cs:13-20, 96-188): `|`-separated, ≤12 per lane, duplicates dropped (MIDI equality by note only), `Pad:<GamepadButton name>` (also enum aliases), `Midi:<0-127>[:<threshold 0-127>]`, `None` = intentionally unassigned (empty list, NOT reverted); unparseable/empty lane → default key only (PS:2623-2639). `DrumKeys` in Config is comma-separated with exactly 10 entries (ConfigIni.cs:497-509). MIDI velocity minimum: input ignored if velocity ≤ min; defaults HH=20, others 0 (`[System] {Lane}VelocityMin`, ConfigIni.cs:77, 612-617). Other keys (PS:830-831, 867-881, 989-1020, 1072-1148): F1 AUTO (Shift not held); Shift+F1 / Pause = pause toggle (sounds/movie paused); F2 or `=` restart (`ResetPlayStats` + jump 0); F6 skip +SkipTimeMs (default 5000, range 100..20000), F5 skip −(max 0); F7 loop point (1st=begin, 2nd=end, swapped if earlier; ignored if both set); F8 loop clear; F10/F9 play speed ±1 (5..40) only if not at limit; ↑/↓ scroll ±1 (allowed while paused); Shift+↑/↓ BGM ±10 ms (Ctrl ±1); ←/→ input adjust; F11 help; Esc (or gamepad East) → song select. The ↑↓←→ handler is a single if/else-if chain in that priority (PS:996-1019).

---

## 11. Chip rendering, scroll speed, bar lines
```
S=1.5; JudgeY = 561·S = 841.5 (CUSTOM: center of JudgeLine rect; NX: TOP of JudgeLine image); BasePixelsPerMs = 0.45·S = 0.675 px/ms   // PS:40-43, 4219-4222
ScrollSpeed setting ∈ [1,2000], default 2 ("display multiplier = value×0.5")           // ConfigIni.cs:32-38, 477-482
targetRaw = setting − 1                                                                  // PS:943-946
currentRaw starts = targetRaw; every 2 ms of wall clock moves 0.012 toward target        // PS:952-975
pixelsPerMs = 0.675 × (currentRaw+1) × 0.5    // default 0.675 px/ms → a chip needs 841.5/0.675 ≈ 1247 ms from top of judge line to screen top
```
Per frame (PS:2982-3030 lane pools / 3033-3063 flat pool; `drawMs = songMs − NoteOffsetMs`, training only):
```
for i in Notes (time order): if judged[i] continue
  dt = TimeMs − drawMs
  y  = reverse ? judgeY + dt·ppm : judgeY − dt·ppm       // future chips above (smaller y)
  if y < −60 || y > 1140: continue                        // no break
  if HidSud != 0: alpha = HidSudAlpha(max(0,dt)·ppm); if alpha<=0 continue
     // HIDDEN(1/3): dist<150 → 0, 150..225 → (d−150)/75 ; SUDDEN(2/3): d≥375 → 0, 300..375 → 1−(d−300)/75 ; STEALTH(4) → 0 ; min of both (PS:2346-2361)
  draw centered at (laneCenterX[lane], y); lane pool cap 80 per lane (flat pool: 80 total and loop stops)
  bounce (only nodes with a "_icon" child): phase=frac((songMs−TimeMs)/666.67); scale=(1+0.3·sin2πphase, 1−0.3·sin2πphase)   // PS:3069-3075
  NX look: pattern frame=(Now/70)%8; HHO (ch 0x18 on lane 1) uses 48·S-wide cell; bonus overlay iff note.Bonus (PS:3159-3188)
```
Lane centers Type-A `{330,393,443,497,550,612,668,717,780,834}`·S; chip widths `{74,56,58,64,56,70,56,56,74,48}`·S, height 64·S (NxPerfLayout.cs:25-29). Lane types B/C/D shift LP/SD/HT/BD by `{0,0,57,−51,69,−49,…}`, `{…,69,−49,…}`, `{0,0,106,−51,−51,0,…}` NX px (PS:419-425). Reverse: `judgeY = 1080 − judgeY` (PS:2537).
Bar/beat lines (PS:3217-3254; pool 96, PS:80): only `Visible` lines; `dt = TimeMs − drawMs`, same y formula; normal: `y > 1090 → continue` (passed), `y < −10 → break`; reverse mirrored. CUSTOM color: bar white α0.35, beat white α0.16, height 2 px (PS:81-82, 2383); NX: sprite rows (0,769,559,2) bar / (0,772,559,2) beat of `7_chips_drums.png`, height 2·S, width 559·S at x=295·S (PS:2375-2376, 4359-4364); CUSTOM width = `LanesPanel` rect width (else lane extent) centered. Drawn in the `Notes` container before chips (behind). Not created at Dark=FULL(2) (PS:2368). Loop lines: begin green (0.4,1,0.5,0.85) / end red (1,0.45,0.45,0.85) 2 lines 6 px apart CUSTOM; NX 7 stripes at offsets `{−1,1,3,9,11,17,23}` / `{−1,−3,−5,−11,−13,−19,−25}` with "Begin loop"/"End loop" console text at x=830 (PS:2396-2499).
Progress bars: CUSTOM `ProgressFill.fillAmount = songMs/Duration`, 60 section cells (i > cur transparent; miss → (1,0.3,0.3,0.75); else (0.4,0.95,0.55,0.55)), best lamps 'Y' (0.35,0.95,0.5,0.5) / 'B' (1,0.4,0.4,0.5) (PS:5611-5689). NX (PS:3936-3975): 64 sections bottom=start, elapsed `n3=min(540, songMs·540/lastChipMs)` px (×S), top 8 px bright; cell: AUTO → chips>0 gray α64; not reached (`(j+1)·last/64−1 > songMs`) gray α64; no chips hidden; hits≥chips yellow α192; else DeepSkyBlue (0,191/255,1).

**Per-frame order** (PS:788-938): `UpdateScrollSpeed` → `songMs=clock.SongMs` → (Clearing/Failing: Render + timers, return) → keys (training keys/jump, F11, F1, Esc, realtime keys; paused → Render, return) → loop wrap (`songMs > loopEnd` → jump to begin, reset counts/combo/maxCombo/score/pgSectionHits/bomb flags) → `ProcessBgm` → `ProcessSe` → `ProcessGuitarBassAuto` → `ProcessFillIn` → `ProcessBarLines` → `ProcessMovie` → `ProcessBga` → **`ProcessJudgement`** (hidden consume → per-lane AUTO → [all AUTO | pads → misses]) → `playedMaxMs` → `Render` → clear check.
`Render` (PS:3190-3337): lane flash decay → notes → bar lines → loop lines → `UpdateNxVisuals` (flush, pads, fire, stars, debris, skill meter, waves, judge strings, score digits, combo digits/label, bonus fx, bomb, progress, NX status panel, play-speed text, danger) → HUD texts (score, combo, judge, status, info) → gauge → `score_detailed` → start fade.

## Key facts

- Judgment windows (inclusive ±ms) default Perfect 34 / Great 67 / Good 84 / Ok(Poor) 117; index = first window containing |dt| (HitRanges.cs:28,49-56); pedal chips (ch 0x13/0x1B/0x1C) use DrumPedalHitRanges (PS:2255-2258); hidden chips always use the fixed default set (PS:2267-2288); global search break uses max of both sets (PS:610,2241)
- inputMs = songMs + JudgeOffsetMs (−99..+99); lag = inputMs − chip.TimeMs; negative=early, positive=late; a positive offset makes hits register later (PS:2148,2185)
- Within a lane: nearest unjudged chip by |dt| within its own window, strict '<' so equal |dt| keeps the earlier chip; across grouped lanes the EARLIEST TimeMs wins, ties → first lane in SearchLanes array (PS:2160-2176, 2232-2251)
- SearchLanes: LC/HH → [HH,LC] if HHGroup∈{1,3}; LT/FT mutual if FTGroup=1; CY/RD → [CY,RD] (CY first for both pads) if CYGroup=1; BD → [BD,LP] if BDGroup∈{1,3} (BDGroup=1 restricts LP lane to ch 0x1C); LP → [LP,BD] only if BDGroup=3 (DrumGroups.cs:40-63); chart downgrade: no LC chip → HH=3, no RD chip → CY=1 (DrumGroups.cs:26-32)
- TieHitsAll = pad ∉ {LC, CY, RD}: same-time chips in partner lanes (visible and hidden) are all hit by one press; LC/CY/RD pads hit only the first-array-order chip so the partner chip needs another press (DrumGroups.cs:70-73; PS:2186-2202)
- Empty hit: flash + pad anim on the PAD lane only, no penalty; sound = nearest chip (visible or hidden, judged or not, any distance) on own lane then partner lanes; [FIX] on equal distance the VISIBLE chip wins; else built-in kit sample for that lane (PS:2204-2217, 2305-2342)
- Miss when inputMs − chip.TimeMs > chip's SearchWindowMs (default 117), judged Miss via Judge (counts late, combo 0, gauge −0.041×DamageFactor, section 'B'); chip vanishes the frame it is judged; hidden chips never Miss (consumed when TimeMs < songMs) (PS:2220-2226, 2113-2118)
- All-lanes AUTO: every chip with songMs ≥ TimeMs is judged Perfect through Judge (counts/combo/score/gauge advance, sound at ChipVolume, AUTO or PERFECT sprite, center text PERFECT); pad presses do nothing at all in AUTO (PS:2134-2142, 2792)
- Per-lane AUTO (AutoJudge): Perfect at chip time, counted only in countsIncAuto, combo unchanged unless all 10 lanes auto, score/gauge only if AutoAddGage, sound at AutoChipVolume (80), bonus +500 unless (allLanesAuto && !AutoAddGage); early manual press within the window still judges such a chip manually (PS:2122-2131, 2720-2769)
- LBD chips are in the LP lane; AutoLanes[10] 'LBD' only affects AutoLaneRevise (0.5 when BD-only, LP-only, or LBD flag), never judgment (PS:584,599; PerformanceResult.cs:110-123)
- ScoreDelta: base=(1000000−500·bonusChips)/(1275+50·(total−50)) float32; Perfect ×1 / Great ×0.5 / Good ×0.2; ×combo if combo<50 else ×50 (except FC-final / all-Perfect); all-Perfect final chip snaps to exactly 1,000,000; FC-not-all-Perfect final Perfect adds 0; int truncation; combo and perfectCount include the current chip (PerformanceResult.cs:161-182; PS:2775,2805,2813)
- Bonus chip: +500 added before ScoreDelta on Perfect/Great only (not Good); Audience.ogg (ungated) + 31-frame full-screen flash + BONUS image 1020 ms; score clamped 0..9,999,999 (PS:2808-2816, 5841-5848)
- Achievement% = P%·0.85 + G%·0.35 + MaxCombo%·0.15 (combo term 0 if all lanes auto) × AutoLaneRevise; Skill = rate × LevelFactor × 0.2 (0 if any AUTO); Rank SS≥95 S≥80 A≥73 B≥63 C≥53 D≥45 else E (PerformanceResult.cs:87-98,134-141,246-260)
- Gauge: initial 2/3, max 1.0 (upper clamp only), fail at ≤ −0.1, danger ≤ 0.3; deltas Perfect +0.005, Great +0.001, Good 0, Ok −0.017 (unscaled), Miss −0.041×{0.25,0.5,0.75}[DamageLevel, default 1] = −0.0205 (PS:492-500, 2853-2873)
- [FIX] RISKY: P/G/Gd → 0; Ok/Miss → gauge −= 1/(riskyInitial−1) except when riskyTimes==1 (last life → 0), then riskyTimes−−; fail when riskyTimes ≤ 0 (PS:2855-2864, 2876-2879)
- STAGE FAILED suppressed in training mode and when Config StageFailed=0: `IsFailed() && _state==Playing && !_trainingMode && Config.StageFailedEnabled` (PS:2844-2845); on fail StopAll, failed image, Stage failed.ogg at +200 ms, → result after 2200 ms CUSTOM / 2500 ms NX or Enter/Space/Esc
- Stage clear when HasNotes && songMs > DurationMs + 2000 && no loop; banner 'STAGE CLEAR' rgb(0.4,1,0.6) 1500 ms CUSTOM / 2000 ms blank NX; a chart with no notes never clears (PS:929-935, 797-824)
- Center judgment text (CUSTOM): PERFECT/GREAT/GOOD/OK/MISS for 0.5 s (Time.deltaTime), colors P(1,0.95,0.3) G(0.4,1,0.5) Gd(0.4,0.8,1) Ok(0.8,0.5,1) Miss(1,0.4,0.4); per-lane sprite 300 ms classic anim (open horizontally 50 ms, hold, squash from 240 ms; bad: rise 50 ms, shrink from 200 ms; bad=Miss in NX, Ok+Miss in CUSTOM) or NX sheet 24×14 ms (PS:3264-3273, 4069-4079, 3691-3725)
- Combo text (CUSTOM) from combo ≥ 2 as '{n}\nCOMBO'; NX sprite digits from combo ≥ 10 (prefab ≥ 1); jump −15·S·sin(π·t/180) over 180 ms; combo bomb at combo 102, 202, … (combo > combo/100+100) 14×20 ms; 100-combo emphasis scale 1.22–1.303 (PS:3263, 3760-3831, 3855-3881)
- score_detailed rows: perfect/great/good/ok(poor)/miss _hits = counts[i], _rate = RoundToInt(100·count/Σcounts)+'%' ('0%' when Σ=0), max_combo_hits/max_combo_rate likewise; NX status panel rates use Σ countsIncAuto as denominator (PS:3341-3363, 3981-4004)
- song_info: song_name = SelectedSong.Title, song_artist = SelectedScore.ArtistName, Jacket always shown (PS:4393-4421)
- PlayHit: WAV by chip WavId; volume = (#VOLUME/100, default 1) × (ChipVolume/100 or AutoChipVolume/100); pan = #PAN/100; pan≈0 → PlayOneShot (unbounded); pan≠0 → 16-voice round-robin cutting oldest; BGM at WavVolume×AutoVol protected; SE at WavVolume; pitch = PlaySpeed/20 (no time-stretch), chart times scaled by 20/PlaySpeed (PS:2029-2050, 1855, 1887; SoundManager.cs:155-180, 204-232, 260-268)
- Hidden chips (0x31–0x3C): hit before passing → sound + flash + pad + fire if |dt| ≤ 84; no judgment/score/combo/gauge/counts; consumed silently once TimeMs < songMs; never auto-played (PS:2292-2301, 2113-2118)
- Lane flash (CUSTOM): 0.12 s, alpha = clamp01(remaining/0.12)×0.5 in lane color; NX flush 270 ms, nomY = 700 − 7.4·(t/3), alpha nomY/255; pad flash alpha (6−t/18)·50/255 (~108 ms) with bounce 2,4,6,8,10,11,10…0; chip fire 210 ms scale 0.4+0.8·cos(π/2·t/150 ms) (PS:3197-3204, 3519-3623)
- Default keys LC=A HH=S LP=W SD=D HT=F BD=Space LT=J FT=K CY=L RD=Semicolon (Unity Key enum names; PS:50-62; ConfigIni.cs:58-70); token 'None' = unassigned, unparseable → default key; ≤12 bindings per lane; MIDI velocity min HH=20 (DrumBinding.cs:169-188; ConfigIni.cs:77)
- Scroll: pixelsPerMs = 0.45·1.5 × ((ScrollSpeed−1)+1)×0.5 = 0.675 px/ms at default ScrollSpeed=2 (display multiplier = ScrollSpeed×0.5), ramped 0.012 raw per 2 ms of wall clock; y = judgeY(841.5) − dt·ppm (≈1247 ms from screen top to line); chips drawn if −60 ≤ y ≤ 1140; judged chips not drawn; lane pool 80 (PS:40-43, 943-980, 2989-2995)
- Bar lines (0x50) white α0.35 / beat lines (0x51) white α0.16, 2 px tall (NX: sprite rows y=769/772, 2·S tall, 559·S wide at x=295·S), only Visible (0xC2) lines, drawn behind chips, pool 96, hidden at Dark=FULL; beat lines generated at (int)(384·i/(4·barLen)) + 0xC1 shift, skipping multiples of 384 (PS:81-82, 2364-2394, 3217-3254; DtxChart.cs:669-751)
- Early/Late counters: lag > 0 → late, else (0 or negative) early; counted only for manual Judge calls including Miss; lag-digit color chosen by leading '-' so lag 0 shows late color (PS:2783-2787, 5773)
- JumpInSong marks chips before the target as judged (no Miss) and chips after as unjudged; loop wrap resets counts/combo/maxCombo/score (not gauge, not countsIncAuto); Restart resets everything incl. gauge 2/3 (PS:1304-1313, 892-905, 1197-1218)

## Open questions

- CUSTOM-layout element positions (lane X, judge line Y, JudgeStr/Pad/Flash placement, score_detailed layout) are read from the Unity prefab Resources/Stages/PerformanceStage.prefab at runtime, not from code; only the NX fallback constants (NxPerfLayout) and the fallback UI (PS:6038-6176) are known from source. Decide which layout the browser port reproduces.
- NX-mode visuals depend on skin image files (7_judge strings.png, 7_chips_drums.png, lane flush PNGs, 7_Ratenumber_*.png, 7_lag numbers.png, 7_combobomb.png, 7_Fillin Effect.png, 7_Bonus.png, etc.); the spec gives geometry/timing but sprite content must be supplied.
- Unity PlayOneShot polyphony for unpanned hit sounds is effectively unbounded (Unity real-voice limit 32 applies globally; SE voices have priority 200 and are virtualized first); the browser port must pick a voice cap. Panned hits use a 16-voice round-robin that cuts the oldest.
- CUSTOM lane-flash, center judgment text (Time.deltaTime) and gauge/DANGER blink (Time.time) are frame-rate/real-time based; NX effects use the pause-aware wall clock. Choose ms-based timing in the port.
- Fill-in 'last chip' detection uses a fixed 100 ms gap approximation of NX's 0x18-tick rule (PS:2927-2953); exact NX tick behavior is not reproduced.
- Mathf.RoundToInt (score_detailed) vs Math.Round (NX status panel) both use banker's rounding on exact .5; JS Math.round differs — decide whether to reproduce.
- Training-mode menu (TrainingMenu class), NX skill meter graphics (PS:5127-5312), and the guitar/bass auto-sound path were only summarized; read PS:1480-1700 and Stages/TrainingMenu.cs if those features are in scope.
- The ConfigIni.cs:46 doc-comment says a positive JudgeOffset 'treats input as early'; the code (inputMs = songMs + offset) makes hits register later. The formula is authoritative but the intended user-facing wording should be confirmed.
