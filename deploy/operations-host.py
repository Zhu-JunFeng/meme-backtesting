#!/usr/bin/env python3
"""Read bounded kernel counters; no traversal, Docker access or network probes."""
import json, os, time
from pathlib import Path

target = Path('/run/meme-operations')
target.mkdir(mode=0o750, exist_ok=True)
previous_path = target / 'previous.json'
try:
    previous = json.loads(previous_path.read_text())
except (OSError, ValueError):
    previous = {}
now = time.time()
cpu = [int(n) for n in Path('/proc/stat').read_text().splitlines()[0].split()[1:9]]
total, idle = sum(cpu), cpu[3] + cpu[4]
delta = total - previous.get('cpuTotal', total)
mem = {line.split(':')[0]: int(line.split()[1])*1024 for line in Path('/proc/meminfo').read_text().splitlines()}
rx = tx = 0
for line in Path('/proc/net/dev').read_text().splitlines()[2:]:
    name, values = line.split(':')
    if name.strip() == 'lo':
        continue
    fields = values.split()
    rx += int(fields[0]); tx += int(fields[8])
disk = os.statvfs('/')
elapsed = max(1, now - previous.get('time', now))
sample = {'sampledAt':int(now*1000), 'cpuPercent':max(0, min(100, 100*(1-(idle-previous.get('cpuIdle', idle))/delta))) if delta > 0 else None,
          'load':os.getloadavg(), 'memoryTotal':mem['MemTotal'], 'memoryAvailable':mem['MemAvailable'],
          'availableMemoryPercent':mem['MemAvailable']/mem['MemTotal']*100,
          'diskTotal':disk.f_blocks*disk.f_frsize, 'diskAvailable':disk.f_bavail*disk.f_frsize,
          'diskPercent':(1-disk.f_bavail/disk.f_blocks)*100,
          'inodePercent':(1-disk.f_favail/disk.f_files)*100 if disk.f_files else None,
          'networkRxBytesPerSecond':max(0, rx-previous.get('rx', rx))/elapsed,
          'networkTxBytesPerSecond':max(0, tx-previous.get('tx', tx))/elapsed}
for path, data in [(previous_path, {'cpuTotal':total,'cpuIdle':idle,'time':now,'rx':rx,'tx':tx}), (target/'host.json', sample)]:
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(data)); temp.chmod(0o640); os.replace(temp, path)
