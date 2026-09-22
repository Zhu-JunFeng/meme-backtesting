import {it,expect} from 'vitest';
import {generateStrategyDescription} from '../src/strategy-description.js';
import type {StrategyConfig} from '../src/index.js';
const config=():StrategyConfig=>({schemaVersion:1,impulseCondition:{type:'impulse_fractal_swing',leftBars:2,rightBars:3,lookbackBars:120,minGainPercent:80,maxDurationBars:100,requireVolumeExpansion:true,volumeExpansionRatio:1.5},entryConditionGroup:{mode:'all',conditions:[{type:'fib_retracement',zoneLow:.618,zoneHigh:.786},{mode:'at_least',minMatches:1,conditions:[{type:'rsi_recovery',period:14,oversold:30,recovery:35},{type:'ema_reclaim',period:9,enabled:false}]}]},invalidationConditionGroup:{mode:'any',conditions:[{type:'break_swing_low_invalidation',bufferPercent:2}]},positionConfig:{mode:'pyramiding',maxEntries:3,maxConcurrentPositions:4,allowReentry:false,sizing:{type:'risk_percent',value:1}},executionConfig:{initialCapital:10000,feePercent:.5,slippagePercent:1,buyTaxPercent:2,sellTaxPercent:3,fillMode:'current_bar_close'},exitConfig:{stopLoss:{type:'fib_level',ratio:.886,bufferPercent:1},takeProfit:{type:'risk_reward',ratio:2},maxHoldingBars:100,closeAtEnd:true,profitLock:{enabled:true,tiers:[{activationPercent:50,floorPercent:20},{activationPercent:100,floorPercent:60}]}}});
it('deterministic full prose preserves exact thresholds, nested groups, disabled conditions and notes without modifying strategy',()=>{
 const s=config(),original=JSON.stringify(s),d=generateStrategyDescription(s,'<script>note</script>\n备注');
 expect(d).toEqual(generateStrategyDescription(s,'<script>note</script>\n备注'));expect(JSON.stringify(s)).toBe(original);
 for(const text of ['0.618–0.786','右侧 3 根','全部满足','至少满足 1 项','[已禁用]','RSI','Fib 0.886 下方 1%','下一根才启用','盈利≥100% → 保底 60%','手续费 0.5%','卖出税 3%','10% 的估算距离','每个池平仓后不再入场','未配置加仓组','开盘时间必须严格晚于','末根新买入'])expect(d.generatedText).toContain(text);
 expect(d.notes).toBe('<script>note</script>\n备注');expect(d.generatorVersion).toBe(1);
});
it('distinguishes disabled group, no signal gate, closeAtEnd false and enabled lock false',()=>{
 const s=config();s.entryAfterSignal=false;s.addConditionGroup={enabled:false,mode:'any',conditions:[]};s.exitConfig.closeAtEnd=false;s.exitConfig.profitLock!.enabled=false;
 const d=generateStrategyDescription(s).generatedText;
 expect(d).toContain('不限制信号前买入');expect(d).toContain('不自动回退入场组');expect(d).toContain('数据结束不强制卖出');expect(d).toContain('动态锁盈\n未启用');
});
it('describes every currently supported condition without hiding its thresholds',()=>{
 const s=config();s.entryConditionGroup={mode:'any',conditions:[{type:'percent_retracement',minPercent:20,maxPercent:40},{type:'volume_contraction',period:5,maxRatio:.7},{type:'bullish_volume_confirmation',period:8,minRatio:2},{type:'candle_pattern',patterns:['hammer','bullish_engulfing','pin_bar','long_lower_wick']},{type:'obv_confirmation',lookbackBars:10,minChangePercent:15},{type:'break_fib_invalidation',ratio:.886,bufferPercent:2},{type:'bearish_volume_invalidation',period:9,minRatio:3,minBodyPercent:25}]};
 const d=generateStrategyDescription(s).generatedText;for(const t of ['20%–40%','≤ 0.7','此前最多 8 根','锤子线','Pin Bar','长下影','阳线吞没','OBV','15%','实体跌幅≥25%'])expect(d).toContain(t);
 expect(()=>generateStrategyDescription(s,'x'.repeat(20001))).toThrow('20000');
});
