import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAlertGeography, buildAlertLabels, labelPoint, alertPopupHTML, attachAlertPopups } from '../web/js/operations-alert-map.js';
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
test('hover/tap handlers query all overlapping areas and respect drawing suppression',()=>{
  const handlers=new Map(); let shown=0, removed=0, enabled=true;
  const features=buildAlertGeography({alerts:[warning('a','red')]},{admin}).features;
  globalThis.maplibregl={Popup:class {constructor(options){assert.equal(options.className,'ops-alert-popup-wrap');} setLngLat(){return this;} setHTML(html){assert.match(html,/Cod roșu/);assert.match(html,/data-code="red"/);assert.doesNotMatch(html,/style=/);return this;} addTo(){shown++;return this;} remove(){removed++;}}};
  const map={on(type,layer,handler){handlers.set(`${type}:${typeof layer==='string'?layer:''}`,handler||layer);},off(){},queryRenderedFeatures(){return features;}};
  const dispose=attachAlertPopups(map,()=>enabled), event={point:{x:1,y:1},lngLat:{lng:26,lat:47}};
  handlers.get('mousemove:ops-alert-fill')(event); handlers.get('click:ops-alert-fill')(event);
  assert.equal(shown,2); enabled=false; handlers.get('mousemove:ops-alert-fill')(event); assert.equal(shown,2); assert.equal(removed,1); dispose(); delete globalThis.maplibregl;
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
