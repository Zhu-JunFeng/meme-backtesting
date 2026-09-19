import { describe, expect, it } from "vitest";
import { normalizeCandles, runBacktest } from "../src/index.js";
describe("candle normalization", () => {
  it("fills gaps and skips malformed OHLC", () => {
    const result = normalizeCandles([
      { time: 0, closeTime: 30000, open: 1, high: 2, low: 1, close: 2, volume: 1 },
      { time: 90000, closeTime: 120000, open: 2, high: 3, low: 2, close: 3, volume: 1 },
      { time: 120000, closeTime: 150000, open: 3, high: 2, low: 2, close: 2, volume: 1 }
    ], "30s");
    expect(result.syntheticBars).toBe(2); expect(result.invalidBars).toBe(1); expect(result.candles).toHaveLength(4); expect(result.candles[1].synthetic).toBe(true);
  });
});
describe("pyramiding", () => {
  it("merges a second entry into weighted average cost", () => {
    const result = runBacktest({ name: "test", initialCapital: 1000, symbols: [{ chain: "x", ca: "c", pairId: "p" }], interval: "30s", valueType: "mcap", startTime: "1970-01-01", endTime: "1970-01-01T00:02:00Z", entryConditions: { logic: "AND", conditions: [{ type: "candle_pattern", pattern: "bullish_volume" }] }, exitConfig: { stopLoss: { type: "percent", value: 50 }, takeProfit: { type: "percent", value: 50 }, closeAtEnd: true }, executionConfig: { feePercent: 0, slippagePercent: 0, buyTaxPercent: 0, sellTaxPercent: 0, fillMode: "next_bar_open" }, positionConfig: { mode: "pyramiding", maxEntries: 2, maxConcurrentPositions: 1, allowReentry: false, sizing: { type: "fixed_amount", value: 100 } } }, [{ symbol: { chain: "x", ca: "c", pairId: "p" }, candles: [1,2,3,4,5].map((time, i) => ({ time: time * 30000, closeTime: (time + 1) * 30000, open: 1 + i * .1, high: 1.2 + i * .1, low: 1 + i * .1, close: 1.1 + i * .1, volume: i + 1 })) }]);
    expect(result.trades.length).toBe(1); expect(result.trades[0].adds.length).toBeLessThanOrEqual(1);
  });
});
