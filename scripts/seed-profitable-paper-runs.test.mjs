import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';

test('paper experiment seeder keeps four source-isolated runs paused',()=>{
 const source=readFileSync(new URL('./seed-profitable-paper-runs.mjs',import.meta.url),'utf8');
 assert.match(source,/fomo_new_project_expanded/);
 assert.match(source,/top_cluster_first_buy/);
 assert.match(source,/robin.*1m.*E0345/);
 assert.match(source,/bsc.*30s.*E0119/);
 assert.match(source,/run\.status!=='paused'/);
 assert.doesNotMatch(source,/\/live-runs\/[^']+\/start/);
});
