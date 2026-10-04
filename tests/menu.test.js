import { test, assert, assertEq, assertDeepEq } from './runner.js';
import { TrainingSettings, LOOP_UNIT } from '../js/game/training.js';
import { TrainingMenu, MENU_COMMAND, ITEM, GB_PRESET, gbAutoPresetOf } from '../js/ui/menu.js';
import { parseDTX, INSTRUMENT } from '../js/core/dtx.js';

function makeMenu() {
  const s = new TrainingSettings();
  const sounds = { cursor: 0, decide: 0, cancel: 0 };
  const speedSteps = [];
  const m = new TrainingMenu(s, {
    sound: { cursor: () => sounds.cursor++, decide: () => sounds.decide++, cancel: () => sounds.cancel++ },
    onPlaySpeedStep: (d) => speedSteps.push(d),
  });
  const chart = parseDTX('#BPM: 120\n#00013: 01\n#00313: 01\n'); // 小節 0..3、durationMs = 小節 3 頭
  m.setChart(chart);
  return { m, s, sounds, speedSteps, chart };
}

test('menu: item order, initial values, formats', () => {
  const { m, s } = makeMenu();
  assertEq(m.itemCount, 19);
  assertEq(m.itemName(0), '自動演奏');
  assertEq(m.itemName(7), 'ドラム音量');
  assertEq(m.itemName(8), 'BGM 音量');
  assertEq(m.itemName(9), 'メトロノーム');
  assertEq(m.itemValue(9), 'OFF');
  assertEq(m.itemName(14), '現在位置');
  assertEq(m.itemName(15), '演奏開始');
  m.playing = true;
  assertEq(m.itemName(15), '演奏停止');
  m.paused = true;
  assertEq(m.itemName(17), '再開');
  assertEq(m.itemValue(0), 'OFF');
  assertEq(m.itemValue(1), 'なし');
  assertEq(m.itemValue(2), '0 ms');
  s.noteOffsetMs = 12;
  assertEq(m.itemValue(2), '+12 ms');
  s.judgeOffsetMs = -5;
  assertEq(m.itemValue(3), '-5 ms');
  assertEq(m.itemValue(4), 'x1.0');
  assertEq(m.itemValue(5), 'x1.00');
  assertEq(m.itemValue(6), '1.0 s');
  assertEq(m.itemValue(10), 'OFF');
  s.loop = true;
  s.loopBeginMs = 0;
  s.loopEndMs = 0;
  assertEq(m.itemValue(10), 'ON (無効)');
  s.loopEndMs = 4000;
  assertEq(m.itemValue(10), 'ON');
  assertEq(m.itemValue(11), '小節');
  // 小節一覧は [0(リードイン), 2000(小節0), 4000(小節1), ...] で、表示はその添字(DTXManiaAI と同じ)
  assertEq(m.itemValue(12), '002 小節');
  assertEq(m.itemValue(13), '000 小節');
  s.loopUnit = LOOP_UNIT.SECOND;
  assertEq(m.itemValue(12), '4.0 s');
});

test('menu: cursor wraps, Enter on value items steps +1, Ctrl x10, clamps', () => {
  const { m, s, sounds } = makeMenu();
  const t = 1000;
  m.keyDown('ArrowUp', false, t);
  m.keyUp('ArrowUp');
  assertEq(m.cursor, 18, 'wrap to last');
  m.keyDown('ArrowDown', false, t + 100);
  m.keyUp('ArrowDown');
  assertEq(m.cursor, 0);
  // Enter on 自動演奏 toggles
  m.keyDown('Enter', false, t + 200);
  assertEq(s.autoPlay, true);
  assertEq(m.takeCommand(), MENU_COMMAND.NONE);
  // ノーツ表示調整 を Ctrl+→ で +10
  m.cursor = 2;
  m.keyDown('ArrowRight', true, t + 300);
  m.keyUp('ArrowRight');
  assertEq(s.noteOffsetMs, 10);
  // 判定タイミング調整の下限クランプ
  m.cursor = 3;
  s.judgeOffsetMs = -95;
  m.keyDown('ArrowLeft', true, t + 400);
  m.keyUp('ArrowLeft');
  assertEq(s.judgeOffsetMs, -99);
  assert(sounds.cursor > 0, 'cursor sound played');
});

test('menu: key repeat timing 0 / 200 / 30 ms', () => {
  const { m } = makeMenu();
  m.keyDown('ArrowDown', false, 0);
  assertEq(m.cursor, 1, 'immediate');
  m.update(100);
  assertEq(m.cursor, 1, 'no repeat before 200ms');
  m.update(201);
  assertEq(m.cursor, 2, 'second fire after 200ms');
  m.update(220);
  assertEq(m.cursor, 2);
  m.update(232);
  assertEq(m.cursor, 3, 'third fire after 30ms');
  m.keyUp('ArrowDown');
  m.update(300);
  assertEq(m.cursor, 3, 'stopped after release');
});

test('menu: actions, pause disabled in standby, Esc/quit, submenu', () => {
  const { m, s, sounds } = makeMenu();
  m.cursor = 15;
  m.keyDown('Enter', false, 0);
  assertEq(m.takeCommand(), MENU_COMMAND.START_STOP);
  m.cursor = 17;
  m.playing = false;
  m.keyDown('Enter', false, 0);
  assertEq(m.takeCommand(), MENU_COMMAND.PAUSE_RESUME, 'returned even in standby (the player ignores it)');
  assertEq(m.isDisabled(17), true, 'greyed while not playing');
  m.playing = true;
  m.keyDown('Enter', false, 0);
  assertEq(m.takeCommand(), MENU_COMMAND.PAUSE_RESUME);
  assertEq(m.isDisabled(12), true, 'loop rows disabled while loop off');
  // サブメニュー
  m.cursor = 1;
  m.keyDown('ArrowRight', false, 0);
  m.keyUp('ArrowRight');
  assertEq(m.page, 'main', '←→ does not open submenu');
  m.keyDown('Enter', false, 0);
  assertEq(m.page, 'auto');
  assertEq(m.itemCount, 12);
  assertEq(m.itemName(10), 'すべて');
  assertEq(m.itemName(11), '戻る');
  m.cursor = 10;
  m.keyDown('Enter', false, 0);
  assertEq(s.autoLanes.slice(0, 10).every(Boolean), true, 'すべて → all auto');
  assertEq(m.autoLaneSummary(), 'すべて');
  m.cursor = 3;
  m.keyDown('Enter', false, 0);
  assertEq(s.autoLanes[3], false);
  assertEq(m.autoLaneSummary(), '9 レーン');
  m.keyDown('Escape', false, 0);
  assertEq(m.page, 'main');
  assertEq(m.cursor, 1, 'back to 自動演奏詳細');
  assertEq(m.takeCommand(), MENU_COMMAND.NONE);
  m.keyDown('Escape', false, 0);
  assertEq(m.takeCommand(), MENU_COMMAND.QUIT);
  assert(sounds.cancel >= 2);
});

test('menu: play speed goes through callback; loop positions clamp against each other', () => {
  const { m, s, speedSteps } = makeMenu();
  m.cursor = 5;
  m.keyDown('ArrowRight', false, 0);
  m.keyUp('ArrowRight');
  assertEq(speedSteps.length, 1);
  assertEq(speedSteps[0], 1);
  s.loop = true;
  s.loopBeginMs = 0;
  s.loopEndMs = 6000; // 小節 3 頭
  m.cursor = 13; // 開始位置
  m.keyDown('ArrowRight', true, 0); // +10 小節 → 終了の 1 段手前(小節 2 = 4000)
  m.keyUp('ArrowRight');
  assertEq(s.loopBeginMs, 4000);
  m.cursor = 12; // 終了位置
  m.keyDown('ArrowLeft', true, 0);
  m.keyUp('ArrowLeft');
  assertEq(s.loopEndMs, 6000, 'end cannot move below begin+1 → unchanged');
});

test('menu: volume rows step by 5 (x10 with Ctrl), clamp, and do not touch training settings', () => {
  const vol = { chip: 100, bgm: 70 };
  const saved = [];
  const m = new TrainingMenu(new TrainingSettings(), {
    getVolume: (kind) => vol[kind],
    onVolumeStep: (kind, step) => {
      const before = vol[kind];
      vol[kind] = Math.max(0, Math.min(100, Math.round(before + step)));
      return vol[kind] !== before;
    },
    onChange: () => saved.push(1),
  });
  m.setChart(parseDTX('#BPM: 120\n#00013: 01\n'));
  assertEq(m.itemValue(7), '100 %');
  assertEq(m.itemValue(8), '70 %');

  m.cursor = 7; // ドラム音量
  m.changeValue(-1);
  assertEq(vol.chip, 95, '←→ steps 5 %');
  m.changeValue(-10);
  assertEq(vol.chip, 45, 'Ctrl steps 50 %');
  for (let i = 0; i < 20; i++) m.changeValue(-1);
  assertEq(vol.chip, 0, 'clamped at 0');
  m.changeValue(+1);
  assertEq(vol.chip, 5);

  m.cursor = 8; // BGM 音量
  m.changeValue(+10);
  assertEq(vol.bgm, 100, 'clamped at 100');
  assertEq(vol.chip, 5, 'the other bus is untouched');

  assertEq(saved.length, 0, '音量はトレーニング設定ではないので training.save() を呼ばない');
});

test('menu: refresh writes the DOM only when a shown value changed', () => {
  const { m } = makeMenu();
  const host = document.createElement('div');
  m.build(host);
  const mo = new MutationObserver(() => {});
  mo.observe(m.root, { subtree: true, childList: true, characterData: true, attributes: true });
  // 記録の対象 → 行番号(見出し・状態行は -1 なので除く)
  const rowsOf = (recs) => [...new Set(recs.map((r) => m.rows.findIndex((row) => row.li.contains(r.target))).filter((i) => i >= 0))].sort((a, b) => a - b);
  try {
    m.refresh();
    assertEq(mo.takeRecords().length, 0, 'no writes when nothing changed');

    // カーソル移動: 書き換わるのは移動前と移動後の行だけ
    m.moveCursor(+1);
    assertDeepEq(rowsOf(mo.takeRecords()), [0, 1]);
    assertEq(m.rows[0].name.textContent, '自動演奏');
    assertEq(m.rows[1].name.textContent, '> 自動演奏詳細');
    m.refresh();
    assertEq(mo.takeRecords().length, 0);

    // 演奏中・一時停止・状態行は外から変わる(main.js の演奏ループが毎フレーム入れる)
    m.playing = true;
    m.paused = true;
    m.stateText = 'PLAYING';
    m.refresh();
    assert(mo.takeRecords().length > 0, 'changes are written');
    assertEq(m.rows[15].name.textContent, '演奏停止');
    assertEq(m.rows[17].name.textContent, '再開');
    assertEq(m.rows[17].li.classList.contains('disabled'), false, 'PAUSE row enabled while playing');
    assertEq(m.state.textContent, 'PLAYING');
    m.refresh();
    assertEq(mo.takeRecords().length, 0, 'steady while playing');

    // 動作の行には ◀ ▶ が無く、値の行にはある
    assertEq(m.rows[15].left.hidden, true);
    assertEq(m.rows[2].left.hidden, false);

    // 自動演奏詳細へ入ると見出しが変わり、使わない行(12〜18)が隠れる。戻ると元どおり
    m.cursor = 1;
    m.keyDown('Enter', false, 0);
    assertEq(m.page, 'auto');
    assertEq(m.header.textContent, 'TRAINING - 自動演奏詳細');
    for (let i = 12; i < 19; i++) assertEq(m.rows[i].li.hidden, true, 'row ' + i + ' hidden');
    assertEq(m.rows[11].left.hidden, true, '戻る has no buttons');
    mo.takeRecords();
    m.refresh();
    assertEq(mo.takeRecords().length, 0, 'steady in the submenu');
    m.keyDown('Escape', false, 0);
    assertEq(m.page, 'main');
    assertEq(m.header.textContent, 'TRAINING');
    for (let i = 12; i < 19; i++) assertEq(m.rows[i].li.hidden, false, 'row ' + i + ' shown again');

    // 控えを持たず今の DOM と比べるので、外から書き換えられても次の refresh で戻る
    m.rows[3].value.textContent = 'X';
    m.refresh();
    assertEq(m.rows[3].value.textContent, m.itemValue(3));
  } finally {
    mo.disconnect();
    m.destroy();
  }
});

test('menu: guitar / bass variant (button AUTO, own hi-speed, part volume, reverse)', () => {
  const s = new TrainingSettings();
  const volumes = [];
  const m = new TrainingMenu(s, {
    instrument: INSTRUMENT.BASS,
    getVolume: (kind) => (kind === 'chip' ? 70 : 90),
    onVolumeStep: (kind, step) => { volumes.push([kind, step]); return true; },
  });
  m.setChart(parseDTX('#BPM: 120\n#000A1: 01\n#003A1: 01\n'));
  const row = (item) => m.items.indexOf(item);
  assertEq(m.itemCount, 23);
  // 並び: 自動演奏 / AUTO プリセット / 自動演奏詳細 / … / BGM 音量 / メトロノーム / リバース / LEFT / 空ピックで BAD / ループ演奏 / …
  assertDeepEq([0, 1, 2, 3].map((i) => m.itemName(i)), ['自動演奏', 'AUTO プリセット', '自動演奏詳細', 'ノーツ表示調整']);
  assertDeepEq([9, 10, 11, 12, 13, 14].map((i) => m.itemName(i)), ['BGM 音量', 'メトロノーム', 'リバース', 'LEFT(左利き)', '空ピックで BAD', 'ループ演奏']);
  assertEq(m.itemName(row(ITEM.DRUM_VOLUME)), 'ベース音量');
  assertEq(m.itemValue(row(ITEM.DRUM_VOLUME)), '70 %');
  assertEq(m.itemValue(row(ITEM.REVERSE)), 'OFF');
  assertEq(m.itemName(row(ITEM.START_STOP)), '演奏開始');
  assertEq(m.itemName(m.itemCount - 1), 'トレーニング終了');
  // リバースの切り替え
  m.cursor = row(ITEM.REVERSE);
  m.keyDown('ArrowRight', false, 0);
  m.keyUp('ArrowRight');
  assertEq(s.gbReverse, true);
  assertEq(m.itemValue(row(ITEM.REVERSE)), 'ON');
  // ハイスピードはドラムと別
  m.cursor = row(ITEM.HI_SPEED);
  m.keyDown('ArrowRight', true, 0);
  m.keyUp('ArrowRight');
  assertEq(s.gbScrollSpeedTenth, 30);
  assertEq(s.scrollSpeedTenth, 10, 'drum hi-speed untouched');
  assertEq(m.itemValue(row(ITEM.HI_SPEED)), 'x3.0');
  // 音量は 'chip' のバス(main.js がギター / ベース音量に振り分ける)
  m.cursor = row(ITEM.DRUM_VOLUME);
  m.keyDown('ArrowLeft', false, 0);
  m.keyUp('ArrowLeft');
  assertDeepEq(volumes, [['chip', -5]]);
  // 動作の行
  m.cursor = row(ITEM.START_STOP);
  m.keyDown('Enter', false, 0);
  assertEq(m.takeCommand(), MENU_COMMAND.START_STOP);
  assertEq(m.isAction(row(ITEM.QUIT)), true);
  // 自動演奏詳細: R G B Y P PICK WAIL
  m.cursor = row(ITEM.AUTO_DETAIL);
  m.keyDown('Enter', false, 0);
  assertEq(m.page, 'auto');
  assertEq(m.itemCount, 9);
  assertEq(m.itemName(0), 'R');
  assertEq(m.itemName(5), 'PICK');
  assertEq(m.itemName(6), 'WAIL');
  assertEq(m.itemName(7), 'すべて');
  m.cursor = 5;
  m.keyDown('Enter', false, 0);
  assertEq(s.gbAutoLanes[5], true);
  assertEq(s.autoLanes.some(Boolean), false, 'drum lanes untouched');
  assertEq(m.autoLaneSummary(), '1 ボタン');
  m.cursor = 7;
  m.keyDown('Enter', false, 0);
  assertEq(s.gbAutoLanes.every(Boolean), true);
  m.keyDown('Escape', false, 0);
  assertEq(m.page, 'main');
  assertEq(m.cursor, row(ITEM.AUTO_DETAIL), 'back to 自動演奏詳細');
  assertEq(m.itemValue(row(ITEM.AUTO_DETAIL)), 'すべて');
  assertEq(m.itemValue(row(ITEM.AUTO_PRESET)), 'すべて');
});

test('menu: guitar AUTO preset detection follows NX (WAIL is ignored except for OFF)', () => {
  const f = (str) => [...str].map((c) => c === '1');
  assertEq(gbAutoPresetOf(f('0000000')), GB_PRESET.OFF);
  assertEq(gbAutoPresetOf(f('1111100')), GB_PRESET.NECK);
  assertEq(gbAutoPresetOf(f('1111101')), GB_PRESET.NECK, 'neck + WAIL is still Neck');
  assertEq(gbAutoPresetOf(f('0000010')), GB_PRESET.PICK);
  assertEq(gbAutoPresetOf(f('0000011')), GB_PRESET.PICK, 'pick + WAIL is still Pick');
  assertEq(gbAutoPresetOf(f('1111111')), GB_PRESET.ALL);
  assertEq(gbAutoPresetOf(f('1111110')), GB_PRESET.ALL, 'R..PICK is All (NX bAllGuitarsAreAutoPlay excludes WAIL)');
  assertEq(gbAutoPresetOf(f('0000001')), GB_PRESET.CUSTOM, 'WAIL only is not OFF');
  assertEq(gbAutoPresetOf(f('0100000')), GB_PRESET.CUSTOM, 'G only is not OFF (NX guitar OFF test skips G)');
  assertEq(gbAutoPresetOf(f('0001010')), GB_PRESET.CUSTOM, 'Y + PICK is not Pick (NX bass tests skip G Y P)');
  assertEq(gbAutoPresetOf(f('1100000')), GB_PRESET.CUSTOM);
});

test('menu: guitar AUTO preset cycles OFF → Neck → Pick → All and gives the custom set back', () => {
  const s = new TrainingSettings();
  let saved = 0;
  const m = new TrainingMenu(s, { instrument: INSTRUMENT.GUITAR, onChange: () => saved++ });
  m.setChart(parseDTX('#BPM: 120\n#00020: 01\n'));
  m.cursor = m.items.indexOf(ITEM.AUTO_PRESET);
  const flags = () => s.gbAutoLanes.map((b) => (b ? '1' : '0')).join('');
  const step = (code, ctrl = false) => { m.keyDown(code, ctrl, 0); m.keyUp(code); };
  assertEq(m.itemValue(m.cursor), 'OFF');
  step('ArrowRight');
  assertEq(flags(), '1111100');
  assertEq(m.itemValue(m.cursor), 'ネック');
  step('ArrowRight');
  assertEq(flags(), '0000010');
  assertEq(m.itemValue(m.cursor), 'ピック');
  step('ArrowRight', true); // Ctrl でも 1 つずつ
  assertEq(flags(), '1111111');
  assertEq(m.itemValue(m.cursor), 'すべて');
  step('ArrowRight');
  assertEq(flags(), '0000000', 'wraps to OFF (no custom set yet)');
  step('ArrowLeft');
  assertEq(flags(), '1111111', 'wraps back to All');
  assertEq(saved, 5, 'saved like other training settings');

  // カスタムからプリセットへ移っても、回して戻れば元の組み合わせ
  s.gbAutoLanes.splice(0, 7, true, true, false, false, false, false, true);
  assertEq(m.itemValue(m.cursor), 'カスタム');
  step('ArrowRight');
  assertEq(flags(), '0000000', 'custom → OFF');
  step('ArrowLeft');
  assertEq(flags(), '1100001', 'OFF ← custom restored');
  step('ArrowLeft');
  assertEq(flags(), '1111111', 'custom ← All');
  step('ArrowRight');
  assertEq(flags(), '1100001');
  assertEq(m.itemValue(m.cursor), 'カスタム');

  // ドラムには無い
  const drum = new TrainingMenu(new TrainingSettings(), {});
  assertEq(drum.items.includes(ITEM.AUTO_PRESET), false);
  assertEq(drum.items.includes(ITEM.GB_BAD), false);
  assertEq(drum.items.includes(ITEM.REVERSE), false);
  assertEq(drum.items.includes(ITEM.LEFT), false);
});

test('menu: 空ピックで BAD goes through the app-config hooks, not the training settings', () => {
  let light = true;
  let saved = 0;
  const m = new TrainingMenu(new TrainingSettings(), {
    instrument: INSTRUMENT.GUITAR,
    onChange: () => saved++,
    getGbBad: () => !light,
    onGbBadToggle: () => { light = !light; },
  });
  m.setChart(parseDTX('#BPM: 120\n#00020: 01\n'));
  m.cursor = m.items.indexOf(ITEM.GB_BAD);
  assertEq(m.itemName(m.cursor), '空ピックで BAD');
  assertEq(m.itemValue(m.cursor), 'OFF', 'Light ON (default) = BAD off');
  m.keyDown('ArrowRight', false, 0);
  m.keyUp('ArrowRight');
  assertEq(light, false);
  assertEq(m.itemValue(m.cursor), 'ON');
  m.keyDown('Enter', false, 0);
  assertEq(light, true, 'Enter toggles too');
  assertEq(m.takeCommand(), MENU_COMMAND.NONE);
  assertEq(saved, 0, 'training.save() is not called for an app setting');
  // フックが無ければ何もしない
  const bare = new TrainingMenu(new TrainingSettings(), { instrument: INSTRUMENT.BASS });
  bare.cursor = bare.items.indexOf(ITEM.GB_BAD);
  bare.changeValue(+1);
  assertEq(bare.itemValue(bare.cursor), 'OFF');
});

test('menu: metronome row steps by 10 % (Ctrl jumps to the end), shows OFF at 0, saves, on both instruments', () => {
  for (const instrument of [INSTRUMENT.DRUMS, INSTRUMENT.GUITAR]) {
    const s = new TrainingSettings();
    let saved = 0;
    const m = new TrainingMenu(s, { instrument, onChange: () => saved++ });
    m.setChart(parseDTX('#BPM: 120\n#00013: 01\n'));
    m.cursor = m.items.indexOf(ITEM.METRONOME);
    assertEq(m.itemName(m.cursor), 'メトロノーム');
    assertEq(m.itemValue(m.cursor), 'OFF');
    m.changeValue(+1);
    assertEq(s.metronomeVolume, 10);
    assertEq(m.itemValue(m.cursor), '10 %');
    m.changeValue(+10);
    assertEq(s.metronomeVolume, 100, 'clamped at 100');
    m.changeValue(+1);
    assertEq(saved, 2, 'no save when clamped (nothing changed)');
    m.changeValue(-3);
    assertEq(s.metronomeVolume, 70);
    m.changeValue(-10);
    assertEq(s.metronomeVolume, 0);
    assertEq(m.itemValue(m.cursor), 'OFF');
  }
});

test('training: metronome volume is saved, snapped to 10 % and clamped', () => {
  assertEq(new TrainingSettings().metronomeVolume, 0, 'off by default');
  assertEq(TrainingSettings.fromJSON({ metronomeVolume: 37 }).metronomeVolume, 40);
  assertEq(TrainingSettings.fromJSON({ metronomeVolume: 150 }).metronomeVolume, 100);
  assertEq(TrainingSettings.fromJSON({ metronomeVolume: -5 }).metronomeVolume, 0);
  assertEq(TrainingSettings.fromJSON({ metronomeVolume: 'x' }).metronomeVolume, 0);
  const s = new TrainingSettings();
  s.metronomeVolume = 60;
  assertEq(TrainingSettings.fromJSON(JSON.parse(JSON.stringify(s))).metronomeVolume, 60);
});

test('menu: the selected row is scrolled into view when the menu overflows', () => {
  const m = new TrainingMenu(new TrainingSettings(), { instrument: INSTRUMENT.GUITAR });
  m.setChart(parseDTX('#BPM: 120\n#00020: 01\n'));
  const host = document.createElement('div');
  host.style.cssText = 'position: fixed; left: -2000px; top: 0; width: 400px; height: 400px;';
  document.body.appendChild(host);
  m.build(host);
  const root = m.root;
  root.style.cssText = 'position: absolute; left: 0; top: 0; width: 400px; height: 150px; overflow-y: auto;';
  const visible = (i) => {
    const li = m.rows[i].li;
    return li.offsetTop >= root.scrollTop - 0.5 && li.offsetTop + li.offsetHeight <= root.scrollTop + root.clientHeight + 0.5;
  };
  try {
    assert(root.scrollHeight > root.clientHeight, 'the test menu overflows');
    m.moveCursor(-1); // 最後の行へ
    assertEq(m.cursor, m.itemCount - 1);
    assert(root.scrollTop > 0, 'scrolled down');
    assert(visible(m.cursor), 'last row visible');
    const bottomScroll = root.scrollTop;
    // 上へ戻ると、見えなくなる前に枠が上へ動く(先頭の手前の行 1 まで。行 0 は見出しまで見せる別の扱い)
    for (let i = 0; i < m.itemCount - 2; i++) {
      m.moveCursor(-1);
      assert(visible(m.cursor), 'row ' + m.cursor + ' visible after stepping up');
    }
    assertEq(m.cursor, 1);
    assert(root.scrollTop < bottomScroll, 'scrolled up');
    assertEq(root.scrollTop, m.rows[1].li.offsetTop, 'the row is at the top edge');
    m.moveCursor(+1);
    m.moveCursor(-2); // 行 0 へ
    assertEq(m.cursor, 0);
    m.moveCursor(-1); // 最後の行へ
    m.moveCursor(+1); // 先頭へ戻ると見出しまで
    assertEq(m.cursor, 0);
    assertEq(root.scrollTop, 0);
    for (let i = 0; i < 12; i++) m.moveCursor(+1);
    assert(visible(m.cursor), 'row ' + m.cursor + ' visible after stepping down');
    const top = root.scrollTop;
    m.refresh();
    assertEq(root.scrollTop, top, 'refresh without a cursor change does not scroll');
    root.scrollTop = 0; // 手でスクロールした位置は、カーソルが動くまで戻さない
    m.refresh();
    assertEq(root.scrollTop, 0);
    // 隠れている間(測れない)にカーソルが動いても、出したときに invalidateScroll で測り直す
    root.hidden = true;
    m.moveCursor(+8); // 行 20
    const hiddenCursor = m.cursor;
    root.hidden = false;
    m.refresh();
    assert(!visible(m.cursor), 'stale until re-measured (the case invalidateScroll is for)');
    m.invalidateScroll();
    m.refresh();
    assertEq(m.cursor, hiddenCursor);
    assert(visible(m.cursor), 'row ' + m.cursor + ' visible after the menu is shown again');
  } finally {
    m.destroy();
    host.remove();
  }
});

test('menu: guitar / bass 現在位置 works with loop off (row → item mapping)', () => {
  for (const instrument of [INSTRUMENT.DRUMS, INSTRUMENT.GUITAR, INSTRUMENT.BASS]) {
    const s = new TrainingSettings();
    const seeks = [];
    const m = new TrainingMenu(s, { instrument, canSeek: () => true, getPositionMs: () => 0, onSeek: (ms) => { seeks.push(ms); return true; } });
    m.setChart(parseDTX('#BPM: 120\n#00013: 01\n#00313: 01\n'));
    m.cursor = m.items.indexOf(ITEM.POSITION);
    assertEq(m.itemName(m.cursor), '現在位置');
    assertEq(s.loop, false);
    m.keyDown('ArrowRight', false, 0);
    m.keyUp('ArrowRight');
    assertDeepEq(seeks, [2000], 'instrument ' + instrument);
  }
});

test('menu: LEFT toggles the guitar / bass lane mirroring (saved like reverse)', () => {
  const s = new TrainingSettings();
  let saved = 0;
  const m = new TrainingMenu(s, { instrument: INSTRUMENT.GUITAR, onChange: () => saved++ });
  m.setChart(parseDTX('#BPM: 120\n#00020: 01\n'));
  m.cursor = m.items.indexOf(ITEM.LEFT);
  assertEq(m.itemName(m.cursor), 'LEFT(左利き)');
  assertEq(m.itemValue(m.cursor), 'OFF');
  m.keyDown('ArrowRight', false, 0);
  m.keyUp('ArrowRight');
  assertEq(s.gbLeft, true);
  assertEq(m.itemValue(m.cursor), 'ON');
  m.keyDown('Enter', false, 0);
  assertEq(s.gbLeft, false, 'Enter toggles too');
  assertEq(saved, 2);
  assertEq(s.gbReverse, false, 'reverse untouched');
});

test('menu: the judge offset is separate for drums and guitar / bass', () => {
  const s = new TrainingSettings();
  const gb = new TrainingMenu(s, { instrument: INSTRUMENT.BASS });
  gb.setChart(parseDTX('#BPM: 120\n#000A0: 01\n'));
  gb.cursor = gb.items.indexOf(ITEM.JUDGE_OFFSET);
  assertEq(gb.itemName(gb.cursor), '判定タイミング調整');
  gb.changeValue(+10);
  gb.changeValue(+3);
  assertEq(s.gbJudgeOffsetMs, 13);
  assertEq(s.judgeOffsetMs, 0, 'drum offset untouched');
  assertEq(gb.itemValue(gb.cursor), '+13 ms');
  gb.changeValue(-200);
  assertEq(s.gbJudgeOffsetMs, -99, 'clamped like the drum offset');

  const drum = new TrainingMenu(s, {});
  drum.setChart(parseDTX('#BPM: 120\n#00013: 01\n'));
  drum.cursor = drum.items.indexOf(ITEM.JUDGE_OFFSET);
  drum.changeValue(+5);
  assertEq(s.judgeOffsetMs, 5);
  assertEq(s.gbJudgeOffsetMs, -99, 'guitar / bass offset untouched');
  assertEq(drum.itemValue(drum.cursor), '+5 ms');
  assertEq(gb.itemValue(gb.cursor), '-99 ms');
});

test('training: LEFT and the guitar / bass judge offset are saved; old saves carry the shared offset over', () => {
  const s = new TrainingSettings();
  assertEq(s.gbLeft, false, 'LEFT off by default');
  assertEq(s.gbJudgeOffsetMs, 0);
  s.gbLeft = true;
  s.judgeOffsetMs = 7;
  s.gbJudgeOffsetMs = -12;
  const back = TrainingSettings.fromJSON(JSON.parse(JSON.stringify(s)));
  assertEq(back.gbLeft, true);
  assertEq(back.judgeOffsetMs, 7);
  assertEq(back.gbJudgeOffsetMs, -12);
  // ドラムと共有していた頃の保存(gbJudgeOffsetMs が無い)は、その値をギター / ベースにも
  const old = TrainingSettings.fromJSON({ judgeOffsetMs: 21 });
  assertEq(old.judgeOffsetMs, 21);
  assertEq(old.gbJudgeOffsetMs, 21, 'carried over from the shared value');
  assertEq(TrainingSettings.fromJSON({ judgeOffsetMs: 21, gbJudgeOffsetMs: 0 }).gbJudgeOffsetMs, 0, 'a saved 0 is kept');
  assertEq(TrainingSettings.fromJSON({ gbJudgeOffsetMs: 500 }).gbJudgeOffsetMs, 99, 'clamped');
  assertEq(TrainingSettings.fromJSON({ judgeOffsetMs: -300 }).gbJudgeOffsetMs, -99, 'the carried value is clamped too');
  assertEq(TrainingSettings.fromJSON({ gbLeft: 1 }).gbLeft, true);
});
