import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = readFileSync(resolve('../../deploy/advance-batch.sh'), 'utf8');
function run(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'batch-timer-'));
  try {
    writeFileSync(join(dir, 'runner.sh'), script.replace('/run/lock/meme-backtest-batch.lock', join(dir, 'lock')));
    writeFileSync(join(dir, 'flock'), '#!/bin/sh\nexit "${LOCK_EXIT:-0}"\n');
    writeFileSync(join(dir, 'docker'), `#!/bin/sh
case "$1" in
 inspect) echo "\${RUNNING:-true}";;
 ps) printf '%b\\n' "\${PG_ROWS:-database postgres:18-alpine}";;
 exec)
  if [ "$2" = database ]; then
   printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/test 99999 1 %s 1%% /data\\n' "\${FREE_KB:-99998}"
  else
   printf '%s\\n' "$*"
   exit "\${CLI_EXIT:-0}"
  fi;;
esac
`);
    for (const file of ['docker', 'flock']) chmodSync(join(dir, file), 0o755);
    return spawnSync('sh', [join(dir, 'runner.sh')], { encoding: 'utf8', env: { ...process.env, ...env, PATH: `${dir}:${process.env.PATH}` } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
describe('production batch timer', () => {
  it('passes actual database-volume free bytes to advance, never start', () => {
    const r = run({ FREE_KB: '5000000' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('BATCH_FREE_BYTES=5120000000');
    expect(r.stdout).toContain('batch-cli.js advance --yes');
    expect(r.stdout).not.toContain('start');
  });
  it('skips during deployment or when the API is down', () => {
    for (const env of [{ LOCK_EXIT: '1' }, { RUNNING: 'false' }]) {
      const r = run(env); expect(r.status).toBe(0); expect(r.stdout).toBe('');
    }
  });
  it('fails closed if the database container is ambiguous or absent', () => {
    for (const PG_ROWS of ['first postgres:18\\nsecond postgres:17', 'api node:22']) {
      const r = run({ PG_ROWS }); expect(r.status).toBe(1); expect(r.stdout).toBe('');
    }
  });
  it('propagates coordinator failure for journald/systemd diagnostics', () => {
    expect(run({ CLI_EXIT: '1' }).status).toBe(1);
  });
  it('uses a boot-enabled recurring timer and serializes releases', () => {
    const timer = readFileSync(resolve('../../deploy/meme-backtest-batch.timer'), 'utf8');
    expect(timer).toContain('OnUnitInactiveSec=60s');
    expect(timer).toContain('WantedBy=timers.target');
    const release = readFileSync(resolve('../../deploy/release.sh'), 'utf8');
    expect(release.indexOf('flock -w 900 9')).toBeLessThan(release.indexOf('docker stop --time 90'));
    expect(release).toContain('sh deploy/install-batch-timer.sh');
  });
});
