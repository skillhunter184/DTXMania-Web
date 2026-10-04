import { test, assert, assertEq, assertDeepEq } from './runner.js';
import { TrainingSettings, LOOP_UNIT } from '../js/game/training.js';
import { TrainingMenu, MENU_COMMAND } from '../js/ui/menu.js';
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
  assertEq(m.itemCount, 18);
  assertEq(m.itemName(0), '自動演奏');
  assertEq(m.itemName(7), 'ドラム音量');
  assertEq(m.itemName(8), 'BGM 音量');
  assertEq(m.itemName(13), '現在位置');
  assertEq(m.itemName(14), '演奏開始');
  m.playing = true;
  assertEq(m.itemName(14), '演奏停止');
  m.paused = true;
  assertEq(m.itemName(16), '再開');
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
  assertEq(m.itemValue(9), 'OFF');
  s.loop = true;
  s.loopBeginMs = 0;
  s.loopEndMs = 0;
  assertEq(m.itemValue(9), 'ON (無効)');
  s.loopEndMs = 4000;
  assertEq(m.itemValue(9), 'ON');
  assertEq(m.itemValue(10), '小節');
  // 小節一覧は [0(リードイン), 2000(小節0), 4000(小節1), ...] で、表示はその添字(DTXManiaAI と同じ)
  assertEq(m.itemValue(11), '002 小節');
  assertEq(m.itemValue(12), '000 小節');
  s.loopUnit = LOOP_UNIT.SECOND;
  assertEq(m.itemValue(11), '4.0 s');
});

test('menu: cursor wraps, Enter on value items steps +1, Ctrl x10, clamps', () => {
  const { m, s, sounds } = makeMenu();
  const t = 1000;
  m.keyDown('ArrowUp', false, t);
  m.keyUp('ArrowUp');
  assertEq(m.cursor, 17, 'wrap to last');
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
  m.cursor = 14;
  m.keyDown('Enter', false, 0);
  assertEq(m.takeCommand(), MENU_COMMAND.START_STOP);
  m.cursor = 16;
  m.playing = false;
  m.keyDown('Enter', false, 0);
  assertEq(m.takeCommand(), MENU_COMMAND.PAUSE_RESUME, 'returned even in standby (the player ignores it)');
  assertEq(m.isDisabled(16), true, 'greyed while not playing');
  m.playing = true;
  m.keyDown('Enter', false, 0);
  assertEq(m.takeCommand(), MENU_COMMAND.PAUSE_RESUME);
  assertEq(m.isDisabled(11), true, 'loop rows disabled while loop off');
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
  m.cursor = 12; // 開始位置
  m.keyDown('ArrowRight', true, 0); // +10 小節 → 終了の 1 段手前(小節 2 = 4000)
  m.keyUp('ArrowRight');
  assertEq(s.loopBeginMs, 4000);
  m.cursor = 11; // 終了位置
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
    assertEq(m.rows[14].name.textContent, '演奏停止');
    assertEq(m.rows[16].name.textContent, '再開');
    assertEq(m.rows[16].li.classList.contains('disabled'), false, 'PAUSE row enabled while playing');
    assertEq(m.state.textContent, 'PLAYING');
    m.refresh();
    assertEq(mo.takeRecords().length, 0, 'steady while playing');

    // 動作の行には ◀ ▶ が無く、値の行にはある
    assertEq(m.rows[14].left.hidden, true);
    assertEq(m.rows[2].left.hidden, false);

    // 自動演奏詳細へ入ると見出しが変わり、使わない行(12〜17)が隠れる。戻ると元どおり
    m.cursor = 1;
    m.keyDown('Enter', false, 0);
    assertEq(m.page, 'auto');
    assertEq(m.header.textContent, 'TRAINING - 自動演奏詳細');
    for (let i = 12; i < 18; i++) assertEq(m.rows[i].li.hidden, true, 'row ' + i + ' hidden');
    assertEq(m.rows[11].left.hidden, true, '戻る has no buttons');
    mo.takeRecords();
    m.refresh();
    assertEq(mo.takeRecords().length, 0, 'steady in the submenu');
    m.keyDown('Escape', false, 0);
    assertEq(m.page, 'main');
    assertEq(m.header.textContent, 'TRAINING');
    for (let i = 12; i < 18; i++) assertEq(m.rows[i].li.hidden, false, 'row ' + i + ' shown again');

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
  assertEq(m.itemCount, 19);
  assertEq(m.itemName(7), 'ベース音量');
  assertEq(m.itemValue(7), '70 %');
  assertEq(m.itemName(9), 'リバース');
  assertEq(m.itemValue(9), 'OFF');
  assertEq(m.itemName(10), 'ループ演奏');
  assertEq(m.itemName(15), '演奏開始');
  assertEq(m.itemName(18), 'トレーニング終了');
  // リバースの切り替え
  m.cursor = 9;
  m.keyDown('ArrowRight', false, 0);
  m.keyUp('ArrowRight');
  assertEq(s.gbReverse, true);
  assertEq(m.itemValue(9), 'ON');
  // ハイスピードはドラムと別
  m.cursor = 4;
  m.keyDown('ArrowRight', true, 0);
  m.keyUp('ArrowRight');
  assertEq(s.gbScrollSpeedTenth, 30);
  assertEq(s.scrollSpeedTenth, 10, 'drum hi-speed untouched');
  assertEq(m.itemValue(4), 'x3.0');
  // 音量は 'chip' のバス(main.js がギター / ベース音量に振り分ける)
  m.cursor = 7;
  m.keyDown('ArrowLeft', false, 0);
  m.keyUp('ArrowLeft');
  assertDeepEq(volumes, [['chip', -5]]);
  // 動作の行(番号がドラムと 1 つずれる)
  m.cursor = 15;
  m.keyDown('Enter', false, 0);
  assertEq(m.takeCommand(), MENU_COMMAND.START_STOP);
  m.cursor = 18;
  assertEq(m.isAction(18), true);
  // 自動演奏詳細: R G B Y P PICK WAIL
  m.cursor = 1;
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
  assertEq(m.cursor, 1);
  assertEq(m.itemValue(1), 'すべて');
});

test('menu: guitar / bass 現在位置 works with loop off (row → item mapping)', () => {
  for (const instrument of [INSTRUMENT.DRUMS, INSTRUMENT.GUITAR, INSTRUMENT.BASS]) {
    const s = new TrainingSettings();
    const seeks = [];
    const m = new TrainingMenu(s, { instrument, canSeek: () => true, getPositionMs: () => 0, onSeek: (ms) => { seeks.push(ms); return true; } });
    m.setChart(parseDTX('#BPM: 120\n#00013: 01\n#00313: 01\n'));
    m.cursor = m.items.indexOf(13); // ITEM.POSITION
    assertEq(m.itemName(m.cursor), '現在位置');
    assertEq(s.loop, false);
    m.keyDown('ArrowRight', false, 0);
    m.keyUp('ArrowRight');
    assertDeepEq(seeks, [2000], 'instrument ' + instrument);
  }
});
