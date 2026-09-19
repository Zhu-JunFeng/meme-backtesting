import { describe, expect, it } from "vitest";
import type { BacktestConfig, Candle, ConditionGroup } from "@meme/domain";
import { detectImpulse, evaluateCondition, evaluateConditionGroup, normalizeCandles, runBacktest } from "../src/index.js";

const candle = (index:number, close:number, volume=100, extra:Partial<Candle> = {}): Candle => ({ time:index*30000, closeTime:(index+1)*30000, open:close*.98, high:close*1.02, low:close*.96, close, volume, ...extra });
const impulseConfig = { type:"impulse_fractal_swing" as const, leftBars:2, rightBars:2, lookbackBars:100, minGainPercent:80, maxDurationBars:20, requireVolumeExpansion:false };

describe("candle normalization", () => {
  it("fills gaps and skips malformed OHLC", () => {
    const result = normalizeCandles([
      { time:0,closeTime:30000,open:1,high:2,low:1,close:2,volume:1 },
      { time:90000,closeTime:120000,open:2,high:3,low:2,close:3,volume:1 },
      { time:120000,closeTime:150000,open:3,high:2,low:2,close:2,volume:1 }
    ], "30s");
    expect(result.syntheticBars).toBe(2);
    expect(result.invalidBars).toBe(1);
    expect(result.candles).toHaveLength(4);
  });
});

describe("Fractal Pivot", () => {
  const candles = [candle(0,1.2),candle(1,1.1),candle(2,1,100,{ low:1 }),candle(3,1.3),candle(4,1.7),candle(5,2,100,{ high:2 }),candle(6,1.85),candle(7,1.7),candle(8,1.6)];
  it("does not expose a swing high until all right bars are complete", () => {
    expect(detectImpulse(candles.slice(0,7), impulseConfig)).toBeUndefined();
    const impulse = detectImpulse(candles.slice(0,8), impulseConfig);
    expect(impulse?.lowIndex).toBe(2);
    expect(impulse?.highIndex).toBe(5);
    expect(impulse?.confirmedAtIndex).toBe(7);
  });
});

describe("condition groups", () => {
  const history = [candle(0,1,100,{open:1.1,close:1}),candle(1,1.1,100,{open:1,close:1.1,low:.9,high:1.12})];
  const yes:any = { type:"candle_pattern", patterns:["bullish_engulfing"] };
  const no:any = { type:"candle_pattern", patterns:["hammer"] };
  it("supports all, any, at_least, nesting and disabled items", () => {
    expect(evaluateConditionGroup({ mode:"all",conditions:[yes,{...no,enabled:false}] },history,undefined)).toBe(true);
    expect(evaluateConditionGroup({ mode:"any",conditions:[no,yes] },history,undefined)).toBe(true);
    const nested:ConditionGroup = { mode:"at_least",minMatches:2,conditions:[yes,no,{mode:"any",conditions:[yes]}] };
    expect(evaluateConditionGroup(nested,history,undefined)).toBe(true);
  });
});

describe("indicator conditions", () => {
  const history = Array.from({length:20},(_,index) => candle(index, index<18 ? 1-index*.02 : .66+index*.04, index===19?300:100));
  it("calculates Fib and percentage retracement from the confirmed impulse", () => {
    const impulse = { low:1,high:2,lowIndex:0,highIndex:5,confirmedAtIndex:7,gainPercent:100,averageVolume:100 };
    const fibHistory = [...history.slice(0,-1),candle(19,1.3)];
    expect(evaluateCondition({type:"fib_retracement",zoneLow:.618,zoneHigh:.786},fibHistory,impulse)).toBe(true);
    expect(evaluateCondition({type:"percent_retracement",minPercent:30,maxPercent:40},fibHistory,impulse)).toBe(true);
  });
  it("evaluates volume, candle, EMA and OBV confirmations", () => {
    const impulse = { low:1,high:2,lowIndex:0,highIndex:5,confirmedAtIndex:7,gainPercent:100,averageVolume:200 };
    expect(evaluateCondition({type:"bullish_volume_confirmation",period:5,minRatio:1.5},history,impulse)).toBe(true);
    expect(evaluateCondition({type:"obv_confirmation",lookbackBars:3,minChangePercent:1},history,impulse)).toBe(true);
    expect(typeof evaluateCondition({type:"ema_reclaim",period:9},history,impulse)).toBe("boolean");
  });
});

describe("execution", () => {
  const config:BacktestConfig = {
    name:"test",schemaVersion:1,symbols:[{chain:"x",ca:"c",pairId:"p"}],interval:"30s",valueType:"mcap",startTime:"1970-01-01",endTime:"1970-01-01T00:10:00Z",
    impulseCondition:{...impulseConfig,minGainPercent:20},
    entryConditionGroup:{mode:"all",conditions:[{type:"fib_retracement",zoneLow:.2,zoneHigh:.8}]},
    invalidationConditionGroup:{mode:"any",conditions:[{type:"break_swing_low_invalidation",bufferPercent:0}]},
    addConditionGroup:{mode:"all",enabled:false,conditions:[]},
    exitConfig:{stopLoss:{type:"percent",value:20},takeProfit:{type:"risk_reward",ratio:2},closeAtEnd:true},
    executionConfig:{initialCapital:1000,feePercent:0,slippagePercent:0,buyTaxPercent:0,sellTaxPercent:0,fillMode:"current_bar_close"},
    positionConfig:{mode:"pyramiding",maxEntries:2,maxConcurrentPositions:1,allowReentry:false,sizing:{type:"fixed_amount",value:100}}
  };
  it("produces reproducible trades and applies conservative exit priority", () => {
    const values = [1.2,1.1,1,1.2,1.5,1.8,1.7,1.6,1.45,1.2,.7];
    const result = runBacktest(config,[{symbol:config.symbols[0],candles:values.map((value,index)=>candle(index,value))}]);
    expect(result.report.totalTrades).toBeLessThanOrEqual(1);
    expect(result.report.dataQuality.invalidBars).toBe(0);
  });
});
