# training-state

# TRAINING MODE — merged & corrected behavioral spec (`PerformanceStage.cs` + `SongClock.cs`, `GameTimer.cs`, `Counter.cs`, `TrainingSettings.cs`, `TrainingMenu.cs`, `SoundManager.cs`, `docs/19_training-mode.md`)

All paths under `DTXManiaAI\Assets\Scripts\`. Abbreviations: `PS` = `Stages/PerformanceStage.cs`, `TM` = `Stages/TrainingMenu.cs`, `TS` = `Core/TrainingSettings.cs`, `SC` = `Core/SongClock.cs`, `SM` = `Audio/SoundManager.cs`, `IM` = `Input/InputManager.cs`, `CT` = `Core/Counter.cs`, `HR` = `Core/HitRanges.cs`, `DG` = `Core/DrumGroups.cs`, `CI` = `Config/ConfigIni.cs`.

Critic notes (what was missing/wrong in the original) are marked **[ADDED]** / **[CORRECTED]** inline. Everything from the original that was verified is kept.

---

## 0. Clocks and time bases

### GameTimer (`Core/GameTimer.cs:8-20`)
- `NowMs = Stopwatch.ElapsedMilliseconds` since app start; real wall time; never pauses. `Unused = -1`.

### SongClock (`SC:15-69`)
```
state: _wallBaseMs (long), _wallAccumMs (long), _songOffsetMs (int), _paused (bool)
ctor(timer): _wallBaseMs = timer.NowMs                                                   // SC:23-27
WallMs  = paused ? _wallAccumMs : _wallAccumMs + (timer.NowMs - _wallBaseMs)            // SC:30-33
SongMs  = (int)(WallMs + _songOffsetMs)                                                  // SC:36
Pause() : if !paused { _wallAccumMs += NowMs - _wallBaseMs; paused = true }             // SC:41-47
Resume(): if paused  { _wallBaseMs = NowMs; paused = false }                             // SC:50-56
JumpTo(songMs): _songOffsetMs = songMs - (int)WallMs                                     // SC:59-62 (WallMs unaffected)
ScaleSongTime(f): JumpTo((int)(SongMs * f))                                              // SC:65-68 — NOT used by the training path (ChangePlaySpeed uses JumpInSong)
```
- Clock always runs at real time 1x; play speed is implemented by scaling chart times (SC header comment lines 12-13).
- `WallMs` is the "effect clock" (lane flush, pad bounce, chip fire, combo jump, status-text timeout, hi-speed ramp, chip pattern frame). It freezes on `Pause()` and is unaffected by `JumpTo`.

### PerformanceStage time helpers
- `LeadInMs = 0` (`PS:44`, constant). Everywhere `songMs = _clock.SongMs - LeadInMs` (`PS:794, 840, 851, 868, 906`) ⇒ **songMs == _clock.SongMs exactly**. In standby `songMs = _trainStartMs - LeadInMs = _trainStartMs` (`PS:851`).
- `Now` = `_clock.WallMs` (falls back to `_g.Timer.NowMs` while `_clock == null`) (`PS:735`).
- `PlaySpeedRatio = _playSpeed / 20f` (`PS:732`).
- `S = NxPerfLayout.S = 1.5` (720p→1080p), `JudgeLineYDefault = 561*S = 841.5`, `BasePixelsPerMs = 0.45*S = 0.675 px/ms` at hi-speed x1.0 (`PS:40-43`; `Stages/NxPerfLayout.cs:17-22`). Lane panel default center `_barLineCenterX = (295 + 558/2)*S`, width `_barLineW = 558*S` (`PS:93-94`).

**[ADDED] Two independent decay clocks in Render**: lane-flash alpha (`_laneFlash[i] -= Time.deltaTime`, `PS:3200`) and the judge text (`_judgeDisplay -= Time.deltaTime`, `PS:3268`) use Unity frame delta, NOT WallMs. So while PAUSED they keep decaying, whereas all NX effects (flush/pad/chip fire/combo jump) freeze because they compare against `Now` (WallMs).

---

## 1. State variables (`PS:124-150`)

| field | meaning |
|---|---|
| `_training` (bool) | NX `bIsTrainingMode` "this play is not recorded". `= _trainingMode` on enter (`PS:619`); always true in training mode. |
| `_playSpeed` (int, 5..40, default 20) | NX `nPlaySpeed`; ratio = value/20. |
| `_loopBeginMs`, `_loopEndMs` (int, -1 = unset) | *active* loop points used by turnaround & loop-line drawing; re-derived every frame from `_train` (§4 ApplyTrainingSettings). |
| `_trainingMode` (bool) | copy of `GameMain.TrainingMode` (F4 in song select). |
| `_train` (TrainingSettings) | persisted training settings (`Config.Training`; `new TrainingSettings()` if Config null, `PS:589`). |
| `_trainMenu` (TrainingMenu) | right-side menu. |
| `_trainStandby` (bool) | true in STANDBY and START-IN; song time pinned to `_trainStartMs` every frame. |
| `_trainWaiting` (bool) | true only in START-IN (countdown); meaningful only when `_trainStandby`. |
| `_trainStartMs` (int) | song ms pinned during standby/wait (0 or loop begin, or current pos at loop turnaround). |
| `_trainWaitUntilMs` (long) | `GameTimer.NowMs` deadline for START-IN (real time, unaffected by SongClock pause). |
| `_noteDrawOffsetMs` (int) | "ノーツ表示調整": shifts drawing only. |
| `_judgeOffsetMs` (int) | "判定タイミング調整": shifts judgement only. |
| `_scrollSpeedSetting` (int) | hi-speed raw setting (display ratio = value×0.5). |
| `_statusText`, `_statusUntilMs` | ShowStatus text and WallMs expiry (`PS:131-132`). |

Logical states:
```
STANDBY  : _trainStandby && !_trainWaiting
START-IN : _trainStandby &&  _trainWaiting
PLAYING  : !_trainStandby && !_clock.IsPaused
PAUSED   : !_trainStandby &&  _clock.IsPaused
```
`TrainingStateText()` (`PS:1668-1677`):
```
if _trainStandby:
    if _trainWaiting: return string.Format("START IN {0:0.0}", Mathf.Max(0f, (_trainWaitUntilMs - Timer.NowMs) / 1000f))   // "START IN 1.0", "START IN 0.3", "START IN 0.0"; .NET "0.0" rounds half away from zero
    return "STANDBY"
return _clock.IsPaused ? "PAUSED" : "PLAYING"
```
Displayed in the menu's state line (font 24, color (1,0.85,0.4)) (`TM:202-204, 409-410`).

---

## 2. Entering the stage in training mode (`OnEnter`, `PS:549-729`)

1. `_nx = Skin.UseNxLayout` (`PS:553`). Normal config load (`PS:557-585`): `_auto=Config.AutoPlay`, `_judgeOffsetMs=Config.JudgeOffsetMs`, dark/hidsud/reverse, `_ranges=Config.DrumHitRanges`, `_pedalRanges=Config.DrumPedalHitRanges`, `_playSpeed=Config.PlaySpeed`, `_autoAddGage`, risky, `_laneAuto[i]=Config.AutoLanes[i]`, `_velocityMin[i]=Config.VelocityMinFor(i)`, `_lbdAuto`.
2. **Overridden when `_trainingMode`** (`PS:588-605`):
   ```
   _trainingMode = _g.TrainingMode; _train = Config.Training
   if _trainingMode:
       _auto = _train.AutoPlay; _judgeOffsetMs = _train.JudgeOffsetMs; _noteDrawOffsetMs = _train.NoteOffsetMs
       _scrollSpeedSetting = _train.ScrollSpeed; _playSpeed = _train.PlaySpeed
       _laneAuto[0..9] = _train.AutoLanes[0..9]; _lbdAuto = _train.AutoLanes[10]
   else: _noteDrawOffsetMs = 0; _scrollSpeedSetting = Config.ScrollSpeed (2 if no config)
   ```
   Not overridden (still from Config): `_ranges/_pedalRanges`, `_dark`, `_hidSud`, `_reverse`, `_autoAddGage`, risky, `_velocityMin`, groups (`_hhGroup` etc. `PS:676-680`), `Config.BgmSound/ChipVolume/AutoChipVolume/Metronome/FillInEffect/AudienceSound/DamageLevel/StageFailedEnabled`.
3. `_trainStandby=false; _trainWaiting=false; _trainStartMs=0` (`PS:606-608`).
4. `_searchWindowMs = max(_ranges.SearchWindowMs, _pedalRanges.SearchWindowMs)` (`PS:610`); `_allLanesAuto` computed; hi-speed ramp starts AT target (`_scrollCurrentRaw = _scrollSpeedSetting - 1`, `_scrollRampTimerMs = -1`) (`PS:611-617`).
5. `_training = _trainingMode; _loopBeginMs = _loopEndMs = -1; _bgmAdjustMs = 0; _inFillIn=_chorusSection=false; all event indices = 0; _gtLastVoice=_bsLastVoice=-1; _cheerClip=null; clear _countsIncAuto` (`PS:619-629`).
6. Chart from preload or parse; optional `MergeRideIntoCymbal`; `_judged = new bool[Notes.Count]; _hiddenJudged = new bool[HiddenNotes.Count]`; `_sectionMiss = new bool[60]` (`ScoreRecord.ProgressSections = 60`); `_playedMaxMs=0; _autoUsed=_auto; _failSoundPlayed=false; _comboBombActive=false;` clear `_comboBombFired/_comboHundredReached` (`PS:642-656`).
7. **If `_playSpeed != 20`: `ScaleChartTimes(20.0 / _playSpeed)`** (`PS:699-700`) — chart pre-scaled once (see §6). E.g. `_train.PlaySpeed=40` ⇒ all chart times ×0.5.
8. `BuildUI()`; training ⇒ `DiscardPreparedMovie()` (movie disposed, never played) else `SetupMovie()` (`PS:702-706`). (`SongLoadingStage.cs:298-299` also skips movie preparation when `TrainingMode`.)
9. `_clock = new SongClock(_g.Timer)`; `Sound.SetChipPitch(PlaySpeedRatio)` (`PS:707-708`).
10. training ⇒ `SetupTraining()` (`PS:709-710`).
11. NX start fade (black curtain) NOT shown in training (`PS:714`).

### `SetupTraining()` (`PS:1480-1493`)
```
_train.LoopBeginMs = 0
_train.LoopEndMs   = Mathf.Max(0, _chart.DurationMs)   // DurationMs is already scaled when PlaySpeed != 20
_trainMenu = new TrainingMenu(_g, _train); _trainMenu.SetChart(_chart); _trainMenu.PlaySpeedStep = TrainingPlaySpeedStep; _trainMenu.Build(_root)
HideForTraining()
EnterStandby(resetStats: true)
```
### `HideForTraining()` (`PS:1496-1503`)
Deactivates: RectTransform named `movie_frame`, `_movieRaw`, `_smallMovieRaw`, `_infoText` (the debug info line; it is still assigned text every frame but invisible). Also: skill "now" bar hidden (`_skillBarNow.enabled = !_trainingMode`, `PS:5284`); best-record section lamps not loaded (`PS:4822, 5646`).

---

## 3. Per-frame flow in training mode (`OnUpdate`, `PS:788-938`)

```
OnUpdate():
  if !IsActivated: return 0
  UpdateScrollSpeed()                       // PS:793 (§10.6) — uses WallMs; runs in standby, frozen while paused
  songMs = _clock.SongMs                    // PS:794 (in standby this is _trainStartMs + ms elapsed since last pin, i.e. ≈ +1 frame)
  if _state != Playing: ...                 // PS:797-824 — never in training (Clearing replaced by EnterStandby, Failing gated off)

  // ---- training branch (PS:826-861) ----
  if Pressed(F1) && !ShiftHeld: _train.AutoPlay = !_train.AutoPlay     // PS:830-831 (no sound; applied below)
  quit = UpdateTrainingMenu()                                            // PS:832 (§4) — countdown expiry, menu input, state text
  if quit != 0: return quit                                              // PS:833-834  (1 → SongSelection, Core/StageFlow.cs:100)
  ApplyTrainingSettings()                                                // PS:835 (§4)
  SyncStandbyPosition()                                                  // PS:836 (§4)
  songMs = _clock.SongMs                                                 // PS:840 re-read: menu may have jumped/scaled
  if Pressed(F11): ToggleHelp()                                          // PS:841-842
  if _auto: _autoUsed = true                                             // PS:843-844 (irrelevant: no result in training)
  if _trainStandby:                                                      // PS:846-855  STANDBY or START-IN
      _clock.JumpTo(_trainStartMs)          // pin song time EVERY frame; WallMs keeps running
      songMs = _trainStartMs
      ProcessWarmUpHits(songMs)             // §8
      Render(songMs)
      return 0
  if _clock.IsPaused:                                                    // PS:856-860  PAUSED
      Render(songMs); return 0              // no chip processing, no judging, no BGM, no warm-up
  // (non-training branch PS:862-888 — HandleTrainingKeys / F1 / CancelPressed / HandleRealtimeKeys — is NOT run in training)

  // ---- loop turnaround (PS:892-914) ----
  if _loopEndMs != -1 && songMs > _loopEndMs:          // strict >
      JumpInSong(_loopBeginMs == -1 ? 0 : _loopBeginMs)       // resyncAudio=true; _trainStandby is false here → BGM/SE resynced mid-clip
      Array.Clear(_counts); _combo = 0; _maxCombo = 0; _score = 0
      Array.Clear(_pgSectionHits); Array.Clear(_comboBombFired); Array.Clear(_comboHundredReached)
      // NOT reset: _gauge, _countsIncAuto, _sectionMiss, _playedMaxMs, _earlyCount/_lateCount, _inFillIn/_chorusSection (recomputed by JumpInSong), bonus fx flags
      songMs = _clock.SongMs                                   // == loop begin
      if _trainingMode && _train.StartWaitMs > 0:
          BeginStartWait()                 // §4 — StopChips() (kills the BGM just resynced), countdown at loop begin
          Render(songMs); return 0
      // StartWaitMs == 0: fall through, keep playing from loop begin in this same frame

  ProcessBgm(songMs); ProcessSe(songMs); ProcessGuitarBassAuto(songMs); ProcessFillIn(songMs)   // PS:916-919
  ProcessBarLines(songMs); ProcessMovie(songMs); ProcessBga(songMs)                            // PS:920-922
  ProcessJudgement(songMs)                                                                     // PS:923 (§11)
  if songMs > _playedMaxMs: _playedMaxMs = songMs                                              // PS:924-925
  Render(songMs)                                                                               // PS:926

  // ---- song end (PS:929-935) ----
  if _chart.HasNotes && songMs > _chart.DurationMs + FinishTailMs(2000) && _loopEndMs == -1:
      if _trainingMode: EnterStandby(resetStats:false)     // stats stay on screen
      else: EnterState(Clearing, "STAGE CLEAR", ...)
  return 0
```
Notes:
- Keys **not** active in training: F2/`=`, F5–F10, Shift+F1, `Pause` key, ↑↓←→ realtime adjust, gamepad East / `CancelPressed` (non-training branch skipped entirely; comment `PS:828-829`).
- `_state` never leaves `Playing`: STAGE FAILED gated by `!_trainingMode` (`PS:2844`); STAGE CLEAR replaced by `EnterStandby(false)`.
- `Judge()` still updates `_gauge` (`PS:2840-2841`) and DANGER display works; gauge just never fails.
- **[ADDED] Metronome**: `ProcessBarLines` plays `ClipMetronome` via `Sound.Play(clip, IsBeat ? 0.4f : 1f)` when `Config.Metronome` (`PS:2000-2011`); it goes through the one-shot `_source`, which is pitched by `SetChipPitch`, so the click is pitched by play speed. Never sounds in STANDBY/START-IN/PAUSED (ProcessBarLines not reached). `_barLineIndex` is recomputed by JumpInSong.
- **[ADDED] BGM not-yet-loaded rule** (`PS:1845-1866`): ProcessBgm plays a BGM event when `songMs >= TimeMs` and clip loaded (`PlayChip(clip, WavVolume*AutoVol, pan, 0, protect:true)` only if `Config.BgmSound`); if not loaded it waits, and gives up (index++) once `songMs > TimeMs + 5000`.

---

## 4. Training state-machine functions

### `UpdateTrainingMenu()` → int (`PS:1520-1549`)
```
if _trainMenu == null: return 0
if _trainStandby && _trainWaiting && Timer.NowMs >= _trainWaitUntilMs: BeginPlaying()   // expiry checked BEFORE input (PS:1525-1526)
switch _trainMenu.HandleInput():                                                          // TM:236-266
   StartStop:   if _trainStandby: StartTraining() else EnterStandby(false)   // "演奏停止" keeps stats (PS:1530-1533)
   Restart:     StartTraining()
   PauseResume: ToggleTrainingPause()
   Quit:        return 1
_trainMenu.Playing  = !_trainStandby
_trainMenu.Paused   = !_trainStandby && _clock.IsPaused
_trainMenu.StateText= TrainingStateText()
_trainMenu.Refresh()                                                                     // every frame
return 0
```
Consequences: during START-IN the item still reads "演奏開始" (Playing=false); pressing it re-runs `StartTraining()` (restarts countdown, resets stats). "一時停止" is a no-op during standby/wait (`PS:1651-1652`). **[ADDED]** Because expiry is checked before input, on the exact expiry frame an Enter on "演奏開始" is interpreted as "演奏停止" (`_trainStandby` already false) → immediately back to STANDBY with stats kept. Quit returns 1 BEFORE `ApplyTrainingSettings`/`Refresh` (irrelevant; stage exits).

### `ApplyTrainingSettings()` (every frame, `PS:1552-1572`)
```
_auto = _train.AutoPlay; _judgeOffsetMs = _train.JudgeOffsetMs; _noteDrawOffsetMs = _train.NoteOffsetMs; _scrollSpeedSetting = _train.ScrollSpeed
_allLanesAuto = all(_train.AutoLanes[0..9]); _laneAuto[i] = _train.AutoLanes[i]; _lbdAuto = _train.AutoLanes[10]
loopOn = _train.Loop && _train.LoopRangeValid        // LoopRangeValid = LoopEndMs > LoopBeginMs (TS:78)
_loopBeginMs = loopOn ? _train.LoopBeginMs : -1
_loopEndMs   = loopOn ? _train.LoopEndMs   : -1
```
Play speed is NOT applied here (goes through `TrainingPlaySpeedStep`). Note `_playSpeed` is only changed by the menu; `_train.PlaySpeed` is written back by `ChangePlaySpeed`.

### `StandbyPositionMs` (`PS:1577-1580`)
`(_train.Loop && _train.LoopRangeValid) ? Mathf.Max(0, _train.LoopBeginMs) : 0`

### `SyncStandbyPosition()` (`PS:1589-1598`)
```
if !_trainStandby || _trainWaiting: return        // only in pure STANDBY (never during START-IN / PLAYING / PAUSED)
desired = StandbyPositionMs
if desired == _trainStartMs: return
_trainStartMs = desired
JumpInSong(_trainStartMs, resyncAudio:false)      // notes from the new position re-armed and drawn; StopChips(); nothing sounds
```
Turning loop OFF (or making it invalid) returns display to song start (0); moving loop **end** does not move the view.

### `EnterStandby(resetStats)` (`PS:1604-1613`)
```
_trainStandby = true; _trainWaiting = false
_trainStartMs = StandbyPositionMs
if resetStats: ResetPlayStats()
JumpInSong(_trainStartMs, false)   // _trainStandby is true → Sound.StopChips() (BGM/SE stop); also un-pauses clock+audio if paused
```
Called with `true` from SetupTraining and StartTraining; with `false` from "演奏停止" and song end. Works from PAUSED too (JumpInSong resumes clock and audio, then chips are stopped).

### `StartTraining()` (`PS:1616-1620`) — "演奏開始" and "リスタート"
```
EnterStandby(true)      // position = loop begin or 0, stats reset, chips stopped, judged flags recomputed
BeginStartWait()
```

### `BeginStartWait()` (`PS:1623-1637`)
```
if !_trainStandby: _trainStartMs = Mathf.Max(0, _clock.SongMs)   // loop-turnaround path: wait at current pos (= loop begin right after JumpInSong)
_trainStandby = true; _trainWaiting = true
_trainWaitUntilMs = Timer.NowMs + Mathf.Max(0, _train.StartWaitMs)      // real time
Sound.StopChips()                                                        // chip pool only (BGM/SE); one-shot hit sounds keep ringing
if _clock.IsPaused: _clock.Resume(); Sound.ResumePerformance()
```
With `StartWaitMs == 0` via Start/Restart: at least one frame of "START IN 0.0" (expiry is checked at the top of the NEXT UpdateTrainingMenu), then `BeginPlaying()`.

### `BeginPlaying()` (`PS:1640-1646`)
```
_trainStandby = false; _trainWaiting = false
_clock.JumpTo(_trainStartMs)
ResyncAutoSounds(_trainStartMs)      // BGM/SE/GB spanning the start position start mid-clip (§4b)
```
Runs inside `UpdateTrainingMenu`, so in that same frame `songMs` is re-read (= `_trainStartMs`), the standby branch is skipped and chip processing/judging begins immediately. `_judged` flags are NOT recomputed here (they were set by the JumpInSong in EnterStandby/SyncStandbyPosition).

### `ToggleTrainingPause()` (`PS:1649-1665`)
```
if _trainStandby: return
if _clock.IsPaused: _clock.Resume(); Sound.ResumePerformance(); movie.Resume()   // movie null in training
else:               _clock.Pause();  Sound.PausePerformance();  movie.Pause()
```
`PausePerformance`/`ResumePerformance` pause/unpause the one-shot hit source, pan pool and chip pool (`SM:271-288`); system sounds (menu beeps) live on `_system` and are unaffected (`SM:15-19, 341-346`). While paused WallMs is frozen ⇒ NX effects freeze; warm-up hits are not processed; the hi-speed ramp stops. No "PAUSE" ShowStatus is issued by this path (the custom-skin status line shows "PAUSE" from `_clock.IsPaused` directly, `PS:3278-3280`).

### `ResetPlayStats()` (`PS:1197-1218`)
Clears `_counts[5]`, `_countsIncAuto[5]`, `_comboBombFired[256]`, `_comboHundredReached[256]`, `_sectionMiss`, `_pgSectionHits`; `_score=0; _combo=0; _maxCombo=0; _gauge = GaugeInitial (2/3); _playedMaxMs=0; _inFillIn=false; _chorusSection=false; _bonusFxActive=false; _bonusTextUntilMs=0; _comboBombActive=false; _failSoundPlayed=false`. Does NOT reset `_earlyCount/_lateCount` (reset only in `AllocateNxArrays` during UI build, `PS:5037-5038`), `_riskyTimes`, `_lastJudge/_judgeDisplay`, `_scoreDisp`.

### Leaving: Quit → `OnUpdate` returns 1 → `OnExit()` (`PS:1817-1839`)
`Sound.ResumePerformance(); Sound.StopAll()` (stops `_source`, `_system`, pan pool, chip pool, preview, screen BGM; not the exclusive source — `SM:323-335`); `Sound.SetChipPitch(1f)`; `_trainMenu.Destroy()`; `if _trainingMode: Config.Save()` (persists `[Training]` keys; loop positions never saved); movie disposed; UI root destroyed. `GameMain.TrainingMode` stays ON (`Core/GameMain.cs:47`; toggled only by F4 in song select, `Stages/SongSelectionStage.cs:343-344, 735-740` with `PlayDecide`; breadcrumb gets `"   [TRAINING]"`, `:1247-1248`; song-select hint line includes `F4: Training`, `:75`). No result stage ⇒ `records.json`/`score.ini` never updated (`BuildResult` never called).

---

## 4b. `JumpInSong` / `ResyncAutoSounds`

### `JumpInSong(newSongMs)` = `JumpInSong(newSongMs, true)` (`PS:1296-1299`); `JumpInSong(newSongMs, resyncAudio)` (`PS:1304-1358`)
```
target = Mathf.Max(0, newSongMs)
for i in Notes:       _judged[i]       = Notes[i].TimeMs < target      // strictly before = consumed; at/after = un-hit
for i in HiddenNotes: _hiddenJudged[i] = HiddenNotes[i].TimeMs < target
_bgmIndex  = CountBefore(BgmEvents, target)      // CountBefore = #events with TimeMs < target, scanning from 0 (PS:1361-1366)
_seIndex   = CountBefore(SeEvents, target); _cheerIndex = CountBefore(CheerEvents, target); _bgaIndex = CountBefore(BgaEvents, target)
_seLastHandle.Clear()
_gtAutoIndex = CountBeforeGB(GuitarNotes, target); _bsAutoIndex = CountBeforeGB(BassNotes, target); _gtLastVoice = _bsLastVoice = -1
_barLineIndex = count of BarLines with TimeMs < target
_inFillIn = false; _chorusSection = false; _fillInIndex = 0
while FillInEvents[_fillInIndex].TimeMs < target: ApplyFillIn(ev, playSound:false); _fillInIndex++   // fold fill-in/chorus state silently (PS:1922-1943)
_cheerClip = last loaded clip among CheerEvents[0.._cheerIndex)  (null if none)
_clock.JumpTo(target)
if _clock.IsPaused: _clock.Resume(); Sound.ResumePerformance()        // NX: jump always clears pause
if resyncAudio && !_trainStandby: ResyncAutoSounds(target)
else:                             Sound.StopChips()                   // standby never sounds BGM
if _movie != null && _movieStarted: _movie.Pause()                    // movie is null in training
```
Score/combo/counts/gauge are NOT touched by JumpInSong. `_bgaShown`, BGA layer sprites are not reset (last shown BGA image remains).

### `ResyncAutoSounds(songMs)` (`PS:1408-1421`)
```
Sound.StopChips(); _seLastHandle.Clear()
_bgmIndex = CountBefore(BgmEvents, songMs); _seIndex = CountBefore(SeEvents, songMs)
ResyncList(BgmEvents, songMs, protect:true); ResyncList(SeEvents, songMs, protect:false)
_gtLastVoice = ResyncGBLast(GuitarNotes, songMs); _bsLastVoice = ResyncGBLast(BassNotes, songMs)
```
`ResyncList` (`PS:1442-1460`): for each ev in time order with `ev.TimeMs < songMs` (break at the first `>= songMs`; events exactly at songMs are left to ProcessBgm/ProcessSe this frame): if clip loaded, `offsetSec = (songMs - ev.TimeMs)/1000f * PlaySpeedRatio`; skip if `offsetSec >= clip.length`; else `Sound.PlayChip(clip, WavVolume(id), WavPan(id), offsetSec, protect)`. **Every** still-ringing BGM/SE clip is restarted (not just the last). `ResyncGBLast` (`PS:1424-1440`): scans from the END for the last GB note with `TimeMs < songMs`; if its clip is missing → -1 (no fallback to earlier notes); if `offsetSec >= length` → -1; else PlayChip.
- Uses `WavVolume` only — no `AutoVol` factor and ignores `Config.BgmSound` — whereas `ProcessBgm` uses `WavVolume*AutoVol` and honors `BgmSound` (`PS:1851-1855`).
- `PlayChip` (`SM:204-232`): pool of 32 slots (`ChipPoolSize`); slot = first non-playing, else oldest unprotected, else oldest (`Core/ChipVoicePool.cs:20-32`); `volume = clamp01`, `panStereo = clamp(-1,1)`, `pitch = _chipPitch`, `priority = protect ? 0 : 200`, `time = clamp(startSec, 0, max(0, len-0.01))`; returns handle `(gen<<8)|slot`.
- `WavVolume(id) = #VOLUMExx/100 (default 1)`, `WavPan(id) = #PANxx/100 (default 0)` (`PS:2040-2050`).

---

## 5. Song end in training
- Condition (`PS:929`): `_chart.HasNotes && songMs > _chart.DurationMs + 2000 && _loopEndMs == -1` (`FinishTailMs = 2000`, `PS:117`). Evaluated AFTER Render, at the end of a PLAYING frame only.
- `DurationMs` (`Song/DtxChart.cs:236`) = max `TimeMs` over drum chips (`:549`), guitar/bass chips (`:499,506`) and long-note ends (`:568,570`); scaled with chart times by `ScaleChartTimes` (`PS:1282`). `HasNotes = Notes.Count > 0` (`:237`). BGM length is NOT part of it — a BGM longer than the last chip is cut off 2 s after the last chip.
- Action: `EnterStandby(false)` → STANDBY at `StandbyPositionMs`, stats kept, chip pool stopped, notes re-armed from that position. Menu shows "演奏開始" again next frame.
- With loop ON the song-end check never fires; the turnaround at `songMs > _loopEndMs` (default `LoopEndMs = DurationMs`, no 2 s tail) takes over.
- A chart without notes never auto-ends (only Quit/演奏停止).

---

## 6. Play speed

- Ranges: `PlaySpeedMin = 5, PlaySpeedMax = 40` (`CI:621`); ratio = `/20` ⇒ x0.25..x2.00, step 0.05. Menu shows `"x{0:0.00}"` (`TM:489`).
- `ChangePlaySpeed(delta)` (`PS:1225-1246`):
```
old = _playSpeed/20.0; _playSpeed = Mathf.Clamp(_playSpeed+delta, 5, 40); new = _playSpeed/20.0; k = old/new     // double
ScaleChartTimes(k)
if _loopBeginMs != -1: _loopBeginMs = (int)(_loopBeginMs*k);  if _loopEndMs != -1: _loopEndMs = (int)(_loopEndMs*k)
if Config != null: training ? _train.PlaySpeed = _playSpeed : Config.PlaySpeed = _playSpeed
Sound.SetChipPitch(PlaySpeedRatio)          // AudioSource.pitch on hit source, pan pool, chip pool (SM:260-268), clamped 0.05..4; affects already-playing clips too
JumpInSong((int)(_clock.SongMs * k))        // recomputes judged flags & cursors around the scaled position; resyncs BGM unless in standby
ShowStatus(string.Format("PLAY SPEED x{0:0.00}", PlaySpeedRatio))
```
  Even when clamped (no change), ScaleChartTimes(1.0), JumpInSong and ShowStatus still run.
- `ScaleChartTimes(k)` (`PS:1249-1286`): `TimeMs = (int)(TimeMs * k)` (C# cast = truncation toward zero) for Notes, HiddenNotes, BgmEvents, SeEvents, CheerEvents, MovieEvents, BgaEvents, BarLines, FillInEvents, Guitar/Bass notes (+`LongEndMs` if ≥0), GuitarWailing, BassWailing, Guitar/BassNoChipEvents, GuitarWailingSoundEvents, BpmChanges (struct write-back); `DurationMs = (int)(DurationMs*k)`; `_pgLastChipMs` likewise if >0.
  - Faster (ratio>1) ⇒ k<1 ⇒ chart times shrink ⇒ chart advances faster on the real-time clock. Audio pitch = ratio (tempo & pitch together; TimeStretch not implemented).
  - Clip offset when resuming mid-clip: `(songMs - ev.TimeMs)/1000 * ratio` s (`PS:1455`).
  - `CurrentBpm` display = chart BPM × ratio (`PS:2897-2913`).
- `TrainingPlaySpeedStep(delta)` (`PS:1682-1695`; delta = ±1, ±10 with Ctrl, or +1 via Enter):
```
before = _playSpeed; ChangePlaySpeed(delta); if _playSpeed == before: return   // at limits: nothing else (ShowStatus already shown)
k = before / (double)_playSpeed
_train.LoopBeginMs = (int)(_train.LoopBeginMs*k); _train.LoopEndMs = (int)(_train.LoopEndMs*k); _trainStartMs = (int)(_trainStartMs*k)
_trainMenu.SetChart(_chart)      // rebuild measure-start list from (already scaled) BarLines
```
  (`_loopBeginMs/_loopEndMs` scaled inside ChangePlaySpeed are overwritten next frame by ApplyTrainingSettings with the identically-truncated `_train` values.)
- **[ADDED] Speed change while in STANDBY (quirk)**: `ChangePlaySpeed` reads `_clock.SongMs`, which in standby is `_trainStartMs + δ` (δ = ms since the previous frame's pin, ~1 frame) because the pin happens later in the frame (`PS:850`). So `JumpInSong((int)((_trainStartMs+δ)*k))` marks notes with `TimeMs < (_trainStartMs+δ)*k` as judged (a note exactly at the standby position may disappear from the standby display); `SyncStandbyPosition` does not re-jump (`desired == _trainStartMs` after identical truncation). The flags are corrected by the next `StartTraining()` (EnterStandby → JumpInSong). In standby the ChangePlaySpeed→JumpInSong path also calls `StopChips()` (no resync).
- On enter, if saved `_train.PlaySpeed != 20`, chart pre-scaled by `20/_playSpeed` (`PS:699-700`) before `SetupTraining` sets `LoopEndMs = DurationMs`.
- Status/HUD: `ShowStatus(text)` sets `_statusUntilMs = Now + 1500` (WallMs) (`PS:1463-1467`); NX skin shows `"Play Speed: x{0:0.000}"` when `_playSpeed != 20 && Config.ShowPlaySpeed != 0` (`PS:4055-4067`); custom skin status line shows `"x{0:0.00}"` under the same condition when no status text is active (`PS:3279-3281`). Menu sounds (`_system` source) are NOT pitched (`SM:16-19`).

---

## 7. Note-draw offset vs judge offset — exact sign conventions

- Ranges: `NoteOffsetMs` −999..999, `JudgeOffsetMs` −99..99 (`TS:31-34`). Menu formats both `"{0:+0;-0;0} ms"` → `"+12 ms"`, `"-5 ms"`, `"0 ms"` (`TM:486-487`). Ctrl step = ±10 ms.
- **Draw** (`Render`, `PS:3195`): `drawMs = songMs - _noteDrawOffsetMs`. Used ONLY by `RenderLaneNotes/RenderFlatNotes(notes, drawMs)` (`PS:3209-3212`), bar/beat lines (`PS:3224`: `dt = bar.TimeMs - drawMs`), `RenderLoopLines(drawMs)` (`PS:3256`). Note y (non-reverse): `y = _judgeLineY - (note.TimeMs - drawMs) * _pixelsPerMs`; reverse: `_judgeLineY + dt*_pixelsPerMs` (`PS:2992-2994`). Judged notes (`_judged[i]`) are not drawn (`PS:2991`). Off-screen cull: `y < -60 || y > 1140` (notes); bar lines skip/break at `-10 / 1090` (`PS:3228-3237`). HidSud alpha uses `max(0,dt)*_pixelsPerMs` (`PS:3000`). Chip bounce phase uses `(drawMs - noteTimeMs)/666.67ms` sine, amp 0.3 (`PS:3069-3075`, `NoteBouncePeriodMs = 1000*40/60`, `NoteBounceAmp = 0.3`) — **[ADDED]** in standby drawMs is constant, so notes are frozen mid-bounce; the chip pattern frame (`Now/70 % 8`, `PS:2987`) keeps animating.
  - ⇒ **positive NoteOffset ⇒ drawMs smaller ⇒ notes drawn farther from (above) the judge line ⇒ they visually reach the line later.** Judgement, score, progress bar (`UpdateNxVisuals(songMs)`, `PS:3259`), BPM display, BGM are unaffected.
- **Judge** (`ProcessJudgement`, `PS:2148`): `inputMs = songMs + _judgeOffsetMs`. Nearest-note search uses `dt = note.TimeMs - inputMs`; lag passed to `Judge` = `inputMs - note.TimeMs` (positive = LATE, `PS:2185, 2771`). **[CORRECTED]** Miss: `inputMs - note.TimeMs > RangesFor(note.Channel).SearchWindowMs` (per-chip window: pedal channels 0x13/0x1B/0x1C use `_pedalRanges`, others `_ranges`; `PS:2221-2226, 2255-2258`), not the global max.
  - ⇒ **positive JudgeOffset shifts the player's hit later in chart time (adds lateness); negative makes hits count earlier.** (Field comment `TS:51` says "正の値で入力を早めに扱う" — opposite reading; see open questions.)
- AUTO judging (`_auto`): `songMs >= note.TimeMs` → `Judge(i, Perfect)` with lag 0, no offset (`PS:2134-2141`). Lane-AUTO: `AutoJudge(i)` when `songMs >= note.TimeMs` and `_laneAuto[lane]` (`PS:2122-2131`).
- Miss detection and all judging are skipped in STANDBY/START-IN/PAUSED.
- `BuildSectionLamps` uses `_searchWindowMs - _judgeOffsetMs` (`PS:1811`) — not used in training.

---

## 8. Standby warm-up hits (`ProcessWarmUpHits(songMs)`, `PS:1703-1718`)
Called only from the `_trainStandby` branch (STANDBY and START-IN; never PAUSED/PLAYING).
```
for pad in 0..9:
   if !Input.PressedAny(_laneBindings[pad], _velocityMin[pad]): continue   // edge (wasPressedThisFrame) per binding: keyboard Key / gamepad button / MIDI note with velocity threshold (IM:92-111)
   _laneFlash[pad] = 0.12f                       // custom-skin lane flash: alpha = clamp01(v/0.12)*0.5, decays by Time.deltaTime (PS:3197-3204)
   StartLaneEffects(pad)                         // _flushStartMs[pad] = _padHitMs[pad] = WallMs (PS:3367-3372)
   lanes = DrumGroups.SearchLanes(pad, _hhGroup, _ftGroup, _cyGroup, _bdGroup)
   borrow = FindNearestAnyNote(pad, lanes, songMs)   // songMs = _trainStartMs; NO judge offset
   if borrow != null: PlayHit(borrow)            // PlayPanned(clip, WavVolume(id)*ChipVol, WavPan(id)) if #WAV loaded, else Sound.Play(Fallback(lane), ChipVol)  (PS:2029-2038)
   else: Sound.Play(Fallback(pad), ChipVol)      // ChipVol = Config.ChipVolume/100 (PS:2916); Fallback = _g.DrumKit[lane] if present else synth (PS:2094-2102)
```
- `FindNearestAnyNote` (`PS:2305-2342`): own lane first, then the other lanes of `lanes` in order; per lane `NearestInList(Notes)` then `NearestInList(HiddenNotes)` with a shared `bestAbs` — hidden wins only if strictly closer (`bestHidden ?? best`); judged-or-not ignored; scan breaks once past `timeMs` without improving.
- **[ADDED]** `SearchLanes` table (`DG:40-63`): LC(0): hhGroup∈{1,3} → {1,0} else {0}; HH(1): hhGroup∈{1,3} → {1,0} else {1}; LP(2): bdGroup==3 → {2,5} else {2}; SD(3)/HT(4): {pad}; BD(5): bdGroup∈{1,3} → {5,2} else {5}; LT(6): ftGroup==1 → {6,7} else {6}; FT(7): ftGroup==1 → {7,6} else {7}; CY(8): cyGroup==1 → {8,9} else {8}; RD(9): cyGroup==1 → {8,9} else {9}.
- Effects driven by WallMs in `UpdateNxVisuals` (`PS:3514-3580`): NX lane flush 270 ms (ct = t/3; nominal top y = 700 − ct·7.4 in 720p space, alpha = clamp01(y/255); reverse: 32 + ct·7.4, alpha 1); NX pad: k = t/8, `dot2 = k<5 ? 2+2k : 11−(k−5)` clamped ≥0, offset = dot2·S, brightness `6 − t/18` → alpha = min(255, b·50)/255 (0 when b≤0); custom pad: t ≤ 130 ms, alpha = clamp01((6 − t/18)/6), offset = (t ≤ 37.5 ? t·0.4 : max(0, 15 − (t−37.5)·0.2))·S. No `Judge`, no `_counts/_score/_combo/_gauge`, no chip fire, no judge string, no `_earlyCount/_lateCount`. Hit sound uses the pitched `_source`/pan pool ⇒ warm-up hits are pitched by play speed. StopChips (from JumpInSong in standby) never cuts a warm-up hit (different sources).

---

## 9. LOOP behavior
- Loop positions live in `_train.LoopBeginMs/LoopEndMs` (not persisted; reset to `0 .. max(0,DurationMs)` on every stage entry, `PS:1483-1484`). Active `_loopBeginMs/_loopEndMs` re-derived every frame in `ApplyTrainingSettings` (−1 unless `Loop && End > Begin`). Toggling Loop OFF keeps the stored positions for re-enable.
- Turnaround: §3 pseudo-code (`PS:892-914`). When `songMs > _loopEndMs` (strict): `JumpInSong(_loopBeginMs)` (notes with `TimeMs >= loopBegin` un-hit and redrawn; cursors recomputed; BGM/SE/GB resynced mid-clip); reset `_counts`, `_combo`, `_maxCombo`, `_score`, `_pgSectionHits`, combo-bomb flags; gauge & `_countsIncAuto` kept; then if `StartWaitMs > 0` → `BeginStartWait()` (`_trainStartMs = max(0, clock.SongMs)` = loop begin, `StopChips()`, countdown in real time, text "START IN x.x", warm-up hits allowed, `_trainStandby` true so the menu shows "演奏開始"), else continue playing immediately. **[ADDED]** With StartWaitMs>0 the resync inside JumpInSong is immediately cancelled by StopChips (BGM restart for <1 frame). NX-skin score count-up display drops immediately when `_score` falls (`PS:3916-3917`).
- Editing loop points (`TM:376-392`, `TS:164-200`): `StepLoopTime(cur, delta, unit, measureTimes, durationMs)`: Measure unit → `idx = MeasureIndexAt(times, cur)` (largest i with `times[i] <= cur`), `if delta < 0 && cur > times[idx]: delta++` (first snap back to the current measure start), `idx = clamp(idx+delta, 0, count-1)`, return `clamp(times[idx], 0, max(0,durationMs))`; Second unit → `clamp(cur + 500*delta, 0, max(0,durationMs))`. `measureTimes = BuildMeasureTimes` = `[0]` + each `BarLine` with `IsBeat==false` and `TimeMs > last` (`TS:125-141`; hidden 0xC2 bar lines still count). `StepLoopEnd`: `v = Step(end, delta)`; if `v <= begin`: `v = Step(begin, +1)`; return `v > begin ? v : end` (`TS:183-188`). `StepLoopBegin`: `v = Step(begin, delta)`; if `v >= end`: `v = Step(end, −1)`; return `v < end ? v : begin` (`TS:195-200`). Unchanged ⇒ no cursor sound (`TM:380-381, 388-389`). **[ADDED]** Ctrl makes delta ±10 (10 measures / 5.0 s). Display `FormatLoopTime` (`TS:203-208`): Measure → `string.Format("{0:000} 小節", MeasureIndexAt(times, t))` (0-based index, e.g. `"012 小節"`); Second → `"{0:0.0} s"` (e.g. `"24.5 s"`).
- Loop line drawing (`RenderLoopLines(drawMs)`, `PS:2433-2451`), `dt = timeMs - drawMs`, `y = reverse ? judgeLineY + dt*pixelsPerMs : judgeLineY - dt*pixelsPerMs`, width `_barLineW` centered at `_barLineCenterX`, anchors top-left, pivot center (`PS:2396-2416`); drawn in every state (Render always runs); pool created even in Dark=FULL (`PS:2366-2367`):
  - Custom skin (pool 4, boxes 3 px tall): begin = 2 lines at `y` and `y+6`, color `LoopBeginColor = (0.4, 1.0, 0.5, 0.85)`; end = same with `LoopEndColor = (1.0, 0.45, 0.45, 0.85)`; skipped if `timeMs < 0` or `y < -10 || y > 1090` (`DrawLoopLine`, `PS:2483-2499`).
  - NX skin (pool 14, sprite 559×2 from `7_chips_drums.png` (0,769) scaled ×S): 7 stripes at `y + (off+1)*S` for `off ∈ LoopStripeBegin {−1,1,3,9,11,17,23}` / `LoopStripeEnd {−1,−3,−5,−11,−13,−19,−25}` (arrays swapped in reverse); console text "Begin loop"/"End loop" (white 8×16 console font) at x=830 (NX px), anchoredPosition.y = −(y − 17·S); cull `y < -40 || y > 1120`; text hidden when culled or timeMs<0 (`PS:353-355, 2453-2481`).
  - In STANDBY with loop ON the begin line sits at the judge line (offset by NoteOffset).
- Status line (`PS:3276-3287`): when non-empty and `_loopBeginMs >= 0`, append `"   [LOOP]"` (or `"   [LOOP BEGIN]"` if end unset — impossible in training) then `"   TRAINING"` (since `_training`).

---

## 10. Keyboard / menu input in training mode

### 10.1 Keys (PerformanceStage side)
- **F1** (no Shift): `_train.AutoPlay = !_train.AutoPlay` (`PS:830-831`), applied to `_auto` by ApplyTrainingSettings the same frame; no sound; persisted on exit. Shift+F1 does nothing.
- **F11**: `ToggleHelp()` (`PS:4970-4985`): lazily builds panel at (260,90) 1400×900 bg (0,0,0,0.82), text at (300,120) 1320×840 font 26 white UpperLeft, `SetAsLastSibling` (on top of the menu); text rebuilt on each open by `BuildHelpText()` (`PS:2654-2709`). Training lines, in order: `"― 操作 ―"`, `"↑ / ↓: メニューの項目を選ぶ"`, `"← / →: 設定を変える（Ctrl 併用で 10 段ずつ）"`, `"Enter: 決定（演奏開始・リスタート・一時停止・サブメニュー）"`, `"Esc: サブメニューから戻る／トレーニング終了（選曲へ）"`, `"F1: AUTO 切替（メニューの「自動演奏」と同じ）        F11: このヘルプ"`, `"待機中にパッドを叩くと音だけ鳴る（ウォーミングアップ）"`, blank, `"※ トレーニングの演奏は記録されません（records.json / score.ini とも更新しない）"`, `"※ トレーニングの設定は通常演奏とは別に保存されます"`, blank, `"― レーン割り当て（Config 画面の Key Assign で変更）―"`, then per lane `string.Format("  {0,-3} {1}", LaneName, _auto ? "AUTO" : _laneAuto[i] ? "AUTO" : bindingString)`, blank, then `"MIDI デバイス: N 台（Midi:<ノート番号> で割り当て）"` + per device `"  {Name}{（開けません） if !Opened}  打鍵 {HitCount}"`, or `"MIDI デバイス: 未検出（未接続か、この環境では MIDI 入力を利用できません）"`. The help panel does not block any input (Esc still quits, pads still hit).
- Bottom hint (`PS:2642-2646`, label "Hint": (600,24) 1284×36 font 22 UpperRight color (0.65,0.65,0.65) when not in prefab, `PS:6141-6143`): `"TRAINING   ↑↓: select   ←→: change   Enter: decide   F1: AUTO   F11: HELP   Esc: quit"`.
- **Esc** (keyboard `Key.Escape` only): sub-menu → `BackToMain()` (page Main, cursor = 1, `PlayCancel`); main → `PlayCancel` + `Quit` (`TM:253-264`).
- **Enter / NumpadEnter** only for decide (`TM:250-251`); Space and gamepad South deliberately excluded (Space = default BD key).
- **↑↓←→** via `Counter.RepeatKey(Pressing(key), action)` (`CT:100-138`): fires immediately on press, again when held > 200 ms, then every > 30 ms (GameTimer real time); released → reset to first stage. Each arrow has its own Counter; Up and Down can fire in the same frame. Ctrl (either side, level) ⇒ step ×10 evaluated at each fire (`TM:149-152`). Cursor sound throttled to ≥ 60 ms apart (`TM:117-118, 155-162`).
- Pads: `_laneBindings` (keyboard default A,S,W,D,F,Space,J,K,L,; = LC,HH,LP,SD,HT,BD,LT,FT,CY,RD `PS:50-62`, or Config DrumKeys / gamepad / MIDI) — warm-up in STANDBY/START-IN, judged in PLAYING, ignored in PAUSED.

### 10.2 TrainingMenu (`TM`) — items and behavior
Main page indices/names (`TM:43-65`): 0 `自動演奏`, 1 `自動演奏詳細`, 2 `ノーツ表示調整`, 3 `判定タイミング調整`, 4 `ハイスピード`, 5 `演奏速度`, 6 `開始待ち時間`, 7 `ループ演奏`, 8 `ループ位置単位`, 9 `ループ終了位置`, 10 `ループ開始位置`, 11 `演奏開始` (Playing ⇒ `演奏停止`), 12 `リスタート`, 13 `一時停止` (Paused ⇒ `再開`), 14 `トレーニング終了`. `MainCount = 15`. Cursor starts at 0; wraps both ways (`TM:134-146`).

Values (`TM:474-498`): 0 → `ON`/`OFF`; 1 → `なし` (0 AUTO lanes) / `N レーン` / `すべて` (10) (`TM:501-509`); 2,3 → `"{0:+0;-0;0} ms"`; 4 → `string.Format("x{0:0.0}", ScrollSpeed*0.5)`; 5 → `"x{0:0.00}"`; 6 → `string.Format("{0:0.0} s", StartWaitMs/1000f)`; 7 → `OFF` / `ON` / `ON (無効)` (Loop && !LoopRangeValid); 8 → `小節`/`秒`; 9,10 → FormatLoopTime; 11-14 → `""`.

`ChangeValue(delta)` on Main (`TM:342-396`; delta = ±1, ±10 with Ctrl, +1 via Enter): 0 → toggle AutoPlay (any delta); 1 → return (no sound; ←→ never opens the sub-menu); 2 → `NoteOffsetMs = clamp(+delta, −999, 999)`; 3 → `JudgeOffsetMs = clamp(+delta, −99, 99)`; 4 → `ScrollSpeed = clamp(+delta, 1, 2000)`; 5 → `PlaySpeedStep(delta)` (stage callback; always plays cursor sound afterwards even if clamped); 6 → `StartWaitMs = clamp(+delta*100, 0, 5000)`; 7 → toggle Loop; 8 → toggle unit; 9 → StepLoopEnd (return without sound if unchanged); 10 → StepLoopBegin (same); 11-14 → return (no sound). Otherwise `PlayCursorThrottled()`.

`Decide()` on Main (`TM:268-300`): 1 → `OpenAutoDetail()` (page AutoDetail, cursor 0, PlayDecide); 11 → PlayDecide + StartStop; 12 → PlayDecide + Restart; 13 → PlayDecide + PauseResume (stage ignores it in standby); 14 → PlayCancel + Quit; any other → `ChangeValue(+1)` (Enter always +1, Ctrl ignored).

Sub-menu `TRAINING - 自動演奏詳細` (12 rows): 0-9 lane names `LC HH LP SD HT BD LT FT CY RD` (value `AUTO`/`手動`), 10 `すべて` (value ""), 11 `戻る` (value ""). `ChangeValue` (←→ any delta, or Enter): lane row → toggle `AutoLanes[i]`; `すべて` → if any lane manual ⇒ all AUTO else all manual (`TM:325-333`); `戻る` → nothing; cursor sound after lane/all toggles. Enter on `戻る` and Esc → BackToMain. LBD (index 10) is not shown and is never changed by the menu.

Disabled rule (`TM:444-459`): rows 8/9/10 when `!Loop`; row 13 when `!Playing`; sub-menu never disabled. Colors (`TM:82-85, 424-431`): selected → (1,0.95,0.4) even if disabled; else disabled → (0.55,0.55,0.55); else action rows (11-14; sub-menu `戻る`) → (0.6,0.9,1); else (0.92,0.92,0.92). Both name and value colored. Row name text `"> "+name` when selected else `"   "+name`.

Layout (`TM:77-80, 179-222`): panel `TrainingMenu` default top-left (1400,340) 500×700 in 1920×1080 top-left coordinates (or prefab RectTransform named `training_menu` if its size > 100×100), bg (0.04,0.05,0.09,0.82); header (16,10) w=468 h36 font 30 MiddleLeft color (0.6,0.9,1) text `"TRAINING"` / `"TRAINING - 自動演奏詳細"`; state line (16,52) h32 font 24 color (1,0.85,0.4); rows y = 96 + i·36, h32: name x16 w300 font 25 MiddleLeft, value x316 w168 font 25 MiddleRight; unused rows (sub-menu rows 12-14) deactivated; footer at y = 96+15·36+6 = 642, h52, font 19 UpperLeft color (0.7,0.7,0.7): `"↑↓ 選択   ←→ 変更(Ctrl:x10)\nEnter 決定   Esc 終了"`.

### 10.3 Persistence (`CI:694-712, 809-817`; `TS:87-97`)
`[Training]`: `TrainingAutoPlay`(0/1), `TrainingAutoLanes`(11 chars '0'/'1', shorter strings fill from the front), `TrainingNoteOffset` (−999..999), `TrainingJudgeOffset` (−99..99), `TrainingScrollSpeed` (1..2000), `TrainingPlaySpeed` (5..40), `TrainingStartWait` (0..5000, floored to multiple of 100 by `Clamp`), `TrainingLoop` (0/1), `TrainingLoopUnit` (0=Measure/1=Second; invalid → Measure). Defaults: AutoPlay 0, lanes all 0, offsets 0, ScrollSpeed 2, PlaySpeed 20, StartWait 1000, Loop 0, Unit 0 (`TS:43-67`). Loop positions never saved. Saved in `OnExit` when `_trainingMode`.

### 10.4 Displays specific to training
- NX skin: score digits show 0 while `_training` (`PS:3742`); achievement rate 0 (`PS:4008`); skill "now" bar hidden; no start fade; no best lamps. Custom skin `_scoreText = "SCORE  " + _score.ToString("D7")` shows the real score (`PS:3262`); `_comboText = combo >= 2 ? combo + "\nCOMBO" : ""` (`PS:3263`); `_judgeText` = last judge name upper-case (PERFECT/GREAT/GOOD/OK/MISS) for 0.5 s with colors Perfect (1,0.95,0.3), Great (0.4,1,0.5), Good (0.4,0.8,1)… (`PS:3264-3273, 4069-4075`). `score_detailed` panel (if in prefab) shows `_counts[i]`, `round(100*count/total)%` (0% when total 0) and `_maxCombo` every frame (`PS:3341-3355`).
- `TrainingStatus` label (prefab `TrainingStatus` or generated: font 42, MiddleCenter, color (1,0.9,0.4), (660,420) 600×60; `PS:4988-4995`): `"PAUSE"` while `_clock.IsPaused`, else `_statusText` while `Now < _statusUntilMs`, else `"x{0:0.00}"` (custom skin only, speed≠1, `ShowPlaySpeed != 0`), else `""`; suffixes `"   [LOOP]"` and `"   TRAINING"` when non-empty (`PS:3276-3287`). In training the only ShowStatus source is `"PLAY SPEED x{0:0.00}"` (`ScrollSpeedStep`/`ChangeInputAdjust` are not reachable in training).

### 10.5 Hi-speed (`PS:942-980`)
`ScrollTargetRaw = _scrollSpeedSetting - 1`; every 2 ms of WallMs, `_scrollCurrentRaw` moves 0.012 toward target (clamped at target); `_pixelsPerMs = 0.675 * (raw + 1) * 0.5`. Starts at target on enter; runs during standby (WallMs runs); frozen while paused.

---

## 11. Judgement details reached in PLAYING (`ProcessJudgement`, `PS:2106-2228`)
1. Hidden chips with `TimeMs < songMs` are consumed silently (`PS:2113-2118`).
2. If `!_auto`: lane-AUTO — for unjudged notes with `TimeMs <= songMs` and `_laneAuto[lane]`: `AutoJudge(i)` (`PS:2720-2769`): judged; `_countsIncAuto[Perfect]++` (NOT `_counts`); `_pgSectionHits[NxSectionOf(TimeMs)]++`; judge string as AUTO (no lag digits); lane flash + StartLaneEffects; `PlayHit(note, auto:true)` at `AutoVol` (Config.AutoChipVolume/100); chip fire; fill-in effects if `_inFillIn`; bonus chip → `StartBonusEffect`, +500 score if `!_allLanesAuto || _autoAddGage`; combo++ only if `_allLanesAuto`; if `_autoAddGage`: score += ScoreDelta(Perfect,…) and gauge += 0.005.
3. If `_auto`: every unjudged note with `TimeMs <= songMs` → `Judge(i, Perfect)` (lag 0).
4. Else manual: `inputMs = songMs + _judgeOffsetMs`; for each pad with `PressedAny`: `lanes = SearchLanes(...)`; `lbdOnlyLane = (pad==5 && _bdGroup==1) ? 2 : -1` (lane 2 restricted to channel 0x1C); per lane `FindNearestNote` (unjudged, same lane, `dt = TimeMs - inputMs`, break when `dt > _searchWindowMs` (global max), accept when `|dt| <= RangesFor(channel).SearchWindowMs` and closer than current) and `FindNearestHiddenNote` (window = default 117); hidden candidate preferred only when strictly closer than the visible one in that lane; among lanes the earliest `TimeMs` wins; hidden wins over visible if its TimeMs is earlier. Hit: `Judge(best, RangesFor(ch).Judge(abs), inputMs - TimeMs)`; if `TieHitsAll(pad)` (pad not LC/CY/RD) also judge same-time chips in the other lanes. No candidate → "empty hit": lane flash, effects, borrow-sound via `FindNearestAnyNote(pad, lanes, inputMs)` (note: inputMs here, unlike warm-up).
5. Miss sweep: unjudged notes with `inputMs - TimeMs > RangesFor(ch).SearchWindowMs` → `Judge(i, Miss, lag)`.
- `HitRanges.Judge(abs)`: `<= Perfect → 0; <= Great → 1; <= Good → 2; <= Ok → 3; else 4` (`HR:49-56`); defaults 34/67/84/117.
- `Judge(idx, j, lagMs)` (`PS:2772-2846`): judged; `_counts[j]++; _countsIncAuto[j]++; _lastJudge=j; _judgeDisplay=0.5`; judge string; if `!_auto`: `lagMs > 0 ? _lateCount++ : _earlyCount++` (Miss counts as late; 0 counts as early); non-Miss → lane flash, effects, `PlayHit(note)` at ChipVol (also for global AUTO), chip fire unless Ok, fill-in fx; Perfect/Great/Good → combo++, bonus +500 (Perfect/Great only) + effect, score += ScoreDelta, clamp 0..9999999; Ok/Miss → combo 0, clear combo-bomb flags; maxCombo; combo jump + `_pgSectionHits` on P/G/G; `MarkSectionMiss` on Ok/Miss; gauge += delta (P +0.005, G +0.001, Good 0, Ok −0.017, Miss −0.041×DamageLevelFactor; risky variant `PS:2853-2873`), clamp ≤ 1.0; STAGE FAILED suppressed in training.

---

## 12. [ADDED] Edge cases / quirks summary
- Standby pin happens AFTER menu handling each frame, so `_clock.SongMs` read by menu-triggered code (ChangePlaySpeed) is `_trainStartMs + ~1 frame` (§6 quirk).
- On the loop turnaround with `StartWaitMs > 0`, `_trainStartMs = _clock.SongMs` read right after `JumpTo(loopBegin)`; normally exactly loopBegin (could be +1 ms only if WallMs ticks between the two calls within one frame).
- Song end + 2 s cut-off applies to BGM audio too (StopChips in EnterStandby).
- "演奏停止"/song end keep `_gauge`, counts and score on screen; the next "演奏開始"/"リスタート" resets them (including gauge to 2/3).
- Loop turnaround keeps `_gauge` and `_countsIncAuto`; resets `_counts/_combo/_maxCombo/_score/_pgSectionHits`.
- `_earlyCount/_lateCount` accumulate across the whole training session (reset only at UI build).
- In PAUSED, Unity-deltaTime-driven decays (lane flash alpha, judge text 0.5 s) still run; WallMs-driven NX effects freeze.
- Global AUTO plays hit sounds at ChipVol (Judge→PlayHit(note)), lane-AUTO at AutoVol.
- BGM/SE resumed by ResyncList ignore `Config.BgmSound` and `AutoVol`.
- Metronome (if enabled) is pitched by play speed and silent in standby.
- StopChips (standby jumps) does not stop one-shot hit sounds; PausePerformance does pause them.


## Key facts

- LeadInMs = 0 (PS:44): songMs == SongClock.SongMs everywhere; in standby songMs == _trainStartMs (pinned via _clock.JumpTo every frame at PS:850, AFTER menu handling).
- States: STANDBY = _trainStandby&&!_trainWaiting ('STANDBY'); START-IN = _trainStandby&&_trainWaiting (string.Format('START IN {0:0.0}', max(0,(waitUntil - GameTimer.NowMs)/1000f)), real time); PLAYING ('PLAYING'); PAUSED ('PAUSED'). PS:1668-1677
- Per-frame order (training): UpdateScrollSpeed → songMs read → F1 toggles _train.AutoPlay → UpdateTrainingMenu (countdown expiry → BeginPlaying BEFORE menu input; then menu command; then Playing/Paused/StateText/Refresh) → ApplyTrainingSettings → SyncStandbyPosition → songMs re-read → F11 → standby branch (pin clock, ProcessWarmUpHits, Render, return) / paused branch (Render, return) → loop turnaround → ProcessBgm,Se,GuitarBassAuto,FillIn,BarLines,Movie,Bga,Judgement → _playedMaxMs → Render → song-end check. PS:788-938
- StartTraining() = EnterStandby(true) [_trainStartMs = (Loop&&End>Begin)?max(0,LoopBegin):0; ResetPlayStats (counts, countsIncAuto, score, combo, maxCombo, gauge=2/3, playedMax, fillin flags, bomb flags); JumpInSong(pos,false) → judged[i]=TimeMs<pos, cursors, un-pause, StopChips] + BeginStartWait() [waitUntil = NowMs + max(0,StartWaitMs); StopChips; un-pause]. BeginPlaying() = JumpTo(_trainStartMs) + ResyncAutoSounds(_trainStartMs) (no judged recompute). PS:1604-1646
- '演奏停止' and song end (HasNotes && songMs > DurationMs + 2000 && loop off; DurationMs = max chip time incl. GB/long-note ends, scaled with play speed) → EnterStandby(false): stats/gauge kept, BGM stopped, position reset, notes re-armed. PS:929-935, 1531-1532
- Loop turnaround when songMs > _loopEndMs (strict): JumpInSong(_loopBeginMs) (judged[i] = TimeMs < target, cursors recomputed, BGM/SE/GB resynced mid-clip at offset (songMs-ev)/1000*ratio); reset _counts,_combo,_maxCombo,_score,_pgSectionHits,combo-bomb flags (gauge/_countsIncAuto kept); if StartWaitMs>0 → BeginStartWait (StopChips cancels the resync, countdown at loop begin, warm-up hits allowed), else keep playing same frame. PS:892-914
- Play speed: value 5..40, ratio=/20; ChangePlaySpeed: k = old/new (double), ScaleChartTimes(k) ((int) truncation on Notes/Hidden/Bgm/Se/Cheer/Movie/Bga/BarLines/FillIn/GB(+LongEnd)/wailing/nochip/BpmChanges + DurationMs + _pgLastChipMs), active loop points ×k, _train.PlaySpeed=value, SetChipPitch(ratio) (AudioSource.pitch on hit source/pan pool/chip pool, clamp 0.05..4), JumpInSong((int)(SongMs*k)), ShowStatus('PLAY SPEED x{0:0.00}' 1500ms WallMs). TrainingPlaySpeedStep additionally scales _train.LoopBeginMs/LoopEndMs/_trainStartMs by before/after and rebuilds the measure list; on enter chart pre-scaled by 20/PlaySpeed. PS:699-700, 1225-1286, 1682-1695
- Draw offset: drawMs = songMs - _noteDrawOffsetMs used ONLY for notes, bar/beat lines, loop lines (y = judgeLineY - (TimeMs - drawMs)*pixelsPerMs; reverse +); positive offset ⇒ notes reach the line later. pixelsPerMs = 0.675*(raw+1)*0.5 with raw ramping 0.012 per 2ms WallMs toward ScrollSpeed-1. PS:3195, 3209-3256, 942-980
- Judge offset: inputMs = songMs + _judgeOffsetMs; lag = inputMs - TimeMs (positive = late; Miss counts as late, 0 as early); miss when inputMs - TimeMs > RangesFor(chip channel).SearchWindowMs (pedal chips 0x13/0x1B/0x1C use pedal ranges); positive offset makes hits count LATER (code convention; TS:51 comment reads the opposite). AUTO/lane-AUTO judge at songMs >= TimeMs with no offset. PS:2122-2148, 2185, 2221-2226, 2255-2258
- Warm-up hits (STANDBY and START-IN only, not PAUSED): PressedAny edge with velocity threshold; lane flash 0.12 (decays by Time.deltaTime), StartLaneEffects (flush/pad WallMs timers); sound = FindNearestAnyNote(pad, SearchLanes(pad,groups), _trainStartMs) — own lane then partner lanes, visible+hidden (hidden only if strictly closer), judged or not, no judge offset — via PlayHit at WavVolume*ChipVol (PlayPanned) else Sound.Play(DrumKit[pad] or synth, ChipVol); no Judge/score/combo/gauge/chip fire/early-late counts; sounds are pitched by play speed. PS:1703-1718, 2305-2342
- JumpInSong(ms, resyncAudio): target=max(0,ms); judged/hiddenJudged = TimeMs < target; _bgmIndex/_seIndex/_cheerIndex/_bgaIndex = CountBefore; _seLastHandle cleared; GB indices + lastVoice=-1; _barLineIndex; fill-in state folded silently; _cheerClip = last loaded cheer before target; clock.JumpTo; always un-pauses clock+audio; resync BGM only if resyncAudio && !_trainStandby else StopChips (chip pool only); movie paused. ResyncList restarts EVERY BGM/SE with TimeMs < songMs whose offset < clip.length at WavVolume (no AutoVol, ignores Config.BgmSound), BGM protect:true priority 0, SE priority 200. PS:1304-1358, 1408-1460; SM:204-232
- Keys active in training: F1 (toggle _train.AutoPlay, no sound), F11 (help; panel on top, doesn't block input), Enter/NumpadEnter (decide; Enter on a value row = ChangeValue(+1) ignoring Ctrl), Esc keyboard only (sub-menu → back with cursor on item 1 + cancel sound; main → cancel sound + quit → SongSelection ret 1), arrows with Counter.RepeatKey (immediate, >200ms, then every >30ms; Ctrl = ×10; cursor sound ≥60ms apart), lane pads. F2/F5-F10/Shift+F1/Pause/gamepad East/realtime arrows are NOT handled. PS:826-863, TM:236-266; CT:100-138
- Loop editing: Measure unit snaps to measure starts ([0] + non-beat BarLines, strictly increasing; hidden bar lines count), −1 from mid-measure first snaps to current measure start; Second unit = 500 ms; clamp 0..DurationMs; StepLoopEnd: if v<=begin → Step(begin,+1), keep only if > begin; StepLoopBegin: if v>=end → Step(end,−1), keep only if < end; unchanged ⇒ no sound. Ctrl ⇒ delta ±10 (10 measures / 5 s). Display '{0:000} 小節' (0-based index) / '{0:0.0} s'. TS:125-208, TM:376-392
- Loop lines drawn in all states from drawMs: custom skin begin = 2 boxes 3px at y and y+6 color (0.4,1,0.5,0.85), end red (1,0.45,0.45,0.85), full lane-panel width (558*1.5 px default), culled outside y∈[-10,1090] or timeMs<0; NX skin: 7 sprite stripes (559×2 ×S) at y+(off+1)*S, off ∈ {-1,1,3,9,11,17,23}/{-1,-3,-5,-11,-13,-19,-25} (swapped in reverse) + 'Begin loop'/'End loop' console text at x=830, y-17*S, cull [-40,1120]. PS:84-88, 353-355, 2396-2499
- Menu items in order: 自動演奏, 自動演奏詳細, ノーツ表示調整, 判定タイミング調整, ハイスピード, 演奏速度, 開始待ち時間, ループ演奏, ループ位置単位, ループ終了位置, ループ開始位置, 演奏開始/演奏停止, リスタート, 一時停止/再開, トレーニング終了; sub-menu LC HH LP SD HT BD LT FT CY RD (AUTO/手動), すべて, 戻る; header 'TRAINING' / 'TRAINING - 自動演奏詳細'; footer '↑↓ 選択   ←→ 変更(Ctrl:x10)\nEnter 決定   Esc 終了'; disabled = rows 8/9/10 when !Loop, row 13 when !Playing; panel (1400,340) 500×700 bg (0.04,0.05,0.09,0.82); rows y=96+i*36. TM:43-85, 179-222, 402-509
- TrainingSettings defaults/ranges: NoteOffset ±999 (default 0), JudgeOffset ±99 (0), ScrollSpeed 1..2000 (2, ×0.5 display), PlaySpeed 5..40 (20), StartWait 0..5000 step 100 (1000, floored to 100 on load), Loop off, LoopUnit Measure(0)/Second(1); loop positions reset to 0..DurationMs on stage entry and never saved; [Training] keys TrainingAutoPlay/TrainingAutoLanes(11 chars)/TrainingNoteOffset/TrainingJudgeOffset/TrainingScrollSpeed/TrainingPlaySpeed/TrainingStartWait/TrainingLoop/TrainingLoopUnit saved in OnExit. TS:31-97, CI:694-712, 809-817
- Training-only display/flow: no movie (discarded, not even preloaded), movie_frame/Info line hidden, NX score digits & achievement 0, skill bar hidden, no best lamps, no start fade, STAGE FAILED disabled (gauge still moves), no result stage; TrainingStatus label shows 'PAUSE' | status text | 'x1.05' with '   [LOOP]' and '   TRAINING' suffixes. PS:703-714, 1496-1503, 2844, 3276-3287, 3742, 4008, 5284
- Pause semantics: menu only; SongClock.Pause freezes WallMs (NX effects, hi-speed ramp, status timeout freeze) and Sound.PausePerformance pauses hit source + pan pool + chip pool (menu sounds unaffected); Unity-deltaTime decays (lane flash, judge text) keep running; warm-up hits ignored; JumpInSong/EnterStandby/BeginStartWait always un-pause. PS:1649-1665, SM:271-288
- Metronome click (Config.Metronome: bar vol 1.0, beat 0.4) plays through the pitched one-shot source, only in PLAYING; BGM chip plays at WavVolume*AutoVol only if Config.BgmSound, waits up to 5000ms for an unloaded clip. PS:1842-1866, 2000-2011

## Open questions

- Judge-offset sign: code uses inputMs = songMs + _judgeOffsetMs (positive ⇒ hit treated as later / adds lateness), whereas the TrainingSettings.JudgeOffsetMs comment (TS:51) says '正の値で入力を早めに扱う'. Implement the code convention; confirm intent with the owner.
- ResyncAutoSounds/ResyncList plays BGM at WavVolume only (no AutoVol factor) and ignores Config.BgmSound, while ProcessBgm uses WavVolume*AutoVol and honors BgmSound (PS:1451-1458 vs 1851-1855). A BGM resumed mid-clip after Start/loop is louder than one started from its chip, and plays even with BGMSound=0. Decide whether to replicate or normalize.
- Loop turnaround calls JumpInSong with resyncAudio=true (BGM restarts) and then BeginStartWait immediately calls StopChips when StartWaitMs>0 — a sub-frame audio blip is possible; a reimplementation can skip the resync when StartWaitMs > 0.
- Play-speed change while in STANDBY: ChangePlaySpeed reads _clock.SongMs (= _trainStartMs + ~1 frame, since the standby pin at PS:850 happens after menu handling) and marks notes with TimeMs < (that)*k as judged, so a note sitting exactly at the standby position can disappear from the standby display until the next 演奏開始 (which recomputes flags). Decide whether to replicate or pin before handling the menu.
- _earlyCount/_lateCount are never reset by ResetPlayStats (only at UI build), so they accumulate across Start/Restart within one training session (visible in NX lag counters / info line if ShowLagHitCount) — confirm whether intended.
- During START-IN the Start item still reads '演奏開始' and re-triggers StartTraining (restarting the countdown and resetting stats); there is no way to cancel the countdown back to plain STANDBY except waiting or 演奏開始→wait→演奏停止. Also, on the exact countdown-expiry frame an Enter on 演奏開始 becomes 演奏停止 because expiry is processed before input (PS:1525-1531).
- Song end is defined by the last chip (+2000 ms) and cuts any longer BGM tail (StopChips in EnterStandby); confirm whether the browser port should also stop audio there.
- Judge text (0.5 s) and custom lane-flash alpha decay with Unity Time.deltaTime and therefore continue while PAUSED, unlike WallMs-driven NX effects — decide which clock to use in the port.
