"""Cadastrul apelor: citirea KMZ, tăierea la județ, unirea codurilor, numele și UAT-urile.

Toate datele sunt sintetice (cursuri și nume inventate); niciun fișier ABA nu intră în teste.
Necesită shapely și se sare fără el.
"""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

try:
    import shapely
except ImportError:
    shapely = None

MODULE_PATH = Path(__file__).resolve().parents[1] / 'pipeline' / 'hydrography.py'

# Județ-pătrat împărțit în trei UAT-uri-pătrat (lon, lat)
COUNTY = (26.0, 47.5, 26.4, 47.9)
UATS = {
    'Zănoaga': (26.0, 47.5, 26.2, 47.9),
    'Brădeni': (26.2, 47.5, 26.4, 47.7),
    'Șoapta': (26.2, 47.7, 26.4, 47.9),
}
KEYS = {'name', 'aba', 'alt', 'code', 'parent', 'order', 'lengthKm', 'basinKm2', 'uats'}


def square(box):
    w, s, e, n = box
    return {'type': 'Polygon', 'coordinates': [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}


def admin_geojson():
    features = [{'type': 'Feature', 'properties': {'name': 'Județul Inventat', 'kind': 'judet'},
                 'geometry': square(COUNTY)}]
    features += [{'type': 'Feature', 'properties': {'name': name, 'kind': 'uat'}, 'geometry': square(box)}
                 for name, box in UATS.items()]
    return {'type': 'FeatureCollection', 'features': features}


def search_json():
    return [
        ['Valea Largă', 'apa:rau', 26.05, 47.6, None, None],
        ['Pârâul Sec', 'apa:parau', 26.15, 47.55, None, None],
        # aceeași cheie ca apa de mai sus, dar localitățile vin după ape
        ['Părâul Sec', 'loc:hamlet', 26.1, 47.5, 'cătun', None],
        ['Lărguța', 'loc:village', 26.1, 47.6, 'sat', None],
        ['Valea Largă', 'str', 26.1, 47.6, None, None],
        ['Iazul Lung', 'str', 26.1, 47.6, None, None],
    ]


def placemark(attrs, lines):
    rows = ''.join(f'<tr><td>{k}</td><td>{v}</td></tr>' for k, v in attrs.items())
    coords = ''.join('<LineString><coordinates>' + ' '.join(f'{lon},{lat},0' for lon, lat in line)
                     + '</coordinates></LineString>' for line in lines)
    return (f'<Placemark><name>{attrs["Nume"]}</name><description><![CDATA[<html><body><table>'
            f'<tr><td>{attrs["Nume"]}</td></tr><tr><td><table>{rows}</table></td></tr></table></body></html>]]>'
            f'</description><MultiGeometry>{coords}</MultiGeometry></Placemark>')


def kml(placemarks):
    return ('<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
            '<Folder>' + ''.join(placemarks) + '</Folder></Document></kml>')


@unittest.skipUnless(shapely, 'Instalează shapely pentru testele de hidrografie')
class HydrographyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('hydrography', MODULE_PATH)
        cls.hydro = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.hydro)
        cls.kx = cls.hydro.KX
        cls.margin = 1000 / cls.kx  # 1 km în grade de longitudine

    def sample_kml(self):
        kx = self.kx
        return kml([
            # taie conturul pe la vest; punctul din mijloc se abate sub 10 m
            placemark({'Nume': 'VALEA LARGA (LARGUTA)', 'COD_ROMAN': 'RO_XX_1', 'NumeObiect': 'MARELE',
                       'ORDIN': '2', 'L_CURS': '20', 'SBazin_km2': '100'},
                      [[(25.8, 47.6), (26.05, 47.60002), (26.1, 47.6)]]),
            # intră 150 m în Brădeni: sub prag
            placemark({'Nume': 'PARAUL SEC', 'COD_ROMAN': 'RO_XX_1.1', 'NumeObiect': 'VALEA LARGA(LARGUTA)',
                       'ORDIN': '3', 'L_CURS': '6', 'SBazin_km2': '12'},
                      [[(26.1, 47.55), (26.2 + 150 / kx, 47.55)]]),
            # intră 300 m în Brădeni: peste prag; fără emisar
            placemark({'Nume': 'IAZUL LUNG', 'COD_ROMAN': 'RO_XX_1.2', 'NumeObiect': '',
                       'ORDIN': '3', 'L_CURS': '9', 'SBazin_km2': '15'},
                      [[(26.1, 47.65), (26.2 + 300 / kx, 47.65)]]),
            # același cod ca primul, alt nume și alt tronson: se unesc
            placemark({'Nume': 'SOAPTA', 'COD_ROMAN': 'RO_XX_1', 'NumeObiect': 'MARELE',
                       'ORDIN': '2', 'L_CURS': '8', 'SBazin_km2': '30'},
                      [[(26.25, 47.75), (26.35, 47.75)]]),
            # departe de județ: iese
            placemark({'Nume': 'RAU DEPARTE', 'COD_ROMAN': 'RO_XX_7', 'NumeObiect': 'MARELE',
                       'ORDIN': '2', 'L_CURS': '5', 'SBazin_km2': '5'},
                      [[(30.0, 47.6), (30.1, 47.6)]]),
            # la 500 m de județ, în zona de 1 km: rămâne, fără UAT-uri
            placemark({'Nume': 'MARGINEA', 'COD_ROMAN': 'RO_XX_9', 'NumeObiect': 'MARELE',
                       'ORDIN': '2', 'L_CURS': '4', 'SBazin_km2': '4'},
                      [[(26.0 - 500 / kx, 47.6), (26.0 - 500 / kx, 47.7)]]),
            # la 1,5 km de județ, dincolo de zonă: iese
            placemark({'Nume': 'PREA LA VEST', 'COD_ROMAN': 'RO_XX_8', 'NumeObiect': 'MARELE',
                       'ORDIN': '2', 'L_CURS': '4', 'SBazin_km2': '4'},
                      [[(26.0 - 1500 / kx, 47.6), (26.0 - 1500 / kx, 47.7)]]),
        ])

    def run_build(self, content, kmz=True):
        """Scrie intrările sintetice într-un director temporar și întoarce (colecția, statisticile)."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            if kmz:
                source = root / 'ape.kmz'
                with zipfile.ZipFile(source, 'w') as z:
                    z.writestr('doc.kml', content)
            else:
                source = root / 'doc.kml'
                source.write_text(content, encoding='utf-8')
            (root / 'admin.geojson').write_text(json.dumps(admin_geojson()), encoding='utf-8')
            (root / 'search.json').write_text(json.dumps(search_json()), encoding='utf-8')
            return self.hydro.build(source, root / 'admin.geojson', root / 'search.json',
                                    generated='2026-10-25T21:40Z')

    def by_code(self, fc):
        return {f['properties']['code']: f for f in fc['features']}

    def test_cut_to_county_plus_one_km_and_simplified_to_five_decimals(self):
        fc, stats = self.run_build(self.sample_kml())
        features = self.by_code(fc)
        self.assertEqual(list(features), ['RO_XX_1', 'RO_XX_1.1', 'RO_XX_1.2', 'RO_XX_9'])
        self.assertEqual((stats['read'], stats['zone']), (7, 5))
        west = features['RO_XX_1']['geometry']['coordinates'][0]
        self.assertEqual(len(west), 2)  # punctul abătut sub 10 m a dispărut
        self.assertAlmostEqual(west[0][0], 26.0 - self.margin, places=4)
        self.assertAlmostEqual(west[-1][0], 26.1, places=5)
        margin = features['RO_XX_9']['geometry']['coordinates'][0]
        self.assertAlmostEqual(margin[0][0], 26.0 - 500 / self.kx, places=4)
        for feature in fc['features']:
            self.assertEqual(feature['geometry']['type'], 'MultiLineString')
            for line in feature['geometry']['coordinates']:
                for lon, lat in line:
                    self.assertEqual((round(lon, 5), round(lat, 5)), (lon, lat))
                    self.assertGreaterEqual(lon, 26.0 - self.margin - 1e-5)

    def test_same_code_is_merged_into_one_feature(self):
        fc, stats = self.run_build(self.sample_kml())
        merged = self.by_code(fc)['RO_XX_1']
        self.assertEqual(len(merged['geometry']['coordinates']), 2)  # cele două tronsoane
        self.assertEqual(sum(f['properties']['code'] == 'RO_XX_1' for f in fc['features']), 1)
        props = merged['properties']
        self.assertEqual(props['aba'], 'VALEA LARGA (LARGUTA)')  # tronsonul cel mai lung dă datele
        self.assertEqual((props['order'], props['lengthKm'], props['basinKm2']), (2, 20, 100))
        self.assertEqual(stats['merged'], {'RO_XX_1': ['VALEA LARGA (LARGUTA)', 'SOAPTA']})
        self.assertIn('Cod unit: RO_XX_1', self.hydro.summary(stats))

    def test_names_come_from_osm_waters_then_places_then_aba(self):
        fc, _ = self.run_build(self.sample_kml())
        features = self.by_code(fc)
        main = features['RO_XX_1']['properties']
        self.assertEqual(main['name'], 'Valea Largă')  # apă OSM, cu diacritice
        self.assertEqual(main['alt'], ['Lărguța', 'Șoapta'])  # localitate OSM; apoi numele unui UAT
        self.assertEqual(main['parent'], 'Marele')  # numele ABA în Title Case
        branch = features['RO_XX_1.1']['properties']
        self.assertEqual(branch['name'], 'Pârâul Sec')  # apa bate localitatea cu aceeași cheie
        self.assertEqual(branch['parent'], 'Valea Largă')
        self.assertEqual(branch['alt'], [])
        lake = features['RO_XX_1.2']['properties']
        self.assertEqual(lake['name'], 'Iazul Lung')  # rândurile „str” nu sunt ape
        self.assertIsNone(lake['parent'])

    def test_uat_needs_at_least_200_m_of_the_stream_itself(self):
        fc, stats = self.run_build(self.sample_kml())
        features = self.by_code(fc)
        self.assertEqual(features['RO_XX_1.1']['properties']['uats'], ['Zănoaga'])  # 150 m în Brădeni
        self.assertEqual(features['RO_XX_1.2']['properties']['uats'], ['Brădeni', 'Zănoaga'])  # 300 m
        self.assertEqual(features['RO_XX_9']['properties']['uats'], [])  # în afara județului
        # tronsoanele unite adună UAT-urile; „Ș” se sortează după „S”, înainte de „Z”
        self.assertEqual(features['RO_XX_1']['properties']['uats'], ['Șoapta', 'Zănoaga'])
        self.assertEqual((stats['uats'], stats['uat_total']), (3, 3))
        self.assertAlmostEqual(stats['km'], (0.4 * self.kx + 450) / 1000, delta=0.05)

    def test_properties_are_exactly_the_contract_keys(self):
        fc, _ = self.run_build(self.sample_kml())
        self.assertEqual(list(fc)[:5], ['type', 'format', 'version', 'source', 'generated'])
        self.assertEqual((fc['format'], fc['version'], fc['generated']),
                         ('harta-botosani-hydrography', 1, '2026-10-25T21:40Z'))
        self.assertEqual(fc['source'], 'ABA Prut-Bârlad – cadastrul apelor')
        for feature in fc['features']:
            props = feature['properties']
            self.assertEqual(set(props), KEYS)
            self.assertIsInstance(props['order'], int)
            self.assertIsInstance(props['alt'], list)
            self.assertIsInstance(props['uats'], list)

    def test_plain_kml_and_command_line_entry_point(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'doc.kml').write_text(self.sample_kml(), encoding='utf-8')
            (root / 'admin.geojson').write_text(json.dumps(admin_geojson()), encoding='utf-8')
            (root / 'search.json').write_text(json.dumps(search_json()), encoding='utf-8')
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.hydro.main(root / 'doc.kml', root / 'admin.geojson', root / 'search.json',
                                root / 'hidrografie.geojson')
            fc = json.loads((root / 'hidrografie.geojson').read_text(encoding='utf-8'))
            self.assertEqual(len(fc['features']), 4)
            self.assertIn('Cursuri (coduri distincte): 4', out.getvalue())
            self.assertIn('UAT-uri atinse (cel puțin 200 m): 3 din 3', out.getvalue())

    def test_kmz_must_hold_exactly_one_kml(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'ape.kmz'
            with zipfile.ZipFile(source, 'w') as z:
                z.writestr('a.kml', self.sample_kml())
                z.writestr('b.kml', self.sample_kml())
            with self.assertRaisesRegex(ValueError, 'un singur KML'):
                list(self.hydro.read_placemarks(source))

    def test_name_helpers(self):
        h = self.hydro
        self.assertEqual(h.fold('Pârâul-Întors  Mare'), 'paraul intors mare')
        self.assertEqual(h.fold('Şendriceni'), 'sendriceni')
        self.assertEqual(h.split_name('SITNA (SIHNA)'), ('SITNA', ['SIHNA'], ''))
        self.assertEqual(h.split_name('SARATA(BOROLEA)'), ('SARATA', ['BOROLEA'], ''))
        self.assertEqual(h.split_name('BALINTI(URSULEAN,CEAUS)'), ('BALINTI', ['URSULEAN', 'CEAUS'], ''))
        # omonimele rămân deosebite
        self.assertEqual(h.split_name('RACHITA(B)'), ('RACHITA', [], ' (B)'))
        self.assertEqual(h.split_name('DOLINA (1)'), ('DOLINA', [], ' (1)'))
        self.assertEqual(h.split_name('CORNESTI1'), ('CORNESTI', [], ' 1'))
        self.assertEqual(h.title_case('PARAUL LUI MARTIN'), 'Paraul lui Martin')
        self.assertEqual(h.title_case('POIENILOR-HARIGII'), 'Poienilor-Harigii')
        self.assertEqual(h.title_case('LA ODAIE'), 'La Odaie')
        self.assertEqual((h.to_number('43'), h.to_number('12,5'), h.to_number('')), (43, 12.5, None))

    def test_romanian_sort_matches_the_browsers_locale_compare(self):
        # ordinea dată de `localeCompare(..., 'ro')` în Node
        expected = ['Cordăreni', 'Corni', 'Curtești', 'Hănțești', 'Hudești', 'Iacobeni', 'Ibănești', 'Ichim',
                    'Îndărătnici', 'Radauti', 'Răchiți', 'Rădăuți-Prut', 'Ripiceni', 'Roma', 'Român',
                    'Santa Mare', 'Săveni', 'Stăuceni', 'Suharău', 'Sulița', 'Șendriceni', 'Ștefănești',
                    'Tudora', 'Țuțora', 'Vlăsinești', 'Vorona', 'Vorona Mare', 'Vorona-Mare']
        shuffled = sorted(expected, key=lambda s: (s[::-1], s))
        self.assertNotEqual(shuffled, expected)
        self.assertEqual(sorted(shuffled, key=self.hydro.ro_key), expected)

    def test_natural_code_order(self):
        codes = ['RO_XIII_1.10', 'RO_XIII_1.2.1', 'RO_XIII_1.2', 'RO_XIII_1', 'RO_XIII_1.10b']
        self.assertEqual(sorted(codes, key=self.hydro.code_key),
                         ['RO_XIII_1', 'RO_XIII_1.2', 'RO_XIII_1.2.1', 'RO_XIII_1.10', 'RO_XIII_1.10b'])


if __name__ == '__main__':
    unittest.main()
