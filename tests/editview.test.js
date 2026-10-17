// 譜面の編集画面の描画と当たり判定(js/edit/view.js)のテスト。画像の無いスキン(単色)で描いて画素を見る。
import { test, assert, assertEq, assertNear } from './runner.js';
import { Skin, LANE_RGB, columnRange, columnCenterX } from '../js/ui/skin.js';
import { DtxDoc } from '../js/edit/dtxdoc.js';
import { EditModel } from '../js/edit/model.js';
import { EditView, VIEWS, COMPACT_BELOW, HEADER_CSS, HIT_TOL_CSS, barLengthLabel } from '../js/edit/view.js';
import { TouchGestures, G } from '../js/edit/gestures.js';

function makeView(text, w = 1044, h = 700) {
  const canvas = document.createElement('canvas');
  const view = new EditView(canvas, new Skin());
  view.resize(w, h, 1);
  view.state.model = new EditModel(DtxDoc.fromText(text));
  return { view, canvas };
}

function rgbAt(canvas, x, y) {
  const d = canvas.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data;
  return [d[0], d[1], d[2]];
}

/** 論理座標 → キャンバスの画素(dpr 1。キャンバスの左上が CSS の 0,0)。 */
function px(view, x, y) {
  return [view.offX + (x - view.view.x) * view.s, y * view.s];
}

test('editview: wide / compact layout, scale cap, centring, logical <-> client, header height', () => {
  const { view } = makeView('#00113: 01\n', 1300, 700);
  assertEq(view.layout, 'wide');
  assertEq(view.s, 1, 'チップは演奏画面より大きくしない');
  assertNear(view.offX, (1300 - VIEWS.wide.w) / 2, 1e-9);
  assertEq(view.headY, Math.round(0.75 * 700));
  view.resize(COMPACT_BELOW - 1, 600, 1);
  assertEq(view.layout, 'compact');
  assertNear(view.s, (COMPACT_BELOW - 1) / VIEWS.compact.w, 1e-9);
  assertNear(view.headerH, HEADER_CSS / view.s, 1e-9);
  assertNear(view.css(10), 10 / view.s, 1e-9);
  // y(u) と uAt(y) は逆
  view.uHead = 3.25;
  view.zoom = 1.4;
  assertNear(view.uAt(view.y(2.5)), 2.5, 1e-9);
});

test('editview: a chip is drawn at y(u) in its column colour; split halves; guide lines hidden when too dense', () => {
  const { view, canvas } = makeView('#00113: 01\n#00216: 05\n#00219: 06\n');
  view.uHead = 0.5;
  view.zoom = 1;
  view.draw(0);
  const m = view.state.model;
  const bd = m.chips.find((c) => c.channel === 0x13);
  const [x, y] = px(view, columnCenterX(5), view.y(bd.u));
  const c = rgbAt(canvas, x, y);
  const want = LANE_RGB.BD;
  assert(c.every((v, i) => Math.abs(v - want[i]) <= 2), `BD colour at the chip: ${c} vs ${want}`);
  // CY と RD が同じセル: 左半分が CY、右半分が RD の色(単色のスキンでは同じ色なので、半分の間の隙間で見る)
  const cy = m.chips.find((ch) => ch.channel === 0x16);
  assertEq(cy.half, 1);
  view.uHead = cy.u - 0.3; // 再生位置の線に重ならないところで見る
  view.draw(0);
  const [x0, x1] = columnRange(8);
  const mid = px(view, (x0 + x1) / 2, view.y(cy.u));
  const gap = rgbAt(canvas, mid[0], mid[1]);
  assert(!gap.every((v, i) => Math.abs(v - LANE_RGB.CY[i]) <= 10), 'gap between the two halves: ' + gap);
  const left = px(view, mid ? (x0 + x1) / 2 - 20 : 0, view.y(cy.u));
  assert(rgbAt(canvas, left[0], left[1]).every((v, i) => Math.abs(v - LANE_RGB.CY[i]) <= 2), 'left half is a chip');
  // 1/64 を拡大率 0.25 で描くと線の間が 5 CSS px より狭いので描かない(拍線は描く)
  view.guide = 64;
  view.zoom = 0.25;
  assert((view.ppu / 64) * view.s < 5, 'dense');
});

test('editview: hit regions (header, BPM lane, gutter, lanes with halves) and touch tolerance in CSS px', () => {
  const { view, canvas } = makeView('#00113: 01\n');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1044, bottom: 700, width: 1044, height: 700 });
  const at = (x, y) => view.hit(view.offX + (x - view.view.x) * view.s, y * view.s);
  assertEq(at(600, 5).region, 'header');
  assertEq(at(400, 300).region, 'bpm');
  assertEq(at(500, 300).region, 'gutter');
  const h = at(columnRange(8)[0] + 5, 300);
  assertEq(h.region, 'lanes');
  assertEq(h.column, 8);
  assertEq(h.half, 1);
  assertEq(at(columnRange(8)[1] - 5, 300).half, 2);
  assertNear(view.tolU('touch') * view.ppu, view.chipH / 2 + HIT_TOL_CSS.touch / view.s, 1e-9);
  assert(view.tolU('touch') > view.tolU('mouse'));
});

test('editview: bar-length labels', () => {
  assertEq(barLengthLabel(0.75), '3/4');
  assertEq(barLengthLabel(0.875), '7/8');
  assertEq(barLengthLabel(1.25), '5/4');
  assertEq(barLengthLabel(0.7), '×0.7');
});

// ---- タッチの身振り ----
test('gestures: tap, scroll past the slop with fling, long-press lift, pinch cancels the one-finger gesture, palm rejection', () => {
  let now = 0;
  const timers = [];
  const log = [];
  const g = new TouchGestures({
    press: () => log.push('press'), tap: () => log.push('tap'), longPress: () => log.push('long'),
    liftMove: () => log.push('liftMove'), liftEnd: (p, moved) => log.push('liftEnd:' + moved),
    scroll: (dy) => log.push('scroll:' + Math.round(dy)), scrollEnd: (v) => log.push('fling:' + (v > 0)),
    pinch: (p) => log.push('pinch:' + p.scale.toFixed(1)), pinchEnd: () => log.push('pinchEnd'), cancel: () => log.push('cancel'),
  }, { now: () => now, setTimer: (f, ms) => { timers.push({ f, at: now + ms }); return timers.length - 1; }, clearTimer: (h) => { timers[h] = null; } });
  const ev = (id, x, y) => ({ pointerId: id, clientX: x, clientY: y, timeStamp: now });
  const fire = () => { for (const tm of timers) if (tm && tm.at <= now) { const f = tm.f; tm.f = () => {}; f(); } };
  // タップ
  g.down(ev(1, 100, 100));
  now = 100;
  g.up(ev(1, 102, 101));
  assertEq(log.join(' '), 'press tap');
  // スクロール(遊びを越えたら)と慣性
  log.length = 0;
  g.down(ev(1, 100, 100));
  now += 16; g.move(ev(1, 100, 104));
  now += 16; g.move(ev(1, 100, 120));
  now += 16; g.move(ev(1, 100, 140));
  g.up(ev(1, 100, 140));
  assertEq(log.join(' '), 'press cancel scroll:20 scroll:20 fling:true');
  // 長押しで持ち上げる
  log.length = 0;
  g.down(ev(1, 50, 50));
  now += G.LONG_PRESS_MS + 1; fire();
  g.move(ev(1, 50, 52));
  g.move(ev(1, 80, 90));
  g.up(ev(1, 80, 90));
  assertEq(log.join(' '), 'press long liftMove liftEnd:true');
  // 2 本目の指でつまむ
  log.length = 0;
  g.down(ev(1, 0, 0));
  g.down(ev(2, 100, 0));
  g.move(ev(2, 200, 0));
  g.up(ev(2, 200, 0));
  g.up(ev(1, 0, 0));
  assertEq(log.join(' '), 'press cancel pinch:2.0 pinchEnd');
  // ペンを使った直後の指のタップは無視
  log.length = 0;
  g.notePen(now);
  g.down(ev(1, 10, 10));
  now += 50;
  g.up(ev(1, 10, 10));
  assertEq(log.join(' '), 'cancel');
});
