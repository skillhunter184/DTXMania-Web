// MIDI(電子ドラム)の割り当ての純ロジック(DOM にも Web MIDI にも触らない)。
// 入力の受け口は js/ui/midi.js、設定 UI は js/ui/midipanel.js。仕様は docs/spec/nx-docs.md §7。
// 元実装: DTXManiaAI Input/DrumBinding.cs(`Midi:38` / `Midi:38:12` トークン)、Input/MidiDrumPresets.cs
// (GITADORA のプリセット表)、Config/ConfigIni.cs(GM 既定・<PAD>VelocityMin)、Stages/ConfigStage.cs(MIDI Setup)。
//
// 保存形式は Web 版の差分。元実装はキーボード・パッド・MIDI を 1 レーン 1 本のトークン列(`A|Midi:38:12`)に
// 混ぜて最大 12 個だが、Web 版はキーボード(config.bindings、js/ui/keybind.js)と MIDI
// (config.midiNotes: {note, threshold}[][] と config.midiVelocityMin: number[])を別々に持ち、それぞれ 12 個まで。
// キーボード側の UI と保存形式を変えずに足すため。MIDI の操作(プリセット適用・既定に戻す)が
// キーボードの割り当てに触らないのは、元実装の Apply Preset(MIDI だけ入れ替える)と同じ結果になる。

import { LANE_COUNT } from './keybind.js';
import { t } from '../i18n.js';

/** 1 レーンあたりの MIDI ノートの上限(元実装の MaxPerLane と同じ 12。GITADORA は 1 パッド 10 枠)。 */
export const MAX_NOTES_PER_LANE = 12;

/** ノート別のしきい値を持たない(レーン別の下限に従う)ことを表す値(DrumBinding.NoThreshold)。 */
export const NO_THRESHOLD = -1;

export const MAX_VELOCITY = 127;
const MAX_NOTE = 127;

// GM ドラムマップの既定(ConfigIni.cs の DrumKeys 既定。docs/spec/judge-score.md §10、nx-docs.md §7)。
// NX は MIDI の既定を持たないが、DTXManiaAI は電子ドラムをつなげば設定なしで叩けるようにこれを入れている。
const GM_DEFAULT_NOTES = [
  [49], // LC  Crash 1
  [42, 46], // HH  Closed / Open HH
  [44], // LP  Pedal HH
  [38, 40, 37], // SD  Snare / E.Snare / Side Stick
  [48, 50], // HT  Hi-Mid / High Tom
  [36, 35], // BD  Bass Drum 1 / Acoustic BD
  [45, 47], // LT  Low / Low-Mid Tom
  [43, 41], // FT  High / Low Floor Tom
  [57, 55], // CY  Crash 2 / Splash
  [51, 59, 53], // RD  Ride 1 / Ride 2 / Ride Bell
];

// レーン別のベロシティ切り捨て下限(NX [System] <PAD>VelocityMin)。HH だけ 20(電子ドラムのクロストーク対策)
const VELOCITY_MIN_DEFAULTS = [0, 20, 0, 0, 0, 0, 0, 0, 0, 0];

// 表示用の GM ドラムマップ名(35〜59。電子ドラムが送るのはほぼこの範囲。機種固有の番号は名前なし)
const GM_NOTE_NAMES = {
  35: 'Acoustic Bass Drum', 36: 'Bass Drum 1', 37: 'Side Stick', 38: 'Acoustic Snare', 39: 'Hand Clap',
  40: 'Electric Snare', 41: 'Low Floor Tom', 42: 'Closed Hi-Hat', 43: 'High Floor Tom', 44: 'Pedal Hi-Hat',
  45: 'Low Tom', 46: 'Open Hi-Hat', 47: 'Low-Mid Tom', 48: 'Hi-Mid Tom', 49: 'Crash Cymbal 1',
  50: 'High Tom', 51: 'Ride Cymbal 1', 52: 'Chinese Cymbal', 53: 'Ride Bell', 54: 'Tambourine',
  55: 'Splash Cymbal', 56: 'Cowbell', 57: 'Crash Cymbal 2', 58: 'Vibraslap', 59: 'Ride Cymbal 2',
};

/** GM ドラムマップの名前(無ければ空文字)。 */
export function noteName(note) {
  return GM_NOTE_NAMES[note] || '';
}

export function isValidNote(note) {
  return Number.isInteger(note) && note >= 0 && note <= MAX_NOTE;
}

function binding(note, threshold = NO_THRESHOLD) {
  return { note, threshold };
}

function copyNotes(notes) {
  return notes.map((lane) => lane.map((b) => binding(b.note, b.threshold)));
}

/** 既定の割り当て(GM ドラムマップ。10 レーン分の新しい配列)。 */
export function defaultMidiNotes() {
  return GM_DEFAULT_NOTES.map((lane) => lane.map((n) => binding(n)));
}

/** レーンの既定ノート番号。 */
export function defaultLaneNotes(lane) {
  return GM_DEFAULT_NOTES[lane].slice();
}

export function defaultVelocityMin() {
  return VELOCITY_MIN_DEFAULTS.slice();
}

/** 保存値 1 個を {note, threshold} に直す。読めなければ null。 */
function toBinding(v) {
  if (!v || typeof v !== 'object') return null;
  if (!isValidNote(v.note)) return null;
  const th = v.threshold;
  return binding(v.note, Number.isInteger(th) && th >= NO_THRESHOLD && th <= MAX_VELOCITY ? th : NO_THRESHOLD);
}

/**
 * 保存済みの MIDI 割り当てを 10 レーン × 重複無しの形に整える(keybind.js の normalizeBindings と同じ方針)。
 * 配列ですらない / 中身はあったのに全部読めなかったレーンは既定(GM)を入れ直し、repaired に載せる。
 * 空のレーン([])は意図的な未割り当て(元実装の None)なので残す。
 * レーン間でノートが重なっていたら若いレーンが勝つ(1 打で 2 レーン鳴らないように)。
 * @returns {{notes:{note:number,threshold:number}[][], repaired:number[]}}
 */
export function normalizeMidiNotes(raw) {
  const src = Array.isArray(raw) ? raw : [];
  const cleaned = [];
  const broken = [];
  for (let lane = 0; lane < LANE_COUNT; lane++) {
    const given = Array.isArray(src[lane]);
    const list = given ? src[lane] : [];
    const clean = [];
    for (const v of list) {
      const b = toBinding(v);
      if (!b) continue;
      if (clean.some((x) => x.note === b.note)) continue;
      if (clean.length >= MAX_NOTES_PER_LANE) break;
      clean.push(b);
    }
    broken.push(!given || (list.length > 0 && clean.length === 0));
    cleaned.push(clean);
  }
  const owner = new Set();
  const take = (b) => {
    if (owner.has(b.note)) return false;
    owner.add(b.note);
    return true;
  };
  const notes = new Array(LANE_COUNT);
  // 生きているレーンを先に確定させる(壊れたレーンの修復で、正しく設定されたレーンから奪わない)
  for (let lane = 0; lane < LANE_COUNT; lane++) if (!broken[lane]) notes[lane] = cleaned[lane].filter(take);
  const repaired = [];
  for (let lane = 0; lane < LANE_COUNT; lane++) {
    if (!broken[lane]) continue;
    notes[lane] = GM_DEFAULT_NOTES[lane].map((n) => binding(n)).filter(take);
    repaired.push(lane);
  }
  return { notes, repaired };
}

/** レーン別の下限を 10 個の 0〜127 に整える(読めない値はそのレーンの既定)。 */
export function normalizeVelocityMin(raw) {
  const src = Array.isArray(raw) ? raw : [];
  return VELOCITY_MIN_DEFAULTS.map((def, lane) => {
    const v = src[lane];
    return Number.isInteger(v) && v >= 0 && v <= MAX_VELOCITY ? v : def;
  });
}

/** note を持っているレーンと位置。無ければ null。 */
export function findNote(notes, note) {
  for (let lane = 0; lane < notes.length; lane++) {
    const i = notes[lane].findIndex((b) => b.note === note);
    if (i >= 0) return { lane, index: i };
  }
  return null;
}

/**
 * 叩いて登録したノートをレーンの末尾に足す。他レーンが持っていれば取り上げる
 * (元実装 ConfigStage.AssignBinding = NX tDeleteAlreadyAssignedInputs。1 ノートが 2 レーンに載らない)。
 * 取り上げたノートのノート別しきい値は引き継がない(元実装と同じ。新しい割り当てはレーンの下限に従う)。
 * 同じレーンに既にあれば何もしない(反応を確かめようと叩き直しても、しきい値が消えない。22:133 の修正と同じ結果)。
 * @returns {{notes, ok:boolean, reason:?string, stolenFrom:?number, stolenEmptied:boolean}}
 *          reason は 'invalid' | 'already' | 'full'
 */
export function addNote(notes, lane, note) {
  const fail = (reason) => ({ notes, ok: false, reason, stolenFrom: null, stolenEmptied: false });
  if (!isValidNote(note)) return fail('invalid');
  if (notes[lane].some((b) => b.note === note)) return fail('already');
  if (notes[lane].length >= MAX_NOTES_PER_LANE) return fail('full');
  const next = copyNotes(notes);
  const at = findNote(next, note);
  let stolenFrom = null;
  let stolenEmptied = false;
  if (at) {
    next[at.lane].splice(at.index, 1);
    stolenFrom = at.lane;
    stolenEmptied = next[at.lane].length === 0; // 空になっても既定では埋めない(None)
  }
  next[lane].push(binding(note)); // 追加順に並べる(キーボードの割り当てと同じ)
  return { notes: next, ok: true, reason: null, stolenFrom, stolenEmptied };
}

/**
 * レーンからノートを 1 個外す。位置ではなくノート番号で指す(画面の並びと保存の並びがずれても誤爆しない)。
 * @returns {{notes, ok:boolean, emptied:boolean}}
 */
export function removeNote(notes, lane, note) {
  const i = notes[lane].findIndex((b) => b.note === note);
  if (i < 0) return { notes, ok: false, emptied: false };
  const next = copyNotes(notes);
  next[lane].splice(i, 1);
  return { notes: next, ok: true, emptied: next[lane].length === 0 };
}

/** レーンの MIDI を空(意図的な未割り当て)にする。 */
export function clearLaneNotes(notes, lane) {
  const next = copyNotes(notes);
  next[lane] = [];
  return { notes: next, ok: true };
}

/**
 * レーンだけ既定(GM)に戻す。既定ノートを他レーンが持っていれば取り上げる(keybind.js の resetLane と同じ)。
 * @returns {{notes, ok:boolean, stolenFrom:number[], stolenEmptied:number[]}}
 */
export function resetLaneNotes(notes, lane) {
  const next = copyNotes(notes);
  next[lane] = [];
  const stolenFrom = [];
  for (const n of GM_DEFAULT_NOTES[lane]) {
    const at = findNote(next, n);
    if (at) {
      next[at.lane].splice(at.index, 1);
      if (stolenFrom.indexOf(at.lane) < 0) stolenFrom.push(at.lane);
    }
    next[lane].push(binding(n));
  }
  const stolenEmptied = stolenFrom.filter((l) => next[l].length === 0);
  return { notes: next, ok: true, stolenFrom, stolenEmptied };
}

/**
 * ノート別しきい値を dir だけ動かした値(元実装 ConfigStage.ChangeMidiThreshold)。
 * 「レーン設定に従う(-1)」から上げるときはレーンの下限から動かす。素直に -1+1=0 にすると
 * しきい値 0 = 素通しになり、HH の既定 20(クロストーク対策)が黙って外れるため(22:134)。
 * 下げていって 0 の次は -1(レーン設定に戻る)。
 */
export function stepThreshold(threshold, dir, laneMin) {
  const clamp = (v, lo) => Math.max(lo, Math.min(MAX_VELOCITY, v));
  if (threshold === NO_THRESHOLD && dir > 0) return clamp(laneMin + dir, 0);
  return clamp(threshold + dir, NO_THRESHOLD);
}

/** ノート別しきい値を書き換える(-1 = レーン設定に従う)。 */
export function setNoteThreshold(notes, lane, note, threshold) {
  const i = notes[lane].findIndex((b) => b.note === note);
  if (i < 0) return { notes, ok: false };
  const next = copyNotes(notes);
  next[lane][i].threshold = threshold;
  return { notes: next, ok: true };
}

/** このノートに使うしきい値(個別指定が無ければレーン別の下限。DrumBinding.EffectiveThreshold)。 */
export function effectiveThreshold(b, laneMin) {
  return b.threshold === NO_THRESHOLD ? laneMin : b.threshold;
}

/** NX と同じく「しきい値以下は捨てる」(nVelocity <= nVelocityMin)。 */
export function passesThreshold(velocity, threshold) {
  return velocity > threshold;
}

/** レーンのノートを 1 行で表す("42 / 46"、空なら "なし")。 */
export function laneNotesText(list) {
  return list && list.length ? list.map((b) => String(typeof b === 'number' ? b : b.note)).join(' / ') : t('common.none');
}

// ---- GITADORA のプリセット(DTXManiaAI Input/MidiDrumPresets.cs、docs/spec/nx-docs.md §7) ----

/** GITADORA のパッド番号 → レーン番号。プリセット表のパッドの並びは HT / LT / SD / FT / LC / CY / HH / LP / BD。 */
const PAD_TO_LANE = [4, 6, 3, 7, 0, 8, 1, 2, 5];

/**
 * 出荷時プリセット(GITADORA の MIDI 設定のプリセットと同じノート番号)。名前はそのまま MIDI 入力デバイス名の照合キーで、
 * DEFAULT だけが「どれにも当たらないとき」の受け皿。DTX DRUMS / DTX Drums / DTX drums は
 * 大小文字だけ違う別物(ドライバの版で名乗りが変わる)。しきい値は全部が既定の 8 なので持たない。
 */
export const MIDI_PRESETS = [
  //                                HT         LT         SD    FT         LC        CY            HH                    LP        BD
  { name: 'DEFAULT', pads: [[50, 48], [47, 45], [38], [41], [49], [51], [46], [44], [36]] },
  { name: 'MIDI DRUM', pads: [[50], [47], [38], [41], [49], [51], [46], [44], [36]] },
  { name: 'TD-1', pads: [[48], [45], [38], [43], [49], [51], [46], [44], [36]] },
  { name: 'DTX DRUMS', pads: [[48], [47], [38], [43], [49], [51], [46], [44], [36]] },
  { name: 'DTX Drums', pads: [[48], [47], [38], [43], [49], [51], [46, 42], [44], [36]] },
  { name: 'DTX drums', pads: [[48], [47], [38], [43], [49, 59], [51, 52, 53], [42, 46, 78, 79, 86], [35, 44], [36]] },
  { name: 'Yamaha DTX700-1', pads: [[15, 48], [19, 47], [38], [23, 43], [59], [51, 52, 53], [46, 78], [33], [36]] },
];

/** レーンに割り当てるノート番号。GITADORA に無いレーン(RD)は null。 */
export function presetNotesForLane(preset, lane) {
  const pad = PAD_TO_LANE.indexOf(lane);
  return pad < 0 ? null : preset.pads[pad].slice();
}

/**
 * プリセットを流し込む(元実装 MidiDrumPresets.Apply)。MIDI のノートだけを入れ替え、
 * ノート別しきい値は書かない(レーン別の下限に任せる)。GITADORA に無い RD の MIDI は空にする:
 * 残すと GITADORA の右シンバル(ライドの 51/52/53)が CY に入る一方で RD 側に 59/53 が残り、
 * 1 枚のライドパッドがボウで CY・エッジで RD を鳴らす割れた状態になるため(22:90-94)。
 * RD のチップを叩きたいときは CY グループを「共通」にする。
 */
export function applyPreset(notes, preset) {
  const next = copyNotes(notes);
  for (let lane = 0; lane < LANE_COUNT; lane++) {
    const add = presetNotesForLane(preset, lane);
    next[lane] = add ? add.map((n) => binding(n)) : [];
  }
  return { notes: next, ok: true };
}

/**
 * 名前でプリセットを引く(無ければ null)。大小文字違いの DTX 3 種は別物なので、
 * まず完全一致で探し、無ければ大小文字を無視して探す(22:136)。
 */
export function findPreset(name) {
  if (!name) return null;
  return MIDI_PRESETS.find((p) => p.name === name)
    || MIDI_PRESETS.find((p) => p.name.toLowerCase() === String(name).toLowerCase())
    || null;
}

function noteTotal(p) {
  return p.pads.reduce((n, pad) => n + pad.length, 0);
}

function matchDeviceWith(deviceName, fold) {
  const hay = fold ? deviceName.toLowerCase() : deviceName;
  let best = null;
  for (let i = 1; i < MIDI_PRESETS.length; i++) { // 0 = DEFAULT は照合しない(受け皿なので)
    const p = MIDI_PRESETS[i];
    if (hay.indexOf(fold ? p.name.toLowerCase() : p.name) < 0) continue;
    // 名前の長いほう(= より具体的なほう)を採る。同点(大小文字を無視する 2 周目の DTX 3 種)なら
    // ノートを多く受けるほうを採る(叩いても無反応なパッドが残らないように)
    if (!best || p.name.length > best.name.length || (p.name.length === best.name.length && noteTotal(p) > noteTotal(best))) best = p;
  }
  return best;
}

/**
 * MIDI 入力デバイス名にいちばん合うプリセット(元実装 MidiDrumPresets.MatchDevice)。
 * デバイス名にプリセット名が含まれるかで照合する(Windows は "2- TD-1" のように番号を前に付けることがある)。
 * 大小文字を区別して探し、当たらなければ無視してもう一度。どれにも当たらなければ null。
 */
export function matchDevicePreset(deviceName) {
  if (!deviceName) return null;
  return matchDeviceWith(String(deviceName), false) || matchDeviceWith(String(deviceName), true);
}

/** つながっている機器の名前から選ぶプリセット(AUTO)。当たらなければ DEFAULT。 */
export function autoPreset(deviceNames) {
  for (const name of deviceNames || []) {
    const p = matchDevicePreset(name);
    if (p) return p;
  }
  return MIDI_PRESETS[0];
}
