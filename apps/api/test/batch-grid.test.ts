import{describe,it,expect}from'vitest';
import{combinations,batchId,digest,PILOTS}from'../src/batch-grid.js';
import{configuration}from'../../../packages/engine/test/fixtures.js';
describe('approved finite grid',()=>{
 const base=configuration();base.exitConfig.profitLock={enabled:true,tiers:[{activationPercent:50,floorPercent:20},{activationPercent:100,floorPercent:60},{activationPercent:150,floorPercent:80},{activationPercent:200,floorPercent:100}]};
 it('has 864 unique combinations plus original control without mutating base',()=>{const before=digest(base),rows=combinations(base);expect(rows).toHaveLength(865);expect(new Set(rows.slice(1).map(r=>r.checksum)).size).toBe(864);expect(digest(base)).toBe(before);expect(rows[0].strategy).toEqual(base);expect(rows.slice(1).every(r=>r.strategy.positionConfig.maxConcurrentPositions===1)).toBe(true);});
 it('uses stable distinct ids and representative pilots',()=>{expect(batchId('a')).toBe(batchId('a'));expect(batchId('a')).not.toBe(batchId('b'));const rows=combinations(base),pilot=PILOTS.slice(1).map(n=>rows[n]);expect(new Set(pilot.map(r=>r.key[0])).size).toBe(6);expect(new Set(pilot.map(r=>r.strategy.exitConfig.takeProfit.type)).size).toBe(4);});
});
