import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAlertGeography, alertOutlined, buildAlertLabels, labelPoint, alertPopupHTML, attachAlertPopups } from '../web/js/operations-alert-map.js';
const geometry = { type: 'Polygon', coordinates: [[[26,47],[27,47],[27,48],[26,47]]] };
const admin = { features: [{ properties: { kind: 'uat', name: 'Botoșani' }, geometry }] };
const warning = (id, code, extra = {}) => ({ id, code, areas: ['Botoșani'], places: [], source: 'ANM', validFrom: '2026-10-19T06:00:00Z', validTo: '2026-10-19T12:00:00Z', ...extra });
test('same UAT combines simultaneous warnings with highest severity and retains archive times', () => {
  const data = buildAlertGeography({ alerts: [warning('a','yellow'),warning('b','red')] }, { admin });
  assert.equal(data.features.length,1);
  assert.equal(data.features[0].geometry,geometry);
  assert.equal(data.features[0].properties.code,'red');
  assert.equal(JSON.parse(data.features[0].properties.alerts).length,2);
  const html = alertPopupHTML(data.features, Date.parse('2026-10-20T00:00:00Z'));
  assert.match(html,/Cod galben/); assert.match(html,/Cod roșu/); assert.match(html,/Încheiat/); assert.match(html,/09:00/); assert.match(html,/15:00/);
});
test('the popup names a same-day interval\'s date once and labels each end on its own when one is missing', () => {
  const popup = extra => alertPopupHTML(buildAlertGeography({ alerts: [warning('a', 'yellow', extra)] }, { admin }).features);
  assert.match(popup({}), /<br>19\.10\.2026, 09:00 – 15:00<br>/);
  assert.match(popup({ validTo: '2026-10-20T06:00:00Z' }), /<br>19\.10\.2026, 09:00 – 20\.10\.2026, 09:00<br>/);
  assert.match(popup({ validTo: '' }), /<br>19\.10\.2026, 09:00 – neprecizat<br>/);
});
test('villages use exact names and finite coordinates, never prefix matches', () => {
  const data = buildAlertGeography({ alerts: [warning('a','orange',{ areas:[], places:['Agafton','Curte'] })] }, {localities:[{name:'Agafton',lon:26.5,lat:47.7},{name:'Curtești',lon:26.6,lat:47.7}]});
  assert.equal(data.features.length,1);
  assert.equal(data.features[0].properties.kind,'place');
  assert.equal(data.features[0].geometry.coordinates[0].length,49);
  assert.match(alertPopupHTML(data.features),/orientativă/);
});
test('same-named villages in different UATs get their own area and a legacy name joins its keyed village', () => {
  const localities = [{ name: 'Poiana', lon: 26.9, lat: 47.6, uat: 'Flămânzi' }, { name: 'Poiana', lon: 26.7, lat: 47.9, uat: 'Ștefănești' }];
  const data = buildAlertGeography({ alerts: [warning('a', 'yellow', { areas: [], places: ['Poiana|Ștefănești'] }), warning('b', 'red', { areas: [], places: ['Poiana|Flămânzi', 'Poiana'] })] }, { localities });
  assert.deepEqual(data.features.map(f => f.properties.name).sort(), ['Poiana (Flămânzi)', 'Poiana (Ștefănești)']);
  const stefanesti = data.features.find(f => f.properties.name === 'Poiana (Ștefănești)');
  assert.equal(stefanesti.properties.code, 'yellow');
  assert.ok(Math.abs(stefanesti.geometry.coordinates[0][0][1] - 47.9) < 0.02);
  assert.equal(JSON.parse(data.features.find(f => f.properties.name === 'Poiana (Flămânzi)').properties.alerts).length, 1);
});
test('overlapping polygons merge warnings without duplicate popup entries and escape stored text', () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const data = buildAlertGeography({ alerts:[warning('a','yellow',{source:malicious,text:'<script>bad()</script>',places:['Agafton']})] }, {admin,localities:[{name:'Agafton',lon:26.5,lat:47.7}]});
  const html=alertPopupHTML(data.features, Date.parse('2026-10-18T00:00:00Z'));
  assert.equal(html.match(/Cod galben/g).length,1);
  assert.match(html,/Urmează/); assert.match(html,/&lt;img/); assert.doesNotMatch(html,/<script>|<img/);
});
test('legacy event produces geometry while explicit cleared warnings produce none',()=>{
  assert.equal(buildAlertGeography({alert:{code:'orange'},areas:['Botoșani']},{admin}).features.length,1);
  assert.equal(buildAlertGeography({alerts:[],alert:{code:'orange'},areas:['Botoșani']},{admin}).features.length,0);
});
test('hover keeps one steady popup out of keyboard focus, lets the pointer enter it and respects drawing suppression', async () => {
  const handlers = new Map(), element = new EventTarget();
  let created = 0, added = 0, removed = 0, htmlSets = 0, moves = 0, enabled = true, options;
  const features = buildAlertGeography({ alerts: [warning('a', 'red')] }, { admin }).features;
  globalThis.maplibregl = { Popup: class {
    constructor(o) { options = o; created++; this.open = false; }
    on() { return this; }
    setLngLat() { moves++; return this; }
    setHTML(html) { assert.match(html, /Cod roșu/); assert.match(html, /data-code="red"/); assert.doesNotMatch(html, /style=/); htmlSets++; return this; }
    addTo() { added++; this.open = true; return this; }
    isOpen() { return this.open; }
    getElement() { return element; }
    remove() { removed++; this.open = false; return this; }
  } };
  const map = { on(type, layer, handler) { handlers.set(`${type}:${typeof layer === 'string' ? layer : ''}`, handler || layer); }, off() {}, queryRenderedFeatures() { return features; } };
  const dispose = attachAlertPopups(map, () => enabled);
  const fire = name => handlers.get(name)({ point: { x: 1, y: 1 }, lngLat: { lng: 26, lat: 47 } });
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let i = 0; i < 3; i++) fire('mousemove:ops-alert-fill');
  assert.equal(options.className, 'ops-alert-popup-wrap');
  assert.equal(options.focusAfterOpen, false, 'Hover must not move focus out of the editor');
  assert.deepEqual([created, added, htmlSets, moves], [1, 1, 1, 1], 'Same areas: no rebuild and no move');
  fire('click:ops-alert-fill');
  assert.equal(moves, 2, 'A tap places the popup where it happened');
  fire('mouseleave:ops-alert-fill'); element.dispatchEvent(new Event('mouseenter'));
  await wait(350); assert.equal(removed, 0, 'Entering the popup keeps it open');
  element.dispatchEvent(new Event('mouseleave'));
  await wait(350); assert.equal(removed, 1, 'Leaving the popup closes it');
  enabled = false; fire('mousemove:ops-alert-fill'); assert.equal(added, 1, 'No popup while another tool is active');
  dispose(); delete globalThis.maplibregl;
});
test('a village inside a UAT tinted at the same or higher code merges into it; a more severe village stays', () => {
  const localities = [{ name: 'Agafton', lon: 26.5, lat: 47.6, uat: 'Botoșani' }, { name: 'Curtești', lon: 26.6, lat: 47.7, uat: 'Botoșani' }];
  const data = buildAlertGeography({ alerts: [
    warning('uat', 'orange'),
    warning('village', 'yellow', { areas: [], places: ['Agafton|Botoșani'] }),
    warning('worse', 'red', { areas: [], places: ['Curtești|Botoșani'] }),
  ] }, { admin, localities });
  assert.deepEqual(data.features.map(f => [f.properties.kind, f.properties.name, f.properties.code]), [['uat', 'Botoșani', 'orange'], ['place', 'Curtești (Botoșani)', 'red']]);
  assert.deepEqual(JSON.parse(data.features[0].properties.alerts).map(a => a.id), ['uat', 'village'], 'The absorbed warning stays in the UAT popup');
});
test('the focus outline steps aside only where a code outline draws that same shape', () => {
  const agafton = { name: 'Agafton', lon: 26.5, lat: 47.6, uat: 'Botoșani' }, curtesti = { name: 'Curtești', lon: 26.6, lat: 47.7, uat: 'Botoșani' };
  const localities = [agafton, curtesti, { name: 'Poiana', lon: 26.9, lat: 47.6, uat: 'Flămânzi' }, { name: 'Poiana', lon: 26.7, lat: 47.9, uat: 'Ștefănești' }];
  const outlined = alerts => alertOutlined(buildAlertGeography({ alerts }, { admin, localities }));

  // One UAT warning and no village warning: the UAT has its outline, a focused village inside has none.
  let drawn = outlined([warning('uat', 'orange')]);
  assert.equal(drawn.uat('Botoșani'), true, 'The warned UAT keeps its code outline');
  assert.equal(drawn.uat('Dorohoi'), false, 'An unwarned UAT has none');
  assert.equal(drawn.place(agafton), false, 'A village in a warned UAT has no outline of its own, so its focus circle shows');

  // A village warned more severely than its UAT keeps its own feature; a milder one is merged into the UAT.
  drawn = outlined([warning('uat', 'orange'), warning('mild', 'yellow', { areas: [], places: ['Agafton|Botoșani'] }), warning('worse', 'red', { areas: [], places: ['Curtești|Botoșani'] })]);
  assert.equal(drawn.place(curtesti), true, 'A more severe village has its own outline');
  assert.equal(drawn.place(agafton), false, 'A village absorbed into the UAT outline keeps its focus circle');

  // Equal severity is absorbed as well, and a legacy plain name resolves to the same village key.
  drawn = outlined([warning('uat', 'orange'), warning('same', 'orange', { areas: [], places: ['Agafton|Botoșani'] })]);
  assert.equal(drawn.place(agafton), false);
  drawn = outlined([warning('legacy', 'red', { areas: [], places: ['Curtești'] })]);
  assert.equal(drawn.place(curtesti), true, 'A village warned alone is outlined, whichever way the warning names it');

  // Same-named villages: only the warned one is outlined.
  drawn = outlined([warning('poiana', 'red', { areas: [], places: ['Poiana|Ștefănești'] })]);
  assert.deepEqual([drawn.place(localities[2]), drawn.place(localities[3])], [false, true]);

  // Without warnings nothing is outlined.
  for (const none of [outlined([]), alertOutlined(null), alertOutlined({ features: [] })]) assert.deepEqual([none.uat('Botoșani'), none.place(agafton)], [false, false]);
});
test('label points sit inside concave UATs and carry the upper-case code label', () => {
  // A "C" shape: its bounding-box centre and vertex mean both fall in the empty bay.
  const c = { type: 'Polygon', coordinates: [[[26, 47], [27, 47], [27, 47.2], [26.2, 47.2], [26.2, 47.8], [27, 47.8], [27, 48], [26, 48], [26, 47]]] };
  const [x, y] = labelPoint(c);
  assert.ok(x > 26 && x < 26.2 && y > 47 && y < 48, `inside the spine, got ${x},${y}`);
  const concave = { features: [{ properties: { kind: 'uat', name: 'Cristinești' }, geometry: c }] };
  const labels = buildAlertLabels(buildAlertGeography({ alerts: [warning('a', 'red', { areas: ['Cristinești'] })] }, { admin: concave, localities: [{ name: 'Agafton', lon: 26.5, lat: 47.6 }] }));
  assert.equal(labels.features.length, 1);
  assert.deepEqual(labels.features[0].properties, { name: 'Cristinești', kind: 'uat', code: 'red', severity: 3, codeLabel: 'COD ROȘU' });
  assert.equal(labels.features[0].geometry.type, 'Point');
  const village = buildAlertLabels(buildAlertGeography({ alerts: [warning('b', 'yellow', { areas: [], places: ['Agafton'] })] }, { localities: [{ name: 'Agafton', lon: 26.5, lat: 47.6 }] })).features[0];
  assert.ok(Math.hypot(village.geometry.coordinates[0] - 26.5, village.geometry.coordinates[1] - 47.6) < 1e-6, 'Village label sits on the village');
  assert.equal(village.properties.codeLabel, 'COD GALBEN');
});

test('a warning on every UAT is one county band; milder areas under it draw nothing but keep their warnings', () => {
  const square = (x, y) => ({ type: 'Polygon', coordinates: [[[x, y], [x + 0.1, y], [x + 0.1, y + 0.1], [x, y + 0.1], [x, y]]] });
  const county = { type: 'Polygon', coordinates: [[[26, 47], [26.3, 47], [26.3, 47.1], [26, 47.1], [26, 47]]] };
  const names = ['Botoșani', 'Dorohoi', 'Săveni'];
  const countyAdmin = { features: [{ properties: { kind: 'judet', name: 'Botoșani' }, geometry: county },
    ...names.map((name, i) => ({ properties: { kind: 'uat', name }, geometry: square(26 + i * 0.1, 47) }))] };
  const data = buildAlertGeography({ alerts: [warning('all', 'orange', { areas: [...names].reverse() }), warning('red', 'red', { areas: ['Dorohoi'] }),
    warning('mild', 'yellow', { areas: ['Săveni'] })] }, { admin: countyAdmin });
  const by = Object.fromEntries(data.features.map(f => [f.properties.key, f.properties]));
  assert.deepEqual(data.features.map(f => f.properties.key), ['Săveni', 'county', 'Dorohoi']);
  assert.equal(data.features[1].geometry, county);
  assert.deepEqual([by.county.name, by.county.kind, by.county.code, JSON.parse(by.county.alerts).map(a => a.id)], ['Județul Botoșani', 'county', 'orange', ['all']]);
  assert.equal(by.Dorohoi.covered, undefined, 'a more severe UAT draws over the band');
  assert.equal(by['Săveni'].covered, true);
  assert.deepEqual(JSON.parse(by['Săveni'].alerts).map(a => a.id), ['mild'], 'its own warning stays for the popup');
  assert.deepEqual(buildAlertLabels(data).features.map(f => f.properties.name), ['Județul Botoșani', 'Dorohoi']);
  const outlined = alertOutlined(data);
  assert.equal(outlined.uat('Botoșani'), true, 'the band stands for every UAT, so no focus outline grid');
  const popup = alertPopupHTML(data.features.filter(f => ['county', 'Săveni'].includes(f.properties.key)));
  assert.match(popup, /Săveni · Județul Botoșani|Județul Botoșani · Săveni/);
  assert.ok(popup.indexOf('Cod portocaliu') < popup.indexOf('Cod galben'));
  const partial = buildAlertGeography({ alerts: [warning('two', 'orange', { areas: names.slice(0, 2) })] }, { admin: countyAdmin });
  assert.deepEqual(partial.features.map(f => f.properties.kind), ['uat', 'uat'], 'a warning that leaves out a UAT stays per UAT');
  const noCounty = buildAlertGeography({ alerts: [warning('all', 'orange', { areas: names })] }, { admin: { features: countyAdmin.features.slice(1) } });
  assert.equal(noCounty.features.length, 3, 'without the county shape the UATs are drawn one by one');
});
