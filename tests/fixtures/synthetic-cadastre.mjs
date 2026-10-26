// An invented hydrography for the layer tests: the real cadastre's code scheme and properties, but invented UATs,
// lengths and geometries. Never real ABA data. Every course runs along a meridian, so its length is a multiple of
// 111.195 km per degree of latitude and the expected values can be written by hand.
export const UATS = ['Zorilă', 'Ălbăstrea', 'Mierea', 'Cetate'];

const course = (name, code, order, parent, extra) => ({
  type: 'Feature',
  properties: { name, aba: name.toUpperCase(), alt: [], code, parent, order, lengthKm: null, basinKm2: null, uats: [], ...extra.properties },
  geometry: { type: 'MultiLineString', coordinates: extra.parts },
});

export const hydrography = {
  type: 'FeatureCollection', format: 'harta-botosani-hydrography', version: 1, source: 'Sursă sintetică',
  features: [
    // A short piece listed first, then the longest part: 0.6 degrees of latitude with a bend at 47.2.
    course('Prut', 'RO_XIII_1', 1, 'Dunarea', {
      properties: { lengthKm: 742, basinKm2: 5757, uats: ['Zorilă', 'Ălbăstrea', 'Mierea'] },
      parts: [[[26.8, 47.0], [26.8, 47.1]], [[26.5, 47.0], [26.5, 47.2], [26.5, 47.6]]],
    }),
    course('Bașeu', 'RO_XIII_1.10', 2, 'Prut', {
      properties: { aba: 'BASEU', alt: ['Baseu Mare', 'Bașeul'], lengthKm: 8.46, basinKm2: 120, uats: ['Cetate'] },
      parts: [[[26.4, 47.5], [26.4, 47.58]]],
    }),
    course('Sitna', 'RO_XIII_1.15.18', 3, 'Jijia', {
      properties: { aba: 'SITNA (SIHNA)', alt: ['Sihna'], lengthKm: 61.2, basinKm2: 640.4, uats: ['Mierea', 'Cetate'] },
      parts: [[[26.3, 47.1], [26.3, 47.3]]],
    }),
    course('Jijia', 'RO_XIII_1.15', 2, 'Prut', {
      properties: { lengthKm: 275, basinKm2: 5757, uats: ['Cetate'] },
      parts: [[[26.2, 47.0], [26.2, 47.4]]],
    }),
    // The parent is written the way the cadastre writes an alternate spelling, and one parent matches no course.
    course('Morișca', 'RO_XIII_1.15.18.5', 4, 'Sitna (Sihna)', { properties: {}, parts: [[[26.1, 47.1], [26.1, 47.15]]] }),
    course('Valea Mare', 'RO_XIII_1.12.2', 3, 'Rau Strain', { properties: {}, parts: [[[26.0, 47.1], [26.0, 47.15]]] }),
  ],
};

export const emptyHydrography = { type: 'FeatureCollection', features: [] };
