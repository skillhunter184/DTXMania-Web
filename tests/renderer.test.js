import { test, assert, assertEq, assertNear } from './runner.js';
import { Renderer } from '../js/ui/renderer.js';
import {
  Skin, DEFAULT_SKIN_BASE, LEGACY_SKIN_BASE, SKIN_PARTS, LANE_X0, LANE_W, LANE_Y0, LANE_Y1, LANE_LINES, PAD_H, PADS_Y,
  JUDGE_Y, JUDGE_SRC, PANELS, columnRange, isSkinFileName, collectSkinFiles, normalizeSkinPath,
} from '../js/ui/skin.js';
import { crc32 } from '../js/core/zip.js';
import { Player, PLAYER_STATE } from '../js/game/player.js';
import { TrainingSettings } from '../js/game/training.js';
import { parseDTX } from '../js/core/dtx.js';

// 横 16:9 ちょうど / 上下に余白 / 縦画面(ハイウェイだけの切り出し)
const SIZES = [[1920, 1080], [1317, 1016], [784, 1405]];

function pixels(canvas) {
  return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
}

function samePixels(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** console.warn を数えながら fn を走らせる(下敷きの失敗は catch で握りつぶされ、警告にしか出ない)。 */
function countWarns(fn) {
  const warn = console.warn;
  let n = 0;
  console.warn = (...a) => { n++; warn(...a); };
  try {
    fn();
  } finally {
    console.warn = warn;
  }
  return n;
}

function makeRenderer(player, w, h, warm) {
  const canvas = document.createElement('canvas');
  const r = new Renderer(canvas, new Skin(), player);
  if (!warm) r._warm = 0;
  r.resize(w, h, 1, 'auto', 52);
  return { r, canvas };
}

test('renderer: the effect underlay of the first frames is hidden by the static layer', () => {
  const player = { chart: null };
  for (const [w, h] of SIZES) {
    const a = makeRenderer(player, w, h, true);
    const b = makeRenderer(player, w, h, false);
    const frames = a.r._warm;
    assert(frames > 0, 'warm frames scheduled');
    a.r.draw(0);
    b.r.draw(0);
    assert(samePixels(pixels(a.canvas), pixels(b.canvas)), `${w}x${h}: first frame identical with and without the underlay`);
    const warns = countWarns(() => { for (let i = 1; i <= frames; i++) a.r.draw(0); });
    assertEq(warns, 0, 'the underlay did not fail');
    assertEq(a.r._warm, 0, 'underlay finished');
    assertEq(a.r._base.getContext('2d').getContextAttributes().alpha, false, 'static layer rebuilt opaque after the underlay');
    b.r.draw(0);
    assert(samePixels(pixels(a.canvas), pixels(b.canvas)), `${w}x${h}: identical after the underlay`);
  }
});

test('skin: the lane strip is drawn without images and matches lane_a.png', () => {
  const c = new Skin().laneStrip();
  assertEq(c.width, LANE_W);
  assertEq(c.height, LANE_Y1 - LANE_Y0);
  const row = c.getContext('2d').getImageData(0, 500, c.width, 1).data;
  const px = (x) => Array.from(row.slice(x * 4, x * 4 + 4)).join(',');
  for (const x of LANE_LINES) {
    assertEq(px(x - 1), '163,163,163,128', `line ${x} left edge`);
    assertEq(px(x), '255,255,255,128', `line ${x} core`);
    assertEq(px(x + 1), '163,163,163,128', `line ${x} right edge`);
  }
  assertEq(px(50), '0,0,0,0', 'transparent between lines');
  assertEq(px(105), '0,0,0,0', 'transparent inside the LC|HH double line');
});

test('skin: chips are shrunk once to the device pixel size and rebuilt only when the size changes', () => {
  const skin = new Skin();
  const chips = document.createElement('canvas');
  chips.width = 2000;
  chips.height = 400;
  const cg = chips.getContext('2d');
  cg.fillStyle = 'rgb(250,80,160)';
  cg.fillRect(0, 0, chips.width, chips.height);
  skin.images.chips = chips;
  skin.layouts.chips = { chips: { LC: [0, 0, 2000, 400] } };
  const target = document.createElement('canvas').getContext('2d');
  skin.drawBar(target, 'LC', 60, 20, 99, 15, 2);
  const a = skin.chipSprites.LC.canvas;
  assertEq([a.width, a.height].join('x'), '198x30', 'device pixels at devScale 2');
  skin.drawBar(target, 'LC', 300, 80, 99, 15, 2);
  assertEq(skin.chipSprites.LC.canvas, a, 'reused while the size is the same');
  skin.drawBar(target, 'LC', 60, 20, 99, 15, 1);
  const b = skin.chipSprites.LC.canvas;
  assert(b !== a, 'rebuilt for a new devScale');
  assertEq([b.width, b.height].join('x'), '99x15');
  const px = Array.from(target.getImageData(60, 20, 1, 1).data).join(',');
  assertEq(px, '250,80,160,255', 'drawn at the chip center');
});

test('renderer: the static layer is rebuilt for a new size, and follows the canvas', () => {
  const player = { chart: null };
  const { r, canvas } = makeRenderer(player, 1280, 720, false);
  r.draw(0);
  const base1 = r._base;
  assertEq(base1.width, canvas.width);
  assertEq(base1.height, canvas.height);
  r.draw(0);
  assertEq(r._base, base1, 'kept while nothing changes');
  r.resize(1000, 1000, 1, 'auto', 52);
  r.draw(0);
  assert(r._base !== base1, 'rebuilt after resize');
  assertEq(base1.width, 0, 'old pixels released');
  assertEq(r._base.width, canvas.width);
});

test('renderer: draws a playing frame with every effect active (landscape and portrait)', async () => {
  const audio = {
    ctx: { get currentTime() { return 3; } },
    outputLatencySec: 0,
    buffers: new Map(),
    async loadChartSounds() { return this.buffers; },
    hasBuffer() { return false; },
    play() { return { src: null }; },
    playBuffer() { return { src: null }; },
    stopVoice() {},
    stopAll() {},
    synthBuffer(lane) { return { lane }; },
  };
  const settings = new TrainingSettings();
  const player = new Player({ audio, settings, config: {} });
  await player.load({ resolve() { return null; }, readBytes() {} }, parseDTX('#BPM: 120\n#00012: 01010101\n#00013: 01000100\n#0004F: 01\n'));
  settings.loop = true;
  settings.loopBeginMs = 0;
  settings.loopEndMs = 4000;
  player.applySettings();
  player.state = PLAYER_STATE.PLAYING;
  player._anchorReal = 0;
  player._anchorSong = 1900;
  const now = 10000;
  for (let lane = 0; lane < 10; lane++) {
    player.laneFlashUntil[lane] = now + 60;
    player.padHitAt[lane] = now - 20 - lane * 10;
    player.fireAt[lane] = now - 10 - lane * 15;
    player.judgeStr[lane] = { at: now - lane * 30, judge: lane % 5, lagMs: lane * 3 - 12, auto: lane === 9 };
  }
  player.stats.combo = 123;
  player.comboJumpAt = now - 60;
  for (const [w, h] of [[1920, 1080], [784, 1405]]) {
    const { r } = makeRenderer(player, w, h, true);
    assertEq(countWarns(() => { for (let i = 0; i < 12; i++) r.draw(now + i); }), 0, 'no underlay failure');
    assertEq(r._warm, 0);
  }
});

// ---- スキン(決まった名前の画像の組。skins/README.md) ----

const DEFAULT_BASE = '../' + DEFAULT_SKIN_BASE;

/** 範囲 [x0, x1) × [y0, y1)(画素)の内と外の不透明な画素の数。 */
function opaqueCount(canvas, x0, y0, x1, y1) {
  const d = pixels(canvas);
  let inside = 0;
  let outside = 0;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (d[(y * canvas.width + x) * 4 + 3] <= 8) continue;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) inside++;
      else outside++;
    }
  }
  return { inside, outside, area: (x1 - x0) * (y1 - y0) };
}

/** w×h の塗りつぶしの PNG(読み込んだ画像のスキンの代わり)。 */
function pngBlob(w, h, color = 'rgb(200,60,60)') {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.fillRect(0, 0, w, h);
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

/** 格納(無圧縮)だけの ZIP を組む。entries: [名前, Uint8Array]。 */
function storedZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let off = 0;
  for (const [name, data] of entries) {
    const nb = enc.encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nb.length, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nb.length, true);
    cd.setUint32(42, off, true);
    parts.push(local, nb, data);
    central.push(cd, nb);
    off += 30 + nb.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, off, true);
  return new Blob([...parts, ...central, end]);
}

/** console.warn を黙らせて fn を待つ(読めない画像の警告はわざと出している)。 */
async function quiet(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
}

test('skin: the bundled default skin is read as images in the standard layout', async () => {
  const skin = await Skin.load(null, { defaultBase: DEFAULT_BASE });
  assertEq(Object.keys(skin.images).sort().join(','), 'chips,gbChips,gbNeck,pads,scorePanel,songPanel', 'every part is an image');
  assertEq(skin.missing.length, 0, 'nothing missing');
  for (const [part, cands] of Object.entries(SKIN_PARTS)) {
    const img = skin.images[part];
    const k = skin.scales[part];
    assert(k >= 1, `${part}: at least the logical size (x${k})`);
    assertNear(img.width, cands[0].w * k, 0.01, `${part} width`);
    assertNear(img.height, cands[0].h * k, 1, `${part}: height at the same scale`);
  }
  // パネルは画像全体がパネルで、数の位置も画像の倍率に合わせてある
  const sp = skin.scorePanel;
  assertEq(sp.src.join(','), [0, 0, skin.images.scorePanel.width, skin.images.scorePanel.height].join(','));
  assertNear(sp.rows[0], SKIN_PARTS.scorePanel[0].layout.rows[0] * skin.scales.scorePanel, 1e-9);
  assertEq(skin.pads.gray.width, Math.round(LANE_W * skin.scales.pads), 'pad rows kept at the image scale');
  assertEq(skin.judge.width, JUDGE_SRC[2] * skin.scales.pads);
});

test('skin: a skin in the earlier file names is read in its own layout; missing images come from the default skin', async () => {
  const files = new Map([
    ['drum_chips_hd.webp', await pngBlob(2000, 667)],
    ['drum_pads.png', await pngBlob(780, 189)],
  ]);
  const skin = await Skin.load({ files }, { defaultBase: DEFAULT_BASE });
  assertEq(skin.layouts.chips.chips.LC.join(','), '9,308,245,48', 'earlier chip sheet');
  assertEq(skin.layouts.chips.chips.RD.join(','), skin.layouts.chips.chips.CY.join(','), 'RD uses the CY chip');
  assertEq(skin.scales.pads, 1);
  assertEq(skin.missing.join(','), 'score_panel.png,song_panel.png,gb_chips.png,gb_neck.png', 'reported by the standard names');
  assert(skin.images.scorePanel && skin.images.songPanel, 'panels taken from the default skin');
  assertEq(skin.scorePanel.src[0], 0, 'default panel in the standard layout');
});

test('skin: a high-resolution skin is scaled to its layout and drawn at the logical size', async () => {
  const files = new Map([
    ['CHIPS.PNG', await pngBlob(384, 720)],
    ['pads.webp', await pngBlob(2340, 567)],
    ['score_panel.jpg', await pngBlob(744, 792)],
    ['song_panel.png', await pngBlob(1332, 417)],
    ['gb_chips.png', await pngBlob(960, 540)],
    ['GB_NECK.webp', await pngBlob(1272, 1224)],
  ]);
  const skin = await Skin.load({ files }, { defaultBase: null });
  assertEq(skin.missing.length, 0, 'names match without case or extension');
  assertEq(skin.layouts.chips.chips.LC.join(','), '12,12,360,48', 'chip cell x3');
  assertEq(skin.layouts.chips.chips.RD.join(','), '12,660,360,48', 'the last row (RD)');
  assertEq(skin.scorePanel.countRight, 152 * 3);
  assertEq(skin.songPanel.jacket.join(','), '30,90,300,300');
  assertEq(skin.layouts.gbChips.wail.join(','), '12,216,243,306', 'guitar parts scaled too');
  const c = document.createElement('canvas');
  c.width = 1920;
  c.height = 1080;
  const g = c.getContext('2d');
  skin.drawJudge(g);
  const n = opaqueCount(c, LANE_X0, JUDGE_Y - 6, LANE_X0 + JUDGE_SRC[2], JUDGE_Y + 6);
  assertEq(n.outside, 0, 'judge line drawn at 780x11');
  assertEq(n.inside, JUDGE_SRC[2] * JUDGE_SRC[3]);
});

test('skin: picked images and ZIPs keep only the skin images; folder paths get a trailing slash', async () => {
  assert(isSkinFileName('chips.png'));
  assert(isSkinFileName('My Skin/PADS.webp'));
  assert(isSkinFileName('score_detailed_hd.png'), 'earlier names too');
  assert(!isSkinFileName('chips.txt'));
  assert(!isSkinFileName('readme.png'));
  const png = await pngBlob(4, 4);
  const picked = await collectSkinFiles([new File([png], 'chips.png'), new File([png], 'notes.png'), new File([png], 'chips.webp')]);
  assertEq(picked.map((f) => f.name).join(','), 'chips.webp', 'the later file of the same name wins; others dropped');
  const bytes = new Uint8Array(await png.arrayBuffer());
  const zip = new File([storedZip([['MySkin/song_panel.png', bytes], ['__MACOSX/MySkin/._song_panel.png', bytes], ['MySkin/readme.txt', bytes]])], 'skin.zip');
  const fromZip = await collectSkinFiles([zip]);
  assertEq(fromZip.map((f) => f.name).join(','), 'song_panel.png', 'images in the ZIP by file name');
  assertEq(fromZip[0].blob.type, 'image/png');
  assertEq(normalizeSkinPath(' assets\\skin\\Mine '), 'assets/skin/Mine/');
  assertEq(normalizeSkinPath('skins/x/'), 'skins/x/');
  assertEq(normalizeSkinPath(''), LEGACY_SKIN_BASE);
});

test('skin: without any image every part falls back to plain shapes inside its box', async () => {
  const skin = await quiet(() => Skin.load({ base: 'no-such-skin/' }, { defaultBase: 'no-such-default/' }));
  assertEq(Object.keys(skin.images).length, 0);
  assertEq(skin.missing.join(','), 'chips.png,pads.png,score_panel.png,song_panel.png,gb_chips.png,gb_neck.png');
  assertEq(skin.scorePanel.rows.length, 6, 'numbers still placed by the standard layout');
  assertEq(skin.judge, null);
  const c = document.createElement('canvas');
  c.width = 1920;
  c.height = 1080;
  const g = c.getContext('2d');
  skin.drawJudge(g);
  skin.drawPads(g, 1);
  const n = opaqueCount(c, LANE_X0, JUDGE_Y - 6, LANE_X0 + LANE_W + 2, PADS_Y + PAD_H);
  assertEq(n.outside, 0, 'judge line and pads inside the bottom of the highway');
  assert(n.inside > 0);
});

test('skin: pad rows follow the display scale without images, and a lit pad is cut to its column', () => {
  const skin = new Skin();
  const c = document.createElement('canvas');
  c.width = 1920;
  c.height = 1080;
  const g = c.getContext('2d');
  skin.drawPads(g, 0.8);
  const rows1 = skin.pads;
  assertEq([rows1.gray.width, rows1.gray.height].join('x'), `${LANE_W}x${PAD_H}`, 'at least 1 px per logical px');
  skin.drawPads(g, 1);
  assertEq(skin.pads, rows1, 'kept while the scale rounds to the same size');
  skin.drawPads(g, 2);
  assert(skin.pads !== rows1, 'rebuilt for a new scale');
  assertEq(rows1.gray.width, 0, 'old pixels released');
  assertEq([skin.pads.lit.width, skin.pads.lit.height].join('x'), `${LANE_W * 2}x${PAD_H * 2}`);
  g.clearRect(0, 0, c.width, c.height);
  const [x0, x1] = columnRange(3); // SD
  skin.drawPadLit(g, x0, x1, PADS_Y, 2);
  const n = opaqueCount(c, x0, PADS_Y, x1, PADS_Y + PAD_H);
  assertEq(n.outside, 0, 'nothing outside the column');
  assert(n.inside > n.area * 0.3, 'the lit SD pad is drawn');

  // 画像のパッド列は画像の倍率のまま使う(表示の倍率で作り直さない)
  const img = document.createElement('canvas');
  img.width = 780 * 2;
  img.height = 189 * 2;
  img.getContext('2d').fillRect(0, 0, img.width, img.height);
  const skin2 = new Skin();
  skin2.images.pads = img;
  skin2.layouts.pads =JSON.parse(JSON.stringify(SKIN_PARTS.pads[0].layout), (k, v) => (typeof v === 'number' ? v * 2 : v));
  skin2.scales.pads = 2;
  skin2._prerender();
  const rows2 = skin2.pads;
  skin2.drawPads(g, 1);
  assertEq(skin2.pads, rows2);
  assertEq(rows2.gray.width, LANE_W * 2);
  assertEq(rows2.gray.height, PAD_H * 2);
  assertEq(skin2.judge.width, JUDGE_SRC[2] * 2);
});

test('skin: panels stay inside their rectangles (default skin and plain shapes)', async () => {
  const skins = [['plain', new Skin()], ['default', await Skin.load(null, { defaultBase: DEFAULT_BASE })]];
  for (const [label, skin] of skins) {
    for (const [key, draw] of [['scoreDetailed', (g) => skin.drawScorePanel(g)], ['songInfo', (g) => skin.drawSongPanel(g)]]) {
      const c = document.createElement('canvas');
      c.width = 1920;
      c.height = 1080;
      const g = c.getContext('2d');
      draw(g);
      const r = PANELS[key];
      const n = opaqueCount(c, Math.floor(r.x), Math.floor(r.y), Math.ceil(r.x + r.w), Math.ceil(r.y + r.h));
      assertEq(n.outside, 0, `${label} ${key}: nothing outside the panel`);
      assert(n.inside > n.area * 0.5, `${label} ${key}: drawn`);
    }
  }
});
