// キー割り当ての純ロジック(DOM に触らない)。UI は js/main.js、実行時の照合は js/ui/input.js。
// 元実装(DTXManiaAI / NX)の CONFIG > Key Assign に合わせる:
//   ・1 レーンあたり最大 12 キー(docs/spec/nx-docs.md:250、docs/spec/judge-score.md:315。18:190 の 8 から 22:64 で 12 へ)
//   ・差し替えは 1:1 スワップ、追加は他レーンから取り上げ(nx-docs.md:251)
//   ・同じキーが 2 レーンに同時に載ることはない(nx-docs.md:251)
//   ・空レーンは「意図的な未割り当て」で、既定キーで勝手に復活させない(nx-docs.md:250 の None)
// MIDI / ゲームパッドのトークン(`Midi:38` など)は ini 用の文法なので Web 版には持ち込まない。
// 電子ドラム(MIDI)は js/ui/midibind.js で別に持つ(config.midiNotes)。ゲームパッドは未対応。
// 保存形式は config.bindings: string[][](レーン → KeyboardEvent.code)のまま。

import { LANE_KEY_DEFAULTS, keyLabel } from './input.js';

export const LANE_COUNT = LANE_KEY_DEFAULTS.length;

// 上限 12 は元実装のトークン数上限。あちらはキー 1 + MIDI 3 のような混在で 12 だが、Web 版の MIDI は
// 別枠(js/ui/midibind.js の MAX_NOTES_PER_LANE)なので、キーボードだけで 12 埋めても MIDI は減らない
// (docs/spec/judge-score.md:315)。
export const MAX_KEYS_PER_LANE = 12;

// 割り当て不可のキー。
// 矢印 4 種 / Enter / NumpadEnter / Escape は演奏中にトレーニングメニューが食う(js/ui/menu.js の keyDown)。
// F1 は AUTO 切替(js/main.js の onKey)。DrumInput は laneOfCode より先に onKey フックを呼ぶので、
// これらを割り当てても叩いた分はレーンに届かない(= 無反応なレーンになる)。
// Tab はこの設定 UI 自体の移動に要るため予約する。
// F11 は onKey が false を返して素通りするので、あえて予約しない。
export const RESERVED_CODES = [
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Enter', 'NumpadEnter', 'Escape', 'Tab', 'F1',
];

const MODIFIER_RE = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

function copyBindings(bindings) {
  return bindings.map((a) => a.slice());
}

/** 修飾キー単体か(押し途中なので割り当てもエラーもしない)。 */
export function isModifierCode(code) {
  return MODIFIER_RE.test(code || '');
}

/** レーンに割り当ててよいキーか。 */
export function isAssignableCode(code) {
  if (!code || typeof code !== 'string') return false;
  if (isModifierCode(code)) return false;
  return RESERVED_CODES.indexOf(code) < 0;
}

/** 既定の割り当て(10 レーン分の新しい配列)。 */
export function defaultBindings() {
  return LANE_KEY_DEFAULTS.map((a) => a.slice());
}

/** code を持っているレーンと位置。無ければ null。 */
export function findCode(bindings, code) {
  for (let lane = 0; lane < bindings.length; lane++) {
    const i = bindings[lane].indexOf(code);
    if (i >= 0) return { lane, index: i };
  }
  return null;
}

/**
 * 保存済み config(壊れている / 古い形式かもしれない)を 10 レーン × 重複無しの形に整える。
 * レーン単位で直すので、1 レーンが壊れていても他 9 レーンの設定は捨てない。
 *
 * 「壊れたレーン」= 配列ですらない、または中身はあったのに全部落ちた(旧版が保存できてしまった
 * 予約キーだけのレーンなど)。これは既定を入れ直す。ユーザーが自分で空にしたレーン([])は
 * 意図的な未割り当て(None)なのでそのまま残す。
 * 修復は他レーンの設定を壊してまでは行わない(既に使われているキーは奪わない)ので、
 * 埋められなかったレーンは空のまま returned.repaired に載る(呼び出し側で知らせる)。
 *
 * @returns {{bindings:string[][], repaired:number[]}}
 */
export function normalizeBindings(raw) {
  const src = Array.isArray(raw) ? raw : [];
  const cleaned = [];
  const broken = [];
  for (let lane = 0; lane < LANE_COUNT; lane++) {
    const given = Array.isArray(src[lane]);
    const list = given ? src[lane] : [];
    const clean = [];
    for (const v of list) {
      const code = typeof v === 'string' ? v : '';
      if (!isAssignableCode(code)) continue; // 予約キーが紛れ込んでいたら落とす(叩いても鳴らないため)
      if (clean.indexOf(code) >= 0) continue;
      if (clean.length >= MAX_KEYS_PER_LANE) break;
      clean.push(code);
    }
    broken.push(!given || (list.length > 0 && clean.length === 0));
    cleaned.push(clean);
  }

  const owner = new Set();
  const take = (code) => {
    if (owner.has(code)) return false;
    owner.add(code);
    return true;
  };
  const bindings = new Array(LANE_COUNT);
  // 生きているレーンを先に確定させる(壊れたレーンの修復で、正しく設定されたレーンを空にしない)
  for (let lane = 0; lane < LANE_COUNT; lane++) if (!broken[lane]) bindings[lane] = cleaned[lane].filter(take);
  const repaired = [];
  for (let lane = 0; lane < LANE_COUNT; lane++) {
    if (!broken[lane]) continue;
    bindings[lane] = LANE_KEY_DEFAULTS[lane].filter(take);
    repaired.push(lane);
  }
  return { bindings, repaired };
}

/**
 * レーンの末尾にキーを足す。他レーンが持っていれば取り上げる(元実装と同じ)。
 * @returns {{bindings:string[][], ok:boolean, reason:?string, stolenFrom:?number, stolenEmptied:boolean}}
 *          reason は 'reserved' | 'already' | 'full'
 */
export function addKey(bindings, lane, code) {
  if (!isAssignableCode(code)) return { bindings, ok: false, reason: 'reserved', stolenFrom: null, stolenEmptied: false };
  if (bindings[lane].indexOf(code) >= 0) return { bindings, ok: false, reason: 'already', stolenFrom: null, stolenEmptied: false };
  if (bindings[lane].length >= MAX_KEYS_PER_LANE) return { bindings, ok: false, reason: 'full', stolenFrom: null, stolenEmptied: false };
  const next = copyBindings(bindings);
  const at = findCode(next, code);
  let stolenFrom = null;
  let stolenEmptied = false;
  if (at) {
    next[at.lane].splice(at.index, 1);
    stolenFrom = at.lane;
    stolenEmptied = next[at.lane].length === 0; // 空になっても既定では埋めない(None)
  }
  next[lane].push(code); // 順序は追加順(先頭挿入にすると押すたび並びが入れ替わる)
  return { bindings: next, ok: true, reason: null, stolenFrom, stolenEmptied };
}

/**
 * レーン内の index 番目を code に差し替える。他レーンが持っていれば 1:1 で入れ替える(nx-docs.md:251 の swap)。
 * 位置は動かさないので、並びが勝手に変わらない。
 * @returns {{bindings:string[][], ok:boolean, reason:?string, swappedWith:?number}}
 *          reason は 'reserved' | 'missing' | 'same'
 */
export function replaceKey(bindings, lane, index, code) {
  if (!isAssignableCode(code)) return { bindings, ok: false, reason: 'reserved', swappedWith: null };
  const old = bindings[lane][index];
  if (old === undefined) return { bindings, ok: false, reason: 'missing', swappedWith: null };
  if (old === code) return { bindings, ok: false, reason: 'same', swappedWith: null };
  const next = copyBindings(bindings);
  const at = findCode(next, code);
  let swappedWith = null;
  if (at) {
    next[at.lane][at.index] = old; // 1:1 なので相手レーンが空になることはない
    swappedWith = at.lane;
  }
  next[lane][index] = code;
  return { bindings: next, ok: true, reason: null, swappedWith };
}

/**
 * レーンから 1 個だけ外す。
 * @returns {{bindings:string[][], ok:boolean, removed:?string, emptied:boolean}}
 */
export function removeKey(bindings, lane, index) {
  const code = bindings[lane][index];
  if (code === undefined) return { bindings, ok: false, removed: null, emptied: false };
  const next = copyBindings(bindings);
  next[lane].splice(index, 1);
  return { bindings: next, ok: true, removed: code, emptied: next[lane].length === 0 };
}

/** レーンを空(None = 意図的な未割り当て)にする。 */
export function clearLane(bindings, lane) {
  const next = copyBindings(bindings);
  next[lane] = [];
  return { bindings: next, ok: true };
}

/**
 * レーンだけ既定に戻す。既定キーを他レーンが持っていれば取り上げる(重複させないため)。
 * @returns {{bindings:string[][], ok:boolean, stolenFrom:number[], stolenEmptied:number[]}}
 *          stolenEmptied は取り上げた結果、空(= 未割り当て)になったレーン
 */
export function resetLane(bindings, lane) {
  const next = copyBindings(bindings);
  next[lane] = [];
  const stolenFrom = [];
  for (const code of LANE_KEY_DEFAULTS[lane]) {
    const at = findCode(next, code);
    if (at) {
      next[at.lane].splice(at.index, 1);
      if (stolenFrom.indexOf(at.lane) < 0) stolenFrom.push(at.lane);
    }
    next[lane].push(code);
  }
  // 同じレーンから 2 キー取り上げて最後に空になる場合も拾うため、まとめて最後に見る
  const stolenEmptied = stolenFrom.filter((l) => next[l].length === 0);
  return { bindings: next, ok: true, stolenFrom, stolenEmptied };
}

/** レーンの割り当てを 1 行で表す("A / Q"、空なら "なし")。 */
export function laneKeysText(codes) {
  return codes && codes.length ? codes.map(keyLabel).join(' / ') : 'なし';
}
