// Web Audio によるオーディオエンジン。
// - 音源の復号: XA(自前) / WAV・OGG・MP3(decodeAudioData) / WAV フォールバック(自前) /
//   Ogg Vorbis フォールバック(iOS Safari 向け。CDN の wasm デコーダを必要時に読み込む)
// - 発音: #VOLUME / #PAN を反映、同一 WAV の同時発音数を制限(NX の多重発音数に相当)、
//   演奏速度は playbackRate で追従(DTXManiaAI の AudioSource.pitch と同じ考え方)
// - 時計: AudioContext の時刻を演奏の基準時計にする(player 側で songMs へ変換)。「今聞こえている ctx 時刻」を
//   getOutputTimestamp() の組から作り(audibleCtxAt)、使えないときは currentTime − 出力遅延の推定に戻る。
//   docs/architecture.md「時計モデル」

import { decodeXA, isXA } from './xa.js';
import { decodeWav, isWav } from './wav.js';
import { buildSynthLanes, buildClick, SYNTH_SAMPLE_RATE } from './synth.js';
import { requiredWavIds } from './dtx.js';

const VORBIS_CDN = 'https://cdn.jsdelivr.net/npm/@wasm-audio-decoders/ogg-vorbis@0.1.20/dist/ogg-vorbis-decoder.min.js';
let vorbisLoader = null;

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('script load failed: ' + url));
    document.head.appendChild(s);
  });
}

async function vorbisDecoderClass() {
  if (!vorbisLoader) {
    vorbisLoader = loadScript(VORBIS_CDN).then(() => {
      const mod = globalThis['ogg-vorbis-decoder'];
      if (!mod || !mod.OggVorbisDecoder) throw new Error('OggVorbisDecoder not found');
      return mod.OggVorbisDecoder;
    });
    vorbisLoader.catch(() => { vorbisLoader = null; });
  }
  return vorbisLoader;
}

function isOgg(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;
}

/** getOutputTimestamp の組の古さの上限(ms)。ふだんは 5〜10 ms。超えたら音の装置が止まっているとみる。 */
const STAMP_MAX_AGE_MS = 100;

export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.master = null;
    this.masterVolume = 0.8;
    /**
     * 種類ごとの音量バス(master の手前)。鳴っている最中の音にも即座に効くので、
     * 長い BGM トラックの音量を演奏中に変えられる。
     * @type {{bgm: GainNode, chip: GainNode}|null}
     */
    this.buses = null;
    this.busVolume = { bgm: 1, chip: 1 };
    /** 同一 WAV の同時発音数(超えると最も古い音を止める)。 */
    this.maxVoicesPerId = 4;
    /** @type {Map<string, AudioBuffer|null>} wavId → バッファ */
    this.buffers = new Map();
    /** @type {Map<string, Set<any>>} wavId → 発音中の voice */
    this.voices = new Map();
    this.allVoices = new Set();
    this.synthBuffers = null;
    /** 復号できなかった wavId の一覧(表示用)。 */
    this.failed = [];
    /** ユーザー指定の追加遅延補正(ms)。正で音が早く出る(=映像が遅れる側へ補正)。 */
    this.userLatencyMs = 0;
    /** getOutputTimestamp の組を時計に使うか(audibleCtxAt)。 */
    this.useOutputTimestamp = AudioEngine.trustsOutputTimestamp();
  }

  /**
   * getOutputTimestamp の組を時計に使ってよいブラウザか。確かめたのは Chromium(Chrome / Edge)だけ。
   * Firefox は組を呼んだときの currentTime と performance.now から作るので、延ばしても currentTime の階段に戻り、
   * performance.now の丸めしだいで下の「遅れ > 1 ms」の判定もすり抜ける。WebKit(Safari と iOS の全ブラウザ)は
   * 組がどの時点の出力を指すかを確かめていない。どちらも今までの推定(currentTime − 出力遅延)を使う。
   */
  static trustsOutputTimestamp(ua = globalThis.navigator ? globalThis.navigator.userAgent : '') {
    return /Chrome\/\d/.test(ua); // ヘッドレスは HeadlessChrome/。iOS の Chrome は CriOS/ で WebKit なので当たらない
  }

  /**
   * performance.now 軸の時刻 perfMs に「聞こえている」ctx 時刻(秒)。使えなければ null(呼び出し側は推定に戻す)。
   * getOutputTimestamp() は「今スピーカーから出ている音の ctx 時刻 contextTime」と、それを出した performance.now の
   * 時刻 performanceTime の組を返すので、perfMs まで延ばす。ユーザーの遅延補正は含めない。状態を持たない。
   *
   * Chrome の currentTime は音の処理の区切り(約 10 ms ごとに 8 / 10.67 ms ずつ)でしか進まないので、
   * currentTime − 出力遅延 の時計は階段になり、360 Hz では 7 割のフレームでチップが止まっていた(直線からのずれ RMS 約 3 ms)。
   * 組を延ばすと RMS 0.04 ms になる。SoundVoltexAnalyze の譜面シミュレータ(audio.js _audibleCtx)と同じ作り。
   * @param {number} perfMs
   * @param {number} [nowPerf] 今の performance.now()(組の古さと、測った遅れの判定に使う)
   */
  audibleCtxAt(perfMs, nowPerf = performance.now()) {
    const ctx = this.ctx;
    if (!ctx || !this.useOutputTimestamp || typeof ctx.getOutputTimestamp !== 'function') return null;
    // suspend 中に組を延ばすと、止まっている音より先へ時計が走る
    if (ctx.state !== 'running') return null;
    const ts = ctx.getOutputTimestamp();
    // 鳴り始めの数十 ms は組がまだ無い(0)
    if (!ts || !(ts.contextTime > 0) || !(ts.performanceTime > 0)) return null;
    // 組が古い = 音の装置が止まっている(出力機器の切り替えなど)。延ばし続けると、組が戻ったときに大きく跳ぶ
    const age = nowPerf - ts.performanceTime;
    if (Math.abs(age) > STAMP_MAX_AGE_MS) return null;
    // 測った出力の遅れ(今処理している ctx 時刻 − 聞こえている ctx 時刻)。起動直後の組(遅れが負に出る)や、
    // 呼んだときの currentTime から作る実装(遅れが 0 に出る)を弾く
    const lat = ctx.currentTime - (ts.contextTime + age / 1000);
    if (!(lat > 0.001 && lat < 0.5)) return null;
    return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
  }

  /** ユーザー操作の中で呼ぶ(AudioContext の生成/再開)。 */
  async ensureContext() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.masterVolume;
      this.master.connect(this.ctx.destination);
      this.buses = { bgm: this.ctx.createGain(), chip: this.ctx.createGain() };
      for (const name of Object.keys(this.buses)) {
        this.buses[name].gain.value = this.busVolume[name];
        this.buses[name].connect(this.master);
      }
    }
    if (this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch (e) { /* ignore */ }
    }
    return this.ctx;
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** 出力遅延の推定(秒。ユーザーの遅延補正込み)。audibleCtxAt が使えないときの時計(player.realFromPerf)が使う。 */
  get outputLatencySec() {
    if (!this.ctx) return 0;
    const base = this.ctx.baseLatency || 0;
    const out = this.ctx.outputLatency || 0;
    return base + out + this.userLatencyMs / 1000;
  }

  setMasterVolume(v) {
    this.masterVolume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.masterVolume;
  }

  /** 種類ごとの音量(name は 'bgm' / 'chip')。鳴っている音にも即座に効く。 */
  setBusVolume(name, v) {
    if (!(name in this.busVolume)) return;
    this.busVolume[name] = Math.max(0, Math.min(1, v));
    if (this.buses) this.buses[name].gain.value = this.busVolume[name];
  }

  /** 出力先(opts.bus が無ければ master 直結。SE・歓声・メニュー音はこちら)。 */
  busNode(name) {
    return (name && this.buses && this.buses[name]) || this.master;
  }

  /** {sampleRate, channels, length, channelData} → AudioBuffer */
  toAudioBuffer(pcm) {
    const buf = this.ctx.createBuffer(pcm.channels, Math.max(1, pcm.length), pcm.sampleRate);
    for (let c = 0; c < pcm.channels; c++) buf.copyToChannel(pcm.channelData[c], c);
    return buf;
  }

  /**
   * 任意の音声ファイルを AudioBuffer にする。失敗したら null。
   * @param {Uint8Array} bytes
   * @param {string} name 拡張子判定用
   */
  async decode(bytes, name = '') {
    await this.ensureContext();
    const lower = name.toLowerCase();
    try {
      if (isXA(bytes) || lower.endsWith('.xa')) return this.toAudioBuffer(decodeXA(bytes));
    } catch (e) {
      console.warn('XA の復号に失敗:', name, e);
      return null;
    }
    // ネイティブ復号(コピーを渡す: decodeAudioData は ArrayBuffer を detach する)
    try {
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return await this.ctx.decodeAudioData(copy);
    } catch (e) {
      /* フォールバックへ */
    }
    try {
      if (isWav(bytes)) return this.toAudioBuffer(decodeWav(bytes));
    } catch (e) {
      console.warn('WAV の復号に失敗:', name, e);
    }
    if (isOgg(bytes)) {
      try {
        const Decoder = await vorbisDecoderClass();
        const dec = new Decoder();
        await dec.ready;
        const r = await dec.decodeFile(bytes);
        if (dec.free) dec.free();
        if (r && r.channelData && r.channelData.length > 0) {
          return this.toAudioBuffer({ sampleRate: r.sampleRate, channels: r.channelData.length, length: r.samplesDecoded, channelData: r.channelData });
        }
      } catch (e) {
        console.warn('Ogg Vorbis のフォールバック復号に失敗:', name, e);
      }
    }
    return null;
  }

  /**
   * 譜面が必要とする音源をすべて読み込む。
   * @param {import('./song.js').SongPackage} pkg
   * @param {any} chart parseDTX の結果
   * @param {(done:number, total:number, name:string)=>void} [onProgress]
   */
  async loadChartSounds(pkg, chart, onProgress) {
    await this.ensureContext();
    this.stopAll();
    this.buffers = new Map();
    this.failed = [];
    const ids = requiredWavIds(chart);
    const byPath = new Map(); // 同じファイルを指す id は一度だけ復号する
    let done = 0;
    const total = ids.length;
    const worker = async (id) => {
      const file = chart.wavDefs.get(id);
      let buf = null;
      if (file) {
        const ent = pkg.resolve(chart.dir, file);
        if (ent) {
          const key = ent.name.toLowerCase();
          if (!byPath.has(key)) {
            byPath.set(key, (async () => {
              try {
                return await this.decode(await pkg.readBytes(ent), ent.name);
              } catch (e) {
                console.warn('音源の読み込みに失敗:', ent.name, e);
                return null;
              }
            })());
          }
          buf = await byPath.get(key);
        }
        if (!buf) this.failed.push({ id, file });
      }
      this.buffers.set(id, buf);
      done++;
      if (onProgress) onProgress(done, total, file || id);
    };
    const queue = ids.slice();
    const runners = [];
    for (let i = 0; i < 4; i++) {
      runners.push((async () => {
        while (queue.length) await worker(queue.shift());
      })());
    }
    await Promise.all(runners);
    return this.buffers;
  }

  /** レーン別の合成音(音源が無いチップ用)。 */
  synthBuffer(lane) {
    if (!this.synthBuffers) {
      const lanes = buildSynthLanes();
      this.synthBuffers = lanes.map((d) => this.toAudioBuffer({ sampleRate: SYNTH_SAMPLE_RATE, channels: 1, length: d.length, channelData: [d] }));
    }
    return this.synthBuffers[lane] || null;
  }

  /** メトロノームの音(accent = 小節の頭)。初めて使うときに作り、以後は持ち続ける。 */
  clickBuffer(accent) {
    if (!this.ctx) return null;
    if (!this.clickBuffers) {
      this.clickBuffers = [false, true].map((a) => {
        const d = buildClick(a);
        return this.toAudioBuffer({ sampleRate: SYNTH_SAMPLE_RATE, channels: 1, length: d.length, channelData: [d] });
      });
    }
    return this.clickBuffers[accent ? 1 : 0];
  }

  hasBuffer(id) {
    return !!this.buffers.get(id);
  }

  /**
   * バッファを鳴らす。
   * @param {AudioBuffer} buffer
   * @param {{when?:number, offset?:number, volume?:number, pan?:number, rate?:number, key?:string}} opts
   *   when: AudioContext 時刻(省略で即時) / offset: バッファ内の開始位置(秒) /
   *   volume: 0..1 / pan: -1..1 / rate: 再生速度 / key: 同時発音制限のグループ(通常は wavId)
   */
  playBuffer(buffer, opts = {}) {
    if (!buffer || !this.ctx) return null;
    const ctx = this.ctx;
    let when = opts.when !== undefined ? opts.when : ctx.currentTime;
    let offset = Math.max(0, opts.offset || 0);
    if (when < ctx.currentTime) {
      // 予定時刻を過ぎていたら、遅れたぶんだけ頭を飛ばして今すぐ鳴らす(位置ずれを出さない)
      offset += (ctx.currentTime - when) * (opts.rate || 1);
      when = ctx.currentTime;
    }
    if (offset >= buffer.duration) return null;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = opts.rate || 1;
    const gain = ctx.createGain();
    gain.gain.value = opts.volume === undefined ? 1 : Math.max(0, Math.min(1, opts.volume));
    let node = gain;
    if (opts.pan && ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, opts.pan));
      gain.connect(pan);
      node = pan;
    }
    node.connect(this.busNode(opts.bus));
    src.connect(gain);
    const voice = { src, gain, key: opts.key || null, startedAt: when };
    const key = voice.key;
    if (key) {
      let set = this.voices.get(key);
      if (!set) {
        set = new Set();
        this.voices.set(key, set);
      }
      if (set.size >= this.maxVoicesPerId) {
        // 新しい音が鳴り始める時点で、その時点までに鳴り始めている中で最も古い音を止める
        // (先読みで未来にスケジュールした音を、まだ鳴っていないうちに消さない)
        let oldest = null;
        for (const v of set) if (v.startedAt <= when && (!oldest || v.startedAt < oldest.startedAt)) oldest = v;
        if (oldest) this.stopVoice(oldest, when);
      }
      set.add(voice);
    }
    this.allVoices.add(voice);
    src.onended = () => this._release(voice);
    try {
      src.start(when, offset);
    } catch (e) {
      this._release(voice);
      return null;
    }
    return voice;
  }

  /**
   * wavId で鳴らす。バッファが無ければ null(呼び出し側で合成音へフォールバックする)。
   * volume/pan は 0..100 / -100..100 の DTX 値ではなく正規化済みの値を渡す。
   */
  play(id, opts = {}) {
    const buf = this.buffers.get(id);
    if (!buf) return null;
    return this.playBuffer(buf, { ...opts, key: id });
  }

  /** 同時発音数の管理から外す(グラフの切断はしない)。 */
  _untrack(voice) {
    this.allVoices.delete(voice);
    if (voice.key) {
      const set = this.voices.get(voice.key);
      if (set) set.delete(voice);
    }
  }

  _release(voice) {
    this._untrack(voice);
    try { voice.src.disconnect(); voice.gain.disconnect(); } catch (e) { /* ignore */ }
  }

  /**
   * 音を止める。at(AudioContext 時刻)を指定するとその時点までは鳴らし続け、
   * 切断は onended に任せる(即座に disconnect すると予約した停止時刻より前に切れてしまう)。
   */
  stopVoice(voice, at) {
    try {
      if (at !== undefined && at > this.ctx.currentTime) {
        voice.gain.gain.setTargetAtTime(0, at, 0.01);
        voice.src.stop(at + 0.05);
        this._untrack(voice);
        return;
      }
      voice.src.stop();
    } catch (e) {
      /* already stopped */
    }
    this._release(voice);
  }

  /** 特定 wavId の発音をすべて止める(SE01-05 の「前音を止めてから鳴らす」用)。 */
  stopId(id) {
    const set = this.voices.get(id);
    if (!set) return;
    for (const v of [...set]) this.stopVoice(v);
  }

  stopAll() {
    for (const v of [...this.allVoices]) this.stopVoice(v);
    this.voices.clear();
    this.allVoices.clear();
  }

  /** DTX の #VOLUME(0..100)/#PAN(-100..100)を再生パラメータに変換する。 */
  static gainPan(chart, id) {
    const vol = chart.wavVolumes.has(id) ? chart.wavVolumes.get(id) : 100;
    const pan = chart.wavPans.has(id) ? chart.wavPans.get(id) : 0;
    return { volume: Math.max(0, Math.min(100, vol)) / 100, pan: Math.max(-100, Math.min(100, pan)) / 100 };
  }
}
