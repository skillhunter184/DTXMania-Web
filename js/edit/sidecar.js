// vid2dtx の確信度のファイル(<譜面>.dtx.conf.json)を読む(docs/spec/vid2dtx-edit.md §8・§12)。
// 確信度の低いチップに枠を付け、「次の要確認」で低い順に回る。ファイルは書き換えない(書き出す ZIP にはそのまま入る)。

/** 枠を付ける確信度の上限(これより低い)。0.4 未満は赤、それ以外は橙。 */
export const SUSPECT_BELOW = 0.7;

/**
 * @returns {Promise<Map<string, {conf: number, why: string}>|null>} `${小節}.${tick}.${チャンネル}` → 確信度。無ければ null
 */
export async function loadSidecar(pkg, chartPath) {
  const ent = pkg.entry(chartPath + '.conf.json');
  if (!ent) return null;
  try {
    const json = JSON.parse(new TextDecoder('utf-8').decode(await pkg.readBytes(ent)));
    const out = new Map();
    for (const c of (json && json.chips) || []) {
      const m = parseInt(c.m, 10);
      const tick = parseInt(c.tick, 10);
      const ch = parseInt(c.ch, 10);
      const conf = Number(c.conf);
      if (![m, tick, ch].every(Number.isFinite) || !Number.isFinite(conf)) continue;
      out.set(`${m}.${tick}.${ch}`, { conf, why: typeof c.why === 'string' ? c.why : '' });
    }
    return out;
  } catch (e) {
    console.warn('確信度のファイルを読めません:', chartPath, e);
    return null;
  }
}

/** 今の譜面のチップのうち確信度の低いもの(チップの名前 → 確信度)。動かしたチップは枠が外れる(vid2dtx と同じ)。 */
export function suspectsOf(model, sidecar) {
  const out = new Map();
  if (!sidecar) return out;
  for (const c of model.chips) {
    if (c.locked) continue;
    const s = sidecar.get(`${c.measure}.${c.tick}.${c.channel}`);
    if (s && s.conf < SUSPECT_BELOW) out.set(c.key, s.conf);
  }
  return out;
}

/** 回る順(確信度の低い順、同じなら前から)。 */
export function suspectOrder(model, suspects) {
  return [...suspects.entries()]
    .map(([key, conf]) => ({ chip: model.chip(key), conf }))
    .filter((x) => x.chip)
    .sort((a, b) => a.conf - b.conf || a.chip.u - b.chip.u);
}
