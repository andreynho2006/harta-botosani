import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const chrome = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('CJSU warning remains readable and scrollable across desktop, mobile, and short viewports', { skip: !existsSync(chrome) }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cjsu-presentation-'));
  const web = new URL('../web/', import.meta.url).href;
  const frameScript = `
    try {
      const { initOperations } = await import('${web}js/operations.js');
      const { createEvent } = await import('${web}js/event-store.js');
      const active = createEvent('Presentation warning regression', 'snow');
      active.notes = 'Operational summary';
      active.alert = { code: 'orange', source: 'Warning authority', validFrom: '2026-10-17T06:00:00Z', validTo: '2026-10-17T20:00:00Z', text: Array.from({length: 60}, (_, i) => 'Warning line ' + i + ': <strong>literal text</strong> & details.').join('\\n') };
      const memory = new Map([['hb.ops.session.v1', JSON.stringify({ active })]]);
      const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
      const noop = () => {};
      const map = { on: noop, getSource: noop, getLayer: noop, getCenter: () => ({ lng: 26.6, lat: 47.7 }), getZoom: () => 8, getBearing: () => 0, getPitch: () => 0, getPadding: () => ({}), resize: noop, jumpTo: noop };
      initOperations({ map, storage, state: { data: {}, visible: {}, overlays: {}, basemap: 'harta', theme: 'zi' }, toast: noop, selectTab: noop, applyStyle: noop, renderLayerPanel: noop });
      document.querySelector('[data-action="present"]').click();
      const alert = document.querySelector('.ops-alert');
      if (!alert) throw new Error('Warning is missing');
      const style = getComputedStyle(alert), rect = alert.getBoundingClientRect(), head = document.querySelector('.ops-slide-head').getBoundingClientRect();
      const start = alert.scrollTop;
      alert.scrollTop = alert.scrollHeight;
      const result = {
        viewport: innerWidth + 'x' + innerHeight,
        warningUnclamped: style.webkitLineClamp === 'none',
        warningScrollable: ['auto', 'scroll'].includes(style.overflowY) && alert.scrollTop > start,
        warningWide: rect.width >= head.width - 40,
        warningInViewport: rect.top >= 0 && rect.bottom <= innerHeight,
        escapedText: !alert.querySelector('strong') && alert.textContent.includes('<strong>literal text</strong> & details.'),
        sourceVisible: alert.textContent.includes('Warning authority'),
        validityVisible: alert.textContent.includes('17.10.2026'),
      };
      document.querySelector('[data-action="exit"]').click();
      for (const field of ['code', 'text', 'validFrom', 'validTo']) {
        const input = document.querySelector('[data-alert="' + field + '"]');
        input.value = '';
        input.dispatchEvent(new Event('input', {bubbles: true}));
      }
      document.querySelector('[data-action="present"]').click();
      result.sourceOnlyVisible = document.querySelector('.ops-alert')?.textContent.includes('Warning authority') ?? false;
      document.querySelector('[data-action="exit"]').click();
      const source = document.querySelector('[data-alert="source"]');
      source.value = ''; source.dispatchEvent(new Event('input', {bubbles: true}));
      document.querySelector('[data-action="present"]').click();
      result.emptyWarningOmitted = !document.querySelector('.ops-alert');
      parent.postMessage(result, '*');
    } catch (error) { parent.postMessage({ error: error.stack }, '*'); }
  `;
  const child = `<script src="${web}vendor/proj4.js"></script><link rel="stylesheet" href="${web}css/app.css"><link rel="stylesheet" href="${web}css/operations.css"><div class="app"><aside class="side"><div id="tab-situatii"></div></aside><div class="mapwrap"></div></div><script type="module">${frameScript}</script>`;
  const harness = `<body><pre id="results"></pre><script>
    const results = [];
    onmessage = event => { results.push(event.data); if (results.length === 3) document.querySelector('#results').textContent = JSON.stringify(results); };
    for (const [width, height] of [[1366, 768], [390, 844], [900, 480]]) {
      const frame = document.createElement('iframe'); frame.width = width; frame.height = height;
      frame.srcdoc = ${JSON.stringify(child).replaceAll("<", "\\u003c")}; document.body.append(frame);
    }
  </script>`;
  try {
    const path = join(dir, 'test.html');
    writeFileSync(path, harness);
    const run = spawnSync(chrome, ['--headless', '--enable-logging=stderr', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files', '--user-data-dir=' + join(dir, 'profile'), '--virtual-time-budget=10000', '--dump-dom', pathToFileURL(path).href], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(run.status, 0, run.error?.message || run.stderr || String(run.signal));
    const match = run.stdout.match(/<pre id="results">([\s\S]*?)<\/pre>/);
    assert.ok(match?.[1], 'Browser did not complete the presentation checks: ' + run.stderr.slice(-4000));
    const results = JSON.parse(match[1].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
    assert.equal(results.length, 3);
    for (const result of results) {
      assert.equal(result.error, undefined, result.error);
      for (const [check, passed] of Object.entries(result)) {
        if (check !== 'viewport') assert.equal(passed, true, result.viewport + ': ' + check);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
