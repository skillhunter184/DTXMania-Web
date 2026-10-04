// レーン別の合成ドラム音(DTXManiaAI DrumSynth.cs 移植)。譜面に実音源が無い / 復号できないときのフォールバック。

const SAMPLE_RATE = 44100;
const AMP = 0.35;

function rng(seed) {
  // mulberry32(C# System.Random の列は再現しないが、音色として同等)
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function kick(dur) {
  const n = Math.floor(SAMPLE_RATE * dur);
  const d = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const freq = lerp(150, 50, t);
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    d[i] = Math.sin(phase) * Math.exp(-6 * t) * AMP;
  }
  return d;
}

function snare() {
  const n = Math.floor(SAMPLE_RATE * 0.16);
  const d = new Float32Array(n);
  const r = rng(1);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const env = Math.exp(-22 * t);
    const noise = r() * 2 - 1;
    phase += (2 * Math.PI * 180) / SAMPLE_RATE;
    d[i] = (noise * 0.7 + Math.sin(phase) * 0.3) * env * AMP;
  }
  return d;
}

function hihat(dur) {
  const n = Math.floor(SAMPLE_RATE * dur);
  const d = new Float32Array(n);
  const r = rng(2);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const noise = r() * 2 - 1;
    const hp = noise - prev;
    prev = noise;
    d[i] = hp * Math.exp(-50 * t) * AMP * 0.8;
  }
  return d;
}

function tom(freq) {
  const n = Math.floor(SAMPLE_RATE * 0.22);
  const d = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    phase += (2 * Math.PI * lerp(freq, freq * 0.7, t)) / SAMPLE_RATE;
    d[i] = Math.sin(phase) * Math.exp(-9 * t) * AMP;
  }
  return d;
}

function cymbal(dur) {
  const n = Math.floor(SAMPLE_RATE * dur);
  const d = new Float32Array(n);
  const r = rng(3);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const noise = r() * 2 - 1;
    const hp = noise - prev;
    prev = noise;
    d[i] = hp * Math.exp(-7 * t) * AMP * 0.6;
  }
  return d;
}

function ride(dur) {
  const n = Math.floor(SAMPLE_RATE * dur);
  const d = new Float32Array(n);
  const r = rng(4);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const noise = r() * 2 - 1;
    phase += (2 * Math.PI * 520) / SAMPLE_RATE;
    d[i] = (noise * 0.4 + Math.sin(phase) * 0.4) * Math.exp(-8 * t) * AMP * 0.6;
  }
  return d;
}

/** 10 レーン分の合成波形(モノラル 44.1kHz Float32Array)。添字はレーン番号。 */
export function buildSynthLanes() {
  return [
    cymbal(0.4), // LC
    hihat(0.05), // HH
    kick(0.16), // LP
    snare(), // SD
    tom(220), // HT
    kick(0.18), // BD
    tom(160), // LT
    tom(110), // FT
    cymbal(0.45), // CY
    ride(0.3), // RD
  ];
}

/**
 * メトロノームの音(モノラル 44.1kHz Float32Array)。元実装はスキンの Metronome.ogg 1 つを小節線 1.0 / 拍線 0.4 の音量で鳴らすが、
 * 本アプリは第三者の音を同梱しないので合成する。短いサイン波の減衰音で、小節の頭(accent)は高い音にもする(音量が小さくても
 * 小節の頭が分かるように)。音量の比は鳴らす側(js/game/player.js)で元実装と同じ 0.4 を掛ける。
 * 立ち上がりを 1 ms かけてプチッという音を消す。
 */
export function buildClick(accent) {
  const freq = accent ? 1600 : 1000;
  const amp = 0.6;
  const n = Math.floor(SAMPLE_RATE * 0.05);
  const attack = Math.floor(SAMPLE_RATE * 0.001);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const env = (i < attack ? i / attack : 1) * Math.exp(-90 * t);
    d[i] = Math.sin(2 * Math.PI * freq * t) * env * amp;
  }
  return d;
}

export const SYNTH_SAMPLE_RATE = SAMPLE_RATE;
