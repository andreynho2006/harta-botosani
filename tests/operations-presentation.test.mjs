import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const chrome = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sizes = [[1920, 1080], [1366, 768], [1024, 768], [320, 568], [390, 844], [844, 390], [900, 480]];

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
    document.querySelector('[data-alert-action="add"]').click(); // a second, yellow warning
    document.querySelector('[data-action="present"]').click();
    if (!visible(panel('messages'))) toggle('messages').click();
    const banners = [...panel('messages').querySelectorAll('.ops-alert')];
    const villageWarning = banners[0]?.textContent || '';
    check('chosenVillageShownWithItsUat', villageWarning.includes('Poiana (Ștefănești)') && !villageWarning.includes('Flămânzi'));
    check('mostSevereWarningFirst', banners.map(banner => banner.dataset.code).join() === 'orange,yellow');
    check('codePlateShown', banners[0]?.querySelector('.ops-alert-code')?.textContent === 'Cod portocaliu');
    check('warningsSideBySide', compact || (banners.length === 2 && Math.abs(banners[0].getBoundingClientRect().top - banners[1].getBoundingClientRect().top) < 1));
    if (!visible(panel('legend'))) toggle('legend').click();
    const chips = [...panel('legend').querySelectorAll('.ops-legend-code')];
    check('legendNamesEachCode', chips.map(chip => chip.dataset.code).join() === 'orange,yellow' && chips[0].textContent.includes('Cod portocaliu') && chips[0].textContent.includes('1 sat'));
    document.querySelector('.ops-pres-exit').click();
    for (let i = 0; i < 2; i++) document.querySelector('[data-alert-action="remove"]').click();
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

    // A warning date the editor rejected stays on screen while the stored interval is the last accepted one:
    // every action that keeps or replaces the event must refuse, and no render may drop the typed date.
    document.querySelector('.ops-pres-exit').click();
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    const typed = (field, value) => {
      const input = document.querySelector('[data-warning-field="' + field + '"]');
      input.value = value; input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    document.querySelector('[data-alert-action="add"]').click();
    typed('validFrom', '2026-10-25T09:00'); typed('validTo', '2026-10-25T17:00');
    typed('validFrom', '2026-10-26T10:00'); // after the end: rejected
    const archive = () => memory.get('hb.events.v1');
    let archiveBefore = archive();
    const notice = () => document.querySelector('.ops-notice').textContent;
    const refusal = text => notice().includes(text) && notice().includes('interval de valabilitate este invalid');
    const held = () => {
      const start = document.querySelector('[data-warning-field="validFrom"]');
      return start.value === '2026-10-26T10:00' && Boolean(start.validationMessage)
        && document.querySelector('[data-alert-status]').textContent.startsWith('Interval invalid')
        && document.querySelector('[data-warning-id]').open;
    };
    const refused = (name, text) => check(name, refusal(text) && held() && archive() === archiveBefore);
    const title = () => document.querySelector('[data-ops-card="event"] h2').textContent;
    check('rejectedDateFlagged', held());
    document.querySelector('[data-action="save"]').click();
    refused('saveRefusedWhileDateRejected', 'Situația nu a fost salvată.');
    document.querySelector('[data-action="event-export"]').click(); await settle();
    refused('exportRefusedWhileDateRejected', 'Situația nu a fost exportată.');
    document.querySelector('[data-action="archive-export"]').click(); await settle();
    refused('archiveExportRefusedWhileDateRejected', 'Arhiva nu a fost exportată.');
    document.querySelector('[data-resolve-mark="test-0"]').click();
    refused('resolveRefusedWhileDateRejected', 'Starea situației nu a fost schimbată.');
    check('resolveLeavesMarkerOpen', !document.querySelector('[data-resolve-mark="test-0"]').classList.contains('active'));
    document.querySelector('[data-remove="test-1"]').click();
    refused('removeRefusedWhileDateRejected', 'Marcajul nu a fost eliminat.');
    check('removeLeavesMarker', Boolean(document.querySelector('[data-remove="test-1"]')));
    const heading = title();
    document.querySelector('[data-action="duplicate"]').click();
    refused('duplicateRefusedWhileDateRejected', 'Situația curentă a rămas deschisă.');
    check('duplicateLeavesEvent', title() === heading);
    document.querySelector('[data-action="new"]').click();
    refused('closeRefusedWhileDateRejected', 'Situația curentă a rămas deschisă.');
    check('closeLeavesEvent', title() === heading);
    const archiveSelect = document.querySelector('#ops-archive');
    archiveSelect.value = ''; archiveSelect.dispatchEvent(new Event('change', { bubbles: true }));
    check('openRefusedWhileDateRejected', refusal('Situația curentă a rămas deschisă.') && held() && title() === heading);
    // Rebuilding the panel for any other reason keeps the typed date and the invalid status.
    document.querySelector('[data-alert-action="add"]').click();
    check('renderKeepsRejectedDate', held() && document.querySelectorAll('[data-warning-id]').length === 2);
    document.querySelectorAll('[data-alert-action="remove"]')[1].click();
    check('removingAnotherWarningKeepsRejectedDate', held() && document.querySelectorAll('[data-warning-id]').length === 1);
    archiveBefore = archive(); // adding and removing a warning autosaves the last accepted interval
    document.querySelector('[data-mark="test-2"]').click();
    document.querySelector('#ops-marker').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    refused('markerAddRefusedWhileDateRejected', 'Marcajul nu a fost adăugat.');
    check('markerStaysPendingWhileDateRejected', Boolean(document.querySelector('#ops-marker')));
    document.querySelector('[data-action="archive-export"]').click(); await settle();
    refused('archiveExportWithMarkerRefusedWhileDateRejected', 'Arhiva nu a fost exportată.');
    document.querySelector('[data-action="discard-mark"]').click();
    check('discardKeepsRejectedDate', held());
    typed('validFrom', '2026-10-25T08:00');
    check('correctedDateLiftsTheFlag', !document.querySelector('[data-warning-field="validFrom"]').validationMessage
      && !document.querySelector('[data-alert-status]').textContent.startsWith('Interval invalid'));
    document.querySelector('[data-action="save"]').click();
    check('saveWorksOnceCorrected', notice().startsWith('Situația a fost salvată') && archive() !== archiveBefore);

    // Back to presentation with no warnings, as the layout checks below expect.
    while (document.querySelector('[data-alert-action="remove"]')) document.querySelector('[data-alert-action="remove"]').click();
    document.querySelector('[data-action="present"]').click();
    await nextFrame();

    // Three realistic warnings (about three lines of text, two lines of areas each) must stay
    // readable together: the grid never scrolls on its own and the title is never clipped.
    const shownRect = (rect, start, boundary) => {
      if (!rect || !rect.width || !rect.height) return false;
      for (let node = start; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
          const box = node.getBoundingClientRect(), left = box.left + node.clientLeft, top = box.top + node.clientTop;
          if (rect.top < top - 0.5 || rect.left < left - 0.5 || rect.bottom > top + node.clientHeight + 0.5 || rect.right > left + node.clientWidth + 0.5) return false;
        }
        if (node === boundary) break;
      }
      return rect.top >= -0.5 && rect.bottom <= innerHeight + 0.5;
    };
    const shown = (element, boundary) => Boolean(element) && shownRect(element.getBoundingClientRect(), element.parentElement, boundary);
    const firstLine = element => { const range = document.createRange(); range.selectNodeContents(element); return range.getClientRects()[0]; };
    const openMessages = async () => {
      document.querySelector('[data-action="present"]').click();
      await nextFrame();
      if (!visible(panel('messages'))) toggle('messages').click();
      await nextFrame();
      return panel('messages');
    };
    document.querySelector('.ops-pres-exit').click();
    for (let i = 0; i < 3; i++) document.querySelector('[data-alert-action="add"]').click();
    const scenario = [
      ['red', 'Ninsori abundente și viscol puternic, cu depuneri de zăpadă de peste 25 cm; drumuri impracticabile și vizibilitate redusă sub 100 m.'],
      ['orange', 'Intensificări ale vântului cu rafale de 60-70 km/h și ninsori moderate cantitativ; posibile căderi de arbori și întreruperi de curent.'],
      ['yellow', 'Polei și ceață densă în zonele joase, cu temperaturi în scădere sub minus 5 grade; circulație îngreunată pe drumurile secundare.'],
    ];
    [...document.querySelectorAll('[data-warning-id]')].forEach((entry, index) => {
      const set = (field, value, type) => {
        const input = entry.querySelector('[data-warning-field="' + field + '"]');
        input.value = value; input.dispatchEvent(new Event(type, { bubbles: true }));
      };
      set('code', scenario[index][0], 'change'); set('source', 'ANM București', 'input');
      set('validFrom', '2026-10-17T06:00', 'change'); set('validTo', '2026-10-17T20:00', 'change'); set('text', scenario[index][1], 'input');
      for (const village of entry.querySelectorAll('[data-alert-area="places"]')) village.click();
    });
    // Without a description the title block is the only thing the header can squeeze, so the clip showed up there first.
    const readable = async (suffix) => {
      const head = await openMessages();
      const grid = head.querySelector('.ops-alert-grid');
      const triple = [...head.querySelectorAll('.ops-alert')];
      check('threeWarningsRendered' + suffix, triple.length === 3 && triple.map(banner => banner.dataset.code).join() === 'red,orange,yellow');
      check('descriptionAsConfigured' + suffix, Boolean(head.querySelector('.ops-slide-notes')) === (suffix === ''));
      check('titleNotClipped' + suffix, shown(head.querySelector('.ops-slide-eyebrow'), head) && shown(head.querySelector('h1'), head));
      check('threeWarningsHeaderInViewport' + suffix, inViewport(head));
      if (!compact) {
        // The header is the visible area: neither the grid, a banner nor the header itself may hide a banner's start.
        check('bannerStartsVisible' + suffix, triple.every(banner => {
          const text = banner.querySelector('.ops-alert-text');
          return shown(banner.querySelector('.ops-alert-code'), head) && shown(banner.querySelector('.ops-alert-when'), head) && shownRect(firstLine(text), text, head);
        }));
        check('alertGridHasNoNestedScroll' + suffix, grid.scrollHeight <= grid.clientHeight + 1);
        check('headerHasNoScroll' + suffix, head.scrollHeight <= head.clientHeight + 1);
        check('headerLeavesMapFree' + suffix, head.getBoundingClientRect().height <= innerHeight * 0.5);
      } else {
        // On phones the header scrolls as a whole, so every banner's start must be reachable by scrolling to it.
        check('bannersReachableByScrolling' + suffix, triple.every(banner => {
          banner.scrollIntoView({ block: 'start' });
          const text = banner.querySelector('.ops-alert-text');
          return shown(banner.querySelector('.ops-alert-code'), head) && shown(banner.querySelector('.ops-alert-when'), head) && shownRect(firstLine(text), text, head);
        }));
        head.scrollTop = 0;
      }
    };
    await readable('');
    document.querySelector('.ops-pres-exit').click();
    const noNotes = document.querySelector('[data-field="notes"]');
    noNotes.value = ''; noNotes.dispatchEvent(new Event('input', { bubbles: true }));
    await readable('NoDescription');

    // A scrolled banner or description keeps its position when the overlay is rebuilt.
    document.querySelector('.ops-pres-exit').click();
    const longText = document.querySelector('[data-warning-field="text"]');
    longText.value = Array.from({ length: 40 }, (_, i) => 'Long warning line ' + i).join('\n'); longText.dispatchEvent(new Event('input', { bubbles: true }));
    const longNotes = document.querySelector('[data-field="notes"]');
    longNotes.value = Array.from({ length: 60 }, (_, i) => 'Operational note ' + i).join('\n'); longNotes.dispatchEvent(new Event('input', { bubbles: true }));
    await openMessages();
    const scrollIds = ['ops-pres-alert', 'ops-pres-message-text'];
    const scrolled = {};
    for (const id of scrollIds) { const element = document.getElementById(id); element.scrollTop = 40; scrolled[id] = element.scrollTop; }
    for (let i = 0; i < 2; i++) document.querySelector('[data-pres-group="resolved"]').click(); // rebuilds the overlay, then restores the group
    check('bannerScrollSurvivesRender', scrolled['ops-pres-alert'] > 0 && document.getElementById('ops-pres-alert').scrollTop === scrolled['ops-pres-alert']);
    check('descriptionScrollSurvivesRender', scrolled['ops-pres-message-text'] > 0 && document.getElementById('ops-pres-message-text').scrollTop === scrolled['ops-pres-message-text']);
    // Banners are keyed by warning, not by rank: downgrading the scrolled warning while presenting moves its banner to
    // ops-pres-alert-1, and its position has to follow it.
    const rank = document.querySelector('[data-warning-field="code"]');
    rank.value = 'yellow'; rank.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 2; i++) document.querySelector('[data-pres-group="resolved"]').click();
    const moved = [...document.querySelectorAll('.ops-alert')].find(banner => banner.textContent.includes('Long warning line 39'));
    check('scrolledWarningChangedRank', moved?.id === 'ops-pres-alert-1');
    check('bannerScrollFollowsWarning', Boolean(moved) && moved.scrollTop === scrolled['ops-pres-alert']);
    parent.postMessage(result, '*');
  } catch (error) { parent.postMessage({ viewport: innerWidth + 'x' + innerHeight, error: error.stack }, '*'); }
}

test('CJSU panels collapse independently, preserve the map, and keep full warnings accessible', { skip: !existsSync(chrome) }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cjsu-presentation-'));
  const web = new URL('../web/', import.meta.url).href;
  const child = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><script src="${web}vendor/proj4.js"></script><link rel="stylesheet" href="${web}css/app.css"><link rel="stylesheet" href="${web}css/operations.css"><link rel="stylesheet" href="${web}css/operations-cards.css"><link rel="stylesheet" href="${web}css/operations-alerts.css"><div class="app"><aside class="side"><div id="tab-situatii"></div></aside><div class="mapwrap"><div id="map" style="background:#dce6df"></div></div></div><script type="module">import { initOperations } from "${web}js/operations.js"; import { createEvent } from "${web}js/event-store.js"; (${browserChecks.toString()})({ initOperations, createEvent })</script>`;
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
