import { Worker } from "bullmq";
import { Pool } from "pg";
import { runBacktest } from "@meme/engine";
import type { BacktestConfig, Candle } from "@meme/domain";
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres@localhost:5432/backtesting" });
const connection = { host: process.env.REDIS_HOST ?? "localhost", port: Number(process.env.REDIS_PORT ?? 6379), password: process.env.REDIS_PASSWORD };
async function insertMany(table: string, columns: string[], rows: unknown[][]) {
  if (!rows.length) return;
  const values: unknown[] = [];
  const placeholders = rows.map((row, rowIndex) => `(${row.map((_, colIndex) => { values.push(row[colIndex]); return `$${rowIndex * columns.length + colIndex + 1}`; }).join(",")})`).join(",");
  await pool.query(`INSERT INTO ${table}(${columns.join(",")}) VALUES ${placeholders}`, values);
}
new Worker("backtest", async job => {
  const runId = job.data.runId; await pool.query("UPDATE backtest_runs SET status='running' WHERE id=$1", [runId]);
  try {
    const run = (await pool.query("SELECT config_json FROM backtest_runs WHERE id=$1", [runId])).rows[0]; const config = run.config_json as BacktestConfig;
    const inputs = []; for (const symbol of config.symbols) { const rows = await pool.query("SELECT open_time AS time, close_time AS \"closeTime\", open, high, low, close, volume FROM public.meme_kline WHERE chain=$1 AND ca=$2 AND pair_id=$3 AND interval=$4 AND type=$5 AND open_time BETWEEN $6 AND $7 ORDER BY open_time", [symbol.chain,symbol.ca,symbol.pairId,config.interval,config.valueType,new Date(config.startTime).getTime(),new Date(config.endTime).getTime()]); inputs.push({ symbol, candles: rows.rows.map((r:any) => ({ ...r, time: Number(r.time), closeTime: Number(r.closeTime), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) })) as Candle[] }); }
    const result = runBacktest(config, inputs, async progress => { await pool.query("UPDATE backtest_runs SET progress=$1 WHERE id=$2", [progress,runId]); });
    await insertMany("backtest_signals", ["run_id","chain","ca","pair_id","time","price","signal_type","reason_json","quantity"], result.signals.map(signal => [runId,signal.symbol.chain,signal.symbol.ca,signal.symbol.pairId,signal.time,signal.price,signal.type,JSON.stringify(signal.reason),signal.quantity ?? null]));
    await insertMany("backtest_trades", ["run_id","chain","ca","pair_id","entry_time","entry_price","quantity","exit_time","exit_price","gross_pnl","fees","slippage_cost","tax_cost","net_pnl","exit_reason","holding_bars","adds_json"], result.trades.map(trade => [runId,trade.symbol.chain,trade.symbol.ca,trade.symbol.pairId,trade.entryTime,trade.entryPrice,trade.quantity,trade.exitTime ?? null,trade.exitPrice ?? null,trade.grossPnl ?? null,trade.fees,trade.slippageCost,trade.taxCost,trade.netPnl ?? null,trade.exitReason ?? null,trade.holdingBars ?? null,JSON.stringify(trade.adds)]));
    await insertMany("backtest_equity_curve", ["run_id","time","equity","cash","unrealized"], result.equity.map(point => [runId,point.time,point.equity,point.cash,point.unrealized]));
    await pool.query("INSERT INTO backtest_reports(run_id,report_json) VALUES($1,$2) ON CONFLICT(run_id) DO UPDATE SET report_json=EXCLUDED.report_json",[runId,JSON.stringify(result.report)]); await pool.query("UPDATE backtest_runs SET status='completed',progress=1,finished_at=now() WHERE id=$1",[runId]);
  } catch (error) { await pool.query("UPDATE backtest_runs SET status='failed', error_message=$1, finished_at=now() WHERE id=$2", [String(error),runId]); throw error; }
}, { connection, concurrency: 1 });
console.log("backtest worker started");
