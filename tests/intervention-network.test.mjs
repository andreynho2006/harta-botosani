import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getInterventionUnits } from '../web/js/intervention-units.js';
import { prepareInterventionGraph, computeInterventionRoutes } from '../web/js/intervention-routing.js';

test('all eight confirmed exits connect to the county network and offer actual base/reserve routes', async () => {
  const units = getInterventionUnits(JSON.parse(await readFile(new URL('../web/data/subunitati.json', import.meta.url), 'utf8')));
  assert.equal(units.length, 8);
  assert.ok(units.every(unit => unit.confirmed));
  const network = JSON.parse(await readFile(new URL('../web/data/routing-roads.json', import.meta.url), 'utf8'));
  for (const cls of ['dn', 'dj', 'dc', 'local', 'street', 'service', 'track']) assert.ok(network.metadata.classes[cls] > 0);
  const graph = prepareInterventionGraph(network.features);
  // An independently checked DN29 vertex in the frozen source, not a made-up connector.
  const objective = [26.7924866, 47.8435775];
  for (const unit of units) {
    const result = computeInterventionRoutes(unit.coordinate, objective, graph);
    assert.ok(result.primary, unit.id + ': ' + result.reason);
    assert.ok(result.alternative, unit.id + ': missing reserve');
    assert.ok(result.snaps.start.distanceMeters < 20, unit.id + ': exit should align with its nearby road');
    assert.ok(result.primary.geometry.coordinates.length > 2);
    assert.notDeepEqual(result.primary.geometry.coordinates, result.alternative.geometry.coordinates);
  }
});

test('Botosani town-hall reserve follows Eminescu, Marchian and Cuza Voda instead of the residential alley shortcut', async () => {
  const network = JSON.parse(await readFile(new URL('../web/data/routing-roads.json', import.meta.url), 'utf8'));
  const result = computeInterventionRoutes([26.648383,47.752259], [26.662969,47.745412], network.features);
  assert.ok(result.primary);
  assert.ok(result.alternative);
  const names = result.alternative.roads.map(road => road.name);
  const boulevard = names.indexOf('Bulevardul Mihai Eminescu');
  const marchian = names.indexOf('Strada Arhimandrit Marchian');
  const cuza = names.indexOf('Strada Cuza Vodă');
  assert.ok(boulevard >= 0 && marchian > boulevard && cuza > marchian, names.join(' → '));
  assert.ok(!names.includes('Aleea Crizantemelor'));
  assert.ok(!names.includes('Aleea Rapsodia'));
  assert.ok(result.alternative.sharedFraction < 0.1);
  assert.ok(result.alternative.distanceKm > 2.8 && result.alternative.distanceKm < 3.1);
});
