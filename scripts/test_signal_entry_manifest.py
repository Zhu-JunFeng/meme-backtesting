import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import tempfile
import zipfile

spec = importlib.util.spec_from_file_location('manifest', Path(__file__).with_name('signal-entry-manifest.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class ManifestTests(unittest.TestCase):
    def test_time_units_and_timezone(self):
        self.assertEqual(m.signal_time('1789827364099', '2026-09-19 22:16:04'), 1789827364099)
        for raw, display in [('1789827364', '2026-09-19 22:16:04'), ('NaN', ''), ('1789827364099', '2026-09-19 14:16:04')]:
            with self.assertRaises(ValueError): m.signal_time(raw, display)

    def test_header_reordering_dedup_and_earliest_signal(self):
        with tempfile.TemporaryDirectory() as tmp:
            files=[Path(tmp)/'a.xlsx',Path(tmp)/'b.xlsx']
            for f in files:
                with zipfile.ZipFile(f,'w'): pass
            rows=[(1,{0:'title'}),(2,{i:h for i,h in enumerate(reversed(m.HEADERS))}),
                  (3,{3:' SOL ',2:'CaseSensitive',1:'2026-09-19 22:16:04',0:'1789827364099'}),
                  (4,{3:'sol',2:'CaseSensitive',1:'2026-09-19 22:16:03',0:'1789827363099'})]
            with patch.object(m.reader,'workbook_sheets',return_value=[('signals','sheet')]), patch.object(m.reader,'read_shared_strings',return_value=[]), patch.object(m.reader,'iter_sheet_rows',return_value=rows):
                r=m.build_manifest(files)
            self.assertEqual(r['counts'],{'sol':1})
            self.assertEqual(r['entries'][0]['signalTime'],1789827363099)
            self.assertEqual(len(r['entries'][0]['sources']),4)
            self.assertEqual(r['entries'][0]['ca'],'CaseSensitive')

if __name__ == '__main__': unittest.main()
