import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import tempfile
import zipfile

spec=importlib.util.spec_from_file_location('tokens',Path(__file__).with_name('token-signal-manifest.py'))
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class TokenSignals(unittest.TestCase):
    def run_fixture(self,conflict=False):
        with tempfile.TemporaryDirectory() as tmp:
            files=[Path(tmp)/'a.xlsx',Path(tmp)/'b.xlsx']
            for f in files:
                with zipfile.ZipFile(f,'w'): pass
            headers=['所属链','合约地址','触发时间（北京时间）','触发时间戳（毫秒）','信号名称','信号代码','信号来源','信号ID','明细ID']
            row=['ROBIN','0xABC','2026-09-19 22:16:04','1789827364099','FOMO','fomo_new_project','trade-monitor','33','1']
            later=row.copy();later[2]='2026-09-19 22:16:05';later[3]='1789827365099';later[-1]='1' if conflict else '2'
            rows=[(1,dict(enumerate(headers))),(2,dict(enumerate(row))),(3,dict(enumerate(later)))]
            with patch.object(m.signals.reader,'workbook_sheets',return_value=[('sheet','sheet')]),patch.object(m.signals.reader,'read_shared_strings',return_value=[]),patch.object(m.signals.reader,'iter_sheet_rows',return_value=rows):
                return m.build_events(files)
    def test_preserves_multiple_signals_deduplicates_exports_and_normalizes_evm(self):
        r=self.run_fixture();self.assertEqual(len(r['events']),2);self.assertEqual(r['duplicates'],2)
        self.assertEqual(r['events'][0]['ca'],'0xabc');self.assertEqual(len(r['events'][0]['provenance']),2)
        self.assertEqual(r['events'][0]['sourceSignal']['upstreamSource'],'trade-monitor')
    def test_conflicting_identity_is_rejected(self):
        with self.assertRaises(ValueError):self.run_fixture(True)

if __name__=='__main__':unittest.main()
