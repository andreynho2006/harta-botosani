import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWarningText, nameKey } from '../web/js/operations-alert-parse.js';
import { isoTime } from '../web/js/operations-time.js';
import { rivers, U } from './fixtures/synthetic-rivers.mjs';

const uats = ['Botoșani', 'Dorohoi', 'Broscăuți', 'Dersca', 'Lozna', 'Cristinești', 'Hilișeu-Horia', 'Mihăileni', 'Curtești', 'Vlădeni',
  'Ungureni', 'Darabani', 'Săveni', 'Ștefănești', 'Răchiți', 'Corni', 'Hudești', 'Flămânzi', 'Mihai Eminescu'];
const localities = [
  { name: 'Agafton', uat: 'Curtești' }, { name: 'Poiana', uat: 'Flămânzi' }, { name: 'Poiana', uat: 'Vlădeni' },
  { name: 'Liteni', uat: '' }, { name: 'Ipotești', uat: 'Mihai Eminescu' },
];
const now = new Date('2026-10-20T12:00:00+03:00');
const parse = (text, options = {}) => parseWarningText(text, { uats, localities, now, ...options });
const at = wall => isoTime(wall);

test('a nowcasting message gives its code, interval, phenomena and the UATs of its county list', () => {
  const [warning, ...rest] = parse(`AVERTIZARE NOWCASTING Nr. 735
Cod: GALBEN
Ora emiterii: 18:20
Valabil de la: 18:30 până la: 19:30
Zona: Județul Botoșani: Dorohoi, Broscăuți, Dersca, Lozna, Cristinești, Hilișeu Horia și Mihăileni;
Fenomene: Averse torențiale, descărcări electrice,
grindină de mici dimensiuni.`);
  assert.equal(rest.length, 0);
  assert.equal(warning.code, 'yellow');
  assert.equal(warning.source, 'ANM');
  assert.equal(warning.validFrom, at('2026-10-20T18:30'), 'The time of issue is not the start');
  assert.equal(warning.validTo, at('2026-10-20T19:30'));
  assert.deepEqual(warning.areas, ['Dorohoi', 'Broscăuți', 'Dersca', 'Lozna', 'Cristinești', 'Hilișeu-Horia', 'Mihăileni']);
  assert.equal(warning.text, 'Averse torențiale, descărcări electrice, grindină de mici dimensiuni.');
  assert.deepEqual([warning.unmatched, warning.ambiguous, warning.county], [[], [], false]);
});

test('another county\'s list is left out, abbreviations stay in the list and shared village names need their UAT', () => {
  const [warning] = parse(`Avertizare nowcasting nr. 12 – COD PORTOCALIU
Data emiterii: 20.10.2026 ora 14:15
Interval de valabilitate: 20.10.2026 ora 14:20 – 20.10.2026 ora 15:30
Zone afectate: Județul Suceava: Liteni, Dolhasca, Dorohoi; Județul Botoșani: mun. Botoșani, com. Curtești, Poiana, Poiana (Flămânzi), Agafton, Ipotești, Tâmpești.
Fenomene vizate: vijelie, grindină mare.`);
  assert.equal(warning.validFrom, at('2026-10-20T14:20'));
  assert.equal(warning.validTo, at('2026-10-20T15:30'));
  assert.deepEqual(warning.areas, ['Botoșani', 'Curtești'], 'Dorohoi in the Suceava list is not ours');
  assert.deepEqual(warning.places, ['Poiana|Flămânzi', 'Agafton|Curtești', 'Ipotești|Mihai Eminescu']);
  assert.deepEqual(warning.ambiguous, [{ name: 'Poiana', count: 2 }]);
  assert.deepEqual(warning.unmatched, ['Tâmpești'], 'Unknown names are reported as written');
});

test('a general warning keeps only the code that names the county, for the whole county', () => {
  const found = parse(`AVERTIZARE METEOROLOGICĂ
COD PORTOCALIU
Interval de valabilitate: 21 octombrie, ora 10 – 22 octombrie, ora 10
Fenomene vizate: intensificări ale vântului, viscol
Zone afectate: județele Suceava, Botoșani și zona de munte a județului Neamț

COD GALBEN
Interval de valabilitate: 21 octombrie, ora 10 – 22 octombrie, ora 22
Fenomene vizate: ninsori, polei
Zone afectate: Banat, Crișana și județele Iași, Vaslui`);
  assert.equal(found.length, 1);
  const [warning] = found;
  assert.equal(warning.code, 'orange');
  assert.equal(warning.county, true);
  assert.deepEqual(warning.areas, uats);
  assert.equal(warning.validFrom, at('2026-10-21T10:00'));
  assert.equal(warning.validTo, at('2026-10-22T10:00'));
  assert.equal(warning.text, 'intensificări ale vântului, viscol');
});

test('a title that names two codes stays with the first, and each heading opens its own warning', () => {
  const found = parse(`Avertizare cod portocaliu și cod galben de ploi
COD PORTOCALIU
Valabil de la 20.10.2026 ora 12 până la 21.10.2026 ora 12. Zona: Darabani, Săveni
COD GALBEN
Valabil de la 20.10.2026 ora 12 până la 21.10.2026 ora 18. Zona: Corni`);
  assert.deepEqual(found.map(warning => [warning.code, warning.areas.join()]), [['orange', 'Darabani,Săveni'], ['yellow', 'Corni']]);
  assert.equal(found[1].validTo, at('2026-10-21T18:00'));
});

test('an INHGA warning names rivers: the county is marked, but no UAT is chosen for it', () => {
  const [warning] = parse(`AVERTIZARE HIDROLOGICĂ
COD PORTOCALIU
Interval de valabilitate: 20.10 ora 12:00 – 21.10 ora 12:00
Fenomene: scurgeri importante pe versanți, viituri rapide pe râurile mici.
Zone afectate: râurile din bazinul hidrografic Prut – afluenții din județul Botoșani (Jijia, Sitna, Bașeu).`);
  assert.equal(warning.source, 'INHGA');
  assert.equal(warning.county, true);
  assert.deepEqual([warning.areas, warning.places], [[], []]);
  assert.equal(warning.validFrom, at('2026-10-20T12:00'));
  assert.equal(warning.validTo, at('2026-10-21T12:00'));
});

test('free text names UATs, but not "ISU Botoșani", and "până la" alone is the end of the interval', () => {
  const [warning] = parse('ISU Botoșani informează: cod galben de ceață până la ora 11:00, în localitățile Darabani, Săveni și Ștefănești.');
  assert.deepEqual(warning.areas, ['Darabani', 'Săveni', 'Ștefănești']);
  assert.equal(warning.validFrom, '');
  assert.equal(warning.validTo, at('2026-10-20T11:00'));
  assert.equal(warning.interval, 'partial');
});

test('a signature with "al județului Botoșani" is not the whole county; "județele Iași, Botoșani" is', () => {
  const signed = parse('Cod galben de vânt. Zona: Răchiți, Corni\nInspectoratul pentru Situații de Urgență al județului Botoșani');
  assert.deepEqual([signed[0].county, signed[0].areas], [false, ['Răchiți', 'Corni']]);
  const county = parse('Cod galben de vânt în județele Iași, Botoșani, până la ora 20.');
  assert.equal(county[0].county, true);
  assert.equal(county[0].areas.length, uats.length);
});

test('an end at an earlier hour on the same day is the next morning', () => {
  const [warning] = parse('Cod galben de ninsoare. Valabil de la ora 22:00 până la ora 06:00. Zona: Răchiți, Corni, Hudești');
  assert.equal(warning.validFrom, at('2026-10-20T22:00'));
  assert.equal(warning.validTo, at('2026-10-21T06:00'));
});

test('a message without a code gives nothing; RO-Alert is its own code', () => {
  assert.deepEqual(parse('Informare meteorologică: vreme deosebit de rece în Moldova.'), []);
  assert.deepEqual(parse('   '), []);
  const [alert] = parse('RO-ALERT: Inundații pe râul Jijia. Evitați zona Dorohoi.');
  assert.equal(alert.code, 'ro-alert');
  assert.equal(alert.source, 'IGSU');
});

test('a name within one letter matches a UAT of five letters or more, never a shorter one', () => {
  const [warning] = parse('Cod galben. Zona: Darabanii, Savenii, Corn, Dersc');
  assert.deepEqual(warning.areas, ['Darabani', 'Săveni', 'Dersca']);
  assert.deepEqual(warning.unmatched, ['Corn']);
});

test('a day and month without a year take the year closest to the paste', () => {
  const [warning] = parse('Cod galben. Interval de valabilitate: 31 decembrie, ora 20 – 1 ianuarie, ora 8. Zona: Corni', { now: new Date('2026-12-31T12:00:00+02:00') });
  assert.equal(warning.validFrom, at('2026-12-31T20:00'));
  assert.equal(warning.validTo, at('2027-01-01T08:00'));
});

test('a reversed interval keeps its start only, and a time the clock skips is not invented', () => {
  const [reversed] = parse('Cod galben. Valabil de la 21.10.2026 ora 10 până la 20.10.2026 ora 10. Zona: Corni');
  assert.deepEqual([reversed.validFrom, reversed.validTo, reversed.interval], [at('2026-10-21T10:00'), '', 'reversed']);
  const [skipped] = parse('Cod galben. Valabil de la 29.03.2026 ora 03:30 până la 29.03.2026 ora 08:00. Zona: Corni');
  assert.equal(skipped.validFrom, '', 'Spring clocks skip 03:30');
  assert.equal(skipped.validTo, at('2026-03-29T08:00'));
});

test('a message about other places only is still returned, with no zone to colour', () => {
  const [warning] = parse('COD GALBEN\nValabil de la 20.10.2026 ora 10 până la 20.10.2026 ora 20\nZone afectate: Banat, Crișana');
  assert.deepEqual([warning.code, warning.areas, warning.county], ['yellow', [], false]);
  assert.deepEqual(warning.unmatched, ['Banat', 'Crișana']);
});

test('a text over the field limit is cut and says so; names compare without diacritics or hyphens', () => {
  const [warning] = parse(`Cod roșu. Zona: Corni. ${'x'.repeat(6000)}`);
  assert.equal(warning.text.length, 5000);
  assert.equal(warning.textCut, true);
  assert.equal(nameKey('Hilişeu – Horia'), nameKey('Hilișeu-Horia'));
  assert.equal(nameKey('ŞTEFĂNEŞTI'), 'stefanesti');
});

test('labels and hours that wrapped to the next line keep their meaning', () => {
  const issued = parse('COD GALBEN\nData emiterii:\n20.10.2026 ora 09:00\nPână la ora 11:00\nZona: Corni');
  assert.deepEqual([issued[0].validFrom, issued[0].validTo], ['', at('2026-10-20T11:00')], 'A wrapped time of issue is still not the start');
  const until = parse('COD GALBEN\nValabil până la:\n20.10.2026 ora 11:00\nZona: Corni');
  assert.deepEqual([until[0].validFrom, until[0].validTo], ['', at('2026-10-20T11:00')]);
  const hour = parse('COD GALBEN\nValabil de la: 20.10.2026\nora 18:00 până la ora 20:00\nZona: Corni');
  assert.deepEqual([hour[0].validFrom, hour[0].validTo], [at('2026-10-20T18:00'), at('2026-10-20T20:00')]);
  const count = parse('COD GALBEN\nValabil până la ora\n20 de localități afectate\nZona: Corni');
  assert.deepEqual([count[0].validFrom, count[0].validTo], ['', ''], 'A count on the next line is not an hour');
});

test('a list that wraps after a comma or "și" goes on to the next line', () => {
  assert.deepEqual(parse('COD GALBEN\nJudețul Botoșani: Dorohoi,\nCurtești și\nCorni;\nFenomene: vijelie')[0].areas, ['Dorohoi', 'Curtești', 'Corni']);
  const found = parse('COD GALBEN\nZone afectate: județele Suceava,\nBotoșani\nCOD PORTOCALIU\nZona: Corni');
  assert.deepEqual(found.map(warning => [warning.code, warning.county]), [['yellow', true], ['orange', false]]);
});

test('two codes on one line are two warnings, and a shared interval reaches each', () => {
  const inline = parse('COD GALBEN: Județul Botoșani: Corni; COD PORTOCALIU: Județul Botoșani: Dorohoi;');
  assert.deepEqual(inline.map(warning => [warning.code, warning.areas.join()]), [['yellow', 'Corni'], ['orange', 'Dorohoi']]);
  const shared = parse('ANM\nInterval de valabilitate: 20.10.2026 ora 10 – 21.10.2026 ora 10\nCOD GALBEN\nZona: Corni\nCOD PORTOCALIU\nZona: Dorohoi');
  assert.deepEqual(shared.map(warning => [warning.validFrom, warning.validTo]), [[at('2026-10-20T10:00'), at('2026-10-21T10:00')], [at('2026-10-20T10:00'), at('2026-10-21T10:00')]]);
});

test('another county named in brackets, or a signature, never selects a UAT of ours', () => {
  const [qualified] = parse('COD GALBEN\nZona: Corni (județul Suceava), Dorohoi');
  assert.deepEqual([qualified.areas, qualified.unmatched], [['Dorohoi'], ['Corni (județul Suceava)']]);
  assert.deepEqual(parse('COD GALBEN\nFenomene: vijelie\nISU „Nicolae Iorga” Botoșani')[0].areas, []);
});

// The river cases use an invented index and invented UATs: `with` parses like `parse`, with the rivers loaded.
const withRivers = (text, options = {}) => parse(text, { uats: U, rivers, ...options });
const INHGA_2025 = `AVERTIZARE HIDROLOGICĂ
BAZINELE HIDROGRAFICE VIZATE: Vişeu, Iza, Siret şi Jijia.
COD GALBEN: În intervalul 27.06.2025 ora 12:00 – 28.06.2025 ora 12:00 pe râurile din bazinele hidrografice: Jijia – bazin superior şi afluenţi bazin mijlociu şi inferior (judeţele: Botoşani şi Iaşi), Siret – afluenţii mici aferenţi sectorului aval confluenţă cu râul Suceava (judeţele: Suceava, Botoşani, Neamţ, Iaşi, Bacău, Vrancea şi Galaţi)`;

test('with the river list, an INHGA warning takes the UATs along the rivers it names instead of marking the county', () => {
  const [warning, ...rest] = withRivers(INHGA_2025);
  assert.equal(rest.length, 0);
  assert.equal(warning.source, 'INHGA');
  assert.equal(warning.validFrom, at('2025-06-27T12:00'));
  assert.equal(warning.validTo, at('2025-06-28T12:00'));
  assert.deepEqual(warning.areas, ['U2', 'U5', 'U9', 'U10', 'U11', 'U12', 'U13', 'U14']);
  assert.deepEqual([warning.places, warning.unmatched, warning.ambiguous, warning.county], [[], [], [], false]);
  assert.deepEqual(warning.rivers.map(river => [river.name, river.scope, river.sector]), [['Jijia', 'basin', false], ['Siret', 'tributaries', true]]);
  assert.deepEqual([warning.smallRivers, warning.riverAmbiguous], [false, []]);
});

test('without the river list an INHGA warning reads as before, and the rivers fields are empty', () => {
  const text = `AVERTIZARE HIDROLOGICĂ
COD PORTOCALIU
Interval de valabilitate: 20.10 ora 12:00 – 21.10 ora 12:00
Zone afectate: râurile din bazinul hidrografic Prut – afluenții din județul Botoșani (Jijia, Sitna, Bașeu).`;
  const [plain] = parse(text);
  assert.deepEqual([plain.county, plain.areas, plain.rivers, plain.smallRivers, plain.riverAmbiguous], [true, [], [], false, []]);
  const [loaded] = withRivers(text);
  assert.deepEqual([loaded.county, loaded.rivers.map(river => `${river.name} ${river.scope}`)],
    [false, ['Prut tributaries', 'Jijia basin', 'Sitna basin', 'Bașeu basin']]);
  assert.equal(loaded.areas.length, 14, 'The Prut\'s tributaries reach every UAT of the index');
});

test('a text pasted without the INHGA title is told by its "bazinele hidrografice", and a river text of another source is not read', () => {
  const text = 'Cod galben. Pe râurile din bazinele hidrografice Başeu şi Volovăţ din judeţul Botoşani';
  const [found] = withRivers(text);
  assert.equal(found.source, 'INHGA');
  assert.deepEqual([found.areas, found.rivers.map(river => river.name)], [['U3', 'U4', 'U5', 'U6'], ['Bașeu', 'Volovăț']]);
  assert.equal(parse(text)[0].source, 'INHGA', 'Also without the river list');
  const [anm] = withRivers('Cod galben nowcasting ANM. Zona: Jijia (județul Botoșani)');
  assert.deepEqual([anm.source, anm.rivers, anm.county], ['ANM', [], true], 'An ANM warning for the county is still every UAT');
});

test('a section whose rivers are all in other counties does not concern ours, unless no section does', () => {
  const found = withRivers(`COD GALBEN
Valabil de la 20.10.2026 ora 10 până la 21.10.2026 ora 10
Pe râurile din bazinele hidrografice: Prut – afluenţii aferenţi sectorului aval confluenţă cu râul Jijia (judeţele: Iaşi, Vaslui şi Galaţi)
COD PORTOCALIU
Valabil de la 20.10.2026 ora 10 până la 21.10.2026 ora 10
Pe râurile din bazinele hidrografice: Jijia (judeţele: Botoşani şi Iaşi)`);
  assert.deepEqual(found.map(warning => [warning.code, warning.areas.length]), [['orange', 7]]);
  const [alone] = withRivers('COD GALBEN\nPe râurile din bazinele hidrografice: Prut – afluenţii aferenţi sectorului aval confluenţă cu râul Jijia (judeţele: Iaşi, Vaslui şi Galaţi)');
  assert.deepEqual([alone.code, alone.areas, alone.rivers, alone.county], ['yellow', [], [], false], 'Every section comes back when none concerns the county');
  const every = withRivers('COD GALBEN\nPrut – afluenţii mici (judeţele: Iaşi şi Vaslui)\nCOD ROŞU\nJijia (judeţele: Botoşani şi Iaşi)', { all: true });
  assert.equal(every.length, 2, '`all` asks for every section');
});

test('"unele râuri mici" make a section concern the county, and a name of several courses is reported by name', () => {
  const found = withRivers(`Avertizare hidrologică
COD GALBEN: pe unele râuri mici din judeţele: Prahova, Suceava şi Botoşani
COD PORTOCALIU: Prut – afluenţii mici (judeţele: Iaşi şi Vaslui)`);
  assert.deepEqual(found.map(warning => [warning.code, warning.smallRivers, warning.rivers.length, warning.areas.length]), [['yellow', true, 0, 0]]);
  const [clash] = withRivers('Cod galben. Pe râurile din bazinele hidrografice: Valea Mare – bazin (județul Botoșani), Miletin (județul Botoșani)');
  assert.deepEqual([clash.riverAmbiguous, clash.ambiguous, clash.rivers.map(river => river.name)], [['Valea Mare'], [], ['Miletin']]);
});

test('a national bulletin pasted from a PDF: wrapped entries, its title and addressees skipped, one warning per code', () => {
  const found = withRivers(`AVERTIZARE HIDROLOGICĂ NR. 35 DIN 02.04.2026
Către: Ministerul Mediului, Apelor şi Pădurilor, S.C. Hidroelectrica S.A., Administraţiile Bazinale de Apă: Jiu,
Olt, Siret şi Prut-Bârlad.

BAZINELE HIDROGRAFICE VIZATE:

Prut, Siret, Jijia.

MOMENTUL PRODUCERII FENOMENELOR VIZATE:
Data: 02.04.2026 ora 18:00 – 04.04.2026 ora 23:00

COD GALBEN

În intervalul 02.04.2026 ora 18:00 – 04.04.2026 ora 23:00 pe râurile din bazinele hidrografice: Jijia – bazin superior şi afluenţi
bazin mijlociu şi inferior (judeţele: Botoşani şi Iaşi), Siret – afluenţii mici aferenţi sectorului aval confluenţă cu râul Suceava –
amonte confluenţă cu râul Bahna (judeţele: Suceava, Botoşani, Neamţ şi
Iaşi), Prut – afluenţii de dreapta aferenţi sectorului aval confluenţă cu râul
Vorona (judeţele: Botoşani şi Iaşi).

COD PORTOCALIU

În intervalul 03.04.2026 ora 09:00 – 04.04.2026 ora 12:00 pe râurile din bazinele hidrografice: Siret – afluenţii aferenţi sectorului aval S.H. Dorna – amonte confluenţă cu râul Bahna (judeţele: Suceava şi Neamţ), Miletin (afluent al râului
Jijia) - judeţele: Botoşani şi Iaşi.

Harta cu codurile se anexează.

Se menţionează că fenomenele hidrologice potenţial periculoase prognozate se pot produce şi pe afluenţi de grad inferior ai râurilor marcate pe hartă, precum şi pe cursurile de apă necadastrate, în bazinele hidrografice vizate, conform textului mesajului.`, { now: new Date('2026-04-02T12:00:00+03:00') });
  assert.deepEqual(found.map(warning => [warning.code, warning.source, warning.county]), [['yellow', 'INHGA', false], ['orange', 'INHGA', false]]);
  assert.deepEqual(found[0].rivers.map(river => [river.name, river.scope, river.sector, river.after, river.before]),
    [['Jijia', 'basin', false, undefined, undefined], ['Siret', 'tributaries', true, undefined, 'Bahna'], ['Prut', 'tributaries', true, 'Vorona', undefined]]);
  assert.deepEqual(found[0].areas, ['U1', 'U2', 'U3', 'U8', 'U9', 'U10', 'U11', 'U12', 'U13', 'U14']);
  assert.deepEqual(found[1].rivers.map(river => [river.name, river.scope]), [['Miletin', 'basin']], 'Siret is for Suceava and Neamț, Jijia only places Miletin');
  assert.deepEqual([found[1].validFrom, found[1].validTo], [at('2026-04-03T09:00'), at('2026-04-04T12:00')]);
});
