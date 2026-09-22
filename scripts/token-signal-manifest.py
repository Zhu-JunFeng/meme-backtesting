"""Extract all external signal events without modifying source workbooks."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import zipfile

spec = importlib.util.spec_from_file_location('signals', Path(__file__).with_name('signal-entry-manifest.py'))
signals = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signals)

def build_events(paths):
    events = {}
    rows = 0
    required = signals.HEADERS + ['信号名称', '信号代码', '信号来源', '信号ID', '明细ID']
    for file in paths:
        path = Path(file)
        checksum = hashlib.sha256(path.read_bytes()).hexdigest()
        found = False
        with zipfile.ZipFile(path) as archive:
            strings = signals.reader.read_shared_strings(archive)
            for sheet, location in signals.reader.workbook_sheets(archive):
                columns = None
                for row, values in signals.reader.iter_sheet_rows(archive, location, strings):
                    if columns is None:
                        header = {v.strip(): k for k, v in values.items()}
                        if all(h in header for h in required):
                            columns, found = header, True
                        continue
                    data = {h: values.get(columns[h], '').strip() for h in required}
                    if not any(data.values()):
                        continue
                    chain = data['所属链'].lower()
                    ca = data['合约地址'].lower() if chain == 'robin' else data['合约地址']
                    if not chain or not ca or not data['明细ID'] or data['信号代码'] != 'fomo_new_project':
                        raise ValueError(f'{path.name}/{sheet}/{row}: 无效的项目信号身份')
                    time = signals.signal_time(data['触发时间戳（毫秒）'], data['触发时间（北京时间）'])
                    event = dict(chain=chain, ca=ca, signalSource='fomo_new_project', detailId=data['明细ID'], signalTime=time,
                                 sourceSignal=dict(name=data['信号名称'], code=data['信号代码'], signalId=data['信号ID'], detailId=data['明细ID'], upstreamSource=data['信号来源']))
                    key = (chain, ca, event['signalSource'], event['detailId'])
                    if key in events and {k: v for k, v in events[key].items() if k != 'provenance'} != event:
                        raise ValueError(f'同一信号明细内容冲突：{key}')
                    if key not in events:
                        events[key] = {**event, 'provenance': []}
                    ref = dict(file=path.name, sha256=checksum, sheet=sheet, row=row)
                    if ref not in events[key]['provenance']:
                        events[key]['provenance'].append(ref)
                    rows += 1
        if not found:
            raise ValueError(f'{path}: 缺少信号表头')
    return dict(version=1, rows=rows, duplicates=rows-len(events), events=list(events.values()))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('files', nargs='+', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = build_events(args.files)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(dict(rows=result['rows'], unique=len(result['events']), duplicates=result['duplicates'])))
