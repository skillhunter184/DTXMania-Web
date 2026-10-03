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
