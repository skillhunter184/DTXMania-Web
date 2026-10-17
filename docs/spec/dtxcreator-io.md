# dtxcreator-io

# DTXCreator DTX load/save and DTXMania NX DTX text decoding: behavioral specification

Source root (absolute): `DTXmaniaNX\`, repo HEAD `9cdabe2`. Both DTXCreator and DTXMania NX target .NET Framework 4.7.1 (`DTXCreator\DTXCreator.csproj:13`, `DTXMania\DTXMania.csproj:13`).

Files read:
- `DTXCreator\Code\00.App\CDTXInputOutput.cs` (3390 lines). Loader `tDTX入力` (46-130, 198-2550) and writer `tDTX出力` (24-45, 2552-3315). Decimal `TryParse` (3325-3385).
- `DTXCreator\Code\00.App\MakeTempDTX.cs` (73 lines). Temp-file lifecycle for the viewer.
- `DTXCreator\Code\00.App\CMainForm.cs`:
  - new/reset `t譜面を初期化する` (521-640)
  - open `t演奏ファイルを開いて読み込む` (740-866)
  - save `tシナリオ_上書き保存` / `名前をつけて保存` (871-1015)
  - viewer temp file (1541-1761)
- `DTXCreator\Code\05.Score\ScoreManager.cs`. Lane table (746-848), 10 initial measures (857-863).
- `DTXCreator\Code\05.Score\CMeasure.cs`, `CChip.cs`, `CLane.cs` (105-121), `CEditModeManager.cs` (173-290), `CChangeMeasureLengthDialog.Designer.cs` (44-61)
- `DTXCreator\Code\00.App\CMainForm.Designer.cs:503-516` (BPM numeric box)
- `DTXCreator\Properties\Resources.resx:127-129` (version string)
- `FDK\Code\00.Common\CConversion.cs` (189 lines). Base-36, hex and measure-number codecs, shared by both programs.
- `DTXMania\Code\Score,Song\CDTX.cs` (6998 lines). Player reader. `DTXMania\Code\Score,Song\EChannel.cs` (channel enum).

Conventions:
- **grid** is DTXCreator's internal unit: 192 per 1.0-length measure.
- **tick** is NX's unit: always 384 per measure, whatever the bar length.
- "INFERRED" marks a conclusion drawn from code paths or from .NET framework behaviour, not a line that states it directly.
- `int /` truncates.

---

## 1. Shared codecs (CConversion.cs)

- **Base-36 digits.** `strBase36Characters = "0-9A-Za-z"`. Lowercase letters index 36..61 and are folded back by −26, so 2-digit base-36 parsing is case-insensitive (104-124). Output is always uppercase (169-177). Out-of-range output (`num<0 || num>=1296`) silently returns `"00"` (171-172).
- **Hex.** Parsing is case-insensitive (83-103). Output is uppercase; out-of-range output returns `"00"` (160-168).
- **Measure number (3 chars).** The first char is base-36; the 2nd and 3rd chars must be decimal 0-9 (125-145). So the value is `d36*100 + d10*10 + d1`, range 0..3599 ("Z99"). Examples: 100 → `"100"`, 1000 → `"A00"`.
  - The formatter (147-159) returns **`"000"` for any value ≥3600 or <0, silently**.
  - DTXCreator's measure setter throws above 3599 (`CMeasure.cs:42-45`).

## 2. DTXCreator: load

### 2.1 File open and decode (CMainForm.cs:740-866)
- **Extension dispatch** (761-793): `.dtx`→DTX, `.gda`→GDA, `.g2d`→G2D, `.bms`→BMS, `.bme`→BME. Any other extension shows `strDTXファイルではありませんMSG` and aborts.
- **Read** (820-822):
  ```csharp
  StreamReader reader = new StreamReader( strファイル名, Encoding.GetEncoding( 932/*Shift-JIS*/ ) );
  string str全入力文字列 = reader.ReadToEnd();
  ```
  INFERRED (.NET Framework): this constructor has `detectEncodingFromByteOrderMarks=true`, so UTF-8 and UTF-16/32 files with a BOM are also decoded correctly (see 4.1).
- **After parsing:**
  - The file name's extension is forced to `.dtx` (832).
  - The working folder becomes the file's folder (833).
  - Non-DTX inputs are marked unsaved (847-848).
- **Reset before parse** (`t譜面を初期化する`, 521-640):
  - title, artist and similar fields are cleared; `numericUpDownBPM=120`; DLEVEL 50, GLEVEL 0, BLEVEL 0 (532-538)
  - WAV/BMP/AVI managers are recreated (550-557); `textBox自由入力欄` is cleared (565)
  - a new `ScoreManager.t初期化()` builds the lane list and **measures 0..9** (584-607; `ScoreManager.cs:500-506, 857-863`)
  - `tDTX入力` then sets DLEVEL/GLEVEL/BLEVEL to 0 again (`CDTXInputOutput.cs:48-55`). A loaded file without `#DLEVEL` therefore shows 0, while a brand-new chart shows 50.

### 2.2 Tokenizer (CDTXInputOutput.cs:46-130, 250-405)
- **Pre-pass.** `Replace(Environment.NewLine /*"\r\n"*/, "\n")` and `Replace('\t',' ')` (68-69). LF-only files work. A lone CR is not handled (INFERRED: a CR-only file becomes one line).
- **Loop** (72-110):
  1. Skip spaces and newlines.
  2. If the current char is `#`: read the command up to `:`, space, `;` or `\n` (250-276). A `:` is consumed together with the spaces after it, so `#CMD: v`, `#CMD:v` and `#CMD v` are all equivalent.
  3. Read the parameter up to `\n` or `;` (368-383). If the line has `;`, read the comment up to `\n` (288-307).
  4. Call `tDTX入力_行解析`. The parameter is passed `.Trim()`ed; the command and comment are passed raw (408-410).
  5. Always skip to the next line (277-287).
- **Lines whose first non-blank char is not `#` are dropped.** This includes `;` comment lines, blank lines and the old `; Created by` line (the loop simply falls into `コメントをスキップする`, 110).
- **The last line is lost if the file does not end with `\n`.** INFERRED: `パラメータ文字列を抜き出す` returns false when `MoveNext()` fails before reaching `\n` (375-378). The loop then `break`s (107) and `行解析` is never called for that line. NX avoids this by appending `"\n"` (CDTX.cs:3474); DTXCreator does not.

### 2.3 Dispatch order and recognised commands (406-412)
The first handler that returns true wins. The order is: `TITLE_ARTIST_COMMENT_その他` → `WAVVOL_VOLUME` → `WAVPAN_PAN` → `WAV` → `BGMWAV` → `BMPTEX` → `BMP` → `AVI_AVIPAN` → `BPx` → `DTXC_LANEBINDEDCHIP` → `DTXC_WAVFORECOLOR` → `DTXC_WAVBACKCOLOR` → `DTXC_BMPFORECOLOR` → `DTXC_BMPBACKCOLOR` → `DTXC_AVIFORECOLOR` → `DTXC_AVIBACKCOLOR` → `DTXC_CHIPPALETTE` → `チャンネル`.

| Command (match rule) | Effect | Lines |
|---|---|---|
| `TITLE`, `ARTIST`, `COMMENT`, `PREVIEW`, `PREIMAGE`, `STAGEFILE`, `RESULTIMAGE` (**exact** `Equals`, case-insensitive) | Text box gets `param.Trim()`. Any comment is dropped. | 736-793 |
| `BACKGROUND` or `WALL` (exact) | `textBoxBACKGROUND` | 782-787 |
| `PANEL` (exact) | Non-integer param → panel text. An integer param falls through to `WAVPAN_PAN` as `#PAN` + `EL`, i.e. the pan of WAV `EL` (same rule as NX, CDTX.cs:5058-5071). | 754-763 |
| `BPM` (exact) | Decimal via the comma-tolerant `TryParse`. On failure → 120. Assigned to `numericUpDownBPM` (DecimalPlaces 2, Max 9999, `CMainForm.Designer.cs:503-516`). INFERRED: a value above 9999 throws. | 794-804 |
| `DLEVEL`, `GLEVEL`, `BLEVEL` (exact) | Integer clamped to 0..999; non-integer → 0 | 805-867 |
| `DTXVPLAYSPEED` (exact) | `decimal.TryParse`, clamped to 0.5..1.5. Combo index = `(int)((1.5−v)*10)`, clamped 0..10. | 868-897 |
| `WAVVOLzz` / `VOLUMEzz` (StartsWith) | Integer clamped 0..100 → `n音量0to100`. Returns true even when the value does not parse, so a bad line is swallowed. | 955-988 |
| `WAVPANzz` / `PANzz` | Integer clamped −100..100 → `n位置_100to100` (same swallowing) | 921-954 |
| `WAVzz` | zz must be 1..1295. Filename = param, label = comment. A redefinition overwrites, so **infinite definitions collapse to the last one** (INFERRED). | 901-920 |
| `BGMWAV: zz` | Collects zz. After parsing, sets `bBGMとして使用` on those WAVs. | 433-450, 118-124 |
| `BMPTEXzz` / `BMPzz` (`BMP` requires length > 3) | zz 1..1295. Filename, label, `bテクスチャ` flag. | 451-492 |
| `AVIzz` (but not `AVIPAN`) | zz 1..1295. Filename, label. | 413-432 |
| `BPMzz` | zz 1..1295 and value in **0..1000**, otherwise the handler returns false and the line goes to free text. `dicBPx.Add(zz, (float)v)`. INFERRED: a **duplicate `#BPMzz` throws** `ArgumentException` (no try/catch on the open path). | 493-515 |
| `DTXC_*` | See 3.9 | 516-733 |
| `MMMCC` (channel line) | See 2.5 | 989-2235 |

Everything else falls through to free text (2.4). Examples: `#GENRE`, `#PLAYLEVEL`, `#HIDDENLEVEL`, `#PREMOVIE`, `#BACKGROUND_GR`, `#BASEBPM`, `#DLVDEC`, `#PATH_WAV`, `#SIZE`, `#BGA`, `#BGAPAN`, `#AVIPAN`, `#VIDEO`, `#MIDIFILE`, `#SOUND_*`, `#RESULTMOVIE`/`#RESULTSOUND`, `#BPM00`, `#BMP00`, `#RANDOM`, `#IF`, `#ENDIF`.

### 2.4 Unrecognised lines go to the 自由入力欄 free-text tab
- **Unknown command line** (95-100): rebuilt as `"#" + cmd + ": " + rawParam`, plus `"\t;" + comment` if there was one, plus CRLF. These lines are buffered and appended to `textBox自由入力欄` **after** the whole parse (112).
- **Channel line whose channel has no lane** (2225-2234): rebuilt as `"#" + 3-digit measure + 2-digit uppercase hex channel + ": " + param`, plus `" ;" + comment`. These are appended to the text box **immediately**, during the parse.
- Resulting order in the tab: all unknown-channel lines (in file order) come first, then all unknown commands (in file order). INFERRED.
- The free text is written back verbatim in the header area on save (3.4). So these lines survive, but:
  - they are moved away from their original position;
  - INFERRED: they are not renumbered when DTXCreator inserts or deletes measures.
- **`#RANDOM`/`#IF`/`#ENDIF` are not interpreted.** INFERRED: chips from every branch are loaded into the score unconditionally, while the `#IF`/`#ENDIF` lines end up together in the free-text block with no chips between them. The branch structure is destroyed and all branches play.
- `nChannel == 0` or an unparsable measure makes `コマンドから小節番号とチャンネル番号を抜き出す` return false (2477). The line is then treated as an unknown command.

### 2.5 Channel lines (989-2235, 2460-2523)
- **Command parse** (2462-2477): length **≥5** (NX requires exactly 5). The first 3 chars are the measure; the next 2 chars are a hex channel for DTX, or mapped through tables for GDA/G2D (2236-2427) and BMS/BME (2430-2459).
- **Bar length (ch 02)** (996-1005): decimal via `TryParse`, default 1. `dic小節長倍率.Add(bar, v)`. A duplicate `#MMM02` throws (INFERRED). No measure is created for it.
- **Measure creation** (2505-2523): if `bar > max`, every measure `max+1..bar` is created, so measures stay contiguous.
- **Data string:** every `_` is removed (2202-2206); `nChips = len/2`, so an odd trailing char is ignored. Each pair `i` gets `n位置grid = i`, `n読み込み時の解像度 = nChips`, and the value from base-36 (hex for ch 03, 2210). Only `value > 0` creates a chip (2211). INFERRED: an invalid pair parses to −1 and is skipped silently; NX rejects the whole line instead.
- **Lane lookup** (2483-2504): lanes are scanned in order; the 表 (front) channel is checked before the 裏 (back) channel; the first hit wins. The chip keeps `nチャンネル番号00toFF = nCh` and `b裏`. Lane table (`ScoreManager.cs:752-843`; index = position in `listレーン`, used by `#DTXC_LANEBINDEDCHIP`):

  | idx | lane | 表 / 裏 ch | | idx | lane | 表 / 裏 ch |
  |---|---|---|---|---|---|---|
  | 0 | BPM | 08 / 03 | | 21 | BGM | 01 |
  | 1 | LC | 1A | | 22-26 | SE1-SE5 | 61-65 |
  | 2 | HH | 11 / **18** (HHO) | | 27-53 | SE6…S32 | 66-69, 70-79, 80-89, 90-92 (hidden by default) |
  | 3 | LP | 1B | | 54 | GtV | 0 (wav for guitar notes) |
  | 4 | LB | 1C | | 55-59 | GtR/GtG/GtB/GtY/GtP | 0 |
  | 5 | SD | 12 | | 60 / 61 | GtW / GtL | 28 / 2C |
  | 6 | HT | 14 | | 62-67 | BsV, BsR..BsP | 0 |
  | 7 | BD | 13 | | 68 / 69 | BsW / BsL | A8 / 2D |
  | 8 | LT | 15 | | 70 | AVI | 54 |
  | 9 | FT | 17 | | 71 / 72 | BG1 / BG2 | 04/C4, 07/C7 |
  | 10 | CY | 16 | | 73 | BG3 | **0x100** (never matches) / D5 |
  | 11 | RD | 19 | | 74-78 | BG4-BG8 | 56/D6, 57/D7, 58/D8, 59/D9, 60/E0 |
  | 12 | FI | 53 | | | | |
  | 13-16 | BN1-BN4 | 4F, 4E, 4D, 4C | | | | |
  | 17-20 | MLC, MHH, MCY, MRD | 87, 84, 85, 86 | | | | |

  - MLC/MHH/MCY/MRD shadow S27/S24/S25/S26, which use the same channels; NX treats 0x84-0x87 as SE24-SE27 (`EChannel.cs`).
  - Channels with no lane go to free text. INFERRED list, checked against `EChannel.cs`: 05, 06, 09, 0A, 1F, 29, 2F, 30, 31-3C (hidden drum chips), 50, 51, 52, **55** (because BG3's 表 is 0x100), 5A, B1-BE (no-chip empty-hit sounds), C1, C2, EA-EF.
- **Guitar and bass** are decoded into one value chip plus fret chips with `nチャンネル番号=0`:
  - Guitar channels (1006-1608): 0x20-0x27, 0x93-0x9F, 0xA9-0xAF, 0xD0-0xD3. Each nonzero pair adds a GtV chip (value = WAV) and then fret chips with value 1. Channel 0x20 adds **GtR with value 2 = OPEN** (`ScoreManager.cs:29-33`).
  - Bass channels (1609-2196): 0xA0-0xA7, 0xC5-0xC6, 0xC8-0xCF, 0xDA-0xDF, 0xE1-0xE8, decoded the same way.
  - INFERRED: an invalid pair gives −1, which passes the `!= 0` test, and the `n値` setter throws (`CChip.cs:70-73`).

### 2.6 Grid mapping (2524-2550; CMeasure.cs:11-33)
- Post-processing order (113-117):
  1. sort each measure's chips by the raw `n位置grid` (still the pair index i at this point);
  2. apply bar lengths and rescale;
  3. bind BPM;
  4. rebuild the list views;
  5. rebuild the palette.
- Bar-length application (2526-2541):
  ```
  num = 1.0
  for i in 0..dic小節.Count-1:              // assumes keys 0..Count-1
      if dic小節長倍率 has key i: num = value  // **persists** to later measures
      m.f小節長倍率 = num
      H = (int)(192 * num)                   // n小節長倍率を考慮した現在の小節の高さgrid
      chip.n位置grid = chip.n位置grid * H / chip.n読み込み時の解像度   // truncation
  ```
- **Precision loss** (INFERRED from the formula):
  - Any resolution whose positions don't land on the 1/H grid is truncated. 1/5 → 38/192 instead of 38.4. Odd slots of a 384-resolution line shift 1/384 measure earlier and can collide with the previous slot. A 4-division line in a 0.3 measure (H=57) lands at 0/14/28/42.
  - A `#MMM02` for a measure that doesn't exist (beyond both the last chip measure and 9) is **never applied and is lost on save**.
  - Bar lengths below 1/192 give H=0.
- The bar-length dialog allows min 0.001, step 0.05, DecimalPlaces 3, and the default max (`CChangeMeasureLengthDialog.Designer.cs:44-61`).
- `CMeasure.n位置変換count2grid` / `grid2count` (58-69) convert using **384 counts per measure**, the NX tick.

### 2.7 BPM (198-228)
- **ch 08**: `f値 = dicBPx[n値]`. An undefined key leaves `f値` at 0.
- **ch 03**, which loaded as the BPM lane's 裏 chip:
  - It is converted to **ch 08** with `f値 = hex value` and `b裏=false`.
  - It is given the **first free key j in 1..1295**, and `dicBPx.Add(j, value)` is called.
  - There is no deduplication: every ch 03 chip consumes a new `#BPMzz`.
  - So DTXCreator never writes ch 03 again (INFERRED; the hex branch at 2863-2866 is dead in practice).
  - NX semantics are preserved: ch 03 is `BASEBPM + v`, and ch 08 with zz≠0 is also `BASEBPM + v` (CDTX.cs:3799, 3830).
- **Placing a BPM chip in the editor** (`CEditModeManager.cs:250-278`): a dialog takes a value 0.0001..1000. An existing `dicBPx` entry with an equal float is reused; otherwise the first free key 1..1295 is taken. The chip always goes on the 表 channel 08.

### 2.8 What a DTXCreator load and save round trip loses or changes (summary)
1. Lines not starting with `#`; trailing comments on header, chip, ch02, `#BPMzz`, `#VOLUME` and `#PAN` lines; the last line if it is unterminated (2.2).
2. `#IF`/`#RANDOM` semantics (2.4). Infinite (re)definitions of `#WAVzz` and similar collapse to the last one.
3. Positions are re-quantised to the `(int)(192·f)` grid (2.6). Two same-channel chips on the same grid **collapse into one** on save (2838). Multiple `#MMMCC` lines for the same measure and channel are legal and additive in NX (CDTX.cs:6939) but are merged.
4. ch 03 becomes ch 08 plus new `#BPMzz` (2.7).
5. Unknown commands and unmapped channels are moved into the header free-text block (2.4).
6. `#VOLUMEzz`/`#PANzz` without a filename-bearing `#WAVzz` are dropped (2654). A guitar/bass position without both a WAV chip and a fret chip is dropped (2917-2924).
7. Duplicate `#BPMzz` or duplicate `#MMM02` make the load throw (INFERRED).
8. Chip palette: the rebuild loop is `for (i=0; i<Count/2; i+=2)` and indexes `[i*2]`, so **only pairs 0, 2, 4… of the first half are restored** (310-313). This is a bug.
9. Color lines: the writer emits the 1-based number `i` (2689, 2693, 2631, 2635, 2581, 2585). The reader applies the color to `nChipNo + 1` (539, 566, 593, 620, 703, 730). **Every round trip shifts colors by +1.** This is a bug.
10. Characters outside CP932 are lost (3.1).

## 3. DTXCreator: save

### 3.1 File write (CMainForm.cs:871-952)
- **First save** (888-907): if the chart has no file name yet, a save dialog asks for one (filter `DTXファイル(*.dtx)|*.dtx`, 999-1004). All WAV/BMP/AVI paths are then made relative to the folder.
- **Write** (924-926):
  ```csharp
  var sw = new StreamWriter( this.str作業フォルダ名 + this.strDTXファイル名, false, Encoding.GetEncoding( 932/*Shift-JIS*/ ) );
  new CDTXInputOutput( this ).tDTX出力( sw );
  sw.Close();
  ```
- **Encoding:** CP932, no BOM (CP932 has no preamble). INFERRED (.NET): unmappable characters get the framework's best-fit or `?` replacement.
- **Newline:** `StreamWriter.WriteLine` uses `Environment.NewLine`, i.e. **CRLF** (INFERRED, .NET default).
- **No other encoding is written anywhere** in DTXCreator, FDK or NX (grep for `Encoding.`). There is no UTF-16 output in this codebase.
- **Numbers use the current culture.** INFERRED: on a comma-decimal Windows locale, the saved file contains `0,75` and `145,5`. Only the viewer temp file switches to en-GB (3.10).
- Version string `Resources.DTXC_VERSION` = **`NX 1.4.2`** (`Resources.resx:127-129`).

### 3.2 Exact output order (tDTX出力, 28-45)

| # | Writer | Output |
|---|---|---|
| 1 | 30 | `; Created by DTXCreator NX 1.4.2` |
| 2 | 2698-2765 | blank line, then the header lines (3.3) |
| 3 | 2787-2796 | blank line; if the free text is non-empty: another blank line, the text verbatim, then a newline |
| 4 | 2648-2677 | blank line; for zz = 1..1295, if the WAV has a filename (and is a BGM WAV when only BGM is requested): `#WAVzz: file` (+`\t;label`), `#VOLUMEzz: n` if ≠100, `#PANzz: n` if ≠0, `#BGMWAV: zz` if BGM |
| 5 | 2590-2619 | blank line; `#BMPzz: file` or `#BMPTEXzz: file` (+`\t;label`) |
| 6 | 2552-2569 | blank line; `#AVIzz: file` (+`\t;label`) |
| 7 | 2797-2810 | blank line; bar lengths (3.6) |
| 8 | 2640-2647 | blank line; `#BPMzz: f` for each `dicBPx` entry in Dictionary (insertion) order, including unused entries. Format `"{1}"` of a float. |
| 9 | 2811-3297 | blank line; chip lines (3.8) |
| 10 | 39 | blank line |
| 11 | 2775-2786 | blank line; `#DTXC_LANEBINDEDCHIP` lines |
| 12 | 2678-2697, 2620-2639, 2570-2589 | `#DTXC_WAVFORECOLOR`/`BACKCOLOR`, then BMP, then AVI colors (no blank lines) |
| 13 | 2766-2774 | `#DTXC_CHIPPALETTE: ` plus `" {img},{zz}"` per palette item. **Always written**, even when empty, so it is the last line. |

Example output for a new chart, traced by hand (INFERRED). Setup: WAV01 `snare.wav` labelled `SD`; BPM chip 150 at measure 1, grid 0; SD chips at grid 48 and 144 of measure 1; measure 2 bar length 0.75; play-speed combo at index 5:
```
; Created by DTXCreator NX 1.4.2

#TITLE: (no title)
#BPM: 120
#DLEVEL: 50


#WAV01: snare.wav	;SD



#00202: 0.75
#00302: 1

#BPM01: 150

#00108: 01
#00112: 00010001


#DTXC_CHIPPALETTE: 
```

### 3.3 Header (2698-2765)
- `#TITLE: text`, or **`#TITLE: (no title)`** when the title is empty.
- Written only when non-empty: `#ARTIST`, `#COMMENT`, `#PANEL`, `#PREVIEW`, `#PREIMAGE`, `#STAGEFILE`, `#BACKGROUND`, `#RESULTIMAGE`.
- `#BPM: <decimal>` if ≠0.
- `#DLEVEL`, `#GLEVEL`, `#BLEVEL` if ≠0.
- `#PATH_WAV: ` only when `strPATH_WAV` is non-empty, which happens only during the viewer export (`CMainForm.cs:1726, 1755`).
- `#DTXVPLAYSPEED: (1.5f − idx*0.1f)` if the combo index ≠5.
- All lines use the form `#CMD: value` (colon + one space).

### 3.4 Free text
Written verbatim with `sw.Write` (2793). Lines appended at load already end in CRLF, so this block usually ends with an extra blank line (INFERRED).

### 3.5 Measure numbering
Every chip and ch02 line uses `strConvertNumberTo3DigitMeasureNumber`: base-36 first char, then 2 decimal digits, uppercase. Channels are 2-digit uppercase hex. INFERRED: measures are written in `dic小節` enumeration order, which can stop being ascending after measure insert or delete operations (Remove+Add, `ScoreManager.cs:507-567`); NX does not care about order.

### 3.6 Bar length (2797-2810)
Walking measures 0..Count−1 with `prev = 1f`, the writer emits `#MMM02: <float>` **only when the value changes**. A return to 1 is therefore written explicitly (`#00302: 1`). This matches the "persists until the next ch02" rule used by both the loader and NX.

### 3.7 BPM changes
BPM changes are always ch 08 chips (value = key) plus the `#BPMzz` table (row 8). `#BPM` (the base) comes from the numeric box. Nothing writes `#BPM00`. ch 03 is never written (2.7).

### 3.8 Chip lines and per-line resolution (2811-3315)
For each measure (H = `(int)(192·f)`):
1. **Regular channels.** The distinct nonzero `nチャンネル番号` values are collected in order of first appearance in the sorted chip list (2817-2828); channel 0 means guitar/bass and is skipped. For each channel:
   - `arr[pos] = value`, so the last chip at a position wins (2834-2839);
   - nothing is written if every value is 0 (2841-2846);
   - **resolution reduction** (2848-2859, 3298-3315): `res = H`. For each prime p in `arr素数リスト` (2..383, 144-150): while `res % p == 0` and every occupied slot index is a multiple of p, do `res /= p` and compact `arr[k] = arr[k*p]`. Net effect: `res = H / gcd(H, all occupied positions)`, which reduces to 1 when the only chip is at 0 (INFERRED).
   - Each slot is written as 2 base-36 digits, or 2 hex digits for ch 03 (2863-2870).
   - Line format: `#MMMCC: data` (2872).
2. **Guitar** (2876-3085). Per grid position:
   - col0 = GtV value; col1 = bitmask with **B=0x01, G=0x02, R=0x04, Y=0x10, P=0x20, OPEN (GtR value 2) = 0xFF**.
   - Positions missing either column are cleared.
   - Both columns are reduced together with the same prime rule.
   - One line is written per distinct mask; slots belonging to other masks are written as `00`.
   - Mask → channel: 0xFF→0x20; 1..7→0x21..0x27; 16..23→0x93..0x9A; 32..36→0x9B..0x9F; 37..39→0xA9..0xAB; 48..51→0xAC..0xAF; 52..55→0xD0..0xD3 (2981-3081).
3. **Bass** (3086-3295) works the same way on base 0xA0:
   - 1..7→0xA1..0xA7; 16, 17→0xC5, 0xC6; 18..23→0xC8..0xCD; 32, 33→0xCE, 0xCF; 34..39→0xDA..0xDF; 48..55→0xE1..0xE8.
   - These mappings are exact inverses of the load tables (2.5).

### 3.9 `#DTXC_*` editor-only metadata (all ignored by NX, 4.6)

| Line | Meaning | Write / read |
|---|---|---|
| `#DTXC_LANEBINDEDCHIP: LL FF BB` | Per-lane default chip number: the 表 value is used on a plain click, the 裏 value on Ctrl+click; Shift+click uses the selected WAV/BMP/AVI row instead (`CEditModeManager.cs:178-189, 237-243`). `LL` = `listレーン` index as `"00"` decimal (table in 2.5; INFERRED: version-specific). `FF`/`BB` = base-36 (`00` = none). | Write 2775-2786 (only if either value >0). Read 646-679: parameter length must be exactly 8. |
| `#DTXC_WAVFORECOLOR: n #RRGGBB` / `WAVBACKCOLOR`, plus `BMP*`, `AVI*` variants | ListView text and background colors. `ColorTranslator.ToHtml` is used; a line is written only when the color differs from `windowtext` (fore) or `window` (back). | Write 2678-2697, 2620-2639, 2570-2589. Read 516-733 (off by one, 2.8 #9). |
| `#DTXC_CHIPPALETTE: t,zz t,zz …` | Chip-palette entries; t = 0 WAV, 1 BMP, 2 AVI. | Write 2766-2774 (always; double space after the colon). Read 624-645 / 308-367 (lossy, 2.8 #8). |

`#BGMWAV: zz` (DTXCreator's "use as BGM" flag) is also ignored by NX (grep finds no parser).

### 3.10 Viewer temp file (MakeTempDTX.cs; CMainForm.cs:1706-1761)
- **File name:** `Path.GetTempFileName()`, i.e. `%TEMP%\tmpXXXX.tmp` (MakeTempDTX.cs:33-40). The previous temp file is deleted when a new one is made (37, 47-62) and again on `Dispose` (67-71).
- **Reuse:** the existing file is reused when nothing changed (CMainForm.cs:1712). `tViewer用の一時ファイルを削除する` only forgets the name, it does not delete the file (1758-1761).
- **Content:** written with the same `tDTX出力`, but:
  - `strPATH_WAV` is set to the working folder, so `#PATH_WAV:` is emitted (1726);
  - the culture is switched to en-GB when the decimal separator is `,` ("DTXVはピリオドしか使えないため", 1730-1737);
  - the encoding is `Encoding.GetEncoding(0x3a4)` = 932 (1741);
  - for the "BGM only" mode, only BGM-flagged WAVs are written (1637).
- **Launch:** DTXManiaGR or DTXV is started with option strings plus the quoted temp path. "Play from here" passes `PlayStartFromOption + <DTXCreator measure number>` (1565-1567, 1655-1658).

## 4. DTXMania NX: reading DTX text (CDTX.cs)

### 4.1 Encoding decision
There is exactly one DTX reader, used by the song list, song loading and DTXV mode (`CSongManager.cs:885`, `CStageSongLoading.cs:209, 440, 595` all go through `CDTX.tRead`). Exact code (CDTX.cs:3437-3452):
```csharp
try
{
    StreamReader reader = new StreamReader( strファイル名, Encoding.GetEncoding( "shift-jis" ) );
    string str2 = reader.ReadToEnd();
    reader.Close();
    this.tRead_FromString( str2, db再生速度, nBGMAdjust );
}
catch
{
}
```
- There is no explicit BOM sniffing and no header that declares an encoding.
- INFERRED (.NET Framework `StreamReader(string, Encoding)` → `detectEncodingFromByteOrderMarks: true`; the same conclusion is in `docs/spec/dtx-audio.md:42`):
  - A leading **UTF-8 BOM `EF BB BF`**, **UTF-16LE `FF FE`**, **UTF-16BE `FE FF`** or a UTF-32 BOM overrides Shift-JIS. The BOM is consumed, so line 1 still starts with `#` or `;`.
  - Without a BOM, the file is decoded as CP932. A UTF-8 file without a BOM keeps its ASCII structure, but non-ASCII titles and `#WAV` paths become mojibake, so sounds whose paths contain non-ASCII are not found.
- Any exception during read or parse is swallowed and the chart stays empty (3450-3452).
- What a browser-written file can safely use:
  - **Shift-JIS**, written with a hand-made encoder;
  - **UTF-8 with BOM** (`TextEncoder` output prefixed with `EF BB BF`);
  - UTF-16LE with BOM.
  - UTF-8 without BOM is safe only for pure-ASCII files.

### 4.2 Tokenizer (3470-3535, 4595-4716)
Same character-level grammar as DTXCreator (2.2), with these differences:
- `"\r\n"` → `"\n"`, tab → space, and **`+ "\n"` is appended** (3472-3474), so an unterminated last line is still parsed.
- The line counter exists only for error traces.
- Parameters are `.Trim()`ed (4720).
- Commands are matched with **`StartsWith`** (case-insensitive) in a fixed order (4727-5163). Glued parameters are split off by `t入力_パラメータ食い込みチェック` (4663-4670), e.g. `#TITLEfoo`.

### 4.3 Header dispatch, order-sensitive constructs
- **`#IF`** (4727-4748): pushes `skip = (param != 現在の乱数)`; a non-integer param counts as 1. If the parent block is skipped, the child is skipped too. Nesting is limited to 255.
- **`#ENDIF`** (4753-4765) pops.
- Every other command is ignored while `Peek()` is true (4769).
- **`#RANDOM n`** (5001-5013): `乱数 = Random.Next(n)+1`.
- Header-only mode (song list) stops before `PANEL`, `WAV` and chip parsing (5056). BPM is parsed in both modes (5024-5029).
- Prefixes tested before the chip parser, in order: `IF`, `ENDIF`, `PATH_WAV`, `PATH`, `TITLE`, `ARTIST`, `COMMENT`, `DLEVEL`/`PLAYLEVEL`, `GLEVEL`, `BLEVEL`, `DLVDEC`/`GLVDEC`/`BLVDEC`, `GENRE`, `HIDDENLEVEL`, `STAGEFILE`, `PREVIEW`, `PREIMAGE`, `PREMOVIE`, `BACKGROUND_GR`, `BACKGROUND`/`WALL`, `RANDOM`, `SOUND_NOWLOADING`, `BPM`, `FORCINGXG`, `VOL7FTO64`, `DTXVPLAYSPEED`, then `PANEL`, `MIDIFILE`, `MIDINOTE`, `BLACKCOLORKEY`, `BASEBPM`, `SOUND_*`, `WAVVOL`/`VOLUME`, `WAVPAN`/`PAN`, `WAV`, `BMPTEX`, `BMP`, `BGAPAN`, `BGA`, `AVIPAN`, `AVI`/`VIDEO`, `RESULTIMAGE`/`MOVIE`/`SOUND`, `SIZE` (4771-5160).
- **Pitfall:** any custom command that begins with one of these prefixes is misparsed; for example `#IFOO` is treated as an `#IF`.

### 4.4 Infinite definitions (6401-6575, 5986-6075)
- `#WAVzz`, `#VOLUMEzz`, `#PANzz` and `#BPMzz` may be redefined.
- A chip binds to the definition **most recently seen when the chip line is parsed**. Chips that appear before the first definition are back-filled when it arrives (6448-6458, 6059-6070).
- So **line order matters**. DTXCreator's "all definitions before all chips" layout (3.2) is the safe form.
- `#BPM` and `#BPM00` are the same thing: they set `this.BPM` and BPM entry zz=0 (6005-6012, 6042-6043).
- BPM values must be **> 0** (6037-6038), parsed with the comma-tolerant `TryParse` (6951-6993):
  - the **last** `.` or `,` is the decimal point; other `.`, `,`, `'` and spaces are group separators;
  - scanning stops at any other character, so no sign and no exponent.

### 4.5 Chip lines (6613-6942) and timing
- **Command:** exactly 5 chars (6617); 3-char measure (6622); hex channel (6659).
- **`n小節番号++` "先頭に空の1小節を設ける"** (6626): file measure m lands at ticks `(m+1)*384`.
- **ch 02** (6783-6806): one chip at `(m+1)*384` with `db実数値 = TryParse(param)`. An unparsable value drops the line with a TraceError.
- **Data string:**
  - empty → ignored (6813);
  - `_` is skipped;
  - **any non-base-36 character (including a space) drops the whole line** (6824-6834);
  - an odd count drops the last char (6842-6843).
- **Positions:** `pos = (m+1)*384 + 384*i/N`, truncated (6877); `00` slots are skipped (6867); ch 03 is hex, all others base-36 (6856-6865).
- **Fill-in ch 53:** value 1 is moved −32 ticks, value 2 +32 ticks (6917-6933).
- Lines are additive; duplicate measure+channel lines all contribute (6939).
- **Lead-in:**
  - A BPMEx chip is inserted at tick 0, using `#BPM`, or 120 if the file has no `#BPM` (3553-3586).
  - INFERRED: the empty lead-in measure therefore always lasts `240000/#BPM` ms at bar length 1.0, because a `#00002` lands at tick 384, not 0.
- **Time** (3758-3833, 6586-6598): `ms += 625 * Δtick * barLength / bpm`, with mode 0 flooring.
  - **Bar length persists** for DTX; only BMS/BME reset it each measure (3683-3694, 3775-3781).
  - ch 03: `bpm = BASEBPM + v` (3799).
  - ch 08: `bpm = (zz==0 ? 0 : BASEBPM) + #BPMzz` (3823-3833). An undefined zz leaves the BPM unchanged.
- **Bar lines** are generated every 384 ticks up to `nEndOfSong`, which is the last chip rounded up to the next measure. Beat lines are placed at `384*i/(4*barLength)` plus the C1 shift; C2 = 1 or 2 shows or hides them (3651-3754).
- Measure range: 0..3599 (Z99) in the file, set by the codec (§1).

### 4.6 Lines NX ignores
- `#DTXC_*`, `#BGMWAV` and anything else unmatched fall through to `tInput_LineAnalysis_ChipLocation`. The length≠5 check returns false and the line is dropped silently.
- `;` comment lines and the `; Created by…` line are skipped by the tokenizer.

## 5. What an edited file must respect for NX (checklist)
- Encoding: Shift-JIS, or a BOM-marked Unicode encoding (4.1).
- Lines end in CRLF or LF; the file ends with a newline (DTXCreator needs it, 2.2).
- Header lines use `#CMD: value`. Chip lines use `#MMMCC: data` with:
  - a 3-char measure: base-36 first char, then 2 decimal digits;
  - an uppercase 2-digit hex channel;
  - base-36 pairs (hex for ch 03);
  - no spaces inside the data.
- Measures 0..3599. File measure 000 is played after the automatic 4/4 lead-in at `#BPM`.
- Decimals use `.`, with no exponent and no sign.
- ch 02 lasts until the next ch 02, so write `1` to reset.
- `#BPMzz` > 0, and zz ≠ 00 for chips.
- All `#WAV`/`#VOLUME`/`#PAN`/`#BPMzz` definitions come before the chip lines that use them (or are written once each, without redefinition).
- `#IF`/`#RANDOM` blocks stay in their original order and position.

---

## Key facts
- DTXCreator (NX 1.4.2) **reads and writes Shift-JIS (CP932) only**: `CMainForm.cs:820, 924, 1741`. Its reader also accepts BOM-marked Unicode because of the StreamReader default (INFERRED). It writes **no BOM, CRLF** line endings, and starts every file with `; Created by DTXCreator NX 1.4.2` (`CDTXInputOutput.cs:30`, `Resources.resx:128`).
- NX reads every DTX with `new StreamReader(path, Encoding.GetEncoding("shift-jis"))` (`CDTX.cs:3442`). INFERRED: a BOM (UTF-8, UTF-16LE/BE, UTF-32) overrides that; without a BOM the file is decoded as CP932.
- DTXCreator's internal grid is `(int)(192 × bar length)` per measure (`CMeasure.cs:11-33`). Loaded positions are `i*H/N`, truncated (`CDTXInputOutput.cs:2540`). This is lossy for 5-, 7- and 384-based resolutions and for odd bar lengths.
- NX's grid is 384 ticks per measure regardless of bar length, with `pos = (m+1)*384 + 384*i/N` and a **one-measure lead-in** (`CDTX.cs:6626, 6877`).
- DTXCreator saves each line at `res = H/gcd(H, occupied positions)` (prime-by-prime reduction, 2848-2859). The channel order inside a measure follows first chip appearance; guitar and bass lines come last.
- BPM: `#BPM: base` plus ch 08 chips and a `#BPMzz` table (written before the chips). ch 03 is converted to ch 08 plus a new `#BPMzz` on load and never written back (198-228).
- Bar length: `#MMM02` is written only when the value changes from the previous measure, including the return to 1. Both DTXCreator and NX treat ch 02 as persistent (2526-2537, 2804-2807; `CDTX.cs:3683-3694`).
- DTXCreator does not understand `#RANDOM`/`#IF`, does not keep comments or blank lines, and moves unknown commands and unmapped channels into a header-area free-text block (95-100, 112, 2225-2234).
- Editor-only lines: `#DTXC_LANEBINDEDCHIP`, `#DTXC_{WAV,BMP,AVI}{FORE,BACK}COLOR`, `#DTXC_CHIPPALETTE` (always written), `#BGMWAV`. NX ignores all of them. DTXCreator itself mis-round-trips the colors (+1) and the palette (every other entry).
- DTXCreator crashes (INFERRED) on a duplicate `#BPMzz` or a duplicate `#MMM02`. It silently loses a final line without a newline and any ch02 for a measure that doesn't exist.

## Open questions and porting notes for the browser editor
1. **Encoding to write.** Use Shift-JIS when every character is representable, otherwise UTF-8 with BOM. `js/core/encoding.js:139-170` `encodeText` already does this, and NX accepts both (4.1). Never write UTF-8 without a BOM for non-ASCII content. Keep line 1 a `;` comment, as DTXCreator does: tools that don't detect a BOM (vid2dtx's `dtx.py`, `docs/spec/dtx-audio.md:436`) then lose only that comment.
2. **UTF-16LE claim to settle.** `encoding.js:2` says "DTXCreator 031 以降は UTF-16 LE(BOM 付き)". This NX DTXCreator never does that. The claim may refer to the original non-NX DTXCreator; it can't be checked from this repo. Reading UTF-16 BOM files is still right.
3. **Newlines and decimals.** Write CRLF and always end with a newline. Write decimals with `.`, a fixed number of digits, and no exponent (avoid JS `String(1e-7)`-style output). The reader should match NX's `TryParse`, where the last `.` or `,` is the decimal point. `js/core/dtx.js:170-177` replaces only the first `,`, so it parses `1.234,5` differently from NX. Minor.
4. **Don't copy DTXCreator's 192-grid model.** Keep 384 ticks (the existing parser, `js/core/dtx.js:3, 18, 386`), or store each chip as an exact fraction (i/N per measure), so unedited chips round-trip losslessly. Serialise each measure+channel at `N/gcd`. If two chips of the same channel share a tick, emit a second `#MMMCC` line instead of dropping one (NX adds them up).
5. **Preserve what we don't understand, in place.** That means unknown commands, unmapped channels (hidden chips 31-3C, B1-BE, 50/51/C1/C2…), comments, and especially `#IF`/`#RANDOM` blocks. Doing better than DTXCreator's free-text dump is easy if the editor keeps the original line list and rewrites only the chip lines of the drum channels it edits. Decision needed: allow editing at all inside `#IF` blocks, or make such charts read-only?
6. **Order.** Keep definitions (`#WAV`, `#VOLUME`, `#PAN`, `#BPMzz`) ahead of the chip lines that use them (4.4). Don't reorder redefinitions.
7. **BPM changes.** Write ch 08 with `#BPMzz`, reusing a zz with an equal value (as `CEditModeManager.cs:262-278` does), with zz ≥ 01 and value > 0. Decision needed: keep original ch 03 chips as ch 03 (round-trips exactly under BASEBPM) or convert like DTXCreator.
8. **Bar length.** Store the resolved bar length per measure. Emit `#MMM02` on every change, including returns to 1. Snap and beat guides should follow NX's `384*i/(4*barLength)`.
9. **Measure numbers.** Validate 0..3599 before formatting; the FDK formatter silently returns `"000"` (`CConversion.cs:149-150`). Insert and delete measure operations must also renumber our preserved unknown chip lines, which DTXCreator does not do.
10. **`#DTXC_*` lines.** Pass them through untouched rather than generating them. `LANEBINDEDCHIP` lane indices are specific to DTXCreator's lane table (2.5).
11. **Our own metadata.** Either a `;` comment (DTXCreator drops it) or a `#`-command whose name avoids every NX `StartsWith` prefix (4.3); for example `#DTXMANIAWEB_…` survives DTXCreator (moved into its free text) and is ignored by NX. Avoid anything starting with `IF`, `PATH`, `BPM`, `WAV`, `PAN`, `VOLUME`, `BMP`, `BGA`, `AVI`, `SIZE` and the like.
12. **Preview.** The web player already mirrors NX's lead-in and 384-tick model. A preview of edited data can re-parse in memory, so no MakeTempDTX-style temp file is needed. Fill-in ch 53 is shifted ±32 ticks by NX (`CDTX.cs:6917-6933`), so the editor should show its file position, not the shifted one.
13. **Writer output must also satisfy the stricter NX checks.** The web parser strips spaces and tabs inside data (`js/core/dtx.js:382`), but NX drops the whole line (`CDTX.cs:6830-6834`). Never emit spaces in data, and use exactly 5-char chip commands.
14. **Not verified:** how .NET's CP932 encoder replaces unmappable characters on DTXCreator save; whether DTXCreator writes `#BPM: 145.50` (trailing zeros kept from the decimal); how NX treats file-supplied ch 50/51 chips alongside the bar and beat lines it generates itself.
