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
  const boot = ({ active, session = {}, save, del } = {}) => {
    const memory = new Map([['hb.ops.session.v1', JSON.stringify({ active, ...session })]]);
    const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
    const calls = [], toasts = [], deletes = [];
    const cloudDb = { saveSituation: situation => { calls.push(situation); return save ? save(situation) : Promise.resolve(true); }, deleteSituation: id => { deletes.push(id); return del ? del(id) : Promise.resolve(true); } };
    const state = { data: { admin: { features: [] }, localities: [] }, visible: {}, overlays: {}, basemap: 'harta', theme: 'zi' };
    document.querySelector('#tab-situatii').replaceChildren();
    document.querySelectorAll('.ops-drawbar, .ops-focusbar, .ops-presentation').forEach(el => el.remove());
    const ops = initOperations({ map, storage, state, toast: text => toasts.push(text), selectTab: noop, setSheet: noop, stopOtherTools: noop,
      applyStyle: noop, renderLayerPanel: noop, cloudDb, publishWaitMs: 40 });
    const archive = () => JSON.parse(memory.get('hb.events.v1') || '{"events":[]}').events;
    return { ops, calls, toasts, archive, deletes };
  };
  const $ = selector => document.querySelector(selector);
  // A missing button fails the checks that follow instead of stopping every later scenario.
  const click = selector => $(selector)?.click();
  const title = () => $('[data-ops-card="event"] h2')?.textContent;
  const status = () => $('#ops-save-state')?.textContent || '';
  const notice = () => $('.ops-notice')?.textContent || '';
  const editTitle = value => { const input = $('[data-field="title"]'); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
  const situation = name => { const event = createEvent(name, 'snow'); event.updatedAt = later(-30); return event; };
  const pick = id => { const select = $('#ops-archive'); select.value = id; select.dispatchEvent(new Event('change', { bubbles: true })); };
  const colleague = (event, title, minutes) => ({ ...structuredClone(event), title, updatedAt: later(minutes) });

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
      click('[data-action="cloud-take"]');
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
      click('[data-action="save"]'); await settle();
      check('plainPublishRefusedInConflict', calls.length === 0 && notice().startsWith('Altcineva a publicat'));
      click('[data-action="cloud-overwrite"]'); await settle();
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
      click('[data-action="save"]'); await settle();
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
      click('[data-action="save"]'); await settle(5);
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
      click('[data-action="save"]'); await settle();
      check('failedPublishReported', notice().startsWith('Situația e salvată doar în acest browser') && status().includes('nepublicat în Cloud'));
      void ops;
    }

    // Offline the write only queues: the operator hears it is pending, then that it landed.
    {
      const mine = situation('Ninsoare');
      let release;
      boot({ active: mine, save: () => new Promise(resolve => { release = () => resolve(true); }) });
      editTitle('Ninsoare · offline');
      click('[data-action="save"]'); await settle(80);
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
      click('[data-remove="m1"]');
      const stored = () => archive().find(event => event.id === mine.id)?.features.features.map(f => f.properties.id).join(',');
      check('markerRemovedAtOnce', !$('[data-remove="m1"]') && stored() === 'm2' && $('.ops-undo')?.textContent.includes('Echipaj ISU 1'));
      click('[data-action="undo"]');
      check('markerUndoRestoresOrder', $('[data-remove="m1"]') && stored() === 'm1,m2' && !$('.ops-undo'));
    }

    // Deleting a situation asks first, then can be undone in this browser and in the Cloud.
    {
      const mine = situation('Exercițiu CJSU');
      const { ops, archive, calls, deletes } = boot({ active: mine });
      ops.syncFromCloud([structuredClone(mine)]);
      const inArchive = () => archive().some(event => event.id === mine.id);
      click('[data-delete-id]');
      check('deleteAsksFirst', $('.ops-confirm')?.textContent.includes('și din Cloud') && inArchive() && !deletes.length);
      check('deleteFocusesCancel', document.activeElement?.dataset.action === 'cancel-delete');
      click('[data-action="cancel-delete"]');
      check('deleteCanBeCancelled', !$('.ops-confirm') && title() === 'Exercițiu CJSU' && inArchive());
      click('[data-delete-id]');
      click('[data-confirm-delete]'); await settle();
      check('deleteRemovesEverywhere', !inArchive() && deletes[0] === mine.id && !title() && $('.ops-undo')?.textContent.includes('Exercițiu CJSU'));
      ops.syncFromCloud([]);
      click('[data-action="undo"]'); await settle();
      check('deleteUndoRestores', inArchive() && title() === 'Exercițiu CJSU' && calls.some(sent => sent.id === mine.id && sent.updatedAt === mine.updatedAt) && !$('.ops-undo'));
    }

    // The colleague's version may carry an older timestamp than our edit; taking it still stores it.
    {
      const mine = situation('Ceață densă');
      const { ops, archive } = boot({ active: mine, session: { cloudBase: mine.updatedAt } });
      editTitle('Ceață densă · varianta mea');
      const older = colleague(mine, 'Ceață densă · coleg', -10);
      ops.syncFromCloud([older]);
      click('[data-action="cloud-take"]');
      check('takeOlderCloudVersion', title() === 'Ceață densă · coleg' && archive().find(event => event.id === mine.id)?.updatedAt === older.updatedAt);
    }

    // Undoing a delete during a conflict brings back our edits and the conflict, not the colleague's copy.
    {
      const mine = situation('Revărsare Siret');
      const { ops, archive, calls } = boot({ active: mine, session: { cloudBase: mine.updatedAt } });
      editTitle('Revărsare Siret · varianta mea');
      const theirs = colleague(mine, 'Revărsare Siret · coleg', 1);
      ops.syncFromCloud([theirs]);
      click('[data-delete-id]'); click('[data-confirm-delete]'); await settle();
      ops.syncFromCloud([]);
      click('[data-action="undo"]'); await settle();
      const stored = () => archive().find(event => event.id === mine.id)?.title;
      check('undoKeepsOurEditsInConflict', $('[data-field="title"]').value === 'Revărsare Siret · varianta mea' && stored() === 'Revărsare Siret · varianta mea' && $('.ops-conflict'));
      check('undoRewritesTheirCloudCopy', calls.some(sent => sent.title === 'Revărsare Siret · coleg'));
      ops.syncFromCloud([theirs]);
      check('restoredConflictSurvivesEcho', stored() === 'Revărsare Siret · varianta mea' && $('.ops-conflict'));
      const before = calls.length;
      click('[data-action="save"]'); await settle();
      check('restoredConflictStillGuardsPublish', calls.length === before && notice().startsWith('Altcineva a publicat'));
    }

    // Our write is still pending: reopening the situation must not call it published.
    {
      const mine = situation('Viscol sud'), other = situation('Secetă Prut');
      let release;
      const { ops } = boot({ active: mine, session: { cloudBase: mine.updatedAt }, save: written => new Promise(resolve => {
        release = () => resolve(true);
        ops.syncFromCloud([written, structuredClone(other)], { pending: new Set([written.id]) });
      }) });
      ops.syncFromCloud([structuredClone(mine), structuredClone(other)], { pending: new Set() });
      editTitle('Viscol sud · offline');
      click('[data-action="save"]'); await settle(80);
      pick(other.id); pick(mine.id);
      check('pendingWriteNotPublishedOnReopen', title() === 'Viscol sud · offline' && status().includes('nepublicat în Cloud'));
      release(); await settle();
      check('pendingWriteLandsAfterReopen', status().startsWith('Publicat în Cloud'));
    }

    // A write queued offline (even before a reload) is published once the server confirms it in a snapshot.
    {
      const mine = situation('Polei DJ291');
      const { ops, calls } = boot({ active: mine, save: () => new Promise(() => {}) });
      editTitle('Polei DJ291 · trimis');
      click('[data-action="save"]'); await settle(80);
      ops.syncFromCloud([structuredClone(calls[0])], { pending: new Set([calls[0].id]) });
      check('queuedWriteStillUnpublished', status().includes('nepublicat în Cloud'));
      ops.syncFromCloud([structuredClone(calls[0])], { pending: new Set() });
      check('serverConfirmationMarksPublished', status().startsWith('Publicat în Cloud'));
    }

    // A just-created or duplicated situation can be deleted before any edit, and undone.
    {
      const { archive } = boot({});
      const form = $('#ops-new');
      form.querySelector('[name="title"]').value = 'Exercițiu nou';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      check('newSituationSavedAtOnce', archive().some(event => event.title === 'Exercițiu nou'));
      click('[data-delete-id]'); click('[data-confirm-delete]'); await settle();
      check('newSituationDeletes', !title() && !archive().some(event => event.title === 'Exercițiu nou') && $('.ops-undo'));
      click('[data-action="undo"]'); await settle();
      check('newSituationUndo', title() === 'Exercițiu nou');
      click('[data-action="duplicate"]');
      check('duplicateSavedAtOnce', archive().some(event => event.title === 'Exercițiu nou · copie'));
      click('[data-delete-id]'); click('[data-confirm-delete]'); await settle();
      check('duplicateDeletes', !title() && !archive().some(event => event.title === 'Exercițiu nou · copie') && archive().some(event => event.title === 'Exercițiu nou'));
    }

    // A live version with an older timestamp (another computer's clock, or a queued write) is stored as shown.
    {
      const mine = situation('Furtună Dorohoi');
      const { ops, archive } = boot({ active: mine, session: { cloudBase: mine.updatedAt } });
      ops.syncFromCloud([structuredClone(mine)]);
      ops.syncFromCloud([colleague(mine, 'Furtună Dorohoi · coleg', -40)]);
      check('olderLiveVersionStored', title() === 'Furtună Dorohoi · coleg' && archive().find(event => event.id === mine.id)?.title === 'Furtună Dorohoi · coleg');
    }

    // While our overwrite travels, "Încarcă versiunea din Cloud" waits for its answer.
    {
      const mine = situation('Inundație Bașeu');
      let release;
      const { ops } = boot({ active: mine, session: { cloudBase: mine.updatedAt }, save: () => new Promise(resolve => { release = () => resolve(true); }) });
      editTitle('Inundație Bașeu · varianta mea');
      ops.syncFromCloud([colleague(mine, 'Inundație Bașeu · coleg', 1)]);
      click('[data-action="cloud-overwrite"]'); await settle();
      click('[data-action="cloud-take"]');
      check('takeRefusedWhilePublishing', $('[data-field="title"]').value === 'Inundație Bașeu · varianta mea' && notice().startsWith('Așteaptă răspunsul'));
      release(); await settle();
      check('overwriteLandsCleanly', !$('.ops-conflict') && status().startsWith('Publicat în Cloud'));
    }

    // Undo before the Cloud delete answers: no stale "deleted" message, and the restore is not called published early.
    {
      const mine = situation('Alunecare Hudești');
      let answerDelete, answerRestore;
      const { ops, toasts } = boot({ active: mine, session: { cloudBase: mine.updatedAt },
        del: () => new Promise(resolve => { answerDelete = () => resolve(true); }),
        save: () => new Promise(resolve => { answerRestore = () => resolve(true); }) });
      ops.syncFromCloud([structuredClone(mine)]);
      click('[data-delete-id]'); click('[data-confirm-delete]'); await settle();
      click('[data-action="undo"]'); await settle();
      check('restoreNotPublishedBeforeAnswer', title() === 'Alunecare Hudești' && status().includes('nepublicat în Cloud'));
      answerDelete(); await settle(80);
      check('noStaleDeleteMessage', !toasts.some(text => text.includes('ștearsă')) && !notice().includes('ștearsă'));
      answerRestore(); await settle();
      check('restoreLandsAsPublished', status().startsWith('Publicat în Cloud'));
    }

    // The banner leaves when the conflict does: Cloud copy deleted, or the held marker form dropped.
    {
      const mine = situation('Vânt puternic');
      const { ops } = boot({ active: mine, session: { cloudBase: mine.updatedAt } });
      editTitle('Vânt puternic · varianta mea');
      ops.syncFromCloud([colleague(mine, 'Vânt puternic · coleg', 1)]);
      ops.syncFromCloud([]);
      check('bannerLeavesWhenCloudCopyGoes', !$('.ops-conflict'));
    }
    {
      const mine = situation('Grindină Săveni');
      const { ops } = boot({ active: mine, session: { cloudBase: mine.updatedAt } });
      ops.openRoadCreator();
      ops.syncFromCloud([colleague(mine, 'Grindină Săveni · coleg', 1)]);
      check('heldByFormExplainsWhy', $('.ops-conflict')?.textContent.includes('Dacă renunți la ele'));
      click('[data-action="discard-mark"]');
      check('droppingTheFormLoadsTheNewVersion', title() === 'Grindină Săveni · coleg' && !$('.ops-conflict'));
    }

    // Exporting a clean situation keeps its version, so it still reads as published.
    {
      const mine = situation('Export curat');
      window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async () => {}, close: async () => {} }) });
      const { ops, archive } = boot({ active: mine });
      ops.syncFromCloud([structuredClone(mine)]);
      click('[data-action="event-export"]'); await settle();
      click('[data-action="archive-export"]'); await settle();
      check('exportKeepsVersion', archive().find(event => event.id === mine.id)?.updatedAt === mine.updatedAt && status().startsWith('Publicat în Cloud'));
      pick(mine.id);
      check('exportedReopensPublished', status().startsWith('Publicat în Cloud'));
    }

    // A marker's "Anulează" does not outlive the version it belongs to.
    {
      const mine = situation('Marcaj și conflict');
      mine.features.features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [26.6, 47.7] }, properties: { id: 'p1', kind: 'isu', status: 'confirmed', title: 'Echipaj', observedAt: mine.updatedAt } });
      const { ops } = boot({ active: mine, session: { cloudBase: mine.updatedAt } });
      click('[data-remove="p1"]');
      ops.syncFromCloud([colleague(mine, 'Marcaj și conflict · coleg', 1)]);
      click('[data-action="cloud-take"]');
      check('undoGoesWithReplacedVersion', !$('.ops-undo') && title() === 'Marcaj și conflict · coleg');
    }

    // Second review round: what the first fixes still left open.
    {
      const a = situation('Situație A'), b = situation('Situație B');
      const { ops } = boot({ active: a });
      ops.syncFromCloud([structuredClone(a), structuredClone(b)]);
      click('[data-delete-id]'); click('[data-confirm-delete]'); await settle();
      ops.syncFromCloud([structuredClone(b)]);
      pick(b.id);
      check('deleteUndoSurvivesOpeningAnother', title() === 'Situație B' && $('.ops-undo')?.textContent.includes('Situație A'));
      click('[data-action="undo"]'); await settle();
      check('deleteUndoAfterOpeningAnother', title() === 'Situație A');
    }
    {
      const mine = situation('Coadă offline');
      const { ops } = boot({ active: mine, session: { cloudBase: mine.updatedAt }, save: () => new Promise(() => {}) });
      editTitle('Coadă offline · varianta mea');
      ops.syncFromCloud([colleague(mine, 'Coadă offline · coleg', 1)]);
      click('[data-action="cloud-overwrite"]'); await settle(80);
      click('[data-action="cloud-take"]');
      check('takeRefusedWhileWriteQueued', $('[data-field="title"]').value === 'Coadă offline · varianta mea' && notice().startsWith('Așteaptă răspunsul'));
    }
    {
      const mine = situation('Refuz târziu');
      let refuse;
      boot({ active: mine, save: () => new Promise(resolve => { refuse = () => resolve(false); }) });
      editTitle('Refuz târziu · trimis');
      click('[data-action="save"]'); await settle(80);
      refuse(); await settle();
      check('lateRefusalReported', notice().startsWith('Cloud-ul a refuzat publicarea') && status().includes('nepublicat în Cloud'));
    }
    {
      const mine = situation('Republicată între timp');
      const { ops, calls } = boot({ active: mine, session: { cloudBase: mine.updatedAt }, del: () => new Promise(() => {}) });
      ops.syncFromCloud([structuredClone(mine)]);
      click('[data-delete-id]'); click('[data-confirm-delete]'); await settle();
      const again = colleague(mine, 'Republicată între timp · coleg', 1);
      ops.syncFromCloud([again]);
      click('[data-action="undo"]'); await settle();
      check('undoKeepsVersionPublishedMeanwhile', !calls.some(sent => sent.updatedAt === mine.updatedAt) && title() === 'Republicată între timp · coleg');
    }
    {
      const mine = situation('După publicare');
      let release;
      const { ops } = boot({ active: mine, session: { cloudBase: mine.updatedAt }, save: () => new Promise(resolve => { release = () => resolve(true); }) });
      editTitle('După publicare · a mea');
      click('[data-action="save"]'); await settle();
      ops.syncFromCloud([colleague(mine, 'După publicare · coleg', 1)]);
      release(); await settle();
      check('laterColleagueVersionLoadsAfterPublish', title() === 'După publicare · coleg' && !$('.ops-conflict'));
    }
    {
      const mine = situation('Reîncărcare');
      const theirs = colleague(mine, 'Reîncărcare · coleg', 1);
      boot({ active: { ...mine, title: 'Reîncărcare · a mea' }, session: { cloudBase: mine.updatedAt, unpublished: true, cloudConflict: theirs } });
      check('conflictSurvivesReload', $('.ops-conflict') && title() === 'Reîncărcare · a mea');
    }

    // Ending an area selection or an itinerary pick lets the held version in, like the other tools.
    {
      const mine = situation('Zonă terminată');
      const { ops } = boot({ active: mine, session: { cloudBase: mine.updatedAt } });
      click('button[data-action="area"]');
      ops.syncFromCloud([colleague(mine, 'Zonă terminată · coleg', 1)]);
      check('heldWhileSelectingArea', $('.ops-conflict') && title() === 'Zonă terminată');
      click('.ops-drawbar button[data-action="finish"]');
      check('finishingAreaLoadsHeldVersion', title() === 'Zonă terminată · coleg' && !$('.ops-conflict'));
    }
    {
      const mine = situation('Punct de itinerar');
      const { ops } = boot({ active: mine, session: { cloudBase: mine.updatedAt } });
      // The "Adaugă pe hartă" buttons live in a menu; choosing an entry runs its action.
      const menu = $('[data-ops-add-action]');
      if (menu) { menu.value = 'open-itinerary'; menu.dispatchEvent(new Event('change', { bubbles: true })); }
      click('button[data-itinerary="pick"]');
      ops.syncFromCloud([colleague(mine, 'Punct de itinerar · coleg', 1)]);
      check('heldWhilePickingItinerary', $('.ops-conflict') && title() === 'Punct de itinerar');
      click('.ops-drawbar button[data-action="cancel-itinerary-pick"]');
      check('cancellingPickLoadsHeldVersion', title() === 'Punct de itinerar · coleg' && !$('.ops-conflict'));
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
    assert.ok(Object.keys(result).length >= 65, 'Every scenario reported');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
