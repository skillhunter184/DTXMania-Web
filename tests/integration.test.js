// 実曲パック(tests/fixtures/local/*.zip、git 管理外)を使った結合テスト。無ければスキップする。
import { test, assert, assertEq } from './runner.js';
import { SongPackage } from '../js/core/song.js';
import { AudioEngine } from '../js/core/audio.js';
import { requiredWavIds } from '../js/core/dtx.js';

async function fetchLocal(name) {
  const r = await fetch('fixtures/local/' + name);
  if (!r.ok) return null;
  return r.blob();
}

test('integration: monster.zip (set.def, 4 charts, ogg/xa decode)', async () => {
  const blob = await fetchLocal('monster.zip');
  if (!blob) { console.warn('skip: monster.zip not present'); return; }
  const pkg = await SongPackage.fromZip(blob, 'monster.zip');
  assert(pkg.songs.length >= 1, 'songs found');
  const song = pkg.songs[0];
  assert(song.charts.length >= 2, 'multiple difficulties: ' + song.charts.map((c) => c.label).join(','));
  const chart = await pkg.loadChart(song.charts[song.charts.length - 1].path);
  assert(chart.notes.length > 100, 'notes: ' + chart.notes.length);
  assert(chart.bgmEvents.length >= 1, 'bgm');
  assert(chart.barLines.length > 10, 'bar lines');
  const ids = requiredWavIds(chart);
  assert(ids.length > 3, 'wav ids');
  // 参照される音源ファイルが ZIP 内で解決できる
  let resolved = 0;
  for (const id of ids) if (pkg.resolve(chart.dir, chart.wavDefs.get(id))) resolved++;
  assert(resolved === ids.length, `resolved ${resolved}/${ids.length}`);
  const engine = new AudioEngine();
  await engine.ensureContext();
  const t0 = performance.now();
  await engine.loadChartSounds(pkg, chart);
  const ms = performance.now() - t0;
  console.log('decoded', engine.buffers.size, 'buffers in', ms.toFixed(0), 'ms; failed:', engine.failed);
  assertEq(engine.failed.length, 0, 'all sounds decoded: ' + JSON.stringify(engine.failed));
  const bgm = engine.buffers.get(chart.bgmEvents[0].wavId);
  assert(bgm && bgm.duration > 30, 'bgm decoded: ' + (bgm && bgm.duration));
});

test('integration: smooooch.zip (loose .dtx files without set.def)', async () => {
  const blob = await fetchLocal('smooooch.zip');
  if (!blob) { console.warn('skip: smooooch.zip not present'); return; }
  const pkg = await SongPackage.fromZip(blob, 'smooooch.zip');
  assert(pkg.songs.length >= 3, 'each .dtx listed: ' + pkg.songs.length);
  const s = pkg.songs.find((x) => x.charts[0].path.endsWith('vid2dtx.dtx'));
  assert(s, 'vid2dtx.dtx present');
  const chart = await pkg.loadChart(s.charts[0].path);
  assert(chart.notes.length > 500, 'notes: ' + chart.notes.length);
});

// 楽器別のファイルに分かれた GITADORA 形式のパック(dm_* / gt_* / ba_* と set.def の 3 ブロック)。
// 「完全感覚Dreamer Taka.zip」を tests/fixtures/local/dreamer.zip としてコピーしたとき走る
test('integration: dreamer.zip (split drum / guitar / bass files merged into one song)', async () => {
  const blob = await fetchLocal('dreamer.zip');
  if (!blob) { console.warn('skip: dreamer.zip not present'); return; }
  const pkg = await SongPackage.fromZip(blob, 'dreamer.zip');
  assertEq(pkg.songs.length, 1, 'the three set.def blocks are one song');
  const song = pkg.songs[0];
  assertEq(song.title, '完全感覚Dreamer');
  assertEq(song.charts.length, 12);
  const of = (name) => song.charts.find((c) => c.path.endsWith(name));
  assertEq(of('gt_mst.dtx').header.noteMask, 2);
  assertEq(of('ba_mst.dtx').header.noteMask, 4);
  assertEq(of('dm_mst.dtx').header.noteMask, 1);
  assertEq(of('gt_mst.dtx').header.levels[1], 74);
  const gt = await pkg.loadChart(of('gt_mst.dtx').path);
  assertEq(gt.guitar.notes.length, 537);
  assertEq(gt.guitar.notes.filter((n) => n.lnEndMs >= 0).length, 6);
  assertEq(gt.guitar.notes.filter((n) => n.open).length, 39);
  assertEq(gt.guitar.wailing.length, 4);
  assertEq(gt.guitar.hasYP, true);
  const ba = await pkg.loadChart(of('ba_mst.dtx').path);
  assertEq(ba.bass.notes.length, 501);
  assertEq(ba.bass.notes.filter((n) => n.lnEndMs >= 0).length, 13);
  const bsc = await pkg.loadChart(of('ba_bsc.dtx').path);
  assertEq(bsc.bass.notes.filter((n) => n.lnEndMs >= 0).length, 12, 'stray LN control chips (no note at their position) are skipped');
  // ギターの譜面の音(チップ・BGM)がすべてパック内で解決できる
  const ids = requiredWavIds(gt);
  let resolved = 0;
  for (const id of ids) if (pkg.resolve(gt.dir, gt.wavDefs.get(id))) resolved++;
  assertEq(resolved, ids.length, `resolved ${resolved}/${ids.length}`);
});
