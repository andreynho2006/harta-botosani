import assert from 'node:assert/strict';
import test from 'node:test';
import { readRivers, riverIndex } from '../web/js/operations-rivers.js';
import { rivers, U } from './fixtures/synthetic-rivers.mjs';

// Synthetic rivers only: the codes follow the cadastre's scheme, the UATs are invented.
const read = (text, uats = U) => readRivers(text, rivers, { uats });
const head = 'COD GALBEN: În intervalul 27.06.2025 ora 12:00 – 28.06.2025 ora 12:00 pe râurile din bazinele hidrografice: ';
const summary = result => result.rivers.map(river => [river.name, river.scope, river.sector, river.uats.join()].join(' '));
const JIJIA = 'U2,U9,U10,U11,U12,U13,U14';

test('the index keys a course by its name, its alternative names and the ABA name without brackets, once per list', () => {
  const index = riverIndex(rivers);
  assert.equal(index, riverIndex(rivers), 'Built once for a list');
  assert.equal(index.names.get('sihna'), index.names.get('sitna'));
  assert.equal(index.names.get('volovat').code, 'RO_XIII_1.8');
  const aba = [{ name: 'Sărata', aba: 'SARATA(BOROLEA)', alt: ['Borolea'], code: 'RO_Y_1.3', uats: ['U1'] }, { name: 'Zimbru', aba: 'ZIMBRUL (ZIM)', alt: [], code: 'RO_Y_1.4', uats: ['U2'] }];
  assert.deepEqual(readRivers('Borolea (județul Botoșani)', aba, { uats: ['U1'] }).areas, ['U1']);
  assert.deepEqual(readRivers('Sărata (județul Botoșani)', aba, { uats: ['U1'] }).areas, ['U1']);
  assert.deepEqual(readRivers('Zimbrul (județul Botoșani)', aba, { uats: ['U2'] }).areas, ['U2'], 'The ABA name stands without its brackets');
});

test('a name shared by courses is ambiguous unless one is the outlet of the others, which then stands for it', () => {
  const index = riverIndex(rivers);
  assert.equal(index.names.has('valea mare'), false);
  assert.equal(index.clashes.get('valea mare'), 'Valea Mare');
  const nested = [{ name: 'Șoimu', alt: [], code: 'RO_Y_1.3', uats: ['U1'] }, { name: 'Soimu', alt: [], code: 'RO_Y_1.3.2', uats: ['U2'] }, { name: 'Alt', alt: ['Soimu'], code: 'RO_Y_1.7', uats: ['U3'] }];
  assert.equal(riverIndex(nested).clashes.has('soimu'), true, 'Courses that are not each other\'s outlet clash');
  const chain = nested.slice(0, 2);
  assert.equal(riverIndex(chain).names.get('soimu').code, 'RO_Y_1.3');
  assert.deepEqual(readRivers('Șoimu – bazin (județul Botoșani)', chain, { uats: ['U1', 'U2'] }).areas, ['U1', 'U2']);
});

test('a basin and the tributaries below a confluence the index lacks: the county list ends both entries, the sector is approximate', () => {
  const found = read(`${head}Jijia – bazin superior şi afluenţi bazin mijlociu şi inferior (judeţele: Botoşani şi Iaşi), Siret – afluenţii mici aferenţi sectorului aval confluenţă cu râul Suceava (judeţele: Suceava, Botoşani, Neamţ, Iaşi, Bacău, Vrancea şi Galaţi)`);
  assert.deepEqual(summary(found), [`Jijia basin false ${JIJIA}`, 'Siret tributaries true U5,U13']);
  assert.deepEqual(found.areas, ['U2', 'U5', 'U9', 'U10', 'U11', 'U12', 'U13', 'U14'], 'In the order of the editor\'s list');
  assert.equal(found.concerns, true);
  assert.equal(found.rivers[1].after, undefined, 'Suceava is not in the index, so the sector is not cut');
});

test('a county list after several entries is theirs all, and a later list is the next entries\'', () => {
  const run2024 = read('COD GALBEN: În intervalul 27.06.2024 ora 12:00 – 28.06.2024 ora 12:00 pe râurile: Jijia – bazin superior, Prut – sector aval Acumulare Stânca-Costești – amonte Fălciu, ca urmare a ploilor torențiale, județele Botoșani, Iași și Vaslui');
  assert.deepEqual(summary(run2024), [`Jijia basin false ${JIJIA}`, 'Prut river true U1,U2']);
  const two = read(`${head}Jijia – bazin superior şi afluenţi bazin mijlociu şi inferior, Prut – afluenţii aferenţi sectorului amonte confluenţă cu râul Jijia (judeţele: Botoşani şi Iaşi)`);
  assert.deepEqual(two.rivers.map(river => river.name), ['Jijia', 'Prut']);
  const mixed = read('Volovăț, Bășeu – bazin superior, județul Botoșani și pe râurile din bazinele hidrografice: Jijia – bazin superior (județele: Iași și Vaslui)');
  assert.deepEqual(summary(mixed), ['Volovăț basin false U3', 'Bașeu basin false U4,U5,U6'], 'Jijia is for Iași and Vaslui');
  const after = read(`${head}Prut (judeţele: Botoşani şi Iaşi), Jijia`);
  assert.deepEqual(after.rivers.map(river => river.name), ['Prut', 'Jijia'], 'A name no list follows takes the last list before it');
});

test('tributaries below or above a confluence are told by the order of their segments, where 14 < 14a < 15', () => {
  const below = read(`${head}Jijia – afluenţii aferenţi sectorului aval confluenţă cu râul Sitna (judeţele: Botoşani şi Iaşi)`);
  assert.deepEqual(summary(below), ['Jijia tributaries false U9,U10,U14']);
  assert.equal(below.rivers[0].after, 'Sitna', 'Sitna and Morișca are out, Miletin and its Rediu stay, Buhai is upstream');
  const above = read(`${head}Prut – afluenţii aferenţi sectorului amonte confluenţă cu râul Jijia (judeţele: Botoşani şi Iaşi)`);
  assert.deepEqual(summary(above), ['Prut tributaries false U3,U4,U5,U6,U7,U8']);
  assert.equal(above.rivers[0].before, 'Jijia', 'Volovăț, Bașeu, Podriga and 14a stay; Jijia, its tributaries and Ghireni (17) are out');
  assert.equal(read(`${head}Prut – afluenţii aferenţi sectorului aval confluenţă cu râul Vorona (judeţele: Botoşani)`).rivers[0].uats.includes('U8'), true, '14a is below 14');
  assert.equal(read(`${head}Prut – afluenţii aferenţi sectorului amonte confluenţă cu râul Lunca (judeţele: Botoşani)`).rivers[0].uats.includes('U7'), true, '14 is above 14a');
  const both = read(`${head}Prut – afluenţii aferenţi sectorului aval confluenţă cu râul Vorona – amonte confluenţă cu râul Jijia (judeţele: Botoşani)`);
  assert.deepEqual(summary(both), ['Prut tributaries false U8']);
  assert.deepEqual([both.rivers[0].after, both.rivers[0].before], ['Vorona', 'Jijia']);
});

test('what the index cannot cut is approximated: a confluence it lacks, a station, a bank, and the sector says so', () => {
  const station = read(`${head}Prut – afluenţii aferenţi sectorului aval S.H. Foieşti – amonte confluenţă cu râul Jijia (judeţele: Botoşani şi Iaşi)`);
  assert.deepEqual(summary(station), ['Prut tributaries true U3,U4,U5,U6,U7,U8'], 'The upstream end cuts, the station does not');
  assert.equal(station.rivers[0].before, 'Jijia');
  const bank = read(`${head}Prut – afluenţii de dreapta aferenţi sectorului aval confluenţă cu râul Vorona (judeţele: Botoşani şi Iaşi)`);
  assert.deepEqual([bank.rivers[0].sector, bank.rivers[0].after], [true, 'Vorona']);
  assert.equal(read(`${head}Prut – afluenţii aferenţi sectorului aval confluenţă cu râul Vorona (judeţele: Botoşani)`).rivers[0].sector, false, 'A cut that is made is not approximate');
  assert.equal(read(`${head}Prut – afluenţii din judeţul Botoşani`).rivers[0].sector, false, 'All the tributaries, said as such');
  assert.equal(read(`${head}Prut – afluenţii aferenţi sectorului S.H. Foieşti (judeţul Botoşani)`).rivers[0].sector, true);
});

test('lines wrapped by a PDF do not cut an entry, and a list of names with no commas ends at the next name', () => {
  const wrapped = read(`În intervalul 02.04.2026 ora 18:00 – 04.04.2026 ora 24:00 pe râurile din bazinele hidrografice: Jijia – bazin superior şi afluenţi
bazin mijlociu şi inferior (judeţele: Botoşani şi
Iaşi), Prut – afluenţii aferenţi sectorului amonte confluenţă cu râul
Jijia (judeţele: Botoşani şi Iaşi).`);
  assert.deepEqual(summary(wrapped), [`Jijia basin false ${JIJIA}`, 'Prut tributaries false U3,U4,U5,U6,U7,U8']);
  assert.equal(wrapped.rivers[1].before, 'Jijia', 'The river a wrapped "confluenţă cu râul" ends with is still the cut');
  assert.deepEqual(summary(read('Cod galben: râurile din bazinele hidrografice:\nBaseu\nVolovat\n(judeţul Botoşani)')), ['Bașeu basin false U4,U5,U6', 'Volovăț basin false U3']);
});

test('a confluence that is not a direct tributary does not cut: all tributaries stand for the sector', () => {
  const found = read(`${head}Jijia – afluenţii aferenţi sectorului aval confluenţă cu râul Morişca (judeţele: Botoşani)`);
  assert.deepEqual(summary(found), ['Jijia tributaries true U9,U10,U11,U12,U13,U14']);
  const station = read(`${head}Miletin - afluenţii aferenţi sectorului aval S.H. Nicolae Bălcescu - amonte S.H. Şipote; judeţele: Botoşani şi Iaşi.`);
  assert.deepEqual(summary(station), ['Miletin tributaries true U10'], 'Stations are not in the index');
});

test('a river named to place something else is not warned: tributary of, confluence, station, reservoir, "Rădăuți-Prut"', () => {
  const miletin = read(`${head}Miletin (afluent al râului Jijia) – judeţele: Botoşani şi Iaşi`);
  assert.deepEqual(summary(miletin), ['Miletin basin false U9,U10,U14'], 'Jijia is not kept, and Miletin\'s being a tributary does not widen it');
  assert.deepEqual(summary(read('râul Miletin (afluent al râului Jijia), pe sectorul aferent staţiei hidrometrice Şipote, în judeţul Botoşani')), ['Miletin river false U9,U14']);
  assert.deepEqual(read('râul Miletin (afluent al râului Jijia), pe sectorul aferent staţiei hidrometrice Şipote, în judeţul Iaşi').rivers, [], 'Iași\'s Miletin is not ours');
  assert.deepEqual(read(`${head}Jijia – bazin superior, la S.H. Rădăuți-Prut (judeţul Botoşani)`).rivers.map(river => river.name), ['Jijia']);
  assert.deepEqual(read(`${head}Jijia – bazin superior, la staţia hidrometrică Prut şi acumularea Sitna (judeţul Botoşani)`).rivers.map(river => river.name), ['Jijia']);
  assert.deepEqual(read('S.H. Prut, lacul Sitna, barajul Bahna, ac. Jijia (judeţul Botoşani)').rivers, []);
});

test('a sector of a river is its bed, a plain name is its basin, and "pe râurile:" without basins is the bed', () => {
  assert.deepEqual(summary(read(`${head}Prut – sector amonte acumularea Stânca Costeşti (judeţul Botoşani)`)), ['Prut river true U1,U2']);
  assert.deepEqual(summary(read('Cod galben, pe râurile din bazinele hidrografice Başeu şi Volovăţ din judeţul Botoşani')), ['Bașeu basin false U4,U5,U6', 'Volovăț basin false U3']);
  assert.deepEqual(summary(read(`${head}Jijia (judeţele: Botoşani şi Iaşi)`)), [`Jijia basin false ${JIJIA}`]);
  assert.deepEqual(summary(read('Cod galben: pe râurile: Jijia (județul Botoșani)')), ['Jijia river false U2,U9']);
  assert.deepEqual(summary(read('Cod galben: Jijia (județul Botoșani)')), [`Jijia basin false ${JIJIA}`], 'Without an opening, the basin');
  assert.deepEqual(summary(read('Cod galben, râul Sitna din județul Botoșani')), ['Sitna river false U11,U12']);
  assert.deepEqual(summary(read('Cod galben, pe SIHNA (jud. Botoșani)')), ['Sitna basin false U11,U12,U13'], 'Alternative names and capitals');
});

test('the national title names basins without counties and other counties\' entries are not ours', () => {
  const title = 'BAZINELE HIDROGRAFICE VIZATE: Bahna, Siret şi Jijia.';
  assert.deepEqual(summary(read(`${title}\n${head}Miletin (judeţele: Botoşani şi Iaşi).`)), ['Miletin basin false U9,U10,U14'], 'The title\'s names would take Miletin\'s list');
  const others = read(`BAZINELE HIDROGRAFICE VIZATE: Vişeu, Iza, Jijia, Prut şi Siret.\n${head}Prut – afluenţii aferenţi sectorului aval confluenţă cu râul Jijia (judeţele: Iaşi, Vaslui şi Galaţi), Siret – afluenţii mici (judeţele: Suceava, Neamţ şi Bacău)`);
  assert.deepEqual([others.rivers, others.areas, others.concerns], [[], [], false]);
  const twice = read(`${head}Prut – afluenţii aferenţi sectorului amonte confluenţă cu râul Jijia (judeţele: Botoşani şi Iaşi), Prut – afluenţii aferenţi sectorului aval confluenţă cu râul Jijia (judeţele: Iaşi, Vaslui şi Galaţi)`);
  assert.deepEqual(summary(twice), ['Prut tributaries false U3,U4,U5,U6,U7,U8'], 'The same river twice, only the upstream sector is ours');
  assert.equal(read(`${title} Miletin (judeţele: Botoşani şi Iaşi)`).rivers.length, 1, 'A title that ends in a full stop leaves the rest of its line');
});

test('the title\'s list on the lines after it, and the addressees\' basins administrations, name no river for the county', () => {
  const national = `Către: Ministerul Mediului, Apelor şi Pădurilor, S.C. Hidroelectrica S.A., Administraţiile Bazinale de Apă: Jiu,
Olt, Siret şi Prut-Bârlad.

BAZINELE HIDROGRAFICE VIZATE:

Siret, Jijia şi Prut.

MOMENTUL PRODUCERII FENOMENELOR VIZATE:
Data: 02.04.2026 ora 18:00 – 04.04.2026 ora 24:00
COD GALBEN
În intervalul 02.04.2026 ora 18:00 – 04.04.2026 ora 24:00 pe râurile din bazinele hidrografice: Miletin (judeţele: Botoşani şi Iaşi).`;
  assert.deepEqual(summary(read(national)), ['Miletin basin false U9,U10,U14']);
  const open = read('BAZINELE HIDROGRAFICE AFECTATE: Siret, Jijia\nCOD GALBEN: pe râurile: Miletin (județul Botoșani)');
  assert.deepEqual(open.rivers.map(river => river.name), ['Miletin'], 'A title with no full stop ends at the code');
});

test('"unele râuri mici" from counties naming Botoșani is flagged, not read as a river, and a name of several courses is reported', () => {
  const small = read('Cod galben: pe unele râuri mici din judeţele: Prahova, Suceava şi Botoşani');
  assert.deepEqual([small.rivers, small.smallRivers, small.concerns], [[], true, true]);
  assert.equal(read('Cod galben: pe unele râuri mici din judeţele: Prahova şi Suceava').smallRivers, false);
  const clash = read(`${head}Valea Mare – bazin (județul Botoșani), Jijia (județul Botoșani)`);
  assert.deepEqual([clash.ambiguous, clash.rivers.map(river => river.name)], [['Valea Mare'], ['Jijia']]);
  assert.deepEqual(read(`${head}Valea Mare – bazin (județul Iași)`).ambiguous, [], 'Another county\'s clash is not ours to report');
});

test('UATs keep the editor\'s order, a UAT outside its list is left aside, and no index reads nothing', () => {
  const found = read(`${head}Prut – sector amonte acumularea Stânca Costeşti (judeţul Botoşani)`, ['U2', 'U7', 'U1']);
  assert.deepEqual(found.rivers[0].uats, ['U2', 'U1'], 'Z9 is not in the list');
  assert.deepEqual(found.areas, ['U2', 'U1']);
  assert.equal(read(`${head}Prut (județul Botoșani)`, []).rivers[0].uats.length, 0);
  const none = readRivers(`${head}Jijia (județul Botoșani), pe unele râuri mici din județele: Botoșani`, [], { uats: U });
  assert.deepEqual([none.rivers, none.areas, none.ambiguous, none.smallRivers, none.concerns], [[], [], [], true, true]);
  assert.deepEqual(readRivers('', rivers).rivers, []);
});

test('a river named like a county inside a county list is the county, not a river', () => {
  // Synthetic courses that share a name with a county: "Suceava", and "Bistrița" inside "Bistrița Năsăud".
  const named = [...rivers,
    { name: 'Suceava', alt: [], code: 'RO_XII_1.20', uats: ['U7'] },
    { name: 'Bistrița', alt: [], code: 'RO_XII_1.21', uats: ['U8'] }];
  const names = text => readRivers(text, named, { uats: U }).rivers.map(river => river.name);
  assert.deepEqual(names(`${head}Jijia (județul Botoșani)`), ['Jijia'], 'The control');
  assert.deepEqual(names(`${head}Jijia (județele: Suceava, Botoșani și Iași)`), ['Jijia'], 'Suceava in the list adds no UATs');
  assert.deepEqual(names(`${head}Jijia (județele: Botoșani, Suceava și Iași)`), ['Jijia']);
  assert.deepEqual(names(`${head}Jijia (județele: Bistrița Năsăud, Botoșani și Iași)`), ['Jijia'], 'Nor does the first word of "Bistrița Năsăud"');
  assert.deepEqual(names(`${head}Jijia – bazin superior, Suceava – bazin (județele: Suceava și Botoșani)`), ['Jijia', 'Suceava'],
    'The river named outside the list is still read');
});

test('a county of two words is read whole, wrapped or hyphenated, so a Botoșani after it stays in the list', () => {
  const found = text => summary(read(text));
  assert.deepEqual(found(`${head}Jijia (județele: Bistrița Năsăud, Botoșani și Iași)`), [`Jijia basin false ${JIJIA}`]);
  assert.deepEqual(found(`${head}Jijia (județele: Bistrița-Năsăud, Botoșani și Iași)`), [`Jijia basin false ${JIJIA}`]);
  assert.deepEqual(found(`${head}Jijia (județele: Satu Mare, Botoșani și Iași)`), [`Jijia basin false ${JIJIA}`]);
  assert.deepEqual(found(`${head}Jijia (județele: Satu\nMare, Botoșani și Iași)`), [`Jijia basin false ${JIJIA}`], 'Wrapped by a PDF');
  assert.deepEqual(found(`${head}Jijia (județele: Bistrița\nNăsăud și Botoșani)`), [`Jijia basin false ${JIJIA}`]);
  assert.deepEqual(found(`${head}Jijia (județele: Caraș\nSeverin și Botoșani)`), [`Jijia basin false ${JIJIA}`]);
  assert.deepEqual(found(`${head}Jijia (județele: Satu\nMare, Maramureș și Iași)`), [], 'The list is still not ours without Botoșani');
});

test('the title\'s skipped lines end at any code heading the sections accept, "COD: GALBEN" too', () => {
  const title = 'BAZINELE HIDROGRAFICE VIZATE: Bahna, Siret şi Jijia';
  const entry = 'În intervalul 27.06.2025 ora 12:00 – 28.06.2025 ora 12:00 pe râurile din bazinele hidrografice: Miletin (judeţele: Botoşani şi Iaşi).';
  for (const heading of ['COD GALBEN:', 'COD: GALBEN:', 'COD - GALBEN:', 'COD – PORTOCALIU:', 'Codul roşu:', 'COD DE CULOARE: GALBEN']) {
    assert.deepEqual(summary(read(`${title}\n${heading} ${entry}`)), ['Miletin basin false U9,U10,U14'], heading);
  }
  assert.deepEqual(read(`${title}\nCOD: GALBEN: Jijia (judeţele: Iaşi şi Vaslui).`).rivers, [], 'The title\'s own names are still skipped');
});
