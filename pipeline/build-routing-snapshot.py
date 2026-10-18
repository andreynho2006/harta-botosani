#!/usr/bin/env python3
"""Build a local routing network from an ALREADY published vector-tile snapshot.

Manual, offline operation; never fetches OSM or updates map tiles. Install the
optional build dependency with: pip install mapbox-vector-tile==2.2.0
Usage: build-routing-snapshot.py path/to/tiles web/data/routing-roads.json --zoom 15

The exported network retains the source snapshot's quantization/simplification
and incomplete restrictions. It is a planning aid, not a surveyed road network.
"""
import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
import math
from pathlib import Path

import mapbox_vector_tile

CLASSES = frozenset(('dn', 'dj', 'dc', 'local', 'street', 'service', 'track'))


def clip_segment(a, b, left, top, right, bottom):
    """Liang–Barsky clip, retaining input direction and integer world-grid nodes."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    lo, hi = 0.0, 1.0
    for p, q in ((-dx, a[0] - left), (dx, right - a[0]),
                 (-dy, a[1] - top), (dy, bottom - a[1])):
        if p == 0:
            if q < 0:
                return None
            continue
        r = q / p
        if p < 0:
            lo = max(lo, r)
        else:
            hi = min(hi, r)
        if lo > hi:
            return None
    start = (round(a[0] + lo * dx), round(a[1] + lo * dy))
    end = (round(a[0] + hi * dx), round(a[1] + hi * dy))
    return (start, end) if start != end else None


def near_boundary(point, extent):
    return any(min(v % extent, extent - v % extent) <= 1 for v in point)


def reconcile_seams(segments, extent):
    """Reconcile only same-way seam rounding, never nearby independent roads.

    An intersection with a tile edge can round up to two world-grid units differently
    in neighboring tiles. Only nodes ON that same tile edge may be merged.
    """
    nodes = {p for segment in segments for p in segment}
    parent = {}

    def find(p):
        while p in parent:
            p = parent[p]
        return p

    for p in sorted(nodes):
        candidates = []
        if p[0] % extent == 0:
            candidates.extend((p[0], p[1] + delta) for delta in (-2, -1, 1, 2))
        if p[1] % extent == 0:
            candidates.extend((p[0] + delta, p[1]) for delta in (-2, -1, 1, 2))
        for q in candidates:
            if q in nodes:
                a, b = find(p), find(q)
                if a != b:
                    parent[max(a, b)] = min(a, b)
    return {(find(a), find(b)) for a, b in segments if find(a) != find(b)}


def chain_segments(segments):
    """Join directed edges without dropping vertices or changing one-way order."""
    outgoing, incoming = defaultdict(list), Counter()
    for a, b in sorted(segments):
        outgoing[a].append(b)
        incoming[b] += 1
    used = set()
    lines = []

    def walk(a, b):
        line = [a, b]
        used.add((a, b))
        while incoming[b] == 1 and len(outgoing[b]) == 1:
            c = outgoing[b][0]
            if (b, c) in used:
                break
            line.append(c)
            used.add((b, c))
            b = c
        lines.append(line)

    # Start at way ends / self-junctions first; the remainder are closed loops.
    for a in sorted(outgoing):
        if incoming[a] != 1 or len(outgoing[a]) != 1:
            for b in outgoing[a]:
                if (a, b) not in used:
                    walk(a, b)
    for a, b in sorted(segments):
        if (a, b) not in used:
            walk(a, b)
    return lines


def lonlat(point, extent, zoom):
    scale = extent * (2 ** zoom)
    lon = point[0] / scale * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * point[1] / scale))))
    return [round(lon, 7), round(lat, 7)]


def build_snapshot(tiles, zoom=15):
    tiles = Path(tiles)
    paths = sorted((tiles / str(zoom)).glob('*/*.pbf'))
    if not paths:
        raise ValueError(f'No tiles found at zoom {zoom}')
    groups = {}
    digest = hashlib.sha256()
    source_extent = None
    fragment_count = 0
    for path in paths:
        payload = path.read_bytes()
        digest.update(str(path.relative_to(tiles)).encode('utf-8') + b'\0' + payload)
        decoded = mapbox_vector_tile.decode(
            gzip.decompress(payload) if payload[:2] == b'\x1f\x8b' else payload,
            default_options={'y_coord_down': True})
        roads = decoded.get('roads')
        if not roads:
            continue
        extent = roads['extent']
        if source_extent is not None and extent != source_extent:
            raise ValueError('Mixed tile extents are not supported')
        source_extent = extent
        tile_x, tile_y = int(path.parent.name), int(path.stem)
        left, top = tile_x * extent, tile_y * extent
        for feature in roads['features']:
            props = feature.get('properties', {})
            geometry = feature.get('geometry', {})
            if props.get('cls') not in CLASSES:
                continue
            if not props.get('osm'):
                raise ValueError(f'Road without source OSM identifier in {path}')
            if geometry.get('type') not in ('LineString', 'MultiLineString'):
                continue
            # Keep all original attributes and distinguish bridge/tunnel/property
            # variants. No union of nearby roads or of different source OSM ways.
            key = json.dumps(props, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
            group = groups.setdefault(key, {'properties': props, 'segments': set(), 'endpoints': set()})
            lines = geometry['coordinates'] if geometry['type'] == 'MultiLineString' else [geometry['coordinates']]
            fragment_count += 1
            for line in lines:
                points = [(round(left + p[0]), round(top + p[1])) for p in line]
                if len(points) < 2:
                    continue
                if points[0] != points[-1]:
                    for p in (points[0], points[-1]):
                        if (left < p[0] < left + extent and top < p[1] < top + extent
                                and not near_boundary(p, extent)):
                            group['endpoints'].add(p)
                for a, b in zip(points, points[1:]):
                    segment = clip_segment(a, b, left, top, left + extent, top + extent)
                    if segment:
                        group['segments'].add(segment)
    if source_extent is None:
        raise ValueError('No road layers were found')
    features, counts = [], Counter()
    vertices = 0
    for key in sorted(groups):
        group = groups[key]
        segments = reconcile_seams(group['segments'], source_extent)
        if not segments:
            continue
        lines = chain_segments(segments)
        nodes = {p for line in lines for p in line}
        coords = [[lonlat(p, source_extent, zoom) for p in line] for line in lines]
        props = dict(group['properties'])
        props['endpointJunctions'] = [lonlat(p, source_extent, zoom)
                                      for p in sorted(group['endpoints'] & nodes)]
        features.append({'type': 'Feature', 'properties': props,
                         'geometry': {'type': 'LineString' if len(coords) == 1 else 'MultiLineString',
                                      'coordinates': coords[0] if len(coords) == 1 else coords}})
        counts[props['cls']] += 1
        vertices += sum(len(line) for line in lines)
    if not features:
        raise ValueError('No supported road features were found')
    metadata_path = tiles / 'metadata.json'
    tile_metadata = json.loads(metadata_path.read_text()) if metadata_path.exists() else {}
    stats_path = tiles.parent / 'data' / 'stats.json'
    stats = json.loads(stats_path.read_text()) if stats_path.exists() else {}
    metadata = {
        'formatVersion': 1,
        'source': 'existing-published-vector-tiles',
        'sourceSnapshot': stats.get('generated'),
        'sourceTilesSha256': digest.hexdigest(),
        'sourceGenerator': tile_metadata.get('generator'),
        'attribution': tile_metadata.get('attribution', '© OpenStreetMap contributors'),
        'zoom': zoom,
        'extent': source_extent,
        'tileCount': len(paths),
        'fragmentCount': fragment_count,
        'featureCount': len(features),
        'vertexCount': vertices,
        'classes': dict(sorted(counts.items())),
        'seamJoinToleranceGridUnits': 2,
        'endpointJunctions': 'Only source-fragment ends inside tile cores; excludes tile-edge / buffer clipping ends.',
        'limitations': [
            'Uses the frozen map snapshot; no map or OSM refresh was performed.',
            'Source tiles are quantized and simplified; OSM node IDs and turn restrictions are unavailable.',
            'One-way and vehicle/access restrictions are only as complete as the published tile attributes.',
            'No inferred intersections at geometric road crossings; bridge/tunnel grades remain separate.',
            'Planning routes require operational confirmation of current access and vehicle clearance.',
        ],
    }
    return {'type': 'FeatureCollection', 'metadata': metadata, 'features': features}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tiles', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--zoom', type=int, default=15)
    args = parser.parse_args()
    result = build_snapshot(args.tiles, args.zoom)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print(json.dumps(result['metadata'], ensure_ascii=False, indent=2))
    print(f'Output size: {args.output.stat().st_size:,} bytes')


if __name__ == '__main__':
    main()
