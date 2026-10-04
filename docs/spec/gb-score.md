# gb-score

# Guitar/Bass scoring, gauge, combo, achievement and records (NX vs. DTXManiaAI)

Path abbreviations. NX paths are relative to `DTXmaniaNX/DTXMania/Code/`:
- `CPC` = `Stage/07.Performance/CStagePerfCommonScreen.cs`
- `CPG` = `Stage/07.Performance/GuitarScreen/CStagePerfGuitarScreen.cs`
- `SCO` = `Stage/07.Performance/CActPerfCommonScore.cs`
- `GSC` = `Stage/07.Performance/GuitarScreen/CActPerfGuitarScore.cs` [ADD]
- `GSP` = `Stage/07.Performance/GuitarScreen/CActPerfGuitarStatusPanel.cs` [ADD]
- `GAU` = `Stage/07.Performance/CActPerfCommonGauge.cs`
- `CMB` = `Stage/07.Performance/CActPerfCommonCombo.cs`
- `INI` = `Score,Song/CScoreIni.cs`
- `DTX` = `Score,Song/CDTX.cs`
- `CFG` = `App/CConfigIni.cs`
- `PAD` = `App/CPad.cs` [ADD]
- `RES` = `Stage/08.Result/CStageResult.cs`
- `RPP` = `Stage/08.Result/CActResultParameterPanel.cs`
- `RRK` = `Stage/08.Result/CActResultRank.cs`
- `APP` = `App/CDTXMania.cs`

DTXManiaAI paths are relative to `Assets/Scripts/`:
- `GPS` = `Stages/GuitarPerformanceStage.cs`
- `PR` = `Core/PerformanceResult.cs`
- `AICFG` = `Config/ConfigIni.cs`
- `REC` = `Song/RecordManager.cs`
- `ARS` = `Stages/ResultStage.cs`
- `SIE` = `Song/ScoreIniExporter.cs` [ADD]

Markers:
- **[NX-only]**: present in NX, skipped by DTXManiaAI.
- **[AI-dev]**: DTXManiaAI behaves differently from NX. NX is the reference.
- **[AI-add]**: DTXManiaAI addition.
- **[FIX]** / **[ADD]**: corrections and additions made by the verification pass.

Judgment indices: NX `EJudgement { Perfect=0, Great=1, Good=2, Poor=3, Miss=4, Bad=5, Auto(=6) }` (`App/CConstants.cs:191-200`). DTXManiaAI `EJudge { Perfect, Great, Good, Ok(=Poor), Miss }` (GPS:40). NX `EInstrumentPart`: Drums=0, Guitar=1, Bass=2. Every per-part quantity is an `STDGBVALUE` indexed by part.

NX defaults that matter here:
- `nSkillMode = 1` (XG) (CFG:1281)
- `bAutoAddGage = false` (CFG:1349)
- `eDamageLevel = Normal(1)` (CFG:1273; enum `App/CConstants.cs:51-56`)
- `bSTAGEFAILEDEnabled = true` (CFG:1274)
- `bLight[*] = true` (CFG:1389)
- every Gt/Bs AUTO flag = false (CFG:1420-1433) [FIX: BsW is on 1433]
- `nRisky = 0`, `bHAZARD = false` (CFG:1470-1471)
- [ADD] `_bGuitar有効 = false`, `_bDrums有効 = true` (CFG:1270-1271). GR mode is `!bDrumsEnabled && bGuitarEnabled` (CFG:895-901), so it is opt-in.
- [ADD] `nInfoType = 1` (status panel shown, CFG:1280), `bShowLagHitCount = false` (CFG:1474).

DTXManiaAI has no `SkillMode`. It always uses XG, so every classic-mode item below is **[NX-only]**.

---

### 0. Definitions

**N (total notes)** = `DTX.nVisibleChipsCount.Guitar` / `.Bass` (DTX:3944-3965). It counts chips on these channels (values from `Score,Song/EChannel.cs:30-189`):
- Guitar: `0x20-0x27`, `0x93-0x9F`, `0xA9-0xAF`, `0xD0-0xD3`
- Bass: `0xA0-0xA7`, `0xC5-0xC6`, `0xC8-0xCF`, `0xDA-0xDF`, `0xE1-0xE8` (0xC7 and 0xE0 are BGA-swap channels)

What N includes and excludes:
- One chip = one note. A chord (for example RGB on `0x27`) is one channel and therefore one note.
- OPEN notes and LN start chips are counted.
- Not counted: wailing `0x28/0xA8`, LN control `0x2C/0x2D`, wailing-sound `0x2F`, no-chip sound `0xBA/0xBB`.
- Wailing and LN-control chips have `eInstrumentPart = UNKNOWN` (DTX:6881-6894), so they are never judged, counted, or missed.
- Under FLIP, N is swapped together with the chips (DTX:4410-4415).
- NX quirk: `bチップがある.Guitar` starts at `0xAA`, not `0xA9` (DTX:6674), while the counter and the part assignment include `0xA9` (DTX:3956, 6887).
- Verified on the test charts: gt_mst N=537 (0x20,21,22,23,24,25,26,93,94,95,96,9B,9C,AC,AD), 4×0x28, 12×0x2C; ba_mst N=501, 3×0xA8, 26×0x2D. GLEVEL 74, BLEVEL 73.

DTXManiaAI uses `TotalNotes = Part.Notes.Count` (GPS:1287). That is the same channel set (`Song/DtxChart.cs:128-139, 493-508`).

**AUTO chip** (NX `bCheckAutoPlay`, CPC:3737-3780). A Gt/Bs chip is AUTO iff all of these hold:
- the Pick flag is AUTO, and
- every lane the chip uses is AUTO, and
- (OPEN only) all five neck lanes are AUTO.

[FIX] The code also tests the W flag for wailing chips (CPC:3757, 3775), but that test is dead: wailing chips are `UNKNOWN` part and never reach this branch.

With manual pick, no chip is AUTO. DTXManiaAI uses the same rule (GPS:981-985); `chipIsAuto` is only possible on the AutoPick path.

**All-AUTO part**: `bAllGuitarsAreAutoPlay` = GtR, GtG, GtB, GtY, GtP and GtPick are all AUTO. **W is excluded** (CFG:916-943; `ELane` order in `App/CConstants.cs:236-264`). DTXManiaAI `AllGBAuto` matches (AICFG:144-150).

[ADD] A second, different "all-AUTO" exists on stored entries: `CPerformanceEntry.b全AUTOである` = (ΣExclAuto counts == 0) (INI:331-337). That means "no manual judgment", not "config all-AUTO". APP uses it to pick the history line (APP:1384-1413, 1570-1600).

**Hit counters** (class at CPC:517-577; updates at CPC:1576-1603). Two sets are kept per part:
- `nHitCount_IncAuto[part][j]` counts every judged chip.
- `nHitCount_ExclAuto[part][j]` counts only chips with `!bPChipIsAutoPlay`.

Miss and Bad both go to `.Miss`; other judgments go to `[j]`. A judged Gt/Bs chip can never be `Bad` or `Auto`, because the Gt/Bs judgment always comes from timing, or is forced Miss when `bCorrectLane == false` (CPC:1445-1458, 968-1018). `Bad` exists only on the empty-pick path (§3), which touches no counter.

**Order inside `tProcessChipHit` for a Gt/Bs chip** (CPC:1415-1905, then the CPG:349-417 override):
1. `bHit = true`. If the chip is an LN start, the hold state starts unconditionally (1417-1425).
2. `auto = bCheckAutoPlay(chip)` (1431).
3. Judge: `lag = nHitTime + adj − chipTime`, with `adj = auto ? 0 : nInputAdjustTimeMs[part]` (1447-1458, 974).
4. Gauge (1472-1486).
5. Progress bar (P/G/Gd only) and Early/Late counter, only if `!auto` (1489-1498).
6. Hit counters. A Miss also cancels the hold (1576-1603).
7. Combo (1604-1615).
8. Score (1651-1901).
9. Live achievement and status-panel values (CPG:352-415).

`combo` and `perfect` are therefore post-increment values when the score is computed.

DTXManiaAI `JudgeChip` (GPS:1091-1141) runs in this order: Early/Late → progress → LN start → counters → combo → score → gauge. Applying the gauge after the score makes no numeric difference.

---

### 1. Per-chip score (XG, `nSkillMode == 1`)

#### 1.1 Chip score: NX CPC:1805-1857 (`bAutoAddGage == false`) and CPC:1703-1751 (`bAutoAddGage == true`)

[FIX] The two Gt/Bs branches are identical, and both accept `Perfect || Auto` (1709, 1813). `Auto` is dead for Gt/Bs. Only the drum branches differ: the `!bAutoAddGage` drum branch adds a `!bPChipIsAutoPlay` gate (CPC:1759).

There is **no `!bPChipIsAutoPlay` gate** for Gt/Bs in either branch. AUTO chips are therefore scored, and the AUTO revise in §1.2 scales them.

All arithmetic is float32 (`float nScoreDelta`, `float nComboMax`, `f` literals):

```
if part∉{GUITAR,BASS} || j∈{Miss,Bad}: no Add() call         // Poor reaches Add() with delta 0 (combo already 0)
c   = nCurrentCombo[part]            // already incremented for this chip
N   = (float)nVisibleChipsCount[part]
base = 1000000.0f / (1275.0f + 50.0f*(N − 50.0f))           // NO bonus-chip deduction (drums: (1e6 − 500·bonusChips)/…)
if j ∈ {Perfect, Auto}:
    if c < N:                                   delta = base
    elif IncAuto[part].Perfect >= N:            delta = (1000000.0f − (float)trueScore[part]) + LNacc[part]   // int LNacc → float
    else:                                       delta = 0      // full combo but not all Perfect: final Perfect adds 0
elif j == Great: delta = base * 0.5f
elif j == Good:  delta = base * 0.2f          // 0.2f is a float32 constant
else (Poor):     delta = 0
if c < 50:                                          delta = delta * c       // also applies to the correction when N < 50
elif c == N || ExclAuto[part].Perfect == N:         (no multiplier)
else:                                               delta = delta * 50.0f
actScore.Add(part, this.bIsAutoPlay, (long)delta)  // truncation toward zero; bIsAutoPlay = config copy (CPC:367)
```

How `1275` is derived: the 1,000,000 points are spread over coefficients 1..49 for combos 1-49 (sum 1225), then 50 for each later chip. The final chip at ×50 makes the total exactly `base × (1275 + 50(N−50)) = 1e6`. The correction branch replaces that final ×50 so the total lands on exactly 1,000,000 + LN bonus (at rev = 1).

The condition uses two different Perfect counts:
- **IncAuto** decides whether the correction applies (CPC:1820).
- **ExclAuto** exempts a chip from ×50 (CPC:1844).

Worked numbers (float32, truncated; re-derived):

| Chart | N | base | Perfect @c≥50 | Great @c≥50 | Good @c≥50 |
|---|---|---|---|---|---|
| gt_mst | 537 | 39.024391 | 1951 | 975 | 390 |
| ba_mst | 501 | 41.972717 | 2098 | 1049 | 419 |

At rev = 1, all-Perfect:
- N=537: the chips before the last sum to 997,921, and the correction adds 2,079.
- N=501: the chips before the last sum to 997,586, and the correction adds 2,414.

**Small charts [NX quirk].** The denominator is `50N − 1225`, which is 0 at N=24.5.
- [FIX] For N≤24, base is negative and the running total goes negative.
- For N<50, the correction is also multiplied by `c = N`, so the all-Perfect final is wildly off. Values re-derived at rev 1, no LN:

| N | All-Perfect final |
|---|---|
| 24 | +277,920,000 |
| 25 | −263,000,000 |
| 40 | 749,152 |
| 49 | 2,921,152 |
| 50 | 1,000,000 |

  Only N≥50 yields exactly 1,000,000.
- [ADD] Both the in-play and result renderers format the score `{0,7:######0}` and draw only the first 7 characters, calling `int.Parse` on each one (GSC:85-96, RPP:596-609). Values above 7 digits are therefore drawn truncated, and a negative value would make `int.Parse("-")` throw.

**DTXManiaAI** (`PR.GBScoreDelta`, PR:195-214):
- Same branches, same float32 math, same two Perfect counts (`CountsIncAuto[0]` / `Counts[0]`, GPS:1125).
- **[AI-dev]** The correction returns early as `(int)(1000000.0f + lnBonus − currentScore)` and is never multiplied by `c`. At rev 1, all-Perfect therefore always ends at 1e6 + LN, even for N<50. Only the drum `ScoreDelta` comment mentions this (PR:165-166).
- The addition order `(1e6 + LN) − score` differs from NX `(1e6 − score) + LN`. The result is the same for integer operands below 2^24.

**Classic mode, `nSkillMode == 0` [NX-only]** (CPC:1861-1901):
- `tbl = {350, 200, 50, 0}[j]`
- if `c ≤ 500 || j == Good`: `delta = tbl·c` (Good is uncapped)
- elif `j == Perfect`: `delta = 350·500`
- else (Great with c>500): `delta = 0` (quirk)
- With `!bAutoAddGage`, only non-AUTO chips score in classic mode (1884), unlike XG.

#### 1.2 Accumulation and the AUTO score revise, `actScore.Add` (SCO:55-120)

```
rev = 1.0
GUITAR: if !bAllGuitarsAreAutoPlay:
            if GtPick: rev /= 2
            if GtR||GtG||GtB||GtY||GtP: rev /= 2          // any neck lane AUTO; independent of how many
        elif !bAutoAddGage: rev = 0.0                       // all-AUTO + AutoAddGage → rev stays 1.0 (full score)
BASS:   same with Bs* flags (SCO:92-116)
trueScore[part] = trueScore[part] + delta * rev            // double; fractional part kept (SCO:119, 36-48)
```

Possible `rev` values: 1, ½, ¼, 0. W never affects `rev`.

Every score source goes through `Add` and is therefore revised: chip score, LN ticks (CPC:5397) and wailing (CPC:5547/5552). The **FC bonus does not** (§1.5).

**[ADD] The all-Perfect correction does not scale with rev.** It is computed against the already-revised total `T` and then revised again:

```
final = T + rev·trunc(1e6 − T + LNacc_raw)
```

For rev = ½ (AutoPick only, manual neck, so every chip is non-AUTO), all-Perfect, re-derived:

| Chart | NX before bonus | NX after +30,000 (unrevised) | DTXManiaAI before bonus | DTXManiaAI after +15,000 |
|---|---|---|---|---|
| gt_mst | 749,480 | 779,480 | 749,352 | 764,352 |
| ba_mst | 749,396.5 | 779,396 stored | 749,387 | 764,387 |

The stored score is `nスコア = (long)trueScore` (CPC:153, 224). The display count-up is cosmetic:
- increment = `max(1, (long)((true − shown)/20))`, recomputed whenever the true value changes (SCO:36-48), applied every 10 ms (GSC:64-79)
- [ADD] the shown value is clamped to `(long)trueScore` (GSC:75-76)
- 7 digits, no 0..9,999,999 clamp in NX
- [ADD] In training, GSC:58-61 zeroes index `[0]` (drums) and skips the count-up, so the Gt/Bs display freezes.

**DTXManiaAI** (GPS:106-109, 406-415, 1145-1158):
- Same `ScoreRev` rule. All-AUTO gives `AutoAddGage ? 1 : 0`.
- **[AI-dev]** `Score` is an `int` and each add does `Score += (int)(delta·rev)`. With rev ½ or ¼, NX keeps the fractions and truncates only once at the end, so the AI loses up to <1 point per add.
- **[AI-dev]** The score is clamped to `[0, 9,999,999]` (GPS:1150-1151).

#### 1.3 Long-note hold bonus (CPC:5354-5418)

A hold is active from an LN-start chip hit with any judgment except Miss. NX starts the hold unconditionally at CPC:1419-1425 and clears it on Miss at CPC:1586-1593, which is equivalent.

`tHandleInput_GuitarBass` runs every frame for both parts (CPC:2368-2369). It returns early only if `!bGuitarEnabled` or the part has no chips (CPC:4877-4880). The LN code runs before the pick handling, so it also runs under AutoPick.

Each frame while the hold is active and `(chipBits & ~autoMask & 0x3F) == (pressedBits & ~autoMask & 0x3F)` (CPC:5360). The `autoMask` includes W=8, which never appears in chip bits (CPC:4894-4900).

```
if part < 5:
    nextAt = startMs + ((part+1) * durationMs) / 6        // int arithmetic; duration = endChip.t − start.t (CPC:1423)
    if nowMs >= nextAt:                                     // nowMs = performance timer, no input adjust
        Add(inst, 100)        // revised by rev
        LNacc[inst] += 100    // raw, unrevised; used by the all-Perfect correction
        part++                // at most one tick per frame; at most 5 ticks = 500 raw per LN
```

How a hold ends:
- **Mask mismatch** while `judge(now + adj − endChipTime) ≥ Miss` (5407), meaning the player released before the end chip's Poor window: the hold is cancelled silently and the chip sound stops (5407-5417). There is no count, no combo break and no gauge change. A mismatch inside the end chip's Poor window keeps the hold but gives no ticks.
- **End control chip (0x2C/0x2D) reaches the bar**: normal release (CPC:3358-3375).
- **Any Miss of the same part**: the hold is cancelled (CPC:1586-1593).

Additional rules:
- An empty-pick Bad does not cancel a hold.
- OPEN notes cannot start an LN (DTX:3877-3880).
- LN pairing: the first control chip that coincides with a visible non-OPEN chip of the part is the start. The next control chip ends the LN, unless a visible chip lies in `(start, end]` (DTX:3866-3909).
- `LNacc` and the hold state reset on `tJumpInSong` (CPC:5622-5628).
- **[NX-only]** While holding a chip that has at least one non-AUTO lane, NX calls `Damage(inst, part, Good)` **every frame** (CPC:5362-5365). Good adds 0, so this only matters with HAZARD:
  - without Risky, it is −0.05 per frame;
  - [ADD] with Risky, it decrements the shared life every frame (GAU:189-202).

Test charts have 12 (gt) and 26 (ba) `0x2C/0x2D` control chips. That is at most 6 / 13 LNs, so a raw LN bonus of at most 3,000 / 6,500.

DTXManiaAI `UpdateLongNoteHold` (GPS:843-885) matches:
- It releases at `songMs >= LongEndMs`.
- It omits the per-frame `Damage(Good)` call; HAZARD does not exist in the AI.

#### 1.4 Wailing bonus (CPC:5484-5490, 5530-5559, 4407-4413, 4589-4605)

**Reservation.** After a successful pick (mask OK, judgment ≠ Miss) or a non-miss AutoPick hit, NX calls `r指定時刻に一番近いChip(t, 0x28/0xA8, adj, 140)` (CPC:1984-2075). It searches around the input-adjusted time for a not-yet-hit wailing chip within ±140 ms; a past chip wins if one exists. The chip is enqueued in `queWailing[part]`.

**Wail input.** Every queued chip is dequeued. For each one:

```
if (tWail − chip.t) <= 1000:          // tWail is NOT input-adjusted; no lower bound
    chip.bHit = true; play wailing effect
    if !autoW:
        XG:      Add(inst, combo > 500 ? 50000 : combo*100)     // combo = current combo; continuous at 500
        classic: Add(inst, min(combo,500) * 3000)               // [NX-only]
        tBoostBonus()      // sets bブーストボーナス; its nRate (CPC:1653) is never used → no score effect
```

Chips that fail the 1000 ms test are discarded.

**AUTO wailing.** If W is AUTO:
- Every frame a wailing chip is past the bar (until it is 234 px past, CPC:4589-4594), the same routine runs with `autoW = true`. It consumes the queue with **no score**.
- A manual wail input is also processed with the config `autoW` (CPC:4887, 5524), so it scores nothing either.

**Side effects.** Wailing never touches combo, gauge, counters or N.

**Interaction with the correction.** Wailing score earned before the last chip of an all-Perfect run is absorbed by the correction, which resets the total. Wailing after the last chip adds on top.

**[NX quirk]** Two picks within 140 ms before a wail can enqueue the same chip twice. `DoWailingFromQueue` does not check `bHit`, so the bonus is paid twice.

DTXManiaAI (GPS:995-1033; PR:220-223):
- XG formula only.
- **[AI-dev]** Deduplicates the queue (`!WailQueue.Contains`, GPS:1013) and skips consumed chips (GPS:1023), so there is never a double bonus.
- **[AI-dev]** AutoWail consumes the queue as soon as it is non-empty (GPS:816-817), not when the chip reaches the bar. This affects visuals only.
- Expiry is a fixed 1000 ms after chip time (GPS:820-825). NX instead uses 234 px of scroll, which depends on scroll speed.

#### 1.5 FC / Excellent bonus (CPG:242-294)

This runs when any fade-out completes and the stage-clear sound is not playing (CPC:4651-4679: clear, STAGE FAILED, or Esc). It runs before the stage returns, so the stored `nスコア` includes it. Only the clear path persists the score.

```
for part in {Guitar, Bass}:
    if ExclAuto.Miss + ExclAuto.Poor == 0:          // empty-pick Bads ignored
        perfects = bAllXAreAutoPlay ? IncAuto.Perfect : ExclAuto.Perfect
        if nSkillMode == 1:
            trueScore[part] += (perfects == N) ? 30000 : 15000     // direct add: NO rev
```

The bonus is applied even to a part with N=0 (Excellent, 0 == 0), but such a part is never stored.

[ADD] Because the bonus is not revised, an all-AUTO part with `!bAutoAddGage` (rev 0) ends with `nスコア = 30000`. That matters for HiScore, see §6.

DTXManiaAI `ApplyClearBonus` (GPS:1213-1228) runs once, at the moment STAGE CLEAR is entered (GPS:594-599). It skips parts with N=0.
- **[AI-dev]** It goes through `AddScore`, so **rev is applied**. AutoPick gives +15000/+7500, and all-AUTO without AutoAddGage gives +0. NX always adds 30000/15000.

Theoretical maximum (XG, rev 1): 1,000,000 + LN bonus + 30,000 + any wailing after the final chip.

---

### 2. Gauge (GAU)

Constants (GAU:42-46):

| Constant | Value |
|---|---|
| `GAUGE_MAX` | 1.0 |
| `GAUGE_INITIAL` | 2/3 |
| `GAUGE_MIN` (fail) | −0.1 |
| `GAUGE_DANGER` | 0.3 |

```
fDamageGaugeDelta (float32) rows=judge, cols=Drums,Guitar,Bass   (GAU:136-143)
  Perfect  +0.004  +0.006  +0.006
  Great    +0.002  +0.003  +0.003
  Good      0       0       0
  Poor     −0.020  −0.030  −0.030
  Miss     −0.050  −0.050  −0.050
XG override (nSkillMode==1) rewrites the DRUMS column only: {+0.005,+0.001,·,−0.017,−0.041} (GAU:156-162)
   (it mutates the shared array on every call; never reverted)
fDamageLevelFactor = {0.25f, 0.5f, 0.75f}  (Small/Normal/High; GAU:144-146)

Damage(screenmode, part, j):                               (GAU:151-291)
  Perfect:     d = risky ? 0 : T[j,part]
  Great/Good:  HAZARD ? (risky ? riskyDecrement() : T[Miss,part])  : (risky ? 0 : T[j,part])   // HAZARD [NX-only]; no level factor
  Poor/Miss:   d = risky ? riskyDecrement() : T[j,part];  if j==Miss && !risky: d *= fDamageLevelFactor[eDamageLevel]
  Bad/other:   d = 0
     riskyDecrement(): d = (nRiskyTimes==1) ? 0 : −1.0/(nRiskyInitial−1); if nRiskyTimes>=0: nRiskyTimes−−
  if screenmode==DRUMS: gauge[DRUMS] += d          // Gt/Bs chips on the drum screen feed the drum gauge [NX-only]
  elif risky:           gauge[GUITAR] += d; gauge[BASS] += d   // one shared life count, both bars drop
  else:                 gauge[part] += d
  gauge[part] = min(gauge[part], 1.0)               // no lower clamp
IsFailed(part) = risky ? nRiskyTimes<=0 : gauge[part] <= −0.1      (GAU:63-70)
IsDanger(part) = risky ? (init==1 ? false : init<=3 ? times<=1 : times<=2) : gauge[part] <= 0.3   (GAU:71-86)
Init(nRisky): gauge = !risky ? 2/3 : (nRisky==1 ? 0.0 : 1.0)       (GAU:109-130; called at CPC:370)
```

`fDamage` is a `double` loaded from `float` cells, so the widened values are what get added (re-derived):

| Judge | Widened value |
|---|---|
| Perfect | 0.006000000052154064 |
| Great | 0.003000000026077032 |
| Poor | −0.029999999329447746 |
| Miss ×0.5 (Normal) | −0.02500000037252903 |
| Miss ×0.25 | −0.012500000186264515 |
| Miss ×0.75 | −0.037500000558793545 |

From 2/3 that means 56 Perfects reach full, and 31 Normal Misses or 26 Poors reach fail.

**What drives the Gt/Bs gauge:**
- **Judged chips** (CPC:1472-1486): with `!bAutoAddGage`, only non-AUTO chips; with `bAutoAddGage`, every chip. An AUTO hit is normally Perfect, +0.006.
- **Empty pick / wrong-fret pick (Bad)** when `!bLight` (CPC:5509-5512 → 1957): `Damage(GUITAR, part, Miss)` applies Miss × level factor and, under Risky, decrements the shared life. There is no AUTO gate.
- **Pass-through Miss** (CPC:2909-2918): a chip past the bar with `judge(now + adj − t) == Miss` (i.e. `|lag| >` Poor) is judged Miss.
- Wailing and LN ticks: no effect, apart from the HAZARD note in §1.3.
- **Per part**: each part has its own bar. A part with no chips stays at 2/3 and is not drawn (`GuitarScreen/CActPerfGuitarGauge.cs:82, 112`).
  - The full-bar image is drawn only when `gauge == 1.0` exactly (same file, 88-91).
  - [ADD] Nothing is drawn while `gauge < 0` (same file, 92-96).

**STAGE FAILED** (CPG:168-179). It is checked once per frame at the start of the update, only when `bSTAGEFAILEDEnabled && !bIsTrainingMode && phase == DefaultState`:

```
fail = IsFailed(GUITAR) || IsFailed(BASS) || (!bチップがある.Guitar && !bチップがある.Bass)
```

The AUTO condition was intentionally removed (#23630), so an AUTO part can fail. Routes:
- the shared Risky life;
- Bads;
- with AutoAddGage, AUTO-chip Misses (§3).

One part failing ends the whole stage.

**Comparison with the web app.** `js/game/judge.js:10` uses `GAUGE_DELTA = [0.005, 0.001, 0, −0.017, −0.041]`, which is NX's XG **drums** column. **Guitar/Bass differ:** `[+0.006, +0.003, 0, −0.030, −0.050]`. This column is the same in XG and classic, because the XG override never touches it.

Unchanged between drums and guitar:
- `GAUGE_MAX`, `GAUGE_INITIAL`, `GAUGE_FAIL`, `GAUGE_DANGER` (judge.js:6-9)
- `DAMAGE_FACTOR = [0.25, 0.5, 0.75]`, applied to Miss only, not Poor (judge.js:11, 100-101)

At Normal level, a Gt/Bs Miss is −0.025 versus −0.0205 on drums.

**DTXManiaAI** (GPS:50-58, 1160-1194, 2895-2903):
- Same table as double literals (not float-widened) and the same Miss-only factor (AICFG:259-262).
- Fail check: `risky ? riskyTimes<=0 : gauge<=−0.1`, gated by `StageFailedEnabled`, performed immediately per judgment (and per Bad) rather than per frame.
- **[AI-dev]** Risky applies `d` only to the judged part's bar; NX drops both bars. The shared life counter is identical (GPS:60-63, 303-305, 1175-1185).
- **[AI-dev]** Risky initial gauge stays 2/3 (GPS:120); NX uses 1.0, or 0.0 when Risky=1. Display only.
- **[NX-only]** HAZARD, the per-frame `Damage(Good)` during holds, and drum-screen aggregation.
- **[NX-only]** [ADD] The "no Gt/Bs chips → immediate STAGE FAILED" rule has no equivalent in GPS.
- **[AI-dev]** `BassAutoLanes` defaults to all ON (AICFG:139-141; NX defaults to all OFF). This keeps a keyboard player's bass part from failing immediately.

---

### 3. Combo (CPC:1604-1615, 1953-1981; CMB:75-108)

```
on judged Gt/Bs chip:  j∈{Perfect,Great,Good} → combo[part]++ ;  else (Poor, Miss) → combo[part] = 0
   NO AUTO gate (drums gate on bAllDrumsAreAutoPlay || !auto, CPC:1553) → AUTO chips build combo
setter: if combo > HighestValue[part]: HighestValue[part] = combo      (MaxCombo)
```

**What breaks combo:**
- **Poor** (a pick inside the Poor window).
- **Miss**, from either source:
  - a pass-through miss (CPC:2914-2918);
  - an AutoPick hit that fails the lane test (CPC:4373-4388), which calls `tProcessChipHit(…, bCorrectLane:false)` → Miss (CPC:4397-4401).
    - [ADD] This can also hit an **AUTO chip**. Example: the chip's lanes are all AUTO, but the player holds a manual fret the chip does not have. NX then counts IncAuto Miss only, with no gauge (unless AutoAddGage) and no Early/Late, but combo still resets.
- **Bad**: an empty pick, a wrong-fret pick, or a pick whose nearest chip is outside the Poor window, when `!bLight`. It sets `combo = 0` and runs `Damage(Miss)`, but **no counter, no Early/Late, no MaxCombo change** (CPC:1953-1981, 5503-5512). With `bLight` (the default), an empty pick only plays a sound.
- **[NX-only]** Auto-ghost lag above 255 (bit 8) resets combo (CPC:4317-4324). This applies only with `eAutoGhost != PERFECT` and ghost data.

**[ADD] NX does not gate manual pick handling on AutoPick.** No early return exists between CPC:4877 and the pick loop at 5421; the comment at 5420 claims otherwise. A pick press under AutoPick can therefore still judge an approaching chip by timing, or produce a Bad when Light is OFF.

**What does not affect combo:** wailing, LN ticks, LN release or cancel, LN-end chips, and drum chips in GR mode (auto-played sound only, CPG:552-560).

**Uses of combo:**
- the score coefficient (post-increment);
- the wailing bonus (current combo);
- the achievement rate (`HighestValue`).

In training, reaching the loop end resets combo and `HighestValue` (CPG:311-327).

DTXManiaAI (GPS:1076-1084, 1116-1135):
- Identical rules, including the ungated AUTO combo and Bad not counting. `p.MaxCombo` mirrors `HighestValue`.
- **[AI-dev]** [ADD] Under AutoPick, manual picks and the pass-through loop are skipped entirely (GPS:783-808). There are no Bads and no early manual hits.
- **[AI-dev]** [ADD] An AutoPick lane-test Miss is always judged as non-AUTO (`chipIsAuto && !miss`, GPS:987). It goes into `Counts[Miss]` and applies the gauge even when the chip is AUTO.

---

### 4. Achievement rate, skill, rank, FC/Excellent

#### 4.1 Achievement (performance skill), XG: `tCalculatePlayingSkill` (INI:1641-1665)

```
if N == 0: 0
auto  = N − (P+G+Gd+Po+M)                // ExclAuto counts → auto = AUTO chips + not-yet-judged chips
pRate = 100·P/N; gRate = 100·G/N; cRate = (N == auto) ? 0 : 100·MaxCombo/N     // MaxCombo includes AUTO chips
rate  = (pRate·0.85 + gRate·0.35 + cRate·0.15) × revise(part)
```

The maximum is 100 when P = N and MaxCombo = N (revise 1).

When it is computed:
- **Result:** with ExclAuto counts and `HighestValue` (CPC:161, 232).
- **Live:** recomputed after every Gt/Bs chip hit (CPG:352-415) and stored in `actStatusPanel.db現在の達成率`. It is drawn on the status panel and fed to the skill graph when `bGraph有効`. With an ONLINE target ghost, the graph instead gets `100·(17P + 7G + 3·MaxCombo)/(20N)` (CPG:365-375).

**Revise** `dbCalcReviseValForDrGtBsAutoLanes` (INI:1863-1936). This is not the same as the score `rev`:

```
if bAllXAreAutoPlay: 1.0
r = 1.0;  if Pick: r /= 2;  n = #AUTO among {R,G,B,Y,P};  r /= sqrt(n + 1)       // W ignored
```

Examples:

| AUTO setting | Achievement revise | Score `rev` |
|---|---|---|
| AutoPick only | ½ | ½ |
| One neck lane | 1/√2 ≈ 0.7071 | ½ |
| Five neck lanes, manual pick | 1/√6 ≈ 0.408 | ½ |
| AutoPick + all five neck lanes (= all-AUTO) | 1.0 (but P=0 and cRate=0, so rate 0) | 0, or 1 with AutoAddGage |

**Game skill, XG: `tCalculateGameSkillFromPlayingSkill`** (INI:1623-1640):

```
lv   = LEVEL ≥ 100 ? LEVEL/100 : LEVEL/10 + LEVELDEC/100
gameSkill = rate × lv × 0.2
```

It returns 0 if `bLivePlay && bDrumsEnabled && bAllDrumsAreAutoPlay`. In GR mode `bDrumsEnabled` is false (CFG:895-901), so this never triggers there.

**Classic mode [NX-only]:**
- Performance skill: `((0.8P + 0.2G + 0.2·MaxCombo)/N)·100 × revise` (INI:1764-1796). Drums use 0.3 for G. There is no combo zeroing.
- Game skill: `LEVEL × ((0.8P + 0.2G + 0.2·MaxCombo)/N) × 0.33 × revise` (INI:1726-1763). LEVEL is raw (for example 74) and LEVELDEC is unused.
  - Quirk: it returns 0 whenever `bAllDrumsAreAutoPlay`, which is the drum-lane flag, even for guitar.
- Live game skill on the classic panel: `rate × LEVEL × 0.0033` (GSP:460-463).
  - [FIX] That panel style (`bCLASSIC`) is also used in XG mode when `bCLASSIC譜面判別を有効にする` is on, the part has no Y/P chips and XG is not forced (GSP:376-382). The stored result still uses the XG formula.

#### 4.2 Rank

Thresholds (INI:1534-1612): SS ≥95, S ≥80, A ≥73, B ≥63, C ≥53, D ≥45, else E. `ERANK` values: SS=0 … E=6, UNKNOWN=99 (INI:151-161).

NX uses three different inputs depending on where the rank is shown:

| Where | Function | Input |
|---|---|---|
| Result rank image and `BestRank` | `tCalculateRank(part)` (RES:127-134; INI:1462-1470, 1565-1612) | Counts-based, see below |
| History line, single part | `tCalculateRank(0, dbPerformanceSkill)` (APP:1590, 1598) | Thresholds on the stored performance skill (revise included, denominator N). `rate == 0` → UNKNOWN, written as "Cleared (No chips)" (APP:1603-1606) |
| History line, G+B | `tCalculateOverallRankValue` (APP:1583; INI:2018-2032) | Used when both entries have ≥1 non-AUTO judgment (`!b全AUTOである`). Sums over the parts: total = ΣN, ExclAuto counts, ΣMaxCombo. Denominator = Σjudged; returns SS if nothing was judged. Classic mode uses `tCalculateRankOld` |

[ADD] The single-part history line falls through to the Bass branch (APP:1594-1599) whenever the guitar entry does not qualify, even when bass is also all-AUTO.

The counts-based result rank works like this:
- It is UNKNOWN unless an input device was flagged for that part (`bKeyboardUsed || bMIDIUsed || …`).
  - [ADD] The flag is weak. `tSaveInputMethod(inst)` runs every frame for both parts (CPC:5318-5326 → 2701-2719) and copies the global `CPad.stDetectedDevice`. That global is set by any assigned-key press (PAD:63-87, 112-140) and cleared at song load (APP:1137). So any mapped input during the play marks both Gt and Bs as "used".
- `T = P+G+Gd+Po+M` uses the entry counts, which are IncAuto if the part is all-AUTO and ExclAuto otherwise.
- `rate = 100·(0.85P + 0.35G + 0.15·MaxCombo)/T`, with **no revise and denominator T, not N**. NX's own comment at INI:1577-1579 calls this "probably wrong".
  - [ADD] Because the caller passes `nTotal = T`, the internal `nAuto` is always 0. The `nTotal <= nAuto → SS` branch is dead, and T=0 → UNKNOWN.
- Under AutoPick partial AUTO, MaxCombo (which includes AUTO chips) can exceed T and inflate the rank.
- RRK:139-144: rank E/UNKNOWN on an all-AUTO part is drawn as SS. [ADD] On a manual part, UNKNOWN is drawn as E, and −1 draws no rank image (RRK:146-148).
- [ADD] `nRankValue` and the result rates are computed only inside the RES:90 guard (score.ini output on, not training, speed ×1 or `SaveScoreIfModifiedPlaySpeed`). Otherwise they keep stale values from the previous result.

Classic rank (`tCalculateRankOld`, INI:1688-1725): `(P+G)/(T−auto)`; 1.0 SS, ≥.95 S, ≥.90 A, ≥.85 B, ≥.80 C, ≥.70 D, else E.

#### 4.3 Full combo and Excellent (four different definitions in NX) [FIX: was "three"]

1. **FC bonus** (§1.5): `ExclAuto.Miss + ExclAuto.Poor == 0`. Bads are ignored. Excellent if Perfect == N (IncAuto when all-AUTO).
2. **`bIsFullCombo`**, used for the result banner and the song-list FC lamp (INI:316-322; lamp RES:160, 251):
   - `MaxCombo > 0 && MaxCombo == P+G+Gd+Po+M`, using entry counts.
   - A mid-song Bad breaks it. A Bad before the first chip or after the last chip does not.
   - [FIX] It is unreachable (barring a coincidence of run lengths) only when at least one chip is AUTO-judged. That requires AutoPick, because MaxCombo counts AUTO chips while ExclAuto counts exclude them. With manual pick and AUTO neck lanes, no chip is AUTO and FC is reachable. An all-AUTO part reaches FC through its IncAuto counts.
3. **Excellent banner** (RRK:196-210): `nPerfectCount == nTotalChipsCount`. The banner shows Excellent, otherwise FullCombo, otherwise StageCleared.
4. [ADD] **Result sound** (RES:544-584). This loop runs over the shown parts with `bAuto[i] == false`:
   - `fPerfect率 == 100.0` → Excellent sound;
   - else `fPoor率 == 0 && fMiss率 == 0` → FullCombo sound (ExclAuto counts, Bads ignored);
   - else Stage clear.

   A later part overwrites an earlier one, so a bass FC downgrades a guitar EXC. All-AUTO parts never trigger a sound. The rates come from the RES:90 guard, so they are stale in training.

DTXManiaAI:
- `AchievementRate` (PR:87-98) uses `comboRate = AllLanesAuto ? 0 : …`, revise = `GBAutoLaneReviseValue` (PR:231-243, same as NX). The live copy is GPS:3164-3171.
- `Skill = rate × LevelFactor × 0.2`; it is 0 for all-AUTO (PR:127-141).
- **[AI-dev]** NX zeroes the combo rate when `N == auto`. That also covers "no manual judgment yet" during live play, and AutoPick runs where every judged chip was AUTO. The AI zeroes it only when the config is all-AUTO.
- **[AI-dev] Rank** = thresholds applied to `AchievementRate` (PR:246-260). That is NX's history-line rank, **not** NX's counts-based result rank (denominator T, no revise, device gate).
  - Rate 0 gives "E" where NX gives UNKNOWN.
  - All-AUTO is always drawn as SS (ARS:808-813).
- **[AI-dev] `FullCombo`** = `Ok==0 && Miss==0 && N>0 && Σcounts>0` (GPS:1288). It ignores Bads, unlike NX `bIsFullCombo`. It is reachable with AutoPick partial AUTO, where NX's is not.
- **[AI-dev] Excellent** = `Counts[0] == N` using ExclAuto (ARS:283-286; REC:143 additionally requires FullCombo). An all-AUTO part is never Excellent. NX shows the Excellent banner there because the entry uses IncAuto counts.
- The AI result sound follows the banner (ARS:235-254). NX's sound excludes AUTO parts while its banner does not.
- **[NX-only]** Classic formulas and the counts-based rank.

---

### 5. Counts shown

**NX in-play status panel** (GSP:384-467; drawn only when `nInfoType == 1`, CPG:202-203):
- Perfect/Great/Good/Poor/Miss as ExclAuto, plus MaxCombo (`HighestValue`), each as `{0,4:###0}`.
- Rates: `Round(100·count_ExclAuto / Σ IncAuto counts so far)` as `{0,3:##0}%`; NaN → 0.
- Achievement `{0,6:##0.00}`, replaced by the `7_skill max` image when ≥100.
- Game skill (XG formula, or `rate·LEVEL·0.0033` on a `bCLASSIC` panel, see §4.1).
- Early/Late if `bShowLagHitCount`.
- [FIX] In training, `db現在の達成率.Guitar` (index Guitar even on the bass panel) is set to 0 every frame and the rates are not recomputed (GSP:401-404). The CPG:359/391 update on each hit then overwrites the value until the next frame.

**NX Early/Late** (CPC:1907-1945):
- Counted for non-AUTO chips only, for every judgment (Miss included), and for Gt/Bs only when screenmode is GUITAR.
- `nLag > 0` → Late, else Early. Bad is not counted.
- A non-AUTO AutoPick lane-test Miss has `nLag = 0` → Early (CPC:4399).
- Under AutoPick, a non-AUTO chip's lag equals `nInputAdjustTimeMs`.

**NX result panel** (RPP:260-309, 530-649):
- One panel per part with chips: guitar at X=136 (left), bass at X=850 (right); swapped under FLIP.
- Counts: Perfect…Miss **ExclAuto**, plus MaxCombo.
- Rates: `fRate = allAuto ? 0 : 100·nXCount/N` (RES:119-123; `nXCount` is IncAuto when all-AUTO). MaxCombo rate is `Round(100·MaxCombo/N)` (RPP:565) and is not zeroed for AUTO.
- Performance skill (or the MAX image when ≥100).
- Game skill, level `{0:0.00}` = LEVEL/10 + LEVELDEC/100 (or `{0:00}` classic), score `{0,7:######0}`, progress bars, Early/Late.
- Rank image and Excellent/FC/Clear banner (RRK).
- The NEW RECORD image loop only checks `bNewRecordSkill[0]` (Drums), so it never appears in GR mode (RPP:620-626).

**DTXManiaAI:**
- Live status panel (GPS:3143-3194): same counts, rates and denominators as NX. Game skill always uses the XG formula.
- Result (ARS:611-731): `Counts` (ExclAuto) and MaxCombo; rates `Round(100·count/N)`, 0 for an all-AUTO part (matches NX); `AchievementRate`, `Skill`, score, rank and banners.
- Non-NX layout: shows the primary part plus a summary line for the sub part. [FIX] The summary is built in ARS:276-279/293+; primary and sub are chosen in GPS:1267-1271.
- **[AI-dev]** NEW RECORD is shown per part (ARS:211-212, 688-691).
- **[AI-dev]** Early/Late also counts **AUTO chips**: `JudgeChip` increments for every chip, and AutoPick passes lag 0, so they count as Early (GPS:987, 1097). NX excludes AUTO chips.
- **[AI-dev]** [ADD] Progress-bar section hits count AUTO chips too (GPS:1099); NX requires `!auto` (CPC:1489).
- **[AI-dev]** AutoPick hits are always judged Perfect (GPS:987). NX judges non-AUTO chips under AutoPick with `|nInputAdjustTimeMs|` as the lag (CPC:4395 → 1447-1448), so a large input adjust can produce Great or Good.

---

### 6. Per-part separation and records

**Per-part state.** All of the following are indexed by part, and both parts run simultaneously on the GR screen:
- score (true and display), combo and `HighestValue`
- IncAuto/ExclAuto counts, gauge
- LN hold state and `LNacc`, wailing queue, Early/Late

[FIX] Where each is reset on stage start:
- counts, Early/Late, wailing queue, LN state and `LNacc`: CPC:315-333
- score: SCO:125-135
- combo: CMB:613-628
- gauge: `Init`, CPC:370

STAGE FAILED is shared: either part failing fails the stage.

**NX result entries.** `tStorePerfResults_Guitar` and `tStorePerfResultsBass` (CPC:147-286) fill a `CPerformanceEntry` only if the part has chips. Otherwise the entry is empty, with `nTotalChipsCount = 0`. A filled entry holds:
- `nスコア = (long)trueScore`
- `dbPerformanceSkill`, `dbGameSkill`
- `nXCount` (IncAuto when all-AUTO, else ExclAuto) and `nXCount_ExclAuto`
- `nMaxCombo`, `nTotalChipsCount = N`
- AUTO flags, options, device-used flags, hit ranges (primary = Gt/Bs ranges, secondary zeroed), progress string, MD5 hash

FLIP: the Gt/Bs entries, timing counts, chart info and AUTO flags are swapped back before saving (APP:1547-1563; on failure APP:1364-1370).

**NX score.ini.** Sections: `HiScoreGuitar=2, HiSkillGuitar=3, HiScoreBass=4, HiSkillBass=5, LastPlayGuitar=7, LastPlayBass=8` (INI:41-150).

On clear, the update runs only if `bScoreIniを出力する && !training && (speed == ×1 || SaveScoreIfModifiedPlaySpeed)` (RES:90).

[FIX] RES:98-100 (Gt/Bs only in GR, and only with chips) gates only the rate and rank computation. The save loop RES:152-229 iterates all three parts. Its only gate is RES:153, "not all three parts config-all-AUTO", which is effectively always true in GR because drum lanes default to manual. Inside the loop:
- `BestRank[i]` is updated if `nRankValue[i] ≥ 0` and better (RES:169-173). [ADD] There is **no AUTO gate**: an all-AUTO part with the device flag set gets rank SS (100) from IncAuto counts.
- HiScore is replaced if `nスコア` is higher (RES:176-181). [ADD] There is **no AUTO gate**: an all-AUTO play has `nスコア = 30000` from the unrevised Excellent bonus, so it can become HiScore. Its entry is FC (IncAuto counts), which later feeds the sticky FC lamp through RES:160.
- HiSkill is replaced if `dbPerformanceSkill` is higher and the part is not config-all-AUTO (`bAuto[i]`, RES:184-189).
- LastPlay is written if `bAuto[i] == false` (RES:193-197). [ADD] `bAuto[i]` is only refreshed for parts that pass RES:98-100 (RES:124) and is otherwise stale (a field, RES:26). A part without chips, including drums in GR, can therefore have its LastPlay overwritten with an empty entry.
- `ClearCountGuitar/Bass++` when `bGuitarEnabled && chips && !allAuto` (RES:201-220; INI:2012-2017).

Other updates:
- `PlayCountGuitar/Bass++` under the same `tGetIsUpdateNeeded` condition, on clear and on failure, together with the history line (APP:3066-3081). It runs only when not training (APP:1361, 1545) and has no speed gate.
- The song-list FC lamp is sticky (`|=`). HighSkill, BestRank and progress are updated, all gated by `tGetIsUpdateNeeded` (RES:238-272).

On STAGE FAILED, NX writes only:
- PlayCount and the history line ("Stage failed Guitar / Bass / G+B");
- the progress-bar record (`LastPlay*.strProgress`, and `HiSkill*.strProgress` when the bar got longer).

HiScore, HiSkill and BestRank are untouched (APP:1341-1457). [ADD] NX then goes straight to song select, with no result screen (APP:1494-1507).

**[NX-only] training.** Skip forward/back, LoopCreate, or a speed change sets `bIsTrainingMode` (CPC:2418-2479). In training:
- STAGE FAILED is suppressed (CPG:168).
- Nothing is saved (APP:1361, 1545; RES:90).
- At the loop end, `tJumpInSong` runs (CPG:309). Then ExclAuto counts, combo, `HighestValue`, true score and Early/Late reset for Gt/Bs (CPG:311-327). IncAuto counts and the gauge are **not** reset. [FIX] `LNacc` and the hold state **are** reset, by `tJumpInSong` (CPC:5622-5628).
- The Gt/Bs score display freezes (GSC:58-61).
- Backward jumps un-hit chips (CPC:5634-5666). As a result, `combo > N` is possible and the all-Perfect correction can fire spuriously, with a negative delta.

**DTXManiaAI** (GPS:1261-1303; REC:99-160; ARS:187-233):
- One `PerformanceResult` per part with chips.
- The primary result is the manually played part (guitar if both are manual); the other becomes the sub result. Both are submitted.
- Records are keyed by chart path plus instrument (`|guitar`, `|bass`) (REC:25-34).
- **[AI-dev]** Under FLIP, AUTO, key and scroll settings stay with the screen side; records, level and result follow the chart instrument (GPS:30-32, 84-86). NX swaps the AUTO flags along with the parts.
- Recordable when not training, not config-all-AUTO, and speed is ×1 or `SaveScoreIfModifiedPlaySpeed` (PR:149-154). This gate also applies to PlayCount, unlike NX.
- **[AI-add]** A result screen is shown after STAGE FAILED (ARS:244-251, 723-730).
- STAGE FAILED updates only PlayCount and merged section lamps (REC:118-125).
- Clear updates (REC:131-156):
  - BestScore (+HiScore counts), BestMaxCombo, BestRank (rate-based);
  - sticky FullCombo/Excellent/Cleared;
  - merged lamps;
  - BestRate (+HiSkill counts);
  - PlayCount.
- **[AI-dev]** `score.ini` is written only on clear and is regenerated from records (ARS:216-233). The Gt/Bs `AutoPlay=` field is zero-filled (SIE:171).
- **[NX-only]** GR-mode training (loop/skip/speed; `Training = false`, GPS:1290), the counts-based rank, BestRank from counts, ClearCount, and the AUTO-ungated HiScore/BestRank writes.

---

### Deviation index (DTXManiaAI vs NX)

| # | Item | NX | DTXManiaAI |
|---|---|---|---|
| 1 | All-Perfect correction, N<50 | ×N multiplier → ≠1e6 (bug) | always 1e6 + LN at rev 1 (PR:199-200) |
| 2 | Score accumulation | double, fractional rev kept, truncate once | int, truncate each add, clamp 0..9,999,999 (GPS:1149-1151) |
| 3 | FC/Excellent bonus | +30000/+15000, no rev, skill mode 1 only | via AddScore, so rev applied (GPS:1226) |
| 4 | Wailing duplicates | same chip can pay twice | deduplicated (GPS:1013) |
| 5 | Risky gauge | both bars drop; init 1.0 or 0 | judged part only; init 2/3 |
| 6 | Gauge constants | float32 widened | double literals |
| 7 | HAZARD, hold `Damage(Good)`, drum-screen gauge aggregation, no-chips fail | present | absent |
| 8 | Classic mode (`nSkillMode=0`) | present | absent |
| 9 | Combo-rate zero rule | `N == auto` (includes "nothing manual judged yet") | config all-AUTO only |
| 10 | Result rank | counts-based (denominator T, no revise, weak input-device gate) | rate thresholds (= NX history-line rank) |
| 11 | FullCombo | `MaxCombo == Σcounts` (Bad breaks it; unreachable once an AUTO chip is judged) | `Ok == Miss == 0` |
| 12 | Excellent, all-AUTO part | yes (IncAuto counts) | no (ExclAuto counts) |
| 13 | Early/Late, progress hits | non-AUTO chips only | include AUTO chips (always Early) |
| 14 | AutoPick judgment | timing judged with `\|adjust\|` for non-AUTO chips | always Perfect |
| 15 | Bass AUTO default | all OFF | all ON (AICFG:141) |
| 16 | NEW RECORD on result panel | never in GR (loop checks `[0]` only) | shown per part |
| 17 | GR training (loop/skip/speed) | supported | not supported |
| 18 [ADD] | Manual pick under AutoPick | still processed (early hits, Bads) | ignored (GPS:783-797) |
| 19 [ADD] | AutoPick lane-test Miss of an AUTO chip | IncAuto only, no gauge (unless AutoAddGage) | counted as manual Miss, gauge applied (GPS:987) |
| 20 [ADD] | HiScore/BestRank of an all-AUTO play | written (no AUTO gate; score 30000) | not recordable |
| 21 [ADD] | STAGE FAILED | song select, no result screen | result screen shown |
| 22 [ADD] | FLIP AUTO flags | swapped with parts | stay with screen side |

### Notes for the web port

- Reuse `scoreDelta` (`js/game/judge.js:20-31`) with `bonusChipCount = 0`. Then:
  - add `+LNacc` in the correction branch;
  - pass IncAuto Perfect for the correction test and ExclAuto Perfect for the ×50 exemption (the current signature has one `perfectCount`);
  - keep every chip (including AUTO chips) scored and multiply by `rev` ∈ {1, ½, ¼, 0}.

  The correction is then revised again: under AutoPick the all-Perfect total is about 749k, not 500k (§1.2).
- Use a separate gauge table: `[0.006, 0.003, 0, −0.030, −0.050]`. Use `Math.fround` if NX bit-exactness is wanted.
- The skill revise is `½^pick / √(nNeckAuto + 1)`, which differs from the score `rev`. Neither depends on W.
- Combo is not gated by AUTO for Gt/Bs. Bad resets combo and damages the gauge as a Miss, but counts nothing, and only when Light is OFF.
- Decide explicitly whether to follow NX or DTXManiaAI for rows 1, 3, 10, 11, 13, 18, 19 and 20 of the deviation index, and record the choice in the code or docs, as `CLAUDE.md` requires.
