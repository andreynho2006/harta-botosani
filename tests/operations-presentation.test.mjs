import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const chrome = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sizes = [[1366, 768], [320, 568], [390, 844], [844, 390], [900, 480]];

async function browserChecks({ initOperations, createEvent }) {
  try {
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
    active.features.features.push(
      {type:'Feature', geometry:{type:'Point',coordinates:[26.65,47.75]},properties:{id:'fire-active',kind:'fire',status:'confirmed',title:'Incendiu activ'}},
      {type:'Feature', geometry:{type:'Point',coordinates:[26.66,47.75]},properties:{id:'fire-resolved',kind:'fire',status:'resolved',title:'Incendiu stins'}},
      {type:'Feature', geometry:{type:'Point',coordinates:[26.67,47.75]},properties:{id:'snow-resolved',kind:'snow',status:'resolved',title:'Drum deszăpezit'}}
    );
    const memory = new Map([['hb.ops.session.v1', JSON.stringify({ active })]]);
    const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
    const noop = () => {};
    let fitCalls = 0, jumpCalls = 0, resizeCalls = 0, paddingCalls = 0, styleCalls = 0;
    const map = {
      on: noop, getSource: noop, getLayer: noop,
      getCenter: () => ({ lng: 26.6, lat: 47.7 }), getZoom: () => 8, getBearing: () => 0, getPitch: () => 0,
      getPadding: () => ({}), getContainer: () => document.querySelector('#map'),
      fitBounds: () => fitCalls++, setPadding: () => paddingCalls++, resize: () => resizeCalls++, jumpTo: () => jumpCalls++,
    };
    // The map is a synchronous stub, so its animation callbacks need no compositor.
    // Execute every production callback deterministically: delayed initial fitting must
    // finish before the toggle baseline, and any fitting scheduled by a toggle still fails.
    const frames = new Map();
    let frameId = 0;
    window.requestAnimationFrame = callback => { const id = ++frameId; frames.set(id, callback); return id; };
    window.cancelAnimationFrame = id => frames.delete(id);
    const state = { data: { localities: [
      { name: 'Poiana', lon: 26.9, lat: 47.6, uat: 'Flămânzi' }, { name: 'Poiana', lon: 26.7, lat: 47.9, uat: 'Ștefănești' },
      { name: 'Agafton', lon: 26.6, lat: 47.8, uat: 'Curtești' }, { name: 'Poiana', lon: 27.6, lat: 47.3, uat: '' },
    ] }, visible: {}, overlays: {}, basemap: 'harta', theme: 'zi' };
    initOperations({ map, storage, state, toast: noop, selectTab: noop, applyStyle: () => styleCalls++, renderLayerPanel: noop });
    const nextFrame = async () => {
      for (let turn = 0; frames.size; turn++) {
        if (turn >= 100) throw new Error('Presentation scheduled an endless animation loop');
        const current = [...frames]; frames.clear();
        for (const [, callback] of current) callback(performance.now());
        await Promise.resolve();
      }
      // Reading layout keeps visibility, scrolling and hit tests in the real browser.
      document.body.getBoundingClientRect();
    };
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
    if (resizeCalls === 0 || fitCalls === 0) throw new Error('Initial presentation fitting did not finish');
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
    // Text fields update on input; date fields commit on change, as in the editor.
    const stylesBeforeTyping = styleCalls;
    for (const field of ['text', 'validFrom', 'validTo']) {
      const input = document.querySelector('[data-warning-field="' + field + '"]');
      input.value = ''; input.dispatchEvent(new Event(field === 'text' ? 'input' : 'change', { bubbles: true }));
    }
    check('warningEditsKeepMapStyle', styleCalls === stylesBeforeTyping);
    document.querySelector('[data-action="present"]').click();
    if (!visible(panel('messages'))) toggle('messages').click();
    check('sourceOnlyVisible', panel('messages').querySelector('.ops-alert')?.textContent.includes('Warning authority'));
    document.querySelector('.ops-pres-exit').click();
    const villages = [...document.querySelectorAll('[data-alert-area="places"]')];
    check('villagesKeyedByUat', villages.map(input => input.value).join(';') === 'Agafton|Curtești;Poiana|Flămânzi;Poiana|Ștefănești'
      && villages.map(input => input.closest('label').textContent.trim()).join(';') === 'Agafton (Curtești);Poiana (Flămânzi);Poiana (Ștefănești)');
    villages[2].click();
    document.querySelector('[data-action="present"]').click();
    if (!visible(panel('messages'))) toggle('messages').click();
    const villageWarning = panel('messages').querySelector('.ops-alert')?.textContent || '';
    check('chosenVillageShownWithItsUat', villageWarning.includes('Poiana (Ștefănești)') && !villageWarning.includes('Flămânzi'));
    document.querySelector('.ops-pres-exit').click();
    document.querySelector('[data-alert-action="remove"]').click();
    document.querySelector('[data-action="present"]').click();
    if (!visible(panel('messages'))) toggle('messages').click();
    check('emptyWarningOmitted', !panel('messages').querySelector('.ops-alert'));
    document.querySelector('.ops-pres-exit').click();
    const typeSelect = document.querySelector('[data-field="type"]');
    typeSelect.value = 'fire'; typeSelect.dispatchEvent(new Event('change', {bubbles:true}));
    document.querySelector('[data-action="present"]').click();
    await nextFrame();
    if (!visible(panel('summary'))) toggle('summary').click();
    check('mapMatchesFireScope', state.operations.features.features.every(f => !['snow','flooded','threat'].includes(f.properties.kind)) && state.operations.features.features.some(f=>f.properties.id==='fire-resolved'));
    check('fireScope', panel('summary').textContent.includes('Incendiu activ') && !panel('summary').textContent.includes('înzăpezite') && !panel('summary').textContent.includes('inundate') && !panel('summary').textContent.includes('Drum deszăpezit'));
    check('resolvedVisibleByDefault', visible(document.querySelector('#ops-risk-resolved')) && document.querySelector('#ops-risk-resolved').textContent.includes('Incendiu stins'));
    const beforeGroupToggle = mapView();
    document.querySelector('[data-pres-group="resolved"]').click();
    check('resolvedCollapses', !visible(document.querySelector('#ops-risk-resolved')));
    document.querySelector('[data-pres-group="resolved"]').click();
    check('resolvedReopens', visible(document.querySelector('#ops-risk-resolved')) && document.querySelector('#ops-risk-resolved').textContent.includes('Incendiu stins'));
    await nextFrame();
    check('groupTogglePreservesMap', mapView() === beforeGroupToggle);
    parent.postMessage(result, '*');
  } catch (error) { parent.postMessage({ viewport: innerWidth + 'x' + innerHeight, error: error.stack }, '*'); }
}

test('CJSU panels collapse independently, preserve the map, and keep full warnings accessible', { skip: !existsSync(chrome) }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cjsu-presentation-'));
  const web = new URL('../web/', import.meta.url).href;
  const child = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><script src="${web}vendor/proj4.js"></script><link rel="stylesheet" href="${web}css/app.css"><link rel="stylesheet" href="${web}css/operations.css"><link rel="stylesheet" href="${web}css/operations-cards.css"><div class="app"><aside class="side"><div id="tab-situatii"></div></aside><div class="mapwrap"><div id="map" style="background:#dce6df"></div></div></div><script type="module">import { initOperations } from "${web}js/operations.js"; import { createEvent } from "${web}js/event-store.js"; (${browserChecks.toString()})({ initOperations, createEvent })</script>`;
  const harness = `<body style="margin:0"><pre id="results" style="position:fixed;left:-10000px"></pre><script>
    const results = [];
    const sizes = ${JSON.stringify(sizes)};
    let index = 0, current;
    function next() {
      if (index === sizes.length) return;
      const [width, height] = sizes[index++];
      const frame = document.createElement('iframe'); frame.width = width; frame.height = height; frame.style.cssText = 'position:fixed;inset:0;border:0';
      frame.srcdoc = ${JSON.stringify(child).replaceAll('<', '\\u003c')}; current = frame; document.body.append(frame);
    }
    onmessage = event => { results.push(event.data); document.querySelector('#results').textContent = JSON.stringify(results); current.remove(); next(); };
    next();
  </script>`;
  try {
    const path = join(dir, 'test.html');
    writeFileSync(path, harness);
    if (process.env.CJSU_FIXTURE_DIR) {
      const preview = child.replace('const nextFrame =', `document.querySelector('[data-action="present"]').click(); for (const [, callback] of frames) callback(performance.now()); frames.clear(); const previewPanel = new URLSearchParams(location.search).get('panel'); if (previewPanel) document.querySelector('[data-action="pres-toggle-' + previewPanel + '"]')?.click(); return; const nextFrame =`);
      writeFileSync(join(process.env.CJSU_FIXTURE_DIR, 'cjsu-presentation.html'), preview);
    }
    const run = spawnSync(chrome, ['--headless', '--window-size=1440,1000', '--enable-logging=stderr', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files', '--user-data-dir=' + join(dir, 'profile'), '--virtual-time-budget=10000', '--dump-dom', pathToFileURL(path).href], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(run.status, 0, run.error?.message || run.stderr || String(run.signal));
    const match = run.stdout.match(/<pre id="results"[^>]*>([\s\S]*?)<\/pre>/);
    assert.ok(match?.[1], 'Browser did not complete the presentation checks: ' + run.stderr.slice(-4000));
    const results = JSON.parse(match[1].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
    assert.equal(results.length, sizes.length, 'Incomplete browser results: ' + JSON.stringify(results));
    const failures = results.flatMap(result => result.error ? [result.viewport + ': ' + result.error] : Object.entries(result).filter(([check, passed]) => check !== 'viewport' && !passed).map(([check]) => result.viewport + ': ' + check));
    if (process.env.CJSU_DEBUG) console.log(run.stderr);
    assert.deepEqual(failures, [], 'Presentation regressions:\n' + failures.join('\n'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
