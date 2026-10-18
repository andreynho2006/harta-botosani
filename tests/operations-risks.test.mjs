import test from 'node:test';
import assert from 'node:assert/strict';
import {presentationFeatures, presentationRiskGroups, presentationKindLabel} from '../web/js/operations-risks.js';
const features = ['fire','snow','flooded','threat','blocked','damaged','persons','houses','isu','route_primary'].flatMap(kind => ['confirmed','resolved'].map(status => ({properties:{kind,status}})));
test('fire presentation excludes winter and flood risks, including resolved records, but keeps support and road effects', () => {
 const shown=presentationFeatures(features,'fire');
 assert.deepEqual([...new Set(shown.map(f=>f.properties.kind))],['fire','blocked','damaged','persons','houses','isu','route_primary']);
 assert.ok(shown.some(f=>f.properties.status==='resolved'));
 assert.ok(presentationRiskGroups('fire').some(g=>g.kinds.includes('fire')));
 assert.ok(!presentationRiskGroups('fire').flatMap(g=>g.kinds).includes('snow'));
});
test('each event scopes active and resolved risks consistently; other events can show every risk',()=>{
 for (const [type,expected,excluded] of [['snow','snow','fire'],['flood','flooded','snow'],['storm','threat','fire']]) {
  assert.ok(presentationFeatures(features,type).some(f=>f.properties.kind===expected));
  assert.ok(!presentationFeatures(features,type).some(f=>f.properties.kind===excluded));
 }
 assert.equal(presentationFeatures(features,'other').length,features.length);
 assert.ok(presentationFeatures(features,'fire',true).every(f=>f.properties.status!=='resolved'));
 assert.equal(presentationKindLabel('houses','fire','Case înzăpezite'),'Gospodării afectate');
 assert.equal(presentationKindLabel('houses','snow','Case înzăpezite'),'Case înzăpezite');
});
