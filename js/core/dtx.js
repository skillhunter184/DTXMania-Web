// DTX 譜面の解析。DTXManiaAI DtxChart.cs / DtxHeader.cs / DtxIfStack.cs(= DTXManiaNX CDTX)の移植。
//
// - 1 小節 = 384 tick、先頭に空 1 小節(リードイン)を置く。位置 pos = (measure + 1) * 384 + 384 * i / N
// - 時刻 ms = currentMs + 625 × Δtick × barLength / bpm(NX tComputeChipPlayTimeMs)
// - ch 02 = 小節長(その小節以降に持続)、ch 03 = BPM(16 進 2 桁、BASEBPM 加算)、ch 08 = #BPMxx 参照
// - 小節線(0x50)/拍線(0x51)はパース後に内部生成し、0xC1(拍線シフト)/0xC2(表示指定)を反映
// - ドラム可視チップ 0x11-0x1C、不可視 0x31-0x3C、ボーナス 0x4C-0x4F、BGM 01、SE 0x61-0x92、歓声 0x1F、フィルイン 0x53
// - #RANDOM / #IF / #ENDIF(食い込み書式 #IF1 も可)
//
// 譜面編集(将来の拡張)のため、各ノートに DTX 上の小節番号・小節内 tick・チップ ID・元チャンネルを保持し、
// 元テキストの行も rawLines として残す。

import { splitLines } from './encoding.js';

export const TICKS_PER_MEASURE = 384;
export const LANE_COUNT = 10;
export const LANE_NAMES = ['LC', 'HH', 'LP', 'SD', 'HT', 'BD', 'LT', 'FT', 'CY', 'RD'];
export const LEAD_IN_TICKS = TICKS_PER_MEASURE;

/** ドラムチャンネル → レーン番号(0=LC 1=HH 2=LP 3=SD 4=HT 5=BD 6=LT 7=FT 8=CY 9=RD)。 */
export const CHANNEL_TO_LANE = {
  0x1a: 0, // LeftCymbal
  0x11: 1, // HiHatClose
  0x18: 1, // HiHatOpen
  0x1b: 2, // LeftPedal
  0x1c: 2, // LeftBassDrum
  0x12: 3, // Snare
  0x14: 4, // HighTom
  0x13: 5, // BassDrum
  0x15: 6, // LowTom
  0x17: 7, // FloorTom
  0x16: 8, // Cymbal
  0x19: 9, // RideCymbal
};

/** レーンの代表チャンネル(ノート追加時などに使う)。 */
export const LANE_CANONICAL_CHANNEL = [0x1a, 0x11, 0x1b, 0x12, 0x14, 0x13, 0x15, 0x17, 0x16, 0x19];

export const CHANNEL_NAMES = {
  0x11: 'HHC', 0x12: 'SD', 0x13: 'BD', 0x14: 'HT', 0x15: 'LT', 0x16: 'CY',
  0x17: 'FT', 0x18: 'HHO', 0x19: 'RD', 0x1a: 'LC', 0x1b: 'LP', 0x1c: 'LBD',
};

const CH_BGM = 0x01;
const CH_BAR_LENGTH = 0x02;
const CH_BPM = 0x03;
const CH_BPM_EX = 0x08;
const CH_CHEER = 0x1f;
const CH_BAR_LINE = 0x50;
const CH_BEAT_LINE = 0x51;
const CH_FILL_IN = 0x53;
const CH_MOVIE = 0x54;
const CH_BEAT_LINE_SHIFT = 0xc1;
const CH_BEAT_LINE_DISPLAY = 0xc2;
const CH_HIDDEN_MIN = 0x31;
const CH_HIDDEN_MAX = 0x3c;
const CH_BONUS_MIN = 0x4c;
const CH_BONUS_MAX = 0x4f;
// ボーナスチップの値(36 進)→ レーン(1=LC 2=HH 3=LP 4=SD 5=HT 6=BD 7=LT 8=FT 9=CY 10=RD)
const BONUS_VALUE_TO_LANE = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/** SE チャンネル(SE01-SE32。NX EChannel の飛び番を含む)。 */
export function isSeChannel(ch) {
  return (ch >= 0x61 && ch <= 0x69) || (ch >= 0x70 && ch <= 0x79) || (ch >= 0x80 && ch <= 0x89) || (ch >= 0x90 && ch <= 0x92);
}

/** 同一チャンネルの前音を止めてから鳴らす SE(SE01-SE05)。 */
export function isMutingSeChannel(ch) {
  return ch >= 0x61 && ch <= 0x65;
}

export function parseBase36(s) {
  let v = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let d;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (c >= 65 && c <= 90) d = c - 55;
    else if (c >= 97 && c <= 122) d = c - 87;
    else return v;
    v = v * 36 + d;
  }
  return v;
}

export function parseHex(s) {
  let v = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let d;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (c >= 65 && c <= 70) d = c - 55;
    else if (c >= 97 && c <= 102) d = c - 87;
    else return v;
    v = v * 16 + d;
  }
  return v;
}

const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function toBase36(n) {
  return B36[Math.floor(n / 36) % 36] + B36[n % 36];
}

/** NX の TryParse 相当: 小数点として '.' と ','(EU 書式)の両方を受理する。 */
export function tryParseBpm(s) {
  const t = String(s).trim();
  if (t.length === 0) return NaN;
  let v = Number(t);
  if (Number.isFinite(v)) return v;
  v = Number(t.replace(',', '.'));
  return Number.isFinite(v) ? v : NaN;
}

/** DTX 行末コメント(';' 以降)を除去して前後空白を落とす。 */
export function stripComment(s) {
  const semi = s.indexOf(';');
  if (semi !== -1) s = s.slice(0, semi);
  return s.trim();
}

/**
 * 行頭コマンドが name に一致すれば true。"#IF1" のようにコマンドとパラメータが連結している場合は
 * 残りでパラメータを置き換える(NX t入力_パラメータ食い込みチェック)。
 */
export function takeCommand(o, name) {
  if (!o.cmd.toUpperCase().startsWith(name)) return false;
  if (o.cmd.length > name.length) {
    o.param = o.cmd.slice(name.length);
    o.cmd = name;
  }
  o.param = stripComment(o.param);
  return true;
}

/** #RANDOM / #IF / #ENDIF の評価(DtxIfStack)。乱数の初期値は 0(#RANDOM 前の #IF は常に不成立)。 */
export class IfStack {
  constructor(random = Math.random) {
    this._skip = [false];
    this._random = random;
    this._current = 0;
  }
  get inIfBlock() {
    return this._skip.length > 1;
  }
  /** true ならこの行は消費済み/スキップ対象。 */
  skipsLine(o) {
    if (takeCommand(o, 'ENDIF')) {
      if (this._skip.length > 1) this._skip.pop();
      return true;
    }
    if (takeCommand(o, 'IF')) {
      if (this._skip.length < 255) {
        if (this._skip[this._skip.length - 1]) this._skip.push(true);
        else {
          let n = parseInt(o.param, 10);
          if (!Number.isFinite(n)) n = 1;
          this._skip.push(n !== this._current);
        }
      }
      return true;
    }
    if (this._skip[this._skip.length - 1]) return true;
    if (takeCommand(o, 'RANDOM')) {
      let n = parseInt(o.param, 10);
      if (!Number.isFinite(n)) n = 1;
      this._current = Math.floor(this._random() * Math.max(n, 0)) + 1;
      return true;
    }
    return false;
  }
}

function splitHeader(body) {
  const colon = body.indexOf(':');
  const sp = body.search(/[ \t]/);
  let sep;
  if (colon === -1) sep = sp;
  else if (sp === -1) sep = colon;
  else sep = Math.min(colon, sp);
  if (sep < 0) return { cmd: body.trim(), param: '' };
  let param = body.slice(sep + 1);
  // "#WAV01 :snare.wav" のように空白の後に ':' が来る書式は、':' を区切りとして扱う(NX 風)
  if (body[sep] !== ':') param = param.replace(/^[ \t]*:/, '');
  return { cmd: body.slice(0, sep).trim(), param: stripComment(param) };
}

/** データ行 "#mmmCC: ..." か(先頭 3 文字が数字)。C# 同様、数字 3 桁のみを小節番号として扱う。 */
function isDataLine(body) {
  return body.length >= 6 && /^[0-9]{3}/.test(body);
}

function ctrlPriority(ch) {
  if (ch === CH_BAR_LENGTH || ch === CH_BPM || ch === CH_BPM_EX) return 0;
  if (ch === CH_BEAT_LINE_SHIFT) return 1;
  if (ch === CH_BAR_LINE || ch === CH_BEAT_LINE) return 2;
  if (ch === CH_BEAT_LINE_DISPLAY) return 3;
  return 4;
}

function newChart() {
  return {
    title: '', artist: '', comment: '', genre: '', preview: '', preimage: '', premovie: '', background: '',
    level: [0, 0, 0], levelDec: [0, 0, 0],
    bpm: 120.0, baseBpm: 0.0,
    wavDefs: new Map(), wavVolumes: new Map(), wavPans: new Map(), aviDefs: new Map(), bmpDefs: new Map(),
    bpmDefs: new Map(),
    notes: [], hiddenNotes: [], bgmEvents: [], seEvents: [], cheerEvents: [], fillInEvents: [],
    movieEvents: [], barLines: [], bpmChanges: [],
    bonusChipCount: 0, durationMs: 0, lastNoteMs: 0,
    laneHasNotes: new Array(LANE_COUNT).fill(false),
    rawLines: [],
  };
}

function setLevel(chart, part, param) {
  let v = parseInt(param, 10);
  if (!Number.isFinite(v)) return;
  v = Math.min(Math.max(v, 0), 1000);
  if (v >= 100) {
    const lvl = Math.floor(v / 10);
    chart.level[part] = lvl;
    chart.levelDec[part] = v - lvl * 10;
  } else {
    chart.level[part] = v;
  }
}

function setLevelDec(chart, part, param) {
  const v = parseInt(param, 10);
  if (Number.isFinite(v)) chart.levelDec[part] = Math.min(Math.max(v, 0), 10);
}

/** ヘッダ 1 行を chart へ反映する(データ行以外)。 */
function applyHeader(chart, o, bpmMap) {
  const cmd = o.cmd;
  const up = cmd.toUpperCase();
  const param = o.param;
  if (up === 'TITLE') chart.title = param;
  else if (up === 'ARTIST') chart.artist = param;
  else if (up === 'COMMENT') chart.comment = param;
  else if (up === 'GENRE') chart.genre = param;
  else if (up === 'PREVIEW') chart.preview = param;
  else if (up === 'PREIMAGE') chart.preimage = param;
  else if (up === 'PREMOVIE') chart.premovie = param;
  else if (up === 'STAGEFILE' || up === 'BACKGROUND') chart.background = param;
  else if (up === 'BPM') {
    const v = tryParseBpm(param);
    if (Number.isFinite(v) && v > 0) chart.bpm = v;
  } else if (takeCommand(o, 'BASEBPM')) {
    const v = tryParseBpm(o.param);
    if (Number.isFinite(v) && v > 0) chart.baseBpm = v;
  } else if (up.length === 5 && up.startsWith('BPM')) {
    const v = tryParseBpm(param);
    if (Number.isFinite(v) && v > 0) {
      const zz = up.slice(3);
      if (zz === '00') chart.bpm = v;
      else bpmMap.set(zz, v);
    }
  } else if (up.length === 5 && up.startsWith('WAV')) {
    if (param) chart.wavDefs.set(up.slice(3), param);
  } else if (up.length === 8 && up.startsWith('VOLUME')) {
    const vol = parseInt(param, 10);
    if (Number.isFinite(vol)) chart.wavVolumes.set(up.slice(6), Math.min(Math.max(vol, 0), 100));
  } else if (up.length === 8 && up.startsWith('WAVVOL')) {
    const vol = parseInt(param, 10);
    if (Number.isFinite(vol)) chart.wavVolumes.set(up.slice(6), Math.min(Math.max(vol, 0), 100));
  } else if (up.length === 5 && up.startsWith('PAN')) {
    const pan = parseInt(param, 10);
    if (Number.isFinite(pan)) chart.wavPans.set(up.slice(3), Math.min(Math.max(pan, -100), 100));
  } else if (up.length === 8 && up.startsWith('WAVPAN')) {
    const pan = parseInt(param, 10);
    if (Number.isFinite(pan)) chart.wavPans.set(up.slice(6), Math.min(Math.max(pan, -100), 100));
  } else if (up.length === 5 && up.startsWith('AVI')) {
    if (param) chart.aviDefs.set(up.slice(3), param);
  } else if (up.length === 5 && up.startsWith('BMP')) {
    if (param) chart.bmpDefs.set(up.slice(3), param);
  } else if (takeCommand(o, 'DLVDEC')) setLevelDec(chart, 0, o.param);
  else if (takeCommand(o, 'GLVDEC')) setLevelDec(chart, 1, o.param);
  else if (takeCommand(o, 'BLVDEC')) setLevelDec(chart, 2, o.param);
  else if (takeCommand(o, 'DLEVEL') || takeCommand(o, 'PLAYLEVEL')) setLevel(chart, 0, o.param);
  else if (takeCommand(o, 'GLEVEL')) setLevel(chart, 1, o.param);
  else if (takeCommand(o, 'BLEVEL')) setLevel(chart, 2, o.param);
}

function parseDataLine(body, chips, state) {
  const colon = body.indexOf(':');
  if (colon < 5) return;
  const measure = parseInt(body.slice(0, 3), 10);
  if (!Number.isFinite(measure)) return;
  const channel = parseInt(body.slice(3, 5), 16);
  if (!Number.isFinite(channel)) return;
  let data = body.slice(colon + 1);
  const semi = data.indexOf(';');
  if (semi !== -1) data = data.slice(0, semi);
  data = data.replace(/[ \t_]/g, ''); // '_' は NX / dtx.py と同じく区切り記号として無視する
  if (data.length === 0) return;

  if (measure > state.maxMeasure) state.maxMeasure = measure;
  const basePos = (measure + 1) * TICKS_PER_MEASURE;

  if (channel === CH_BAR_LENGTH) {
    let v = Number(data);
    if (!Number.isFinite(v)) v = Number(data.replace(',', '.'));
    if (!Number.isFinite(v)) v = 0;
    chips.push({ pos: basePos, channel, wavId: '', value: v, intVal: 0, measure, tick: 0 });
    return;
  }

  const objCount = Math.floor(data.length / 2);
  if (objCount === 0) return;
  for (let i = 0; i < objCount; i++) {
    const id = data.slice(i * 2, i * 2 + 2).toUpperCase();
    if (id === '00') continue;
    const tick = Math.floor((TICKS_PER_MEASURE * i) / objCount);
    const chip = { pos: basePos + tick, channel, wavId: id, value: 0, intVal: 0, measure, tick };
    if (channel === CH_BPM) chip.intVal = parseHex(id);
    else if (channel === CH_FILL_IN || channel === CH_BEAT_LINE_DISPLAY) chip.intVal = parseBase36(id);
    if (channel === CH_FILL_IN) {
      // NX: フィルイン ON チップは 32tick 前へ、OFF チップは 32tick 後ろへずらす
      if (chip.intVal === 1) chip.pos -= 32;
      else if (chip.intVal === 2) chip.pos += 32;
    }
    chips.push(chip);
  }
}

/** 小節線(0x50)と拍線(0x51)を内部生成する(NX 拍子_拍線の挿入)。 */
function insertBarAndBeatLines(chips, maxMeasure) {
  if (chips.length === 0) return;
  let maxPos = (maxMeasure + 1) * TICKS_PER_MEASURE;
  for (const c of chips) if (c.pos > maxPos) maxPos = c.pos;
  const endOfSong = maxPos + TICKS_PER_MEASURE - (maxPos % TICKS_PER_MEASURE);

  const barLengths = new Map();
  const shifts = new Map();
  for (const c of chips) {
    if (c.channel === CH_BAR_LENGTH) {
      barLengths.set(c.pos - (c.pos % TICKS_PER_MEASURE), c.value > 0 ? c.value : 1.0);
    } else if (c.channel === CH_BEAT_LINE_SHIFT) {
      const bar = c.pos - (c.pos % TICKS_PER_MEASURE);
      shifts.set(bar, c.pos - bar);
    }
  }

  let barLen = 1.0;
  for (let tick = 0; tick <= endOfSong; tick += TICKS_PER_MEASURE) {
    const measure = tick / TICKS_PER_MEASURE - 1;
    chips.push({ pos: tick, channel: CH_BAR_LINE, wavId: '', value: 0, intVal: 0, measure, tick: 0, generated: true, visible: true });
    if (tick >= endOfSong) break;
    if (barLengths.has(tick)) barLen = barLengths.get(tick);
    const shift = shifts.has(tick) ? shifts.get(tick) : 0;
    for (let i = 0; i < 100; i++) {
      const tickBeat = Math.floor((384.0 * i) / (4.0 * barLen));
      if (tickBeat + shift >= TICKS_PER_MEASURE) break;
      if ((tickBeat + shift) % TICKS_PER_MEASURE === 0) continue;
      chips.push({ pos: tick + tickBeat + shift, channel: CH_BEAT_LINE, wavId: '', value: 0, intVal: 0, measure, tick: tickBeat + shift, generated: true, visible: true });
    }
  }
}

/** 0xC2(拍線_小節線表示指定)を内部生成の線へ反映する。01=表示 / 02=非表示。同一位置で先に並ぶ線にも遡る。 */
function applyBeatLineDisplay(chips) {
  let show = true;
  for (let i = 0; i < chips.length; i++) {
    let changed = false;
    if (chips[i].channel === CH_BEAT_LINE_DISPLAY) {
      if (chips[i].intVal === 1) { show = true; changed = true; }
      else if (chips[i].intVal === 2) { show = false; changed = true; }
    }
    let start = i;
    if (changed) {
      while (start > 0 && chips[start].pos === chips[i].pos) start--;
      start++;
    }
    for (let j = start; j <= i; j++) {
      const c = chips[j];
      if (c.generated && (c.channel === CH_BAR_LINE || c.channel === CH_BEAT_LINE)) c.visible = show;
    }
  }
}

/**
 * DTX テキストを解析する。
 * @param {string} text
 * @param {{random?: () => number}} [opts] #RANDOM 用の乱数(テストで固定できる)
 */
export function parseDTX(text, opts = {}) {
  const chart = newChart();
  const chips = [];
  const bpmMap = chart.bpmDefs;
  const state = { maxMeasure: 0 };
  const ifStack = new IfStack(opts.random || Math.random);
  const lines = splitLines(text);
  chart.rawLines = lines;

  for (const line of lines) {
    const s = line.replace(/^[ \t]+/, '');
    if (s.length < 2 || s[0] !== '#') continue;
    const body = s.slice(1);
    const o = splitHeader(body);
    if (ifStack.skipsLine(o)) continue;
    if (isDataLine(body)) {
      parseDataLine(body, chips, state);
      continue;
    }
    applyHeader(chart, o, bpmMap);
  }

  insertBarAndBeatLines(chips, state.maxMeasure);
  chips.sort((a, b) => (a.pos !== b.pos ? a.pos - b.pos : ctrlPriority(a.channel) - ctrlPriority(b.channel)));
  applyBeatLineDisplay(chips);

  const bonusMarks = [];
  let currMs = 0.0;
  let bpm = chart.bpm;
  let barLen = 1.0;
  let lastPos = 0;
  if (bpm <= 0) bpm = 120.0;
  chart.bpmChanges.push({ timeMs: 0, bpm });

  for (const chip of chips) {
    const t = currMs + (625.0 * (chip.pos - lastPos) * barLen) / bpm;
    chip.timeMs = Math.round(t);
    const ch = chip.channel;
    if (ch === CH_BAR_LENGTH) {
      lastPos = chip.pos; currMs = t; barLen = chip.value > 0 ? chip.value : 1.0;
    } else if (ch === CH_BPM) {
      lastPos = chip.pos; currMs = t; bpm = chart.baseBpm + chip.intVal; if (bpm <= 0) bpm = chart.bpm;
      chart.bpmChanges.push({ timeMs: chip.timeMs, bpm });
    } else if (ch === CH_BPM_EX) {
      lastPos = chip.pos; currMs = t;
      const exb = bpmMap.get(chip.wavId);
      if (exb !== undefined && chart.baseBpm + exb > 0) bpm = chart.baseBpm + exb;
      chart.bpmChanges.push({ timeMs: chip.timeMs, bpm });
    } else if (ch === CH_BAR_LINE || ch === CH_BEAT_LINE) {
      chart.barLines.push({ timeMs: chip.timeMs, isBeat: ch === CH_BEAT_LINE, visible: chip.visible !== false, measure: chip.measure, pos: chip.pos });
    } else if (ch === CH_BGM) {
      chart.bgmEvents.push({ timeMs: chip.timeMs, wavId: chip.wavId, pos: chip.pos });
    } else if (ch === CH_CHEER) {
      chart.cheerEvents.push({ timeMs: chip.timeMs, wavId: chip.wavId, channel: ch });
    } else if (ch === CH_FILL_IN) {
      if (chip.intVal >= 1 && chip.intVal <= 6) chart.fillInEvents.push({ timeMs: chip.timeMs, value: chip.intVal });
    } else if (ch === CH_MOVIE) {
      chart.movieEvents.push({ timeMs: chip.timeMs, wavId: chip.wavId });
    } else if (isSeChannel(ch)) {
      chart.seEvents.push({ timeMs: chip.timeMs, wavId: chip.wavId, channel: ch });
    } else if (ch >= CH_BONUS_MIN && ch <= CH_BONUS_MAX) {
      chart.bonusChipCount++;
      const bv = parseBase36(chip.wavId);
      if (bv >= 1 && bv < BONUS_VALUE_TO_LANE.length) bonusMarks.push({ pos: chip.pos, lane: BONUS_VALUE_TO_LANE[bv] });
    } else {
      const hidden = ch >= CH_HIDDEN_MIN && ch <= CH_HIDDEN_MAX;
      const visibleChannel = hidden ? ch - 0x20 : ch;
      const lane = CHANNEL_TO_LANE[visibleChannel];
      if (lane !== undefined) {
        const note = {
          timeMs: chip.timeMs, lane, wavId: chip.wavId, channel: visibleChannel, pos: chip.pos,
          measure: chip.measure, tick: chip.tick, bonus: false, hidden,
        };
        if (hidden) chart.hiddenNotes.push(note);
        else {
          chart.notes.push(note);
          chart.laneHasNotes[lane] = true;
          if (chip.timeMs > chart.lastNoteMs) chart.lastNoteMs = chip.timeMs;
        }
      }
    }
  }

  for (const mark of bonusMarks) {
    for (const n of chart.notes) if (n.pos === mark.pos && n.lane === mark.lane) n.bonus = true;
  }

  const byTime = (a, b) => a.timeMs - b.timeMs;
  chart.notes.sort(byTime);
  chart.hiddenNotes.sort(byTime);
  chart.barLines.sort(byTime);
  chart.fillInEvents.sort(byTime);
  chart.cheerEvents.sort(byTime);
  chart.seEvents.sort(byTime);
  chart.bgmEvents.sort(byTime);
  chart.durationMs = chart.lastNoteMs;
  return chart;
}

/**
 * ヘッダのみ読む(選曲リスト用)。#IF 外で最初のデータ行に到達したら以降のヘッダ命令は読まない(DtxHeader 準拠)。
 * @param {string} text
 */
export function parseDTXHeader(text) {
  const chart = newChart();
  const bpmMap = chart.bpmDefs;
  const ifStack = new IfStack();
  let bodyStarted = false;
  for (const line of splitLines(text)) {
    const s = line.replace(/^[ \t]+/, '');
    if (s.length < 2 || s[0] !== '#') continue;
    const body = s.slice(1);
    const o = splitHeader(body);
    if (ifStack.skipsLine(o)) continue;
    if (/^[0-9]{3}/.test(body)) {
      if (!ifStack.inIfBlock) bodyStarted = true;
      // 楽器ごとの譜面有無(ドラムのみ)
      const ch = parseInt(body.slice(3, 5), 16);
      if (Number.isFinite(ch)) {
        const vis = ch >= CH_HIDDEN_MIN && ch <= CH_HIDDEN_MAX ? ch - 0x20 : ch;
        const lane = CHANNEL_TO_LANE[vis];
        if (lane !== undefined && !chart.laneHasNotes[lane]) {
          const colon = body.indexOf(':');
          const data = colon >= 0 ? body.slice(colon + 1) : '';
          if (/[^0 \t_;]/.test(data.split(';')[0])) chart.laneHasNotes[lane] = true;
        }
      }
      continue;
    }
    if (bodyStarted) continue;
    applyHeader(chart, o, bpmMap);
  }
  chart.rawLines = [];
  return chart;
}

/** 再生に必要な #WAVxx の id を重複なく並べて返す(BGM が先頭)。 */
export function requiredWavIds(chart) {
  const seen = new Set();
  const ordered = [];
  const add = (id) => {
    const key = (id || '').toUpperCase();
    if (key.length > 0 && key !== '00' && !seen.has(key)) {
      seen.add(key);
      ordered.push(key);
    }
  };
  for (const n of chart.bgmEvents) add(n.wavId);
  for (const n of chart.notes) add(n.wavId);
  for (const n of chart.hiddenNotes) add(n.wavId);
  for (const n of chart.seEvents) add(n.wavId);
  for (const n of chart.cheerEvents) add(n.wavId);
  return ordered;
}

/** 小節頭の時刻一覧(0ms を必ず先頭に含む、時刻順・重複なし。TrainingSettings.BuildMeasureTimes)。 */
export function buildMeasureTimes(chart) {
  const times = [0];
  if (chart) {
    for (const b of chart.barLines) {
      if (b.isBeat) continue;
      if (b.timeMs <= times[times.length - 1]) continue;
      times.push(b.timeMs);
    }
  }
  return times;
}

/** timeMs を含む小節の添字(times[i] <= timeMs となる最大の i)。 */
export function measureIndexAt(times, timeMs) {
  if (!times || times.length === 0) return 0;
  let lo = 0;
  let hi = times.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= timeMs) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}
