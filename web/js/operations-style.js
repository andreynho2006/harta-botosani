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

const ALERT_COLORS = {
  yellow: '#eab308',
  orange: '#ea580c',
  red: '#dc2626',
  'ro-alert': '#dc2626',
};

/** Decorate a freshly built base style with operational incident overlays. */
export function decorateOperationalStyle(style, state = {}) {
  const operations = state.operations ?? {};
  style.sources ??= {};
  style.layers ??= [];
  for (const key of ['features', 'draft', 'selection', 'mask', 'endpoints', 'alerts']) {
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

  const alertColor = ALERT_COLORS[operations.alertCode] || '#008b9e';
  const hasAlertTint = Boolean(!operations.alerts && operations.tintAreas && ALERT_COLORS[operations.alertCode]);
  const alertOpacity = state.theme === 'noapte' ? 0.18 : state.basemap === 'satelit' ? 0.24 : 0.22;

  // Tint the affected geography, never blur the canvas. Both the translucent
  // fill and soft boundary sit BELOW road casings, labels and incident marks.
  // Reuse one GeoJSON source; no raster, extra geometry or per-frame work.
  const tintLayers = [
    { id: 'ops-alert-fill', type: 'fill', source: 'ops-alerts',
      layout: { 'fill-sort-key': ['coalesce', ['get', 'severity'], 0] },
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': operations.tintAreas === false ? 0 : alertOpacity } },
    { id: 'ops-alert-glow', type: 'line', source: 'ops-alerts', layout: rounded,
      paint: { 'line-color': ['get', 'color'], 'line-width': 10, 'line-blur': 16,
        'line-opacity': operations.tintAreas === false ? 0 : 0.24 } },
    { id: 'ops-selection-fill', type: 'fill', source: 'ops-selection',
      paint: { 'fill-color': alertColor, 'fill-opacity': hasAlertTint ? (state.theme === 'noapte' ? 0.18 : state.basemap === 'satelit' ? 0.24 : 0.22) : 0 } },
    { id: 'ops-selection-glow', type: 'line', source: 'ops-selection', layout: rounded,
      paint: { 'line-color': alertColor, 'line-width': 10, 'line-blur': 16,
        'line-opacity': hasAlertTint ? 0.24 : 0 } },
  ];
  const foreground = style.layers.findIndex(layer => layer.type === 'symbol' || layer.type === 'circle' ||
    layer['source-layer'] === 'roads' || /^(roads|tracks|rail)(-|$)/.test(layer.id));
  style.layers.splice(foreground < 0 ? style.layers.length : foreground, 0, ...tintLayers);

  style.layers.push(
    { id: 'ops-selection', type: 'line', source: 'ops-selection', layout: rounded,
      paint: { 'line-color': hasAlertTint ? alertColor : '#008b9e', 'line-width': hasAlertTint ? 1.5 : 3, 'line-opacity': hasAlertTint ? 0.55 : 1, 'line-dasharray': [3, 2] } },
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
