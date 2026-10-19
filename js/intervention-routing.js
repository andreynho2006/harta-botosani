// Local road routing over provider geometry. No network calls or off-road links.
const R = 6371008.8, RAD = Math.PI / 180;
const GRAPH_KIND = 'hb-intervention-graph-v1';
// z15 tile geometry rounds genuine junction coordinates by a few decimeters.
const ENDPOINT_JOIN_METERS = 0.75;
// Access alleys and tracks remain usable, but should not become through shortcuts
// when a reasonable route on the public road network exists. These are relative
// planning costs, not speeds, travel times or clearance guarantees.
const ROAD_COST = { service: 4, track: 6, street: 1.4, local: 1.1 };
const roadCost = edge => ROAD_COST[edge.road.cls] || 1;
const CLASSES = new Set(['dn', 'dj', 'dc', 'local', 'street', 'service', 'track']);
const HIGHWAYS = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service', 'track', 'road']);
const NON_DRIVING = new Set(['footway', 'pedestrian', 'path', 'steps', 'cycleway', 'bridleway', 'corridor', 'construction', 'proposed']);
// Operator-confirmed physical non-motor continuation: Octav Băncilă →
// Pietonalul Unirii, Botoșani (2026-10-19). Keep the drivable part of
// Octav Băncilă available; reject only this way, even if source tags change.
const CONFIRMED_NON_MOTOR_WAYS = new Set(['w686307418']);
const RESTRICTED = new Set(['no', 'private', 'agricultural', 'forestry', 'delivery', 'customers', 'destination']);
const list = value => Array.isArray(value) ? value : value?.features ?? [];
const lines = geometry => geometry?.type === 'LineString' && Array.isArray(geometry.coordinates) ? [geometry.coordinates] : geometry?.type === 'MultiLineString' && Array.isArray(geometry.coordinates) ? geometry.coordinates.filter(Array.isArray) : [];
const validPoint = p => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
const text = value => String(value ?? '').trim().toLowerCase();
const flag = value => !['', 'no', '0', 'false', 'none'].includes(text(value));
const normalizedRef = value => text(value).replace(/\s+/g, '');
const meters = (a, b) => {
  const h = Math.sin((b[1] - a[1]) * RAD / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin((b[0] - a[0]) * RAD / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
const interpolate = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
function makeProjector(latitude) {
  const scale = Math.max(0.01, Math.cos(latitude * RAD));
  return p => [p[0] * RAD * R * scale, p[1] * RAD * R];
}
const gradeOf = p => `${Number(p.layer) || 0}:${flag(p.bridge) ? 1 : 0}:${flag(p.tunnel) ? 1 : 0}`;
function drivable(p) {
  const osm = String(p.osm ?? '').replace(/^way\//, 'w').replace(/^(\d+)$/, 'w$1');
  if (CONFIRMED_NON_MOTOR_WAYS.has(osm)) return false;
  const highway = text(p.hw ?? p.highway), cls = text(p.cls);
  if (NON_DRIVING.has(highway) || ['rail', 'railway', 'footway', 'pedestrian'].includes(cls)) return false;
  if (!CLASSES.has(cls) && !HIGHWAYS.has(highway)) return false;
  if (['yes', 'designated'].includes(text(p.emergency))) return true;
  const access = p.motor_vehicle ?? p.motorcar ?? p.vehicle ?? p.access;
  return !RESTRICTED.has(text(access));
}
function directionOf(p) {
  const oneway = text(p.oneway);
  if (['-1', 'reverse'].includes(oneway)) return -1;
  if (['yes', '1', 'true'].includes(oneway)) return 1;
  if (!oneway && text(p.junction) === 'roundabout') return 1;
  return 0;
}
function projectOn(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], denominator = dx * dx + dy * dy;
  const t = denominator ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / denominator)) : 0;
  const coordinate = interpolate(a, b, t);
  return { t, coordinate, distance: Math.hypot(point[0] - coordinate[0], point[1] - coordinate[1]) };
}
class Grid {
  constructor(cell = 100) { this.cell = cell; this.cells = new Map(); }
  addPoint(point, id) {
    const key = `${Math.floor(point[0] / this.cell)},${Math.floor(point[1] / this.cell)}`;
    if (!this.cells.has(key)) this.cells.set(key, []);
    this.cells.get(key).push(id);
  }
  addSegment(a, b, id) {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / this.cell * 2));
    const seen = new Set();
    for (let i = 0; i <= steps; i++) {
      const p = interpolate(a, b, i / steps), key = `${Math.floor(p[0] / this.cell)},${Math.floor(p[1] / this.cell)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!this.cells.has(key)) this.cells.set(key, []);
      this.cells.get(key).push(id);
    }
  }
  near(point, radius) {
    const result = new Set(), cx = Math.floor(point[0] / this.cell), cy = Math.floor(point[1] / this.cell);
    const range = Math.ceil(radius / this.cell) + 1;
    for (let x = cx - range; x <= cx + range; x++) for (let y = cy - range; y <= cy + range; y++) {
      for (const id of this.cells.get(`${x},${y}`) ?? []) result.add(id);
    }
    return result;
  }
}

/** Build once from all road classes, independently of map layer visibility.
 * Only shared vertices and same-grade endpoint touches within submeter source
 * quantization tolerance create junctions. Interior crossings never create nodes.
 * Cross-grade junctions require BOTH provider-certified endpointJunctions.
 */
export function prepareInterventionGraph(features) {
  const input = list(features);
  let latitude = 47;
  outer: for (const feature of input) for (const line of lines(feature?.geometry)) for (const p of line) {
    if (validPoint(p)) { latitude = p[1]; break outer; }
  }
  const project = makeProjector(latitude);
  const nodes = [], nodeGrid = new Grid(1), segments = [], endpoints = new Set();
  let skippedFeatures = 0;
  const nodeFor = (coordinate, grade, trusted) => {
    const xy = project(coordinate);
    for (const id of nodeGrid.near(xy, 0.75)) {
      const node = nodes[id];
      if ((node.grades.has(grade) || (trusted && node.trusted)) && meters(node.coordinate, coordinate) <= 0.75) {
        node.grades.add(grade); node.trusted ||= trusted;
        return id;
      }
    }
    const id = nodes.length;
    nodes.push({ coordinate: coordinate.slice(0, 2), xy, grades: new Set([grade]), trusted });
    nodeGrid.addPoint(xy, id);
    return id;
  };
  for (const feature of input) {
    const p = feature?.properties ?? {}, featureLines = lines(feature?.geometry);
    if (!drivable(p) || !featureLines.length) { skippedFeatures++; continue; }
    const certified = list(p.endpointJunctions ?? feature.endpointJunctions).filter(validPoint);
    const grade = gradeOf(p), direction = directionOf(p);
    for (const line of featureLines) {
      if (!Array.isArray(line) || line.length < 2 || !line.every(validPoint)) { skippedFeatures++; continue; }
      const ids = line.map((coordinate, i) => nodeFor(coordinate, grade,
        (i === 0 || i === line.length - 1) && certified.some(point => meters(point, coordinate) <= 0.75)));
      endpoints.add(ids[0]); endpoints.add(ids.at(-1));
      for (let i = 1; i < ids.length; i++) {
        if (ids[i - 1] === ids[i]) continue;
        segments.push({ a: ids[i - 1], b: ids[i], grade, direction, road: { osm: p.osm ?? null, ref: p.ref ?? '', name: p.name ?? '', cls: p.cls ?? p.hw ?? p.highway ?? '' }, splits: [] });
      }
    }
  }
  const segmentGrid = new Grid();
  segments.forEach((segment, id) => segmentGrid.addSegment(nodes[segment.a].xy, nodes[segment.b].xy, id));
  for (const id of endpoints) {
    const node = nodes[id];
    for (const segmentId of segmentGrid.near(node.xy, ENDPOINT_JOIN_METERS)) {
      const segment = segments[segmentId];
      if (segment.a === id || segment.b === id || !node.grades.has(segment.grade)) continue;
      const hit = projectOn(node.xy, nodes[segment.a].xy, nodes[segment.b].xy);
      if (hit.distance <= ENDPOINT_JOIN_METERS && hit.t > 1e-8 && hit.t < 1 - 1e-8) segment.splits.push({ t: hit.t, id });
    }
  }
  const edges = [], adjacency = nodes.map(() => []), edgeGrid = new Grid(), seen = new Set();
  for (const segment of segments) {
    const points = [{ t: 0, id: segment.a }, ...segment.splits, { t: 1, id: segment.b }].sort((a, b) => a.t - b.t);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1].id, b = points[i].id;
      if (a === b) continue;
      const canonicalDirection = a < b ? segment.direction : -segment.direction;
      const signature = `${Math.min(a, b)}:${Math.max(a, b)}:${canonicalDirection}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      const length = meters(nodes[a].coordinate, nodes[b].coordinate);
      if (length < 0.01) continue;
      const id = edges.length;
      edges.push({ a, b, length, direction: segment.direction, road: segment.road });
      edgeGrid.addSegment(nodes[a].xy, nodes[b].xy, id);
      if (segment.direction !== -1) adjacency[a].push({ to: b, edge: id, length });
      if (segment.direction !== 1) adjacency[b].push({ to: a, edge: id, length });
    }
  }
  return { kind: GRAPH_KIND, nodes: nodes.map(({ coordinate, xy }) => ({ coordinate, xy })), edges, adjacency, edgeGrid, project, stats: { nodes: nodes.length, edges: edges.length, skippedFeatures } };
}

class MinHeap {
  constructor() { this.values = []; }
  push(value) {
    const a = this.values; a.push(value);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent].cost <= value.cost) break;
      a[i] = a[parent]; i = parent;
    }
    a[i] = value;
  }
  pop() {
    const a = this.values, first = a[0], last = a.pop();
    if (!a.length) return first;
    let i = 0;
    while (i * 2 + 1 < a.length) {
      let child = i * 2 + 1;
      if (child + 1 < a.length && a[child + 1].cost < a[child].cost) child++;
      if (a[child].cost >= last.cost) break;
      a[i] = a[child]; i = child;
    }
    a[i] = last;
    return first;
  }
}
function snap(point, graph, limit) {
  const xy = graph.project(point);
  let best = null;
  for (const id of graph.edgeGrid.near(xy, limit)) {
    const edge = graph.edges[id], hit = projectOn(xy, graph.nodes[edge.a].xy, graph.nodes[edge.b].xy);
    const coordinate = interpolate(graph.nodes[edge.a].coordinate, graph.nodes[edge.b].coordinate, hit.t);
    const distanceMeters = meters(point, coordinate);
    if (distanceMeters <= limit && (!best || distanceMeters < best.distanceMeters)) best = { coordinate, distanceMeters, edge: id, t: hit.t };
  }
  return best;
}
function segmentDistance(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const first = cross(a, b, c), second = cross(a, b, d), third = cross(c, d, a), fourth = cross(c, d, b);
  if (first * second <= 0 && third * fourth <= 0 &&
      Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <= Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) &&
      Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <= Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]))) return 0;
  return Math.min(projectOn(a, c, d).distance, projectOn(b, c, d).distance, projectOn(c, a, b).distance, projectOn(d, a, b).distance);
}
function blockedEdges(graph, features, tolerance) {
  const blocked = new Set();
  for (const feature of list(features)) {
    const p = feature.properties ?? {};
    if ((p.kind && p.kind !== 'blocked') || p.status === 'resolved') continue;
    const identity = normalizedRef(p.road || p.ref);
    for (const line of lines(feature.geometry)) {
      if (!Array.isArray(line) || !line.every(validPoint)) continue;
      for (let i = 1; i < line.length; i++) {
        const a = graph.project(line[i - 1]), b = graph.project(line[i]);
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const candidates = new Set(), steps = Math.max(1, Math.ceil(length / 50));
        for (let step = 0; step <= steps; step++) for (const id of graph.edgeGrid.near(interpolate(a, b, step / steps), tolerance)) candidates.add(id);
        for (const id of candidates) {
          const edge = graph.edges[id];
          if (identity && ![edge.road.ref, edge.road.name, edge.road.osm].some(value => normalizedRef(value).split(/[;,/]/).includes(identity))) continue;
          if (segmentDistance(a, b, graph.nodes[edge.a].xy, graph.nodes[edge.b].xy) <= tolerance) blocked.add(id);
        }
      }
    }
  }
  return blocked;
}

function geometricSharedMeters(primary, candidate, graph) {
  const coordinates = primary.geometry.coordinates.map(graph.project), grid = new Grid();
  for (let i = 1; i < coordinates.length; i++) grid.addSegment(coordinates[i - 1], coordinates[i], i);
  const points = candidate.geometry.coordinates;
  let shared = 0;
  for (let i = 1; i < points.length; i++) {
    const length = meters(points[i - 1], points[i]), steps = Math.max(1, Math.ceil(length / 25));
    for (let sample = 0; sample < steps; sample++) {
      const point = graph.project(interpolate(points[i - 1], points[i], (sample + 0.5) / steps));
      if ([...grid.near(point, 1)].some(id => projectOn(point, coordinates[id - 1], coordinates[id]).distance <= 1)) shared += length / steps;
    }
  }
  return shared;
}

/** Returns geometry proposals only; missing connectivity never produces a straight fallback.
 * All snapping distances are reported separately, never appended to route geometry.
 */
export function computeInterventionRoutes(start, end, featuresOrGraph, options = {}) {
  const graph = featuresOrGraph?.kind === GRAPH_KIND ? featuresOrGraph : prepareInterventionGraph(featuresOrGraph);
  const fail = (reason, extra = {}) => ({ primary: null, alternative: null, reason, alternativeReason: '', ...extra, stats: graph.stats });
  if (!validPoint(start) || !validPoint(end)) return fail('invalid_coordinates');
  if (!graph.edges.length) return fail('empty_network');
  const limit = Math.min(200, Math.max(1, Number(options.maxSnapMeters) || 150));
  const startSnap = snap(start, graph, limit), endSnap = snap(end, graph, limit);
  const snaps = { start: startSnap, end: endSnap };
  if (!startSnap || !endSnap) return fail(!startSnap ? 'start_too_far' : 'end_too_far', { snaps });
  const blocked = blockedEdges(graph, options.blockedFeatures, Math.min(20, Math.max(0.05, Number(options.blockedToleranceMeters) || 8)));
  const extra = new Map(), virtual = [], splits = new Map();
  const add = (from, to, edge, length) => { if (!extra.has(from)) extra.set(from, []); extra.get(from).push({ to, edge, length }); };
  const nodeForSnap = hit => {
    const edge = graph.edges[hit.edge];
    if (hit.t < 1e-8) return edge.a;
    if (hit.t > 1 - 1e-8) return edge.b;
    const id = graph.nodes.length + virtual.length;
    virtual.push(hit.coordinate);
    if (!splits.has(hit.edge)) splits.set(hit.edge, []);
    splits.get(hit.edge).push({ t: hit.t, id });
    return id;
  };
  const source = nodeForSnap(startSnap), target = nodeForSnap(endSnap);
  for (const [id, middle] of splits) {
    const edge = graph.edges[id];
    const points = [{ t: 0, id: edge.a }, ...middle, { t: 1, id: edge.b }].sort((a, b) => a.t - b.t);
    for (let i = 1; i < points.length; i++) {
      const length = (points[i].t - points[i - 1].t) * edge.length;
      if (edge.direction !== -1) add(points[i - 1].id, points[i].id, id, length);
      if (edge.direction !== 1) add(points[i].id, points[i - 1].id, id, length);
    }
  }
  const count = graph.nodes.length + virtual.length;
  const coordinateFor = id => id < graph.nodes.length ? graph.nodes[id].coordinate : virtual[id - graph.nodes.length];
  const search = (penalized = new Set(), penalty = 1) => {
    const distances = new Float64Array(count).fill(Infinity), previous = new Int32Array(count).fill(-1), previousEdge = new Int32Array(count).fill(-1), stepLength = new Float64Array(count);
    const heap = new MinHeap(); distances[source] = 0; heap.push({ node: source, cost: 0 });
    while (heap.values.length) {
      const current = heap.pop();
      if (current.cost !== distances[current.node]) continue;
      if (current.node === target) break;
      for (const arc of [...(graph.adjacency[current.node] ?? []), ...(extra.get(current.node) ?? [])]) {
        if (blocked.has(arc.edge)) continue;
        const cost = current.cost + arc.length * roadCost(graph.edges[arc.edge]) * (penalized.has(arc.edge) ? penalty : 1);
        if (cost >= distances[arc.to]) continue;
        distances[arc.to] = cost; previous[arc.to] = current.node; previousEdge[arc.to] = arc.edge; stepLength[arc.to] = arc.length;
        heap.push({ node: arc.to, cost });
      }
    }
    if (!Number.isFinite(distances[target])) return null;
    const coordinates = [], edgeMeters = new Map(); let distance = 0;
    for (let id = target; id !== -1; id = previous[id]) {
      coordinates.push(coordinateFor(id).slice());
      if (previousEdge[id] >= 0) { distance += stepLength[id]; edgeMeters.set(previousEdge[id], (edgeMeters.get(previousEdge[id]) ?? 0) + stepLength[id]); }
    }
    coordinates.reverse();
    if (coordinates.length === 1) coordinates.push(coordinates[0].slice());
    const roads = [], seenRoads = new Set();
    for (const id of [...edgeMeters.keys()].reverse()) {
      const road = graph.edges[id].road, key = `${road.osm}:${road.ref}:${road.name}:${road.cls}`;
      if (!seenRoads.has(key)) { roads.push({ ...road }); seenRoads.add(key); }
    }
    const routingCost = [...edgeMeters].reduce((sum, [id, length]) => sum + length * roadCost(graph.edges[id]), 0);
    return { geometry: { type: 'LineString', coordinates }, distanceKm: distance / 1000, roads, edgeMeters, routingCost };
  };
  const primary = search();
  if (!primary) return fail('disconnected_or_blocked', { snaps, blockedEdgeCount: blocked.size });
  let alternative = null, alternativeScore = Infinity;
  const primaryEdges = new Set(primary.edgeMeters.keys());
  const maxShared = Math.min(0.95, Math.max(0, options.maxAlternativeSharedFraction ?? 0.7));
  const maxRatio = Math.max(1, Number(options.maxAlternativeRatio) || 3);
  if (primary.distanceKm > 0) for (const penalty of [4, 12, 40]) {
    const candidate = search(primaryEdges, penalty);
    if (!candidate) continue;
    const sharedMeters = [...candidate.edgeMeters].reduce((sum, [id, length]) => sum + Math.min(length, primary.edgeMeters.get(id) ?? 0), 0);
    const sharedDistance = Math.max(sharedMeters, geometricSharedMeters(primary, candidate, graph));
    candidate.sharedFraction = Math.min(1, sharedDistance / (primary.distanceKm * 1000));
    // Rank viable reserves by road suitability AND independence. Picking the
    // shortest candidate again would undo the primary-edge avoidance search.
    const score = candidate.routingCost + 12 * sharedDistance;
    if (candidate.sharedFraction <= maxShared && candidate.distanceKm <= primary.distanceKm * maxRatio && (score < alternativeScore)) { alternative = candidate; alternativeScore = score; }
  }
  const publicRoute = route => {
    if (!route) return null;
    const { edgeMeters, routingCost, ...result } = route;
    return result;
  };
  return { primary: publicRoute(primary), alternative: publicRoute(alternative), reason: '', alternativeReason: alternative ? '' : 'no_materially_different_alternative', snaps, blockedEdgeCount: blocked.size, stats: graph.stats };
}
