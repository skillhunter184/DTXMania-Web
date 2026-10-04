# gb-judge

# Guitar/Bass input handling and judgment: NX (primary) vs DTXManiaAI (porting base) (VERIFIED)

**Path prefixes.** NX paths are relative to `DTXmaniaNX/DTXMania/Code/`. DTXManiaAI paths are relative to `DTXManiaAI/Assets/Scripts/`.

**Abbreviations.**
- `PC` = `Stage/07.Performance/CStagePerfCommonScreen.cs`
- `GS` = `Stage/07.Performance/GuitarScreen/CStagePerfGuitarScreen.cs`
- `CI` = `App/CConfigIni.cs`
- `CH` = `Score,Song/CChip.cs`
- `DX` = `Score,Song/CDTX.cs`
- `EC` = `Score,Song/EnumConverter.cs`
- `GA` = `Stage/07.Performance/CActPerfCommonGauge.cs` **[FIX]** (the draft called it `Gauge.cs`)
- `GPS` = `Stages/GuitarPerformanceStage.cs` (DTXManiaAI)
- `AIC` = `Config/ConfigIni.cs` (DTXManiaAI)
- `AIX` = `Song/DtxChart.cs` (DTXManiaAI)

**Legend.**
- **[AI≠NX]**: DTXManiaAI deviates from NX.
- **[NX-only]**: NX behaviour that DTXManiaAI skipped.
- **[NX quirk]**: an NX bug or oddity. The port has to decide whether to keep it.
- **[FIX]**: the draft was wrong here. **[ADD]**: the draft left this out. Unmarked text was checked against the source and is correct as written.
- "now" is the performance-timer song time in ms (`rcPerformanceTimer.nCurrentTime`).
- `adj[part]` is InputAdjustTime (see §9).
- `EJudgement { Perfect=0, Great=1, Good=2, Poor=3, Miss=4, Bad=5, Auto }` (`App/CConstants.cs:191-200`).

---

## 0. Data model used by this section

**Fret bits.** R=4, G=2, B=1, Y=16, P=32. OPEN = 0 (`PC:5454`). The channel→bits mapping is the full 32-entry table in `EC:11-141`.
- `GetArrayBoolFromEChannel` throws `NotImplementedException` for any channel outside the table, for example a wailing channel (`EC:187-211`).
- DTXManiaAI uses the same bits in `GBNote.Bits` (`AIX:39-50`, `AIX:124-155`). I checked its tables entry by entry against `EChannel.cs`.

**Instrument part** (`DX:6881-6894`):
- GUITAR: `0x20-0x27, 0x93-0x9F, 0xA9-0xAF, 0xD0-0xD3`.
- BASS: `0xA0-0xA7, 0xC5, 0xC6, 0xC8-0xCF, 0xDA-0xDF, 0xE1-0xE8`.
- Everything else is UNKNOWN, including:
  - wailing chips `0x28/0xA8`
  - LN control chips `0x2C/0x2D`
  - no-chip sound chips `0xBA/0xBB`
  - wailing-sound chip `0x2F`

  UNKNOWN chips never Miss, are not counted as notes, and judge with the default DTX ranges (`PC:1014-1017`).

**Visible-chip predicates.** `bGuitar可視チップ` and `bBass可視チップ` are at `CH:179-225`. The `_Wailing含む` variants add `0x28/0xA8`.
- **[NX quirk]** `bBass可視チップ` tests the range `0xDA..0xE8` (`CH:215-219`), so it also accepts `0xE0` (BGALayer8_Swap, `EChannel.cs:181`).
  - A not-yet-passed `0xE0` chip can be found by the bass pick search (§2). `GetArrayBoolFromEChannel(0xE0)` at `PC:5448` then throws.
  - **[ADD]** The bass empty-pick fallback (§3.1, which uses DontCare) can also return a `0xE0` chip. It then plays whatever WAV has the BMP's internal number.
  - Do not port this.
- DTXManiaAI uses explicit channel tables (`AIX:128-139`).

**Open chip.** `0x20`/`0xA0` (`CH:52-64`).

**Empty chips** are excluded from every search (`CH:429-456`, `PC:2045`). **[FIX]** The range is `0xB1-0xBE` (HH…RD `0xB1-0xB9`, plus `0xBA`, `0xBB`, `0xBC`, `0xBD`, `0xBE`), not `0xB1-0xBC`.

**Same-time chips in one part.** **[FIX]**
- `listChip` is sorted with `List.Sort()` (`DX:3654, 3712`), which is unstable. The comparer orders by `nPlaybackPosition`, then by a priority table, lower value first (`CH:596-640`).
- Not all guitar/bass channels have priority 7:

  | Priority | Channels |
  |---|---|
  | 7 | `0x20-0x27`, `0x93-0x9F`, `0xA0-0xA7`, `0xA9-0xAF`, `0xD0-0xD2` |
  | 5 | `0xD3` (Guitar_RGBYP); bass `0xC5-0xCF` and `0xDA-0xE8`; `0x28`; `0xA8` (`CH:602, 609-614`) |

- So at the same position, a bass extended-channel chip such as `0xC5` sorts **before** `0xA1`. Only chips with equal priority are in unspecified order.
- A part can contain two chips at the same time if they use different channels. Neither NX nor DTXManiaAI merges them (`AIX:494-508`).
- DTXManiaAI sorts by `TimeMs` only (`AIX:574-575`).

**Test charts** (the test pack (完全感覚Dreamer; `tests/fixtures/local/`, not in git), re-scanned). None of these use `0xBA/0xBB`, `0x2F` or `0xAF`.
- `gt_*`: `0x28`×4, `0x2C`×12, which pair into 6 long notes in every chart. `gt_ext`/`gt_mst` add OPEN `0x20` (4 and 39 chips).
- `ba_*`: `0xA8`×3, `0x2D`×26, which pair into 13 long notes in adv/ext/mst. `ba_mst` adds OPEN `0xA0`×32.
  - **[FIX]** `ba_bsc` has only **12** long notes. Its `0x2D` chips at measure 41, ticks 144 and 172 have no bass chip at their position, so both are ignored as start markers (§7 orphan rule).
- No part has two chips at the same position.
- So the port's must-have paths are:
  - picks
  - OPEN notes
  - long notes, **including orphan control chips** **[ADD]**
  - wailing
  - the empty-pick fallback sound (nearest chip)

---

## 1. Input model

### 1.1 Pads and bindings

- Each part has logical pads `R, G, B, Y, P` (neck), `Pick`, `Wail`, plus `Decide`, `Cancel` and `Help` (`App/CConstants.cs:57-84`).
- Each pad holds up to 16 bindings (`CI:4101`).
- **Default bindings** (`CI:4212-4234`; key codes resolved with `FDK/Code/02.Input/SlimDX.DirectInput.Key.cs`):

  | Part | R | G | B, Y, P | Pick | Wail | Decide / Cancel |
  |---|---|---|---|---|---|---|
  | Guitar | `K054` (F1) | `K055,J012` **[FIX]** | `K056..K058` (F3..F5) | `K0115` (`]`), `K046` (`:`), `J06` | `K0116` (RightCtrl) | `K060` (F7) / `K0115` |
  | Bass | `K090` (Num1) | `K091,J013` **[FIX]** | `K092..K094` (Num3..5) | `K0103` (Num.), `K0100` (NumEnter), `J08` | `K089` (Num0) | `K096` (Num7) / `K0103` |

  - **[ADD]** Cancel shares a key with the first Pick binding in both parts.
  - DTXManiaAI translates the defaults as follows (`AIC:159-172`). It drops the joystick buttons.
    - Guitar: F1–F5, Pick = `]` / `:`(Quote), Wail = RightCtrl
    - Bass: Numpad1–5, Pick = NumpadPeriod / NumpadEnter, Wail = Numpad0

- **Neck is a level input.** `CPad.bPressing` checks Keyboard, Joypad and Mouse only. A MIDI binding can never be "held" (`App/CPad.cs:212-254`).
  - The neck is sampled once per `tHandleInput_GuitarBass` call (`PC:5308-5315`), i.e. at processing time, not at the pick event's time.
  - DTXManiaAI does the same: `PressingAny` (`Input/InputManager.cs:115-123`; `GPS:829-836`), and MIDI `Pressing` always returns false (`Input/MidiInput.cs:360-363`).
- **Pick and Wail are edge events.**
  - `CPad.GetEvents` returns every input event of every device that matches any binding, device by device. Events are not merged by timestamp (`App/CPad.cs:43-97`).
  - **[ADD]** An event is appended once per matching binding entry (`CPad.cs:53-91`). A key listed twice in one pad's bindings therefore yields two picks per press.
  - The handler keeps only `b押された` events (`PC:5426, 5520`).
  - Each pick event carries its own timestamp: `t = ev.nTimeStamp − timerResetSystemTime` (`PC:5432`).
  - Every press event is a separate pick, so pressing two Pick bindings in one frame gives 2 picks (alternate picking).
  - **[AI≠NX]** DTXManiaAI uses `PressedAny(p.Pick)`: at most one pick per frame per part, timed at the frame's `songMs` (`GPS:795-796`). DTXManiaAI documents this as intentional ("判定はフレーム時刻基準", `docs/20_guitar-bass-mode.md:119`). The same applies to Wail (`GPS:811-812`).

### 1.2 AUTO flags and mask

- Config `[AutoPlay]` keys: `GuitarR/G/B/Y/P/Pick/Wailing` and `BassR..BassWailing` (`CI:2302-2318`). All default to 0 (`CI:1420-1433`). They are copied to the stage at entry (`PC:367`).
- The mask (`PC:4887-4900`):
  ```
  autoMask = (R?4) | (G?2) | (B?1) | (Y?16) | (P?32) | (W?8)
  ```
  Bit 8 never appears in a chip.
- DTXManiaAI uses the same mask (`GPS:417-419`).
- "All AUTO" (`bAllGuitarsAreAutoPlay` / `bAllBassAreAutoPlay`) means R..P and Pick, **excluding Wailing** (`CI:916-943`).
- **[AI≠NX]** DTXManiaAI defaults the Bass AUTO flags to all ON (`AIC:139-141`).

### 1.3 `bCheckAutoPlay(chip)`: is a chip an AUTO chip? (`PC:3721-3784`)

```
GUITAR/BASS chip: isAuto = autoPick[part]
                  && (for each fret in chip: autoFret)
                  && (chip is OPEN ⇒ all five frets AUTO)
```
- The wailing clause at `PC:3757/3775` is unreachable, because wailing chips are UNKNOWN.
- A chip is never AUTO while Pick is manual.
- DTXManiaAI: `GPS:979-985`.

### 1.4 Per-frame visuals only (no judgment)

- Every held fret gets a lane flush and an RGB button highlight each frame (`PC:5328-5352`).
- `ref` is the held long-note chip if there is one (`PC:4905`). Otherwise it is `NextChip(part)` (`PC:2294-2307`).
  - **[FIX]** `NextChip` is not "the nearest" chip. It calls `Search(now, adj, range=800, pastPriority=true, NotHit, part)`. That returns the **latest** unhit chip of the part at or before `now+adj` within 800 ms, or else the first unhit future chip within 800 ms.
  - `adj` is used only when Pick is manual.
- AUTO frets contained in `ref` also flush, every frame while `ref` exists, so up to ~800 ms before the chip (`PC:5240-5292`). `ref`'s bits are kept as `chipFlag` for the long-note check (`PC:5302`).
- Decide held + B pressed → scroll speed +1, capped at 1999 (`0x7cf`). Decide + R → −1, floored at 0 (`PC:4866-4875`). This runs before the guard in §1.5.

### 1.5 Guard

- `tHandleInput_GuitarBass` returns at once if `!bGuitarEnabled || !bチップがある[part]` (`PC:4877-4880`).
- It is never called while paused or in STAGE FAILED (`PC:2363-2370`).
- DTXManiaAI: a part with no notes and no wailing chips is skipped, and pause returns before any processing (`GPS:771-772, 576-580`).

---

## 2. Chip search `r指定時刻に一番近いChip(t, search, adj, range=0, pastPriority=true, hitState=NotHit, part=UNKNOWN)` (`PC:1984-2075`)

```
T = t + adj
Found(c) = hitStateOK(c) && !c.isEmptyChip &&                               // PC:2043-2058
           ( ((c.ch == search || c.ch == search+0x20) && c.isDrumVisible)
          || (c.ch == search && (c.isGuitarVisibleInclWailing || c.isBassVisibleInclWailing))
          || (part == GUITAR && c.isGuitarVisible)
          || (part == BASS   && c.isBassVisible) )
  // part=GUITAR/BASS: any guitar/bass-visible chip of that part. In practice `search` adds nothing (checked for all EC channels).
  // part=UNKNOWN: only c.ch == search (used for wailing chips 0x28/0xA8)
Past(c)       = c.time <= T
Future(c)     = c.time >  T                                                  // PC:2059-2074
OutOfRange(c) = range > 0 && |T − c.time| > range                            // range <= 0 → unlimited  [ADD]

fut = −1
for i = topChip .. end:                                                      // PC:1993-2006
  if Future(c_i) && OutOfRange(c_i): break      // ANY chip, so the first out-of-range future chip ends the scan
  if Found(c_i) && Future(c_i): fut = i; break  // first matching future chip
past = −1
for i = (fut ≥ 0 ? fut : lastIndex) down to 0:                               // PC:2007-2019
  if Past(c_i) && OutOfRange(c_i): break
  if Found(c_i) && Past(c_i): past = i; break   // nearest (highest-index) matching past chip
res = past ≥ 0 ? c[past] : (fut ≥ 0 ? c[fut] : null)                         // PC:2020-2030
if !pastPriority && both found: res = (|T−fut.time| >= |T−past.time|) ? past : fut   // tie → past (PC:2031-2036)
if res && OutOfRange(res): res = null                                        // PC:2037-2040
```

**For a pick** (`PC:5439-5441`): `range = Poor[part]`, `pastPriority = true`, `NotHit`, `part = inst`.
- The `search` channel is built from the held frets (`EC:143-171`). It has no effect, because `part = GUITAR/BASS` matches every visible chip of the part.
- The search therefore ignores fret patterns.
- It considers only unhit chips of the same part.
- It has **past priority**: an unhit chip at or before `T` within Poor wins over a nearer future chip.
  - Example (default ranges): chip A at 0 ms is unhit, chip B is at 100 ms, pick at 90 ms.
  - The search picks A (|90| ≤ 117), which judges Poor.
  - If the held frets fit B and not A, the result is an empty pick (§3.1). B stays pickable.
- Among same-time chips, a pick at or after `t` takes the last one in list order, and a pick before `t` takes the first. List order is defined in §0.
- **[ADD]** With `[HitRange] GuitarPoor=0` (or `BassPoor=0`), `range` is 0, which means unlimited. The search can then return a far chip that judges Miss, and the pick falls through to the empty-pick path.

**DTXManiaAI equivalent** (`GPS:895-912`):
- It does a linear scan. `past` is the last unjudged chip with `dt ≤ 0` inside the window. `future` is the first unjudged future chip, kept only if it is inside the window.
- The result is the same as NX for time-sorted input.
- **[AI≠NX]** DTXManiaAI's window is `SearchWindowMs = max(P,G,Gd,Poor)` (`Core/HitRanges.cs:59-69`). NX uses Poor only. They differ only for misordered or zero configs.

---

## 3. Manual pick → judgment

### 3.1 Algorithm (`PC:5421-5513`)

```
for ev in GetEvents(part, Pick) where ev.pressed:                         // in event order
  t    = ev.timestamp − timerReset                                          // PC:5432
  chip = Search(t, adj[part], range=Poor[part], pastPriority=true, NotHit, part)   // PC:5440-5441
  j    = chip ? Ranges(chip).Judge(|t + adj − chip.time|) : Miss            // PC:5443, 968-1019 (also writes chip.nLag)
  if chip
     && (Bits(chip) & ~autoMask & 0x3F) == (held & ~autoMask & 0x3F)        // EXACT match on non-AUTO frets (PC:5454-5455)
     && j != Miss:        // always true once found, unless Poor == 0 (§2)
      successOpen = chip.isOpen && every fret is (AUTO or not held)        // PC:5451-5452
      for lane in R..P: if (chip has lane && (auto[lane] || held lane)) || successOpen: chipFire(lane)   // PC:5458-5477
      ProcessChipHit(t, chip)                                               // §4 (PC:5478)
      PlaySound(chip, startAt=systemNow, ChipVolume, pitchShift = (j == Poor && Specialist[part]))   // §8 (PC:5479)
      w = Search(t, adj, range=140, search=Wailing(part), pastPriority, NotHit, UNKNOWN)
      if w: wailQueue[part].enqueue(w)                                      // §6 (PC:5484-5490)
      continue                                                              // one pick hits at most one chip
  // fall-through: no chip, or fret mismatch
  snd = currentNoChip[part]   // last 0xBA (guitar) / 0xBB (bass) chip that has passed (§8)
        ?? Search(t, adj, range=0 /*∞*/, pastPriority=false, DontCare, part=inst)   // PC:5504-5505, 1284-1286
  if snd: PlaySound(snd, ChipVolume, pitchShift = Specialist[part])         // PC:5507 (plays even with Light ON)
  if !Light[part]: Bad(part)                                                // §3.3 (PC:5509-5512)
```

**Fret rules.**
- The match is an exact set equality on non-AUTO frets. There is **no anchoring**: holding an extra, lower or higher fret fails. There is no hammer-on or pull-off.
- AUTO frets are masked out entirely. Holding them neither helps nor hurts, though they still flush visually.
- A chord (several frets) must be held exactly.
- An OPEN chip has bits 0, so every non-AUTO fret must be released. Holding any non-AUTO fret while picking an OPEN chip is a mismatch.
- With all five frets AUTO ("auto neck"), any pick inside Poor hits.

**Neck presses never judge anything.** Only manual pick events (this section) and AutoPick (§3.5) produce judgments.

**DTXManiaAI** (`GPS:888-941`) does the same, with these differences:
- One frame-timed pick per frame (§1.1).
- No Specialist mode.
- **[AI≠NX]** The empty-pick fallback scans only that part's notes, from the start of the list, nearest first. A tie keeps the earlier note (`GPS:1048-1073`), which is the same tie rule as NX.
- **[NX quirk]** In NX, the fallback call passes `search = Guitar_Open (0x20)` even for BASS (`PC:5505`). `Found` therefore also accepts any chip whose channel is `0x20` and is guitar-visible. So when no `0xBB` is defined, a bass empty pick can borrow a nearby guitar OPEN chip's WAV. Do not port this.

### 3.2 Hit windows

- `tGetJudgement(|d|)` (`App/STHitRanges.cs:74-89`) takes the first window that contains `|d|`, testing in this order: `≤P → Perfect`, `≤G → Great`, `≤Gd → Good`, `≤Poor → Poor`, else Miss.
- Defaults are 34/67/84/117 for both guitar and bass (`STHitRanges.cs:43-49`, `CI:1440-1441`).
- Config `[HitRange]` keys `GuitarPerfect/GuitarGreat/GuitarGood/GuitarPoor` and `BassPerfect...BassPoor`. Each accepts 0..999; an invalid value keeps the current one (`CI:4000-4027`).
  - Legacy un-prefixed `Perfect/Great/Good/Poor` keys are composed into all sets (`CI:3718-3742`).
- **[NX-only]** If the song's parent node is a BOX, its `box.def` keys `#GUITARPERFECTRANGE`… and `#BASS…RANGE` are composed over the Config values (`App/CDTXMania.cs:140-165`; `Score,Song/CBoxDef.cs:165-186, 208-232`). DTXManiaAI uses Config only (`GPS:423`).
- UNKNOWN chips (long-note end, wailing) always use the default ranges (`PC:1014-1017`).

### 3.3 BAD: `tチップのヒット処理_BadならびにTight時のMiss(part)` (`PC:1953-1981` via `GS:419-426`)

```
bAUTOでないチップが１つでもバーを通過した = true
gauge.Damage(screen=GUITAR, part, Miss)     // non-RISKY: −0.050 × gaugeDamageLevelFactor{0.25,0.5,0.75}[DamageLevel]
                                            //   → −0.025 at the default Normal (GA:136-146, 208-223)
                                            // RISKY: one life, and both gauges drop together (GA:210-213, 278-282)
judgeString(lane 13|14, Bad, lag 999)
combo[part] = 0
// no hit counts (not Miss, not Poor), no chip consumed, LN hold untouched
```
- **[ADD]** The Config `DamageFactor` (0.5/1/1.5, `CI:1244-1246`) is **not** used. Copying it into the gauge is `#if false` (`App/CDTXMania.cs:1168-1179, 1187-1198`).
- **[ADD]** The guitar judge-string actor has no `Bad` drawing branch (`GuitarScreen/CActPerfGuitarJudgementString.cs:153-1162, 1377-1402`). A BAD therefore draws nothing, but it overwrites the lane's state, so it **erases** the judgment currently shown. DTXManiaAI's comment agrees (`GPS:1080-1081`).
- **Light** (`[PlayOption] GuitarLight/BassLight`, `CI:2040-2041, 3248-3255`) defaults to ON (`CI:1389`). With Light ON there is no BAD; only the empty-pick sound plays. DTXManiaAI matches (`AIC:122-123`).
- Tight mode is drums-only (`CI:2061`).
- **[AI≠NX]** DTXManiaAI shows MISS as the judge text in CUSTOM mode and nothing in NX-skin mode (`GPS:1076-1084`).

### 3.4 Neck-only: never judges

There is no hammer-on, pull-off or tap. Holding frets affects only:
- the visuals (§1.4)
- the long-note check (§7)
- the AutoPick fret check (§3.5)

### 3.5 AutoPick (`PC:4297-4418`, inside the chip loop for each visible guitar/bass chip)

```
cond = !chip.bHit && autoPick[part] && chip.distancePx[part] < 0           // PC:4303-4332
// distancePx = (int)((chip.time − now) × (scroll+1) × 0.0446875) (CH:575-586; scroll = db現在の譜面スクロール速度,
// starts at nScrollSpeed (default 1, CI:1393) and eases 0.012 per 2 ms (CActPerfScrollSpeed.cs:29, 44-75)).
// So this fires at now ≥ chip.time + 1/((scroll+1)·0.0446875) ≈ chip.time + 11.2 ms at default scroll 1.
// AutoGhost (EAutoGhostData ≠ PERFECT) instead uses chip.time + ghostLag ≤ now, ghostLag −= adj: [NX-only] (PC:4308-4326)
if cond:
  held = bPressing(R..P) now                                               // PC:4342-4346
  successOpen = chip.isOpen && every fret (AUTO or !held)
  chipFire(lanes as in §3.1)                                               // PC:4348-4371
  miss = !( chipFretSet == autoFretSet                                     // PC:4376-4379: lets you hold other frets
         || every fret (AUTO or chipHas == held)                           // PC:4380-4384
         || (chip.isOpen && every fret (!held || AUTO)) )                  // PC:4385-4388 (subsumed by the 2nd)
  chip.bHit = true                                                         // PC:4390
  PlaySound(chip, startAt = reset + chip.time + ghostLag, MonitorVolume(part), pitchShift = miss && Specialist)  // PC:4391
  if !miss: ProcessChipHit(chip.time + ghostLag, chip)   // adj = isAuto ? 0 : adj[part], so lag = adj (§4)  PC:4393-4396
  else:     chip.nLag = 0; ProcessChipHit(chip.time + ghostLag, chip, correctLane=false)   // forced Miss (PC:4397-4401)
  w = Search(chip.time + ghostLag, adj, 140, Wailing(part)); if w && !miss: enqueue   // PC:4407-4413
```

- "AUTO pick, manual neck" means the player holds frets and the game strums. A wrong fret gives a forced Miss.
  - A forced Miss of a non-AUTO chip has `nLag = 0`, so it counts as **Early** (`PC:1935-1942`).
- **[ADD]** Consequences of the first clause (`chipFretSet == autoFretSet`):
  - With AutoPick ON and **no** AUTO frets, an OPEN chip (bits 0 = empty AUTO set) **never** Misses, whatever frets are held.
  - In general, a chip whose fret set equals the AUTO set is OK even while extra manual frets are held.
  - DTXManiaAI reproduces this (`GPS:953-969`).
- **[AI≠NX]** If the chip is not AUTO (it has a manual fret), NX judges it at `|adj[part]|`.
  - With InputAdjust = ±50, an auto-picked chip is **Great**, its `nLag = adj` (feeding Early/Late), and it gets the matching score and gauge.
  - **[ADD]** If `|adj| > Poor`, which is possible with a custom Poor < 99, the auto-strum itself is judged Miss.
  - DTXManiaAI always gives Perfect with lag 0 (`GPS:987`).
- **[ADD][NX quirk] Miss detection can pre-empt AutoPick.**
  - In the same chip-loop iteration, the Miss sweep (§5, `PC:2909-2918`) runs **before** the AutoPick switch (`PC:2964 → 3134 → GS:561 → PC:4297`).
  - For a non-AUTO chip under AutoPick, the sweep uses `adj`. On the first frame with `distancePx < 0`, if `now + adj − t > Poor`, the chip is Missed silently and never strummed.
  - With default Poor (117) and adj = +99, that is any frame where `now − t > 18` ms. At 60 fps this is frequent.
  - DTXManiaAI has no Miss sweep under AutoPick (`GPS:783-791`).
- **[AI≠NX]** A chip can be AUTO and still be a forced Miss. Example: AUTO frets {R,G}, chip {R}, and the player holds a manual B. NX gives `miss = true`, but `bCheckAutoPlay` is still true. The result:
  - judge string AUTO
  - `IncAuto.Miss++` only
  - no gauge change unless AutoAddGage
  - combo reset

  DTXManiaAI passes `chipIsAuto && !miss = false`. It therefore counts the Miss in the excl-AUTO counts, shows MISS and applies gauge damage (`GPS:987, 1110-1112, 1139`).
- **[AI≠NX]** NX still processes manual pick events while AutoPick is ON. The "auto pickだとここから先に行かない" comment at `PC:5420` is stale; there is no gate.
  - An early manual pick can hit a chip before the auto strum. That chip is judged at the pick time, with `adj` = 0 if the chip is AUTO.
  - BAD still applies when Light is OFF.
  - DTXManiaAI ignores the Pick key while AutoPick is on (`GPS:783-797`).
- **[AI≠NX]** DTXManiaAI fires at `songMs ≥ chip.time` rather than at pixel distance < 0 (`GPS:785-790`). Its wailing reservation uses `songMs + adj` instead of `chip.time + adj` (`GPS:990`).

---

## 4. `tProcessChipHit` for guitar/bass chips (`PC:1415-1633`; `GS:349-417` adds graph/skill display only)

```
chip.bHit = true
if chip is an LN start: chip.bロングノートHit中 = true; holdLN[part] = chip; lnDur = end.time − chip.time; lnPart = 0   // PC:1419-1425 (any judgment)
isAuto = bCheckAutoPlay(chip)                                           // §1.3
j = correctLane ? ranges[part].Judge(|t + (isAuto ? 0 : adj[part]) − chip.time|) : Miss   // PC:1445-1459
judgeString(13|14, isAuto ? AUTO : j, chip.nLag)
gauge: AutoAddGage ? Damage(j) : (isAuto ? — : Damage(j))               // PC:1472-1486 (AutoAddGage default OFF, CI:1349)
       // G/B deltas: P +0.006, G +0.003, Gd 0, Poor −0.030, Miss −0.050×levelFactor (GA:136-146, 163-223)
if !isAuto && j ∈ {P,G,Gd}: progressBar.Hit                             // PC:1489-1492
if !isAuto: (chip.nLag > 0) ? late++ : early++                          // PC:1495-1498, 1907-1945
counts: Miss/Bad → IncAuto.Miss++, ExclAuto.Miss++ if !isAuto; if Miss: holdLN[part] = null (ANY chip's Miss)   // PC:1579-1594
        else     → IncAuto[j]++, ExclAuto[j]++ if !isAuto               // PC:1595-1602
combo: j ∈ {P,G,Gd} → combo[part]++ else combo[part] = 0  // NO AUTO gate (PC:1604-1615); HighestValue via setter (CActPerfCommonCombo.cs:75-91)
score: §11   [FIX: the draft said §10]
```
- **[ADD][NX quirk]** On a Miss, `PC:1588` clears `bロングノートHit中` of the **missed** chip, not of the held LN chip.
  - The held LN chip keeps `bロングノートHit中 = true` after its hold has been cleared.
  - The draw code then keeps drawing it pinned to the judge line until its end passes (`PC:4185-4189`). This is display only.

DTXManiaAI: `JudgeChip` (`GPS:1091-1141`) is equivalent, except:
- **[AI≠NX]** Early/Late and progress hits are counted for AUTO chips too (`GPS:1097-1100`).
- **[AI≠NX]** An LN hold starts only when the judgment is not Miss. NX starts it and then clears it on Miss, so the end state is the same (`GPS:1104-1108`).

---

## 5. Miss detection (per frame, `PC:2909-2918`, inside the chip loop)

```
for chip from topChip while min(distancePx[D,G,B]) ≤ 600 (PC:2874-2885), in list order:
  isAuto = bCheckAutoPlay(chip); a = (isAuto || part == UNKNOWN) ? 0 : adj[part]
  if part ≠ UNKNOWN && !chip.bHit && chip.distancePx[part] < 0
     && Judge(|now + a − chip.time|) == Miss:            // effectively now + a − time > Poor
      ProcessChipHit(now, chip)                          // Miss, nLag > 0, counted as Late
```
- This runs in chip order, interleaved with AutoPick, wailing-chip and long-note-end handling, and before any input of the frame (§10). **[FIX]** The draft's cross-reference said §9.
- A missed chip makes no sound and does not stop the previous voice.
- Wailing chips, long-note ends and no-chip chips never Miss (all are UNKNOWN).
- **[ADD][NX quirk]** The sweep runs at frame time `now`, but pick events are processed afterwards with their own, earlier timestamps.
  - Suppose a pick event has `t + adj − T ≤ Poor`, but by the time the frame runs `now + adj − T > Poor`.
  - The sweep has already Missed the chip, so the pick becomes an empty pick, or BAD with Light OFF.
  - Up to one frame of the late edge of the Poor window is lost.
- DTXManiaAI: `inputMs − time > SearchWindowMs` → Miss, only while Pick is manual, run after the pick in the same frame (`GPS:798-807`). Its picks are frame-timed, so it does not have the quirk above.

---

## 6. Wailing

**Reservation.** It happens only on a successful hit: a manual hit of any judgment including Poor, or an AutoPick with `!miss`.
- The search is `Search(t, adj, range=140, channel=0x28|0xA8, pastPriority=true, NotHit, UNKNOWN)`, and the result is enqueued on `wailQueue[part]` (`PC:5484-5490, 4407-4413`).
- **[NX quirk]** There is no de-duplication. A wailing chip within ±140 ms of two successful picks is enqueued twice, and the next wail awards the bonus twice (`DoWailingFromQueue` never checks `bHit`).
- **[AI≠NX]** DTXManiaAI skips duplicates and already-consumed chips (`GPS:1013, 1023-1024`).

**Acceptance: `DoWailingFromQueue(part, ts, autoW)`** (`PC:5530-5559`):
```
tw = ts − timerReset                                   // no adj
while queue not empty:
  c = dequeue()
  if tw − c.time ≤ 1000:                               // no lower bound: wailing any time after reservation counts
    c.bHit = true                                      // the wailing chip stops being drawn (GS:694, 891)  [ADD]
    wailingBonus.Start(part, currentWailSound[part])
    if !autoW:
      if SkillMode == 0: score += min(combo, 500) × 3000              // classic
      else:              score += combo > 500 ? 50000 : combo × 100   // XG (default SkillMode = 1, CI:1281)
                         tBoostBonus()        // no effect: nRate computed at PC:1653 but never used
  // entries older than 1000 ms are discarded silently
```
- The score goes through `actScore.Add`, so the AUTO factor applies (`CActPerfCommonScore.cs:55-119`).
- Wailing has no combo, gauge or count effect. Not wailing has no penalty.
- **[NX-only]** DTXManiaAI implements only the XG bonus (`Core/PerformanceResult.cs:220-223`).

**Inputs.**
- Every Wail press event calls this function. With AutoWail ON it still runs, but adds no score (`PC:5515-5526`).
- **AutoWail** (`PC:4589-4606`; reads `configIni.bAutoPlay.GtW/BsW` directly): each frame that a not-yet-hit wailing chip has `distancePx < 0`, the queue is drained with `ts = that chip's time`.
  - The chip is set `bHit` once `distancePx < −234`.
  - **[ADD]** −234 px is `234 / ((scroll+1)·0.0446875)` ms. That is **≈2618 ms at default scroll 1**, not the 1 s the NX comment assumes.
  - **[AI≠NX]** DTXManiaAI drains as soon as the queue is non-empty, so it can fire up to 140 ms early. It marks a wailing chip consumed after 1000 ms instead of −234 px (`GPS:816-825`).

**Effect and sound** (`GuitarScreen/CActPerfGuitarWailingBonus.cs:29-54`):
- Each part has 4 effect slots (`CCounter(0, 300, 2)`).
- Sound plays only when a free slot exists **and** `AudienceSound=1` (default ON; `CI:1355, 1823`).
  - If a `0x2F` chip has passed (guitar only, `PC:3143-3149`), its WAV plays on the BGM lane.
    - **[ADD]** The volume is `MonitorVolume(UNKNOWN)`: `ChipVolume` if all three SoundMonitor flags are OFF, else `AutoChipVolume` (`DX:1569-1573`).
  - Otherwise the skin's audience sound plays, panned −50 for guitar and +50 for bass.
- **[NX quirk]** Bass has no wailing-sound channel. The `0xAF` handler is commented out (`PC:3377-3386`), and `chWailingSound` at `PC:5434` is unused.
  - **[ADD]** `0xAF` is now `Guitar_xGBYP` (`EChannel.cs:137`), a guitar note channel.
- **[AI≠NX]** DTXManiaAI always plays the sound, ignoring free slots and AudienceSound, and without the ±50 pan (`GPS:1842-1848`).

---

## 7. Long notes (LN)

**Pairing** (`DX:3867-3912`; DTXManiaAI port `AIX:595-629`):
```
cand[part] = null
for ctl in control chips (0x2C → GUITAR, 0x2D → BASS) in list order:
  if cand[part] == null:
     cand[part] = first chip in listChip with same position, same part, bChannelWithVisibleChip, !OPEN
     // [ADD] if none: this control chip is ignored (orphan), and the NEXT control chip is again a start candidate
  else:
     if any visible chip of the part has position in (cand.pos, ctl.pos]: cand = null   // violation: ctl is consumed
     else: cand.chipロングノート終端 = ctl; cand = null
```
- This is position-based, and OPEN chips can never start an LN.
- Real case: `ba_bsc`, see §0.

**Start.** A hit of any judgment begins the hold (`PC:1419-1425`). A Miss of any chip of that part clears it (`PC:1586-1593`).

**Hold check** (every input pass, before picks; `PC:5354-5418`):
```
if holdLN[part]:
  if (chipFlag & ~autoMask & 0x3F) == (held & ~autoMask & 0x3F):         // chipFlag = LN start bits (§1.4)
     if chip has any non-AUTO fret: gauge.Damage(screen=part, part, Good)   // G/B Good delta = 0.000, so a no-op;
                                            // [NX quirk] HAZARD: −0.050 EVERY FRAME (GA:189-206);
                                            // [ADD] HAZARD+RISKY: one life EVERY FRAME (GA:193-197)
     chipFire(lanes in chip that are AUTO or held)          // restarted each frame = continuous fire
     if lnPart < 5 && now ≥ start + (lnPart+1) × lnDur / 6 (int division):   // no adj
         score += 100 (via actScore.Add, AUTO factor applies); lnBonusAccum += 100; bonus anim; lnPart++   // ≤ 1 tick per frame
  elif DefaultRanges.Judge(|now + adj − end.time|) ≥ Miss:  // end chip is UNKNOWN, so 117 ms whatever the config
     release: start.bロングノートHit中 = false; holdLN = null; lnPart = 0; StopWav(nLastPlayedWAVNumber.GtPick/BsPick)
  // mismatch within ±117 ms of the end: keep the hold, but no ticks or fire
```
- **End** (`PC:3358-3375`): when the end chip's **drum**-pixel distance is ≤ 0, the hold is cleared normally.
  - That is `now > end.time − 1/((drumScroll+1)·0.089375)`, about 5.6 ms early at default scroll.
  - **[ADD]** The normal end does not stop the sound, in either NX or DTXManiaAI.
- There is no judgment at the end, the end does not count as a note, and there is no penalty for an early release except losing the remaining ticks.
- After a release the hold cannot be resumed.
- **[ADD]** For an LN whose frets are all AUTO, `chipFlag & ~autoMask = 0`. Holding any **manual** fret during it is a mismatch and releases it, if the release happens more than 117 ms before the end.
- The accumulated LN bonus is added to the all-Perfect final correction (`PC:1716-1721, 1820-1825`). So the score before the clear bonus maxes at 1,000,000 + LN bonus, and mid-song wailing bonuses are absorbed by the correction.
- **[NX quirk]** The release stop reads the `GtPick/BsPick` fields of `nLastPlayedWAVNumber` (`PC:5414`). Those fields are never written; `tPlaySound` writes `.Guitar/.Bass` (`PC:1377-1386`), and the drum branch writes only drum lanes (`PC:1371`).
  - **[ADD]** The fields stay at their default of 0, and WAV internal numbers start at 1 (`DX:3488`). So `tStopPlayingWav(0)` is a no-op.
  - So in NX, releasing an LN **does not stop its sound**.
- **[AI≠NX]** DTXManiaAI:
  - stops the last voice on release
  - judges the release window with the guitar/bass ranges instead of the default (`GPS:875-884`)
  - ends the hold at `songMs ≥ LongEndMs` (`GPS:848-852`)
  - has no gauge call in the hold (HAZARD drain not ported)
- An empty pick during a hold cuts the LN's sound (monophonic stop, §8) but does not release the hold. A BAD resets combo but also keeps the hold. NX and DTXManiaAI behave the same here.

---

## 8. Sound

**`tPlaySound`, guitar/bass branch** (`PC:1375-1387`):
```
DTX.tStopPlayingWav(nLastPlayedWAVNumber[part])   // stops ALL polyphonic voices of that WAV number (DX:2969-2982)
DTX.tPlayChip(chip, ...)
nLastPlayedWAVNumber[part] = chip.wav
```
- This makes each part monophonic.
  - **[ADD]** The stop is by WAV number. If a BGM/SE chip uses the same WAV, its voice is cut too.
- `tPlayChip` (`DX:3279-3317`):
  - volume = `vol × #VOLUME / 100`, pan = `#PAN`
  - speed = `PlaySpeed / 20`
  - pitch shift: frequency ratio = `(100 ± 7k)/100` with `k ∈ {1,2,3}` and the sign both chosen at random
  - its 5th argument (`bMIDIMonitor`, which receives `SoundMonitor[part]` on picks, `PC:5479`) is unused
- **[ADD]** The start time is used to correct the playback position **only for WAVs ≥ 5000 ms long** (`tAutoCorrectWavPlaybackPosition`, `DX:2918-2941`). Picks pass "now", so there is no seek.

| Event | WAV | Volume | Pitch shift |
|---|---|---|---|
| Manual hit | the chip's own WAV | `ChipVolume` (default 100, `CI:1366, 1912`) | if Poor && Specialist |
| Empty pick | current `0xBA`/`0xBB`, latched when it passes the bar and then rewritten to `0x20`/**`0xA0`** **[FIX]** (`PC:3405-3422`); else nearest chip (§3.1) | `ChipVolume` | if Specialist |
| AutoPick | the chip's own WAV, start time = `chip.time` (position-corrected only if ≥ 5 s) | `MonitorVolume` = `SoundMonitorGuitar/Bass` (default ON, `CI:1384, 1856`) ? `AutoChipVolume` (default 80, `CI:1365`) : `ChipVolume` (`DX:1543-1574`) | if forced miss && Specialist |
| Miss / BAD | none (BAD has only the empty-pick sound) | — | — |
| Guitar disabled (drums screen) | auto at the bar | `MonitorVolume` | — (`PC:4527-4531`) |

- Specialist: `GuitarSpecialist/BassSpecialist`, default OFF (`CI:1390, 2044-2045`).
- **[NX-only]** Specialist and SoundMonitor are not implemented in DTXManiaAI.
- **[AI≠NX]** DTXManiaAI differs as follows (`GPS:1036-1045`):
  - It stops the last voice handle rather than every voice of the WAV.
  - It plays AutoPick chips at `AllAuto ? AutoVol : ChipVol`. In NX, AutoPick chips with manual frets play at 80 by default; in DTXManiaAI they play at 100.
  - **[ADD]** It never seeks, so it does no position correction.
  - It latches `0xBA/0xBB` at `songMs ≥ time` (`GPS:775-776`).

---

## 9. Input adjust (judge offset) and play speed

**Sign.** `lag = t + adj[part] − chip.time` (`PC:974`). A positive `adj` makes hits register later. This is the same convention as drums (`PC:1439`).

**Config.** `[System] InputAdjustTimeGuitar/Bass`, range ±99 (`CI:1965-1966, 3089-3096`), copied to the stage at entry (`PC:362-363`).

**Where `adj` applies:**
- pick search and judgment
- the empty-pick fallback search **[ADD]** (`PC:5505`)
- Miss detection (non-AUTO chips; see the §3.5 pre-emption quirk)
- AutoPick of non-AUTO chips (lag = adj, §3.5)
- the wailing reservation search
- the long-note release check (via `ConfigIni.nInputAdjustTimeMs`, kept in sync by `PC:2338`)
- `NextChip` (only when Pick is manual)
- AutoGhost lag (subtracted, `PC:4319`)

**Where it does not apply:**
- AUTO chips
- wailing acceptance (1000 ms)
- long-note ticks
- the long-note end-of-hold point

**In play** (`PC:2394-2401, 2309-2339`):
- Shift+←/→ adjusts Guitar, Alt+←/→ adjusts Bass, with no modifier it adjusts Drums.
- Steps are ±10 ms, or ±1 with Ctrl, clamped to ±99, and written back to Config. Not available while paused.
- **[NX-only]** Not available in DTXManiaAI's guitar/bass mode.

**Play speed.** Chip times are divided by the speed at load (`DX:3925-3932`). Windows stay in real ms.

---

## 10. Frame order

**NX guitar screen** (`GS:129-338`):
1. Fail check (`GS:168-179`). **[ADD]** This is skipped in training mode (`!this.bIsTrainingMode`, `GS:168`).
2. Draw/update actors.
3. `tUpdateAndDraw_Chips(GUITAR)` (`GS:196`). For each chip in list order, top chip first:
   - Miss detection (§5)
   - per-channel handling: AutoPick (§3.5), wailing chip / AutoWail (§6), `0x2F` and `0xBA/0xBB` latches, long-note end (§7)
4. Loop wrap (`GS:306-327`).
5. `tHandleKeyInput()` (`GS:333`):
   - Drums: a no-op on this screen (`GS:518-521`).
   - `tHandleInput_GuitarBass(GUITAR)`, then `(BASS)` (`PC:2367-2369`). Inside each: §1.4 visuals → LN hold check → all pick events → all wail events.

NX drums uses the same order: chips loop, then input (`DrumsScreen/CStagePerfDrumsScreen.cs:218, 465`).

**[AI≠NX] DTXManiaAI** per part (`GPS:582-589, 769-826`):
1. No-chip latch
2. Neck bits
3. LN hold
4. Either AutoPick, or (one manual pick, then Miss detection)
5. Wail
6. AutoWail
7. Wailing expiry

In DTXManiaAI the input runs before Miss detection, the reverse of NX.
- **[FIX]** The results are equal only because DTXManiaAI's picks are frame-timed.
- NX's event-timestamped picks plus its sweep-first order lose up to one frame at the late Poor edge (§5).
- NX also runs an AutoPicked LN's first hold check in the same frame, whereas DTXManiaAI runs it in the next frame.

---

## 11. Combo and score rules specific to guitar/bass

**Combo.** It increases on P/G/Gd for AUTO chips too.
- Guitar/bass have no AUTO gate (`PC:1604-1615`), whereas drums require `AllDrumsAuto || !isAuto` (`PC:1553`).
- Poor, Miss and BAD reset it.
- DTXManiaAI matches (`GPS:1116-1135`).

**Score (XG, the default).** **[FIX]** The draft gave the multiplier only as "×combo below 50, ×50 otherwise". The full rule follows. Both AutoAddGage branches are identical for G/B (`PC:1703-1751`, `PC:1805-1857`). Combo is already updated when this runs.
```
N = nVisibleChipsCount[part]; c = combo[part] (including this chip); base = 1e6 / (1275 + 50(N − 50))
j == Perfect: d = c < N ? base : (IncAuto.Perfect[part] ≥ N ? 1e6 − trueScore[part] + lnBonusAccum[part] : 0)
j == Great:   d = base × 0.5
j == Good:    d = base × 0.2
j == Poor:    d = 0
if c < 50:                                      d ×= c
elif c == N || ExclAuto.Perfect[part] == N:     d ×= 1
else:                                           d ×= 50
actScore.Add(part, (long)d)                    // no isAuto gate: AUTO chips score too
```
- **[ADD][NX quirk]** For a chart with N < 50, the all-Perfect final correction is also multiplied by `c` (= N). The score then explodes.
  - **[AI≠NX]** DTXManiaAI returns the correction unmultiplied (`Core/PerformanceResult.cs:199-200`).
- Every addition passes through `actScore.Add` (`CActPerfCommonScore.cs:55-119`):
  - If the part is not fully AUTO: AutoPick halves it, and any AUTO fret halves it again.
  - If the part is fully AUTO and AutoAddGage is OFF: ×0.
  - DTXManiaAI: `GPS:405-415`.
- **[NX-only]** Classic SkillMode 0 (`PC:1861-1900`). **[FIX]** The cap is not a plain "capped at 500":
  ```
  gate = AutoAddGage || !isAuto                 // [ADD] AUTO chips score nothing in Classic unless AutoAddGage
  T = {350, 200, 50, 0}
  d = (c ≤ 500 || j == Good) ? T[j]·c : (j == Perfect ? T[j]·500 : 0)   // Great beyond 500 combo gives 0; Good is uncapped
  ```
- **Clear bonus** (`GS:236-297`, XG only, when the fade-out completes). **[FIX]** The condition is "no Miss/Poor", not a full combo:
  ```
  for part in {GUITAR, BASS}:
    if ExclAuto.Miss + ExclAuto.Poor == 0:                     // BAD does not count, so it does not block the bonus
       P = AllAuto(part) ? IncAuto.Perfect : ExclAuto.Perfect
       trueScore[part] += (P == N) ? 30000 : 15000             // raw add: bypasses actScore.Add and its AUTO factor
  ```
  - **[NX quirk]** A part with no chips gets +30000, because 0 == 0.
  - **[AI≠NX]** DTXManiaAI skips parts with no notes, and it applies the bonus through `AddScore`, so the AUTO factor applies (`GPS:1213-1228`).

---

## 12. Edge cases

| Case | NX result |
|---|---|
| Pick with no chip in the Poor window | Empty-pick sound; BAD if Light OFF |
| Several frets (chord) | Must match exactly; extra fret = mismatch |
| Two same-time chips in one part (different channels) | Each needs its own pick with its own exact pattern; one pick hits ≤ 1 chip. Which one is tried is decided by list order (§0: priority first, then unspecified), so a valid pattern for the other chip can still give BAD |
| OPEN chip with a non-AUTO fret held, manual pick | Mismatch → empty pick / BAD |
| **[ADD]** OPEN chip, AutoPick ON, no AUTO frets | Never Misses, whatever is held (`PC:4376-4379`) |
| **[ADD]** AutoPick, chip frets == AUTO fret set | OK even with extra manual frets held |
| OPEN chip with all frets AUTO | Always matches (AUTO chip only if Pick is also AUTO) |
| AUTO fret pressed manually | Ignored by the comparison (masked) |
| Hit or LN-hit chips | Skipped by the search (NotHit); an older unhit chip in the window takes priority |
| Two picks in one frame | NX: 2 searches; the second gets the next chip or BAD. DTXManiaAI: one pick per frame |
| **[ADD]** Same key bound twice to Pick | NX: 2 picks per press (`CPad.cs:53-91`) |
| **[ADD]** Pick event inside Poor, but the frame is already past Poor | NX: the chip was already Missed by the sweep → empty pick (§5) |
| **[ADD]** LN control chip with no chip at its position | Ignored; the next control chip is a start candidate again (§7) |
| **[ADD]** `GuitarPoor=0` / `BassPoor=0` | The search range is unlimited; far chips judge Miss → empty pick (§2) |

---

## 13. Notes for the web port (recommendations, not NX behaviour)

- NX's default fret keys conflict with this repo's `RESERVED_CODES`, which contains `F1`, `Enter`, `NumpadEnter`, `Tab` and others (`js/ui/keybind.js:27-30`). The defaults F1 (Guitar R) and NumpadEnter (Bass Pick #2) must change, and CLAUDE.md requires `RESERVED_CODES` and docs to be kept in sync.
- Use `KeyboardEvent.timeStamp` per keydown to keep NX's per-event pick timing. That fixes DTXManiaAI's frame-timing and one-pick-per-frame deviations at low cost.
  - **[ADD]** Process the queued pick events **before** the per-frame Miss sweep, or sweep per event time. This avoids NX's lost late-edge frame (§5).
- Decide explicitly on each **[NX quirk]**. Recommended:
  - drop the `0xE0` bass quirk, the bass→guitar OPEN sound borrow, duplicate wailing awards and the HAZARD long-note drain
  - implement the intended long-note sound stop, and note that it differs from NX
  - **[ADD]** drop the Miss-pre-empts-AutoPick case (§3.5)
  - **[ADD]** drop the ×combo final correction for N < 50 and the +30000 for a chipless part (§11)
- **[ADD]** Port the orphan-control-chip rule for LN pairing; `ba_bsc` needs it (§0, §7).
- **[ADD]** Keep the AutoPick lag = adj behaviour, or document the DTXManiaAI simplification (always Perfect) as an intentional deviation in code comments, as CLAUDE.md requires.
