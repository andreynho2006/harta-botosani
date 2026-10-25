// An invented river index for the parser tests: the real cadastre's code scheme, none of its rivers' UATs.
// Never real ABA data. Tributary segments grow from upstream to downstream, so on the Prut the order is
// Volovat (8) < Baseu (10) < Vorona (14) < Lunca (14a) < Jijia (15) < Ghireni (17).
export const U = Array.from({ length: 14 }, (_, i) => `U${i + 1}`);

const course = (name, code, uats, extra = {}) => ({ name, aba: name.toUpperCase(), alt: [], code, parent: '', order: code.split('.').length, uats, ...extra });

export const rivers = [
  course('Prut', 'RO_XIII_1', ['U1', 'U2', 'Z9']),
  course('Volovăț', 'RO_XIII_1.8', ['U3']),
  course('Bașeu', 'RO_XIII_1.10', ['U4', 'U5']),
  course('Podriga', 'RO_XIII_1.10.6', ['U6']),
  course('Vorona', 'RO_XIII_1.14', ['U7']),
  course('Lunca', 'RO_XIII_1.14a', ['U8']),
  course('Jijia', 'RO_XIII_1.15', ['U2', 'U9']),
  course('Buhai', 'RO_XIII_1.15.3', ['U10']),
  course('Sitna', 'RO_XIII_1.15.18', ['U11', 'U12'], { aba: 'SITNA (SIHNA)', alt: ['Sihna'] }),
  course('Morișca', 'RO_XIII_1.15.18.5', ['U13']),
  course('Miletin', 'RO_XIII_1.15.25', ['U14', 'U9']),
  course('Rediu', 'RO_XIII_1.15.25.2', ['U10']),
  course('Ghireni', 'RO_XIII_1.17', ['U1', 'U3']),
  course('Siret', 'RO_XII_1', ['U2', 'U3']),
  course('Bahna', 'RO_XII_1.8', ['U13']),
  // Two unrelated courses with one name.
  course('Valea Mare', 'RO_XIII_1.12.2', ['U4']),
  course('Valea Mare', 'RO_XII_1.9', ['U5']),
];
