import { ALERT_COLORS, ALERT_COLORS_DARK, ALERT_INK, ALERT_INK_DARK } from './operations-alerts.js?v=20261019-multi-alerts';

const emptyCollection = () => ({ type: 'FeatureCollection', features: [] });
const isGeometry = type => ['==', ['geometry-type'], type];
const isThreat = ['in', ['get', 'kind'], ['literal', ['threat', 'evacuated']]];
const resolved = ['==', ['get', 'status'], 'resolved'];
const color = ['case', resolved, '#23834b', ['match', ['get', 'kind'],
  'blocked', '#080808', 'flooded', '#1677cf', 'damaged', '#e97516',
  'snow', '#6b4fd8', 'threat', '#d99810', 'fire', '#d62f37',
  'evacuated', '#c92a2a', 'isolated', '#b5179e', 'power', '#d97706',
  'stranded', '#e11d48', 'houses', '#7c3aed', 'persons', '#dc2626',
  'command', '#6544ad', 'isu', '#c8102e', 'police', '#1d4ed8',
  'medical', '#e03131', 'utility', '#d97706', 'shelter', '#21896b',
  'route_primary', '#087f8c', 'route_backup', '#b05c00', '#c94949']];
const width = (extra = 0) => ['interpolate', ['linear'], ['zoom'], 8, 4 + extra, 14, 9 + extra, 19, 22 + extra];
const rounded = { 'line-cap': 'round', 'line-join': 'round' };
const byCode = (palette, fallback = '#64748b') => ['match', ['get', 'code'],
  'yellow', palette.yellow, 'orange', palette.orange, 'red', palette.red, 'ro-alert', palette['ro-alert'], fallback];
const isPlace = ['==', ['get', 'kind'], 'place'];

/** Decorate a freshly built base style with operational incident overlays. */
export function decorateOperationalStyle(style, state = {}) {
  const operations = state.operations ?? {};
  style.sources ??= {};
  style.layers ??= [];
  for (const key of ['features', 'draft', 'selection', 'mask', 'endpoints', 'alerts']) {
    const data = key === 'mask' && !operations.focusGeometry ? emptyCollection() : operations[key] ?? emptyCollection();
    style.sources[`ops-${key}`] = { type: 'geojson', data };
  }
  style.sources['ops-alert-labels'] = { type: 'geojson', data: operations.alertLabels ?? emptyCollection() };

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

  // Warning codes must read from across the room. Dark maps (night, satellite) get the
  // light palette and a denser tint, otherwise yellow, orange and red become browns.
  // The tint thins out at street zoom so the base map stays legible.
  const tint = operations.tintAreas !== false;
  const darkMap = state.theme === 'noapte' || state.basemap === 'satelit';
  const codeColor = byCode(darkMap ? ALERT_COLORS_DARK : ALERT_COLORS);
  const fillOpacity = tint
    ? ['interpolate', ['linear'], ['zoom'], ...(darkMap ? [7, 0.5, 10, 0.46, 13, 0.34, 16, 0.26] : [7, 0.42, 10, 0.38, 13, 0.28, 16, 0.2])]
    : 0;

  // Tint the affected geography, never blur the canvas. Both the translucent
  // fill and soft boundary sit BELOW road casings, labels and incident marks.
  // Reuse one GeoJSON source; no raster, extra geometry or per-frame work.
  const tintLayers = [
    { id: 'ops-alert-fill', type: 'fill', source: 'ops-alerts',
      layout: { 'fill-sort-key': ['coalesce', ['get', 'severity'], 0] },
      paint: { 'fill-color': codeColor, 'fill-opacity': fillOpacity } },
    { id: 'ops-alert-glow', type: 'line', source: 'ops-alerts', layout: rounded,
      paint: { 'line-color': codeColor, 'line-width': 10, 'line-blur': 16, 'line-opacity': tint ? 0.24 : 0 } },
  ];
  const foreground = style.layers.findIndex(layer => layer.type === 'symbol' || layer.type === 'circle' ||
    layer['source-layer'] === 'roads' || /^(roads|tracks|rail)(-|$)/.test(layer.id));
  style.layers.splice(foreground < 0 ? style.layers.length : foreground, 0, ...tintLayers);

  // A solid boundary in the code colour sits above roads and below every label.
  // Village areas are approximate, so their line stays thinner.
  const outline = { id: 'ops-alert-outline', type: 'line', source: 'ops-alerts', layout: rounded,
    paint: { 'line-color': codeColor, 'line-opacity': tint ? 0.95 : 0,
      'line-width': ['interpolate', ['linear'], ['zoom'], 7, ['case', isPlace, 1.5, 2.5], 11, ['case', isPlace, 2, 3.5], 15, ['case', isPlace, 2.5, 4.5]] } };
  const firstLabel = style.layers.findIndex(layer => layer.type === 'symbol');
  style.layers.splice(firstLabel < 0 ? style.layers.length : firstLabel, 0, outline);

  style.layers.push(
    // The turquoise focus outline steps aside where a code outline already marks the area.
    { id: 'ops-selection', type: 'line', source: 'ops-selection', layout: rounded,
      ...(tint ? { filter: ['!=', ['get', 'alert'], true] } : {}),
      paint: { 'line-color': '#008b9e', 'line-width': 3, 'line-dasharray': [3, 2] } },
    { id: 'ops-features-fill', type: 'fill', source: 'ops-features', filter: isGeometry('Polygon'),
      paint: { 'fill-color': color, 'fill-opacity': ['case', resolved, 0.12, 0.24] } },
    { id: 'ops-features-boundary', type: 'line', source: 'ops-features', layout: rounded,
      filter: ['all', isGeometry('Polygon'), ['!', isThreat]],
      paint: { 'line-color': color, 'line-width': 3, 'line-opacity': ['case', resolved, 0.65, 1] } },
    { id: 'ops-features-threat-boundary', type: 'line', source: 'ops-features', layout: rounded,
      filter: ['all', isGeometry('Polygon'), isThreat],
      paint: { 'line-color': color, 'line-width': 3, 'line-dasharray': [3, 2] } },
    { id: 'ops-features-line-halo', type: 'line', source: 'ops-features', filter: isGeometry('LineString'), layout: rounded,
      paint: { 'line-color': '#ffffff', 'line-width': width(4), 'line-opacity': ['case', resolved, 0.6, 1] } },
    { id: 'ops-features-line', type: 'line', source: 'ops-features', filter: ['all', isGeometry('LineString'), ['!=', ['get', 'kind'], 'route_backup']], layout: rounded,
      paint: { 'line-color': color, 'line-width': width(), 'line-opacity': ['case', resolved, 0.65, 1] } },
    { id: 'ops-route-backup', type: 'line', source: 'ops-features', filter: ['all', isGeometry('LineString'), ['==', ['get', 'kind'], 'route_backup']], layout: rounded,
      paint: { 'line-color': color, 'line-width': width(), 'line-dasharray': [2, 2], 'line-opacity': ['case', resolved, 0.65, 1] } },
    { id: 'ops-features-point', type: 'circle', source: 'ops-features', filter: isGeometry('Point'),
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 7, 14, 10, 19, 15],
        'circle-color': color, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } },
    { id: 'ops-endpoints-circle', type: 'circle', source: 'ops-endpoints',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4.5, 14, 6.5, 18, 9],
        'circle-color': ['case', ['==', ['get', 'status'], 'resolved'], '#23834b', '#ffffff'],
        'circle-stroke-color': ['case', ['==', ['get', 'status'], 'resolved'], '#ffffff', '#080808'],
        'circle-stroke-width': 2.5,
      } },
    { id: 'ops-endpoints-label', type: 'symbol', source: 'ops-endpoints', minzoom: 11,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Medium'],
        'text-size': 11,
        'text-anchor': 'top',
        'text-offset': [0, 0.7],
        'text-optional': true,
        'symbol-sort-key': 10,
        'text-padding': 3,
      },
      paint: {
        'text-color': state.theme === 'noapte' ? '#ffffff' : '#111827',
        'text-halo-color': state.theme === 'noapte' ? '#161a1f' : '#ffffff',
        'text-halo-width': 1.8,
      } },
  );

  const labelLayout = {
    'text-field': ['get', 'mapLabel'],
    'text-font': ['Noto Sans Medium'],
    'text-size': operations.presenting ? operations.labelSize || 18 : 14,
    'text-max-width': 14,
    'text-line-height': 1.15,
    'text-padding': 4,
    'symbol-sort-key': ['match', ['get', 'status'], 'confirmed', 0, 'threat', 1, 'resolved', 3, 2],
  };
  const labelPaint = {
    'text-color': state.theme === 'noapte' ? '#ffffff' : '#15202a',
    'text-halo-color': state.theme === 'noapte' ? '#161a1f' : '#ffffff',
    'text-halo-width': 2,
  };

  // "NAME / COD PORTOCALIU" at each area's visual centre, most severe first. Incident
  // labels come later in the stack, so they keep placement priority over these.
  const night = state.theme === 'noapte';
  const alertLabelSize = operations.presenting ? 15 : 12;
  const alertLabel = (id, filter, extra = {}) => ({ id, type: 'symbol', source: 'ops-alert-labels', filter, ...extra,
    layout: {
      visibility: tint ? 'visible' : 'none',
      'text-field': ['format', ['upcase', ['get', 'name']], {}, '\n', {}, ['get', 'codeLabel'], { 'font-scale': 0.8, 'text-color': byCode(night ? ALERT_INK_DARK : ALERT_INK) }],
      'text-font': ['Noto Sans Medium'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 7, alertLabelSize, 12, alertLabelSize + 4],
      'text-max-width': 9,
      'text-line-height': 1.15,
      'text-letter-spacing': 0.03,
      'text-padding': 2,
      'symbol-sort-key': ['*', -1, ['coalesce', ['get', 'severity'], 0]],
    },
    paint: { 'text-color': night ? '#ffffff' : '#15202a', 'text-halo-color': night ? '#161a1f' : '#ffffff', 'text-halo-width': 2.2, 'text-halo-blur': 0.4 } });
  style.layers.push(
    alertLabel('ops-alert-label', ['!', isPlace]),
    alertLabel('ops-alert-label-place', isPlace, { minzoom: 10 }),
  );

  style.layers.push(
    { id: 'ops-features-label-line', type: 'symbol', source: 'ops-features', filter: isGeometry('LineString'),
      layout: { ...labelLayout, 'text-field': ['get', 'mapLabelInline'], 'symbol-placement': 'line-center', 'text-offset': [0, -1.3], 'text-max-angle': 50,
        'text-keep-upright': true } ,
      paint: labelPaint },
    { id: 'ops-features-label', type: 'symbol', source: 'ops-features', filter: ['!', isGeometry('LineString')],
      layout: { ...labelLayout, 'text-variable-anchor': ['bottom', 'top', 'left', 'right', 'bottom-left', 'bottom-right'],
        'text-radial-offset': 1.2, 'text-justify': 'auto' },
      paint: labelPaint },
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
