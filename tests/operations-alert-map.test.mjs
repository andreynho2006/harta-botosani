import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAlertGeography, alertPopupHTML, attachAlertPopups } from '../web/js/operations-alert-map.js';
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
  globalThis.maplibregl={Popup:class {setLngLat(){return this;} setHTML(html){assert.match(html,/Cod roșu/);return this;} addTo(){shown++;return this;} remove(){removed++;}}};
  const map={on(type,layer,handler){handlers.set(`${type}:${typeof layer==='string'?layer:''}`,handler||layer);},off(){},queryRenderedFeatures(){return features;}};
  const dispose=attachAlertPopups(map,()=>enabled), event={point:{x:1,y:1},lngLat:{lng:26,lat:47}};
  handlers.get('mousemove:ops-alert-fill')(event); handlers.get('click:ops-alert-fill')(event);
  assert.equal(shown,2); enabled=false; handlers.get('mousemove:ops-alert-fill')(event); assert.equal(shown,2); assert.equal(removed,1); dispose(); delete globalThis.maplibregl;
});
