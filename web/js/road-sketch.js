const R = 6371008.8;
const RAD = Math.PI / 180;
const JOIN = 3;
const norm = (value) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
const refs = (value) => norm(value).replace(/\s/g, '').split(/[;/]/).filter(Boolean);
const identity = (p = {}) => ({ osm: p.osm ?? null, ref: p.ref ?? null, name: p.name ?? null, cls: p.cls ?? null });
const matches = (a, b) => {
  if (a.osm != null && b.osm != null && String(a.osm) === String(b.osm)) return true;
  const firstRefs = refs(a.ref), secondRefs = refs(b.ref);
  if (firstRefs.length || secondRefs.length) return firstRefs.some((ref) => secondRefs.includes(ref));
  return Boolean(norm(a.name) && norm(a.name) === norm(b.name));
};
const featuresOf = (features) => Array.isArray(features) ? features : features?.features ?? [];
const linesOf = (geometry) => geometry?.type === 'LineString' ? [geometry.coordinates] : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function haversineMeters(a, b) {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function lineLengthKm(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return 0;
  let meters = 0;
  for (let i = 1; i < coordinates.length; i++) meters += haversineMeters(coordinates[i - 1], coordinates[i]);
  return +(meters / 1000).toFixed(2);
}

export function normalizeRoadRef(value) {
  return norm(value).replace(/[\s_-]+/g, '').toUpperCase();
}

const ROAD_ALIASES = {
  DJ29: 'DN29',
  DN290: 'DJ290',
  DN291: 'DJ291',
  DN292: 'DJ292',
  DN293: 'DJ293',
  DN294: 'DJ294',
  DN296: 'DJ296',
  DN297: 'DJ297',
  DN298: 'DJ298',
  DN282: 'DJ282',
};

export function roadsListOf(roadNetwork) {
  if (Array.isArray(roadNetwork)) return roadNetwork;
  if (Array.isArray(roadNetwork?.roads)) return roadNetwork.roads;
  return [];
}

export function findRoadByRef(roadNetwork, query) {
  const list = roadsListOf(roadNetwork);
  const q = normalizeRoadRef(query);
  if (!q || !list.length) return null;
  const direct = list.find((r) => normalizeRoadRef(r.ref) === q);
  if (direct) return direct;
  const alias = ROAD_ALIASES[q];
  if (alias) {
    const aliased = list.find((r) => normalizeRoadRef(r.ref) === alias);
    if (aliased) return { ...aliased, requestedRef: q };
  }
  const prefix = list.find((r) => normalizeRoadRef(r.ref).startsWith(q));
  return prefix ? { ...prefix, requestedRef: q } : null;
}

export function slicePolylineByKm(coordinates, kmFrom, kmTo) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const startKm = Number(kmFrom);
  const endKm = kmTo === '' || kmTo === null || kmTo === undefined ? startKm : Number(kmTo);
  if (!Number.isFinite(startKm) || !Number.isFinite(endKm) || startKm < 0 || endKm < 0) return null;

  const cumMeters = [0];
  for (let i = 1; i < coordinates.length; i++) {
    cumMeters.push(cumMeters[i - 1] + haversineMeters(coordinates[i - 1], coordinates[i]));
  }
  const totalMeters = cumMeters.at(-1);
  if (totalMeters <= 0) return null;
  const totalKm = totalMeters / 1000;

  let aKm = Math.min(startKm, endKm);
  let bKm = Math.max(startKm, endKm);
  if (aKm > totalKm) aKm = Math.max(0, totalKm - 0.1);
  if (bKm > totalKm) bKm = totalKm;
  if (Math.abs(bKm - aKm) < 1e-4) {
    aKm = Math.max(0, aKm - 0.05);
    bKm = Math.min(totalKm, bKm + 0.05);
    if (bKm <= aKm) bKm = Math.min(totalKm, aKm + 0.05);
  }

  const fromMeters = aKm * 1000;
  const toMeters = bKm * 1000;

  const pointAtMeters = (target) => {
    if (target <= 0) return { coord: [...coordinates[0]], segIndex: 0 };
    if (target >= totalMeters) return { coord: [...coordinates.at(-1)], segIndex: coordinates.length - 2 };
    for (let i = 1; i < cumMeters.length; i++) {
      if (cumMeters[i] >= target) {
        const segLen = cumMeters[i] - cumMeters[i - 1];
        const t = segLen > 0 ? (target - cumMeters[i - 1]) / segLen : 0;
        const c = lerp(coordinates[i - 1], coordinates[i], t);
        return { coord: [+c[0].toFixed(6), +c[1].toFixed(6)], segIndex: i - 1 };
      }
    }
    return { coord: [...coordinates.at(-1)], segIndex: coordinates.length - 2 };
  };

  const startPt = pointAtMeters(fromMeters);
  const endPt = pointAtMeters(toMeters);
  const sliced = [startPt.coord];
  for (let i = startPt.segIndex + 1; i <= endPt.segIndex; i++) {
    const pt = coordinates[i];
    const prev = sliced.at(-1);
    if (pt[0] !== prev[0] || pt[1] !== prev[1]) sliced.push([...pt]);
  }
  const last = sliced.at(-1);
  if (endPt.coord[0] !== last[0] || endPt.coord[1] !== last[1]) {
    sliced.push(endPt.coord);
  }
  if (sliced.length === 1) {
    sliced.push([...coordinates.at(-1)]);
  }
  if (startKm > endKm) sliced.reverse();

  return {
    geometry: { type: 'LineString', coordinates: sliced },
    kmFrom: +aKm.toFixed(2),
    kmTo: +bKm.toFixed(2),
    lengthKm: +(bKm - aKm).toFixed(2),
    totalKm: +totalKm.toFixed(2),
  };
}

export function sliceRoadByKm(roadOrNetwork, arg2, arg3, arg4) {
  const road = roadOrNetwork?.coordinates ? roadOrNetwork : findRoadByRef(roadOrNetwork, arg2);
  const kmFrom = roadOrNetwork?.coordinates ? arg2 : arg3;
  const kmTo = roadOrNetwork?.coordinates ? arg3 : arg4;
  if (!road?.coordinates) return null;
  const res = slicePolylineByKm(road.coordinates, kmFrom, kmTo);
  if (!res) return null;
  return { ...res, road: road.requestedRef || road.ref };
}

export function sliceRoadByPlaces(roadOrNetwork, arg2, arg3, arg4) {
  const road = roadOrNetwork?.coordinates ? roadOrNetwork : findRoadByRef(roadOrNetwork, arg2);
  const fromPlace = roadOrNetwork?.coordinates ? arg2 : arg3;
  const toPlace = roadOrNetwork?.coordinates ? arg3 : arg4;
  if (!road?.coordinates || !Array.isArray(road.places)) return null;
  const nFrom = norm(fromPlace);
  const nTo = norm(toPlace);
  if (!nFrom || !nTo) return null;
  const p1 = road.places.find((p) => norm(p.name) === nFrom) || road.places.find((p) => norm(p.name).includes(nFrom));
  const p2 = road.places.find((p) => norm(p.name) === nTo) || road.places.find((p) => norm(p.name).includes(nTo));
  if (!p1 || !p2) return null;
  const res = sliceRoadByKm(road, Math.min(p1.km, p2.km), Math.max(p1.km, p2.km));
  if (!res) return null;
  return { ...res, fromPlace: p1.name, toPlace: p2.name };
}

function project(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
  const t = length2 ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2)) : 0;
  const coordinate = lerp(a, b, t);
  return { t, coordinate, distance: dist(point, coordinate) };
}
function plane(origin) {
  const xscale = R * RAD * Math.cos(origin[1] * RAD), yscale = R * RAD;
  return { to: (p) => [(p[0] - origin[0]) * xscale, (p[1] - origin[1]) * yscale],
    from: (p) => [p[0] / xscale + origin[0], p[1] / yscale + origin[1]] };
}

export function projectPointOnRoad(road, point) {
  const coords = road?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2 || !Array.isArray(point)) return null;
  const proj = plane(point);
  let best = null;
  let traversed = 0;
  for (let i = 1; i < coords.length; i++) {
    const segMeters = haversineMeters(coords[i - 1], coords[i]);
    const hit = project([0, 0], proj.to(coords[i - 1]), proj.to(coords[i]));
    if (!best || hit.distance < best.distanceMeters) {
      best = {
        coordinate: proj.from(hit.coordinate).map((v) => +v.toFixed(6)),
        km: +((traversed + hit.t * segMeters) / 1000).toFixed(2),
        distanceMeters: hit.distance,
      };
    }
    traversed += segMeters;
  }
  return best;
}

export function roadNetworkToFeatures(roadNetwork, visible = null) {
  return roadsListOf(roadNetwork)
    .filter((r) => !visible || visible['road:' + r.cls] !== false)
    .map((r) => ({
      type: 'Feature',
      properties: { ref: r.ref, cls: r.cls, osm: 'net:' + r.ref },
      geometry: { type: 'LineString', coordinates: r.coordinates },
    }));
}

export function snapToRoad(point, roadFeatures, maxDistanceMeters = 80) {
  const projection = plane(point);
  let best = null;
  for (const feature of featuresOf(roadFeatures)) for (const line of linesOf(feature.geometry)) {
    for (let i = 1; i < line.length; i++) {
      const hit = project([0, 0], projection.to(line[i - 1]), projection.to(line[i]));
      if (hit.distance <= maxDistanceMeters && (!best || hit.distance < best.distance)) {
        best = { coordinate: projection.from(hit.coordinate), road: identity(feature.properties), distance: hit.distance };
      }
    }
  }
  return best;
}

// Sparse buckets keep endpoint matching local even when the tile cache grows.
function buckets(size) {
  const cells = new Map();
  const cell = (p) => p.map((v) => Math.floor(v / size));
  return {
    add(point, value) {
      const key = cell(point).join(',');
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(value);
    },
    near(point) {
      const [x, y] = cell(point), result = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) result.push(...(cells.get(`${x + dx},${y + dy}`) ?? []));
      return result;
    },
  };
}

class Heap {
  values = [];
  push(value) {
    let i = this.values.length;
    this.values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.values[parent][0] <= value[0]) break;
      this.values[i] = this.values[parent]; i = parent;
    }
    this.values[i] = value;
  }
  pop() {
    const first = this.values[0], last = this.values.pop();
    if (this.values.length) {
      let i = 0;
      while (i * 2 + 1 < this.values.length) {
        let child = i * 2 + 1;
        if (child + 1 < this.values.length && this.values[child + 1][0] < this.values[child][0]) child++;
        if (this.values[child][0] >= last[0]) break;
        this.values[i] = this.values[child]; i = child;
      }
      this.values[i] = last;
    }
    return first;
  }
}

export function buildRoadSegment(startSnap, endSnap, roadFeatures) {
  if (!startSnap?.coordinate || !endSnap?.coordinate || !startSnap.road || !endSnap.road || !matches(startSnap.road, endSnap.road)) return null;
  const projection = plane(startSnap.coordinate), nodes = [], segments = [], nodeIndex = buckets(JOIN);
  const nodeFor = (point) => {
    let closest = null;
    for (const id of nodeIndex.near(point)) {
      const meters = dist(nodes[id].point, point);
      if (meters <= JOIN && (!closest || meters < closest.meters)) closest = { id, meters };
    }
    if (closest) return closest.id;
    const id = nodes.length;
    nodes.push({ point, directions: [] }); nodeIndex.add(point, id);
    return id;
  };
  const segmentIndex = buckets(32), seen = new Set();
  for (const feature of featuresOf(roadFeatures)) {
    if (!matches(startSnap.road, identity(feature.properties))) continue;
    for (const line of linesOf(feature.geometry)) for (let i = 1; i < line.length; i++) {
      const a = nodeFor(projection.to(line[i - 1])), b = nodeFor(projection.to(line[i]));
      if (a === b) continue;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const p = nodes[a].point, q = nodes[b].point, length = dist(p, q);
      const direction = [(q[0] - p[0]) / length, (q[1] - p[1]) / length];
      nodes[a].directions.push(direction); nodes[b].directions.push(direction);
      const id = segments.length;
      segments.push({ a, b, direction, cuts: [{ t: 0, node: a }, { t: 1, node: b }] });
      const cells = new Set(), steps = Math.max(1, Math.ceil(length / 16));
      for (let step = 0; step <= steps; step++) {
        const point = lerp(p, q, step / steps), cell = point.map((v) => Math.floor(v / 32)).join(',');
        if (!cells.has(cell)) { cells.add(cell); segmentIndex.add(point, id); }
      }
    }
  }
  if (!segments.length) return null;
  // Join clipped fragments to a collinear segment interior, not road overpasses.
  for (let id = 0; id < nodes.length; id++) {
    const node = nodes[id];
    for (const index of new Set(segmentIndex.near(node.point))) {
      const segment = segments[index];
      if (segment.a === id || segment.b === id) continue;
      if (!node.directions.some((d) => Math.abs(d[0] * segment.direction[1] - d[1] * segment.direction[0]) < 0.025)) continue;
      const hit = project(node.point, nodes[segment.a].point, nodes[segment.b].point);
      if (hit.distance <= JOIN && hit.t > 0 && hit.t < 1) segment.cuts.push({ t: hit.t, node: id });
    }
  }
  const endpoint = (snap) => {
    const point = projection.to(snap.coordinate);
    let best = null;
    for (const index of new Set(segmentIndex.near(point))) {
      const segment = segments[index], hit = project(point, nodes[segment.a].point, nodes[segment.b].point);
      if (hit.distance <= JOIN && (!best || hit.distance < best.hit.distance)) best = { segment, hit };
    }
    if (!best) return null;
    const id = nodeFor(best.hit.coordinate);
    best.segment.cuts.push({ t: best.hit.t, node: id });
    // The snapped point may also lie on another overlapping tile segment.
    for (const index of new Set(segmentIndex.near(nodes[id].point))) {
      const segment = segments[index];
      if (Math.abs(segment.direction[0] * best.segment.direction[1] - segment.direction[1] * best.segment.direction[0]) >= 0.025) continue;
      const hit = project(nodes[id].point, nodes[segment.a].point, nodes[segment.b].point);
      if (hit.distance <= JOIN) segment.cuts.push({ t: hit.t, node: id });
    }
    return id;
  };
  const start = endpoint(startSnap), end = endpoint(endSnap);
  if (start === null || end === null || start === end) return null;
  const graph = nodes.map(() => new Map());
  for (const segment of segments) {
    const cuts = segment.cuts.sort((a, b) => a.t - b.t);
    for (let i = 1; i < cuts.length; i++) {
      const a = cuts[i - 1].node, b = cuts[i].node;
      if (a === b) continue;
      const meters = dist(nodes[a].point, nodes[b].point);
      graph[a].set(b, meters); graph[b].set(a, meters);
    }
  }
  const distances = new Map([[start, 0]]), previous = new Map(), queue = new Heap();
  queue.push([0, start]);
  while (queue.values.length) {
    const [meters, node] = queue.pop();
    if (meters !== distances.get(node)) continue;
    if (node === end) break;
    for (const [next, length] of graph[node]) {
      const candidate = meters + length;
      if (candidate < (distances.get(next) ?? Infinity)) {
        distances.set(next, candidate); previous.set(next, node); queue.push([candidate, next]);
      }
    }
  }
  if (!distances.has(end)) return null;
  const route = [end];
  while (route.at(-1) !== start) route.push(previous.get(route.at(-1)));
  return { type: 'LineString', coordinates: route.reverse().map((id) => projection.from(nodes[id].point)) };
}
