import { test, assert, assertEq } from './runner.js';
import { STRINGS, LANGS, t, getLang, setLang, initialLang, applyDom } from '../js/i18n.js';
import { TrainingSettings, LOOP_UNIT, formatLoopTime } from '../js/game/training.js';
import { TrainingMenu } from '../js/ui/menu.js';
import { laneKeysText } from '../js/ui/keybind.js';
import { laneNotesText } from '../js/ui/midibind.js';
import { parseDTX } from '../js/core/dtx.js';

// t() を使うファイル。キーの書き間違いと、使われていないキーを探す。t() を使うファイルを足したらここにも足す
const SOURCES = [
  '../index.html', '../js/main.js', '../js/ui/menu.js', '../js/ui/midipanel.js', '../js/ui/keybind.js',
  '../js/ui/midibind.js', '../js/ui/renderer.js', '../js/game/player.js', '../js/game/training.js',
  '../js/core/zip.js', '../js/core/song.js',
];

/** 英語に切り替えて fn を走らせ、必ず元の言語に戻す(ほかのテストは日本語の文言を見ている)。 */
async function inLang(lang, fn) {
  const before = getLang();
  setLang(lang);
  try {
    await fn();
  } finally {
    setLang(before);
  }
}

/** 文言の中の差し込み({name} と {n|a|b} の n)の名前。 */
function placeholders(s) {
  return [...new Set([...s.matchAll(/\{(\w+)(?:\|[^{}]*)?\}/g)].map((m) => m[1]))].sort().join(',');
}

/** 要素の並び(タグ名とクラス)。data-i18n-html の日本語と英語で揃っているかを見る。 */
function skeleton(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return [...tpl.content.querySelectorAll('*')].map((el) => el.tagName + '.' + el.className).join(' ');
}

/** HTML ソースの改行と字下げは無視して比べる(日本語の文は改行で区切っているだけなので)。 */
function norm(s) {
  return s.replace(/\s*\n\s*/g, '').replace(/\s+/g, ' ').trim();
}

function serialize(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.innerHTML;
}

test('i18n: every entry has ja and en with the same placeholders and markup', () => {
  for (const [key, pair] of Object.entries(STRINGS)) {
    assert(Array.isArray(pair) && pair.length === LANGS.length, key + ' must be [ja, en]');
    for (const s of pair) assert(typeof s === 'string' && s.length > 0, key + ' has an empty string');
    assertEq(placeholders(pair[1]), placeholders(pair[0]), key + ' placeholders');
    if (/</.test(pair[0]) || /</.test(pair[1])) assertEq(skeleton(pair[1]), skeleton(pair[0]), key + ' markup');
  }
});

test('i18n: t() substitutes variables and English plurals', async () => {
  assertEq(t('load.songCount', { name: 'a.zip', n: 3 }), 'a.zip: 3 曲');
  assertEq(t('keys.added', { lane: 'HH', key: 'A', n: 2, max: 12 }), 'HH に A を追加しました (2/12)');
  await inLang('en', () => {
    assertEq(t('load.songCount', { name: 'a.zip', n: 1 }), 'a.zip: 1 song');
    assertEq(t('load.songCount', { name: 'a.zip', n: 3 }), 'a.zip: 3 songs');
    assertEq(t('midi.stateReady', { open: 1, found: 2 }), '1 of 2 devices open.');
    assertEq(t('common.none'), 'none');
  });
  assertEq(t('no.such.key'), 'no.such.key', 'unknown keys fall back to the key');
  assertEq(t('load.failed', {}), '読み込みに失敗しました: {msg}', 'missing variables stay as they are');
});

test('i18n: initial language (?lang= > saved > Japanese)', () => {
  assertEq(initialLang('', null), 'ja', 'default is Japanese');
  assertEq(initialLang('', 'en'), 'en');
  assertEq(initialLang('?lang=en', null), 'en');
  assertEq(initialLang('?lang=ja', 'en'), 'ja', 'the URL wins over the saved choice');
  assertEq(initialLang('?zip=a.zip&lang=en', 'ja'), 'en');
  assertEq(initialLang('?lang=fr', 'en'), 'en', 'unknown languages are ignored');
  assertEq(initialLang('', 'fr'), 'ja');
  assertEq(setLang('fr'), 'ja', 'setLang falls back to Japanese');
});

test('i18n: index.html Japanese matches the dictionary and every key exists', async () => {
  const r = await fetch('../index.html', { cache: 'no-store' });
  const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
  const ja = (key) => {
    assert(STRINGS[key], 'index.html uses an unknown key: ' + key);
    return STRINGS[key][0];
  };
  let n = 0;
  for (const el of doc.querySelectorAll('[data-i18n]')) {
    assertEq(norm(el.textContent), norm(ja(el.dataset.i18n)), el.dataset.i18n);
    n++;
  }
  for (const el of doc.querySelectorAll('[data-i18n-html]')) {
    assertEq(norm(el.innerHTML), norm(serialize(ja(el.dataset.i18nHtml))), el.dataset.i18nHtml);
    n++;
  }
  for (const el of doc.querySelectorAll('[data-i18n-title]')) {
    assertEq(el.title, ja(el.dataset.i18nTitle), el.dataset.i18nTitle);
    n++;
  }
  for (const el of doc.querySelectorAll('[data-i18n-aria-label]')) {
    assertEq(el.getAttribute('aria-label'), ja(el.dataset.i18nAriaLabel), el.dataset.i18nAriaLabel);
    n++;
  }
  assert(n > 50, 'index.html is marked up (' + n + ' items)');
});

test('i18n: keys in the sources exist, and every key is used', async () => {
  const used = new Set();
  const prefixes = [...new Set(Object.keys(STRINGS).map((k) => k.split('.')[0]))].join('|');
  const re = new RegExp(`['"\`]((?:${prefixes})\\.(?!js['"\`])[A-Za-z0-9]+)['"\`]`, 'g');
  for (const url of SOURCES) {
    const r = await fetch(url, { cache: 'no-store' });
    assert(r.ok, 'fetch ' + url);
    for (const m of (await r.text()).matchAll(re)) {
      assert(STRINGS[m[1]], `${url} uses an unknown key: ${m[1]}`);
      used.add(m[1]);
    }
  }
  const unused = Object.keys(STRINGS).filter((k) => !used.has(k));
  assertEq(unused.join(', '), '', 'unused keys (or a file missing from SOURCES in tests/i18n.test.js)');
});

test('i18n: applyDom switches text, markup and attributes both ways', async () => {
  const host = document.createElement('div');
  host.innerHTML = '<span data-i18n="settings.keys"></span><p data-i18n-html="help.touch"></p>'
    + '<button data-i18n-title="play.back" data-i18n-aria-label="seek.track"></button>';
  const [span, p, btn] = host.children;
  await inLang('en', () => {
    applyDom(host);
    assertEq(span.textContent, 'Key Bindings');
    assertEq(p.querySelector('b').textContent, 'Touch');
    assertEq(btn.title, 'Back to song select');
    assertEq(btn.getAttribute('aria-label'), 'Play position');
  });
  applyDom(host);
  assertEq(span.textContent, 'キー割り当て');
  assertEq(p.querySelector('b').textContent, 'タッチ');
  assertEq(btn.title, '曲選択へ戻る');
});

test('i18n: the training menu and value texts in English', async () => {
  await inLang('en', () => {
    const s = new TrainingSettings();
    const m = new TrainingMenu(s, {});
    m.setChart(parseDTX('#BPM: 120\n#00013: 01\n#00313: 01\n'));
    assertEq(m.itemName(0), 'Auto Play');
    assertEq(m.itemName(14), 'Start');
    m.playing = true;
    assertEq(m.itemName(14), 'Stop');
    assertEq(m.itemValue(1), 'None');
    s.autoLanes[0] = true;
    assertEq(m.itemValue(1), '1 lane');
    s.autoLanes[1] = true;
    assertEq(m.itemValue(1), '2 lanes');
    assertEq(m.itemValue(10), 'Measure');
    s.loopUnit = LOOP_UNIT.SECOND;
    assertEq(m.itemValue(10), 'Second');
    assertEq(formatLoopTime(2500, LOOP_UNIT.MEASURE, [0, 2000, 4000]), 'Measure 001');
    assertEq(laneKeysText([]), 'none');
    assertEq(laneNotesText([]), 'none');

    const host = document.createElement('div');
    m.build(host);
    try {
      assertEq(m.rows[0].left.getAttribute('aria-label'), 'Decrease');
      assert(m.root.querySelector('.tmenu-footer').textContent.startsWith('↑↓ Select'), 'footer');
      m.decide(); // cursor 0 = Auto Play を切り替えるだけ
      m.cursor = 1;
      m.decide(); // 自動演奏詳細へ
      m.refresh();
      assertEq(m.header.textContent, 'TRAINING - Auto Lanes');
    } finally {
      m.destroy();
    }
  });
});
