# gb-chart

# Guitar/Bass chart data: parsing spec (NX `CDTX` + DTXManiaAI `DtxChart`)

**Path conventions.** NX paths are relative to `DTXmaniaNX/DTXMania/Code/`. DTXManiaAI paths are relative to `DTXManiaAI/Assets/Scripts/`. FDK paths are relative to `DTXmaniaNX/FDK/Code/`.

**Abbreviations.**

NX:
- `CDTX` = `Score,Song/CDTX.cs`
- `CChip` = `Score,Song/CChip.cs`
- `EC` = `Score,Song/EChannel.cs`
- `ENC` = `Score,Song/EnumConverter.cs`
- `PCS` = `Stage/07.Performance/CStagePerfCommonScreen.cs`
- `PGS` = `Stage/07.Performance/GuitarScreen/CStagePerfGuitarScreen.cs`
- `PDS` = `Stage/07.Performance/DrumsScreen/CStagePerfDrumsScreen.cs` [ADD]

DTXManiaAI:
- `DC` = `Song/DtxChart.cs`
- `DH` = `Song/DtxHeader.cs`
- `GPS` = `Stages/GuitarPerformanceStage.cs`
- `PS` = `Stages/PerformanceStage.cs`

"GB" means guitar/bass.

**Tags.**
- **[NX-only]**: NX behaviour that DTXManiaAI skipped.
- **[AI+]**: DTXManiaAI addition or change.
- **[NX-bug]**: an NX defect. Do not copy it.
- **[AI-bug]**: a DTXManiaAI defect. Do not copy it. [ADD]
- **[WEB]**: recommendation for DTXMania Web. The committed `js/core/dtx.js` (HEAD 26de61f) ignores every GB channel.
- **[FIX]** / **[ADD]**: corrections and additions made in verification.

The tick and time rules are shared with drums (dtx-audio.md §3, §7.1):
- 384 ticks per measure, plus one empty lead-in measure.
- `pos = (measure+1)*384 + floor(384*i/objCount)`.
- `TimeMs = round(currMs + 625·Δpos·barLen/bpm)`. NX's default `nChipPlayTimeComputeMode = 1` means "accurate/round" (`App/CConfigIni.cs:1512`; CDTX:6586-6611).
- **[FIX]** `round` is C# `Math.Round`, which rounds half to even (NX CDTX:6609, DTXManiaAI DC:422). The web's `Math.round` rounds half up (dtx-audio.md §7.1). The test pack has no exact `.5` times, so this does not affect TV-16.
- The object value `00` is skipped.

---

## 0. Data model

### DTXManiaAI (DC:39-50, 205-223)

```
GBNote { TimeMs, Bits, WavId, Channel, Pos, LongEndMs = -1, LongEndPos = -1 }
         IsOpen = (Bits == 0), IsLong = (LongEndMs >= 0)                     // DC:39-50
GuitarNotes, BassNotes                       : List<GBNote>  (visible chips only)          DC:209-210
GuitarWailing, BassWailing                   : List<Note{TimeMs,Pos,WavId(unused)}>       DC:212-213
GuitarNoChipEvents, BassNoChipEvents         : List<Note{TimeMs,WavId}>  (0xBA / 0xBB)    DC:215-216
GuitarWailingSoundEvents                     : List<Note{TimeMs,WavId}>  (0x2F)           DC:218
HasYPGuitar, HasYPBass                       : bool                                       DC:220-221
HasGuitarNotes = GuitarNotes.Count > 0 ; HasBassNotes = BassNotes.Count > 0               DC:222-223
```

### NX

- NX keeps every raw `CChip` in one `listChip`.
- The GB part is stored in `chip.eInstrumentPart`. It is assigned **only** to the 64 visible GB channels (CDTX:6883-6894). Wailing, LN-control, 0x2F and 0xBA/0xBB chips stay `UNKNOWN`; CDTX:4393 says this explicitly for wailing.
- A long note is a reference from the start chip to the 0x2C/0x2D chip: `chip.chipロングノート終端`, with `bロングノートである => chipロングノート終端 != null` (CChip:424-425).
- The 0x2C/0x2D chip stays in `listChip` as its own chip.
- **[ADD]** Chips are never merged. Each object in each data line becomes its own chip (CDTX:6874-6939; DC:787-806). Two lines that put chips of the same part at the same Pos (for example `#00121: 01` plus `#00124: 01`) give **two** notes, not an R+B chord, and both are counted. Duplicate lines for the same measure and channel are not merged either. The test pack has no same-Pos chips within one part.

---

## 1. Channel → fret bits

### 1.1 Bit values

The bits are `R=4 G=2 B=1 Y=16 P=32`, and `OPEN = 0`. NX builds the chip mask exactly like this at pick time (PCS:5454); DTXManiaAI uses the same values (DC:124).

- `p = Bits & 7` is the R/G/B pattern. It equals the index in NX's naming order `Open, xxB, xGx, xGB, Rxx, RxB, RGx, RGB` (EC:30-37 and 122-129).
- Bit 8 (W) is used only as an AUTO-mask bit and never appears on a chip (DC:123-124; PCS:4894-4900).

Both sources build the table the same way. DTXManiaAI's construction (DC:128-155) has the same content as the NX `ENC:11-141` dictionary, which maps all 32 `(R,G,B,Y,P)` tuples to `(Guitar, Bass)` channels:

```
guitar: 0x20+p | +Y: [93 94 95 96 97 98 99 9A][p] | +P: [9B 9C 9D 9E 9F A9 AA AB][p] | +Y+P: [AC AD AE AF D0 D1 D2 D3][p]
bass  : 0xA0+p | +Y: [C5 C6 C8 C9 CA CB CC CD][p] | +P: [CE CF DA DB DC DD DE DF][p] | +Y+P: [E1 E2 E3 E4 E5 E6 E7 E8][p]
```

### 1.2 Full table

Every row was checked against EC, the DC tables and the ENC tuple. "Pack" = how many times the channel is used in the test pack's MASTER charts (`gt_mst.dtx` / `ba_mst.dtx`). The other difficulties use subsets of these channels.

| ch | NX `EChannel` (EC line) | bits | frets | pack |
|---|---|---|---|---|
| 0x20 | Guitar_Open (30) | 0 | OPEN | 39 |
| 0x21 | Guitar_xxBxx (31) | 1 | B | 20 |
| 0x22 | Guitar_xGxxx (32) | 2 | G | 8 |
| 0x23 | Guitar_xGBxx (33) | 3 | G+B | 139 |
| 0x24 | Guitar_Rxxxx (34) | 4 | R | 26 |
| 0x25 | Guitar_RxBxx (35) | 5 | R+B | 68 |
| 0x26 | Guitar_RGxxx (36) | 6 | R+G | 60 |
| 0x27 | Guitar_RGBxx (37) | 7 | R+G+B | |
| 0x93 | Guitar_xxxYx (109) | 16 | Y | 7 |
| 0x94 | Guitar_xxBYx (110) | 17 | B+Y | 45 |
| 0x95 | Guitar_xGxYx (111) | 18 | G+Y | 20 |
| 0x96 | Guitar_xGBYx (112) | 19 | G+B+Y | 45 |
| 0x97 | Guitar_RxxYx (113) | 20 | R+Y | |
| 0x98 | Guitar_RxBYx (114) | 21 | R+B+Y | |
| 0x99 | Guitar_RGxYx (115) | 22 | R+G+Y | |
| 0x9A | Guitar_RGBYx (116) | 23 | R+G+B+Y | |
| 0x9B | Guitar_xxxxP (117) | 32 | P | 7 |
| 0x9C | Guitar_xxBxP (118) | 33 | B+P | 22 |
| 0x9D | Guitar_xGxxP (119) | 34 | G+P | |
| 0x9E | Guitar_xGBxP (120) | 35 | G+B+P | |
| 0x9F | Guitar_RxxxP (121) | 36 | R+P | |
| 0xA9 | Guitar_RxBxP (131) | 37 | R+B+P | |
| 0xAA | Guitar_RGxxP (132) | 38 | R+G+P | |
| 0xAB | Guitar_RGBxP (133) | 39 | R+G+B+P | |
| 0xAC | Guitar_xxxYP (134) | 48 | Y+P | 28 |
| 0xAD | Guitar_xxBYP (135) | 49 | B+Y+P | 3 |
| 0xAE | Guitar_xGxYP (136) | 50 | G+Y+P | |
| 0xAF | Guitar_xGBYP (137) | 51 | G+B+Y+P | |
| 0xD0 | Guitar_RxxYP (166) | 52 | R+Y+P | |
| 0xD1 | Guitar_RxBYP (167) | 53 | R+B+Y+P | |
| 0xD2 | Guitar_RGxYP (168) | 54 | R+G+Y+P | |
| 0xD3 | Guitar_RGBYP (169) | 55 | R+G+B+Y+P | |
| 0xA0 | Bass_Open (122) | 0 | OPEN | 32 |
| 0xA1 | Bass_xxBxx (123) | 1 | B | 60 |
| 0xA2 | Bass_xGxxx (124) | 2 | G | 59 |
| 0xA3 | Bass_xGBxx (125) | 3 | G+B | 62 |
| 0xA4 | Bass_Rxxxx (126) | 4 | R | 47 |
| 0xA5 | Bass_RxBxx (127) | 5 | R+B | 41 |
| 0xA6 | Bass_RGxxx (128) | 6 | R+G | 16 |
| 0xA7 | Bass_RGBxx (129) | 7 | R+G+B | |
| 0xC5 | Bass_xxxYx (155) | 16 | Y | 31 |
| 0xC6 | Bass_xxBYx (156) | 17 | B+Y | 78 |
| 0xC8 | Bass_xGxYx (158) | 18 | G+Y | 12 |
| 0xC9 | Bass_xGBYx (159) | 19 | G+B+Y | 4 |
| 0xCA | Bass_RxxYx (160) | 20 | R+Y | |
| 0xCB | Bass_RxBYx (161) | 21 | R+B+Y | |
| 0xCC | Bass_RGxYx (162) | 22 | R+G+Y | |
| 0xCD | Bass_RGBYx (163) | 23 | R+G+B+Y | |
| 0xCE | Bass_xxxxP (164) | 32 | P | 9 |
| 0xCF | Bass_xxBxP (165) | 33 | B+P | 8 |
| 0xDA | Bass_xGxxP (175) | 34 | G+P | |
| 0xDB | Bass_xGBxP (176) | 35 | G+B+P | |
| 0xDC | Bass_RxxxP (177) | 36 | R+P | |
| 0xDD | Bass_RxBxP (178) | 37 | R+B+P | |
| 0xDE | Bass_RGxxP (179) | 38 | R+G+P | |
| 0xDF | Bass_RGBxP (180) | 39 | R+G+B+P | |
| 0xE1 | Bass_xxxYP (182) | 48 | Y+P | 37 |
| 0xE2 | Bass_xxBYP (183) | 49 | B+Y+P | 5 |
| 0xE3 | Bass_xGxYP (184) | 50 | G+Y+P | |
| 0xE4 | Bass_xGBYP (185) | 51 | G+B+Y+P | |
| 0xE5 | Bass_RxxYP (186) | 52 | R+Y+P | |
| 0xE6 | Bass_RxBYP (187) | 53 | R+B+Y+P | |
| 0xE7 | Bass_RGxYP (188) | 54 | R+G+Y+P | |
| 0xE8 | Bass_RGBYP (189) | 55 | R+G+B+Y+P | |

### 1.3 Traps

- **0xA9–0xAF are GUITAR** even though they sit inside the 0xA_ "bass" block (EC:131-137). 0xA8 is Bass_Wailing (EC:130).
- These channels in and around the bass Y/P blocks are **not** GB channels:
  - 0xC4 / 0xC7: BGALayer1/2_Swap (EC:154, 157)
  - 0xD5–0xD9: BGALayer3–7_Swap (EC:170-174)
  - 0xE0: BGALayer8_Swap (EC:181)
  - 0xC3, 0xD4 and 0xB0: undefined. 0xC1/0xC2 are BeatLineShift/BeatLineDisplay (EC:152-153).
- 0x29 (`flowspeed_gt_nouse`, EC:39) is unused. 0x2A, 0x2B and 0x2E are undefined. All are ignored.
- **[FIX]** NX's "visible chip" predicates are **not** all exactly the 64 rows above:
  - `bChannelWithVisibleChip` (CChip:79-165) = the 12 drum channels 0x11–0x1C plus exactly the 64 GB rows.
  - `bGuitar可視チップ` (CChip:179-193) = exactly the 32 guitar rows. `_Wailing含む` (CChip:195-209) adds 0x28.
  - **[NX-bug]** `bBass可視チップ` (CChip:211-225) and `bBass可視チップ_Wailing含む` (CChip:227-241) test their last range as `Bass_xGxxP..Bass_RGBYP` = 0xDA–0xE8. That range **includes 0xE0 (BGALayer8_Swap)**.
    - Their only consumer is the chip-search predicate `Found` (PCS:2043-2058; the bass branch is 2049-2051).
    - So a bass pick (PCS:5441) or the bass empty-pick borrow (PCS:5505) can select an unhit 0xE0 chip.
    - On the pick path, that chip reaches `EnumConverter.GetArrayBoolFromEChannel(0xE0)` (PCS:5448), which throws `NotImplementedException` for any non-GB channel (ENC:192-211).
    - DTXManiaAI's table has no 0xE0 (DC:135-139).
  - The part assignment (CDTX:6887, 6891) and the count (CDTX:3956, 3961) match the 32 + 32 rows exactly.
  - The presence flag `.Guitar` (CDTX:6674) omits 0xA9 (§5.1).
  - **[WEB]** Use the explicit 32-entry tables (§1.1) for every predicate.
- **Channel parsing.** NX requires the command to be exactly 5 characters (CDTX:6617-6618). The channel is exactly two hex digits, case-insensitive; a non-hex character drops the line (FDK `00.Common/CConversion.cs:11, 83-103`; CDTX:6659-6662). DTXManiaAI uses `Convert.ToInt32(s,16)`, which throws and drops the line (DC:761-764). **[WEB]** `parseInt(body.slice(3,5),16)` is lax: for example `"2G"` becomes 2 (the bar-length channel). Validate with `/^[0-9A-Fa-f]{2}$/`.
- **[ADD] Object field (shared with drums).**
  - NX (CDTX:6813-6868):
    - An empty parameter drops the line (6813).
    - `_` is skipped (6827-6828).
    - **Any non-base-36 character drops the whole line** (6830-6834).
    - With an odd length, the last character is ignored (6842-6843).
    - Values are base 36 and case-insensitive: `0z` = `0Z` = 35 (`CConversion.cs:12, 104-124`).
    - `00` is skipped (6867-6868).
  - DTXManiaAI (DC:766-791) strips the `;` comment and spaces/tabs. It neither strips `_` nor rejects bad characters, and it keeps the id's original case (`RequiredWavIds` upper-cases later, DC:644).
  - The web HEAD strips `[ \t_]` and upper-cases ids at parse time (`parseDataLine` in `js/core/dtx.js`).

### 1.4 Test pack check

Every GB channel in the pack maps to a row above.
- `gt_*.dtx` uses `01`, `20–26`, `28`, `2C`, `93–96`, `9B`, `9C`, `AC`, `AD`, and SE `66–92`.
- `ba_*.dtx` uses `01`, `2D`, `A0–A6`, `A8`, `C5`, `C6`, `C8`, `C9`, `CE`, `CF`, `E1`, `E2`, and SE `66–92`.
- `dm_*.dtx` uses only drum (0x11–0x1B), BGM and SE channels.

The pack is split by file: no GB chips appear in `dm_*`, and no drum chips appear in `gt_*` or `ba_*`. Channels 0x27/0xA7, 0x2F, 0xBA/0xBB, 0xA9–0xAB/0xAE–0xAF/0xD0–0xD3, 0xC4/0xC7/0xD5–0xD9/0xE0 and 0x61–0x65 are not used. Channels 0x02, 0x03 and 0x08 are not used either: one BPM throughout.

---

## 2. Non-note GB channels

| ch | NX name (EC) | WAV channel? [FIX] (CChip:243-394) | NX parse / runtime | DTXManiaAI parse (DC) |
|---|---|---|---|---|
| 0x28 / 0xA8 | Guitar_Wailing / Bass_Wailing (38, 130) | **no** (the value is ignored) | Part `UNKNOWN`. Not visible and not counted. Drawn as a wailing chip. At runtime a successful pick reserves the nearest unhit wailing chip within ±140 ms, past first (PCS:5484-5490). | `GuitarWailing` / `BassWailing.add{TimeMs, Pos}` (DC:509-518) |
| 0x2C / 0x2D | Guitar_/Bass_LongNote (40-41) | **no** | Long-note control (§3). | collected, then paired (DC:519-520, 563-564) |
| 0x2F | Guitar_WailingSound (42) | yes | When it passes the bar (`nDistanceFromBar.Guitar < 0`): `r現在の歓声Chip.Guitar = chip` (PCS:3143-3149). | `GuitarWailingSoundEvents` (DC:531-535) |
| 0xBA / 0xBB | Guitar_NoChip / Bass_NoChip (147-148) | yes | When it passes the bar: `r現在の空うちギター/ベースChip = chip`, and the chip's channel is rewritten to 0x20/0xA0 (PCS:3405-3423). Reset to null at stage start (PCS:312-313). | `GuitarNoChipEvents` / `BassNoChipEvents` (DC:521-530) |

### 2.1 Wailing sound switch (0x2F)

- On a successful wail, NX plays the chip's WAV on the BGM lane if one has passed. Otherwise it plays the skin Audience sound, panned −50 for guitar and +50 for bass. Both require `b歓声を発声する` (`Stage/07.Performance/GuitarScreen/CActPerfGuitarWailingBonus.cs:39-49`).
- **There is no bass equivalent.**
  - The old 0xAF bass handler is commented out (PCS:3377-3387), and 0xAF is now Guitar_xGBYP (EC:137).
  - `r現在の歓声Chip.Bass` is never assigned, so the bass wail always uses the skin sound.
  - **[FIX]** The commented-out line PCS:5433 still reads `0x2F : 0xAF` (guitar/bass wailing-sound channels).
    - The live line PCS:5434 maps guitar to `Guitar_Wailing` (0x28) and bass to `Guitar_xGBYP` (0xAF).
    - Its variable `chWailingSound` is dead: only the commented-out call at 5438 uses it.
- DTXManiaAI behaves the same:
  - "current" = the last passed 0x2F (GPS:697-702)
  - guitar only (GPS:1842-1848)

### 2.2 Empty-pick sound switch (0xBA / 0xBB)

**[FIX]** On an empty or wrong pick, NX plays the current 0xBA/0xBB chip through `tPlaySound(part)`. If none has passed yet, it borrows the nearest chip found by `r指定時刻に一番近いChip_ヒット未済問わず不可視考慮(nTime, Guitar_Open, adjust, inst)`. The call chain is PCS:5504-5508 → PCS:1284-1286 → `r指定時刻に一番近いChip(…, range 0, b過去優先=false, HitState.DontCare, inst)` at PCS:1984-2075, with `Found` at PCS:2043-2058. The borrow rules:
- hit or not, any distance, `bIsEmptyChip` excluded
- The search key is 0x20 for **both** parts.
  - Guitar: any `bGuitar可視チップ` chip matches, so wailing is excluded.
  - Bass: any `bBass可視チップ` chip matches. This excludes wailing but includes 0xE0 (§1.3 [NX-bug]).
- The nearest future chip and the nearest past chip are compared by |Δt|; ties go to the past chip (PCS:2031-2036).

DTXManiaAI `PlayNoChipSound` (GPS:1048-1073) does the same: nearest by |Δt| in ascending scan with a strict `<`, so ties go to the earlier chip. It is monophonic per part, as is NX `tPlaySound` (PCS:1375-1388). The current value updates when `songMs >= TimeMs` (GPS:775-776).

### 2.3 FLIP

- **NX** `SwapGuitarBassInfos` never touches 0x2F, 0xBA or 0xBB, because they are `UNKNOWN`-part chips that are not in its `else if` chain (CDTX:4346-4400).
- **DTXManiaAI** swaps the NoChip lists under FLIP but not 0x2F (GPS:317-325). **[AI+]**

---

## 3. Long notes (0x2C guitar / 0x2D bass)

### 3.1 NX algorithm

It runs inside the time sweep over `listChip`, which is sorted by Pos and then by the `CChip` priority table (CChip:596-640). The relevant code is CDTX:3766-3769 and 3866-3912.

```
cand[GUITAR] = cand[BASS] = null                                         // 3766-3769
for chip in listChip:
    chip.TimeMs = round(...)                                             // 3772-3773 (computed BEFORE the switch)
    if chip.ch == 0x2C or 0x2D:
        part = (ch == 0x2C) ? GUITAR : BASS                              // 3871
        if cand[part] == null:                                           // 3873-3884
            cand[part] = FIRST c in listChip with c.Pos == chip.Pos
                         && c.eInstrumentPart == part && c.bChannelWithVisibleChip && !c.bChipIsOpenNote
            // none → stays null: this LN chip is simply unused
        else:                                                            // 3886-3909
            if EXISTS c in listChip with c.eInstrumentPart == part && c.bChannelWithVisibleChip
                      && cand[part].Pos < c.Pos <= chip.Pos:
                cand[part] = null                                        // pair discarded
            else:
                cand[part].chipロングノート終端 = chip                       // 3905
                cand[part] = null
```

### 3.2 Normative rules (true for both NX and DTXManiaAI)

1. **Start.** An LN-control chip "arms" only if a **non-OPEN** visible chip of the **same part** sits at exactly the same Pos. That chip becomes the LN start. An OPEN chip can never start an LN (CDTX:3879; DC:604).
2. **End.** The end is the **next** LN-control chip of the same part after an armed start, however far away it is. End time = that control chip's own `TimeMs`; `LongEndPos` = its Pos.
   - **[FIX]** Like every chip, the end time is scaled by the play speed.
   - NX divides every `nPlaybackTimeMs` by `db再生速度` and rounds per the compute mode (CDTX:3925-3932). The draft's 3914-3921 is the BGAPAN code.
   - DTXManiaAI multiplies by a factor and **truncates**, `(int)(t*factor)`, for both `TimeMs` and `LongEndMs` (GPS:465-491).
3. **Discard.** If any visible chip of the same part (OPEN included) lies in `(start.Pos, end.Pos]`, the pair is discarded. The interval includes a chip exactly **at** the end Pos. The control chip that caused the discard is consumed: it is **not** retried as a start, even if a non-OPEN chip sits at its Pos.
4. **What never breaks an LN.** Wailing chips (`UNKNOWN` part, not visible), chips of the other part, drums, and the 0xBA/0x2F switches. Guitar and bass pair independently: 0x2C pairs only with guitar chips, 0x2D only with bass chips.
5. **Stray control chips.** A control chip with no eligible start is ignored, and the following one is tried as a start. A start that never gets an end (end of file) remains an ordinary chip.
   - **[ADD]** Pairing is one running start/end parity over the whole chart. A single stray chip shifts the parity: an intended end that happens to share its Pos with a non-OPEN note becomes a start (TV-7).
   - In the test pack, `ba_bsc.dtx` has two consecutive strays at Pos 16272 and 16300: the BSC arrangement dropped the start note but kept both control chips. Parity resyncs, so it yields 12 LNs from 26 control chips.
6. **Degenerate cases** (both appear only in malformed charts):
   - Two armed control chips at the same Pos (duplicate data lines) produce a zero-length LN, because `(p, p]` is empty (TV-19).
   - If several non-OPEN chips of the part share the start Pos, the first in sorted order wins.
     - **[FIX]** NX's order at equal Pos is the priority table (CChip:599-616). Bass Y/P channels (0xC5–0xCF, 0xDA–0xE8) and guitar 0xD3 have priority **5**; all other GB visible channels have **7**. So a bass Y/P chip precedes a bass 3-lane chip.
     - Within equal priority, NX `List.Sort` is unstable.
     - DTXManiaAI gives every GB channel `CtrlPriority` 4 (DC:809-818), so its order at equal Pos is unspecified.
7. **The control chip's value** (usually `01`) is irrelevant, and it is not a WAV channel.

### 3.3 Is the LN end a judged chip?

**No.**
- The end is outside the visible ranges, so it is not counted (CDTX:3956-3965).
- In NX, the start chip is judged normally. `tProcessChipHit` arms the hold **before** judging (PCS:1417-1425).
- **[ADD]** A `Miss` judged on **any** chip of that part clears the hold (PCS:1586-1593). This includes the LN start itself when it passes unhit, so a missed start never holds. DTXManiaAI does the same (GPS:1127-1130).
- When the control chip reaches the bar (`nDistanceFromBar.Drums <= 0`) and it is the held chip's end, the hold ends silently (PCS:3359-3375).
- While held with matching frets, the player gets +100 points at each sixth of the duration, at most 5 times (PCS:5389-5405).
  - While a hold is active, the fret mask that is compared is the held chip's own (PCS:4905).
  - The accumulated `nAccumulatedLongNoteBonusScore` is added to the all-Perfect score correction (PCS:1718-1720, 1822-1824).
- If the frets mismatch and the judgement of `now` against the end chip is `>= Miss` (that is, outside the end's Poor window), the hold is dropped (PCS:5407-5417).
  - **[FIX][NX-bug]** NX then calls `tStopPlayingWav(nLastPlayedWAVNumber.GtPick/BsPick)` (PCS:5414-5416). Those `STLANEVALUE` fields are never written: `tPlaySound` writes `.Guitar/.Bass` (PCS:1379, 1386), and the drum path only writes lanes 0–9 (PCS:810, 1371). So NX stops WAV #0, and the held sound keeps ringing.
  - DTXManiaAI actually stops the part's last voice (GPS:877-883). **[AI+]**
- No judgement, combo or gauge event happens at the end. Apart from the stop above, DTXManiaAI matches (GPS:843-885).

### 3.4 DTXManiaAI port

`PairLongNotes` (DC:595-629) has the same logic. It runs after the sweep and before the time sort (DC:563-564). It searches the part's `GBNote` list (sweep order) instead of `listChip`. The set of chips is identical (same part, visible), so the result is equivalent except for the same-Pos ordering in rule 6. Differences:
- Pairs are folded into `LongEndMs`/`LongEndPos`, and unpaired control chips are dropped.
- **[AI+]** `DurationMs` is extended to LN ends (DC:565-570). NX instead ends when every `listChip` chip has passed (PCS:2835-2838, 2846-2862).

**[FIX]** On the test pack, no pair is discarded. All `gt_*` and `ba_mst/ext/adv` have 0 strays; `ba_bsc.dtx` has 2 strays (rule 5; TV-16).

---

## 4. Totals: what counts as a note

### 4.1 NX

- `nVisibleChipsCount.Guitar` / `.Bass` = the number of chips on the 32 visible channels of that part (CDTX:3944-3971: guitar 3956-3960, bass 3961-3965).
- **OPEN is included.** Wailing (0x28/0xA8), LN control (0x2C/0x2D, which is the LN end), 0x2F and 0xBA/0xBB are **excluded**.
- A chord is one chip.
- An LN counts once, through its start chip.
- **[FIX]** The per-fret breakdown `incrementChipCount` (CDTX:752-1055) adds 1 to each fret counter of a chord; OPEN goes to `GuitarOpen`/`BassOpen`. `chipCountInLane` (CDTX:1081-1134) returns it as `ELane.GtPick`/`BsPick` (1117-1118, 1129-1130). It is used only for song info (`Score,Song/CSongManager.cs:926-943`).

Consumers of the total, with N = the part total:
- per-chip score base `1000000/(1275+50·(N−50))` (PCS:1703-1751, 1805-1855)
- skill and achievement `tCalculatePlayingSkill(N, …)` and `nTotalChipsCount` (PCS:156-175, 227-246)
- the combo max
- the target-ghost graph (PCS:4440-4520)
- the overall rank (`Score,Song/CScoreIni.cs:2020`)

**There is no bonus-chip term in the GB base.** Drums use `1000000 − 500·nボーナスチップ数` (PCS:1667).

### 4.2 DTXManiaAI

- `TotalNotes = p.Notes.Count` (GPS:1287).
- `GBScoreDelta(…, p.Notes.Count, …)` (GPS:1125; `Core/PerformanceResult.cs:195-214`; base at :202, no bonus term).
- Same as NX.

The drum total excludes GB chips, and the GB totals exclude drums.

---

## 5. Instrument presence and level headers

### 5.1 NX presence flags

The flags are set at **line-parse time, before the values are parsed** (CDTX:6668-6776). **[FIX]** This comes before the bar-length branch (6783), the empty-parameter check (6813), the invalid-character rejection (6830-6834) and the `00` skip (6867).

**[NX-only] quirk:** a data line on a visible GB channel sets the flag even if every object is `00`, the parameter is empty, or the line is later dropped for a bad character.

| Flag | Set by |
|---|---|
| `bチップがある.Guitar` (6674) | channels 0x20–27, 0x93–9F, **0xAA**–AF, 0xD0–D3 |
| `.Bass` (6678) | all 32 bass channels |
| `.YPGuitar` / `.YPBass` (6717-6769) | every Y/P channel (incl. 0xA9) |
| `.OpenGuitar` / `.OpenBass` (6708-6710, 6771-6773) | 0x20 / 0xA0 |

**[NX-bug]** `.Guitar` omits **0xA9** (Guitar_RxBxP), although the count (3956) and the part assignment (6887) include it.

Wailing, LN, 0x2F and 0xBA/0xBB never set any of these flags.

Consumers:
- `bScoreExists` (`CSongManager.cs:905-907`). GR mode lets a song be chosen iff `bScoreExists.Guitar || .Bass` (`Stage/05.SongSelection/CStageSongSelection.cs:1124-1133`).
- Scores are saved only for parts that have chips (`CScoreIni.cs:2014-2016`).
- **[ADD]** The result entry is filled only if the flag is set (PCS:151, 222).
- Per-part pick input is skipped when the part has no chips (PCS:4877-4880).
- **[ADD]** So under the 0xA9 bug, a guitar part made only of 0xA9 chips:
  - cannot be selected (unless bass exists)
  - receives no pick input, so every note misses
  - saves no score
- YP flags only choose between CLASSIC and XG level display (`CSongManager.cs:903-904`; `Stage/06.SongLoading/CStageSongLoading.cs:521-524`).
- Open flags are used only by HYPERRANDOM (CDTX:3152).

### 5.2 DTXManiaAI presence

- **Chart.** `HasGuitarNotes` / `HasBassNotes` = parsed chip count > 0. `HasYP*` = some parsed note has a Y or P bit (DC:497-498, 504-505). The YP flags are set but have no consumer.
- **Header scan `NoteMask` (DH:78-95). [AI+]**
  - It scans every data line, also after the header ends (DH:48-57).
  - The channel is classified by `InstrumentOfChannel` (DC:161-167):
    - guitar = 32 visible + 0x28 + 0x2C
    - bass = 32 visible + 0xA8 + 0x2D
    - drums = 0x11–1C and 0x31–3C
  - The bit is set if the parameter contains any character other than `0`, space, tab or `_`.
- `HasChart(i) = Level[i] > 0 || LevelDec[i] > 0 || NoteMask bit` (`Song/SongScore.cs:38-41`).
  - **[ADD]** Consumers: GR song-select cells (`Stages/SongSelectionStage.GRSelect.cs:368`), `SongListNode.cs:150`, and `SongInstrumentMerge.InstrumentMask` (`Song/SongInstrumentMerge.cs:163-175`).
  - `SongInstrumentMerge` merges split `(Drum)/(Guitar)/(Bass)` set.def blocks into one list entry. That is exactly the shape of the test pack's `set.def`. **[AI+]**
- **[AI+]** In GR mode, loading aborts back to song select if `!HasGuitarNotes && !HasBassNotes` (`Stages/SongLoadingStage.cs:130-136`).

### 5.3 Level headers

NX: CDTX:4839-4910. DTXManiaAI: DH:146-178.

```
#GLEVEL / #BLEVEL   (prefix match; glued "#GLEVEL85" accepted via t入力_パラメータ食い込みチェック, CDTX:4663-4670)
  if int.TryParse(param, v):
      v = clamp(v, 0, 1000)
      if v >= 100: LEVEL = (int)(v / 10f); LEVELDEC = v − LEVEL*10    // 745 → 74 / 5 ; 1000 → 100 / 0
      else:        LEVEL = v                                          // LEVELDEC untouched
#GLVDEC / #BLVDEC:  if int: LEVELDEC = clamp(v, 0, 10)
```

- The last write wins.
- Part index: 1 = guitar, 2 = bass.
- NX does not use the level to detect presence. The level feeds game skill (PCS:156, 162) and display (`CStageSongLoading.cs:519`).
- **[FIX] Web.** `setLevel` / `setLevelDec` in `dtx.js` match the clamp and split, but they use `parseInt`. That accepts trailing junk that C# `int.TryParse` rejects: `#GLEVEL 74.5` becomes 74 in the web but leaves the level unchanged in NX/AI. **[WEB]** Parse with `/^[+-]?\d+$/` after trimming.

### 5.4 [WEB] recommendation

- **Performance:** a part is playable iff its parsed note list is non-empty. This is DTXManiaAI's rule; ignore NX's `00`-line and 0xA9 quirks.
- **Song list:** `HasChart` (level OR non-zero data on that part's channels), as in DTXManiaAI. If no GB notes are found at load time, return to song select.

---

## 6. Chips of the instrument not being played

**[ADD]** In NX, "drum mode" means `bGuitarEnabled == false`. The config UI offers only DrOnly / GROnly, which set the two flags exclusively (`Stage/04.Config/CActConfigList.cs:3504-3506`; `bGuitarRevolutionMode = !bDrumsEnabled && bGuitarEnabled`, `App/CConfigIni.cs:895-901`). The GB auto-sound branch is the `else` of `if (configIni.bGuitarEnabled)` (PCS:3798, 4526-4531).

| Chip | Drum mode — NX | Drum mode — DTXManiaAI | GR mode — NX | GR mode — DTXManiaAI |
|---|---|---|---|---|
| GB visible | Not drawn or judged. At the bar (`nDistanceFromBar[part] < 0`) it plays through `tPlaySound(part)` (PCS:4527-4531, reached through PDS:3489-3495). Monophonic per part: stop the part's last WAV, then play (PCS:1375-1388); a missing WAV still stops the previous one. Volume `nモニタを考慮した音量(part)` (CDTX:1543-1574). | `ProcessGuitarBassAuto` (PS:1381-1401): monophonic per part, `WavVolume` only (no AutoVol). **[FIX]** A missing clip is skipped *without* stopping the previous voice (PS:1394-1395). After a seek, only the last chip is resumed (PS:1417-1440). | Judged (both parts are on screen). | Judged (both parts are on screen, GPS:299-301). |
| Wailing 0x28/0xA8 | `bHit` set immediately, not at the bar; silent (PCS:4609) | ignored | judged / auto-wail (PCS:4589-4607) | judged |
| LN 0x2C/0x2D | `bHit` only (PCS:3359-3375) | ignored | ends the hold | folded into start |
| 0x2F / 0xBA / 0xBB | state update only, silent | ignored | sound selectors | sound selectors |
| Drum visible 0x11–1C | judged | judged | Sound only, at the bar, through `tPlaySound(DRUMS)` (PGS:552-560; the drum mixer path includes HH choke, PCS:1307-1373) | `ProcessDrumsAuto` (GPS:673-686): `WavVolume × AutoVol`. **[AI+]** If the WAV is missing, it plays the bundled kit or synth (GPS:684); NX is silent. |
| Hidden drum 0x31–3C | hittable | hittable | `bHit` only, silent (PCS:3152-3168) | ignored |
| Drum NoChip / fill-in / bonus | — | — | `bHit` only (PGS:942-948, 745-750, 776-782) | ignored |

### 6.1 SE24–SE29 (0x84–0x89)

**[NX-only] mode-independent routing.**
- In NX, 0x88 is routed through the **guitar** slot and 0x89 through the **bass** slot (PCS:3280-3313), via `tPlaySound(GUITAR/BASS)`. That stops the part's last WAV, and the SE in turn is stopped by the next guitar chip.
- 0x84–0x87 go through the drum path.
  - 0x84 plays as HH, lane index 0.
  - 0x85–0x87 have their **channel rewritten** to CY/RD/LC (PCS:1326-1337).
- DTXManiaAI treats them as plain SE (DC:478-481). **[AI+]**
- **[ADD]** dtx-audio.md §9.2 says "routed through the drum mixer" for all six. That is accurate only for 0x84–0x87.

**[WEB]** Use plain SE.

**[FIX]** In the test pack, SE 0x66–0x92 are used round-robin by the BSC/ADV/EXT charts of **all three** instruments (`dm_*` too), and they avoid the muting channels 0x61–0x65. `ba_ext` uses only 0x66–0x80. Each MST uses a single 0x66 chip.
- In `gt_*`/`ba_*`, the SE chips carry the phrase WAV files that the easier arrangement dropped from the playable notes (for example `g_gt2992_01_026.wav`). They use their own `#WAV` ids, distinct from the note ids.
- Every GB note has its own WAV: `gt_mst` has 537 notes and 537 distinct ids.
- So the SE chips are meant to overlap the notes, and per-part monophony applies only to note chips.

### 6.2 [WEB] recommendation

- **Drum mode:** today the web is silent for GB chips, which deviates from NX. Auto-sound GB chips the way DTXManiaAI does. Prefer NX's "stop previous even if the new WAV is missing".
- **GR mode:**
  - Auto-sound drums as NX does: sound only, no hidden chips.
  - If the web shows one part only (NX shows both), auto-sound the other part like drum mode's GB auto: monophonic per part.

In the split-file pack this is moot, because `gt_*` has no bass or drum chips and the accompaniment is BGM 0x01 plus SE.

---

## 7. Hidden chips, bonus chips, GDA/G2D

### 7.1 Hidden GB chips

**None.** 0x31–0x3C are drums only (EC:44-55), and there is no `Guitar_Hidden`. 0xBA/0xBB are not hittable; they only switch the empty-pick sound (§2).

### 7.2 Bonus chips

0x4C–0x4F are drum only. Values 1–10 map to drum channels only (CDTX:2807-2861). The GB score has no bonus term (§4).

### 7.3 GDA / G2D

The file type is chosen by extension: `.gda` / `.g2d` (CDTX:3404-3416). The channel is then two letters, looked up case-insensitively in a table (CDTX:1480-1502, 6636-6653). An unknown name drops the line.

| Name | Meaning |
|---|---|
| `G0`–`G7` | Guitar Open, B, G, GB, R, RB, RG, RGB (0x20–0x27) |
| `GW` | 0x28 (guitar wailing) |
| `B0`–`B7` | 0xA0–0xA7 (bass) |
| `BW` | 0xA8 (bass wailing) |
| `TC` | BPM (0x03) |
| `BL` | bar length (0x02) |
| `FI` | fill-in (0x53) |
| `HH`, `SD`, `BD`, `HT`, `LT`, `CY` | drums |
| `GS`, `DS` | 0x29 / 0x30 (unused) |
| `01`–`09`, `0A`–`0F`, `10`–`20` | SE01–SE32 |

- There is no Y/P, no LN, no hidden channel and no 0xBA/0xBB.
- **[FIX][AI-bug]** DTXManiaAI lists GDA/G2D in its TODO (`docs/20_guitar-bass-mode.md` §6 item 6), but its song scan **does** list `.gda`/`.g2d` files as scores (`Song/SongManager.cs:80, 151-153`). It then parses them with the hex DTX parser (DC:761-764) and the hex NoteMask scan (DH:83). So DTXManiaAI falls into the trap described below.
- The web lists `.dtx` files only (`js/core/song.js:129, 148`).
- **[WEB] Not worth supporting now:** it is a legacy 3-lane format.
- **Never** feed a `.gda` file through the hex parser. Under hex parsing:
  - GDA `20` (SE32) would become Guitar OPEN.
  - `11`–`1C` (SE17–28) would become drum chips.
  - **[ADD]** `01`–`08` (SE01–08) would become BGM, bar length, BPM, BGA1, 0x05, 0x06, BGA2 and BPMEx.
  - `1F` (SE31) would become the drum cheer channel.
  - `BD` would become 0xBD (LeftPedal_NoChip).
  - `B1`–`B7` would become drum-NoChip channels.
- If support is ever added, it is one lookup applied before channel dispatch, selected by file extension.

---

## 8. Required WAV ids

### 8.1 NX

A WAV is loaded iff some chip on a WAV channel references it (`CStageSongLoading.cs:733`; channel sets built at CDTX:3976-3980).

- **[FIX]** GB WAV channels = all 64 visible channels, 0x2F, 0xBA and 0xBB (CChip:243-394).
- **Not** WAV channels: 0x28, 0xA8, 0x2C, 0x2D.
- The rule does not depend on the mode: GB WAVs are needed in drum mode (auto-sound), and drum WAVs in GR mode.

### 8.2 DTXManiaAI

`RequiredWavIds` (DC:638-659) returns distinct upper-cased ids, excluding `""` and `"00"`, in this order:

```
BGM, drum Notes, HiddenNotes, GuitarNotes, BassNotes, GuitarNoChip, BassNoChip, GuitarWailingSound, SE, Cheer
```

Wailing and LN ids are excluded. It is one list for both modes; hidden drum WAVs are still loaded in GR mode even though NX never sounds them there.

### 8.3 [WEB]

Insert `guitarNotes, bassNotes, guitarNoChip, bassNoChip, guitarWailSound` after `hiddenNotes` and before `seEvents`. Keep one list for both modes.

---

## 9. Related transforms that operate on parsed GB data

- **FLIP** (swap guitar and bass charts), NX `SwapGuitarBassInfos` (CDTX:4346-4422):
  - It rewrites the channels of GUITAR/BASS-part chips by arithmetic (4348-4382).
  - **[ADD]** It also swaps 0x2C↔0x2D (4384-4391) and 0x28↔0xA8 (4393-4400).
  - It swaps LEVEL, LEVELDEC, `nVisibleChipsCount` and the per-lane counters (4402-4415).
  - **[FIX]** Of the presence flags, it swaps **only** `bチップがある.Guitar/.Bass` (4417-4419). `YPGuitar/YPBass` and `OpenGuitar/OpenBass` are not swapped.
  - **[NX-bug]** It uses `+0x35` for the whole `Guitar_xxxYP..Guitar_RGBYP` enum range (4380). So 0xD0–0xD3 become 0x105–0x108 (garbage), and bass 0xE5–0xE8 become 0xB0–0xB3 (4363); 0xB1–0xB3 are drum NoChip channels. Chords R+Y+P, R+B+Y+P, R+G+Y+P and R+G+B+Y+P are corrupted.
  - LN links are references, so they survive.
  - **[WEB]** Swap the per-part lists, as DTXManiaAI does (GPS:317-325).
- **RANDOM** (NX `tRandomizeGuitarAndBass`, CDTX:3114 ff.) permutes only the 3-lane channels 0x20–0x27 / 0xA0–0xA7 (3133-3138). Y/P chips are not touched.
  - **[ADD]** HYPERRANDOM may turn a one- or two-lane chip into OPEN only if the chart has OPEN chips for that part (3152). It never does so for an LN start (3153-3157), so rule 1 of §3.2 keeps holding.

---

## 10. Parse test vectors

Every vector starts with `#BPM 120`. At 120 BPM, `ms = pos·625/120`, so:

| pos | ms |
|---|---|
| 384 | 2000 |
| 432 | 2250 |
| 480 | 2500 |
| 576 | 3000 |
| 672 | 3500 |
| 720 | 3750 |
| 768 | 4000 |
| 1152 | 6000 |
| 1536 | 8000 |

Note shape: `{part, timeMs, pos, bits, wavId, channel, lnEndMs = -1, lnEndPos = -1}`.

**TV-1 (table-driven).** For each of the 64 rows in §1.2:
- Input: `#001{CH}: 01`.
- Expected: exactly one note `{part, 4000, 768, bits(row), '01', CH}`, and no notes in the other part or in drums.
- Negative channels: `28, A8, 2C, 2D, 2F, BA, BB, C4, C7, D4, E0, 29, 2A, B0` must create **no** GB note.

**TV-2 (positions, `00`, lower case).**
- `#00020: 0100020000000000` → guitar `[{2000, 384, 0, '01'}, {2500, 480, 0, '02'}]`.
- `#001a9: 0z` → guitar `{4000, 768, bits 37, wavId '0Z', ch 0xA9}`. The web upper-cases at parse; DTXManiaAI keeps `'0z'` until `RequiredWavIds`.

**TV-3 (LN, basic).**
```
#00022: 01000000
#0002C: 01000100
```
Expected: guitar `[{2000, 384, bits 2, lnEndMs 3000, lnEndPos 576}]`; total 1.

**TV-4 (a note inside the LN breaks it).**
```
#00024: 01010000
#0002C: 01000100
```
Expected: R notes at 2000 and 2500, no LN.

**TV-5 (a note exactly at the end breaks it, and the control chip is consumed).**
```
#00021: 01000100
#0002C: 01000100
```
Expected: B notes at 2000 and 3000, **no** LN.

**TV-6 (OPEN cannot start an LN).**
```
#00020: 01000000
#0002C: 01000100
```
Expected: OPEN at 2000 as a plain note, no LN.

**TV-7 (a stray control chip is ignored, then pairing resumes).**
```
#00022: 0100000001000000
#0002C: 0001000001000100
```
Expected: G at 2000 plain; G at 3000 with `lnEndMs 3500`, `lnEndPos 672`. This also shows the parity shift of rule 5: the chip at 576 was "meant" as an end, but it became a start.

**TV-8 (parts pair independently).**
```
#000A4: 01000000
#00022: 00000100
#0002D: 01000100
```
Expected: bass R at 2000 with `lnEndMs 3000`; guitar G at 3000 plain.

**TV-9 (wailing does not break an LN and is not a note).**
```
#00022: 01000000
#00028: 00010000
#0002C: 01000100
```
Expected: guitar `[G 2000, ln → 3000]`; `guitarWailing [{2500, 480}]`; guitar total 1.

**TV-10 (channel traps).**
```
#000A9: 01
#001AF: 02
#002A8: 03
#003C7: 04
#003E0: 05
```
Expected:
- guitar `[{2000, bits 37}, {4000, bits 51}]`
- `hasYPGuitar` true
- `bassWailing [{6000}]`
- no bass notes
- C7 and E0 produce no GB data (unlike NX's `bBass可視チップ`, §1.3)

**TV-11 (sound switches).**
```
#000BA: 05
#000BB: 06
#0002F: 07
```
Expected:
- `guitarNoChip [{2000, '05'}]`
- `bassNoChip [{2000, '06'}]`
- `guitarWailSound [{2000, '07'}]`
- no notes; `hasGuitar` and `hasBass` false

**TV-12 (required WAV ids).** Input, one object each at measure 000:

| line | meaning |
|---|---|
| `#00001: 01` | BGM |
| `#00011: 02` | HH |
| `#00031: 0A` | hidden HH |
| `#00020: 03` | guitar OPEN |
| `#000A1: 04` | bass B |
| `#000BA: 05` | guitar empty-pick sound |
| `#000BB: 06` | bass empty-pick sound |
| `#0002F: 07` | wailing sound |
| `#00061: 08` | SE |
| `#0001F: 0B` | cheer |
| `#00028: 09` | wailing chip |
| `#0002C: 0C` | LN control |

Expected: `['01','02','0A','03','04','05','06','07','08','0B']`. Ids `09` and `0C` are absent.

**TV-13 (totals).**
```
#00020: 01000000
#00026: 00010000
#00022: 0000000001000000
#0002C: 0000000001000001
#00028: 00000001
```
Expected:
- guitar notes: OPEN at 2000, R+G (bits 6) at 2500, G at 3000 with `lnEndMs 3750`
- wailing at 3500, inside the LN, does not break it
- **guitar total = 3**
- DTXManiaAI `DurationMs` = 3750

**TV-14 (level headers, guitar index 1).**

| input | level[1] | levelDec[1] |
|---|---|---|
| `#GLEVEL 74` | 74 | 0 |
| `#GLEVEL: 745` | 74 | 5 |
| `#GLEVEL 1500` | 100 | 0 |
| `#GLEVEL85` | 85 | 0 |
| `#GLEVEL -5` | 0 | 0 |
| `#GLEVEL abc` | unchanged | unchanged |
| **[ADD]** `#GLEVEL 74.5` | unchanged (NX/AI `int.TryParse` fails; web HEAD `parseInt` wrongly gives 74) | unchanged |
| `#GLVDEC 12` | 0 | 10 |
| `#GLVDEC 3` then `#GLEVEL 74` | 74 | 3 |
| `#GLEVEL 745` then `#GLVDEC 3` | 74 | 3 |

`#BLEVEL 73` sets level[2] = 73.

**TV-15 (presence edge cases).**

| input | NX | DTXManiaAI | [WEB] |
|---|---|---|---|
| `#00120: 0000` | `bチップがある.Guitar` **true** | `HasGuitarNotes` false; `NoteMask` guitar bit 0 | not a guitar chart |
| `#00128: 01` only | Guitar false | `NoteMask` guitar bit **1**; `HasGuitarNotes` false | not playable |
| `#001A9: 01` only | `.Guitar` **false** (bug); `YPGuitar` true; count 1; not selectable in GR mode, pick input skipped, no score saved | `HasGuitarNotes` true | playable |

**TV-16 (local fixture `tests/fixtures/local/dreamer.zip`, Shift_JIS, `#BPM 190.000285`, no BPM or bar-length changes).**

Times below were computed with the §7.1 formula (no `.5` ties occur).

`gt_mst.dtx`:
- guitar notes **537**, of which OPEN 39; bass 0; drums 0
- wailing 4; 0x2C chips 12, giving **6 LNs**, 0 discarded, 0 stray
- first LN: Pos 16128, ch 0x94 (bits 17), at 53053 ms, ending at 53553 (end Pos 16280)
- last note at 112579 ms
- per-channel counts:

  | ch | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 93 | 94 | 95 | 96 | 9B | 9C | AC | AD |
  |---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
  | count | 39 | 20 | 8 | 139 | 26 | 68 | 60 | 7 | 45 | 20 | 45 | 7 | 22 | 28 | 3 |

`ba_mst.dtx`:
- bass notes **501**, of which OPEN 32
- wailing 3; 0x2D chips 26, giving **13 LNs**, 0 discarded, 0 stray
- first LN: Pos 16128, ch 0xC9 (bits 19), 53053 → 53145
- `hasYP` true for both charts
- last note at 112579 ms

**[ADD]** Other difficulties (all have 0 discarded pairs):

| file | notes | OPEN | wailing | ctrl chips | LNs | stray | hasYP |
|---|---|---|---|---|---|---|---|
| `gt_ext` | 475 | 4 | 4 | 12 | 6 | 0 | true |
| `gt_adv` | 267 | 0 | 4 | 12 | 6 | 0 | true |
| `gt_bsc` | 193 | 0 | 4 | 12 | 6 | 0 | true (one 0x93) |
| `ba_ext` | 486 | 0 | 3 | 26 | 13 | 0 | true |
| `ba_adv` | 328 | 0 | 3 | 26 | 13 | 0 | true |
| `ba_bsc` | 253 | 0 | 3 | 26 | **12** | **2** (Pos 16272, 16300) | **false** |

**TV-17 (mixed-mode chart).**
```
#00011: 01000000
#00022: 00000100
```
Expected:
- drum total 1, guitar total 1
- in drum mode, the guitar chip is auto-sounded at 3000
- in GR mode, HH is auto-sounded at 2000
- DTXManiaAI `DurationMs` = 3000

**TV-18 [ADD] (two consecutive strays, as in `ba_bsc.dtx`).**
```
#000A2: 0000000001000000
#0002D: 0101000001000100
```
Expected: the controls at 384 and 432 are strays (no bass chip there). Bass G at 3000 has `lnEndMs 3500`, `lnEndPos 672`. Bass total 1.

**TV-19 [ADD] (zero-length LN from duplicate lines, rule 6).**
```
#00022: 01
#0002C: 01
#0002C: 01
```
Expected: guitar G at 2000 with `lnEndMs 2000`, `lnEndPos 384`. `IsLong` is true in DTXManiaAI, and the total is 1.

---

## Key facts

- There are 64 visible GB channels, with bits R4 G2 B1 Y16 P32 and OPEN = 0. 0xA9–0xAF are guitar; 0xA8 is bass wailing; 0xC4, 0xC7, 0xD5–D9 and 0xE0 are BGA swaps, not bass. NX's `bBass可視チップ` wrongly includes 0xE0 [NX-bug].
- Totals count visible chips only: OPEN is counted, wailing and LN control are not. The GB score has no bonus term. Chips are never merged into chords.
- An LN starts at a control chip that has a non-OPEN visible same-part chip at the same Pos. It ends at the next same-part control chip. It is discarded if any visible same-part chip lies in `(start, end]`; a discarding control chip is consumed, and strays shift the start/end parity. The end is never judged; the hold earns up to 5 × 100 points. Any Miss of the part cancels the hold. NX's "stop sound on release" is a no-op [NX-bug].
- 0x2F (wailing sound) is guitar-only; bass has no equivalent. 0xBA/0xBB select the empty-pick sound; without one, the nearest chip of that part is borrowed.
- In NX, non-played instruments are auto-sounded at the bar and never judged (drum mode = `bGuitarEnabled == false`). Hidden drums stay silent in GR mode. GB auto-sound is monophonic per part.
- WAV ids are loaded for the 64 visible channels plus 0x2F/0xBA/0xBB, in both modes. Wailing and LN ids are never loaded.
- `.gda`/`.g2d` must not go through the hex parser; DTXManiaAI does exactly that [AI-bug].

## Open questions

1. Does the web GR mode show one part or both (NX and DTXManiaAI show guitar and bass together)? This decides whether §6's "auto-sound the other part" is needed.
2. Should DTXManiaAI's `DurationMs` rule (GB notes and LN ends extend the song) also apply in web drum mode? Today `durationMs = lastNoteMs` over drums only.
3. 0x84–0x89 routing: this spec recommends plain SE (DTXManiaAI) rather than NX's part-mixer route. This needs confirmation as an intentional deviation.
4. [ADD] When an LN hold is released, should the web stop the held WAV (DTXManiaAI, the evident intent) or keep NX's effective behaviour (the sound keeps ringing because of the `GtPick/BsPick` bug)?
5. [ADD] For play-speed scaling of `TimeMs`/`LongEndMs`, should the web round (NX CDTX:3925-3932) or truncate (DTXManiaAI GPS:465-491)?
