import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const chrome = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Runs in the page: boots the real initOperations with a stub Cloud and feeds it snapshots
// the way Firestore's onSnapshot does, then reports what the operator would see.
async function browserChecks({ initOperations, createEvent }) {
  const out = document.querySelector('#results');
  const result = {};
  const pageErrors = [];
  addEventListener('error', event => pageErrors.push(event.message));
  addEventListener('unhandledrejection', event => pageErrors.push(String(event.reason?.stack || event.reason)));
  const check = (name, value) => { result[name] = Boolean(value); };
  const later = minutes => new Date(Date.now() + minutes * 60000).toISOString();
  const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
  const noop = () => {};
  const map = {
    on: noop, getSource: noop, getLayer: noop, getCenter: () => ({ lng: 26.6, lat: 47.7 }), getZoom: () => 8, getBearing: () => 0, getPitch: () => 0,
    getPadding: () => ({}), getContainer: () => document.querySelector('#map'), fitBounds: noop, flyTo: noop, setPadding: noop, resize: noop, jumpTo: noop,
    getCanvas: () => document.querySelector('#map'),
  };
  const boot = ({ active, session = {}, save } = {}) => {
    const memory = new Map([['hb.ops.session.v1', JSON.stringify({ active, ...session })]]);
    const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
    const calls = [], toasts = [], deletes = [];
    const cloudDb = { saveSituation: situation => { calls.push(situation); return save ? save(situation) : Promise.resolve(true); }, deleteSituation: async id => { deletes.push(id); return true; } };
    const state = { data: { admin: { features: [] }, localities: [] }, visible: {}, overlays: {}, basemap: 'harta', theme: 'zi' };
    document.querySelector('#tab-situatii').replaceChildren();
    const ops = initOperations({ map, storage, state, toast: text => toasts.push(text), selectTab: noop, setSheet: noop, stopOtherTools: noop,
      applyStyle: noop, renderLayerPanel: noop, cloudDb, publishWaitMs: 40 });
    const archive = () => JSON.parse(memory.get('hb.events.v1') || '{"events":[]}').events;
    return { ops, calls, toasts, archive, deletes };
  };
  const $ = selector => document.querySelector(selector);
  const title = () => $('[data-ops-card="event"] h2')?.textContent;
  const status = () => $('#ops-save-state')?.textContent || '';
  const notice = () => $('.ops-notice')?.textContent || '';
  const editTitle = value => { const input = $('[data-field="title"]'); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
  const situation = name => { const event = createEvent(name, 'snow'); event.updatedAt = later(-30); return event; };

  try {
    // A colleague publishes while the marker form is open: the form and its text survive.
    {
      const mine = situation('Viscol nord');
      const { ops, archive } = boot({ active: mine, session: { cloudBase: mine.updatedAt } });
      ops.openRoadCreator();
      const field = $('#ops-marker [name="title"]');
      field.value = 'DJ291 km 4, text tastat';
      const other = situation('Inundație Prut');
      ops.syncFromCloud([structuredClone(mine), other]);
      check('markerFormSurvivesSnapshot', $('#ops-marker [name="title"]') === field && field.value === 'DJ291 km 4, text tastat');
      check('archiveFollowsSnapshot', archive().some(event => event.id === other.id) && $('#ops-archive').textContent.includes('Inundație Prut'));
      const newer = { ...structuredClone(mine), title: 'Viscol nord · coleg', updatedAt: later(1) };
      ops.syncFromCloud([newer]);
      check('newerHeldWhileMarkerOpen', title() === 'Viscol nord' && $('.ops-conflict') && $('#ops-marker [name="title"]') === field);
    }

    // Unpublished edits are not replaced, and the local archive keeps them.
    {
      const mine = situation('Cod portocaliu');
      const { ops, archive, toasts } = boot({ active: mine, session: { cloudBase: mine.updatedAt } });
      editTitle('Cod portocaliu · varianta mea');
      check('editMarkedUnpublished', status().includes('nepublicat în Cloud'));
      const newer = { ...structuredClone(mine), title: 'Cod portocaliu · coleg', updatedAt: later(1) };
      ops.syncFromCloud([newer]);
      check('unpublishedHeld', $('[data-field="title"]').value === 'Cod portocaliu · varianta mea' && $('.ops-conflict'));
      check('localCopyKept', archive().find(event => event.id === mine.id)?.title === 'Cod portocaliu · varianta mea');
      check('conflictToastOnce', toasts.filter(text => text.startsWith('Altcineva')).length === 1 && (ops.syncFromCloud([newer]), toasts.filter(text => text.startsWith('Altcineva')).length === 1));
      $('[data-action="cloud-take"]').click();
      check('takeCloudVersion', title() === 'Cod portocaliu · coleg' && !$('.ops-conflict') && status().startsWith('Publicat în Cloud'));
      check('takenVersionStored', archive().find(event => event.id === mine.id)?.updatedAt === newer.updatedAt);
    }

    // Our edit was made after a colleague's publish: still a conflict, so ours never lands on top silently.
    {
      const mine = situation('Secetă');
      const { ops, calls } = boot({ active: mine, session: { cloudBase: mine.updatedAt } });
      const colleague = { ...structuredClone(mine), title: 'Secetă · coleg', updatedAt: later(-10) };
      editTitle('Secetă · mai târziu');
      ops.syncFromCloud([colleague]);
      check('olderTimestampStillConflict', $('.ops-conflict') && $('[data-field="title"]').value === 'Secetă · mai târziu');
      $('[data-action="save"]').click(); await settle();
      check('plainPublishRefusedInConflict', calls.length === 0 && notice().startsWith('Altcineva a publicat'));
      $('[data-action="cloud-overwrite"]').click(); await settle();
      check('overwritePublishes', calls.length === 1 && calls[0].title === 'Secetă · mai târziu' && !$('.ops-conflict') && status().startsWith('Publicat în Cloud'));
    }

    // Nothing local: a newer Cloud version replaces the screen live, as before.
    {
      const mine = situation('Furtună');
      const { ops } = boot({ active: mine, session: { cloudBase: mine.updatedAt } });
      ops.syncFromCloud([{ ...structuredClone(mine), title: 'Furtună · actualizat', updatedAt: later(1) }]);
      check('cleanScreenFollowsCloud', title() === 'Furtună · actualizat' && !$('.ops-conflict'));
    }

    // The echo of our own write arrives before Firestore answers: not a conflict.
    {
      const mine = situation('Incendiu');
      let release;
      const { ops } = boot({ active: mine, session: { cloudBase: mine.updatedAt }, save: situation => new Promise(resolve => {
        release = () => resolve(true);
        ops.syncFromCloud([structuredClone(situation)]);
      }) });
      editTitle('Incendiu · publicat');
      $('[data-action="save"]').click(); await settle();
      check('echoNotConflict', !$('.ops-conflict') && $('[data-action="save"]').disabled);
      release(); await settle();
      check('publishReportsSuccess', notice().startsWith('Situația a fost publicată în Cloud') && status().startsWith('Publicat în Cloud') && !$('[data-action="save"]').disabled);
    }

    // The operator keeps typing while the write travels; its echo lands after the edit.
    {
      const mine = situation('Grindină');
      let release, sent;
      const { ops } = boot({ active: mine, session: { cloudBase: mine.updatedAt }, save: situation => new Promise(resolve => { sent = situation; release = () => resolve(true); }) });
      editTitle('Grindină · trimis');
      // Headless Chrome runs on virtual time: let a millisecond pass so the versions differ.
      $('[data-action="save"]').click(); await settle(5);
      editTitle('Grindină · după trimitere');
      ops.syncFromCloud([structuredClone(sent)]);
      check('lateEchoAfterEditNotConflict', !$('.ops-conflict') && $('[data-field="title"]').value === 'Grindină · după trimitere');
      release(); await settle();
      check('editAfterSendStaysUnpublished', status().includes('nepublicat în Cloud'));
    }

    // A refused write says so and keeps the situation marked unpublished.
    {
      const mine = situation('Polei');
      const { ops } = boot({ active: mine, save: async () => false });
      editTitle('Polei · DN29');
      $('[data-action="save"]').click(); await settle();
      check('failedPublishReported', notice().startsWith('Situația e salvată doar în acest browser') && status().includes('nepublicat în Cloud'));
      void ops;
    }

    // Offline the write only queues: the operator hears it is pending, then that it landed.
    {
      const mine = situation('Ninsoare');
      let release;
      boot({ active: mine, save: () => new Promise(resolve => { release = () => resolve(true); }) });
      editTitle('Ninsoare · offline');
      $('[data-action="save"]').click(); await settle(80);
      check('slowPublishPending', notice().startsWith('Cloud-ul nu a confirmat încă') && status().includes('nepublicat în Cloud'));
      release(); await settle();
      check('latePublishLands', notice().startsWith('Publicarea s-a încheiat') && status().startsWith('Publicat în Cloud'));
    }

    // Removing a marker is immediate, and "Anulează" puts it back where it was.
    {
      const mine = situation('Inundație Jijia');
      const point = (id, title) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [26.6, 47.7] }, properties: { id, kind: 'isu', status: 'confirmed', title, observedAt: mine.updatedAt } });
      mine.features.features.push(point('m1', 'Echipaj ISU 1'), point('m2', 'Echipaj ISU 2'));
      const { archive } = boot({ active: mine });
      $('[data-remove="m1"]').click();
      const stored = () => archive().find(event => event.id === mine.id)?.features.features.map(f => f.properties.id).join(',');
      check('markerRemovedAtOnce', !$('[data-remove="m1"]') && stored() === 'm2' && $('.ops-undo')?.textContent.includes('Echipaj ISU 1'));
      $('[data-action="undo"]').click();
      check('markerUndoRestoresOrder', $('[data-remove="m1"]') && stored() === 'm1,m2' && !$('.ops-undo'));
    }

    // Deleting a situation asks first, then can be undone in this browser and in the Cloud.
    {
      const mine = situation('Exercițiu CJSU');
      const { ops, archive, calls, deletes } = boot({ active: mine });
      ops.syncFromCloud([structuredClone(mine)]);
      const inArchive = () => archive().some(event => event.id === mine.id);
      $('[data-delete-id]').click();
      check('deleteAsksFirst', $('.ops-confirm')?.textContent.includes('și din Cloud') && inArchive() && !deletes.length);
      $('[data-action="cancel-delete"]').click();
      check('deleteCanBeCancelled', !$('.ops-confirm') && title() === 'Exercițiu CJSU' && inArchive());
      $('[data-delete-id]').click();
      $('[data-confirm-delete]').click(); await settle();
      check('deleteRemovesEverywhere', !inArchive() && deletes[0] === mine.id && !title() && $('.ops-undo')?.textContent.includes('Exercițiu CJSU'));
      ops.syncFromCloud([]);
      $('[data-action="undo"]').click(); await settle();
      check('deleteUndoRestores', inArchive() && title() === 'Exercițiu CJSU' && calls.some(sent => sent.id === mine.id && sent.updatedAt === mine.updatedAt) && !$('.ops-undo'));
    }

    // One malformed document does not stop the others from syncing.
    {
      const { ops, archive } = boot({});
      const good = situation('Alunecare de teren');
      ops.syncFromCloud([{ id: 'stricat', title: 'x', features: 'nu e GeoJSON' }, good]);
      check('validDocsSyncDespiteBadOne', archive().some(event => event.id === good.id) && !archive().some(event => event.id === 'stricat'));
    }
  } catch (error) { result.error = error.stack + (pageErrors.length ? '\n' + pageErrors.join('\n') : ''); }
  check('noPageErrors', !pageErrors.length || (result.pageErrors = pageErrors, false));
  out.textContent = JSON.stringify(result);
}

test('Cloud snapshots keep work in progress, publishing reports the real result, and removals can be undone', { skip: !existsSync(chrome) }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cjsu-cloud-guard-'));
  const web = new URL('../web/', import.meta.url).href;
  const page = `<!doctype html><meta charset="utf-8"><script src="${web}vendor/proj4.js"></script><div class="app"><aside class="side"><div id="tab-situatii"></div></aside><div class="mapwrap"><div id="map"></div></div></div><pre id="results"></pre><script type="module">import { initOperations } from "${web}js/operations.js"; import { createEvent } from "${web}js/event-store.js"; (${browserChecks.toString()})({ initOperations, createEvent })</script>`;
  try {
    const path = join(dir, 'test.html');
    writeFileSync(path, page);
    const run = spawnSync(chrome, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files', '--user-data-dir=' + join(dir, 'profile'), '--virtual-time-budget=10000', '--dump-dom', pathToFileURL(path).href], { encoding: 'utf8', timeout: 60000 });
    assert.equal(run.status, 0, run.error?.message || run.stderr || String(run.signal));
    const match = run.stdout.match(/<pre id="results"[^>]*>([\s\S]*?)<\/pre>/);
    assert.ok(match?.[1], 'Browser did not report results: ' + run.stderr.slice(-2000));
    const result = JSON.parse(match[1].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
    assert.equal(result.error, undefined, result.error);
    const failed = Object.entries(result).filter(([, ok]) => !ok).map(([name]) => name);
    assert.deepEqual(failed, [], 'Cloud guard regressions');
    assert.ok(Object.keys(result).length >= 20, 'Every scenario reported');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
