# gb-config

# Guitar/Bass: configuration, AUTO, options, mode selection, FLIP, song select, training, volume

Sources. Every claim below was re-checked against the code in this verification pass. Inline markers: **[FIX]** corrects the draft, **[ADD]** fills a gap in the draft.
- **NX** = `DTXmaniaNX/DTXMania/Code/`. Abbreviations:
  - `CI` = App/CConfigIni.cs, `CC` = App/CConstants.cs, `APP` = App/CDTXMania.cs, `HR` = App/STHitRanges.cs
  - `DTX` = Score,Song/CDTX.cs, `CHIP` = Score,Song/CChip.cs, `SCI` = Score,Song/CScoreIni.cs
  - `CL` = Stage/04.Config/CActConfigList.cs, `SS` = Stage/05.SongSelection/CStageSongSelection.cs, `QC` = Stage/05.SongSelection/CActSelectQuickConfig.cs
  - `SL` = Stage/06.SongLoading/CStageSongLoading.cs
  - `PCS` = Stage/07.Performance/CStagePerfCommonScreen.cs, `PGS` = Stage/07.Performance/GuitarScreen/CStagePerfGuitarScreen.cs, `SCO` = Stage/07.Performance/CActPerfCommonScore.cs
  - FDK files are cited as `FDK/Code/...`, relative to the DTXmaniaNX repo root.
- **AI** = DTXManiaAI `Assets/Scripts/`. Abbreviations:
  - `AC` = Config/ConfigIni.cs, `CS` = Stages/ConfigStage.cs, `SF` = Core/StageFlow.cs
  - `GPS` = Stages/GuitarPerformanceStage.cs, `PS` = Stages/PerformanceStage.cs
  - `SSS` = Stages/SongSelectionStage.cs, `GRS` = Stages/SongSelectionStage.GRSelect.cs, `SLS` = Stages/SongLoadingStage.cs
  - `GBC` = Input/GBPadCommands.cs, `DB` = Input/DrumBinding.cs
  - `SIM` = Song/SongInstrumentMerge.cs, `SLN` = Song/SongListNode.cs, `SSc` = Song/SongScore.cs
  - `TS` = Core/TrainingSettings.cs, `TM` = Stages/TrainingMenu.cs
  - `AIdoc19/20/25` = `DTXManiaAI/docs/19_…`, `20_…`, `25_…`.
- **Web** = this repo. Web line numbers refer to commit `26de61f`, before the guitar/bass port (the port moved the code they point at).

Tags:
- **[NX-only]**: present in NX, skipped by AI.
- **[AI-add]**: AI added it; it is not in NX.
- **[AI-diff]**: AI behaves differently from NX.
- **[NX-bug]** / **[NX-quirk]**: NX code that contradicts its own stated intent, or surprising behaviour in NX.

---

## 1. Key assignments

### 1.1 NX storage model
- Each part (DRUMS, GUITAR, BASS, SYSTEM) has a `CKeyAssignPad`. Guitar and bass buttons **share storage slots with drum pads** (CI:22-263):

  | Button | Shared drum slot |
  |---|---|
  | R | HH (`padHH_R`) |
  | G | SD |
  | B | BD |
  | Pick | HT |
  | Wail | LT |
  | Help | FT |
  | Decide | CY |
  | Y | HHO |
  | P | LC |
  | Cancel | own slot (`padCancel`) |

  `EKeyConfigPad` aliases these the same way (CC:85-122).
- **Up to 16 bindings per button.** Storage is `new STKEYASSIGN[16]` (CI:4101), and the parser stops after 16 tokens (CI:4147).
- **Token grammar:** `<dev><id36><code>`. Tokens shorter than 3 characters are skipped (CI:4144-4190).
  - `dev`: `K` keyboard, `J` joypad, `M` MIDI, `N` mouse. `L` is skipped.
  - `id`: one base-36 character.
  - `code`: 0..255.
- **Keyboard codes** are `SlimDX.DirectInput.Key` enum values with explicit numbers, not DIK scan codes (FDK/Code/02.Input/SlimDX.DirectInput.Key.cs:12-159). **[FIX]** The enum starts at line 12.
- **Joypad codes** (FDK/Code/02.Input/CInputJoystick.cs:223-254, 264-289, 310-520):
  - 0..5 = X−, X+, Y−, Y+, Z−, Z+ (threshold ±500).
  - `6+i` = button `i`.
  - `6+128+n` = POV directions.
- **Global de-duplication.** Before storing a token, `tDeleteAlreadyAssignedInputs` removes that exact (device, id, code) from every pad of every part and shifts the later slots up (CI:1524-1546, called at CI:4185). Line order therefore matters, including in the default string.
- **[ADD][NX-quirk]** `tReadAndSetSkey` writes token *i* into slot *i* and never clears the slots after the last token (CI:4147-4189). The constructor applies the defaults first (CI:1455), so a shorter user line can leave trailing default bindings in place.
- **[ADD]** `bEnterがキー割り当てのどこにも使用されていない` is true when no part binds keyboard `Return` (CI:849-868). Song select uses it (§4.4).

### 1.2 NX defaults (`tSetDefaultKeyAssignments`, CI:4192-4250)

The raw string is at CI:4196-4248 and is parsed through `tReadFromString` (CI:4249). The *Effective* column applies the de-duplication rule from §1.1.

| Part.Button | Raw default (CI line) | Effective after dedupe | SlimDX key name | Suggested `KeyboardEvent.code` (web) |
|---|---|---|---|---|
| Guitar.R | `K054` (4214) | same | F1 | `F1` |
| Guitar.G | `K055,J012` (4215) | same | F2; joy0 button 6 | `F2` |
| Guitar.B | `K056` (4216) | same | F3 | `F3` |
| Guitar.Y | `K057` (4217) | same | F4 | `F4` |
| Guitar.P | `K058` (4218) | same | F5 | `F5` |
| Guitar.Pick | `K0115,K046,J06` (4219) | **`K046,J06`**: the later `Cancel=K0115` (4222) removes `]` from Pick | RightBracket, **Colon**, joy0 button 0 | `Quote`* (+`BracketRight` if `]` is kept, as AI does) |
| Guitar.Wail | `K0116` (4220) | same | RightControl | `ControlRight` |
| Guitar.Decide | `K060` (4221) | same | F7 | `F7` |
| Guitar.Cancel | `K0115` (4222) | same | RightBracket | `BracketRight`* |
| Bass.R..P | `K090`..`K094` (4226-4230); G also `J013` | same | NumberPad1..5; joy0 button 7 | `Numpad1`..`Numpad5` |
| Bass.Pick | `K0103,K0100,J08` (4231) | **`K0100,J08`**: `Cancel=K0103` (4234) removes Numpad `.` | NumberPadPeriod, NumberPadEnter, joy0 button 2 | `NumpadEnter` (+`NumpadDecimal` if kept, as AI does) |
| Bass.Wail | `K089` (4232) | same | NumberPad0 | `Numpad0` |
| Bass.Decide | `K096` (4233) | same | NumberPad7 | `Numpad7` |
| Bass.Cancel | `K0103` (4234) | same | NumberPadPeriod | `NumpadDecimal` |
| System Help (stored in **Guitar.Help**) | `Help=K064` (4239) | same | F11 | `F11` |
| System Pause (stored in **Bass.Help**) | `Pause=K0110` (4240) | same | Pause | `Pause` |
| System Restart | `K052` (4247) | same | Equals | `Equal` |
| **[ADD]** System Capture / Search | `K065` / `K042` (4237-4238) | same | F12 / Backspace | n/a |
| LoopCreate / LoopDelete / Skip± / PlaySpeed± | empty (4241-4246) | none | none | none |

\* On a JIS keyboard, AI maps NX "Colon" to `Key.Quote`, which is the same physical position (AC:162). The source does not show how DirectInput maps `RightBracket` and `Colon` on JIS hardware.

- Help and Pause are stored in the Guitar.Help and Bass.Help slots for both writing (CI:2507-2512) and reading (CI:3938-3945). **[FIX]** The draft cited 2505 and 3936.
- Config.ini sections are `[GuitarKeyAssign]`, `[BassKeyAssign]` and `[SystemKeyAssign]`, with keys `R,G,B,Y,P,Pick,Wail,Decide,Cancel` (writer CI:2435-2497, reader CI:3839-3923).
- NX GR mode is effectively **2-player**: guitar on the F-keys, bass on the numpad, both manual by default (§2.1).

### 1.3 AI keys
- **Format.** Two separate lines, `GuitarKeys=` and `BassKeys=`. Each has exactly 7 comma-separated tokens in the order R,G,B,Y,P,Pick,Wail (AC:583-584, 641-654).
  - Each token holds `|`-separated bindings in DrumBinding grammar: a Unity `Key` name, `Pad:<button>`, or `Midi:<n>[:<thr>]`.
  - **[ADD]** `None` means "intentionally unassigned": it parses to an empty list and returns true (DB:20, 160-175).
  - At most 12 bindings per button (`MaxPerLane`, DB:43, 184).
  - A line without exactly 7 tokens is ignored. An empty token keeps the current value (AC:641-654).
  - A token that parses to zero bindings falls back to the default for that button (GPS:453-463; same rule in GBC:35-45).
  - Both lines are written back to Config.ini (AC:836-837, 1002-1003).
- **Defaults** (AC:159-172):
  - Guitar: `F1..F5`, Pick `RightBracket|Quote`, Wail `RightCtrl`.
  - Bass: `Numpad1..5`, Pick `NumpadPeriod|NumpadEnter`, Wail `Numpad0`.
- Differences from NX:
  - **[AI-diff]** AI does not apply NX's dedupe, so `]` and Numpad `.` stay Pick keys.
  - **[AI-diff]** There are no per-instrument Decide, Cancel or Help keys, and no joypad defaults.
  - **[AI-diff]** There is no in-app key-assign UI for GB. Keys are edited in Config.ini only (CS:1286; AIdoc20:175-176). **[FIX]** The draft cited CS:1287.

### 1.4 Web constraints (this repo, HEAD 26de61f)
- `RESERVED_CODES = ArrowUp/Down/Left/Right, Enter, NumpadEnter, Escape, Tab, F1` (js/ui/keybind.js:21-30).
- `F1` toggles AUTO (js/main.js:1102-1108 at HEAD).
- Arrows, Enter and NumpadEnter drive the training menu. `F11` is intentionally not reserved (keybind.js:26).
- Two NX defaults collide with this list: **Guitar.R = F1** and **Bass.Pick = NumpadEnter**.
- The web app has a 12-per-lane limit, the same as AI (js/ui/keybind.js:16-19).

---

### 1.5 Joystick / guitar-controller input **[ADD]**

Paths: CJ = FDK/Code/02.Input/CInputJoystick.cs, CIM = FDK/Code/02.Input/CInputManager.cs, CPad = DTXMania/Code/App/CPad.cs,
KA = DTXMania/Code/Stage/04.Config/CActConfigKeyAssign.cs, PCS = CStagePerfCommonScreen.cs, APP = DTXMania/Code/App/CDTXMania.cs.

**NX**
- SharpDX.DirectInput. Every `DeviceClass.GameControl` device attached at startup becomes a `CInputJoystick` (CIM:70-101). No hot-plug; a device whose poll throws is removed (CIM:176-196). Cooperative level Foreground | Exclusive, BufferSize 32 (CJ:21-23).
- Axes: Range ±1000, DeadZone 5000 ("50%"), and a direction counts as pressed when `|v| > 500` on its side (CJ:37-45, 698; polled CJ:310-500). No hysteresis. Crossing to the other side releases the opposite direction (CJ:698-721). Only X, Y, Z are read (Rx/Ry/Rz and sliders ignored).
- POV: `n = (deg + 2250) / 4500 mod 8` (0 = up, 45° clockwise steps); centred (−1) releases (CJ:264-294). Buffered mode can leave a sector stuck when moving between sectors without passing the centre (CJ:271-290).
- Codes: 0..5 = X−, X+, Y−, Y+, Z−, Z+; 6+i = button i (0..127); 134..141 = POV n. UI labels Left / Right / Up / Down / Forward / Back / Button{code−5} (1-based) / POV {n·45} (KA:363-408).
- Two input modes, `BufferedInput` (default ON): buffered DirectInput data with DirectInput timestamps mapped to the sound timer (CJ:119-300; FDK/Code/03.Sound/CSoundTimer.cs:44-66), or the polled state stamped with the poll time (CJ:301-633).
- Pick and Wail are **press edges** from `CPad.GetEvents` with each event's own timestamp (PCS:5421-5432, 5515-5533). The neck is the **held level** `CPad.bPressing`, sampled when processing (PCS:5308-5315). A press and release inside one poll is invisible to the neck.
- No strum-pair handling: picking with both strum directions needs both codes bound to Pick. A wail bound to an axis fires once per crossing.
- Device identity: `[GUID] JoystickID=n,GUID`; IDs are given at startup to unknown GUIDs, n = 0..9 reloaded (APP:2447-2473; CI:4078-4093). Bindings carry the device ID (`J<id36><code>`).
- Capture (CONFIG > Key Assign): every joystick, codes 0..141, the first press edge wins, no exclusions (KA:434-455).
- Joystick defaults exist only for Guitar G (`J012`), Guitar Pick (`J06`), Bass G (`J013`), Bass Pick (`J08`) (CI:4215-4231).

**DTXManiaAI**
- Unity Input System `Gamepad.current` only (one device, no index/GUID). Only 16 named `GamepadButton`s can be bound (`Pad:South`); no stick directions, no hats as such, no generic Joystick class (Input/InputManager.cs:47-77; Input/DrumBinding.cs:59-77).
- Guitar/bass tokens can be typed into `GuitarKeys=` / `BassKeys=`; there is no GB capture UI and no gamepad defaults (Config/ConfigIni.cs:151-172; Stages/ConfigStage.cs:1286).
- Judged at frame time, one pick per frame (docs/20_guitar-bass-mode.md:119). Not verified on hardware (docs/18_nx-parity-stage5-drums.md:285-287).

## 2. AutoPlay

### 2.1 Flags, ini keys and defaults
- NX `STAUTOPLAY` is indexed by `ELane` (CC:236-267, 579-608): `GtR,GtG,GtB,GtY,GtP,GtPick,GtW` and `BsR..BsW`. The `Guitar` and `Bass` fields are unused.
- Section `[AutoPlay]` uses keys `GuitarR, GuitarG, GuitarB, GuitarY, GuitarP, GuitarPick, GuitarWailing` and the same names with a `Bass` prefix (writer CI:2302-2318, reader CI:3652-3711).
- **NX defaults: all 14 false** (CI:1420-1433).
- **[ADD]** The performance stage copies the flags into `this.bIsAutoPlay` when it activates (PCS:367, struct copy). Auto-wailing and the score revision, however, read `ConfigIni` directly (PCS:4595; SCO:66, 93).
- **AI defaults** (AC:136-141):
  - Guitar: all false, as in NX.
  - **Bass: all true.** **[AI-diff]** AI's reason: in single-player keyboard play a manual bass would miss everything and cause STAGE FAILED (AC:139-141; AIdoc20:114-115).
- AI keeps the same ini key names (AC:676-685, 780-784).

### 2.2 Aggregate predicates
- NX `bAllGuitarsAreAutoPlay` and `bAllBassAreAutoPlay` loop over **R..Pick and exclude Wailing** (CI:916-943). `bIsAutoPlay(part)` wraps them (CI:945-961). AI `AllGBAuto` does the same (AC:144-149).
- Where the aggregate is used:
  - Result counts come from IncAuto when the part is all-auto, and from ExclAuto otherwise (PCS:164-168, 235-239).
  - score.ini is updated only if the part is enabled, has chips and is **not** all-auto (SCI:2012-2017).
  - **[ADD]** Score revision (SCO:55-120). When the part is not all-auto, `rev = 1`, then `/2` if Pick is auto, then `/2` again if any of R..P is auto. When the part is all-auto, `rev = AutoAddGage ? 1 : 0`. Every score add for the part goes through this: chips, LN ticks (PCS:5397) and wailing bonus (PCS:5547, 5552). AI mirrors this as `ScoreRev` (GPS:405-415).

### 2.3 Presets

**NX QuickConfig** (song select, P×2; QC):
- Guitar and bass list: `{ "All Auto", "Auto Neck", "Auto Pick", "Custom", "OFF" }` (QC:65).
- Applied strings, in the order `R G B Y P Pick W` (header `"RGBYPPW"`, QC:321):

  | Index | Preset | String | Effect |
  |---|---|---|---|
  | 0 | All Auto | `AAAAAAA` | everything auto, including Wail |
  | 1 | Auto Neck | `AAAAA__` | Pick and Wail **manual** |
  | 2 | Auto Pick | `_____A_` | Pick auto only; **Wail manual** |
  | 3 | Custom | current flags kept | none |
  | 4 | OFF | `_______` | all manual |

  Source: QC:556-585.
- The string is written into `bAutoPlay[GtR+i]` or `[BsR+i]` by `SetAutoParameters` (QC:497-510). It runs on Return, More… (QC:452-461), Cancel and BD-continuity (QC:467-478). **[ADD]** It rewrites all three parts, not only the current target (QC:499).
- The initial index is inferred from the current flags (QC:206-262):
  - All Auto ⇐ `bAll*AreAutoPlay` (W ignored).
  - Neck ⇐ R,G,B,Y,P auto and Pick off (W ignored).
  - Pick ⇐ no neck lane auto and Pick on (W ignored).
  - OFF ⇐ nothing auto, including W.
  - Anything else is Custom.
  - **[NX-bug]** The guitar OFF test checks `GtB` twice and never checks `GtG` (QC:222-223).
  - **[NX-bug]** The bass Neck, Pick and OFF tests check only `BsR, BsB, BsB`, ignoring G, Y and P (QC:239-253).

**NX CONFIG page:**
- `AutoPlay (All)` is a three-state item that sets all 7 flags, including W, at once (CL:1130-1135, 1767-1773, 3242-3249).
- Seven individual toggles follow it (CL:1137-1170).

**AI CONFIG "Guitar/Bass" page:**
- Presets `{OFF, AUTO NECK, AUTO PICK, ALL AUTO}` (CS:121), cycled with ←/→ (CS:1024-1029).
- `SetGBAutoPreset` (CS:1059-1067):
  - neck = NECK or ALL.
  - pick = PICK or ALL.
  - **W = pick.**
- **[FIX][AI-diff]** The difference from NX is **AUTO PICK only**: AI turns W on, while NX "Auto Pick" (`_____A_`) leaves W manual. AI NECK (W off) and ALL (W on) match NX. AI's comment calls this NX-compliant (CS:1066), which is wrong for PICK.
- Detection (CS:1048-1057):
  - ALL ⇐ neck and pick.
  - NECK ⇐ neck and not pick.
  - PICK ⇐ no neck lane and pick.
  - **Otherwise OFF**; W is ignored.
  - **[AI-diff]** There is no "Custom" state and no per-button toggles. Cycling from a custom state overwrites it.

### 2.4 Runtime meaning (NX)

**Per-chip "is AUTO" (`bCheckAutoPlay`, PCS:3721-3784).** A GB chip is AUTO iff all of these hold:
- Pick is auto;
- every fret the chip uses is auto;
- if it is a wailing chip, W is auto;
- if it is an OPEN chip, all five frets are auto.

Consequences of an AUTO chip:
- The input adjust is treated as 0 (PCS:1447, 1455).
- The judgement text is "AUTO" (PCS:1449, 1457).
- The hit is counted in IncAuto only (PCS:1578-1602).
- **Combo still advances on Perfect/Great/Good, AUTO or not** (PCS:1604-1615). Drums differ (PCS:1553).
- **[ADD]** The gauge is not changed by AUTO chips unless `AutoAddGage` is on (PCS:1472-1486; default off, CI:1349). An all-auto part therefore never fails.
- **[ADD]** The progress bar and lag counters ignore AUTO chips (PCS:1489-1498).

**Auto pick** (PCS:4297-4418). It runs while the chip list is drawn.
- **Trigger:** `!bHit && autoPick && nDistanceFromBar < 0` (PCS:4303-4304, 4328-4333).
  - **[FIX]** `nDistanceFromBar = (int)((t − now)·k)` truncates toward zero (CHIP:583-585). So `d < 0` requires `now − t ≥ 1/k`: the trigger is **at least** 1/k ms late (plus up to one frame). At guitar x1.0, `k = 2·0.5·0.5·37.5·286/60000 ≈ 0.0894 px/ms` (CHIP:580), so about 11.2 ms late.
  - The chip sound starts at that moment. Playback-position correction applies only to sounds of 5 s or longer (DTX:2918-2941).
  - When a non-PERFECT AutoGhost is active, the trigger is time-based with the ghost lag instead (PCS:4308-4326).
- **Success test** (PCS:4373-4388). `bMiss = false` if any of these holds:
  - (a) the chip's lane set equals the auto lane set exactly, whatever is held;
  - (b) for every lane, `auto || chipHas == pressing`;
  - (c) the chip is OPEN and every non-auto lane is released.
  - Otherwise the result is a **forced Miss**, processed with `bCorrectLane=false` and `nLag=0` (PCS:4397-4401).
- **[ADD] Judgement on success.** `tProcessChipHit(chipTime + ghostLag, chip)` (PCS:4395). For an AUTO chip the adjust is 0, so lag = 0 and the result is Perfect.
  - For a **non-AUTO chip** (Pick auto, some fret manual), `nInputAdjustTimeMs` is still applied (PCS:1447), so `lag = InputAdjustTimeGuitar/Bass`. The judgement is `|adjust|` against the hit ranges; with |adjust| > 34 the result is no longer Perfect.
  - **[AI-diff]** AI always passes Perfect with lag 0 (GPS:987).
- **Sound:** the chip is played at `nモニタを考慮した音量(inst)` (§6) (PCS:4391). **[ADD]** It plays even on a forced Miss, pitch-shifted when Specialist is on (PCS:4389-4391).
- **Wailing:** on success only, the nearest wailing chip within ±140 ms (search includes the input adjust) is queued (PCS:4407-4413).
- **Chip-fire effects:** a lane fires if `chipHas && (auto || pressing)`, or if the OPEN succeeded (PCS:4350-4371).

**Auto neck.**
- Auto lanes are excluded from the fret comparison: `nAutoMask = W8|R4|G2|B1|Y16|P32` (PCS:4894-4900), and the test is `(chipBits & ~mask & 0x3F) == (pressedBits & ~mask & 0x3F)` (PCS:5455).
- Each frame, the auto lanes used by the next chip get a lane flush and an RGB button "push" (PCS:5240-5291). This is display only.

**Auto wail.**
- While a wailing chip is between the bar and −234 px, `DoWailingFromQueue` runs each frame with `autoW = configIni.bAutoPlay.GtW/BsW` and timestamp = chip time (PCS:4589-4606).
- Queued chips within 1000 ms count as succeeded, **but no bonus score is given when autoW** (PCS:5530-5559; bonus gated at PCS:5542). **[FIX]** The draft cited 5541.

**Manual pick while Pick is AUTO.** **[NX-quirk]**
- `autoPick` is declared at PCS:4893 but never checked in the pick-event loop (PCS:5421-5513). The `else` that would skip the manual block is commented out (PCS:5304-5305).
- Manual picks are therefore still processed. They can hit a chip early inside the window, they play the no-chip sound, and with Light OFF they cause a BAD.
- The comment "auto pickだとここから先に行かないので注意" at PCS:5420 is stale.
- **[AI-diff]** AI ignores Pick input entirely, and skips the manual-miss sweep, when AutoPick is on (GPS:783-808).

**[ADD] Early exit.** `tHandleInput_GuitarBass` returns right after the Decide+B/R scroll check when `!bGuitarEnabled` or the part has no chips (PCS:4877-4880). Picks on an empty part make no sound.

**AI auto-pick.**
- Triggers at `songMs >= note.TimeMs`, with no pixel truncation (GPS:783-791).
- Uses the same three-condition test; (c) is folded into (b) (GPS:944-969).
- AUTO-chip test: `(chipBits & ~AutoMask & 0x3F) == 0`, or all five frets auto for OPEN (GPS:979-985).
- **[ADD]** With AutoWail, a queued wail succeeds as soon as it is queued (GPS:816-817). A manual Wail press with AutoWail on also gives no bonus (GPS:811-812).

---

## 3. Options (per part unless noted)

| Option | NX ini key (section) | NX range / default | NX semantics (cite) | AI |
|---|---|---|---|---|
| Play mode | `Guitar=` / `Drums=` ([System]) | bool; Guitar 0, Drums 1 (CI:1270-1271, 1757-1764, 2870-2877) | §4.1 | same keys (AC:556-559, 787-788) |
| ScrollSpeed | `GuitarScrollSpeed` / `BassScrollSpeed` ([PlayOption]) | 0..1999, default **1** (CI:1393, 3300-3306) | multiplier `(n+1)·0.5`, i.e. x0.5..x1000 (PCS:189). GB px/ms = `(n+1)·0.5·0.5·37.5·286/60000`, half the drum rate (CHIP:575-585). The value is eased by ±0.012 per tick (CActPerfScrollSpeed.cs:29-69) | stored as NX+1: 1..2000, default **2**, multiplier `v·0.5` (AC:38, 109-110, 563-571; GPS:425-426) |
| In-play scroll | none | none | ↑/↓ changes **guitar only** on the GR screen (PGS:509-516, PCS:2381-2388). Held `Decide` + `B` = +1, `Decide` + `R` = −1, per part (PCS:4866-4874) | **[NX-only]** none (GPS:570-575) |
| InputAdjustTime | `InputAdjustTimeGuitar/Bass` ([System]) | −99..99, default 0 (CI:1394, 3089-3095) | `lag = inputTime + adjust − chipTime` (PCS:974); adjust is 0 for AUTO chips. In-play ←/→ = ±10, or ±1 with Ctrl; Shift = guitar, Alt = bass, no modifier = **drums** (PCS:2309-2339, 2394-2401). **[ADD]** The change is written back to ConfigIni (PCS:2338) | same keys and formula (`inputMs = songMs + adjust`, GPS:799, 890); no in-play keys |
| HitRange | `GuitarPerfect/Great/Good/Poor`, `Bass…` ([HitRange]) | 0..999; default 34/67/84/117 (HR:43-49; CI:2546-2552, 4000-4029). Legacy unprefixed `Perfect=`… composes into all four sets (CI:3719-3730) | pick search window = Poor size (PCS:5439-5441) | same (AC:126-127, 628-639, 769-776) |
| Reverse | `GuitarReverse/BassReverse` ([PlayOption]) | default 0 (CI:1387) | judge-line Y = `reverse ? 611−JudgeLine : 154+JudgeLine` (PCS:348-349) | implemented (AC:117-118; GPS:422, 435) |
| Light | `GuitarLight/BassLight` | default **1 (ON)** (CI:1389) | OFF: an empty or wrong pick → BAD (gauge Miss damage, combo 0, no judgement image — BAD has no sprite, the judge slot is just blanked; see gb-judge.md §3.3 / gb-screen.md §4.6 [FIX], not counted) (PCS:5503-5512, 1953-1981). ON: no-chip sound only | implemented, default ON (AC:122-123; GPS:937-940) |
| Left | `GuitarLeft/BassLeft` | default 0 (CI:1391) | lane X order reversed, R-G-B-Y-P → P-Y-B-G-R (CL:1266-1269; PCS:4219-4235) | **[NX-only]** fixed false (GPS:439) **[FIX]** |
| Random | `GuitarRandom/BassRandom` | 0..4 = OFF, Mirror, Part (RANDOM), Super, Hyper (CI:3236-3243; CL:1256-1260; enum CC:151-160) | §3.1 | **[NX-only]** |
| Hidden/Sudden | `GuitarHiddenSudden/BassHiddenSudden` | ini 0..5, menu 0..4 = OFF, Hidden, Sudden, HidSud, Stealth; default 0 (struct default) (CI:3276-3283; CL:1177-1187; QC cycles %5, QC:406-437) | §3.2 | **[NX-only]** GB fixed 0 (GPS:440) **[FIX]**. AI's drum `HidSud` is a single global value (AC:178) |
| Specialist ("Performance Mode") | `GuitarSpecialist/BassSpecialist` | default 0 (CI:1390, 3256-3262) | on a Poor, a forced auto-miss or an empty pick, the chip plays pitch-shifted (§6) (PCS:5479, 5507, 4391) | **[NX-only]** |
| JudgeLinePos | **[FIX]** `GuitarJudgeLine` **and** `BassJudgeLine` ([PlayOption]) | 0..100 clamped, default 0 (CI:1262-1263, 3344-3346, 3356-3358; menu CL:1271-1276) | shifts the judge line (PCS:348-349) | **[NX-only]** |
| **[ADD]** JudgeLinePosOffset | `JudgeLinePosOffsetGuitar/Bass` ([System]) | −99..99 (CI:3105-3111) | copied to `nJudgeLinePosY_delta` (PCS:365-366) but only the drum value is used (PCS:4719). **No effect for GB** | none |
| Shutter In/Out | `GuitarShutterIn/Out`, `Bass…` | In 0..100; Out −100..100 in the ini (CI:3348-3366), but 0..100 in the menu (CL:1280-1294) | lane shutters | **[NX-only]** fixed 0 (GPS:442-443) **[FIX]**. **[NX-bug]** `BassShutterOut` falls back to the Guitar value (CI:3366) |
| LaneDisp, JudgeLineDisp, LaneFlush, AttackEffect, Position, Graph, MinCombo (Gt/Bs 2) | `Guitar…` / `Bass…` | CI:1309-1322, 1360, 2206-2222 | display only (CL:1200-1241, 1301-1312) | not configurable (LaneFlush fixed true, GPS:444) |
| Dark | `Dark` (shared by all parts) | OFF/HALF/FULL | QuickConfig also sets the target part's LaneDisp, JudgeLineDisp and LaneFlush (QC:370-395) | drum setting only |
| SoundMonitor | `SoundMonitorGuitar/Bass` ([System]) | default 1 (CI:1384; writer 1853-1859; reader 2966-2976; menu "GuitarMonitor" CL:1296) | §6 | **[NX-only]** |
| AutoGhost / TargetGhost | `GuitarAutoGhost`… | CI:2108-2114 | ghost replay (PCS:4308-4326) | **[NX-only]** |
| **[ADD]** Shared options that also apply to GB | `PlaySpeed`, `Risky`, `DamageLevel`, `StageFailed`, `AutoAddGage`, `BGMSound` | CI:3308-3311, 3320-3323, 1273-1274, 1349 | — | AI's GR stage honours PlaySpeed (scales chart times and pitch, GPS:302, 358-359, 369), Risky, StageFailed and AutoAddGage (GPS:414) |

### 3.1 NX GB Random (`tRandomizeGuitarAndBass`, DTX:3114-3262)
- **When it runs:** at load time, before the performance stage activates (SL:758-764). It therefore runs on the **original** guitar and bass parts, before any FLIP swap (PCS:417-420).
- **Scope:** only 3-lane channels `0x20..0x27` (`Guitar_Open..Guitar_RGBxx`) and `0xA0..0xA7` (DTX:3133-3138). 5-lane Y/P chips, wailing and LN-control chips are untouched.
  - **MIRROR is a no-op**: it falls into `default: continue` (DTX:3165-3166).
- **Lane table** (indexed by bit pattern 0..7, R=4, G=2, B=1): `{0..7}, {0,2,1,3,4,6,5,7}, {0,1,4,5,2,3,6,7}, {0,2,4,6,1,3,5,7}, {0,4,1,5,2,6,3,7}, {0,4,2,6,1,5,3,7}` (DTX:3118). Row 0 is the identity.
- **RANDOM:** one row per measure (`nPlaybackPosition/384`) (DTX:3127-3131, 3142).
- **SUPER:** a new random row for each chip (DTX:3146).
- **HYPER** (also changes the number of lanes):

  | Original pattern | Replacement |
  |---|---|
  | single lane | `rand(6)+1`, i.e. any 1- or 2-lane pattern (DTX:3158-3163) |
  | two lanes | `flag ? rand(8) : rand(7)+1` (DTX:3170-3174) |
  | RGB, `flag` set | 30% OPEN, 30% RGB, 25% one of xGB/RxB/RGx, 15% one of xxB/xGx/Rxx |
  | RGB, no `flag` | 60% RGB, 25% two-lane, 15% one-lane |
  | **[ADD]** OPEN (0) | unchanged |

  - `flag` = the chart has OPEN chips for that part and the chip is not a long note (DTX:3152-3157).
  - **[NX-bug]** Each inner `switch(rand(3)){case 0:…break; case 1:…break;}` is followed by an unconditional assignment. The 25% bucket therefore always becomes **RGx** and the 15% bucket always **Rxx** (DTX:3190-3253). **[FIX]** The draft cited 3175-3232.

### 3.2 NX Hidden/Sudden for GB (PCS:3800-3843; the same block for wailing chips at PCS:4540-4584)
`d` = `nDistanceFromBar` in pixels. Because the bands are in pixels, they cover less time at higher scroll speeds.

| Mode | Rule |
|---|---|
| SUDDEN (2 or 3) | `d<250`: alpha 255; `250≤d<300`: alpha `255−(d−250)·255/75`; `d≥300`: invisible |
| HIDDEN (1 or 3) | `d<150` (including past the bar): invisible; `150≤d<200`: alpha `(d−150)·255/75` |
| STEALTH (4) | always invisible |
| 5 (ini only) | no effect |

**[NX-bug]** The fade bands are 50 px wide but divided by 75. Alpha therefore jumps from about 88 to 0 at d=300, and from about 166 to full at d=200.

---

## 4. Mode selection and flow

### 4.1 NX
- `bGuitarRevolutionMode = !bDrumsEnabled && bGuitarEnabled` (CI:895-901). `bInstrumentAvailable(GUITAR|BASS)` = `bGuitarEnabled` (CI:835-847).
- The setters never allow both flags to be false (CI:819-833, 869-883).
  - On ini load, the order of lines matters. NX writes `Guitar=` before `Drums=` (CI:1760, 1764). So `Guitar=0` then `Drums=0` ends in **GR mode**, because the Drums setter turns Guitar on.
  - **[AI-diff]** AI always falls back to drums (AC:559).
- **CONFIG item "Drums & GR":** `{DrOnly, GROnly}`, with index = `drums ? 0 : 1` (CL:110-115). On save, Guitar = `(idx+1)/2==1` and Drums = `(idx+1)%2==1` (CL:3504-3506).
- **Stage dispatch:** the drum or guitar screen is chosen by this flag alone; chart content plays no part (APP:1164-1201). The same switch is used at load time (SL:761-764) and when collecting results (APP:1349, 1532).
- **Song-select gate on decide:** `Drums && score.Drums`, or `Guitar && (score.Guitar || score.Bass)`. Otherwise "Score unavailable for {Drum|Guitar/Bass} mode" is shown (SS:1101-1133).
  - The song list itself is not filtered.
  - **[ADD]** RANDOM SELECT *is* filtered by the same check (SS:1159-1197). Its list is reset when `bDrumsEnabled` changes (SS:211-225).
- **GR screen:**
  - Guitar is drawn on the left and bass on the right.
  - Drum chips are not drawn; each one plays its sound when it passes the bar (PGS:552-559).
  - Drum input is ignored (PGS:518-521).
  - STAGE FAILED triggers when **either** GB gauge fails, or when the chart has neither guitar **nor** bass chips. It is suppressed when STAGEFAILED is disabled or in training mode (PGS:168-179).
- **[FIX] GB chips when Guitar is disabled.** When `bGuitarEnabled` is false (DrOnly), GB chips are auto-played at the bar (PCS:4527-4531). The drum screen calls the same base drawing code (DrumsScreen/CStagePerfDrumsScreen.cs:3489-3495). With both flags on via the ini, GB chips would be drawn and judged on the drum screen.
- **[ADD] NX in-play keys on the GR screen** (`tHandleKeyInput`, PCS:2344-2480):

  | Key | Action | Source |
  |---|---|---|
  | Bass.Help (Pause) | pause | PCS:2347-2362 |
  | Shift+↑/↓ | BGM adjust, ±10 ms (±1 with Ctrl) | PCS:2371-2380 |
  | ↑/↓ | guitar scroll | PCS:2381-2388 |
  | Guitar.Help (F11) | toggles the performance-info display | PCS:2390-2393 |
  | ←/→ | input adjust | PCS:2394-2401 |
  | Esc | quit | PCS:2402-2407 |
  | Restart (`=`) | restart | PCS:2408-2417 |
  | Skip / Loop / Speed | training (unbound by default) | PCS:2418-2479 |

### 4.2 AI
- `GuitarMode` mirrors NX (AC:82-97). It is set by CONFIG > System > Play Mode, a DRUMS / GUITAR+BASS toggle (CS:44-45, 912-913, 1203).
- `StageFlow` creates `GuitarPerformanceStage` when `GuitarMode` is set (SF:136-141).
- **[AI-add]** The GR song list and RANDOM SELECT hide songs that have neither a guitar nor a bass chart; a BOX is shown only if it contains a playable song (GRS:41-61). Drum mode is not filtered.
  - **[FIX]** `HasChart(i)` = `Level[i] > 0 || LevelDec[i] > 0 || NoteMask bit i` (SSc:38-41). `HasChartFor` also checks the instrument variant (SLN:139-151).
- **[AI-diff]** Instead of NX's in-play fail, loading a chart with no GB chips aborts back to song select (SLS:130-136, 168-169).
- **[AI-add]** After decide, a GITADORA-style difficulty overlay appears (GRS:339-399, 529-562; AIdoc25:110-127):
  - GR mode: a GUITAR/BASS column × difficulty grid.
  - **[ADD]** Drum mode: a single DRUMS column (GRS:346; AIdoc25:116, 126).

### 4.3 FLIP (swap guitar/bass)

**NX:**
- **Toggle:** guitar `Y`×2 or bass `Y`×2 on song select flips `bIsSwappedGuitarBass` and swaps the clear lamps (SS:632-663).
  - **[ADD]** There is no GR-mode check, so it also toggles in drum mode. The list clear lamp shows Bass whenever the swap is on (CActSelectSongList.cs:1723-1727).
- **Runtime only:** initialised false (CI:1492) and never written to Config.ini.
- **Keys are not swapped.** The `SwapGuitarBassKeyAssign()` calls are commented out (SS:642, 659), and so is the function itself (CI:4034-4049).
- **Chips are swapped** when the performance stage activates (PCS:417-420 → `CDTX.SwapGuitarBassInfos`, DTX:4346-4422):
  - Part and channel are remapped: `0x20-0x28 ↔ 0xA0-0xA8`; Y/P channels by fixed offsets (0x32, 0x33, 0x3D, 0x34, 0x35); LN `0x2C ↔ 0x2D`; wailing chips separately.
  - LEVEL, LEVELDEC, visible-chip counts, per-lane counters and `bチップがある.Guitar/Bass` are swapped too.
  - **[ADD]** Not swapped: `bチップがある.OpenGuitar/OpenBass` (used by HYPER random), no-chip chips `0xBA/0xBB` (so the left side keeps the guitar's empty-pick sound, PCS:3405-3422), and the wailing-sound chip `0x2F` (PCS:3143-3149).
  - Result: **the left side, using guitar keys, guitar AUTO flags, guitar scroll, guitar hit ranges and guitar adjust, plays the bass chart.**
- **AUTO flags stay with the side during play.** They are swapped only around recording:
  - After a clear, results, timing counts and chips are swapped back and `SwapGuitarBassInfos_AutoFlags` is called (APP:1547-1563).
  - Leaving the Result screen swaps the flags back (APP:1668-1671).
  - On exit, a pending swap is undone (APP:2979-2982).
  - The stage-failed path swaps only the result entries (APP:1364-1370). **[FIX]** The draft cited 1362-1368.
  - None of this happens in training mode (APP:1361, 1545).
- Random (§3.1) runs **before** the swap. So `eRandom.Guitar` randomises the original guitar chart, which then appears on the right.
- Song-select and loading displays swap their level slots to `{0, swapped?2:1, swapped?1:2}` (CActSelectStatusPanel.cs:485; SL:502). Ghost files swap `gt` and `bs` (SL:235-240, 624-629).

**AI:**
- `SwapGuitarBass` is runtime-only (AC:99-106).
- It is toggled by GB `Y`×2 (SSS:335-336, 750-758; **GR mode only**, SSS:752, **[AI-diff]**) or by choosing the BASS column in the difficulty overlay (GRS:509-517).
- In the stage, `Part.ChartInst = swap ? 3−Inst : Inst`. Keys, AUTO, scroll, hit ranges, Light, Reverse and layout follow the side; records and levels follow `ChartInst` (GPS:380-425).
- During play this is equivalent to NX. AIdoc25:106-107's statement that NX swaps AUTO flags is true only for recording.
- **[AI-add]** For instrument-split songs, FLIP also chooses *which file* is loaded (§4.5).

### 4.4 Song select with guitar buttons

**NX (SS).** "GB" means the guitar *or* the bass pad.

| Input | Action |
|---|---|
| `R` held (key-repeat), or drum HT | cursor up (553-559) |
| `G` held (key-repeat), or drum LT | cursor down (562-568) |
| `Decide` of D/G/B, drum CY/RD, or Enter if Enter is not bound anywhere | select (503-504) |
| GB `Cancel` or drum LC | leave BOX (571-577); at the root, to title (465) |
| `Esc` | always to title (465) |
| Guitar `Help` (default F11) | open CONFIG (475-483) |
| per-instrument `B`×2 | next difficulty (606-631) |
| per-instrument `Y`×2 | FLIP (632-663) |
| per-instrument `P`×2 | Quick Config popup for that part (665-691) |
| `Y` held + `P` pressed | sort menu (693-706) |

- **CommandHistory** (SS:935-1013) **[FIX]** (draft: 935-997):
  - A buffer of the last 16 entries. Only B, Y and P (GB) and BD, HH/HHO and FT (drums) presses are added; R, G and Pick are not.
  - A command matches if the last N entries equal the pattern, all belong to the same instrument, and the newest is within 500 ms of now with **each gap ≤ 500 ms**.
  - On success the whole history is cleared.

**AI (GBC, GRS, SSS:300-347):**
- Guitar and bass bindings are merged into one button set, so there is no per-instrument history (GBC:6-11, 48-57).
- `DoubleTapped` keeps a per-button timestamp. The second press within 500 ms succeeds and then resets (GBC:63-71).
  - **[AI-diff]** Pressing another button in between does not break a double-tap.
- Mapping (SSS:302-346):
  - R/G move the cursor with key-repeat.
  - B×2 = next difficulty (X also works).
  - Y×2 = FLIP.
  - **P×2 opens the full CONFIG** (**[AI-diff]**: NX opens Quick Config).
  - It is an else-if chain, so at most one command runs per frame.
- **Pick = decide**, in addition to Enter/Space/pad South (GRS:34-35). **[AI-diff]** NX uses the `Decide` pad.
- The F2 (sort), F3 (search), F4 (training) and Shift+F1 (config) hotkeys are disabled when the key is bound to a GB button (GRS:27-32; SSS:339-346). With the default keys this disables F2-F4 in GR mode.

### 4.5 SongInstrumentMerge **[AI-add]** (SIM; AIdoc25)

**Purpose.** GITADORA-style packs split instruments into separate files (`dm_*`, `gt_*`, `ba_*`). In set.def they appear as one block per instrument: `#TITLE x (Drum)`, `(Guitar)`, `(Bass)`. NX shows one list node per block (AIdoc25:5-24).

The test song follows this layout:
- set.def: `#TITLE: 完全感覚Dreamer (Drum|Guitar|Bass)`, each with L1-L4 BASIC/ADVANCED/EXTREME/MASTER.
- Every DTX has the same untagged `#TITLE: 完全感覚Dreamer`.
- **[FIX]** Each file has one level line (`#DLEVEL`, `#GLEVEL` or `#BLEVEL`) and its own instrument's channels. Every file also has BGM `01`, and the BSC/ADV/EXT files also have SE channels `0x66-0x92`.
  - `gt_mst`: 20-26, 28, 2C, 93-96, 9B, 9C, AC, AD.
  - `ba_mst`: A0-A6, A8, 2D, C5, C6, C8, C9, CE, CF, E1, E2.

**When it runs:** after all headers are loaded, recursively over every list (SIM:37-45).
- A list with fewer than 2 nodes is skipped (SIM:50).
- **[FIX]** Only `ENodeType.Score` nodes take part; BOX, ScoreMidi and other nodes pass through (SIM:59-63).

**Algorithm per list** (SIM:48-98):
```
for n in nodes (list order):
  if n.NodeType != Score → keep
  mask = OR over n.Scores of bit i where HasChart(i)        // D=1, G=2, B=4 (SIM:165-177)
  folder = FirstScore.AbsoluteFolderPath, '/'→'\', trim trailing '\', lower-case (SIM:179-184)
  if mask==0 or folder==null → keep untouched
  titleKey = folder+"\n"+Normalize(n.Title)                 // set.def/list title
  dtxKey   = folder+"\ndtx:"+Normalize(FirstScore.Title)    // DTX #TITLE (null if empty)
  host = first host under titleKey with (hostMask & mask)==0,
         else first under dtxKey with disjoint mask (viaDtx=true)   (SIM:100-117)
  if none: hostMask[n]=mask; register n under titleKey (and dtxKey if non-null); keep
  else: Absorb(host, hostMask[host], n, mask, viaDtx ? dtxTitle : null);
        hostMask[host] |= mask; drop n from list
```

**Absorb** (SIM:131-160):
- **First absorb** (no variant set yet):
  - Set `host.InstrumentVariant[i] = host` for each of the host's own bits.
  - Display title: `StripInstrumentTag(host.Title)` if that changes it. Otherwise, **[FIX] only when the match was via the DTX key**, use the matched DTX `#TITLE`.
- **[ADD] Later absorbs:** if the host title has no tag and the match was via the DTX key with a different title, replace the title with the DTX `#TITLE` (SIM:151-155).
- Then set `host.InstrumentVariant[i] = other` for each of the other node's bits.
- Scores, labels, breadcrumbs and record keys stay on their original nodes.

**Normalize** (SIM:223-239): strip the tag, lower-case, then collapse runs of whitespace (`char.IsWhiteSpace` or U+3000) to one space, dropping leading and trailing whitespace.

**StripInstrumentTag** (SIM:210-220): on the trimmed title, repeat `trailingBracket || leadingBracket || trailingToken` (short-circuit, in that order) until nothing changes. If the result would be empty, return the original trimmed title.
- **Brackets** (paired by index): `( [ { < （ ［ 【 〈 《 「 『 ＜ 〔` with their matching closers (SIM:202-203).
  - Trailing (SIM:241-254): length ≥ 3; the last character is a closer; the matching opener is found with `LastIndexOf` at an index > 0; the inner text is a tag (in-bracket rules); the text before it, right-trimmed of separators, is non-empty.
  - Leading (SIM:256-269): length ≥ 3; the first character is an opener; the first matching closer is at an index > 0 and is not the last character; the inner text is a tag; the rest, left-trimmed of separators, is non-empty.
- **Separators:** space, tab, U+3000, `- _ / ~ ～ : ： － ・ | ｜` (SIM:206).
- **Trailing token** (SIM:272-283): the body is right-trimmed of separators; the text after the last separator (at an index > 0) must be an *exact* tag; the remainder, right-trimmed, must be non-empty.
- **IsInstrumentTag(s, inBracket)** (SIM:285-301): lower-case, then remove whitespace, U+3000, `.`, `-` and `_`.
  - Exact set (SIM:189-196): `drum drums dr dm drummania guitar guitars gt gtr guitarfreaks bass bs ba gf df gb g&b gt&bs gt/bs guitar&bass guitar/bass guitarbass ドラム ドラムス ギター ベース ギター&ベース ギター/ベース ギターベース`.
  - Only inside brackets: the single letters `d g b`, or any string *containing* `drum`, `guitar`, `bass`, `ドラム`, `ギター` or `ベース` (SIM:199-200).

**Selecting a variant:**
- `VariantFor(i) = InstrumentVariant[i] ?? self` (SLN:78-82).
- `VariantForMode(guitarMode, bassPrimary)` (SLN:90-95):
  - drum mode → `VariantFor(0)`;
  - GR mode → `[bassPrimary ? 2 : 1] ?? [other] ?? self`;
  - `bassPrimary` = FLIP on in GR mode (AIdoc25:70-74).

**Limitation** (AIdoc25:145-146): the GR stage loads **one file**. For a split song, only the chosen instrument's chips exist and the other GB lane is empty. That file's BGM `01` (plus SE) is the only backing, and no drum chips are present.

---

## 5. Training

### 5.1 AI training menu (drums only)
- Toggled with `F4` on song select (SSS:343-344, 735-740). Settings are stored separately under `[Training]` with `Training*` keys (TS:28-73; AIdoc19:9-22, 81-105).
- Menu: ↑↓ select, ←→ change (×10 with Ctrl, with key-repeat), Enter/NumpadEnter decide, Esc back or quit (TM:12, 236-266).
- Items (TM:43-65). The web app already has a spec for this in docs/spec/training-menu.md.

| # | Item | Semantics | Guitar variant needs |
|---|---|---|---|
| 0 | 自動演奏 | all lanes AUTO; same as F1 | per part: all 7 flags |
| 1 | 自動演奏詳細 | sub-page with 10 lane toggles LC..RD plus "all" and "back" (no LBD, TM:67-72); stored as 11 digits (TS:99-115) | per part: R, G, B, Y, P, Pick, Wail, or presets OFF/NECK/PICK/ALL |
| 2 | ノーツ表示調整 | draw offset ±999 ms; judging unchanged | generic |
| 3 | 判定タイミング調整 | judge offset ±99 ms | per part (`InputAdjustTimeGuitar/Bass`) |
| 4 | ハイスピード | `v·0.5`, 1..2000, default 2 | per part (`GuitarScrollSpeed`/`BassScrollSpeed`) |
| 5 | 演奏速度 | `v/20`, 5..40 | generic |
| 6 | 開始待ち時間 | 0..5000 ms in 100 ms steps, default 1000 | generic |
| 7-10 | ループ演奏 / 単位 / 終了 / 開始 | measure (from bar lines) or 0.5 s steps; begin < end enforced (TS:117-201) | generic; uses the GB chart's bar lines |
| 11-14 | 演奏開始/停止, リスタート, 一時停止/再開, 終了 | state machine STANDBY → START IN → PLAYING ⇄ PAUSED; no records, no STAGE FAILED (AIdoc19:54-79, 141) | generic |

The web app additionally has ドラム音量, BGM 音量 and 現在位置, which are not in AI (per CLAUDE.md).

### 5.2 Why AI did not do guitar training
- GR mode has neither the training mode nor in-play hotkeys. Only Pause, Esc and F11 (help) work, **because F1-F5 are the neck buttons** (AIdoc20:123-124, 174; GPS:34-36, 570-575).
- The GR stage never reads `TrainingMode` and always builds its result with `Training=false` (GPS:1290). In GR mode F4 is suppressed anyway, because it is bound to Guitar Y (GRS:29-32; SSS:343).
- Collisions between the AI drum-stage hotkeys and the GB defaults:

  | Key | Drum-stage use | Collides with |
  |---|---|---|
  | F1 | AUTO toggle (PS:872) | Guitar R |
  | Shift+F1 or Pause | pause (PS:1075) | Guitar R |
  | F2 or `=` | restart (PS:1095) | Guitar G |
  | F5 / F6 | skip **back** / **forward** (PS:1102-1115) | F5 = Guitar P; F6 free |
  | F7 / F8 | loop set / clear (PS:1118-1131) | none (F7 is NX Guitar Decide; AI has no Decide key) |
  | F9 / F10 | play speed −/+ (PS:1134-1145) | none |
  | F11 | help (PS:841, 870) | none (NX System Help) |
  | F4 | training toggle on song select | Guitar Y; suppressed by `HotkeyPressed` (GRS:29-32) |

- The menu itself uses arrows and Enter/NumpadEnter (TM:243-250), so bass Pick on NumpadEnter collides with the menu's decide key.

### 5.3 NX training
- NX has no menu. The hotkeys `SkipForward/Backward`, `LoopCreate` and `Increase/DecreasePlaySpeed` set `bIsTrainingMode = true`; `LoopDelete` and `Restart` do not (PCS:2408-2479). They are unbound by default (CI:4241-4246).
- The GR screen shares them, because `tHandleKeyInput` is common code (PCS:2344-2480).
- Training mode disables STAGE FAILED (PGS:168) and recording (APP:1361, 1545).

---

## 6. Volume and how AUTO parts sound

**NX:**
- **Global levels:** `ChipVolume` (manual, `n手動再生音量`) default 100; `AutoChipVolume` (`n自動再生音量`) default 80. Range 0..100 (CI:1365-1366, 1908-1916, 3036-3043).
- **No per-part volume.** Instead there is a per-part `SoundMonitor{Drums,Guitar,Bass}`, default ON (CI:1384, 1853-1859).
- `nモニタを考慮した音量(part)` (DTX:1543-1574):
  - returns `monitor[part] ? AutoChipVolume : ChipVolume`;
  - for UNKNOWN parts (BGM), returns ChipVolume if **all** monitors are off, otherwise AutoChipVolume.
- **Which volume each sound uses:**

  | Sound | Volume | Cite |
  |---|---|---|
  | Auto-picked GB chip (including forced Miss) | monitor volume | PCS:4391 |
  | GB chips when Guitar is disabled | monitor volume | PCS:4530 |
  | Drum chips on the GR screen | monitor volume (Drums) | PGS:558 |
  | BGM | UNKNOWN-part monitor volume | PCS:2992 |
  | Manual pick hit | `ChipVolume` | PCS:5479 |
  | Empty / no-chip pick | `ChipVolume` | PCS:5507 |

  - With the defaults, AUTO and BGM play at 80 and the player's own hits at 100.
  - The `bモニタ` argument is passed through but unused in `tPlayChip` (DTX:3279-3317).
- **Final gain:** `nVol × #VOLUMExx / 100` (DTX:3309).
- **Monophonic per part:** the previous WAV of the same part is stopped before each GB chip plays (PCS:1374-1387). Releasing an LN outside its window also stops it (PCS:5407-5416).
- **Specialist pitch:** frequency ratio = `(100 + (rand(3)+1)·7·(±1))/100`, one of {0.79, 0.86, 0.93, 1.07, 1.14, 1.21} (DTX:3299-3306).

**AI:**
- `ChipVolume` 100 and `AutoChipVolume` 80 exist (AC:277-281). There is no SoundMonitor.
- On the GR screen, GB chip volume = `AllAuto(part) ? AutoVol : ChipVol` (GPS:1036-1045).
  - **[FIX][AI-diff]** In NX, every auto-picked chip uses the monitor volume. In AI, a part that is not fully auto plays even its auto-picked chips at ChipVol. Example: **AUTO PICK** (neck manual) plays at 80 in NX and at 100 in AI. The draft's NECK example was wrong: with NECK only, chips are picked manually and play at ChipVolume in both.
- BGM (GPS:622-635) and drums on the GR screen (GPS:673-685) play at AutoVol.
  - **[ADD]** SE play at `#VOLUME` only (GPS:647-669).
- No-chip picks play at ChipVol (GPS:1071). Each part is monophonic (GPS:1042-1044, 1069-1070).
- **[ADD][AI-diff]** On AI's **drum** screen, GB chips are auto-sounded at `#VOLUME` only, with no AutoVol (PS:1381-1401). NX uses the monitor volume (80).

---

## 7. Decisions for the web port

| # | Decision | NX | AI | Notes / proposal |
|---|---|---|---|---|
| 1 | Default keys | F1-F5 / Colon / RCtrl; numpad 1-5 / NumpadEnter / Numpad0 (effective after dedupe) | NX keys plus `]` and Numpad `.` kept as Pick | **Conflicts with web `RESERVED_CODES` (F1, NumpadEnter).** Move AUTO off F1 in GB mode or choose new defaults. Browser F-keys (F1, F3, F5, F7, F11) need `preventDefault` |
| 2 | Bindings per button | 16 | 12 | Keep 12, matching the drum lanes |
| 3 | Decide/Cancel/Help per instrument | yes | no | Web uses Enter and Esc only |
| 4 | Which part the player plays | both manual (2P) | Guitar manual, **Bass ALL AUTO** | Single-player training: pick one part, other part ALL AUTO |
| 5 | AUTO granularity | 7 flags per part; QuickConfig presets (Auto Neck and Auto Pick both leave W manual) | 4 presets, W tied to Pick (differs only for PICK), no custom | Choose presets and/or 7 toggles; decide what W does |
| 6 | Manual pick while AutoPick is on | still processed (quirk) | ignored | Choose one; AI's choice is simpler |
| 7 | AUTO trigger and judging | **[FIX]** fires when `now ≥ t + 1/k` (≥ ~11 ms late at x1.0) because of int truncation; AUTO chip lag 0; non-AUTO chip judged by \|InputAdjust\|; combo advances; "AUTO" text | time-exact, always Perfect | Time-exact |
| 8 | **[ADD]** AUTO and gauge/score | gauge untouched unless AutoAddGage; score × rev (½ AutoPick, ½ any neck auto; 0 if all-auto) | same | Training has no fail; decide whether to show a score |
| 9 | Scroll-speed representation | n 0..1999, ×(n+1)/2, GB at half the drum px/ms | stored +1 | Reuse the drum representation, per part |
| 10 | Input adjust | per part ±99, `lag = in + adj − t` | same | Per part, or one shared value in training |
| 11 | Hit ranges | per part 34/67/84/117, Poor = search window | same | Same |
| 12 | Light | default ON | default ON | Same |
| 13 | Reverse | per part | per part | Per part, or skip |
| 14 | Left, Random, Sudden/Hidden, Specialist, Shutter, JudgeLine | NX features (Random: 3-lane only, MIRROR no-op, HYPER bug) | none | Probably out of scope; document as unported |
| 15 | Mode switch | `Drums`/`Guitar` flags choose the screen; decide-time gate; random select filtered | same + list filter + abort at load | A web mode toggle (drums / GB) with a filter for charts that lack the part |
| 16 | FLIP / bass selection | Y×2 swaps chips (also in drum mode); keys and AUTO stay with the side | same, GR only, + difficulty overlay column | Simpler: a "play guitar / play bass" choice |
| 17 | Split-instrument songs (`gt_`/`ba_`/`dm_`, set.def blocks) | separate list items | merged list item, one file loaded (other lane empty) | Merge per §4.5. Decide whether to load both GB files (their WAV-id namespaces collide) or only the chosen one |
| 18 | GB song-select buttons | B×2 / Y×2 / P×2 / R / G, 500 ms | merged set, Pick = decide | Probably not needed (mouse UI) |
| 19 | Training menu for GB | NX hotkeys only | not implemented (F-key collisions) | Same menu with per-part AUTO, hi-speed and adjust; menu keys must not overlap GB keys (NumpadEnter, F-keys) |
| 20 | Volumes | Chip 100 / Auto 80 + SoundMonitor per part; every auto-picked chip at Auto | Chip / Auto, AllAuto-gated | Web has drum and BGM buses; add **guitar and bass buses** (or one GB bus) and an AUTO-part level |
| 21 | Monophonic GB voice | yes | yes | Keep |
| 22 | GB chips in drum mode | auto-played at the bar (monitor volume) | auto-played at `#VOLUME` only | The web player at HEAD has no GB handling; decide whether to sound them |
| 23 | Drum chips in GB mode | auto sound, not drawn | same | Keep |
| 24 | STAGE FAILED on GB gauge | either part fails, or there are no GB chips | same; no-chip charts abort at load | N/A in the training-only web app (no fail) |
