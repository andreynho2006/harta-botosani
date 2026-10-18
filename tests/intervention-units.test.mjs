import test from 'node:test';
import assert from 'node:assert/strict';
import { INTERVENTION_UNIT_ROSTER, roster, getInterventionUnits } from '../web/js/intervention-units.js';

const official = (overrides = {}) => ({ id: 'official-1', name: 'Garda Botoșani', type: 'garda', lat: 47.75, lon: 26.66, ...overrides });
const find = (units, id = 'garda-botosani') => units.find(unit => unit.id === id);

test('roster lists eight distinct physical origins under their three parent units', () => {
  assert.equal(roster, INTERVENTION_UNIT_ROSTER);
  assert.equal(roster.length, 8);
  assert.equal(new Set(roster.map(unit => unit.id)).size, 8);
  assert.deepEqual([...new Set(roster.map(unit => unit.parentLabel))], ['Detașamentul Botoșani', 'Detașamentul Dorohoi', 'Stația Săveni']);
  assert.ok(roster.every(unit => unit.coordinate === null && unit.confirmed === false));
  assert.deepEqual(getInterventionUnits(), roster);
});

test('stable identifiers override names without changing roster labels', () => {
  const resolved = find(getInterventionUnits([official({ id: 'garda-botosani', name: 'Official physical response origin' })]));
  assert.deepEqual(resolved.coordinate, [26.66, 47.75]);
  assert.equal(resolved.name, 'Garda Botoșani');
  assert.equal(resolved.confirmed, true);
  assert.equal(resolved.reason, undefined);
});

test('accent and punctuation normalization supports exact guard and detachment names', () => {
  for (const input of [
    official({ name: ' GARDA DE INTERVENȚIE BOTOŞANI ' }),
    official({ name: 'Detașamentul de Pompieri Botoșani', type: 'detasament' }),
    official({ name: 'Botosani', type: 'garda' }),
    official({ name: 'Botoșani', type: 'detasament' }),
  ]) assert.equal(find(getInterventionUnits([input])).confirmed, true);
});

test('point and station aliases map only to their exact known locality and role', () => {
  const units = getInterventionUnits({ subunits: [
    official({ id: 'pl1', name: 'Punctul de lucru Flămânzi', type: 'punct' }),
    official({ id: 'pl2', name: 'PL Darabani', type: 'punct' }),
    official({ id: 'pl3', name: 'PL Coțușca', type: 'punct' }),
    official({ id: 'station1', name: 'Stația de Pompieri Săveni', type: 'sectie' }),
  ] });
  for (const id of ['punct-flamanzi', 'punct-darabani', 'punct-cotusca', 'garda-saveni']) assert.equal(find(units, id).confirmed, true);
  assert.equal(find(units, 'garda-dorohoi').confirmed, false);
});

test('inspectorate and volunteer sources cannot stand in for a professional guard', () => {
  for (const bad of [
    { name: 'Botoșani', type: 'inspectorat' },
    { id: 'garda-botosani', name: 'Inspectoratul Botoșani', type: 'inspectorat' },
    { name: 'Garda Botoșani', type: 'svsu' },
    { name: 'SVSU Botoșani', type: 'garda' },
    { name: 'Inspectoratul pentru Situații de Urgență Botoșani', type: 'detasament' },
    { name: 'ISU Botoșani', type: 'detasament' },
    { name: 'Garda Botoșani', type: 'vecin' },
  ]) assert.equal(find(getInterventionUnits([official(bad)])).confirmed, false);
  const darabani = official({ name: 'SVSU Darabani', type: 'svsu' });
  assert.equal(find(getInterventionUnits([darabani]), 'punct-darabani').confirmed, false);
});

test('OSM imports and explicitly unconfirmed points never become official route origins', () => {
  for (const bad of [
    { id: 'osm-1' }, { confirmed: false }, { official: false }, { source: 'OpenStreetMap' },
    { notes: 'Preluat din OpenStreetMap – de verificat' },
  ]) assert.equal(find(getInterventionUnits([official(bad)])).confirmed, false);
});

test('ambiguous names stay disabled; an explicit stable identifier takes precedence', () => {
  const duplicate = [official(), official({ id: 'official-2', lon: 26.67 })];
  const unresolved = find(getInterventionUnits(duplicate));
  assert.equal(unresolved.confirmed, false);
  assert.equal(unresolved.reason, 'ambiguous-official-records');
  const explicit = official({ id: 'garda-botosani', lon: 26.68 });
  assert.deepEqual(find(getInterventionUnits([...duplicate, explicit])).coordinate, [26.68, 47.75]);
  assert.equal(find(getInterventionUnits([explicit, explicit])).reason, 'ambiguous-official-records');
});

test('missing, empty, nonfinite and out-of-county coordinates stay null', () => {
  for (const bad of [
    { lat: null }, { lon: undefined }, { lat: '' }, { lon: ' ' }, { lat: false },
    { lat: NaN }, { lon: Infinity }, { lat: 0 }, { lon: 0 }, { lat: 46 }, { lon: 28 },
  ]) {
    const unit = find(getInterventionUnits([official(bad)]));
    assert.equal(unit.coordinate, null);
    assert.equal(unit.confirmed, false);
    assert.equal(unit.reason, 'invalid-coordinates');
  }
  assert.deepEqual(find(getInterventionUnits([official({ lat: '47.75', lon: '26.66' })])).coordinate, [26.66, 47.75]);
});

test('arbitrary names and incompatible roles do not fuzzy-match, and input is untouched', () => {
  const input = [official({ name: 'Garda Botoșani Nord' }), official({ name: 'Punct Botoșani', type: 'punct' })];
  const before = JSON.stringify(input);
  assert.ok(getInterventionUnits(input).every(unit => !unit.confirmed));
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(getInterventionUnits(null), roster);
  const resolved = getInterventionUnits([official()]);
  resolved[0].coordinate[0] = 0;
  assert.equal(roster[0].coordinate, null);
  assert.deepEqual(find(getInterventionUnits([official()])).coordinate, [26.66, 47.75]);
});
