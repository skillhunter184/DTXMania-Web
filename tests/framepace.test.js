import { test, assert, assertEq, assertNear } from './runner.js';
import { estimateHz, frameDivisor, FramePacer, IDLE_DRAW_FPS } from '../js/ui/framepace.js';

/** hz の画面の rAF の時刻を n 個(q ms に切り捨て。Chrome は 0.1 ms、Firefox / Safari は 1 ms)。 */
function rafTimes(hz, n, q, t0 = 1000) {
  const a = [];
  for (let i = 0; i < n; i++) a.push(Math.floor((t0 + (i * 1000) / hz) / q) * q);
  return a;
}
const diffs = (ts) => ts.slice(1).map((t, i) => t - ts[i]);

test('framepace: refresh rate estimate within ±1 Hz for rounded rAF timestamps', () => {
  for (const q of [0.1, 1]) {
    for (const hz of [60, 144, 170, 240, 360]) {
      assertNear(estimateHz(diffs(rafTimes(hz, 91, q))), hz, 1, `${hz} Hz, ${q} ms steps`);
    }
  }
  assertEq(estimateHz([2.8, 2.7]), 0, 'too few samples');
  // 同じ描画更新の rAF(0)とタブが隠れていた間(100 ms 以上)は捨て、1 回の落ち(2 回ぶん)は 2 回と数える
  const d = diffs(rafTimes(360, 60, 0.1));
  d.push(0, 0, 250, 5.6);
  assertNear(estimateHz(d), 360, 1, 'outliers');
});

test('framepace: divisor picks the k whose rate is closest in ratio to the cap', () => {
  assertEq(frameDivisor(360, 60), 6);
  assertEq(frameDivisor(240, 60), 4);
  assertEq(frameDivisor(144, 60), 2);
  assertEq(frameDivisor(120, 60), 2);
  assertEq(frameDivisor(165, 60), 3);
  assertEq(frameDivisor(60, 60), 1);
  assertEq(frameDivisor(59.9, 60), 1);
  assertEq(frameDivisor(360, 0), 1, 'no cap');
  assertEq(frameDivisor(0, 60), 1, 'not measured yet');
});

test('framepace: about 60 draws per second at 360 Hz while idle, every frame otherwise, forced after resize', () => {
  const p = new FramePacer();
  const ts = rafTimes(360, 720, 0.1);
  let drawn = 0;
  for (let i = 0; i < ts.length; i++) {
    p.tick(ts[i]);
    if (p.shouldDraw(ts[i], IDLE_DRAW_FPS) && i >= 360) drawn++;
  }
  assertNear(p.hz, 360, 1);
  assert(drawn >= 59 && drawn <= 61, 'idle draws in the second second: ' + drawn);

  let all = 0;
  for (const t of rafTimes(360, 360, 0.1, ts[ts.length - 1] + 1000 / 360)) {
    p.tick(t);
    if (p.shouldDraw(t, 0)) all++;
  }
  assertEq(all, 360, 'no cap → every frame');

  // 描いた直後でも、resize の後は描く
  const t = ts[ts.length - 1] + 3000;
  p.tick(t);
  p.shouldDraw(t, IDLE_DRAW_FPS);
  assertEq(p.shouldDraw(t + 2.8, IDLE_DRAW_FPS), false, 'skipped right after a draw');
  p.forceNext();
  assertEq(p.shouldDraw(t + 2.8, IDLE_DRAW_FPS), true, 'forced');

  // 測りが 360 Hz のまま 1 フレームが 16.7 ms かかるようになっても、毎回描く(時間で見るので落ちない)
  let slow = 0;
  for (let i = 1; i <= 20; i++) if (p.shouldDraw(t + 2.8 + i * 16.7, IDLE_DRAW_FPS)) slow++;
  assertEq(slow, 20, 'time-based, not count-based');
});
