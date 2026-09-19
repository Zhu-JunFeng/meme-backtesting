import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Module, Controller, Get, Post, Param, Body, Query, Injectable, NotFoundException, Inject } from "@nestjs/common";
import { Pool } from "pg";
import { Queue } from "bullmq";
import type { BacktestConfig } from "@meme/domain";

@Injectable()
class AppService {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres@localhost:5432/backtesting" });
  readonly queue = new Queue("backtest", { connection: { host: process.env.REDIS_HOST ?? "localhost", port: Number(process.env.REDIS_PORT ?? 6379), password: process.env.REDIS_PASSWORD } });
  async projects() { const { rows } = await this.pool.query("SELECT DISTINCT chain, ca, pair_id AS \"pairId\" FROM public.meme_kline ORDER BY chain, ca"); return rows; }
  async candles(query: Record<string, string>) { const params = [query.chain, query.ca, query.pairId, query.interval ?? "30s", query.type ?? "mcap", query.from ? Number(query.from) : 0, query.to ? Number(query.to) : Date.now()]; const { rows } = await this.pool.query("SELECT open_time AS time, close_time AS \"closeTime\", open, high, low, close, volume FROM public.meme_kline WHERE chain=$1 AND ca=$2 AND pair_id=$3 AND interval=$4 AND type=$5 AND open_time BETWEEN $6 AND $7 ORDER BY open_time", params); return rows.map((r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k,v]) => [k, typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : v]))); }
  async create(config: BacktestConfig) { const { rows } = await this.pool.query("INSERT INTO backtest_runs(name,status,config_json,progress) VALUES($1,'pending',$2,0) RETURNING id,status,progress", [config.name, JSON.stringify(config)]); await this.queue.add("run", { runId: rows[0].id }); return rows[0]; }
  async list() { return (await this.pool.query("SELECT id,name,status,progress,created_at,finished_at FROM backtest_runs ORDER BY created_at DESC")).rows; }
  async one(id: string) { const result = await this.pool.query("SELECT * FROM backtest_runs WHERE id=$1", [id]); if (!result.rowCount) throw new NotFoundException(); return result.rows[0]; }
}

@Controller("api")
class AppController {
  constructor(@Inject(AppService) private readonly service: AppService) {}
  @Get("market/projects") projects() { return this.service.projects(); }
  @Get("market/candles") candles(@Query() query: Record<string,string>) { return this.service.candles(query); }
  @Get("backtests") list() { return this.service.list(); }
  @Get("backtests/:id") one(@Param("id") id: string) { return this.service.one(id); }
  @Post("backtests") create(@Body() body: BacktestConfig) { return this.service.create(body); }
  @Post("backtests/:id/cancel") async cancel(@Param("id") id: string) { await this.service.pool.query("UPDATE backtest_runs SET status='cancelled', finished_at=now() WHERE id=$1 AND status IN ('pending','running')", [id]); return this.service.one(id); }
  @Get("backtests/:id/report") async report(@Param("id") id: string) { const result = await this.service.pool.query("SELECT report_json FROM backtest_reports WHERE run_id=$1", [id]); return result.rows[0]?.report_json ?? null; }
  @Get("backtests/:id/trades") async trades(@Param("id") id: string) { return (await this.service.pool.query("SELECT * FROM backtest_trades WHERE run_id=$1 ORDER BY entry_time", [id])).rows; }
  @Get("backtests/:id/signals") async signals(@Param("id") id: string) { return (await this.service.pool.query("SELECT * FROM backtest_signals WHERE run_id=$1 ORDER BY time", [id])).rows; }
  @Get("tv/config") config() { return { supports_search: false, supports_group_request: false, supports_marks: false, supports_timescale_marks: false, supported_resolutions: ["30S","1","5","15","60","240","D"] }; }
  @Get("tv/time") time() { return Math.floor(Date.now() / 1000); }
  @Get("tv/symbols") symbols(@Query("symbol") symbol: string) { const [exchange, ca, pairId, type] = (symbol ?? "").split(":"); return { name: symbol, ticker: symbol, description: `${exchange} ${ca}`, type: "crypto", session: "24x7", timezone: "Etc/UTC", exchange, minmov: 1, pricescale: 1000000, has_intraday: true, supported_resolutions: ["30S","1","5","15","60","240","D"], volume_precision: 4, data_status: "endofday", pairId, valueType: type }; }
  @Get("tv/history") async history(@Query() query: Record<string,string>) { const [chain, ca, pairId, type] = (query.symbol ?? "").split(":"); const rows = await this.candles({ chain, ca, pairId, interval: query.resolution === "30S" ? "30s" : "1m", type: type ?? "mcap", from: String(Number(query.from) * 1000), to: String(Number(query.to) * 1000) }); if (!rows.length) return { s: "no_data" }; return { s: "ok", t: rows.map((r:any) => Math.floor(r.time / 1000)), o: rows.map((r:any) => r.open), h: rows.map((r:any) => r.high), l: rows.map((r:any) => r.low), c: rows.map((r:any) => r.close), v: rows.map((r:any) => r.volume) }; }
}

@Module({ controllers: [AppController], providers: [AppService] }) class AppModule {}
NestFactory.create(AppModule).then(app => { app.enableCors(); app.listen(Number(process.env.PORT ?? 3000)); });
