// ギターコントローラ(ゲームパッド): 符号・軸 / ハットの読み方・押す / 離すの拾い方と順番・時刻・抜き差し・押して追加・
// 割り当て欄・GuitarInput への渡し方・演奏での判定。navigator.getGamepads の代わりに偽のゲームパッドを渡す。
import { test, assert, assertEq, assertNear, assertDeepEq } from './runner.js';
import {
  GamepadInput, GB_PAD_DEFAULTS, PAD_BUTTON_NAMES, PAD_START, PAD_AXIS_ON, PAD_AXIS_OFF, PAD_POLL_MS, PAD_IDLE_MS,
  parsePadCode, isPadCode, padCodeLabel, hatDirection, codePressed, padTimeStamp, padDevice,
} from '../js/ui/gamepad.js';
import { GuitarInput } from '../js/ui/gbinput.js';
import { KeyBindPanel } from '../js/ui/keypanel.js';
import { defaultBindings, normalizeBindings, isAssignableCode } from '../js/ui/keybind.js';
import { GuitarPlayer } from '../js/game/gbplayer.js';
import { PLAYER_STATE } from '../js/game/player.js';
import { TrainingSettings } from '../js/game/training.js';
import { parseDTX, INSTRUMENT } from '../js/core/dtx.js';
import { t } from '../js/i18n.js';

/** 偽のゲームパッド(Chrome の形: buttons は {pressed, value}、ハットは軸 9 で中央は範囲外)。 */
function fakePad(index = 0, { id = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', mapping = 'standard', buttons = 17, axes = 4 } = {}) {
  return {
    index, id, mapping, connected: true, timestamp: 0,
    buttons: Array.from({ length: buttons }, () => ({ pressed: false, value: 0 })),
    axes: new Array(axes).fill(0),
  };
}
const press = (pad, i, on = true) => { pad.buttons[i] = { pressed: on, value: on ? 1 : 0 }; };

function makeInput(pads, bindings = GB_PAD_DEFAULTS) {
  const ev = [];
  const inputs = [];
  const devices = [];
  const g = new GamepadInput({
    getGamepads: () => pads,
    onButton: (button, down, ts, holder) => ev.push({ button, down, ts, holder }),
    onInput: (info) => inputs.push(info),
    onDevices: (c) => devices.push(c),
  });
  g.setBindings(defaultBindings(bindings));
  return { g, ev, inputs, devices };
}

test('gamepad: codes, labels and the default layout', () => {
  assertDeepEq(parsePadCode('b12'), { kind: 'b', index: 12, dir: '' });
  assertDeepEq(parsePadCode('a3-'), { kind: 'a', index: 3, dir: '-' });
  assertDeepEq(parsePadCode('h9u'), { kind: 'h', index: 9, dir: 'u' });
  for (const bad of ['', 'b', 'x1', 'a3', 'h9x', 'b123', 'KeyA', null]) assertEq(isPadCode(bad), false, String(bad));
  assertEq(padCodeLabel('b0'), 'B0');
  assertEq(padCodeLabel('a3-'), '軸3−');
  assertEq(padCodeLabel('h9d'), 'ハット9↓');
  assertEq(PAD_BUTTON_NAMES.length, GB_PAD_DEFAULTS.length);
  for (const codes of GB_PAD_DEFAULTS) for (const c of codes) {
    assert(isPadCode(c), c);
    assert(isAssignableCode(c), c + ' passes the shared binding rules');
  }
  const all = GB_PAD_DEFAULTS.flat();
  assertEq(new Set(all).size, all.length, 'no input on two rows');
  // XInput のギター: 緑 A(0)・赤 B(1)・黄 Y(3)・青 X(2)・オレンジ LB(4) → R G B Y P、ストラムの上下 → PICK
  assertDeepEq(GB_PAD_DEFAULTS.slice(0, 6), [['b0'], ['b1'], ['b3'], ['b2'], ['b4'], ['b12', 'b13']]);
  assertEq(PAD_BUTTON_NAMES[PAD_START], 'START');
  // 保存の読み直し: 壊れた行は既定へ、キーボードのコードは落とす
  const n = normalizeBindings([['b0'], 'x', ['KeyA'], ['b2'], ['b4'], ['b12'], [], ['b9']], GB_PAD_DEFAULTS, isPadCode);
  assertDeepEq(n.repaired, [1, 2]);
  assertDeepEq(n.bindings[1], ['b1']);
  assertDeepEq(n.bindings[2], ['b3'], 'a keyboard code is not a gamepad input');
  assertDeepEq(n.bindings[6], [], 'an empty row stays empty (intentional)');
});

test('gamepad: axes press at 0.5 and release below 0.35; hats decode to 4 directions with diagonals', () => {
  const pad = fakePad();
  const plus = parsePadCode('a3+');
  const minus = parsePadCode('a3-');
  pad.axes[3] = 0.45;
  assertEq(codePressed(pad, plus, false), false, 'below 0.5');
  pad.axes[3] = PAD_AXIS_ON + 0.01;
  assertEq(codePressed(pad, plus, false), true);
  pad.axes[3] = 0.4;
  assertEq(codePressed(pad, plus, true), true, 'held until it drops below 0.35 (hysteresis)');
  pad.axes[3] = PAD_AXIS_OFF - 0.01;
  assertEq(codePressed(pad, plus, true), false);
  pad.axes[3] = -0.8;
  assertEq(codePressed(pad, minus, false), true, 'negative direction');
  assertEq(codePressed(pad, plus, false), false);
  pad.axes[3] = 1.2857;
  assertEq(codePressed(pad, plus, false), false, 'an out-of-range value (a centred hat) is not an axis press');
  // ハット: 向き k(上から時計回りに 45° ずつ)の値は −1 + 2k/7(Chrome / Firefox)。中央は範囲外の値
  const dirs = ['u', 'r', 'd', 'l'];
  const expect = [['u'], ['u', 'r'], ['r'], ['r', 'd'], ['d'], ['d', 'l'], ['l'], ['u', 'l']];
  const p = fakePad(0, { axes: 10 });
  for (let k = 0; k < 8; k++) {
    const v = -1 + (2 * k) / 7;
    assertEq(hatDirection(v), k, 'direction ' + k);
    p.axes[9] = v;
    assertDeepEq(dirs.filter((d) => codePressed(p, parsePadCode('h9' + d))), dirs.filter((d) => expect[k].includes(d)), 'hat ' + k);
  }
  for (const centre of [1.2857, 3.2857, NaN]) {
    assertEq(hatDirection(centre), -1);
    p.axes[9] = centre;
    assertEq(dirs.some((d) => codePressed(p, parsePadCode('h9' + d))), false, 'centred ' + centre);
  }
  // 時刻: gamepad.timestamp が 1 秒以内ならそれ(今より後にはしない)、そうでなければ今
  assertEq(padTimeStamp({ timestamp: 990 }, 1000), 990);
  assertEq(padTimeStamp({ timestamp: 1003 }, 1000), 1000, 'never later than now');
  assertEq(padTimeStamp({ timestamp: 3.5 }, 5000), 5000, 'Safari seconds → now');
  assertEq(padTimeStamp({}, 5000), 5000);
});

test('gamepad: bound inputs report edges in order (frets before pick), with the sample time; held inputs at first sight are not presses', () => {
  const pad = fakePad();
  press(pad, 1); // 見つかったときに押していた赤(G)
  const { g, ev } = makeInput([pad]);
  g.poll(1000);
  assertEq(ev.length, 0, 'the state at first sight is the baseline');
  press(pad, 1, false);
  pad.timestamp = 1003;
  g.poll(1005);
  assertDeepEq(ev.map((e) => [e.button, e.down, e.ts]), [[1, false, 1003]], 'released (a real change)');
  ev.length = 0;
  // 同じ取得で、緑(R)・黄(B)を押してストラム下(PICK)
  press(pad, 13);
  press(pad, 0);
  press(pad, 3);
  pad.timestamp = 1010;
  g.poll(1012);
  assertDeepEq(ev.map((e) => [e.button, e.down]), [[0, true], [2, true], [5, true]], 'neck first, then the pick');
  assert(ev.every((e) => e.ts === 1010), 'all carry the sample time');
  assertEq(ev[0].holder, 'g0:b0');
  ev.length = 0;
  g.poll(1016);
  assertEq(ev.length, 0, 'no change, no event');
  // ストラム上も PICK(上下どちらでも弾く)。チルト(右スティックの縦、上へ傾けると負)と Back は WAIL、Start は START
  press(pad, 13, false);
  press(pad, 12);
  pad.axes[3] = -0.9;
  press(pad, 9);
  g.poll(1020);
  assertDeepEq(ev.filter((e) => e.down).map((e) => e.button), [5, 6, 7]);
  ev.length = 0;
  pad.axes[3] = -0.4;
  g.poll(1024);
  assertEq(ev.length, 0, 'the tilt stays pressed above the release threshold');
  pad.axes[3] = 0;
  g.poll(1028);
  assertDeepEq(ev.map((e) => [e.button, e.down]), [[6, false]]);
});

test('gamepad: a disconnect releases what was held; another device at the same index starts fresh; devices are reported', () => {
  const pads = [fakePad(0)];
  const { g, ev, devices } = makeInput(pads);
  g.poll(1000);
  assertEq(devices.length, 1);
  assertDeepEq(devices[0].added, ['Xbox 360 Controller (XInput STANDARD GAMEPAD)']);
  assertEq(g.devices.length, 1);
  press(pads[0], 0);
  g.poll(1004);
  ev.length = 0;
  pads[0] = null; // 抜けた
  g.poll(1008);
  assertDeepEq(ev.map((e) => [e.button, e.down, e.ts]), [[0, false, 1008]], 'the held fret is released');
  assertEq(g.devices.length, 0);
  assertDeepEq(devices[1].removed, ['Xbox 360 Controller (XInput STANDARD GAMEPAD)']);
  // 別の機器が同じ番号に。押したまま見つかったボタンは押した扱いにしない
  const other = fakePad(0, { id: '12ba-0100-Guitar Hero3 for PlayStation (R) 3', mapping: '', buttons: 13, axes: 10 });
  other.axes[9] = 3.2857;
  press(other, 0);
  pads[0] = other;
  ev.length = 0;
  g.poll(1012);
  assertEq(ev.length, 0);
  assertEq(g.devices[0].mapping, '');
  // 抜き差しの間に取得が無く、同じ番号に別の機器が来た: 前の機器の押さえは 1 回だけ離し、新しい機器の押したままは押した扱いにしない
  press(other, 1);
  g.poll(1013);
  ev.length = 0;
  const third = fakePad(0, { id: 'Other Guitar' });
  press(third, 1);
  press(third, 13);
  pads[0] = third;
  g.poll(1014);
  // 前の機器で押していた B0(見つけたときから押していた)と B1 を離す。新しい機器の B1・B13 は押した扱いにしない
  assertDeepEq(ev.map((e) => [e.button, e.down, e.ts, e.holder]), [[0, false, 1014, 'g0:b0'], [1, false, 1014, 'g0:b1']],
    'only the old device\'s held inputs are released');
  assertDeepEq(devices[devices.length - 1], { added: ['Other Guitar'], removed: ['12ba-0100-Guitar Hero3 for PlayStation (R) 3'] });
  ev.length = 0;
  press(third, 1, false);
  g.poll(1015);
  press(third, 2);
  g.poll(1016);
  assertDeepEq(ev.map((e) => [e.button, e.down]), [[1, false], [3, true]], 'the new device has its own baseline');
  ev.length = 0;
  // 2 台目(番号 1)。同じ割り当てを全部のゲームパッドに使う。押さえの数え分けは番号ごと
  pads[1] = fakePad(1);
  g.poll(1017);
  press(pads[1], 0);
  g.poll(1020);
  assertDeepEq(ev.map((e) => [e.button, e.down, e.holder]), [[0, true, 'g1:b0']]);
});

test('gamepad: press-to-assign takes the first new input, ignores held / stuck ones, decodes hats and axes, and keeps it from the game', () => {
  const pad = fakePad(0, { id: 'GuitarFreaks', mapping: '', buttons: 16, axes: 10 });
  pad.axes[9] = 3.2857; // ハットは中央(範囲外)
  pad.axes[2] = -1; // ワーミーは休みで −1
  press(pad, 14); // ずっと押されている(PS2 のギターの十字キー左右など)
  const { g, ev } = makeInput([pad]);
  g.watchAll = true;
  g.poll(1000);
  const got = [];
  g.startCapture((code) => got.push(code));
  g.poll(1004);
  assertEq(got.length, 0, 'inputs that stay held (the stuck button, the resting whammy) never make an edge');
  g.cancelCapture();
  // 前の取得の後で押し、押したまま待ち始めた入力は数えない(待ち始めを基準にする)
  press(pad, 0);
  press(pad, 1);
  g.startCapture((code) => got.push(code));
  g.poll(1005);
  assertEq(got.length, 0, 'inputs held when the wait starts do not count');
  press(pad, 0, false);
  press(pad, 1, false);
  g.poll(1006);
  assertEq(got.length, 0, 'releases do not count');
  press(pad, 0);
  g.poll(1007);
  assertDeepEq(got, ['b0'], 'pressing it again does');
  got.length = 0;
  press(pad, 0, false);
  g.poll(1007.5);
  g.startCapture((code) => got.push(code));
  g.poll(1007.8);
  pad.axes[9] = 0.143; // ストラム下
  g.poll(1008);
  assertDeepEq(got, ['h9d'], 'the strum bar on the hat axis → hat down');
  assertEq(g.capturing, false, 'one input per capture');
  pad.axes[9] = 3.2857;
  g.poll(1012);
  g.startCapture((code) => got.push(code));
  pad.axes[2] = 0.9; // ワーミーを押し込む → 軸 2 の +
  g.poll(1016);
  assertEq(got[1], 'a2+');
  g.startCapture((code) => got.push(code));
  press(pad, 5); // 割り当てていないボタン 5(PS3 RB のチルトなど)
  g.poll(1020);
  assertEq(got[2], 'b5');
  // 待っている間の入力は演奏へ流さない
  pad.axes[2] = -1;
  press(pad, 5, false);
  g.poll(1024);
  ev.length = 0;
  g.startCapture((code) => got.push(code));
  press(pad, 0);
  g.poll(1028);
  assertEq(got[3], 'b0');
  assertEq(ev.length, 0, 'the captured press did not reach the game');
  g.cancelCapture();
});

test('gamepad: GuitarInput counts gamepad holders with keys; PICK / WAIL fire on the press only', () => {
  const ev = [];
  const input = new GuitarInput({
    onFret: (lane, down, ts, source) => ev.push(['fret', lane, down, ts, source]),
    onPick: (ts, source) => ev.push(['pick', ts, source]),
    onWail: (ts, source) => ev.push(['wail', ts, source]),
  });
  input.setBindings(defaultBindings([['KeyA'], ['KeyS'], ['KeyD'], ['KeyF'], ['KeyG'], ['KeyJ'], ['KeyL']]));
  input._onKeyDown({ code: 'KeyA', repeat: false, timeStamp: 1, target: null, preventDefault() {} });
  input.padInput(0, true, 2, 'g0:b0'); // キーとゲームパッドの両方で R
  input.padInput(0, false, 3, 'g0:b0');
  assertEq(input.isFretDown(0), true, 'still held by the key');
  input._onKeyUp({ code: 'KeyA', timeStamp: 4, target: null, preventDefault() {} });
  input.padInput(5, true, 5, 'g0:b12');
  input.padInput(5, false, 6, 'g0:b12');
  input.padInput(6, true, 7, 'g0:a3-');
  assertDeepEq(ev, [['fret', 0, true, 1, 'key'], ['fret', 0, false, 4, 'key'], ['pick', 5, 'pad'], ['wail', 7, 'pad']]);
  // フォーカスを失った(releaseAll): キーの押さえは離すが、ゲームパッドの押さえは残す(離したことは取得で届く)
  ev.length = 0;
  input.padInput(1, true, 8, 'g0:b1');
  input._onKeyDown({ code: 'KeyD', repeat: false, timeStamp: 8, target: null, preventDefault() {} }); // B をキーで
  input._onKeyDown({ code: 'KeyS', repeat: false, timeStamp: 8, target: null, preventDefault() {} }); // G をキーでも
  ev.length = 0;
  input.releaseAll(9);
  assertDeepEq(ev, [['fret', 2, false, 9, 'release']], 'only the key-only lane is released');
  assertEq(input.isFretDown(1), true, 'G is still held on the controller');
  input.padInput(1, false, 10, 'g0:b1');
  assertEq(input.isFretDown(1), false);
  assertDeepEq(ev[ev.length - 1], ['fret', 1, false, 10, 'pad']);
});

test('gamepad: the gamepad binding panel captures from the controller and shows input names', () => {
  const host = document.createElement('div');
  host.innerHTML = '<div class="list"></div><span class="status"></span><button class="undo" hidden></button><button class="reset"></button>';
  document.body.appendChild(host);
  const pad = fakePad();
  const { g } = makeInput([pad]);
  g.watchAll = true;
  g.poll(1000);
  let bindings = defaultBindings(GB_PAD_DEFAULTS);
  const panel = new KeyBindPanel({
    list: host.querySelector('.list'),
    statusText: host.querySelector('.status'),
    undoButton: host.querySelector('.undo'),
    resetAllButton: host.querySelector('.reset'),
    names: PAD_BUTTON_NAMES,
    defaults: GB_PAD_DEFAULTS,
    getBindings: () => bindings,
    setBindings: (next) => { bindings = next; g.setBindings(next); },
    device: padDevice(g),
  });
  try {
    panel.build();
    const row = (lane) => host.querySelector(`.key-row[data-lane="${lane}"]`);
    assertEq(row(5).querySelector('.chip-key').textContent, 'B12', 'input names, not key names');
    assertEq(row(5).getAttribute('aria-label'), t('pad.rowLabel', { lane: 'PICK' }));
    // PICK に追加: 押して追加 → 右スティックを右へ倒す
    row(5).querySelector('.chip-add').click();
    assertEq(g.capturing, true);
    assertEq(host.querySelector('.status').textContent, t('pad.promptAdd', { lane: 'PICK' }));
    assertEq(row(5).querySelector('.chip-add').textContent, t('pad.waiting'));
    pad.axes[2] = 0.9;
    g.poll(1004);
    assertDeepEq(bindings[5], ['b12', 'b13', 'a2+']);
    assertEq(g.capturing, false);
    assertEq(g.buttonOfCode('a2+'), 5, 'the gamepad uses the new binding right away');
    // 登録済みの入力を押すと待ち続ける(押し直しを待つ)
    pad.axes[2] = 0;
    g.poll(1008);
    row(0).querySelector('.chip-add').click();
    press(pad, 0); // R に既にある B0
    g.poll(1012);
    assertEq(host.querySelector('.status').textContent, t('pad.already', { key: 'B0', lane: 'R' }));
    assertEq(g.capturing, true, 'still waiting');
    press(pad, 5); // RB
    g.poll(1016);
    assertDeepEq(bindings[0], ['b0', 'b5']);
    // Esc で中止するとゲームパッドの待ち受けも止まる
    row(1).querySelector('.chip-add').click();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }));
    assertEq(g.capturing, false, 'Esc cancels the gamepad capture');
    assertEq(panel.assigning, false);
    // 監視の光
    panel.hitLane(2);
    assert(row(2).classList.contains('row-hit'));
  } finally {
    panel.cancelAssign();
    host.remove();
  }
});

test('gamepad: picks from the controller are judged in play like keys (fret + strum in one sample)', async () => {
  let t0 = 0;
  const audio = {
    ctx: { get currentTime() { return t0; } },
    outputLatencySec: 0,
    buffers: new Map(),
    async loadChartSounds() { return this.buffers; },
    hasBuffer(id) { return this.buffers.has(id); },
    play() { return { src: null }; },
    playBuffer() { return { src: null }; },
    stopVoice() {},
    stopAll() {},
    synthBuffer(lane) { return { lane }; },
  };
  const settings = new TrainingSettings();
  settings.startWaitMs = 0;
  const player = new GuitarPlayer({ audio, settings, config: {}, inst: INSTRUMENT.GUITAR });
  // R(2000)・GB の和音(2500)
  await player.load({ resolve() { return null; }, readBytes() {} }, parseDTX('#BPM: 120\n#00024: 01000000\n#00023: 00060000\n'));
  const input = new GuitarInput({
    onFret: (lane, down, ts) => player.fret(lane, down, ts),
    onPick: (ts) => player.pick(ts),
    onWail: (ts) => player.wail(ts),
  });
  const pad = fakePad();
  const g = new GamepadInput({ getGamepads: () => [pad], onButton: (b, down, ts, holder) => input.padInput(b, down, ts, holder) });
  g.setBindings(defaultBindings(GB_PAD_DEFAULTS));
  const perf = () => t0 * 1000;
  const orig = performance.now;
  performance.now = perf;
  try {
    g.poll(perf());
    player.command('startStop');
    player.update(perf(), null);
    assertEq(player.state, PLAYER_STATE.PLAYING);
    t0 = 2.004;
    player.update(perf(), null);
    // 緑(R)を押さえてストラム下 — 同じ取得で届く。時刻はゲームパッドが読んだ 2002
    press(pad, 0);
    press(pad, 13);
    pad.timestamp = 2002;
    g.poll(perf());
    assertEq(player.stats.counts[0], 1, 'perfect');
    assertNear(player.stats.lastLagMs, 2, 1.5, 'judged at the sample time, not the poll time');
    press(pad, 13, false);
    press(pad, 0, false);
    g.poll(perf());
    // 和音 G+B(赤 b1 + 黄 b3)をストラム上で
    t0 = 2.5;
    player.update(perf(), null);
    press(pad, 1);
    press(pad, 3);
    press(pad, 12);
    pad.timestamp = 2500;
    g.poll(perf());
    assertEq(player.stats.counts[0], 2, 'chord perfect');
  } finally {
    performance.now = orig;
    player.dispose();
  }
});

test('gamepad: polling runs only while activated (4 ms with a device, 250 ms without)', () => {
  assertEq(PAD_POLL_MS, 4);
  assertEq(PAD_IDLE_MS, 250);
  const realSI = globalThis.setInterval;
  const realCI = globalThis.clearInterval;
  const timers = new Map();
  let nextId = 1;
  globalThis.setInterval = (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; };
  globalThis.clearInterval = (id) => timers.delete(id);
  const pads = [];
  let reads = 0;
  const g = new GamepadInput({ getGamepads: () => { reads++; return pads; } });
  try {
    assertEq(g.active, false);
    g.activate('play');
    assertEq(timers.get(g._idleTimer).ms, 250, 'idle check without a gamepad');
    assertEq(g._fastTimer, 0);
    const r0 = reads;
    timers.get(g._idleTimer).fn();
    assertEq(reads, r0 + 1, 'the idle timer polls');
    pads.push(fakePad());
    g.poll(0);
    assertEq(timers.get(g._fastTimer).ms, 4, '4 ms polling once a gamepad is seen');
    const r1 = reads;
    timers.get(g._fastTimer).fn();
    assertEq(reads, r1 + 1, 'the fast timer polls');
    g.activate('settings');
    g.deactivate('play');
    assert(g.active && g._fastTimer, 'still active for the settings');
    pads.length = 0;
    g.poll(10);
    assert(!g._fastTimer && g._idleTimer, 'back to the idle check after the last one leaves');
    g.deactivate('play');
    g.deactivate('settings');
    assert(!g._idleTimer && !g._fastTimer, 'stopped');
    assertEq(timers.size, 0, 'every timer cleared');
  } finally {
    g.deactivate('play');
    g.deactivate('settings');
    globalThis.setInterval = realSI;
    globalThis.clearInterval = realCI;
  }
  const none = new GamepadInput({ getGamepads: () => { throw new Error('SecurityError'); } });
  none.poll(0); // 権限ポリシーで止められていても落ちない
  assertEq(none.devices.length, 0);
});
