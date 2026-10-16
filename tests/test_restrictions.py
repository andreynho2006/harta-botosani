"""Check the road property mapping without rebuilding the map or installing GIS tools."""
import ast
from pathlib import Path
import unittest


class RestrictionPropertiesTests(unittest.TestCase):
    def test_original_values_reach_tiles_without_unit_stripping(self):
        source = Path(__file__).resolve().parents[1] / "pipeline" / "process.py"
        tree = ast.parse(source.read_text())
        mapping = next(node for node in ast.walk(tree)
                       if isinstance(node, ast.Dict)
                       and any(isinstance(key, ast.Constant) and key.value == "maxweight_raw"
                               for key in node.keys))
        t = {"maxweight": "7500 kg", "maxheight": '12\'6"', "maxwidth": "2.5"}
        properties = eval(compile(ast.Expression(mapping), str(source), "eval"),
                          {"t": t, "cls": "dn", "ref": "w1"})
        for key, value in t.items():
            self.assertEqual(properties[key + "_raw"], value)
        self.assertNotIn("maxweight", properties)


if __name__ == "__main__":
    unittest.main()
