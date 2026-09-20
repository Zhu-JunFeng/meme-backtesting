import "reflect-metadata";
import { locate } from './locator.js';
import { marketCas, resolveDataset, datasetCounts, resultRows, runCas } from "./datasets.js";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { NestFactory } from "@nestjs/core";
import { Module, Controller, Get, Post, Patch, Param, Body, Query, Injectable, NotFoundException, BadRequestException, ConflictException, Inject } from "@nestjs/common";
import { Pool, type PoolClient } from "pg";
import { Queue } from "bullmq";
import { createQueue, queuePrefix, RUNTIME_VERSION, enqueue, reconcile, actions, stopRun, retryRun, rerun } from '@meme/runtime';
import type { BacktestConfig, Condition, ConditionDefinition, ConditionGroup, CreateBacktestRequest, DatasetConfig, StrategyConfig } from "@meme/domain";

type Validator = ((value: unknown) => boolean) & { errors?: unknown };
type AjvInstance = { compile(schema: Record<string, unknown>): Validator; errorsText(errors?: unknown): string };
const AjvConstructor = createRequire(import.meta.url)("ajv") as new (options?: Record<string, unknown>) => AjvInstance;
const ajv = new AjvConstructor({ allErrors: true, strict: false });
const AVAILABLE_DATA = new Set(["ohlcv"]);
const asNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const isGroup = (value: Condition | ConditionGroup): value is ConditionGroup => "conditions" in value;
const checksum = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

@Injectable()
export class AppService {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres@localhost:5432/backtesting" });
  readonly queue = createQueue();
  private recoveryTimer?:ReturnType<typeof setInterval>;
  private reconciling=false;
  onModuleInit(){this.recoveryTimer=setInterval(async()=>{if(this.reconciling)return;this.reconciling=true;try{await reconcile(this.pool,this.queue);}catch(e){console.error('任务协调失败',String(e));}finally{this.reconciling=false;}},5000);}
  async onModuleDestroy(){clearInterval(this.recoveryTimer);await this.queue.close();await this.pool.end();}

  async projects() {
    const { rows } = await this.pool.query('SELECT chain,ca,pair_id AS "pairId",MIN(open_time) AS "minTime",MAX(open_time) AS "maxTime",array_agg(DISTINCT interval ORDER BY interval) AS intervals,array_agg(DISTINCT type ORDER BY type) AS types FROM public.meme_kline WHERE valid IS DISTINCT FROM false GROUP BY chain,ca,pair_id ORDER BY chain,ca');
    return rows;
  }

  async candles(query: Record<string, string>) {
    if (query.runId) {
      const run=await this.backtest(query.runId);
      const config = run.config_json as BacktestConfig;
      const symbol = config.symbols.find(s=>s.chain===query.chain && s.ca===query.ca && s.pairId===query.pairId);
      if (!symbol) throw new BadRequestException("交易池不属于该任务");
      const snapshot=config.pools?.find(s=>s.chain===symbol.chain && s.ca===symbol.ca && s.pairId===symbol.pairId);
      if(snapshot?.noData) return [];
      query={...query,interval:config.interval,type:config.valueType,
        from:String(Math.max(Number(query.from)||0,snapshot?.startTime ?? (config.startTime ? Date.parse(config.startTime):0))),
        to:String(Math.min(Number(query.to)||Date.now(),snapshot?.endTime ?? (config.endTime ? Date.parse(config.endTime):Date.now())))};
      if(run.input_ready){const rows=(await this.pool.query(`SELECT b FROM backtest_input_chunks c CROSS JOIN LATERAL jsonb_array_elements(c.candles_json) b WHERE c.run_id=$1 AND c.pool_key=$2 AND (b->>'time')::bigint BETWEEN $3 AND $4 ORDER BY (b->>'time')::bigint DESC LIMIT $5`,[run.id,`${symbol.chain}:${symbol.ca}:${symbol.pairId}`,Number(query.from),Number(query.to),Math.min(5000,Math.max(1,Number(query.limit)||5000))])).rows;return rows.reverse().map(r=>r.b);}
    }
    const params = [query.chain, query.ca, query.pairId, query.interval ?? "30s", query.type ?? "mcap", query.from ? Number(query.from) : 0, query.to ? Number(query.to) : Date.now()];
    const limit=Math.min(5000,Math.max(1,Number(query.limit)||5000));
    const { rows } = await this.pool.query('SELECT * FROM (SELECT open_time AS time, close_time AS "closeTime", open, high, low, close, volume FROM public.meme_kline WHERE chain=$1 AND ca=$2 AND pair_id=$3 AND interval=$4 AND type=$5 AND valid IS DISTINCT FROM false AND open_time BETWEEN $6 AND $7 ORDER BY open_time DESC LIMIT $8) candles ORDER BY time', [...params,limit]);
    return rows.map((row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? Number(value) : value])));
  }

  async conditionDefinitions(code?: string): Promise<ConditionDefinition[] | ConditionDefinition> {
    const where = code ? "WHERE code=$1" : "";
    const result = await this.pool.query(`SELECT id,code,name,category,description,parameter_schema AS "parameterSchema",default_parameters AS "defaultParameters",implementation_version AS "implementationVersion",enabled,data_requirements AS "dataRequirements" FROM backtest_condition_definitions ${where} ORDER BY category,name`, code ? [code] : []);
    if (code && !result.rowCount) throw new NotFoundException("配置项不存在");
    return code ? result.rows[0] : result.rows;
  }

  async definitionMap() {
    const definitions = await this.conditionDefinitions() as ConditionDefinition[];
    return new Map(definitions.map(definition => [definition.code, definition]));
  }

  async validateStrategy(strategy: StrategyConfig) {
    if (!strategy || strategy.schemaVersion !== 1) throw new BadRequestException("只支持 schemaVersion=1 的策略配置");
    if (strategy.impulseCondition?.type !== "impulse_fractal_swing") throw new BadRequestException("必须配置 Fractal Pivot 拉升识别");
    const definitions = await this.definitionMap();
    const validateItem = (item: Condition | ConditionGroup, path: string) => {
      if (item.enabled === false) return;
      if (isGroup(item)) {
        if (!["all", "any", "at_least"].includes(item.mode)) throw new BadRequestException(`${path} 条件组模式无效`);
        const active = item.conditions.filter(condition => condition.enabled !== false);
        if (!active.length) throw new BadRequestException(`${path} 至少需要一个已启用条件`);
        if (item.mode === "at_least" && (!Number.isInteger(item.minMatches) || (item.minMatches ?? 0) < 1 || (item.minMatches ?? 0) > active.length)) throw new BadRequestException(`${path} 的 minMatches 超出有效条件数量`);
        item.conditions.forEach((condition, index) => validateItem(condition, `${path}.${index + 1}`));
        return;
      }
      const definition = definitions.get(item.type);
      if (!definition) throw new BadRequestException(`${path} 使用了未知配置项 ${item.type}`);
      if (!definition.enabled) throw new BadRequestException(`${definition.name} 缺少历史数据，暂不可启用`);
      const missing = definition.dataRequirements.filter(requirement => !AVAILABLE_DATA.has(requirement));
      if (missing.length) throw new BadRequestException(`${definition.name} 缺少数据：${missing.join(", ")}`);
      const validate = ajv.compile(definition.parameterSchema);
      if (!validate(item)) throw new BadRequestException(`${definition.name} 参数无效：${ajv.errorsText(validate.errors)}`);
      if (item.type === "fib_retracement" && item.zoneLow > item.zoneHigh) throw new BadRequestException("Fib 区间起点不能大于终点");
      if (item.type === "percent_retracement" && item.minPercent > item.maxPercent) throw new BadRequestException("百分比回撤最小值不能大于最大值");
    };
    const impulseDefinition = definitions.get(strategy.impulseCondition.type);
    if (!impulseDefinition || !ajv.compile(impulseDefinition.parameterSchema)(strategy.impulseCondition)) throw new BadRequestException("拉升识别参数无效");
    validateItem(strategy.entryConditionGroup, "入场条件");
    validateItem(strategy.invalidationConditionGroup, "失效条件");
    if (strategy.addConditionGroup && strategy.addConditionGroup.enabled !== false) validateItem(strategy.addConditionGroup!, "加仓条件");
    if (!asNumber(strategy.executionConfig?.initialCapital) || strategy.executionConfig.initialCapital <= 0) throw new BadRequestException("初始资金必须大于 0");
    for (const key of ["feePercent", "slippagePercent", "buyTaxPercent", "sellTaxPercent"] as const) if (!asNumber(strategy.executionConfig[key]) || strategy.executionConfig[key] < 0) throw new BadRequestException(`${key} 必须是非负数`);
    if (strategy.executionConfig.fillMode !== "current_bar_close") throw new BadRequestException("首期仅支持当前 K 线收盘成交");
    if (!strategy.positionConfig || !["single_entry", "pyramiding"].includes(strategy.positionConfig.mode) || strategy.positionConfig.maxEntries < 1 || strategy.positionConfig.maxConcurrentPositions < 1 || !asNumber(strategy.positionConfig.sizing?.value) || strategy.positionConfig.sizing.value <= 0) throw new BadRequestException("仓位参数无效");
    if (strategy.positionConfig.mode === "single_entry" && strategy.positionConfig.maxEntries !== 1) throw new BadRequestException("单次买入模式的最大买入次数必须为 1");
    const stop = strategy.exitConfig?.stopLoss;
    const target = strategy.exitConfig?.takeProfit;
    if (!stop || !target) throw new BadRequestException("止盈止损配置不能为空");
    if (stop.type === "percent" && (!asNumber(stop.value) || stop.value <= 0 || stop.value >= 100)) throw new BadRequestException("固定止损比例必须在 0 到 100 之间");
    if (stop.type === "fib_level" && (!asNumber(stop.ratio) || stop.ratio <= 0 || stop.ratio >= 1)) throw new BadRequestException("止损 Fib 位无效");
    if (stop.type === "swing_low" && (!asNumber(stop.bufferPercent) || stop.bufferPercent < 0)) throw new BadRequestException("Swing Low 止损缓冲无效");
    if (target.type === "percent" && (!asNumber(target.value) || target.value <= 0)) throw new BadRequestException("固定止盈比例必须大于 0");
    if (target.type === "risk_reward" && (!asNumber(target.ratio) || target.ratio <= 0)) throw new BadRequestException("盈亏比必须大于 0");
    return strategy;
  }

  async templates() {
    return (await this.pool.query('SELECT t.id,t.name,t.description,t.status,t.current_version_id AS "currentVersionId",v.version AS "currentVersion",t.created_at AS "createdAt",t.updated_at AS "updatedAt" FROM backtest_strategy_templates t LEFT JOIN backtest_strategy_versions v ON v.id=t.current_version_id ORDER BY (t.status=\'active\') DESC,t.updated_at DESC')).rows;
  }

  async template(id: string) {
    const result = await this.pool.query('SELECT t.id,t.name,t.description,t.status,t.current_version_id AS "currentVersionId",v.version AS "currentVersion",v.strategy_json AS "strategyJson",t.created_at AS "createdAt",t.updated_at AS "updatedAt" FROM backtest_strategy_templates t LEFT JOIN backtest_strategy_versions v ON v.id=t.current_version_id WHERE t.id=$1', [id]);
    if (!result.rowCount) throw new NotFoundException("策略模板不存在");
    return result.rows[0];
  }

  async createTemplate(body: { name?: string; description?: string; status?: string; strategyJson?: StrategyConfig }) {
    if (!body.name?.trim()) throw new BadRequestException("策略名称不能为空");
    if (body.status && !["draft", "active", "archived"].includes(body.status)) throw new BadRequestException("模板状态无效");
    if (body.strategyJson) await this.validateStrategy(body.strategyJson);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const template = (await client.query("INSERT INTO backtest_strategy_templates(name,description,status) VALUES($1,$2,$3) RETURNING id", [body.name.trim(), body.description ?? "", body.status ?? "draft"])).rows[0];
      if (body.strategyJson) await this.insertVersion(client, template.id, body.strategyJson);
      await client.query("COMMIT");
      return this.template(template.id);
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async patchTemplate(id: string, body: { name?: string; description?: string; status?: string }) {
    if (body.status && !["draft", "active", "archived"].includes(body.status)) throw new BadRequestException("模板状态无效");
    const result = await this.pool.query("UPDATE backtest_strategy_templates SET name=COALESCE($2,name),description=COALESCE($3,description),status=COALESCE($4,status),updated_at=now() WHERE id=$1 RETURNING id", [id, body.name?.trim() || null, body.description ?? null, body.status ?? null]);
    if (!result.rowCount) throw new NotFoundException("策略模板不存在");
    return this.template(id);
  }

  private async insertVersion(client: PoolClient, templateId: string, strategy: StrategyConfig) {
    await client.query("SELECT id FROM backtest_strategy_templates WHERE id=$1 FOR UPDATE", [templateId]);
    const next = Number((await client.query("SELECT COALESCE(MAX(version),0)+1 AS version FROM backtest_strategy_versions WHERE template_id=$1", [templateId])).rows[0].version);
    const inserted = (await client.query('INSERT INTO backtest_strategy_versions(template_id,version,schema_version,strategy_json,checksum) VALUES($1,$2,$3,$4,$5) RETURNING id,template_id AS "templateId",version,schema_version AS "schemaVersion",strategy_json AS "strategyJson",checksum,created_at AS "createdAt"', [templateId, next, strategy.schemaVersion, JSON.stringify(strategy), checksum(strategy)])).rows[0];
    await client.query("UPDATE backtest_strategy_templates SET current_version_id=$2,updated_at=now() WHERE id=$1", [templateId, inserted.id]);
    return inserted;
  }

  async createVersion(templateId: string, strategy: StrategyConfig) {
    await this.template(templateId);
    await this.validateStrategy(strategy);
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const result = await this.insertVersion(client, templateId, strategy); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async versions(templateId: string) {
    await this.template(templateId);
    return (await this.pool.query('SELECT id,template_id AS "templateId",version,schema_version AS "schemaVersion",strategy_json AS "strategyJson",checksum,created_at AS "createdAt" FROM backtest_strategy_versions WHERE template_id=$1 ORDER BY version DESC', [templateId])).rows;
  }

  async version(id: string) {
    const result = await this.pool.query('SELECT v.id,v.template_id AS "templateId",v.version,v.schema_version AS "schemaVersion",v.strategy_json AS "strategyJson",v.checksum,v.created_at AS "createdAt",t.name AS "templateName",t.description AS "templateDescription" FROM backtest_strategy_versions v JOIN backtest_strategy_templates t ON t.id=v.template_id WHERE v.id=$1', [id]);
    if (!result.rowCount) throw new NotFoundException("策略版本不存在");
    return result.rows[0];
  }

  async cloneVersion(id: string, body: { name?: string; description?: string }) {
    const source = await this.version(id);
    return this.createTemplate({ name: body.name?.trim() || `${source.templateName} 副本`, description: body.description ?? source.templateDescription, status: "draft", strategyJson: source.strategyJson });
  }


  async createBacktest(request: CreateBacktestRequest) {
    if (!request.name?.trim() || !request.strategyVersionId) throw new BadRequestException("任务名称和策略版本不能为空");
    const dataset = await resolveDataset(this.pool, request.dataset);
    const version = await this.version(request.strategyVersionId);
    const strategy = structuredClone(version.strategyJson) as StrategyConfig;
    const overrides = request.executionOverrides ?? {};
    const allowedOverrides = new Set(["initialCapital", "feePercent", "slippagePercent", "buyTaxPercent", "sellTaxPercent"]);
    for (const [key, value] of Object.entries(overrides)) {
      if (!allowedOverrides.has(key)) throw new BadRequestException(`${key} 不是允许的运行覆盖项`);
      if (!asNumber(value) || Number(value) < 0) throw new BadRequestException(`${key} 覆盖值必须是非负数`);
    }
    strategy.executionConfig = { ...strategy.executionConfig, ...overrides };
    await this.validateStrategy(strategy);
    const config: BacktestConfig = { name: request.name.trim(), strategyTemplateId: version.templateId, strategyVersionId: version.id, ...dataset, ...strategy };
    const { rows } = await this.pool.query("INSERT INTO backtest_runs(name,status,strategy_template_id,strategy_version_id,dataset_json,config_json,progress,runtime_version,queue_scope,phase) VALUES($1,'pending',$2,$3,$4,$5,0,$6,$7,'freezing') RETURNING id,status,progress,dispatch_no", [config.name, version.templateId, version.id, JSON.stringify(dataset), JSON.stringify(config),RUNTIME_VERSION,queuePrefix()]);
    try { await enqueue(this.queue,rows[0]); }
    catch (error) { await this.pool.query("UPDATE backtest_runs SET status='failed',error_message=$2,finished_at=now() WHERE id=$1", [rows[0].id, `队列提交失败：${String(error)}`]); throw new ConflictException("任务已保存，但提交执行队列失败"); }
    return rows[0];
  }

  async listBacktests() {
    return (await this.pool.query('SELECT r.id,r.name,r.status,r.progress,r.phase,r.runtime_version,r.queue_scope,r.heartbeat_at,r.checkpoint_at,r.recovery_count,r.created_at AS "createdAt",r.finished_at AS "finishedAt",r.strategy_version_id AS "strategyVersionId",t.name AS "strategyName",v.version AS "strategyVersion" FROM backtest_runs r LEFT JOIN backtest_strategy_templates t ON t.id=r.strategy_template_id LEFT JOIN backtest_strategy_versions v ON v.id=r.strategy_version_id ORDER BY r.created_at DESC')).rows.map(r=>({...r,actions:actions(r)}));
  }

  async backtest(id: string) {
    const result = await this.pool.query('SELECT r.*,t.name AS strategy_name,v.version AS strategy_version FROM backtest_runs r LEFT JOIN backtest_strategy_templates t ON t.id=r.strategy_template_id LEFT JOIN backtest_strategy_versions v ON v.id=r.strategy_version_id WHERE r.id=$1', [id]);
    if (!result.rowCount) throw new NotFoundException("回测任务不存在");
    return {...result.rows[0],actions:actions(result.rows[0])};
  }
}

const periods = new Set(["30s", "1m", "5m", "15m", "1h", "4h", "1d"]);

@Controller("api")
class AppController {
  constructor(@Inject(AppService) private readonly service: AppService) {}
  @Get("market/cas") cas(@Query() query: Record<string,string>) { return marketCas(this.service.pool,query); }
  @Post("market/dataset-preview") async preview(@Body() body: CreateBacktestRequest["dataset"]) { const dataset=await resolveDataset(this.service.pool,body); return {dataset,...datasetCounts(dataset)}; }
  @Get("market/chains") async chains() { return (await this.service.pool.query("SELECT DISTINCT chain FROM public.meme_kline ORDER BY chain")).rows.map(r=>r.chain); }
  @Get("market/projects") projects() { return this.service.projects(); }
  @Get("market/candles") candles(@Query() query: Record<string,string>) { return this.service.candles(query); }
  @Get("condition-definitions") definitions() { return this.service.conditionDefinitions(); }
  @Get("condition-definitions/:code") definition(@Param("code") code: string) { return this.service.conditionDefinitions(code); }
  @Get("strategy-templates") templates() { return this.service.templates(); }
  @Post("strategy-templates") createTemplate(@Body() body: any) { return this.service.createTemplate(body); }
  @Get("strategy-templates/:id") template(@Param("id") id: string) { return this.service.template(id); }
  @Patch("strategy-templates/:id") patchTemplate(@Param("id") id: string, @Body() body: any) { return this.service.patchTemplate(id, body); }
  @Post("strategy-templates/:id/versions") createVersion(@Param("id") id: string, @Body() body: StrategyConfig | { strategyJson: StrategyConfig }) { return this.service.createVersion(id, "strategyJson" in body ? body.strategyJson : body); }
  @Get("strategy-templates/:id/versions") versions(@Param("id") id: string) { return this.service.versions(id); }
  @Get("strategy-versions/:id") version(@Param("id") id: string) { return this.service.version(id); }
  @Post("strategy-versions/:id/clone") clone(@Param("id") id: string, @Body() body: any) { return this.service.cloneVersion(id, body); }
  @Get("backtests") list() { return this.service.listBacktests(); }
  @Get("backtests/:id") one(@Param("id") id: string) { return this.service.backtest(id); }
  @Post("backtests") create(@Body() body: CreateBacktestRequest) { return this.service.createBacktest(body); }
  @Post("backtests/:id/stop") async stop(@Param("id") id:string){const run=await this.service.backtest(id);if(run.runtime_version!==RUNTIME_VERSION || run.queue_scope!==queuePrefix())throw new ConflictException('旧执行器或其他环境的任务不能在此安全停止，请先盘点执行器');await stopRun(this.service.pool,id);return this.service.backtest(id);}
  @Post("backtests/:id/cancel") cancel(@Param("id") id:string){return this.stop(id);}
  @Post("backtests/:id/retry") async retry(@Param("id") id:string){const run=await this.service.backtest(id);if(!run.actions.retry && !['pending','running'].includes(run.status))throw new ConflictException('该任务不支持断点重试，请重新回测');await retryRun(this.service.pool,this.service.queue,id);return this.service.backtest(id);}
  @Post("backtests/:id/rerun") async rerun(@Param("id") id:string,@Body() body:{requestId:string}){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body?.requestId ?? ''))throw new BadRequestException('需要 requestId 作为幂等标识');return rerun(this.service.pool,this.service.queue,id,body.requestId);}
  @Get("backtests/:id/report") async report(@Param("id") id: string) { const result = await this.service.pool.query("SELECT report_json FROM backtest_reports WHERE run_id=$1", [id]); return result.rows[0]?.report_json ?? null; }
  @Get("backtests/:id/trades") trades(@Param("id") id:string,@Query() q:Record<string,string>) { return resultRows(this.service.pool,id,"trades",q); }
  @Get("backtests/:id/signals") signals(@Param("id") id:string,@Query() q:Record<string,string>) { return resultRows(this.service.pool,id,"signals",q); }
  @Get("backtests/:id/cas") async runCas(@Param("id") id:string,@Query() q:Record<string,string>) { return runCas(this.service.pool,await this.service.backtest(id),q); }
  @Get("backtests/:id/ca") async runCa(@Param("id") id:string,@Query() q:Record<string,string>) { return runCas(this.service.pool,await this.service.backtest(id),q,true); }
  @Get("backtests/:id/equity") async equity(@Param("id") id:string) { return (await this.service.pool.query("SELECT time,equity,cash,unrealized FROM (SELECT *,ROW_NUMBER() OVER(ORDER BY time) AS rn,COUNT(*) OVER() AS total FROM backtest_equity_curve WHERE run_id=$1) points WHERE rn=1 OR rn=total OR rn % GREATEST(total/2000,1)=0 ORDER BY time",[id])).rows; }
  @Get('backtests/:id/locate') async locate(@Param('id') id:string,@Query() q:Record<string,string>){return locate(this.service.pool,await this.service.backtest(id),q);}
  @Get("tv/config") config() { return { supports_search: false, supports_group_request: false, supports_marks: false, supports_timescale_marks: false, supported_resolutions: ["30S","1","5","15","60","240","D"] }; }
  @Get("tv/time") time() { return Math.floor(Date.now() / 1000); }
  @Get("tv/symbols") symbols(@Query("symbol") symbol: string) { const [exchange, ca, pairId, type] = (symbol ?? "").split(":"); return { name: symbol, ticker: symbol, description: `${exchange} ${ca}`, type: "crypto", session: "24x7", timezone: "Etc/UTC", exchange, minmov: 1, pricescale: 1000000, has_intraday: true, has_seconds: true, seconds_multipliers: ["30"], supported_resolutions: ["30S","1","5","15","60","240","D"], volume_precision: 4, data_status: "endofday", pairId, valueType: type }; }
  @Get("tv/history") async history(@Query() query: Record<string,string>) { const [chain, ca, pairId, type] = (query.symbol ?? "").split(":"); const resolution: Record<string,string> = { "30S": "30s", "1": "1m", "5": "5m", "15": "15m", "60": "1h", "240": "4h", "D": "1d" }; const rows = await this.service.candles({ chain, ca, pairId, interval: resolution[query.resolution] ?? "30s", type: type ?? "mcap", runId:query.runId, from: query.countBack ? "0" : String(Number(query.from) * 1000), to: String(Number(query.to) * 1000 - 1), limit:query.countBack }); if (!rows.length) return { s: "no_data" }; return { s: "ok", t: rows.map((row:any) => Math.floor(row.time / 1000)), o: rows.map((row:any) => row.open), h: rows.map((row:any) => row.high), l: rows.map((row:any) => row.low), c: rows.map((row:any) => row.close), v: rows.map((row:any) => row.volume) }; }
}

@Module({ controllers: [AppController], providers: [AppService] }) class AppModule {}
if (process.env.NODE_ENV !== "test") NestFactory.create(AppModule).then(app => { app.enableCors();app.enableShutdownHooks(); app.listen(Number(process.env.PORT ?? 3000)); });
