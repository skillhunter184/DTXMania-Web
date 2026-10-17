// 譜面の編集画面のタッチの身振り(本アプリの追加。DTXCreator はマウスだけ)。
//
// - 1 本指のドラッグは、チップの上から始めても必ずスクロール(1/16 の詰まった列では、どこを押してもチップの近くなので)
// - タップは指を離したときに置く / 消す(スクロールのつもりで置かないように)
// - 長押し(450 ms)でチップを持ち上げる(そのまま動かせば移動、動かさずに離せばメニュー)
// - 2 本指でつまむと拡大縮小と移動(1 本指の途中の身振りは取り消す)
// - Apple Pencil(pointerType 'pen')はマウスと同じに扱う(編集画面の側)。ペンを使った直後 1 秒は、指のタップを無視する(手のひら)
// マウスとペンはここを通さず、編集画面が直接受ける。

/** 身振りの定数(CSS px・ms)。 */
export const G = {
  SLOP_CSS: { mouse: 4, pen: 4, touch: 8 },
  LONG_PRESS_MS: 450,
  PALM_MS: 1000,
  FLING_WINDOW_MS: 80,
  FLING_FRICTION: 0.92,
  FLING_MIN_CSS_PER_MS: 0.05,
  AUTOSCROLL_CSS: 40,
  PAINT_SOUND_MS: 60,
};

/**
 * タッチの身振りを判別して handlers を呼ぶ。
 * handlers: press(p) / tap(p) / longPress(p) / liftMove(p) / liftEnd(p, moved) / scroll(dyCss) / scrollEnd(vCssPerMs) /
 *   pinch({scale, cx, cy, dy}) / pinchEnd() / cancel()
 * p = {clientX, clientY, pointerType: 'touch', pointerId, timeStamp}
 */
export class TouchGestures {
  constructor(handlers, { now = () => performance.now(), setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (h) => clearTimeout(h) } = {}) {
    this.h = handlers;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.touches = new Map(); // pointerId → {x, y}
    this.state = 'idle'; // idle / pending / scroll / lifted / pinch / done
    this.start = null; // {x, y, t, id}
    this.timer = null;
    this.samples = []; // [{t, y}](指を離したときの速さ)
    this.pinch0 = null;
    this.lastPenAt = -Infinity;
    this.liftMoved = false;
  }

  /** ペンを使った(手のひらの判定)。 */
  notePen(t = this.now()) {
    this.lastPenAt = t;
  }

  get palm() {
    return this.now() - this.lastPenAt < G.PALM_MS;
  }

  down(e) {
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.touches.size === 1) {
      this.state = 'pending';
      this.start = { x: e.clientX, y: e.clientY, t: this.now(), id: e.pointerId };
      this.samples = [{ t: this.now(), y: e.clientY }];
      this.liftMoved = false;
      this._clearTimer();
      this.timer = this.setTimer(() => this._longPress(e), G.LONG_PRESS_MS);
      if (!this.palm) this.h.press && this.h.press(pt(e));
      return;
    }
    if (this.touches.size === 2) {
      // 1 本指の身振りをやめて、つまむ
      this._clearTimer();
      if (this.state === 'pending' || this.state === 'lifted' || this.state === 'scroll') this.h.cancel && this.h.cancel();
      this.state = 'pinch';
      this.pinch0 = this._pair();
    }
  }

  move(e) {
    const tch = this.touches.get(e.pointerId);
    if (!tch) return;
    const prevY = tch.y;
    tch.x = e.clientX;
    tch.y = e.clientY;
    if (this.state === 'pinch') {
      if (this.touches.size < 2) return;
      const p = this._pair();
      const p0 = this.pinch0;
      this.pinch0 = p;
      this.h.pinch && this.h.pinch({ scale: p.d / Math.max(1, p0.d), cx: p.cx, cy: p.cy, dy: p.cy - p0.cy });
      return;
    }
    if (e.pointerId !== (this.start && this.start.id)) return;
    if (this.state === 'pending') {
      const dx = e.clientX - this.start.x;
      const dy = e.clientY - this.start.y;
      if (Math.hypot(dx, dy) > G.SLOP_CSS.touch) {
        this._clearTimer();
        this.state = 'scroll';
        this.h.cancel && this.h.cancel(); // 押した場所の影を消す
        this.h.scroll && this.h.scroll(e.clientY - this.start.y);
        this._sample(e.clientY);
      }
      return;
    }
    if (this.state === 'scroll') {
      this.h.scroll && this.h.scroll(e.clientY - prevY);
      this._sample(e.clientY);
      return;
    }
    if (this.state === 'lifted') {
      if (!this.liftMoved && Math.hypot(e.clientX - this.start.x, e.clientY - this.start.y) > G.SLOP_CSS.touch) this.liftMoved = true;
      if (this.liftMoved) this.h.liftMove && this.h.liftMove(pt(e));
    }
  }

  up(e, cancelled = false) {
    if (!this.touches.has(e.pointerId)) return;
    this.touches.delete(e.pointerId);
    if (this.state === 'pinch') {
      if (this.touches.size < 2) {
        this.state = this.touches.size ? 'done' : 'idle';
        this.h.pinchEnd && this.h.pinchEnd();
      }
      return;
    }
    if (this.state === 'done') {
      if (!this.touches.size) this.state = 'idle';
      return;
    }
    if (e.pointerId !== (this.start && this.start.id)) return;
    this._clearTimer();
    const st = this.state;
    this.state = this.touches.size ? 'done' : 'idle';
    if (cancelled) {
      this.h.cancel && this.h.cancel();
      return;
    }
    if (st === 'pending') {
      if (!this.palm) this.h.tap && this.h.tap(pt(e));
      else this.h.cancel && this.h.cancel();
    } else if (st === 'scroll') {
      this.h.scrollEnd && this.h.scrollEnd(this._velocity());
    } else if (st === 'lifted') {
      this.h.liftEnd && this.h.liftEnd(pt(e), this.liftMoved);
    }
  }

  /** 身振りを途中でやめる(画面を閉じたときなど)。 */
  reset() {
    this._clearTimer();
    this.touches.clear();
    this.state = 'idle';
  }

  _longPress(e) {
    this.timer = null;
    if (this.state !== 'pending' || this.palm) return;
    this.state = 'lifted';
    this.h.longPress && this.h.longPress(pt(e));
  }

  _clearTimer() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  _sample(y) {
    const t = this.now();
    this.samples.push({ t, y });
    while (this.samples.length > 2 && t - this.samples[0].t > G.FLING_WINDOW_MS) this.samples.shift();
  }

  /** 指を離す直前の速さ(CSS px / ms。下へ動かすと +)。 */
  _velocity() {
    const s = this.samples;
    if (s.length < 2) return 0;
    const a = s[0];
    const b = s[s.length - 1];
    const dt = b.t - a.t;
    if (dt <= 0 || this.now() - b.t > G.FLING_WINDOW_MS) return 0;
    return (b.y - a.y) / dt;
  }

  _pair() {
    const [a, b] = [...this.touches.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }
}

function pt(e) {
  return { clientX: e.clientX, clientY: e.clientY, pointerType: 'touch', pointerId: e.pointerId, timeStamp: e.timeStamp };
}
