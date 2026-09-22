import {describe,it,expect} from 'vitest';
import {validateProfitLock} from '@meme/domain';
import {ResumableEngine,CHECKPOINT_VERSION} from '../src/index.js';
import {configuration} from './fixtures.js';
function setup(){
 const config=configuration();config.symbols=[config.symbols[0]];config.positionConfig.mode='single_entry';config.positionConfig.maxEntries=1;
 config.entryConditionGroup={enabled:false,mode:'all',conditions:[]};config.exitConfig.closeAtEnd=false;config.exitConfig.takeProfit={type:'percent',value:1000};config.exitConfig.profitLock={enabled:true,tiers:[{activationPercent:50,floorPercent:20},{activationPercent:100,floorPercent:60}]};
 const engine=new ResumableEngine(config);engine.s.cash=900;
 engine.s.states[0].active={trade:{symbol:config.symbols[0],entryTime:0,entryPrice:100,quantity:1,fees:0,slippageCost:0,taxCost:0,adds:[],tradeNo:1,firstEntryPrice:100,buyAmount:100,buyFees:0,buySlippageCost:0,buyTaxCost:0},entryIndex:0,entries:1,impulse:{low:50,high:200,lowIndex:0,highIndex:1,confirmedAtIndex:2,gainPercent:300,averageVolume:100}};
 return engine;
}
function bar(e:ResumableEngine,time:number,close:number,low=close,high=close,open=close,last=false){e.step([{symbol:e.config.symbols[0],candle:{time,closeTime:time+30000,open,high,low,close,volume:100},last}]);}
describe('close-confirmed profit locks',()=>{
 it('rejects invalid, non-increasing and empty tiers',()=>{for(const tiers of [[],[{activationPercent:50,floorPercent:50}],[{activationPercent:50,floorPercent:20},{activationPercent:40,floorPercent:30}],[{activationPercent:50,floorPercent:20},{activationPercent:100,floorPercent:10}]])expect(validateProfitLock({enabled:true,tiers})).toBeTruthy();expect(validateProfitLock(undefined)).toBeUndefined();});
 it('ignores high spikes and only activates on close for next bar',()=>{const e=setup();bar(e,30000,140,100,170);expect(e.s.states[0].active?.lockPrice).toBeUndefined();bar(e,60000,150,110,160);expect(e.drain().trades).toHaveLength(0);expect(e.s.states[0].active?.lockPrice).toBe(120);bar(e,90000,125,115,130);const t=e.drain().trades[0];expect(t.exitReason).toBe('profit_lock');expect(t.exitPrice).toBe(120);});
 it('crosses multiple tiers, gaps fill at open, persists through restore',()=>{const e=setup();bar(e,30000,210,100,220);expect(e.s.states[0].active?.lockPrice).toBe(160);e.drain();const restored=new ResumableEngine(e.config,JSON.parse(JSON.stringify(e.checkpoint())));bar(e,60000,150,140,155,145);bar(restored,60000,150,140,155,145);expect(restored.drain()).toEqual(e.drain());expect(e.finish().totalTrades).toBe(1);});
 it('does not alter fixed risk-reward target when lock lifts stop',()=>{const e=setup();e.config.exitConfig.takeProfit={type:'risk_reward',ratio:20};bar(e,30000,150,100,155);bar(e,60000,200,140,210);expect(e.drain().trades).toHaveLength(0);});
 it('fixed take profit can exit before lock activates',()=>{const e=setup();e.config.exitConfig.takeProfit={type:'percent',value:20};bar(e,30000,160,100,170);expect(e.drain().trades[0].exitReason).toBe('take_profit');});
 it('base stop keeps priority and costs are charged',()=>{const e=setup();bar(e,30000,150,100,160);bar(e,60000,110,80,120,85);const t=e.drain().trades[0];expect(t.exitPrice).toBe(85);expect(t.netPnl).toBeLessThan(t.grossPnl!);});
 it('additions cannot lower an activated absolute floor',()=>{const e=setup();bar(e,30000,150,100,155);e.config.positionConfig.mode='pyramiding';e.config.positionConfig.maxEntries=3;e.config.addConditionGroup={mode:'all',conditions:[{type:'candle_pattern',patterns:['long_lower_wick']}]};const s=e.s.states[0];const before=s.active!.trade.quantity;
 bar(e,60000,132,121,133,130);expect(s.active!.trade.quantity).toBeGreaterThan(before);expect(s.active!.lockPrice).toBe(120);expect(s.active!.trade.buyAmount).toBeGreaterThan(100);
 });
 it('legacy checkpoints restore only without new strategy behavior',()=>{const e=setup(),cp=e.checkpoint();cp.version=2;cp.engineVersion='portfolio-3';expect(()=>new ResumableEngine(e.config,cp)).toThrow('不兼容');e.config.exitConfig.profitLock=undefined;expect(new ResumableEngine(e.config,cp).s.version).toBe(CHECKPOINT_VERSION);});
 it('migration of a genuine old open holding preserves cash and final result',()=>{const e=setup();e.config.exitConfig.profitLock=undefined;bar(e,30000,110);e.drain();const cp=e.checkpoint();cp.version=2;cp.engineVersion='portfolio-3';const t=cp.states[0].active!.trade;for(const k of ['tradeNo','firstEntryPrice','buyAmount','buyFees','buySlippageCost','buyTaxCost'])delete (t as any)[k];const restored=new ResumableEngine(e.config,cp);bar(e,60000,80);bar(restored,60000,80);expect(restored.finish()).toEqual(e.finish());expect(restored.s.cash).toBe(e.s.cash);});
});
