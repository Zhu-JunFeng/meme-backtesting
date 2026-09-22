"""Read signal workbooks as data only; produce an auditable earliest-observation manifest.

No network/database access, no workbook edits. Reuses the project import skill's XLSX reader.
"""
import argparse
from datetime import datetime, timezone, timedelta
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('meme_kline_import', ROOT / '.agents/skills/meme-kline-import/scripts/import_meme_klines.py')
reader = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = reader
SPEC.loader.exec_module(reader)
HEADERS = ['所属链', '合约地址', '触发时间（北京时间）', '触发时间戳（毫秒）']

def signal_time(raw, displayed):
    if not raw.isdigit():
        raise ValueError('触发时间戳必须为整数毫秒')
    ms = int(raw)
    if not 946684800000 <= ms < 4102444800000:
        raise ValueError('触发毫秒时间戳超出 2000–2100 年范围')
    expected = datetime.fromtimestamp(ms // 1000, timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M:%S')
    if displayed != expected:
        raise ValueError(f'北京时间与毫秒时间戳不一致：{displayed} / {expected}')
    return ms

def build_manifest(paths):
    earliest, sources = {}, []
    for path in paths:
        path = Path(path)
        found, records = False, 0
        with zipfile.ZipFile(path) as archive:
            strings = reader.read_shared_strings(archive)
            for name, location in reader.workbook_sheets(archive):
                columns = None
                for row, values in reader.iter_sheet_rows(archive, location, strings):
                    if columns is None:
                        header = {v.strip(): k for k, v in values.items()}
                        if all(h in header for h in HEADERS):
                            columns, found = header, True
                        continue
                    chain, ca, display, raw = [values.get(columns[h], '').strip() for h in HEADERS]
                    if not any([chain, ca, display, raw]):
                        continue
                    if not chain or not ca:
                        raise ValueError(f'{path.name}/{name}/{row}: 缺少链或 CA')
                    chain = chain.lower()
                    if chain == 'robin':
                        ca = ca.lower()
                    ms = signal_time(raw, display)
                    records += 1
                    key = (chain, ca)
                    ref = {'file': path.name, 'sheet': name, 'row': row, 'signalTime': ms}
                    if key not in earliest:
                        earliest[key] = {'chain': chain, 'ca': ca, 'signalTime': ms, 'sources': []}
                    earliest[key]['signalTime'] = min(earliest[key]['signalTime'], ms)
                    earliest[key]['sources'].append(ref)
        if not found or not records:
            raise ValueError(f'{path.name}: 找不到完整信号表头或数据为空')
        sources.append({'file': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'records': records})
    entries = [earliest[k] for k in sorted(earliest)]
    return {'version': 1, 'rule': 'bar_open_strictly_after_signal', 'history': 'available_before_signal',
            'timeSource': '触发时间戳（毫秒）; cross-checked with 北京时间 UTC+08',
            'deduplication': 'earliest signal per chain/CA across all supplied files',
            'files': sources, 'counts': {chain: sum(e['chain'] == chain for e in entries) for chain in sorted({e['chain'] for e in entries})},
            'entries': entries}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('files', nargs='+', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    manifest = build_manifest(args.files)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'output': str(args.output), 'counts': manifest['counts'], 'files': manifest['files']}, ensure_ascii=False))
