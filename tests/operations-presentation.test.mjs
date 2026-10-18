import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const chrome = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sizes = [[1366, 768], [320, 568], [390, 844], [844, 390], [900, 480]];

async function browserChecks(web) {
  try {
    const { initOperations } = await import(web + 'js/operations.js');
    const { createEvent } = await import(web + 'js/event-store.js');
    const active = createEvent('Presentation warning regression', 'snow');
    active.notes = 'Operational summary: ' + 'Full details remain available. '.repeat(30);
    active.alert = {
      code: 'orange', source: 'Warning authority', validFrom: '2026-10-17T06:00:00Z', validTo: '2026-10-17T20:00:00Z',
      text: Array.from({ length: 60 }, (_, i) => 'Warning line ' + i + ': <strong>literal text</strong> & details.').join('\n'),
    };
    active.features.features = Array.from({ length: 12 }, (_, i) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [26.6 + i * 0.001, 47.7] },
      properties: { id: 'test-' + i, kind: ['blocked', 'flooded', 'command'][i % 3], status: 'reported', title: 'Operational incident ' + i, notes: 'Incident details', observedAt: '2026-10-17T06:00:00Z' },
    }));
    const memory = new Map([['hb.ops.session.v1', JSON.stringify({ active })]]);
    const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
    const noop = () => {};
    let fitCalls = 0, jumpCalls = 0, resizeCalls = 0, paddingCalls = 0;
    const map = {
      on: noop, getSource: noop, getLayer: noop,
      getCenter: () => ({ lng: 26.6, lat: 47.7 }), getZoom: () => 8, getBearing: () => 0, getPitch: () => 0,
      getPadding: () => ({}), getContainer: () => document.querySelector('#map'),
      fitBounds: () => fitCalls++, setPadding: () => paddingCalls++, resize: () => resizeCalls++, jumpTo: () => jumpCalls++,
    };
    initOperations({ map, storage, state: { data: {}, visible: {}, overlays: {}, basemap: 'harta', theme: 'zi' }, toast: noop, selectTab: noop, applyStyle: noop, renderLayerPanel: noop });
    const nextFrame = () => new Promise(resolve => { requestAnimationFrame(() => requestAnimationFrame(resolve)); setTimeout(resolve, 40); });
    const visible = (element) => Boolean(element && getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().width && element.getBoundingClientRect().height);
    const inViewport = (element) => {
      if (!visible(element)) return false;
      const rect = element.getBoundingClientRect();
      return rect.left >= -0.5 && rect.top >= -0.5 && rect.right <= innerWidth + 0.5 && rect.bottom <= innerHeight + 0.5;
    };
    const clickable = (element) => {
      if (!inViewport(element)) return false;
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return element === hit || element.contains(hit);
    };
    const panels = ['messages', 'summary', 'legend', 'commands'];
    const panel = name => document.querySelector('#ops-pres-' + name);
    const toggle = name => document.querySelector('.ops-pres-toggle[data-action="pres-toggle-' + name + '"]');
    const openPanels = () => panels.filter(name => visible(panel(name)));
    const result = { viewport: innerWidth + 'x' + innerHeight };
    const check = (name, value) => { result[name] = Boolean(value); };
    document.querySelector('[data-action="present"]').click();
    await nextFrame();
    await nextFrame();
    const compact = innerWidth <= 760 || innerHeight <= 520;
    check('compactClassification', document.querySelector('.ops-presentation').dataset.compact === String(compact));
    check('initialPanels', compact ? openPanels().length === 0 : visible(panel('messages')));
    const mapView = () => JSON.stringify([fitCalls, jumpCalls, resizeCalls, paddingCalls]);
    const beforeToggles = mapView();
    check('toggleAriaLinked', panels.every(name => toggle(name)?.getAttribute('aria-controls') === 'ops-pres-' + name));
    let accessible = true, singleOpen = true, reachable = true;
    for (const name of panels) {
      if (visible(panel(name))) toggle(name).click();
      toggle(name).click();
      accessible &&= toggle(name).getAttribute('aria-expanded') === 'true' && document.activeElement === toggle(name);
      await nextFrame();
      singleOpen &&= !compact || openPanels().length === 1;
      reachable &&= clickable(toggle(name));
      if (name === 'messages') {
        const alert = panel(name).querySelector('.ops-alert');
        const style = getComputedStyle(alert), rect = alert.getBoundingClientRect();
        let scroller = alert;
        while (scroller && !(scroller.scrollHeight > scroller.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
        const end = document.createElement('span'); end.textContent = '.'; alert.append(end);
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        check('warningUnclamped', style.webkitLineClamp === 'none');
        check('warningScrollable', scroller && scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1);
        check('warningWide', rect.width >= panel(name).getBoundingClientRect().width - 40);
        check('warningInViewport', inViewport(scroller) && inViewport(end));
        check('escapedText', !alert.querySelector('strong') && alert.textContent.includes('<strong>literal text</strong> & details.'));
        check('fullWarningAvailable', alert.textContent.includes('Warning line 59'));
        check('sourceVisible', alert.textContent.includes('Warning authority'));
        check('validityVisible', alert.textContent.includes('17.10.2026'));
      }
      if (name === 'legend') check('legendReachable', inViewport(panel(name)) && panel(name).textContent.includes('Actualizat'));
      if (name === 'commands') {
        const commands = [...panel(name).querySelectorAll('button')];
        check('commandsReachable', inViewport(panel(name)) && commands.length > 0);
      }
    }
    check('onePanelOpenOnMobile', singleOpen);
    check('toggleAriaExpandedAndFocus', accessible);
    check('togglesRemainReachable', reachable);
    for (const name of panels) if (visible(panel(name))) toggle(name).click();
    await nextFrame();
    check('allPanelsCollapseViaArrows', openPanels().length === 0 && panels.every(name => toggle(name).getAttribute('aria-expanded') === 'false'));
    const presentation = document.querySelector('.ops-presentation');
    const controls = [...presentation.querySelectorAll('button')].filter(visible);
    const area = controls.reduce((sum, button) => { const r = button.getBoundingClientRect(); return sum + r.width * r.height; }, 0);
    check('collapsedControlsOccupySmallArea', area < innerWidth * innerHeight * 0.2);
    check('collapsedMapCenterReceivesInput', !document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('.ops-presentation'));
    check('toggleDoesNotChangeMapView', beforeToggles === mapView());
    check('touchTargets44', !compact || controls.every(button => { const rect = button.getBoundingClientRect(); return rect.width >= 44 && rect.height >= 44; }));
    check('noHorizontalOverflow', document.documentElement.scrollWidth <= innerWidth && presentation.scrollWidth <= innerWidth);
    const exit = document.querySelector('.ops-pres-exit[data-action="exit"]');
    check('exitAlwaysReachable', clickable(exit));
    exit.click();
    check('exitRestoresSidebar', !document.body.classList.contains('presenting') && visible(document.querySelector('.side')));
    for (const field of ['code', 'text', 'validFrom', 'validTo']) {
      const input = document.querySelector('[data-alert="' + field + '"]');
      input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.querySelector('[data-action="present"]').click();
    if (!visible(panel('messages'))) toggle('messages').click();
    check('sourceOnlyVisible', panel('messages').querySelector('.ops-alert')?.textContent.includes('Warning authority'));
    document.querySelector('.ops-pres-exit').click();
    const source = document.querySelector('[data-alert="source"]');
    source.value = ''; source.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-action="present"]').click();
    if (!visible(panel('messages'))) toggle('messages').click();
    check('emptyWarningOmitted', !panel('messages').querySelector('.ops-alert'));
    parent.postMessage(result, '*');
  } catch (error) { parent.postMessage({ viewport: innerWidth + 'x' + innerHeight, error: error.stack }, '*'); }
}

test('CJSU panels collapse independently, preserve the map, and keep full warnings accessible', { skip: !existsSync(chrome) }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cjsu-presentation-'));
  const web = new URL('../web/', import.meta.url).href;
  const child = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><script src="${web}vendor/proj4.js"></script><link rel="stylesheet" href="${web}css/app.css"><link rel="stylesheet" href="${web}css/operations.css"><div class="app"><aside class="side"><div id="tab-situatii"></div></aside><div class="mapwrap"><div id="map" style="background:#dce6df"></div></div></div><script type="module">(${browserChecks.toString()})(${JSON.stringify(web)})</script>`;
  const harness = `<body><pre id="results"></pre><script>
    const results = [];
    onmessage = event => { results.push(event.data); document.querySelector('#results').textContent = JSON.stringify(results); };
    for (const [width, height] of ${JSON.stringify(sizes)}) {
      const frame = document.createElement('iframe'); frame.width = width; frame.height = height;
      frame.srcdoc = ${JSON.stringify(child).replaceAll('<', '\\u003c')}; document.body.append(frame);
    }
  </script>`;
  try {
    const path = join(dir, 'test.html');
    writeFileSync(path, harness);
    if (process.env.CJSU_FIXTURE_DIR) {
      const preview = child.replace('const nextFrame =', `document.querySelector('[data-action="present"]').click(); const previewPanel = new URLSearchParams(location.search).get('panel'); if (previewPanel) document.querySelector('[data-action="pres-toggle-' + previewPanel + '"]')?.click(); return; const nextFrame =`);
      writeFileSync(join(process.env.CJSU_FIXTURE_DIR, 'cjsu-presentation.html'), preview);
    }
    const run = spawnSync(chrome, ['--headless', '--enable-logging=stderr', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files', '--user-data-dir=' + join(dir, 'profile'), '--virtual-time-budget=10000', '--dump-dom', pathToFileURL(path).href], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(run.status, 0, run.error?.message || run.stderr || String(run.signal));
    const match = run.stdout.match(/<pre id="results">([\s\S]*?)<\/pre>/);
    assert.ok(match?.[1], 'Browser did not complete the presentation checks: ' + run.stderr.slice(-4000));
    const results = JSON.parse(match[1].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
    assert.equal(results.length, sizes.length, 'Incomplete browser results: ' + JSON.stringify(results));
    const failures = results.flatMap(result => result.error ? [result.viewport + ': ' + result.error] : Object.entries(result).filter(([check, passed]) => check !== 'viewport' && !passed).map(([check]) => result.viewport + ': ' + check));
    if (process.env.CJSU_DEBUG) console.log(run.stderr);
    assert.deepEqual(failures, [], 'Presentation regressions:\n' + failures.join('\n'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
