const emptyCollection = () => ({ type: 'FeatureCollection', features: [] });
const isGeometry = type => ['==', ['geometry-type'], type];
const isThreat = ['==', ['get', 'kind'], 'threat'];
const resolved = ['==', ['get', 'status'], 'resolved'];
const color = ['case', resolved, '#23834b', ['match', ['get', 'kind'],
  'blocked', '#080808', 'flooded', '#1677cf', 'damaged', '#e97516',
  'snow', '#7773cf', 'threat', '#d99810', 'fire', '#d62f37',
  'command', '#6544ad', 'shelter', '#21896b', '#c94949']];
const width = (extra = 0) => ['interpolate', ['linear'], ['zoom'], 8, 4 + extra, 14, 9 + extra, 19, 22 + extra];
const rounded = { 'line-cap': 'round', 'line-join': 'round' };

/** Decorate a freshly built base style with operational incident overlays. */
export function decorateOperationalStyle(style, state = {}) {
  const operations = state.operations ?? {};
  style.sources ??= {};
  style.layers ??= [];
  for (const key of ['features', 'draft', 'selection', 'mask']) {
    const data = key === 'mask' && !operations.focusGeometry ? emptyCollection() : operations[key] ?? emptyCollection();
    style.sources[`ops-${key}`] = { type: 'geojson', data };
  }

  // Keep labels readable inside the focus and suppress all exterior labels.
  // Existing visibility/category filters remain part of every label filter.
  const baseSymbols = style.layers.filter(layer => layer.type === 'symbol');
  if (operations.focusGeometry) {
    for (const layer of baseSymbols) {
      const within = ['within', operations.focusGeometry];
      layer.filter = layer.filter ? ['all', layer.filter, within] : within;
    }
    style.layers = style.layers.filter(layer => layer.type !== 'symbol');
  }
  style.layers.push({
    id: 'ops-mask', type: 'fill', source: 'ops-mask',
    paint: { 'fill-color': state.theme === 'noapte' ? '#161a1f' : '#eef0f3', 'fill-opacity': 1, 'fill-antialias': false },
  });
  if (operations.focusGeometry) style.layers.push(...baseSymbols);

  style.layers.push(
    { id: 'ops-selection', type: 'line', source: 'ops-selection', layout: rounded,
      paint: { 'line-color': '#008b9e', 'line-width': 3, 'line-dasharray': [3, 2] } },
    { id: 'ops-features-fill', type: 'fill', source: 'ops-features', filter: isGeometry('Polygon'),
      paint: { 'fill-color': color, 'fill-opacity': ['case', resolved, 0.12, 0.22] } },
    { id: 'ops-features-boundary', type: 'line', source: 'ops-features', layout: rounded,
      filter: ['all', isGeometry('Polygon'), ['!', isThreat]],
      paint: { 'line-color': color, 'line-width': 3, 'line-opacity': ['case', resolved, 0.65, 1] } },
    { id: 'ops-features-threat-boundary', type: 'line', source: 'ops-features', layout: rounded,
      filter: ['all', isGeometry('Polygon'), isThreat],
      paint: { 'line-color': color, 'line-width': 3, 'line-dasharray': [3, 2] } },
    { id: 'ops-features-line-halo', type: 'line', source: 'ops-features', filter: isGeometry('LineString'), layout: rounded,
      paint: { 'line-color': '#ffffff', 'line-width': width(4), 'line-opacity': ['case', resolved, 0.6, 1] } },
    { id: 'ops-features-line', type: 'line', source: 'ops-features', filter: isGeometry('LineString'), layout: rounded,
      paint: { 'line-color': color, 'line-width': width(), 'line-opacity': ['case', resolved, 0.65, 1] } },
    { id: 'ops-features-point', type: 'circle', source: 'ops-features', filter: isGeometry('Point'),
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 7, 14, 10, 19, 15],
        'circle-color': color, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } },
    { id: 'ops-features-label', type: 'symbol', source: 'ops-features',
      layout: { 'text-field': ['concat', ['coalesce', ['get', 'title'], ['get', 'road'], ''], ' · ',
          ['match', ['get', 'status'], 'threat', 'Potențial', 'confirmed', 'Confirmat', 'resolved', 'Remediat', 'Raportat']],
        'text-font': ['Noto Sans Medium'], 'text-size': operations.presenting ? operations.labelSize || 18 : 14, 'text-anchor': 'bottom', 'text-offset': [0, -1.1],
        'text-allow-overlap': true, 'text-ignore-placement': true, 'text-max-width': 20 },
      paint: { 'text-color': state.theme === 'noapte' ? '#ffffff' : '#15202a',
        'text-halo-color': state.theme === 'noapte' ? '#161a1f' : '#ffffff', 'text-halo-width': 2 } },
    { id: 'ops-draft-fill', type: 'fill', source: 'ops-draft', filter: isGeometry('Polygon'),
      paint: { 'fill-color': '#00bcd4', 'fill-opacity': 0.18 } },
    { id: 'ops-draft-line-halo', type: 'line', source: 'ops-draft', layout: rounded,
      filter: ['in', ['geometry-type'], ['literal', ['LineString', 'Polygon']]],
      paint: { 'line-color': '#ffffff', 'line-width': 7 } },
    { id: 'ops-draft-line', type: 'line', source: 'ops-draft', layout: rounded,
      filter: ['in', ['geometry-type'], ['literal', ['LineString', 'Polygon']]],
      paint: { 'line-color': '#00bcd4', 'line-width': 4, 'line-dasharray': [2, 1] } },
    { id: 'ops-draft-point', type: 'circle', source: 'ops-draft', filter: isGeometry('Point'),
      paint: { 'circle-radius': 7, 'circle-color': '#00bcd4', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } },
  );
  return style;
}
