"""Offline vector-tile reconstruction; optional mapbox-vector-tile build dependency."""
import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

try:
    import mapbox_vector_tile
except ImportError:
    mapbox_vector_tile = None

BUILD_PATH = Path(__file__).resolve().parents[1] / 'pipeline' / 'build-routing-snapshot.py'


@unittest.skipUnless(mapbox_vector_tile, 'Install mapbox-vector-tile==2.2.0 for snapshot-builder tests')
class RoutingSnapshotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('build_routing_snapshot', BUILD_PATH)
        cls.builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.builder)

    def write_tile(self, root, x, lines, compressed=False):
        features = [{'type': 'Feature', 'properties': props,
                     'geometry': {'type': 'LineString', 'coordinates': line}}
                    for props, line in lines]
        payload = mapbox_vector_tile.encode({'name': 'roads', 'features': features},
                                           default_options={'y_coord_down': True, 'extents': 4096})
        path = root / '1' / str(x) / '0.pbf'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(gzip.compress(payload) if compressed else payload)

    def test_buffer_overlap_reassembled_without_false_endpoints_or_reversing_oneway(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            props = {'osm': 'w1', 'cls': 'dn', 'oneway': 1, 'ref': 'DN29', 'bridge': 1}
            self.write_tile(root, 0, [(props, [(100, 1000), (3000, 1000), (4176, 1000)])])
            self.write_tile(root, 1, [(props, [(-80, 1000), (904, 1000)])], compressed=True)
            fc = self.builder.build_snapshot(root, 1)
            self.assertEqual(len(fc['features']), 1)
            feature = fc['features'][0]
            self.assertEqual(feature['properties']['oneway'], 1)
            self.assertEqual(feature['properties']['bridge'], 1)
            self.assertEqual(feature['geometry']['type'], 'LineString')
            expected_nodes = [(100, 1000), (3000, 1000), (4096, 1000), (5000, 1000)]
            self.assertEqual(feature['geometry']['coordinates'],
                             [self.builder.lonlat(p, 4096, 1) for p in expected_nodes])
            self.assertEqual(feature['properties']['endpointJunctions'],
                             [self.builder.lonlat(p, 4096, 1) for p in (expected_nodes[0], expected_nodes[-1])])
            self.assertEqual(fc['metadata']['tileCount'], 2)
            self.assertEqual(fc['metadata']['classes'], {'dn': 1})
            self.assertEqual(len(fc['metadata']['sourceTilesSha256']), 64)

    def test_seam_rounding_reconciles_same_edge_but_nearby_unrelated_points_remain(self):
        segments = {((100, 1000), (4096, 1100)), ((4096, 1102), (5000, 1200)),
                    ((2000, 2000), (2001, 2001)), ((4000, 2000), (4001, 2001))}
        result = self.builder.reconcile_seams(segments, 4096)
        self.assertIn(((4096, 1100), (5000, 1200)), result)
        self.assertIn(((2000, 2000), (2001, 2001)), result)
        self.assertIn(((4000, 2000), (4001, 2001)), result)

    def test_all_classes_and_distinct_way_grades_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lines = [({'osm': f'w{i}', 'cls': cls, 'hw': 'service', 'maxweight_raw': '3.5 t'},
                      [(100, 200 + i), (200, 200 + i)])
                     for i, cls in enumerate(sorted(self.builder.CLASSES))]
            lines.append(({'osm': 'w0', 'cls': 'dc', 'bridge': 1}, [(100, 200), (200, 200)]))
            self.write_tile(root, 0, lines)
            fc = self.builder.build_snapshot(root, 1)
            self.assertEqual(len(fc['features']), 8)
            self.assertEqual(set(fc['metadata']['classes']), self.builder.CLASSES)
            self.assertEqual(sum(f['properties'].get('maxweight_raw') == '3.5 t' for f in fc['features']), 7)
            self.assertEqual(sum(f['properties']['osm'] == 'w0' for f in fc['features']), 2)

    def test_source_ends_on_tile_boundary_are_not_assumed_junctions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_tile(root, 0, [({'osm': 'w1', 'cls': 'track'}, [(4095, 100), (4000, 200)])])
            feature = self.builder.build_snapshot(root, 1)['features'][0]
            self.assertEqual(feature['properties']['endpointJunctions'],
                             [self.builder.lonlat((4000, 200), 4096, 1)])

    def test_missing_zoom_or_osm_identifier_fail_instead_of_silent_partial_network(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, 'No tiles'):
                self.builder.build_snapshot(root, 1)
            self.write_tile(root, 0, [({'cls': 'street'}, [(100, 100), (200, 200)])])
            with self.assertRaisesRegex(ValueError, 'without source OSM'):
                self.builder.build_snapshot(root, 1)


if __name__ == '__main__':
    unittest.main()
