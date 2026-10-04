import { test, assert, assertEq, assertDeepEq } from './runner.js';
import {
  LANE_COUNT, MAX_KEYS_PER_LANE, RESERVED_CODES, addKey, replaceKey, removeKey, clearLane, resetLane,
  defaultBindings, normalizeBindings, isAssignableCode, isModifierCode, findCode, laneKeysText,
} from '../js/ui/keybind.js';
import { DrumInput, LANE_KEY_DEFAULTS } from '../js/ui/input.js';
import { GB_KEY_DEFAULTS, GB_KEY_LEFTY, GB_BUTTON_NAMES } from '../js/ui/gbinput.js';
import { KeyBindPanel } from '../js/ui/keypanel.js';
import { t } from '../js/i18n.js';

// レーン: 0 LC / 1 HH / 2 LP / 3 SD / 4 HT / 5 BD / 6 LT / 7 FT / 8 CY / 9 RD

test('keybind: assignable codes', () => {
  assertEq(isAssignableCode('KeyA'), true);
  assertEq(isAssignableCode('F11'), true); // main.js の onKey が false を返して素通りする
  assertEq(isAssignableCode('Space'), true); // BD の既定キー
  assertEq(isAssignableCode(''), false);
  assertEq(isAssignableCode(null), false);
  assertEq(isAssignableCode('ShiftLeft'), false);
  assertEq(isModifierCode('AltRight'), true);
  assertEq(isModifierCode('KeyA'), false);
  for (const code of RESERVED_CODES) assertEq(isAssignableCode(code), false, code);
  // 演奏中にアプリが実際に食うキーが予約に入っていること
  for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'NumpadEnter', 'Escape', 'F1']) {
    assert(RESERVED_CODES.includes(code), code + ' が予約されていない');
  }
});

test('keybind: add appends, stays unique across lanes, respects the 12 cap', () => {
  let b = defaultBindings();
  const r1 = addKey(b, 1, 'KeyQ');
  assertEq(r1.ok, true);
  assertDeepEq(r1.bindings[1], ['KeyS', 'KeyQ'], '末尾に足す(先頭挿入にしない)');
  assertDeepEq(b[1], ['KeyS'], '元の配列は書き換えない');

  // 他レーンが持っているキーは取り上げる
  const r2 = addKey(r1.bindings, 1, 'KeyD'); // KeyD は SD(3)
  assertEq(r2.ok, true);
  assertEq(r2.stolenFrom, 3);
  assertEq(r2.stolenEmptied, true);
  assertDeepEq(r2.bindings[3], [], '空になっても既定キーで復活させない');
  assertDeepEq(r2.bindings[1], ['KeyS', 'KeyQ', 'KeyD']);
  assertEq(findCode(r2.bindings, 'KeyD').lane, 1, '同じキーが 2 レーンに載らない');

  // 同じレーンに入っているキーは拒否(待ち受けは継続させたいので reason で区別する)
  const dup = addKey(r2.bindings, 1, 'KeyQ');
  assertEq(dup.ok, false);
  assertEq(dup.reason, 'already');

  // 予約キーは拒否
  assertEq(addKey(b, 0, 'Enter').reason, 'reserved');

  // 上限 12
  b = defaultBindings();
  const extra = ['KeyQ', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'KeyZ', 'KeyX'];
  for (const code of extra) b = addKey(b, 1, code).bindings;
  assertEq(b[1].length, MAX_KEYS_PER_LANE);
  const over = addKey(b, 1, 'KeyC');
  assertEq(over.ok, false);
  assertEq(over.reason, 'full');
  assertEq(over.bindings[1].length, MAX_KEYS_PER_LANE);
});

test('keybind: replace keeps position and swaps 1:1 with the other lane', () => {
  const b = defaultBindings();
  // 他レーンが持っていないキー
  const r1 = replaceKey(b, 0, 0, 'KeyQ');
  assertEq(r1.ok, true);
  assertEq(r1.swappedWith, null);
  assertDeepEq(r1.bindings[0], ['KeyQ']);

  // 他レーンが持っているキー → 1:1 スワップ(相手は空にならない)
  const r2 = replaceKey(b, 0, 0, 'KeyD'); // KeyD は SD(3)
  assertEq(r2.ok, true);
  assertEq(r2.swappedWith, 3);
  assertDeepEq(r2.bindings[0], ['KeyD']);
  assertDeepEq(r2.bindings[3], ['KeyA'], '奪った側の旧キーが相手に入る');

  // 位置を動かさない
  let m = addKey(defaultBindings(), 1, 'KeyQ').bindings; // HH = [S, Q]
  m = replaceKey(m, 1, 0, 'KeyG').bindings;
  assertDeepEq(m[1], ['KeyG', 'KeyQ'], '差し替えても並びは変わらない');

  // 同じレーン内のキーを指定すると位置が入れ替わる
  const same = replaceKey(m, 1, 0, 'KeyQ');
  assertEq(same.ok, true);
  assertEq(same.swappedWith, 1);
  assertDeepEq(same.bindings[1], ['KeyQ', 'KeyG']);

  assertEq(replaceKey(b, 0, 0, 'KeyA').reason, 'same');
  assertEq(replaceKey(b, 0, 5, 'KeyQ').reason, 'missing');
  assertEq(replaceKey(b, 0, 0, 'ArrowUp').reason, 'reserved');
});

test('keybind: remove / clear / resetLane', () => {
  let b = addKey(defaultBindings(), 1, 'KeyQ').bindings; // HH = [S, Q]
  const r = removeKey(b, 1, 0);
  assertEq(r.ok, true);
  assertEq(r.removed, 'KeyS');
  assertEq(r.emptied, false);
  assertDeepEq(r.bindings[1], ['KeyQ']);
  assertEq(removeKey(r.bindings, 1, 0).emptied, true);
  assertEq(removeKey(b, 1, 9).ok, false);

  assertDeepEq(clearLane(b, 1).bindings[1], []);

  // レーン単位の既定復帰。既定キーを他レーンが持っていれば取り上げる
  b = addKey(defaultBindings(), 0, 'KeyS').bindings; // LC が HH の S を奪った → HH は空
  assertDeepEq(b[1], []);
  const back = resetLane(b, 1);
  assertDeepEq(back.bindings[1], ['KeyS']);
  assertDeepEq(back.stolenFrom, [0]);
  assertDeepEq(back.stolenEmptied, [], 'LC には A が残るので空にはならない');
  assertDeepEq(back.bindings[0], ['KeyA'], '取り上げられた側から S が消える');

  // 相手が 1 キーしか持っていなければ、取り上げた結果そのレーンが未割り当てになる
  let c = addKey(defaultBindings(), 8, 'KeyA').bindings; // CY = [L, A]、LC = []
  c = removeKey(c, 8, 0).bindings; // CY = [A]
  const back2 = resetLane(c, 0);
  assertDeepEq(back2.bindings[0], ['KeyA']);
  assertDeepEq(back2.bindings[8], []);
  assertDeepEq(back2.stolenEmptied, [8], '空になったレーンを呼び出し側に伝える');

  // 既に既定を持っているレーンは誰からも取り上げない
  const keep = resetLane(addKey(defaultBindings(), 1, 'KeyQ').bindings, 1);
  assertDeepEq(keep.bindings[1], ['KeyS']);
  assertDeepEq(keep.stolenFrom, []);
});

test('keybind: normalizeBindings repairs config lane by lane', () => {
  const norm = (raw) => normalizeBindings(raw).bindings;
  assertDeepEq(norm(defaultBindings()), defaultBindings(), '正常な設定は素通し');
  assertDeepEq(normalizeBindings(defaultBindings()).repaired, [], '直すところが無ければ repaired は空');
  assertDeepEq(norm(undefined), defaultBindings());
  assertDeepEq(norm([]), defaultBindings());
  assertDeepEq(normalizeBindings([]).repaired, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  // ユーザーが自分で空にしたレーンは意図的な未割り当て。既定で埋め戻さないし repaired にも載せない
  const withNone = defaultBindings();
  withNone[4] = [];
  assertDeepEq(norm(withNone)[4], []);
  assertDeepEq(normalizeBindings(withNone).repaired, []);

  // 長さが足りなくても、ある分は残して足りないレーンだけ既定で埋める
  const short = defaultBindings().slice(0, 9);
  short[0] = ['KeyZ'];
  const fixed = normalizeBindings(short);
  assertEq(fixed.bindings.length, LANE_COUNT);
  assertDeepEq(fixed.bindings[0], ['KeyZ'], '1 レーンの欠落で他レーンの設定を捨てない');
  assertDeepEq(fixed.bindings[9], LANE_KEY_DEFAULTS[9]);
  assertDeepEq(fixed.repaired, [9]);

  // 長すぎる場合は 10 に切る
  assertEq(norm(defaultBindings().concat([['KeyZ']])).length, LANE_COUNT);

  // 文字列以外・予約キー・レーン内重複・上限超過を落とす
  const dirty = defaultBindings();
  dirty[0] = ['KeyA', 'KeyA', 'Enter', 'ArrowUp', 42, null, 'KeyZ'];
  assertDeepEq(norm(dirty)[0], ['KeyA', 'KeyZ']);
  const many = defaultBindings();
  many[0] = [];
  for (let i = 0; i < 20; i++) many[0].push('Digit' + (i % 10) + '_' + i);
  assertEq(norm(many)[0].length, MAX_KEYS_PER_LANE);

  // レーン間の重複は若いレーンが勝つ
  const dup = defaultBindings();
  dup[5] = ['Space', 'KeyA'];
  const ded = norm(dup);
  assertDeepEq(ded[0], ['KeyA']);
  assertDeepEq(ded[5], ['Space']);

  // 中身はあったのに全部落ちたレーン(旧版が保存できてしまった予約キーだけ、など)は壊れている扱い。
  // 既定を入れ直し、直したことを repaired で知らせる
  for (const junk of [['Tab'], ['ArrowLeft'], ['Enter'], [42, null, {}]]) {
    const b = defaultBindings();
    b[4] = junk;
    const r = normalizeBindings(b);
    assertDeepEq(r.bindings[4], LANE_KEY_DEFAULTS[4], JSON.stringify(junk));
    assertDeepEq(r.repaired, [4], JSON.stringify(junk));
  }

  // 修復は他レーンの生きている設定を壊してまではやらない(埋まらなければ空のまま repaired に載る)
  const broken = defaultBindings();
  broken[0] = ['KeyD']; // LC がユーザー操作で SD の既定キーを持っている
  broken[3] = 'not-an-array';
  const rep = normalizeBindings(broken);
  assertDeepEq(rep.bindings[0], ['KeyD'], '正しく設定されているレーンを巻き添えにしない');
  assertDeepEq(rep.bindings[3], [], '奪えないので空のまま');
  assertDeepEq(rep.repaired, [3], '直しきれなかったことは呼び出し側に伝える');

  // 旧形式(レーンが文字列)でも全部は捨てない
  const old = defaultBindings();
  old[2] = 'KeyW';
  assertDeepEq(norm(old)[2], LANE_KEY_DEFAULTS[2]);
  assertDeepEq(norm(old)[1], LANE_KEY_DEFAULTS[1]);

  // 冪等(直した結果をもう一度通しても変わらない)
  const once = normalizeBindings(broken);
  const twice = normalizeBindings(once.bindings);
  assertDeepEq(twice.bindings, once.bindings);
  assertDeepEq(twice.repaired, [], '2 回目は直すところが無い');
});

test('keybind: laneKeysText', () => {
  assertEq(laneKeysText(['KeyA', 'Space']), 'A / Space');
  assertEq(laneKeysText([]), 'なし');
  assertEq(laneKeysText(undefined), 'なし');
});

test('input: multiple keys on one lane all fire, and each is a separate hit', () => {
  const hits = [];
  const input = new DrumInput({ onHit: (lane, ts, src) => hits.push({ lane, ts, src }) });
  const b = defaultBindings();
  b[1] = ['KeyS', 'KeyQ', 'KeyH']; // HH に 3 キー
  input.setBindings(b);

  assertEq(input.laneOfCode('KeyS'), 1);
  assertEq(input.laneOfCode('KeyQ'), 1);
  assertEq(input.laneOfCode('KeyH'), 1);
  assertEq(input.laneOfCode('KeyA'), 0);
  assertEq(input.laneOfCode('KeyZ'), -1);

  const press = (code, ts) => input._onKeyDown({ code, key: '', timeStamp: ts, repeat: false, target: document.body, preventDefault() {} });
  const release = (code) => input._onKeyUp({ code, key: '', target: document.body });

  press('KeyQ', 100);
  press('KeyH', 110); // KeyQ を押したままでも別の打鍵になる(両手で交互に叩ける)
  assertEq(hits.length, 2);
  assertDeepEq(hits.map((h) => h.lane), [1, 1]);

  press('KeyQ', 120); // 押しっぱなしの再入力は無視
  assertEq(hits.length, 2);
  release('KeyQ');
  press('KeyQ', 130);
  assertEq(hits.length, 3);

  // 割り当てを外したキーは鳴らない
  input.setBindings(removeKey(b, 1, 1).bindings);
  release('KeyQ');
  press('KeyQ', 140);
  assertEq(hits.length, 3);
});

test('keybind: guitar / bass bindings use their own defaults (7 buttons)', () => {
  const b = defaultBindings(GB_KEY_DEFAULTS);
  assertEq(b.length, 7);
  assertDeepEq(b[5], ['KeyJ', 'KeyK'], 'two pick keys for alternate picking');
  for (const codes of GB_KEY_DEFAULTS) for (const code of codes) assertEq(isAssignableCode(code), true, code + ' must be assignable');
  const norm = normalizeBindings([['KeyA'], 'broken', ['KeyD'], ['KeyF'], ['KeyG'], ['KeyJ', 'KeyK'], ['KeyL']], GB_KEY_DEFAULTS);
  assertDeepEq(norm.repaired, [1]);
  assertDeepEq(norm.bindings[1], ['KeyS']);
  assertEq(normalizeBindings(null, GB_KEY_DEFAULTS).bindings.length, 7);
  const moved = addKey(b, 0, 'KeyL').bindings; // WAIL の L を R へ
  assertDeepEq(moved[6], []);
  const back = resetLane(moved, 6, GB_KEY_DEFAULTS);
  assertDeepEq(back.bindings[6], ['KeyL']);
  assertDeepEq(back.stolenFrom, [0]);
  assertEq(laneKeysText(b[5]), 'J / K');
});

test('keybind: the lefty layout mirrors the guitar defaults across the keyboard centre', () => {
  const mirror = { KeyA: 'Semicolon', KeyS: 'KeyL', KeyD: 'KeyK', KeyF: 'KeyJ', KeyG: 'KeyH', KeyJ: 'KeyF', KeyK: 'KeyD', KeyL: 'KeyS' };
  assertEq(GB_KEY_LEFTY.length, 7);
  for (let i = 0; i < 7; i++) assertDeepEq(GB_KEY_LEFTY[i], GB_KEY_DEFAULTS[i].map((c) => mirror[c]), GB_BUTTON_NAMES[i]);
  for (const codes of GB_KEY_LEFTY) for (const code of codes) assertEq(isAssignableCode(code), true, code + ' must be assignable');
  const all = GB_KEY_LEFTY.flat();
  assertEq(new Set(all).size, all.length, 'no key on two buttons');
  assertEq(normalizeBindings(GB_KEY_LEFTY, GB_KEY_DEFAULTS).repaired.length, 0, 'a valid saved layout');
});

test('keybind: a preset button replaces all bindings and can be undone', () => {
  const host = document.createElement('div');
  host.innerHTML = '<div class="list"></div><span class="status"></span><button class="undo" hidden></button><button class="reset"></button><button class="lefty"></button>';
  document.body.appendChild(host);
  let bindings = defaultBindings(GB_KEY_DEFAULTS);
  let changes = 0;
  const panel = new KeyBindPanel({
    list: host.querySelector('.list'),
    statusText: host.querySelector('.status'),
    undoButton: host.querySelector('.undo'),
    resetAllButton: host.querySelector('.reset'),
    names: GB_BUTTON_NAMES,
    defaults: GB_KEY_DEFAULTS,
    getBindings: () => bindings,
    setBindings: (next) => { bindings = next; },
    onChange: () => changes++,
    presets: [{ button: host.querySelector('.lefty'), bindings: GB_KEY_LEFTY, done: 'keys.leftyDone' }],
  });
  try {
    panel.build();
    host.querySelector('.lefty').click();
    assertDeepEq(bindings, GB_KEY_LEFTY);
    assert(bindings[5] !== GB_KEY_LEFTY[5], 'a copy (editing the bindings does not change the preset)');
    assertEq(host.querySelector('.status').textContent, t('keys.leftyDone'));
    assertEq(host.querySelector('.undo').hidden, false, 'undo offered');
    assert(changes > 0, 'onChange called (help keys refresh)');
    assert(host.querySelector('.list').textContent.includes(';'), 'rows re-rendered with the new keys');
    host.querySelector('.undo').focus();
    host.querySelector('.undo').click();
    assertDeepEq(bindings, defaultBindings(GB_KEY_DEFAULTS), 'undo restores the previous bindings');
    assertEq(document.activeElement, host.querySelector('.lefty'), 'focus goes back to the preset button, not reset all');
    host.querySelector('.lefty').click();
    host.querySelector('.reset').click();
    assertDeepEq(bindings, defaultBindings(GB_KEY_DEFAULTS), 'reset all goes back to the defaults');
  } finally {
    panel.cancelAssign();
    host.remove();
  }
});
