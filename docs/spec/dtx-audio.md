# dtx-audio

# DTXManiaAI chart / audio behavioral specification — v2 (merged, corrected, extended)

Sources (absolute paths, all re-read for this revision):
- `DTXManiaAI\Assets\Scripts\Song\DtxChart.cs` (877 lines) — chart body parser + timing
- `DTXManiaAI\Assets\Scripts\Song\DtxIfStack.cs` — #RANDOM/#IF/#ENDIF
- `DTXManiaAI\Assets\Scripts\Song\DtxHeader.cs` — header-only reader (song list)
- `DTXManiaAI\Assets\Scripts\Song\TextEncodingUtil.cs` — encoding
- `DTXManiaAI\Assets\Scripts\Song\SetDef.cs`, `BoxDef.cs`, `SongManager.cs`, `SongInstrumentMerge.cs`, `SongScore.cs` — song folder presentation
- `DTXManiaAI\Assets\Scripts\Audio\SoundManager.cs`, `DrumSynth.cs`, `AudioFileLoader.cs`, `libbjxa.cs`; `DTXManiaAI\Assets\Scripts\Core\ChipVoicePool.cs`, `Core\SongClock.cs`
- Consumers: `DTXManiaAI\Assets\Scripts\Stages\PerformanceStage.cs`, `Stages\SongLoadingStage.cs`, `Config\ConfigIni.cs`, `Core\GameMain.cs`
- Cross-check: `vid2dtx\vid2dtx\dtx.py` (228 lines)

## 0. Change log versus the v1 spec (what was wrong / missing)

CORRECTIONS
- C1 (§4) Beat-line spacing examples were reversed. Spacing = `96 / barLen` ticks: barLen 0.5 → 192 ticks (2 beats), 0.75 → 128 (3), 1.0 → 96 (4), 1.5 → 64 (6), 2.0 → 48 (8). (DtxChart.cs:711)
- C2 (§10) "AUTO hits use AutoChipVolume" is only true for per-lane AUTO (`AutoJudge` → `PlayHit(note, auto:true)`, PerformanceStage.cs:2733). Global AUTO (`_auto`) judges via `Judge(i, Perfect)` → `PlayHit(note)` with `auto=false` → uses ChipVolume (2140, 2792).
- C3 (§10) Jump/resume (`ResyncList`) restarts BGM at `WavVolume(id)` only — it drops the `AutoVol` factor and ignores `Config.BgmSound` (1458). v1 implied identical volume.
- C4 (§1.4) The glued form `#BPM120` (no separator) is NOT accepted by DtxChart: cmd `BPM120` has length 6, so neither the exact `BPM` test nor the length-5 `#BPMxx` test matches (331, 347). `#BASEBPM120` and `#SOUND_STAGEFAILEDx` ARE accepted (prefix `TakeCommand`, 337-346).
- C5 (§11.4) `ScaleChartTimes` also scales `BpmChanges[i].TimeMs` (1276-1281) and `_pgLastChipMs`; v1 omitted BpmChanges.
- C6 (§6) The "chips[0] skipped" quirk in `ApplyBeatLineDisplay` can never fire: no 0xC2 chip can sit at Pos 0 (minimum data Pos is 384 and only ch53 is shifted, by ±32).
- C7 (§8) `#DLEVELDEC:5` is captured by the `DLEVEL` prefix (param becomes `DEC`, int parse fails) and is silently ignored — it is NOT treated as `#DLVDEC` (DtxHeader.cs:149, DtxIfStack.cs:71-74).

ADDITIONS
- A1 Cheer, metronome and fallback sounds go through `SoundManager.Play` = `_source.PlayOneShot` (no #VOLUME/#PAN, cheer volume 1.0, pitch-shifted by play speed) (§10.4, §10.5).
- A2 Empty-hit sound ("空打ち"): pad pressed with no chip in the window borrows the nearest chip's WAV, else the lane fallback (§10.7).
- A3 `#SOUND_NOWLOADING` (SongLoadingStage) and `#SOUND_STAGEFAILED` (DtxChart) file semantics (§1.6).
- A4 `SongInstrumentMerge` — how Drum/Guitar/Bass variant charts in one folder collapse into one list entry (§12.4).
- A5 bjXA 4/6/8-bit unpacking rule (§11.6) — removes the v1 open question.
- A6 SongClock origin (songMs = 0 at PerformanceStage enter) and in-game play-speed change (§10.1, §11.4).
- A7 Parser edge cases: leading ':' retained in params after a space separator; `#WAV01 :x` illegal path; header/chart divergence for space-separated data lines; GDA letter channels unsupported; duplicate ch02 ordering hazard (§1.3, §3, §7.2).
- A8 SE24-29 (0x84-0x89) treated as plain SE — intentional divergence from NX (§9.2).

---

## 1. File reading and line grammar (DtxChart.DoParse, DtxChart.cs:294-391)

### 1.1 Encoding (TextEncodingUtil.cs:14-25; DtxChart.cs:307)
- Reader = `new StreamReader(path, TextEncodingUtil.ShiftJis)`. `ShiftJis` resolves once: `Encoding.GetEncoding(932)` → `GetEncoding("shift_jis")` → `GetEncoding("shift-jis")` → if all fail, `Encoding.UTF8` (TextEncodingUtil.cs:21-23). In a Unity/Mono build lacking the I18N.CJK assembly this fallback silently garbles Shift-JIS titles.
- There is NO custom BOM sniffing, BUT the .NET `StreamReader(string, Encoding)` constructor defaults `detectEncodingFromByteOrderMarks = true`, so a UTF-8 BOM (EF BB BF), UTF-16 LE (FF FE) / BE (FE FF) or UTF-32 LE/BE BOM overrides the Shift-JIS default. Files without a BOM are decoded as CP932; undecodable bytes become U+FFFD.
- `ReadLine` accepts CR, LF and CRLF terminators.
- Same reader is used for set.def / box.def / DtxHeader / #SOUND_NOWLOADING scan (SetDef.cs:34, BoxDef.cs:30, DtxHeader.cs:23, SongLoadingStage.cs:390).
- Web equivalent: check BOM first; else `new TextDecoder('shift_jis')` (Encoding Standard label; also `windows-31j`).

### 1.2 Per-line preprocessing (DtxChart.cs:310-328)
```
for each line (ReadLine):
  s = line.TrimStart(' ', '\t')            // leading spaces/tabs only; trailing kept
  if s.Length < 2 or s[0] != '#': continue // non-# lines and lone "#" ignored (313-314)
  body = s.Substring(1)
  (cmd, param) = SplitHeader(body)         // §1.3
  if ifStack.SkipsLine(cmd, param): continue  // §2 — evaluated BEFORE data-line detection (320)
  if body.Length >= 6 and isDigit(body[0]) and isDigit(body[1]) and isDigit(body[2]):
      ParseDataLine(body); continue        // §3 (324-328); note: uses body, not cmd/param
  else: header dispatch on cmd/param       // §1.4
```
- `char.IsDigit` accepts Unicode digits; `int.TryParse` later rejects non-ASCII ones → such a line is dropped (759-760).
- No `//` comment support; only `;` (see below). A line `#00011:` (body length 6, empty data) is a data line that produces nothing.

### 1.3 SplitHeader (DtxChart.cs:821-831) and StripComment (DtxIfStack.cs:83-88)
```
colon = body.indexOf(':'); space = body.indexOfAny(' ', '\t')
sep = (colon==-1) ? space : (space==-1) ? colon : min(colon, space)
if sep < 0: cmd = body.Trim(); param = ""
else:       cmd = body[0..sep].Trim(); param = StripComment(body[sep+1..])
StripComment(s): cut at first ';', then .Trim()   // whitespace only; a leading ':' is NOT stripped
```
- `#TITLE: foo` → cmd `TITLE`, param `foo`; `#BPM 120` → cmd `BPM`; `#WAV01\tsnare.wav\t;comment` → param `snare.wav`; `#TITLE:a:b` → param `a:b`.
- EDGE (added): when the FIRST separator is a space/tab and a colon follows, the colon stays in the param: `#WAV01 :snare.wav` → `WavDefs["01"] = ":snare.wav"`; `Path.Combine` then throws on Windows (':' illegal) and that WAV is skipped (SongLoadingStage.cs:277-282). `#TITLE : foo` in DtxHeader → Title `: foo`. Recommended web behaviour: after splitting, strip one leading ':' from the param (NX-like).

### 1.4 Header commands handled by DtxChart (DtxChart.cs:331-389). Comparisons case-insensitive. Tested in this order (first match wins):
1. `cmd == "BPM"` (exact) → `TryParseBpm(param)`; accepted only if `v > 0` → `Bpm = v` (default 120.0, line 234). Empty param → ignored. (331-336)
2. `cmd startsWith "SOUND_STAGEFAILED"` (TakeCommand, §2.2, glued form allowed) → `SoundStageFailed = param` (relative path from chart folder). (337-340)
3. `cmd startsWith "BASEBPM"` (glued `#BASEBPM120` allowed) → if `v > 0`: `BaseBpm = v` (default 0.0). (341-346)
4. `cmd.Length == 5 && cmd startsWith "BPM"` → `zz = cmd[3..5].ToUpperInvariant()`; if `v > 0`: `zz == "00"` ? `Bpm = v` : `bpmMap[zz] = v`. KEY IS THE 2-CHAR UPPERCASED STRING (not a base-36 number; `#BPM0_` is a valid key). (347-357) CORRECTION C4: `#BPM120` (length 6) and `#BPM0` (length 4) fall through every test and are ignored.
5. `cmd.Length == 5 && startsWith "WAV"` → if param non-empty: `WavDefs[cmd[3..5].upper] = param` (later definition overwrites). (358-363)
6. `cmd.Length == 8 && startsWith "VOLUME"` → `int.TryParse(param)` (integers only; `50.0` rejected) → `WavVolumes[cmd[6..8].upper] = clamp(vol, 0, 100)`. (364-370)
7. `cmd.Length == 5 && startsWith "AVI"` → `AviDefs[id] = param` if non-empty. (371-376)
8. `cmd.Length == 5 && startsWith "PAN"` → `WavPans[id] = clamp(pan, -100, 100)`. (377-383)
9. `cmd.Length == 5 && startsWith "BMP"` → `BmpDefs[id] = param` if non-empty. (384-389)

`TryParseBpm(s)` (865-870): `double.TryParse(s, NumberStyles.Float, InvariantCulture)`; on failure retry with `','`→`'.'`. NumberStyles.Float accepts leading/trailing whitespace, sign, decimal point, exponent.

NOT handled anywhere in DtxChart: `#WAVVOLxx`, `#WAVPANxx`, `#BGMWAV`, `#DTXVPLAYSPEED`, `#RESULTIMAGE`, `#HIDDENLEVEL`, `#PATH_WAV`, `#PATH`, `#TITLE` etc. (a grep of the whole Scripts tree finds none; ResultStage.cs:535-536 states RESULTIMAGE is unsupported and falls back to PREIMAGE). Metadata is read separately by DtxHeader (§8).

### 1.5 Robustness
`DtxChart.Parse` wraps `DoParse` in try/catch and returns whatever was built so far (280-292). A missing/empty path returns an empty chart (296-297). Headers after the first data line ARE still processed by DtxChart (no `bodyStarted` cut-off, unlike DtxHeader).

### 1.6 (added) Song-folder sound files referenced by headers
- `#SOUND_STAGEFAILED` (DtxChart, §1.4 item 2): at PerformanceStage enter, `Path.Combine(chartFolder, value)`; if the file exists it is loaded and replaces the skin "Stage failed" sound (PerformanceStage.cs:659-667).
- `#SOUND_NOWLOADING` is NOT parsed by DtxChart/DtxHeader; SongLoadingStage rescans the file itself (SongLoadingStage.cs:381-415): first line whose `TrimStart()`-ed text starts with `#` and whose body starts (case-insensitive) with `SOUND_NOWLOADING` followed by `:`/space/tab/end-of-line; value = `StripComment(rest after that one separator).Trim()`. If `chartFolder + value` exists it is played as the exclusive "now loading" sound (stops the select BGM) instead of the skin `Now loading.ogg` (111-125, 328-360; NX-layout mode only).

---

## 2. #RANDOM / #IF / #ENDIF (DtxIfStack.cs)

State: `skipStack: Stack<bool>` initialised with `[false]` (line 19); `currentRandom = 0` (line 15); `System.Random` (14). `InIfBlock = stack.Count > 1` (23).

```
SkipsLine(cmd, param):                              // DtxIfStack.cs:29-62
  if TakeCommand(cmd,param,"ENDIF"):  if stack.Count > 1: pop;  return true   // extra #ENDIF at depth 1 ignored
  if TakeCommand(cmd,param,"IF"):
      if stack.Count < 255:                         // nesting overflow: this #IF is consumed but NOT pushed;
          if stack.top == true: push(true)          //   its matching #ENDIF will later pop the PARENT frame
          else: n = int.TryParse(param) ? n : 1;  push(n != currentRandom)
      return true
  if stack.top == true: return true                 // skip EVERYTHING (headers + data) inside a non-taken branch
  if TakeCommand(cmd,param,"RANDOM"):
      n = int.TryParse(param) ? n : 1
      currentRandom = rng.Next(max(n,0)) + 1        // uniform 1..n; n<=0 → Next(0)=0 → 1
      return true
  return false
```
- Before any `#RANDOM`, `currentRandom == 0`, so every `#IF n` (n ≥ 1) is NOT taken; `#IF 0` (or `#IF` with unparsable param → n=1) — only `#IF 0` would be taken before a #RANDOM.
- `#ENDIF` is handled (pop) even while skipping; `#ELSE`/`#ENDRANDOM`/`#SETRANDOM` are unknown headers and ignored (no ELSE support).
- `#RANDOM` inside a skipped block is ignored (the `stack.top` check precedes it).
- Prefix matching: any cmd starting with `IF` / `ENDIF` / `RANDOM` (e.g. `#IFOO`) is treated as that command with the remainder as its param.
- DtxHeader and DtxChart each create their OWN `DtxIfStack` with its own `System.Random` (DtxHeader.cs:28, DtxChart.cs:305) → song-list metadata and the performed chart may pick different branches. Prefer: pick once per load in the web app.

### 2.2 TakeCommand (DtxIfStack.cs:67-78) — prefix + "glued parameter" form
```
TakeCommand(cmd, param, name):
  if !cmd.startsWithIgnoreCase(name): return false
  if cmd.Length > name.Length: param = cmd.Substring(name.Length); cmd = name   // "#IF1" → IF,"1"; existing param DISCARDED
  param = StripComment(param); return true
```

---

## 3. Measure data lines — ParseDataLine (DtxChart.cs:753-807)

```
colon = body.indexOf(':');  if colon < 5: return          // "#00011 0101" (no colon) is IGNORED (755-757)
measure = int.Parse(body[0..3])                           // DECIMAL 3 digits (000..999); "A00" never reaches here (§1.2)
channel = Convert.ToInt32(body[3..5], 16); on exception (e.g. GDA "HH", "1G") return   // GDA/G2D letter channels unsupported
data = body[colon+1..]; cut at first ';'; remove ALL ' ' and '\t' (NOT '_'); if empty return   (766-771)
maxMeasure = max(maxMeasure, measure)                     // updated for every non-empty data line incl. ch02 (773)
basePos = (measure + 1) * 384                             // LEAD-IN: DTX measure 0 starts at tick 384 (774)

if channel == 0x02:                                       // bar length (776-782)
    v = double.TryParse(data, Float, Invariant) (failure → 0)   // NO ','→'.' conversion here; "0,75" → 0 → later 1.0
    chips.add{Pos=basePos, Channel=0x02, Value=v}; return       // one chip per ch02 line, even if several per measure

objCount = data.Length / 2 (integer; odd trailing char dropped); if 0 return
for i in 0..objCount-1:
    id = data[2i..2i+2]
    if id == "00": continue                               // literal string compare; "0_" / "_0" / "0 " are NOT skipped
    pos = basePos + (384 * i) / objCount                  // integer division (792)
    chip = {Pos=pos, Channel=channel, WavId=id (original case)}
    if channel == 0x03: chip.IntVal = ParseHex(id)        // lenient: stops at first non-hex char (849-862); "0_" → 0
    elif channel in {0x53, 0xC2}: chip.IntVal = ParseBase36(id)   // lenient (834-847)
    if channel == 0x53: if IntVal==1: chip.Pos -= 32; elif IntVal==2: chip.Pos += 32   // fill-in ON 32 ticks EARLIER, OFF 32 ticks LATER (798-804)
    chips.add(chip)
```
- `'_'` is NOT stripped by DtxChart (only DtxHeader.NoteChannel skips `_`, DtxHeader.cs:90). A chart using `_` separators produces garbage ids; the web app should strip `_` (NX and dtx.py do) — see §13.
- Every other channel's `id` is kept as the raw 2-char string (WAV/BPM-table/AVI/BMP lookups use `id.ToUpperInvariant()`).
- Bonus channel value is decoded later with ParseBase36 (488). 0xC1 value is never decoded (only position matters, §4).
- Data lines with spaces instead of ':' are dropped here but DO set `NoteMask` in DtxHeader (§8) → a song can be listed as having a drum chart yet play empty.

---

## 4. Bar-line / beat-line generation — InsertBarAndBeatLines (DtxChart.cs:669-719), run BEFORE sorting

```
if chips.isEmpty: return                                   // no lines at all for an empty chart (671-672)
maxPos = (maxMeasure + 1) * 384; maxPos = max(maxPos, max(chip.Pos))     // includes fill-in +32 shifts (673-675)
endOfSong = (maxPos + 384) - (maxPos % 384)                // the multiple of 384 STRICTLY greater than maxPos (676)
barLengths: map measureStartPos → (Value > 0 ? Value : 1.0)   // last one in FILE ORDER wins per measure (683-687)
shifts:     map measureStartPos → (C1chip.Pos - measureStartPos) // 0xC1: VALUE ignored; position inside measure = shift (0..383); last in file order wins (688-693)

barLen = 1.0
for tick = 0; tick <= endOfSong; tick += 384:
    measure = tick/384 - 1                                 // -1 = lead-in measure (699)
    add {Pos=tick, Channel=0x50, Measure=measure, Generated=true}
    if tick >= endOfSong: break                            // final bar line has no beat lines (702-703)
    if barLengths has tick: barLen = barLengths[tick]      // persists to later measures (705)
    shift = shifts[tick] or 0                              // NOT persisted (707)
    for i = 0..99:
        tickBeat = (int)((384.0 * i) / (4.0 * barLen))     // truncation (711)
        if tickBeat + shift >= 384: break
        if (tickBeat + shift) % 384 == 0: continue         // only i=0 with shift 0 (coincides with bar line)
        add {Pos=tick + tickBeat + shift, Channel=0x51, Measure=measure, Generated=true}
```
CORRECTION C1 — beat spacing = `96 / barLen` ticks (position space): barLen 0.5 → 192 (beats at 192 → 1 beat line), 0.75 → 128 (128, 256 → 2), 1.0 → 96 (96, 192, 288 → 3), 1.5 → 64 (64..320 → 5), 2.0 → 48 (48..336 → 7). With `shift > 0` the i=0 beat line IS emitted at `tick + shift` (e.g. shift 48, barLen 1 → beat lines at 48, 144, 240, 336; i=4 → 432 ≥ 384 break).
Example: maxMeasure = 10 → maxPos = 4224 → endOfSong = 4608 → bar lines at 0, 384, …, 4608 (13 lines, Measure −1..11); beat lines for measures −1..10. A fill-in "02" chip in the last measure at high resolution (objCount ≥ 12, last slot) can push `maxPos` past the next measure start and add one more empty measure.
Directly written 0x50/0x51 chips in the DTX are also kept: they become BarLine entries with `Visible=true` always and `Measure=0` (default), and are never affected by 0xC2 (747).

## 5. Sort (DtxChart.cs:397-401, 809-818)
Sort chips by `Pos` ascending; ties by `CtrlPriority(channel)`:
`0`: 0x02, 0x03, 0x08 · `1`: 0xC1 · `2`: 0x50, 0x51 · `3`: 0xC2 · `4`: everything else.
C# `List.Sort` (introsort) is unstable; use a stable sort in JS (ordering among equal keys is unspecified in the original). Hazard: two ch02 lines for the same measure — §4 uses the LAST in file order, but the timing sweep processes both in unspecified order, so the effective bar length for timing may be the other value.

## 6. 0xC2 show/hide — ApplyBeatLineDisplay (DtxChart.cs:725-751)
```
show = true
for i in 0..chips.Count-1:
    changed = false
    if chips[i].Channel == 0xC2:
        if IntVal == 1: show = true; changed = true
        elif IntVal == 2: show = false; changed = true    // other values: no effect
    start = i
    if changed:
        while start > 0 and chips[start].Pos == chips[i].Pos: start--
        start++          // quirk copied from NX (skips chips[0] if the run reaches index 0) — unreachable, see C6
    for j in start..i:
        if chips[j].Generated and Channel in {0x50,0x51}: chips[j].Visible = show
```
Effect: state persists forward (every generated line at index i receives the current `show`); a C2 also retro-applies to generated lines at the same Pos (they sort before it by priority 2 < 3).

## 7. Timing sweep (DtxChart.cs:411-554)

### 7.1 Formula
```
currMs = 0.0 (double); bpm = Bpm (header; if <= 0 → 120); barLen = 1.0; lastPos = 0
BpmChanges = [{TimeMs:0, Bpm:bpm}]                                (416-417)
for chip in sortedChips:
    t = currMs + 625.0 * (chip.Pos - lastPos) * barLen / bpm     // ms; 625 = 240000/384 (one 4/4 measure = 240000/bpm ms)
    chip.TimeMs = (int)Math.Round(t)   // C# banker's rounding (half → even); currMs itself keeps the UNROUNDED double
    switch chip.Channel: ...
```
`barLen` semantic: 1.0 = 4/4 (384 ticks = 4 beats). Time of DTX measure 0 start = 625·384/Bpm = 240000/Bpm ms (2000 ms at 120 BPM) because of the lead-in measure. `LeadInMs` in PerformanceStage is 0 (PerformanceStage.cs:44) — the chart itself carries the lead-in. Time is monotonic non-decreasing in Pos (bpm > 0, barLen > 0 always hold), so Pos order == time order.

### 7.2 Control channels (426-438)
- `0x02`: `lastPos = Pos; currMs = t; barLen = (Value > 0 ? Value : 1.0)`. Applies from that measure start onward (the chip sits at the measure start and sorts first).
- `0x03`: `lastPos = Pos; currMs = t; bpm = BaseBpm + IntVal(hex 00-FF)`; `if bpm <= 0: bpm = Bpm(header)`; push BpmChange{chip.TimeMs, bpm}. (A stray `0_` id on ch03 therefore resets to the header BPM.)
- `0x08`: `lastPos = Pos; currMs = t`; `if bpmMap[id.upper] exists and BaseBpm + value > 0: bpm = BaseBpm + value` (else bpm unchanged); push BpmChange REGARDLESS (unknown id → duplicate entry with the same bpm).
Both BPM channels add BASEBPM.

### 7.3 Dispatch of other channels (439-552) — outputs
| Channel | Handling |
|---|---|
| 0x50 / 0x51 | `BarLines.add{TimeMs, IsBeat=(ch==0x51), Visible, Measure}` |
| 0x01 BGM | `BgmEvents.add{TimeMs, Lane=-1, WavId}` |
| 0x1F cheer | `CheerEvents.add{TimeMs, WavId, Channel}` |
| 0x53 fill-in | if `1 <= IntVal <= 6`: `FillInEvents.add{TimeMs, Value}` (Pos already shifted ±32 ticks for 1/2) |
| 0x54 movie | `MovieEvents.add{TimeMs, WavId}` (#AVIxx id; only the FIRST event is ever used, PerformanceStage.cs:754, SongLoadingStage.cs:302) |
| 0x04 | `BgaEvents{Lane=0}`; 0x07 → Lane 1; 0x55..0x59 → Lane 2..6 (#BMPxx ids) |
| SE (§9.2) | `SeEvents.add{TimeMs, WavId, Channel}` |
| 0x4C-0x4F bonus | `BonusChipCount++` unconditionally (even for value 0/out of range); `bv = ParseBase36(id)`; if `1<=bv<=10`: remember (Pos, lane = table `{1:LC 2:HH 3:LP 4:SD 5:HT 6:BD 7:LT 8:FT 9:CY 10:RD}`) (183, 484-492) |
| guitar/bass visible (§9.3) | `GuitarNotes/BassNotes.add{TimeMs, Bits, WavId, Channel, Pos}`; sets HasYPGuitar/HasYPBass when Bits has Y or P; `DurationMs = max(...)` |
| 0x28 / 0xA8 wailing | `GuitarWailing/BassWailing` (no WAV) |
| 0x2C / 0x2D long-note ctrl | collected, paired later (§7.5) |
| 0xBA / 0xBB | `GuitarNoChipEvents/BassNoChipEvents` (empty-pick sound switch) |
| 0x2F | `GuitarWailingSoundEvents` |
| 0x11-0x1C drums | `Notes.add{TimeMs, Lane, WavId, Channel, Pos}`; `DurationMs = max(DurationMs, TimeMs)` |
| 0x31-0x3C hidden drums | `Channel -= 0x20`, same lane mapping, `HiddenNotes.add` (NOT counted in DurationMs, not judged/scored) |
| anything else (incl. 0xC1, 0xC2, unknown) | ignored |

### 7.4 Post-processing (556-585)
- Bonus flags: for each (Pos, lane) mark, every visible `Note` with the same `Pos` AND `Lane` gets `Bonus = true` (557-560). Score baseline used elsewhere: `1000000 - 500 × BonusChipCount` (comment 189).
- `DurationMs` = max TimeMs over visible drum notes, guitar notes, bass notes, and long-note end times (499, 506, 549, 567-570). BGM/SE/bar lines/hidden notes do NOT extend it.
- Sorted by TimeMs (unstable): Notes, HiddenNotes, GuitarNotes, BassNotes, wailing, no-chip, wailing-sound, BarLines, FillInEvents, CheerEvents, SeEvents (572-585). BgmEvents/MovieEvents/BgaEvents are left in Pos order (identical to time order, §7.1).

### 7.5 Long-note pairing — PairLongNotes (595-629), per part, in Pos order
```
candidate = null
for ln in longChips (0x2C/0x2D, Pos asc):
  if candidate == null:
      candidate = first note with note.Pos == ln.Pos and !note.IsOpen   // OPEN can't start an LN; none found → stays null
  else:
      if any note with candidate.Pos < note.Pos <= ln.Pos: candidate = null   // a visible note at the END position also violates
      else: candidate.LongEndMs = ln.TimeMs; candidate.LongEndPos = ln.Pos; candidate = null
```

### 7.6 RequiredWavIds (638-659)
Distinct uppercased ids, excluding "" and "00", in order: BGM, Notes, HiddenNotes, GuitarNotes, BassNotes, GuitarNoChip, BassNoChip, GuitarWailingSound, SE, Cheer. Excluded: AVI/BMP ids, wailing chips (no WAV), ch08 ids. Load order = this list (BGM first); files are `Path.Combine(chartFolder, WavDefs[id])` (SongLoadingStage.cs:142-146, 277), loaded sequentially before the performance starts; an id with no `#WAVxx` is skipped silently.

---

## 8. Header-only reader — DtxHeader (song list)
Line handling: skip empty lines (33); same TrimStart/`#` rule; `SplitCommand` identical to SplitHeader (DtxHeader.cs:97-118); same `DtxIfStack`. A data line is `body.Length >= 3 && 3 leading digits` (51) (weaker than DtxChart's ≥ 6); once a data line is met OUTSIDE any #IF block, `bodyStarted = true` and later header commands are ignored, but data lines keep being scanned for `NoteMask` (53-59).
`NoteChannel` (78-95): cmd must be ≥5 chars; `ch = strict hex(cmd[3..5])`; `inst = InstrumentOfChannel(ch)` (0 drums for 0x11-0x1C and 0x31-0x3C; 1 guitar = visible guitar bits ∪ {0x28, 0x2C}; 2 bass = visible bass bits ∪ {0xA8, 0x2D}; −1 otherwise — DtxChart.cs:161-167); any char in param other than `'0' ' ' '\t' '_'` sets `NoteMask |= 1<<inst` (space-separated data lines count here even though DtxChart drops them).
`Apply` (128-152), case-insensitive: `TITLE`→Title, `ARTIST`, `COMMENT`, `GENRE`, `PREVIEW`→Presound, `PREIMAGE`, `PREMOVIE`, `STAGEFILE`|`BACKGROUND`→Background, `BPM`|`BPM00`→Bpm (TryParseBpm, >0; SongScore.Bpm default 120.0, SongScore.cs:31), prefix `DLVDEC`/`GLVDEC`/`BLVDEC`→LevelDec[part]=clamp(int,0,10), prefix `DLEVEL`|`PLAYLEVEL`/`GLEVEL`/`BLEVEL`→SetLevel (parts 0/1/2 = drums/guitar/bass). Prefix commands accept the glued form (`#DLEVEL85`). CORRECTION C7: `#DLEVELDEC` is swallowed by the `DLEVEL` prefix and ignored.
`SetLevel` (155-171): `v = clamp(int, 0, 1000)`; if `v >= 100`: `Level = (int)(v/10f); LevelDec = v - Level*10` (856 → 85 + dec 6; 1000 → 100.0) else `Level = v` (LevelDec untouched).
`SongScore.HasChart(inst)` = `Level[inst] > 0 || LevelDec[inst] > 0 || NoteMask bit` (SongScore.cs:38-41) — used for instrument detection in §12.4.

---

## 9. Channel and lane tables

### 9.1 Drum lanes (DtxChart.cs:77-93)
Lane index / name: `0 LC, 1 HH, 2 LP, 3 SD, 4 HT, 5 BD, 6 LT, 7 FT, 8 CY, 9 RD`.
| ch | NX name | lane |
|---|---|---|
| 0x11 | HiHatClose | 1 HH |
| 0x12 | Snare | 3 SD |
| 0x13 | BassDrum | 5 BD |
| 0x14 | HighTom | 4 HT |
| 0x15 | LowTom | 6 LT |
| 0x16 | Cymbal (right) | 8 CY |
| 0x17 | FloorTom | 7 FT |
| 0x18 | HiHatOpen | 1 HH |
| 0x19 | RideCymbal | 9 RD |
| 0x1A | LeftCymbal | 0 LC |
| 0x1B | LeftPedal | 2 LP |
| 0x1C | LeftBassDrum | 2 LP |
Hidden 0x31-0x3C = visible + 0x20 (same lanes; `Note.Channel` is normalised to the visible value). Optional app feature `MergeRideIntoCymbal` (246-263, `ConfigIni.MergeRideToCymbal` default false, ConfigIni.cs:196): moves lane 9 → 8 and Channel → 0x16 for visible and hidden notes, applied at PerformanceStage enter before judgement arrays are built (PerformanceStage.cs:644-645). Pedal judgement windows are selected by original channel `0x13/0x1B/0x1C` (2255-2258).

### 9.2 Non-drum channels (95-121, 170-180)
`0x01` BGM · `0x02` bar length · `0x03` BPM (hex) · `0x04` BGA layer1 · `0x07` BGA layer2 · `0x08` BPM-ex (#BPMxx) · `0x1F` cheer WAV · `0x50` bar line · `0x51` beat line · `0x53` fill-in · `0x54` movie · `0x55-0x59` BGA layers 3-7 · SE: `0x61-0x69` (SE01-09), `0x70-0x79` (SE10-19), `0x80-0x89` (SE20-29), `0x90-0x92` (SE30-32) — gaps 0x6A-0x6F/0x7A-0x7F/0x8A-0x8F are NOT SE · muting SE = `0x61-0x65` only · `0xC1` beat-line shift · `0xC2` line display · bonus `0x4C-0x4F` (all equivalent).
(added A8) SE24-29 (0x84-0x89) are "hit-sound replacement" channels in NX (routed through the drum mixer); DTXManiaAI deliberately treats them as ordinary auto-played SE (comment 479-480).
Fill-in values: `01` start, `02` end (+cheer), `03` chorus start, `04` chorus end, `05` chorus start + cheer, `06` chorus end + cheer (64-66).

### 9.3 Guitar/bass visible channels (128-155): bits `R=4 G=2 B=1 Y=16 P=32`, `0 = OPEN`. Pattern p (0..7) = R/G/B bits.
Guitar: `0x20+p` ; +Y: `[0x93,0x94,0x95,0x96,0x97,0x98,0x99,0x9A][p]` ; +P: `[0x9B,0x9C,0x9D,0x9E,0x9F,0xA9,0xAA,0xAB][p]` ; +Y+P: `[0xAC,0xAD,0xAE,0xAF,0xD0,0xD1,0xD2,0xD3][p]`. Guitar wailing 0x28, LN ctrl 0x2C, wailing-sound switch 0x2F, no-chip sound 0xBA.
Bass: `0xA0+p` ; +Y: `[0xC5,0xC6,0xC8,0xC9,0xCA,0xCB,0xCC,0xCD]` ; +P: `[0xCE,0xCF,0xDA,0xDB,0xDC,0xDD,0xDE,0xDF]` ; +Y+P: `[0xE1,0xE2,0xE3,0xE4,0xE5,0xE6,0xE7,0xE8]`. Bass wailing 0xA8, LN ctrl 0x2D, no-chip 0xBB.

---

## 10. Playback: which chips sound automatically and when (PerformanceStage.cs)

### 10.1 Clock (SongClock.cs:23-36, 59-62; PerformanceStage.cs:707, 794)
`SongClock` is created at PerformanceStage enter; `WallMs` = ms since then (pauses excluded); `SongMs = WallMs + offset` (offset 0 initially, set by `JumpTo`). `songMs = clock.SongMs − LeadInMs(0)`, so songMs = 0 at stage enter; the first DTX measure starts 240000/BPM ms later. All event lists are consumed by cursors with `while (cursor < n && songMs >= ev.TimeMs)` — every due event fires in the same frame, in list order.

### 10.2 Per-frame order (916-923)
`ProcessBgm → ProcessSe → ProcessGuitarBassAuto → ProcessFillIn → ProcessBarLines → ProcessMovie → ProcessBga → ProcessJudgement`.

### 10.3 Auto-played sound events
- **BGM 0x01** (1842-1867): if clip loaded → (only if `Config.BgmSound`, default true, ConfigIni.cs:275) `PlayChip(clip, WavVolume(id) * AutoVol, WavPan(id), startSec=0, protect=true)`, cursor++; else if `songMs > TimeMs + 5000` cursor++ (give up); else `break` (wait; blocks later BGM events until loaded — only reachable in the non-preload path). Every BGM chip starts its own clip from sample 0 at its own TimeMs (polyphonic; there is no separate "BGM start time" — the chip time IS the start time). Movie audio is muted if any BGM chip exists (761, SongLoadingStage.cs:309).
- **SE** (1872-1894): missing clip → skip. `0x61-0x65`: `StopChip(lastHandle[channel])` then play and remember the handle; others overlap. Volume = `WavVolume(id)` ONLY (no ChipVol/AutoVol), pan = WavPan, unprotected pool voice.
- **Guitar/bass chips in the drums screen** (1381-1401): auto-sounded, monophonic per part (`StopChip(lastVoice)` then `PlayChip(clip, WavVolume, WavPan)`; no AutoVol); missing clip → nothing.
- **Cheer 0x1F** (1898-1908): passing a cheer chip only SELECTS `_cheerClip` (if loaded). (added A1) `PlayCheer` (1990-1997) = `Sound.Play(_cheerClip ?? skin Audience.ogg)` → `_source.PlayOneShot(clip)` at volume 1.0, no #VOLUME/#PAN/AutoVol, pitch-shifted with play speed; fired by fill-in values 2/5/6 if `Config.AudienceSound` (default true) and `(combo > 0 || global AUTO || all lanes AUTO)`. Values 1/2/3/4/5/6 toggle `_inFillIn` (1/2) / `_chorusSection` (3-6) only when `Config.FillInEffect` (default true) (1922-1943).
- **Bar/beat lines** (2000-2011): metronome (`Config.Metronome`, default false): `Sound.Play(ClipMetronome, IsBeat ? 0.4 : 1.0)` (PlayOneShot volumeScale; NX 40/100), plays regardless of `Visible`, including the lead-in bar line at songMs 0.
- **Movie**: first 0x54 event only; at its time `PlayAt((songMs − TimeMs)/1000)` (2014-2025); paused after any jump (1356-1357).
- **BGA**: at each event, layer `clamp(Lane, 0, layers−1)` shows `#BMPxx` image (2053-2074).

### 10.4 Drum hit sounds (`PlayHit`, 2029-2038)
`vol = auto ? AutoVol : ChipVol`; `id = WavId.upper`; if clip loaded: `PlayPanned(clip, WavVolume(id) * vol, WavPan(id))` else `Sound.Play(Fallback(lane), vol)`.
CORRECTION C2 — who passes `auto`:
- Manual hit → `Judge(...)` → `PlayHit(note)` → ChipVolume (2792).
- Global AUTO (`_auto`): `Judge(i, Perfect)` at `songMs >= TimeMs` → `PlayHit(note)` → ChipVolume (2134-2142, 2792).
- Per-lane AUTO (`_laneAuto[lane]`, not global): `AutoJudge(i)` → `PlayHit(note, auto:true)` → AutoChipVolume (2122-2131, 2733).
- Hidden notes: silently consumed once `TimeMs < songMs` (never auto-sounded, 2113-2118); an early manual hit within the default window → `HitHiddenNote` → `PlayHit(n)` at ChipVolume (2292-2301).
- Fallback(lane) (2094-2102): bundled kit `StreamingAssets/System/Sounds/Drums/{LeftCrash,HiHat_Close,HiHat_Foot,Snare,Tom1,Bass,Tom2,Tom3,RightCrash,Ride}.wav` per lane 0..9 (GameMain.cs:67-71, 206-215, loaded once at startup), else `DrumSynth` clip (always built at stage enter, 682). Also used while WAVs are still loading in the non-preload path (767-786).

### 10.5 (added A2) Empty hit (pad pressed, no chip within the search window) (2204-2217)
Lane flash on the pad; sound = `PlayHit(borrow)` where `borrow = FindNearestAnyNote(pad, groupLanes, inputMs)`: nearest chip by |Δt| in the pad's own lane first (visible AND hidden, judged or not; hidden wins ties), then the group-partner lanes; if the chart has no chip at all in those lanes → `Sound.Play(Fallback(pad), ChipVol)`.

### 10.6 Song end (929-935)
`HasNotes (Notes.Count > 0) && songMs > DurationMs + 2000` (FinishTailMs, 117) and no training loop → STAGE CLEAR. A chart with only BGM/SE never ends automatically.

### 10.7 Jump / resume mid-song (1304-1358, 1408-1460)
`JumpInSong(target)`: mark notes/hidden with `TimeMs < target` as judged; reset all cursors to `count(TimeMs < target)`; clear SE handles; fold fill-in events `< target` without sound to recompute `_inFillIn/_chorusSection`; `_cheerClip` = last loaded cheer chip `< target`; `clock.JumpTo(target)`; then `ResyncAutoSounds`: `StopChips()`; for every BGM/SE event with `TimeMs < songMs` (strictly earlier): `offsetSec = (songMs − TimeMs)/1000 × PlaySpeedRatio`; if `offsetSec < clip.length` → `PlayChip(clip, WavVolume(id), WavPan(id), offsetSec, protect = isBgm)`. CORRECTION C3: no `AutoVol`, no `BgmSound` check here. Guitar/bass: only the LAST chip before songMs is restarted, and only if still inside its clip (1424-1440). Movie is paused after a jump.

Config defaults (ConfigIni.cs): `ChipVolume = 100` (278), `AutoChipVolume = 80` (281), `PlaySpeed = 20` (234; range 5..40, 621), `Metronome=false` (249), `FillInEffect=true` (252), `AudienceSound=true` (255), `BgmSound=true` (275), `MergeRideToCymbal=false` (196).

---

## 11. Audio engine

### 11.1 Formats — AudioFileLoader.cs:15-74
Missing file → null clip (case-insensitive path match on Windows). `.xa` → bjxa decoder (§11.6, synchronous). Else by lower-cased extension via `UnityWebRequestMultimedia.GetAudioClip`: `.ogg`→Vorbis, `.wav`→WAV, `.mp3`→MPEG, `.aiff/.aif`→AIFF, anything else → attempted as WAV; request failure → null. Path = chart folder + `#WAVxx` value (no `#PATH_WAV`).

### 11.2 Gain and pan
- `WavVolume(id) = WavVolumes[id] / 100 else 1.0` (2040-2044); `WavPan(id) = WavPans[id] / 100 else 0` (2046-2050).
- Final linear gain: manual and global-AUTO hits `WavVolume × (ChipVolume/100)`; per-lane-AUTO hits and BGM `WavVolume × (AutoChipVolume/100)`; SE, guitar/bass auto and resynced BGM `WavVolume` only; cheer/metronome/fallback per §10.3/10.4. Pool voices clamp to [0,1] (SoundManager.cs:219); the pan pool assigns `volume` unclamped (177; Unity clamps internally); values never exceed 1 anyway.
- Pan: `panStereo = clamp(pan, -1, 1)` (178, 220). Unity/FMOD pan law is not spelled out; for mono sources FMOD uses constant-power (`L = cos((pan+1)·π/4)`, `R = sin((pan+1)·π/4)`), which is Web Audio `StereoPannerNode` — use that. When `pan == 0` (`Mathf.Approximately`, i.e. `#PAN` absent or 0) hits go through `PlayOneShot` on the shared hit source (no pan) (159-163).

### 11.3 Polyphony (SoundManager.cs, ChipVoicePool.cs)
- Hit sounds, pan 0: `_source.PlayOneShot` — unlimited overlap (subject to Unity's global 32 real voices; quietest virtualised).
- Hit sounds, pan ≠ 0: 16-slot round-robin pool (`PanPoolSize = 16`, line 22), created lazily on first use (164-172); the next slot is `Stop()`ped unconditionally (173-179) → at most 16 simultaneous panned hits, oldest cut. (added) Lazily created pan-pool sources get NO pitch at creation and `SetChipPitch` only touches existing pools (264-265) → in the first song where the pool is created after `SetChipPitch(≠1)`, panned hits play unpitched until the next `SetChipPitch` call. Do not replicate.
- Auto chips (BGM/SE/GB auto): 32-slot pool (`ChipPoolSize = 32`, line 32, created lazily with the current pitch, 290-305). Slot choice `ChipVoicePool.PickSlot` (ChipVoicePool.cs:20-32): first non-playing slot (lowest index); else the oldest (smallest start counter) NON-protected slot; else the oldest overall. BGM is `protect=true` and gets Unity priority 0, others 200 (225). Handle = `(generation << 8) | slot`; `StopChip(handle)` is a no-op if the slot was reused (238-246). Start offset `src.time = clamp(startSec, 0, max(0, clip.length − 0.01))` (226). `StopChips()` stops all 32 (249-255); pause/resume affect hit source + both pools (271-288).
- System sounds (menu) use a separate `_system` source unaffected by pitch/pause (19, 341-346); preview/screen-BGM/exclusive sources likewise.

### 11.4 Play speed / pitch
`PlaySpeedRatio = PlaySpeed / 20` (732). At stage start, if `PlaySpeed != 20`: `ScaleChartTimes(20 / PlaySpeed)` → every TimeMs (Notes, HiddenNotes, Bgm, Se, Cheer, Movie, Bga, BarLines, FillIn, Guitar/Bass + LongEndMs, wailing/no-chip/wailing-sound events, `BpmChanges` (C5), DurationMs) `= (int)(TimeMs * k)` truncated (1249-1286). Then `SetChipPitch(ratio)`: `pitch = clamp(ratio, 0.05, 4)` applied to hit source, pan pool, chip pool — NOT to system/preview/screen-BGM (260-268); reset to 1 on stage exit (1822). No time-stretch: pitch and tempo change together (Web Audio: `playbackRate = ratio`). Displayed BPM = last `BpmChanges` entry with `TimeMs <= songMs` × ratio (2897-2913). (added A6) In-game change (training F9/F10, 1225-1246): `k = oldRatio / newRatio`; `ScaleChartTimes(k)`; loop points ×k; `SetChipPitch(newRatio)`; `JumpInSong((int)(SongMs × k))` (which resyncs audio per §10.7).

### 11.5 DrumSynth fallback (DrumSynth.cs) — used only when a lane hit has no loaded WAV clip AND the bundled kit file failed to load (§10.4).
All clips: mono, 44100 Hz, `Amp = 0.35`, `n = (int)(44100 × dur)` (float arithmetic), `t = (float)i / n`, noise = uniform [-1,1) from `System.Random(seed)` (seeds: Snare 1, HiHat 2, Cymbal 3, Ride 4; any white noise is fine), phase accumulated in double, `env` via `Mathf.Exp`:
- Lane 0 LC: `Cymbal(dur 0.40)`; 1 HH: `HiHat(0.05)`; 2 LP: `Kick(0.16)`; 3 SD: `Snare()`; 4 HT: `Tom(220 Hz)`; 5 BD: `Kick(0.18)`; 6 LT: `Tom(160)`; 7 FT: `Tom(110)`; 8 CY: `Cymbal(0.45)`; 9 RD: `Ride(0.30)` (19-28).
- `Kick(dur)`: `freq = lerp(150, 50, t)`; `phase += 2π·freq/44100`; `s = sin(phase) · e^(−6t) · 0.35` (40-54).
- `Snare`: dur 0.16; `env = e^(−22t)`; `phase += 2π·180/44100`; `s = (noise·0.7 + sin(phase)·0.3) · env · 0.35` (57-73).
- `HiHat(dur)`: `env = e^(−50t)`; `hp = noise − prevNoise` (1st-order high-pass, prev starts 0); `s = hp · env · 0.35 · 0.8` (76-92).
- `Tom(f0)`: dur 0.22; `f = lerp(f0, 0.7·f0, t)`; `phase += 2π·f/44100`; `s = sin(phase) · e^(−9t) · 0.35` (95-109).
- `Cymbal(dur)`: `hp = noise − prev`; `s = hp · e^(−7t) · 0.35 · 0.6` (112-128).
- `Ride(dur)`: `phase += 2π·520/44100`; `s = (noise·0.4 + sin(phase)·0.4) · e^(−8t) · 0.35 · 0.6` (131-147).

### 11.6 bjXA (.xa) — public API, header and (added A5) sample unpacking (libbjxa.cs)
API: `new bjxa.Decoder()`; `float[] Decode(byte[] xa)` (259-268) → interleaved float PCM; then `Samples` (= Blocks × 32 × Channels, 186), `Channels` (187), `SampleRate` (188). AudioFileLoader builds `AudioClip.Create(name, Samples, Channels, SampleRate)` (AudioFileLoader.cs:52).
32-byte little-endian header (270-291): `[0..4) magic 0x3144574B` ("KWD1"), `[4..8) DataLength` (bytes of coded data), `[8..12) Samples` (per channel), `[12..14) SampleRate u16`, `[14] bits` (4, 6 or 8 per sample), `[15] Channels` (1|2), `[16..20) loop ptr` (ignored), `[20..22) L.prev0, [22..24) L.prev1, [24..26) R.prev0, [26..28) R.prev1` (int16 predictor state), `[28..32) padding`. `BlockSize = bits*4 + 1` bytes per channel-block of 32 samples (1 profile byte + 32×bits/8 data bytes). Data starts at offset 32; per block: channel-0 block, then channel-1 block if stereo.
Validation (128-156): DataLength, Samples, SampleRate, BlockSize ≠ 0; Channels ∈ {1,2}; `DataLength % BlockSize == 0`; `Samples <= maxSamples = 32·DataLength/(BlockSize·Channels)`; `maxSamples − Samples < 32`; bits ∈ {4,6,8}.
Unpacking (190-257): each n-bit unsigned field v is left-aligned into an int16: `raw = (short)(v << (16 − n))` (4-bit: per byte hi nibble then lo nibble; 6-bit: 3 bytes → 24-bit big-endian word → 4 fields MSB-first; 8-bit: byte << 8).
Per-sample reconstruction (309-337): `profile = block byte 0; factor = profile >> 4 (0..4, else error); range = profile & 0xF`; `sample = (raw >> range) + (prev0·k0 + prev1·k1) / 256` (arithmetic shift; integer division truncating toward 0), clamp int16, `prev1 = prev0; prev0 = sample`; gain table `k0,k1 = {0,0},{240,0},{460,−208},{392,−220},{488,−240}` (301-307). Float output = `short / 32767` (376).
**Defects in the reference:** the copy loop writes `pcm[i]` instead of `pcm[pcmOff + i]` (375-376), so every block overwrites the first 32×Channels floats — decoded XA is effectively silent in DTXManiaAI. Also `pcmData` is over-allocated by ×Channels and `Samples` reports Blocks×32×Channels frames (2× for stereo → clip twice as long). Do NOT copy these; implement `pcm[pcmOff+i]` and frames = Blocks×32 (trim to header `Samples`).

---

## 12. SET.def / box.def and folder presentation

### 12.1 set.def (SetDef.cs:31-120)
Read Shift-JIS (with BOM detection as §1.1). Per line: skip empty; `s = TrimStart(' ', '\t')`; must start with `#`; cut at first `;`. Prefix match on the whole line, case-insensitive (`StartsWith`), tested in this order:
- `#TITLE`: if current block `InUse` → `Finish(block)`, push, start a new block. `Title = s.Substring(6).TrimStart(':',' ','\t')` (TrimStart only — trailing whitespace kept). `InUse = true`.
- `#GENRE`: `Genre = s.Substring(6).Trim(':',' ','\t')`; InUse.
- `#FONTCOLOR`: `s.Substring(10).Trim(':','#',' ','\t')` → exactly 6 hex digits RRGGBB → colour, else white (127-139).
- `#L1FILE`..`#L5FILE` → `File[0..4]`; `#L1LABEL`..`#L5LABEL` → `Label[0..4]`; value = `s.Substring(tag.Length).Trim(':',' ','\t')`; InUse.
- Unknown tags ignored; per-line exceptions swallowed.
`Finish` (110-120): for i in 0..4: if `File[i]` set and `Label[i]` empty → `Label[i] = ["NOVICE","REGULAR","EXPERT","MASTER","DTXMania"][i]`; if `Label[i]` set and `File[i]` empty → `Label[i] = ""`. Last block pushed at EOF if InUse. A block with only `#GENRE`/`#LxFILE` and no `#TITLE` still becomes a block (empty title, later filled from the DTX `#TITLE`).

### 12.2 box.def (BoxDef.cs:28-66)
Same line rules. Tags (prefix, case-insensitive; value = rest `.Trim(':',' ','\t')`): `#TITLE` (Substring 6), `#ARTIST` (7), `#COMMENT` (8; default text `"BOX に移動します。"`), `#GENRE` (6), `#PREVIEW`→Presound (8), `#PREIMAGE` (9), `#PREMOVIE` (9), `#SKINPATH` (9), `#FONTCOLOR` (10, as above), `#DIFFICULTY` (11; int ≥ 0 → `Difficulty = value != 0`).

### 12.3 Folder scan (SongManager.cs:100-221)
For a folder:
1. If `set.def` exists → one song node per block: `Title/Genre/FontColor` from block; for j=0..4 with non-empty `File[j]` and existing `folder + File[j]`: `DifficultyLabels[j] = Label[j]`, `Scores[j]` = that chart. Node kept only if ≥1 score exists. Loose chart files in that folder are NOT enumerated. Empty set.def titles are later filled from the DTX `#TITLE` (334-338).
2. Else every file with extension in `{.dtx,.gda,.g2d,.bms,.bme}` (80) becomes its own single-difficulty node at slot 0, provisional title = file name without extension (replaced by DTX `#TITLE` via DtxHeader when non-empty). (.gda/.g2d letter channels are unplayable in DtxChart, §3.)
3. Subfolders: name starting with `dtxfiles.` (case-insens.) → BOX titled `name.Substring(9)` (+ box.def Title/Genre/Color/SkinPath if present); folder containing `box.def` → BOX with its Title/Genre/Color/SkinPath; any other folder → transparent (its contents are appended to the current list). Recursion in all cases.
So "a song folder with several .dtx" = 1 node with up to 5 labelled difficulties when set.def exists, otherwise N separate 1-difficulty nodes — then §12.4 may merge some of them.

### 12.4 (added A4) SongInstrumentMerge (SongInstrumentMerge.cs; applied after headers load, SongManager.cs:302-304)
Within one list (same BOX level), consecutive-or-not Score nodes are merged into the first one when ALL hold: (a) same chart folder (case-insensitive path); (b) instrument masks are disjoint — mask bit i set iff any score `HasChart(i)` (Level, LevelDec or NoteMask); nodes with mask 0 are never merged; (c) `NormalizeTitle(node.Title)` equal (strip instrument tags, lower-case, collapse whitespace) OR the DTX `#TITLE`s normalise equal. Instrument tags recognised: trailing/leading bracketed tokens (`()[]{}<>` and full-width variants) whose content is one of `drum, drums, dr, dm, drummania, guitar, guitars, gt, gtr, guitarfreaks, bass, bs, ba, gf, df, gb, g&b, gt&bs, gt/bs, guitar&bass, guitar/bass, guitarbass, ドラム, ドラムス, ギター, ベース, ギター&ベース, ギター/ベース, ギターベース` (whitespace-insensitive), or single letters `d/g/b` inside brackets, or bracket contents containing `drum/guitar/bass/ドラム/ギター/ベース` (e.g. "(Drum only)"); also a trailing such word separated by ` \t　-_/~～:：－・|｜`. The host keeps its Scores/labels; its Title becomes the stripped title (or the matched DTX title); absorbed nodes disappear from the list and are reachable via `InstrumentVariant[inst]`.

---

## 13. vid2dtx `dtx.py` vs DtxChart — discrepancies (choose NX/DtxChart semantics unless noted)

1. **Lead-in**: dtx.py time origin is the start of measure 0 (`t = 0.0`, dtx.py:183-188). DtxChart adds an empty measure: all positions +384 ticks → +240000/#BPM ms (2000 ms @120) (DtxChart.cs:774). Web app: keep the lead-in (NX-compatible) or subtract 240000/BPM.
2. **Units/rounding**: dtx.py float seconds; DtxChart int ms with banker's rounding (422).
3. **Measure number**: dtx.py accepts base-36 first digit (`Z99` = 3599, dtx.py:61-69, 107); DtxChart only 3 decimal digits (000-999); a letter-led line is silently treated as an unknown header (DtxChart.cs:324). Charts emitted by vid2dtx with ≥1000 measures lose those measures in DtxChart.
4. **Data line without ':'**: dtx.py splits on the first space and still parses (cmd must then be exactly 5 chars, OBJ_RE); DtxChart requires a colon at index ≥5 (755-757) and drops the line (DtxHeader still counts it for NoteMask).
5. **`_`**: dtx.py strips `_` (dtx.py:132); DtxChart does not (769) — it produces bogus ids. Strip `_` (NX does).
6. **Inner whitespace in data**: DtxChart removes spaces/tabs inside the data (769); dtx.py does not (pairs would misalign).
7. **Comment stripping**: dtx.py cuts `;` from the whole line then strips (116); DtxChart cuts only in param/data. Same result except for pathological lines.
8. **Header split**: dtx.py: if `:` anywhere in body → split on first `:` else on first SPACE (tabs not recognised → `#BPM\t120` is lost as header "BPM\t120"); DtxChart splits at the earliest of `:`/space/tab (821-831). `#TITLE foo:bar` differs (dtx.py cmd=`TITLE foo`).
9. **#IF/#RANDOM**: dtx.py has no support — all branches are merged (headers overwrite, chips accumulate). DtxChart evaluates them (§2).
10. **BPM parsing**: dtx.py `float(param)` — no `,` support, no `>0` rejection (a `#BPM 0` yields ZeroDivisionError later), raises on garbage (aborts the whole parse); DtxChart tolerant (865-870) and rejects ≤0. dtx.py `#BPMxx` table keyed by base-36 integer (raises on `#BPM0_`); DtxChart by the uppercased 2-char string.
11. **Bar length parse**: dtx.py `float(param.replace(",", "."))`, accepts 0/negative (zero/negative durations), raises on garbage; DtxChart: no comma conversion, unparsable → 0, and any value ≤0 → 1.0 (427, 686, 779).
12. **BPM ≤ 0 guard**: DtxChart ch03 resets to the header `#BPM` when `BASEBPM + value <= 0`; ch08 ignores non-positive results (431, 436). dtx.py has no guard.
13. **Invalid chip pair**: dtx.py skips pairs that fail base-36/hex (`continue`, dtx.py:156-159) and skips numeric 0 (so `0_` is skipped); DtxChart skips only the literal `"00"`, keeps other ids verbatim (lenient hex for ch03 → `0_` resets BPM).
14. **Timing algorithm**: dtx.py's per-measure walk (`sec_per_tick0 = barlen·4·60/384 / bpm`, dtx.py:189-201, 205-217) is mathematically identical to `625·Δtick·barLen/bpm` ms; results agree modulo the lead-in and rounding. Both apply ch02 from that measure onward and BPM changes mid-measure at their tick. dtx.py ch08 with an unknown id emits no event (DtxChart emits a no-op BpmChange) — same timing.
15. **Sorting**: dtx.py sorts by `(time, channel)` (stable); DtxChart sorts notes by time only (unstable).
16. **Scope**: dtx.py keeps every non-control channel (BGM, SE, hidden 0x31.., BGA, 0x50/51/53/C1/C2/4C…) as generic chips with `lane=None` for non-drums; it does not generate bar/beat lines, ignores 0xC1/0xC2/0x53 ±32 shifts/bonus/hidden normalisation/guitar/bass/long notes. `last_measure` = max over notes, BPM events and bar-length changes (172-174); DtxChart's `DurationMs` = last visible drum/GB note time.
17. **BGM start**: dtx.py `bgm_start_time` = min time of ch01 chips (225-228, seconds, no lead-in); DtxChart plays every BGM chip at its own TimeMs (lead-in included).
18. **WAV keys**: dtx.py `#WAVxx` keyed by base-36 int (raises on invalid id); DtxChart by uppercased string — equivalent for valid ids. dtx.py stores empty params; DtxChart ignores empty `#WAVxx`.
19. **Encoding**: dtx.py `cp932` with `errors="replace"` and no BOM detection (a UTF-8 BOM makes line 1 start with U+FEFF → that line is dropped); DtxChart Shift-JIS with BOM auto-detect (§1.1).

## 14. Recommended web semantics (NX-compatible)
DtxChart rules for everything, plus (a) strip `_` and inner whitespace in data, (b) accept a base-36 first measure digit (NX/dtx.py), (c) stable sorts, (d) round-half-even to match ms values exactly (or accept ±1 ms), (e) strip one leading ':' from header params, (f) accept `#BPM120` glued form only if you want NX parity (DtxChart does not), (g) do not replicate the pan-pool pitch, BGM-resync-volume, and bjXA copy defects.

## Key facts

- Time formula: t_ms = currMs + 625 * (pos - lastPos) * barLen / bpm; 625 = 240000/384; barLen 1.0 = 4/4; chip.TimeMs = round-half-even(t) but currMs keeps the unrounded double (DtxChart.cs:421-422, 427-437).
- Lead-in: basePos = (measure + 1) * 384, so DTX measure 0 starts at tick 384 = 240000/#BPM ms (2000 ms at 120 BPM); songMs = 0 at PerformanceStage enter (LeadInMs = 0) (DtxChart.cs:774, PerformanceStage.cs:44, SongClock.cs:23-36).
- Chip position: pos = basePos + (384 * i) / objCount (integer division); objCount = data.Length / 2; only the literal pair "00" is skipped; ch03 ids hex (lenient), ch53/C2 base-36, others raw 2-char strings uppercased on lookup; '_' is NOT stripped by DtxChart (DtxChart.cs:784-806, 769).
- Data line needs body.Length >= 6, 3 ASCII decimal digits, a ':' at index >= 5 and a hex channel; space-separated or GDA letter-channel lines are dropped (DtxChart.cs:324, 755-764).
- Header order: BPM exact > SOUND_STAGEFAILED prefix > BASEBPM prefix > BPMxx (len 5) > WAVxx (len 5) > VOLUMExx (len 8) > AVIxx > PANxx > BMPxx; glued #BPM120 is NOT accepted (len 6); #BPM00 == #BPM; keys are uppercased 2-char strings (DtxChart.cs:331-389).
- CORRECTED beat-line spacing = 96/barLen ticks: barLen 0.5 -> 192, 0.75 -> 128, 1.0 -> 96, 1.5 -> 64, 2.0 -> 48; tickBeat = (int)(384*i/(4*barLen)) + C1 shift, emitted while < 384 and not a multiple of 384; bar lines every 384 ticks from 0 to endOfSong = multiple of 384 strictly above max(maxPos,(maxMeasure+1)*384) (DtxChart.cs:669-719).
- ch02 bar length: decimal via double.TryParse Invariant (no comma conversion), <=0 or unparsable -> 1.0, chip at measure start, persists forward; ch03 bpm = BASEBPM + hex (<=0 -> header #BPM); ch08 bpm = BASEBPM + #BPMxx[id] only if > 0, BpmChange pushed regardless (DtxChart.cs:776-782, 426-438).
- Sort key: Pos asc, then priority 0={02,03,08} 1={C1} 2={50,51} 3={C2} 4=others; C# List.Sort is unstable (DtxChart.cs:397-401, 809-818).
- 0xC2: 01=show, 02=hide, applies to generated lines only, forward-persistent and retroactive at the same Pos; directly written 0x50/0x51 are always visible with Measure 0 (DtxChart.cs:725-751).
- Fill-in ch53: value 01 -> Pos -= 32, 02 -> Pos += 32; only values 1..6 kept (01 start, 02 end+cheer, 03 chorus start, 04 chorus end, 05 chorus start+cheer, 06 chorus end+cheer) (DtxChart.cs:798-804, 456-460).
- Lane map: 0x1A->0 LC, 0x11/0x18->1 HH, 0x1B/0x1C->2 LP, 0x12->3 SD, 0x14->4 HT, 0x13->5 BD, 0x15->6 LT, 0x17->7 FT, 0x16->8 CY, 0x19->9 RD; hidden = channel + 0x20 (0x31-0x3C), normalised back to the visible channel (DtxChart.cs:77-91, 536-551).
- Bonus ch 0x4C-0x4F: BonusChipCount++ always; base-36 value 1..10 -> lane {1 LC,2 HH,3 LP,4 SD,5 HT,6 BD,7 LT,8 FT,9 CY,10 RD}; flags visible notes with the same Pos and lane (DtxChart.cs:183, 484-492, 557-560).
- SE channels: 0x61-0x69, 0x70-0x79, 0x80-0x89, 0x90-0x92 (gaps are not SE); 0x61-0x65 stop the previous sound of the same channel; 0x84-0x89 treated as plain SE (intentional NX divergence) (DtxChart.cs:170-180, 479-482).
- Per-frame order: Bgm, Se, GuitarBassAuto, FillIn, BarLines, Movie, Bga, Judgement; each cursor fires while songMs >= TimeMs (PerformanceStage.cs:916-923).
- BGM ch01: WavVolume*AutoChipVolume/100, protected pool voice, starts at clip 0 at its own TimeMs, skipped only if Config.BgmSound=false; non-preload path waits up to 5 s for the clip (PerformanceStage.cs:1842-1867).
- CORRECTED hit volume: manual and global-AUTO hits use ChipVolume/100 (Judge -> PlayHit(note)); only per-lane AUTO uses AutoChipVolume/100 (AutoJudge -> PlayHit(note, auto:true)) (PerformanceStage.cs:2029-2038, 2140, 2733, 2792).
- Jump/resume restarts BGM/SE with TimeMs < songMs at offset (songMs-TimeMs)/1000*PlaySpeedRatio s if inside the clip, at WavVolume only (no AutoVol, no BgmSound check); GB: only the last chip before songMs (PerformanceStage.cs:1408-1460).
- Cheer: ch1F only selects the clip; fill-in values 2/5/6 play it via PlayOneShot at volume 1.0 (no #VOLUME/#PAN, pitch-shifted) if AudienceSound and (combo>0 or AUTO); skin Audience.ogg fallback; metronome bar 1.0 / beat 0.4 regardless of Visible (PerformanceStage.cs:1898-1908, 1990-1997, 2000-2011).
- Empty hit: nearest chip's WAV (own lane first, visible+hidden, judged or not) at ChipVolume, else lane fallback (kit WAV, else DrumSynth) (PerformanceStage.cs:2204-2217, 2094-2102).
- DurationMs = max TimeMs of visible drum notes, guitar/bass notes and long-note ends (not BGM/SE/lines/hidden); stage clear when Notes.Count > 0 and songMs > DurationMs + 2000 (DtxChart.cs:499-570, PerformanceStage.cs:117, 929).
- Gain/pan: #VOLUMExx/100 (default 1) x mode factor; pan = #PANxx/100 in [-1,1] via Unity panStereo (constant-power for mono = Web Audio StereoPannerNode); pan==0 hits use PlayOneShot (PerformanceStage.cs:2040-2050, SoundManager.cs:155-180).
- Polyphony: pan==0 hits unbounded PlayOneShot; panned hits 16-slot round-robin (oldest cut); auto chips 32-slot pool: first idle, else oldest unprotected, else oldest (BGM protected, priority 0 vs 200); start offset clamped to clip.length-0.01 (SoundManager.cs:22,32,204-232; ChipVoicePool.cs:20-32).
- Play speed: PlaySpeed 5..40 (default 20), ratio = PlaySpeed/20; chart times (incl. BpmChanges, DurationMs, LongEndMs) x= 20/PlaySpeed with int truncation; pitch = clamp(ratio, 0.05, 4) on chart sounds only, no time-stretch; in-game change scales by old/new and jumps (PerformanceStage.cs:732, 1225-1286; SoundManager.cs:260-268).
- DrumSynth (44.1 kHz mono, Amp 0.35, seeds Snare 1/HiHat 2/Cymbal 3/Ride 4): LC Cymbal 0.40s, HH HiHat 0.05s, LP Kick 0.16s, SD Snare 0.16s, HT Tom 220Hz, BD Kick 0.18s, LT Tom 160Hz, FT Tom 110Hz, CY Cymbal 0.45s, RD Ride 0.30s; envelopes e^(-6t) kick, e^(-22t) snare, e^(-50t) hihat, e^(-9t) tom, e^(-7t) cymbal, e^(-8t) ride (DrumSynth.cs:19-147).
- Formats: wav, ogg, mp3, aiff/aif, xa; bjXA header magic 0x3144574B, BlockSize = bits*4+1, fields left-aligned to int16 (v << (16-bits)), sample = (raw >> range) + (prev0*k0 + prev1*k1)/256 with gains {0,0},{240,0},{460,-208},{392,-220},{488,-240}; reference writes pcm[i] instead of pcm[pcmOff+i] (silent output) - do not replicate (AudioFileLoader.cs:23-74, libbjxa.cs:190-337, 375-376).
- #IF/#RANDOM: random starts at 0 (all #IF n>=1 false before #RANDOM); #RANDOM n -> uniform 1..n (n<=0 -> 1); #IF taken iff n == current; max depth 255 (overflowing #IF consumed but not pushed); skipped blocks drop headers and data; #ELSE unsupported; DtxHeader and DtxChart roll separately (DtxIfStack.cs:29-62).
- Encoding: Shift-JIS (cp932) via StreamReader with BOM auto-detect (UTF-8/16/32 BOM wins); falls back to UTF-8 only if cp932 is unavailable (TextEncodingUtil.cs:14-25).
- set.def: #TITLE starts a block (TrimStart only); #GENRE, #FONTCOLOR RRGGBB, #L1FILE..#L5FILE, #L1LABEL..#L5LABEL (Trim ':' space tab); missing labels default NOVICE/REGULAR/EXPERT/MASTER/DTXMania; label without file cleared; node kept only if >=1 file exists (SetDef.cs:51-120, SongManager.cs:106-144).
- Without set.def every .dtx/.gda/.g2d/.bms/.bme is its own single-difficulty node; 'dtxfiles.*' folders and folders with box.def become BOX nodes; other folders are transparent; SongInstrumentMerge then merges Drum/Guitar/Bass variant nodes with the same folder, disjoint instrument masks and tag-stripped equal titles (SongManager.cs:80, 147-221, 302-304; SongInstrumentMerge.cs).
- #SOUND_STAGEFAILED (DtxChart) and #SOUND_NOWLOADING (SongLoadingStage's own scanner) are chart-folder-relative sound files replacing skin sounds when present (DtxChart.cs:337-340, PerformanceStage.cs:659-667, SongLoadingStage.cs:381-415).
- dtx.py differs from DtxChart in: no lead-in measure, float seconds, base-36 first measure digit, strips '_', no #IF support, header split on first ':' else first space only, strict float() for BPM/bar length, no <=0 guards, no BOM handling; timing math itself is equivalent (dtx.py:110-222).

## Open questions

- Unity AudioSource.panStereo exact pan law for STEREO clips (mono is constant-power). The web app should use StereoPannerNode; verify by ear against DTXManiaAI for stereo #PANxx WAVs if exact parity matters.
- C# List.Sort is unstable: relative order of chips with equal Pos+priority (e.g. two ch02 lines for one measure, two SE chips at the same tick) and of notes with equal TimeMs is unspecified; the beat-line generator uses last-in-file for ch02 while the timing sweep may use either. A stable sort in JS is a superset behaviour but cannot match a specific unstable ordering.
- Math.Round banker's rounding vs JS Math.round: exact ms parity requires round-half-even; decide whether +-1 ms mismatches on exact .5 boundaries are acceptable.
- DtxChart does not strip '_' inside measure data (DtxChart.cs:769) whereas NX and dtx.py do; the web app should strip it, but this is a deliberate divergence from the DTXManiaAI reference.
- DtxChart only accepts 3 decimal measure digits (000-999); NX/dtx.py accept a base-36 first digit up to Z99. Decide whether to follow NX (recommended) or DTXManiaAI.
- Header params keep a leading ':' when a space precedes it (e.g. '#WAV01 :x', '#TITLE : foo'); DTXManiaAI then fails the path or shows ': foo'. Decide whether the web app strips it (NX-like) or reproduces the reference.
- DtxHeader and DtxChart each roll their own #RANDOM value; whether the web app should pick one branch per session or re-roll per load is a product decision.
- #WAVVOLxx / #WAVPANxx / #BGMWAV / #DTXVPLAYSPEED / #RESULTIMAGE / #PATH_WAV / #HIDDENLEVEL are unsupported in DTXManiaAI; decide whether the web app adds NX-style support (e.g. treating WAVVOL as VOLUME) for wider chart compatibility.
- GDA/G2D letter channels (e.g. 'HH', 'SD') are listed by SongManager but produce no notes in DtxChart; decide whether the web app implements the GDA channel-name table.
- Whether to reproduce the reference's global-AUTO hit volume (ChipVolume) or use AutoChipVolume for all auto-sounded chips as NX does; and whether resynced BGM after a jump should keep the AutoChipVolume factor (the reference drops it).
