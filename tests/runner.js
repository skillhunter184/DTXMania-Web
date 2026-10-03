// 依存無しの極小テストランナー(ブラウザで tests/index.html を開く)。
// 結果は DOM と window.__testResults に出す(自動化用)。

const tests = [];
export function test(name, fn) {
  tests.push({ name, fn });
}

export function assert(cond, msg = 'assertion failed') {
  if (!cond) throw new Error(msg);
}

export function assertEq(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  }
}

export function assertNear(actual, expected, tol, msg = '') {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${msg} expected≈${expected}±${tol} actual=${actual}`);
  }
}

export function assertDeepEq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} expected=${b} actual=${a}`);
}

export async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch failed: ' + url + ' ' + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

export async function run() {
  const results = [];
  const root = document.getElementById('results') || document.body;
  for (const t of tests) {
    const li = document.createElement('li');
    try {
      await t.fn();
      li.textContent = 'PASS ' + t.name;
      li.className = 'pass';
      results.push({ name: t.name, ok: true });
    } catch (e) {
      li.textContent = 'FAIL ' + t.name + ' — ' + (e && e.stack ? e.stack : e);
      li.className = 'fail';
      results.push({ name: t.name, ok: false, error: String(e && e.message ? e.message : e) });
      console.error('FAIL', t.name, e);
    }
    root.appendChild(li);
  }
  const failed = results.filter((r) => !r.ok).length;
  const summary = document.getElementById('summary');
  if (summary) summary.textContent = failed === 0 ? `ALL ${results.length} TESTS PASSED` : `${failed} / ${results.length} FAILED`;
  window.__testResults = { done: true, total: results.length, failed, results };
  return results;
}
