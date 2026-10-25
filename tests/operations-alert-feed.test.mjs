import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { anmTimes, anmWarnings, readNowcasting, readGeneral, htmlText, fetchAnmFeeds, ANM_FEEDS } from '../web/js/operations-alert-feed.js';
import { readZone } from '../web/js/operations-alert-parse.js';
import { isoTime } from '../web/js/operations-time.js';

const uats = ['Botoșani', 'Dorohoi', 'Broscăuți', 'Dersca', 'Hilișeu-Horia', 'Mihăileni', 'Manoleasa', 'Săveni', 'Mihălășeni', 'Flămânzi', 'Vlădeni'];
const localities = [
  { name: 'Liveni', uat: 'Manoleasa' }, { name: 'Poiana', uat: 'Flămânzi' }, { name: 'Poiana', uat: 'Vlădeni' },
];
const at = wall => isoTime(wall);
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const nowcast = attrs => ({ avertizare: [{ '@attributes': { tipMesaj: '1', numeTipMesaj: 'Avertizare nowcasting', culoare: '1', numeCuloare: 'portocaliu', ...attrs } }] });

test('ANM pads hours 1–9 on the right: "T50:00" is 05:00, and "T10" / "T20" have two readings', () => {
  assert.deepEqual(anmTimes('2024-12-08T50:00'), [at('2024-12-08T05:00')]);
  assert.deepEqual(anmTimes('2024-12-08T70:50'), [at('2024-12-08T07:50')]);
  assert.deepEqual(anmTimes('2024-12-08T10:30'), [at('2024-12-08T01:30'), at('2024-12-08T10:30')]);
  assert.deepEqual(anmTimes('2024-12-08T20:00'), [at('2024-12-08T02:00'), at('2024-12-08T20:00')]);
  assert.deepEqual(anmTimes('2024-12-08T00:55'), [at('2024-12-08T00:55')]);
  assert.deepEqual(anmTimes('2024-12-08T17:00'), [at('2024-12-08T17:00')]);
  assert.deepEqual(anmTimes('2024-12-08T24:00'), []);
  assert.deepEqual(anmTimes(''), []);
});

test('a nowcasting for the county gives its UATs, villages, code and a repaired interval', () => {
  const [warning, ...rest] = readNowcasting(nowcast({
    dataInceput: '2026-07-14T90:40', dataSfarsit: '2026-07-14T10:30', creat: '2026-07-14 09:32:01', modificat: '2026-07-14 09:32:01',
    zona: 'Județul Suceava: Liteni, Dolhasca;<br>Județul Botoșani: Dorohoi, Broscăuți, Dersca, Liveni, Hilișeu Horia, Poiana, Mihăileni;<br>',
    semnalare: 'Averse torențiale, grindină &#351;i vijelie.',
  }), { uats, localities });
  assert.equal(rest.length, 0);
  assert.equal(warning.code, 'orange');
  assert.equal(warning.source, 'ANM nowcasting');
  assert.equal(warning.validFrom, at('2026-07-14T09:40'));
  assert.equal(warning.validTo, at('2026-07-14T10:30'), 'The end is the first reading after the start, not 01:30');
  assert.equal(warning.interval, '');
  assert.deepEqual(warning.areas, ['Dorohoi', 'Broscăuți', 'Dersca', 'Hilișeu-Horia', 'Mihăileni']);
  assert.deepEqual(warning.places, ['Liveni|Manoleasa']);
  assert.deepEqual(warning.ambiguous, [{ name: 'Poiana', count: 2 }]);
  assert.equal(warning.text, 'Averse torențiale, grindină şi vijelie.');
  assert.match(warning.id, /^anm-nc-20260714093201-orange-[a-z0-9]+$/);
  assert.ok(warning.id.startsWith(`${warning.key}-`));
});

test('the start is the reading nearest the time of issue; "T20" after 19:50 ends at 20:00', () => {
  const [late] = readNowcasting(nowcast({ dataInceput: '2026-07-14T19:50', dataSfarsit: '2026-07-14T20:00', creat: '2026-07-14 19:41:01', zona: 'Județul Botoșani: Săveni;' }), { uats });
  assert.equal(late.validFrom, at('2026-07-14T19:50'));
  assert.equal(late.validTo, at('2026-07-14T20:00'));
  const [night] = readNowcasting(nowcast({ dataInceput: '2026-07-14T10:00', dataSfarsit: '2026-07-14T30:00', creat: '2026-07-14 00:52:01', zona: 'Județul Botoșani: Săveni;' }), { uats });
  assert.equal(night.validFrom, at('2026-07-14T01:00'), 'Issued at 00:52, "T10:00" starts at 01:00');
  assert.equal(night.validTo, at('2026-07-14T03:00'));
  const [reversed] = readNowcasting(nowcast({ dataInceput: '2026-07-14T17:00', dataSfarsit: '2026-07-14T16:00', creat: '2026-07-14 16:50:01', zona: 'Județul Botoșani: Săveni;' }), { uats });
  assert.equal(reversed.validTo, '');
  assert.equal(reversed.interval, 'reversed');
});

test('a whole-county nowcasting takes every UAT; ANM\'s "zona localităților" list is read too', () => {
  const archived = readNowcasting(fixture('anm-nowcasting-20191214.json'), { uats, localities });
  assert.equal(archived.length, 1, 'Only the warning whose zone names the county');
  assert.equal(archived[0].county, true);
  assert.deepEqual(archived[0].areas, uats);
  assert.equal(archived[0].validFrom, at('2019-12-14T07:10'));
  assert.equal(archived[0].validTo, at('2019-12-14T10:00'));
  const [plain] = readNowcasting(nowcast({ dataInceput: '2026-07-14T19:50', dataSfarsit: '2026-07-14T21:00', creat: '2026-07-14 19:41:01',
    zona: 'Zona de câmpie a județului Botoșani, respectiv zona localităților: Săveni, Mihălășeni;<br>', semnalare: 'Ceață.' }), { uats });
  assert.deepEqual(plain.areas, ['Săveni', 'Mihălășeni']);
  assert.equal(plain.text, 'Ceață.');
  // A zone the reader cannot place keeps its text in the warning, for the operator to pick on the map.
  const [unknown] = readNowcasting(nowcast({ dataInceput: '2026-07-14T19:50', dataSfarsit: '2026-07-14T21:00', creat: '2026-07-14 19:41:01',
    zona: 'Nordul județului Botoșani;', semnalare: 'Ceață.' }), { uats });
  assert.deepEqual([unknown.areas, unknown.places], [[], []]);
  assert.equal(unknown.text, 'Ceață.\nZona (ANM): Nordul județului Botoșani;');
});

test('the same warning read twice has the same id; a change ANM makes gives a new id under the same key', () => {
  const attrs = { dataInceput: '2026-07-14T90:40', dataSfarsit: '2026-07-14T10:30', creat: '2026-07-14 09:32:01', zona: 'Județul Botoșani: Dorohoi;', semnalare: 'Vijelie.' };
  const [first] = readNowcasting(nowcast(attrs), { uats });
  const [again] = readNowcasting(nowcast(attrs), { uats });
  const [extended] = readNowcasting(nowcast({ ...attrs, dataSfarsit: '2026-07-14T11:30' }), { uats });
  assert.equal(again.id, first.id);
  assert.notEqual(extended.id, first.id);
  assert.equal(extended.key, first.key);
});

test('general warnings colour the whole county with its own code and take the interval of that code\'s section', () => {
  // Read long after: the year of "28 mai" comes from the day the message appeared, not from today.
  const found = readGeneral(fixture('anm-generale-20250528.json'), { uats, now: new Date('2026-10-25T12:00:00+03:00') });
  assert.deepEqual(found.map(warning => warning.code), ['orange', 'yellow', 'yellow'], 'BT is orange in the first message, yellow in the others');
  const [orange, wind, storms] = found;
  assert.equal(orange.source, 'ANM');
  assert.equal(orange.county, true);
  assert.deepEqual(orange.areas, uats);
  assert.equal(orange.validFrom, at('2025-05-28T10:00'));
  assert.equal(orange.validTo, at('2025-05-29T03:00'), '"T30:00" in the feed is 03:00');
  assert.equal(orange.text, 'ploi importante cantitativ', 'The orange section\'s phenomena, not the yellow one\'s');
  assert.equal(wind.text, 'intensificări ale vântului');
  assert.equal(storms.validFrom, at('2025-05-29T03:00'), 'The message appeared at 10:00 on the 28th but is valid from 03:00 on the 29th');
  assert.equal(storms.validTo, at('2025-05-29T23:00'));
  assert.equal(new Set(found.map(warning => warning.id)).size, 3, 'Two messages issued together keep apart');
});

test('a general warning on a zone of the county only takes no UAT; an uncoloured county none at all', () => {
  const message = (judet, zona) => ({ avertizare: { '@attributes': { tipMesaj: '1', culoare: '0', numeCuloare: 'galben', dataAparitiei: '2026-01-10T10:00', dataExpirarii: '2026-01-11T90:00',
    intervalul: '10 ianuarie, ora 12 – 11 ianuarie, ora 09', fenomeneVizate: 'polei;', mesaj: '' }, judet: { '@attributes': judet }, zona: zona && { '@attributes': zona } } });
  const options = { uats, now: new Date('2026-12-30T11:00:00+02:00') };
  const [part] = readGeneral(message({ cod: 'BT', culoare: '0' }, { cod: 'BT_nord', culoare: '1' }), options);
  assert.equal(part.code, 'yellow');
  assert.deepEqual(part.areas, []);
  assert.deepEqual(part.zoneOnly, ['BT_nord']);
  assert.equal(part.validFrom, at('2026-01-10T12:00'), 'From the message\'s own interval');
  assert.equal(part.validTo, at('2026-01-11T09:00'));
  assert.equal(part.text, 'polei');
  assert.deepEqual(readGeneral(message({ cod: 'BT', culoare: '0' }), options), []);
  // Sections that name regions, not counties: the county's code picks its section.
  const section = (code, interval, phenomena, region) => `<p>COD ${code}</p><p>Interval de valabilitate: ${interval}</p><p>Fenomene vizate: ${phenomena}</p>`
    + `<p>Zone afectate: conform textului și hărții</p><p>${region} se va forma ${phenomena}.</p>`;
  const mesaj = section('GALBEN', '10 ianuarie, ora 12 – 10 ianuarie, ora 20', 'ceață', 'În Banat')
    + section('PORTOCALIU', '10 ianuarie, ora 14 – 11 ianuarie, ora 06', 'polei', 'În Moldova');
  const regional = message({ cod: 'BT', culoare: '2' });
  Object.assign(regional.avertizare['@attributes'], { mesaj, intervalul: 'conform textelor', fenomeneVizate: 'conform textelor' });
  const [orange] = readGeneral(regional, options);
  assert.equal(orange.code, 'orange');
  assert.equal(orange.text, 'polei');
  assert.equal(orange.validFrom, at('2026-01-10T14:00'));
  assert.equal(orange.validTo, at('2026-01-11T06:00'));
  assert.deepEqual(readGeneral(message({ cod: 'SV', culoare: '2' }), options), []);
});

test('an empty feed is the string "Nu exista date"; HTML entities and breaks become text', () => {
  assert.deepEqual(anmWarnings({ nowcasting: 'Nu exista date', general: 'Nu exista date' }, { uats }), []);
  assert.deepEqual(anmWarnings({ nowcasting: null, general: undefined }, { uats }), []);
  assert.equal(htmlText('<p>Vânt&nbsp;puternic&#8230;<br/>ora 10 &ndash; ora 12</p><p>&amp; &#xFFFFFFF; &bogus;</p>'), 'Vânt puternic…\nora 10 – ora 12\n& &#xFFFFFFF; &bogus;');
});

test('the feeds are read past the site cache; one that fails leaves the other usable', async () => {
  const asked = [];
  const fetchImpl = async (url, options) => {
    asked.push({ url, cache: options.cache });
    if (url.startsWith(ANM_FEEDS.general)) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ avertizare: [] }) };
  };
  const feeds = await fetchAnmFeeds({ fetchImpl, now: 1234 });
  assert.deepEqual(asked.map(item => item.url), [`${ANM_FEEDS.nowcasting}?_=1234`, `${ANM_FEEDS.general}?_=1234`]);
  assert.ok(asked.every(item => item.cache === 'no-store'));
  assert.deepEqual(feeds.nowcasting, { avertizare: [] });
  assert.equal(feeds.general, null);
  assert.deepEqual(feeds.errors, { general: 'HTTP 503' });
});

test('a zone of another county named in passing is not read as ours', () => {
  const zone = readZone('Zona continentală a județului Constanța, respectiv zona localităților: Săveni, Dorohoi;', { uats });
  assert.equal(zone.concerns, false);
  assert.deepEqual(zone.areas, []);
});

// Found by the review of the import, each against the first version of the reader.
test('each zone clause names its own county: ours is read, the neighbour\'s skipped', () => {
  const zone = readZone('Zona de câmpie a județului Botoșani, respectiv zona localităților: Săveni;\nZona de câmpie a județului Suceava, respectiv zona localităților: Corni;', { uats: ['Săveni', 'Corni'] });
  assert.deepEqual(zone.areas, ['Săveni']);
});

test('a zone of the county under a more severe code than the county is a warning of its own', () => {
  const found = readGeneral({ avertizare: { '@attributes': {}, judet: { cod: 'BT', culoare: 1 }, zona: { cod: 'BT_nord', culoare: 2 } } }, { uats: ['Dorohoi'] });
  assert.deepEqual(found.map(warning => [warning.code, warning.areas, warning.zoneOnly]), [['yellow', ['Dorohoi'], []], ['orange', [], ['BT_nord']]]);
  assert.notEqual(found[0].id, found[1].id);
});

test('the county\'s code finds its section even when another section names the county', () => {
  const section = (code, interval, zone) => `COD ${code}\nInterval de valabilitate: ${interval}\nFenomene vizate: polei\nZone afectate: ${zone}\n`;
  const mesaj = section('GALBEN', '10 ianuarie, ora 12 – 11 ianuarie, ora 09', 'județul Botoșani') + section('PORTOCALIU', '10 ianuarie, ora 14 – 10 ianuarie, ora 20', 'nordul Moldovei');
  const attrs = { dataAparitiei: '2026-01-10T10:00', dataExpirarii: '2026-01-11T90:00', intervalul: 'conform textelor', fenomeneVizate: 'conform textelor', mesaj };
  const [orange] = readGeneral({ avertizare: { '@attributes': attrs, judet: { cod: 'BT', culoare: 2 } } });
  assert.deepEqual([orange.validFrom, orange.validTo, orange.text], [at('2026-01-10T14:00'), at('2026-01-10T20:00'), 'polei']);
  // Without a section or interval for the code, the time the message appeared is not its start.
  const [bare] = readGeneral({ avertizare: { '@attributes': { ...attrs, mesaj: '' }, judet: { cod: 'BT', culoare: 2 } } });
  assert.deepEqual([bare.validFrom, bare.validTo, bare.interval], ['', at('2026-01-11T09:00'), 'partial']);
});

test('an interval across the autumn clock change keeps the repeated hour as its end', () => {
  const [warning] = readNowcasting({ avertizare: { '@attributes': { culoare: 0, creat: '2026-10-25 03:40:01', dataInceput: '2026-10-25T30:50', dataSfarsit: '2026-10-25T30:10', zona: 'Județul Botoșani: Dorohoi;' } } }, { uats: ['Dorohoi'] });
  assert.equal(warning.validFrom, '2026-10-25T00:50:00.000Z');
  assert.equal(warning.validTo, '2026-10-25T01:10:00.000Z', '03:10 after the clocks went back');
  assert.equal(warning.interval, '');
  assert.deepEqual(anmTimes('2026-10-25T30:10'), ['2026-10-25T00:10:00.000Z', '2026-10-25T01:10:00.000Z']);
});

test('an answer that is neither warnings nor "Nu exista date" is a failed feed, not an empty one', async () => {
  for (const value of [null, 42, '<html>error</html>', { code: 'rest_error' }]) {
    const feeds = await fetchAnmFeeds({ fetchImpl: async () => ({ ok: true, json: async () => value }) });
    assert.deepEqual(feeds.errors, { nowcasting: 'răspuns neașteptat', general: 'răspuns neașteptat' }, JSON.stringify(value));
  }
  const empty = await fetchAnmFeeds({ fetchImpl: async () => ({ ok: true, json: async () => 'Nu exista date' }) });
  assert.deepEqual(empty.errors, {});
});
