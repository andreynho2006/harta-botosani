const EARTH_RADIUS = 6371008.8;
const EPS = 1e-10;
const fc = (features) => ({ type: 'FeatureCollection', features });
const polygons = (g) => g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
const interpolate = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const difference = (a, b) => [a[0] - b[0], a[1] - b[1]];
const lineParts = (g) => g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : [];

function ringContains(ring, point) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    const edge = difference(b, a), offset = difference(point, a);
    if (Math.abs(cross(edge, offset)) <= EPS * Math.max(Math.hypot(...edge), EPS) &&
        point[0] >= Math.min(a[0], b[0]) - EPS && point[0] <= Math.max(a[0], b[0]) + EPS &&
        point[1] >= Math.min(a[1], b[1]) - EPS && point[1] <= Math.max(a[1], b[1]) + EPS) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
        point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function contains(polys, point) {
  return polys.some(([outer, ...holes]) => ringContains(outer, point) && !holes.some((r) => ringContains(r, point)));
}

export function containsPoint(geometry, point) {
  return contains(polygons(geometry), point);
}

export function geometryBounds(geometry) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const poly of polygons(geometry)) for (const ring of poly) for (const [x, y] of ring) {
    minx = Math.min(minx, x); miny = Math.min(miny, y);
    maxx = Math.max(maxx, x); maxy = Math.max(maxy, y);
  }
  return Number.isFinite(minx) ? [[minx, miny], [maxx, maxy]] : null;
}

function oriented(ring, clockwise) {
  let area = 0;
  for (let i = 1; i < ring.length; i++) area += cross(ring[i - 1], ring[i]);
  return (area < 0) === clockwise ? ring.map((p) => [...p]) : [...ring].reverse().map((p) => [...p]);
}

export function outsideMask(geometry) {
  const polys = polygons(geometry);
  const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  const feature = (coordinates) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates } });
  return fc([
    feature([world, ...polys.map(([outer]) => oriented(outer, true))]),
    ...polys.flatMap(([, ...holes]) => holes.map((hole) => feature([oriented(hole, false)]))),
  ]);
}

function distance(a, b) {
  const rad = Math.PI / 180;
  const dlat = (b[1] - a[1]) * rad, dlon = (b[0] - a[0]) * rad;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dlon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

function edgesOf(polys) {
  return polys.flatMap((poly) => poly.flatMap((ring) => ring.slice(1).map((b, i) => {
    const a = ring[i];
    return { a, b, minx: Math.min(a[0], b[0]), maxx: Math.max(a[0], b[0]), miny: Math.min(a[1], b[1]), maxy: Math.max(a[1], b[1]) };
  })));
}

function cuts(a, b, edges) {
  const result = [0, 1], r = difference(b, a);
  const minx = Math.min(a[0], b[0]), maxx = Math.max(a[0], b[0]);
  const miny = Math.min(a[1], b[1]), maxy = Math.max(a[1], b[1]);
  for (const edge of edges) {
    if (edge.minx > maxx + EPS || edge.maxx < minx - EPS || edge.miny > maxy + EPS || edge.maxy < miny - EPS) continue;
    const s = difference(edge.b, edge.a), offset = difference(edge.a, a), denominator = cross(r, s);
    if (Math.abs(denominator) < 1e-20) {
      if (Math.abs(cross(offset, r)) > 1e-20) continue;
      const length2 = r[0] ** 2 + r[1] ** 2;
      if (!length2) continue;
      for (const point of [edge.a, edge.b]) {
        const d = difference(point, a), t = (d[0] * r[0] + d[1] * r[1]) / length2;
        if (t > 0 && t < 1) result.push(t);
      }
      continue;
    }
    const t = cross(offset, s) / denominator, u = cross(offset, r) / denominator;
    if (t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS) result.push(Math.max(0, Math.min(1, t)));
  }
  return result.sort((x, y) => x - y).filter((t, i, all) => !i || t - all[i - 1] > EPS);
}

function portions(line, polys, edges) {
  const chunks = [];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], ts = cuts(a, b, edges);
    for (let j = 1; j < ts.length; j++) {
      const start = interpolate(a, b, ts[j - 1]), end = interpolate(a, b, ts[j]);
      if (distance(start, end) < 0.001) continue;
      const inside = contains(polys, interpolate(start, end, 0.5));
      const last = chunks.at(-1);
      if (last && last.inside === inside) last.coordinates.push(end);
      else chunks.push({ inside, coordinates: [start, end] });
    }
  }
  return chunks;
}

function limitedPath(points, limit) {
  const result = [points[0]];
  let remaining = limit;
  for (let i = 1; i < points.length; i++) {
    const length = distance(points[i - 1], points[i]);
    if (length >= remaining) {
      result.push(interpolate(points[i - 1], points[i], remaining / length));
      break;
    }
    result.push(points[i]); remaining -= length;
  }
  return result;
}

function fadePieces(points) {
  const lengths = points.slice(1).map((p, i) => distance(points[i], p));
  const total = lengths.reduce((sum, n) => sum + n, 0);
  if (total < 0.001) return [];
  const at = (target) => {
    let traversed = 0;
    for (let i = 0; i < lengths.length; i++) {
      if (traversed + lengths[i] >= target) return interpolate(points[i], points[i + 1], (target - traversed) / lengths[i]);
      traversed += lengths[i];
    }
    return points.at(-1);
  };
  const pieces = [];
  for (let i = 0; i < 8; i++) {
    const from = total * i / 8, to = total * (i + 1) / 8;
    const coordinates = [at(from)];
    let traversed = 0;
    for (let j = 0; j < lengths.length; j++) {
      traversed += lengths[j];
      if (traversed > from && traversed < to) coordinates.push(points[j + 1]);
    }
    coordinates.push(at(to));
    pieces.push({ coordinates, fade: 1 - i / 7 });
  }
  return pieces;
}

export function roadExits(roads, geometry, limitMeters = 250) {
  if (!(limitMeters > 0)) return fc([]);
  const polys = polygons(geometry), edges = edgesOf(polys), features = [], exits = new Map();
  const input = roads?.type === 'FeatureCollection' ? roads.features : Array.isArray(roads) ? roads : [];
  for (const road of input) {
    for (const line of lineParts(road.geometry)) {
      const chunks = portions(line, polys, edges);
      for (let i = 0; i < chunks.length; i++) {
        if (chunks[i].inside) continue;
        const paths = [];
        if (chunks[i - 1]?.inside) paths.push(chunks[i].coordinates);
        if (chunks[i + 1]?.inside) paths.push([...chunks[i].coordinates].reverse());
        for (const path of paths) {
          const clipped = limitedPath(path, limitMeters);
          const direction = difference(clipped[1], clipped[0]), magnitude = Math.hypot(...direction);
          const signature = JSON.stringify([road.properties?.osm ?? road.id ?? road.properties,
            clipped[0].map((x) => +x.toFixed(8)), direction.map((x) => +(x / magnitude).toFixed(6))]);
          const meters = clipped.slice(1).reduce((sum, point, j) => sum + distance(clipped[j], point), 0);
          // Buffered tiles can repeat an exit with different clipping endpoints.
          if (!exits.has(signature) || exits.get(signature).meters < meters) {
            exits.set(signature, { coordinates: clipped, meters, properties: road.properties });
          }
        }
      }
    }
  }
  for (const exit of exits.values()) for (const piece of fadePieces(exit.coordinates)) features.push({
    type: 'Feature', properties: { ...exit.properties, fade: piece.fade },
    geometry: { type: 'LineString', coordinates: piece.coordinates },
  });
  return fc(features);
}

function touches(line, [[minx, miny], [maxx, maxy]]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of line) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return x0 <= maxx && x1 >= minx && y0 <= maxy && y1 >= miny;
}

const insideMemo = new WeakMap();

/**
 * The stretches of `lines` (a FeatureCollection of lines) that lie inside `geometry`, one LineString per stretch with the
 * properties of its line. A `within` filter on a label layer tests a whole line, so a river that crosses the border loses
 * its label even where it is inside; cutting the line at the border leaves the inside stretch to be labelled.
 * The answer is kept per collection, so the same lines and area give the same object back (a style diff then sees no change).
 */
export function linesInside(lines, geometry) {
  const polys = polygons(geometry);
  if (!polys.length || !Array.isArray(lines?.features)) return fc([]);
  const key = JSON.stringify(geometry), last = insideMemo.get(lines);
  if (last?.key === key) return last.result;
  const edges = edgesOf(polys), box = geometryBounds(geometry), features = [];
  for (const feature of lines.features) {
    for (const line of lineParts(feature.geometry)) {
      if (!touches(line, box)) continue;
      for (const chunk of portions(line, polys, edges)) {
        if (chunk.inside) features.push({ type: 'Feature', properties: feature.properties, geometry: { type: 'LineString', coordinates: chunk.coordinates } });
      }
    }
  }
  const result = fc(features);
  insideMemo.set(lines, { key, result });
  return result;
}
