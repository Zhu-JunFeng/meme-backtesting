CREATE TABLE IF NOT EXISTS backtest_condition_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NOT NULL,
  description text NOT NULL DEFAULT '',
  parameter_schema jsonb NOT NULL,
  default_parameters jsonb NOT NULL,
  implementation_version text NOT NULL DEFAULT '1.0.0',
  enabled boolean NOT NULL DEFAULT true,
  data_requirements jsonb NOT NULL DEFAULT '["ohlcv"]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS backtest_strategy_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS backtest_strategy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES backtest_strategy_templates(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  schema_version integer NOT NULL DEFAULT 1,
  strategy_json jsonb NOT NULL,
  checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(template_id, version)
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backtest_strategy_templates_current_version_fk') THEN
    ALTER TABLE backtest_strategy_templates ADD CONSTRAINT backtest_strategy_templates_current_version_fk FOREIGN KEY (current_version_id) REFERENCES backtest_strategy_versions(id) ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS strategy_template_id uuid REFERENCES backtest_strategy_templates(id) ON DELETE RESTRICT;
ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS strategy_version_id uuid REFERENCES backtest_strategy_versions(id) ON DELETE RESTRICT;
ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS dataset_json jsonb;

CREATE INDEX IF NOT EXISTS idx_strategy_versions_template ON backtest_strategy_versions(template_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_strategy_version ON backtest_runs(strategy_version_id);

CREATE OR REPLACE FUNCTION prevent_strategy_version_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '策略版本为不可变记录，不能修改或删除';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS immutable_strategy_version_update ON backtest_strategy_versions;
CREATE TRIGGER immutable_strategy_version_update BEFORE UPDATE OR DELETE ON backtest_strategy_versions FOR EACH ROW EXECUTE FUNCTION prevent_strategy_version_mutation();

INSERT INTO backtest_condition_definitions(code,name,category,description,parameter_schema,default_parameters,implementation_version,enabled,data_requirements) VALUES
('impulse_fractal_swing','Fractal Pivot 拉升','impulse','使用左右 K 线确认 Swing Low 与 Swing High，仅在右侧 K 线完成后确认，避免未来函数。',
 '{"type":"object","required":["leftBars","rightBars","lookbackBars","minGainPercent","maxDurationBars","requireVolumeExpansion"],"properties":{"leftBars":{"type":"integer","title":"左侧确认根数","minimum":1,"maximum":20},"rightBars":{"type":"integer","title":"右侧确认根数","minimum":1,"maximum":20},"lookbackBars":{"type":"integer","title":"回看根数","minimum":20,"maximum":5000},"minGainPercent":{"type":"number","title":"最小涨幅 (%)","minimum":1,"maximum":10000},"maxDurationBars":{"type":"integer","title":"最长持续 K 线","minimum":2,"maximum":2000},"requireVolumeExpansion":{"type":"boolean","title":"要求拉升放量"},"volumeExpansionRatio":{"type":"number","title":"放量倍数","minimum":0.1,"maximum":20}}}'::jsonb,
 '{"type":"impulse_fractal_swing","leftBars":2,"rightBars":2,"lookbackBars":300,"minGainPercent":80,"maxDurationBars":100,"requireVolumeExpansion":false,"volumeExpansionRatio":1.5}'::jsonb,'1.0.0',true,'["ohlcv"]'::jsonb),
('fib_retracement','Fibonacci 回撤区间','retracement','价格进入基于有效拉升计算的 Fibonacci 回撤区间。',
 '{"type":"object","required":["zoneLow","zoneHigh"],"properties":{"zoneLow":{"type":"number","title":"区间起点","enum":[0.382,0.5,0.618,0.65,0.786,0.886]},"zoneHigh":{"type":"number","title":"区间终点","enum":[0.382,0.5,0.618,0.65,0.786,0.886]}}}'::jsonb,
 '{"type":"fib_retracement","zoneLow":0.618,"zoneHigh":0.786}'::jsonb,'1.0.0',true,'["ohlcv"]'::jsonb),
('percent_retracement','自定义百分比回撤','retracement','按 Swing High 的回撤百分比判断价格区间。',
 '{"type":"object","required":["minPercent","maxPercent"],"properties":{"minPercent":{"type":"number","title":"最小回撤 (%)","minimum":0,"maximum":100},"maxPercent":{"type":"number","title":"最大回撤 (%)","minimum":0,"maximum":100}}}'::jsonb,
 '{"type":"percent_retracement","minPercent":40,"maxPercent":70}'::jsonb,'1.0.0',true,'["ohlcv"]'::jsonb),
('volume_contraction','回调成交量萎缩','volume','回调阶段平均成交量低于拉升阶段平均成交量指定比例。',
 '{"type":"object","required":["period","maxRatio"],"properties":{"period":{"type":"integer","title":"统计根数","minimum":2,"maximum":200},"maxRatio":{"type":"number","title":"最大量比","minimum":0.01,"maximum":5}}}'::jsonb,
 '{"type":"volume_contraction","period":10,"maxRatio":0.7}'::jsonb,'1.0.0',true,'["ohlcv"]'::jsonb),
('bullish_volume_confirmation','放量阳线确认','volume','当前阳线成交量相对近期均量放大。',
 '{"type":"object","required":["period","minRatio"],"properties":{"period":{"type":"integer","title":"均量周期","minimum":2,"maximum":200},"minRatio":{"type":"number","title":"最小放量倍数","minimum":0.1,"maximum":20}}}'::jsonb,
 '{"type":"bullish_volume_confirmation","period":10,"minRatio":1.5}'::jsonb,'1.0.0',true,'["ohlcv"]'::jsonb),
('candle_pattern','反转 K 线形态','candle','支持锤子线、吞没、Pin Bar 和长下影线。',
 '{"type":"object","required":["patterns"],"properties":{"patterns":{"type":"array","title":"形态","minItems":1,"items":{"type":"string","enum":["hammer","bullish_engulfing","pin_bar","long_lower_wick"]}}}}'::jsonb,
 '{"type":"candle_pattern","patterns":["hammer","bullish_engulfing","pin_bar","long_lower_wick"]}'::jsonb,'1.0.0',true,'["ohlcv"]'::jsonb),
('rsi_recovery','RSI 超卖回升','indicator','RSI 从超卖阈值下方回升至确认阈值。',
 '{"type":"object","required":["period","oversold","recovery"],"properties":{"period":{"type":"integer","title":"RSI 周期","minimum":2,"maximum":100},"oversold":{"type":"number","title":"超卖阈值","minimum":0,"maximum":100},"recovery":{"type":"number","title":"回升阈值","minimum":0,"maximum":100}}}'::jsonb,
 '{"type":"rsi_recovery","period":14,"oversold":30,"recovery":35}'::jsonb,'1.0.0',true,'["ohlcv"]'::jsonb),
('ema_reclaim','重新站上 EMA','indicator','收盘价从 EMA 下方上穿指定周期 EMA。',
 '{"type":"object","required":["period"],"properties":{"period":{"type":"integer","title":"EMA 周期","enum":[9,21]}}}'::jsonb,
 '{"type":"ema_reclaim","period":9}'::jsonb,'1.0.0',true,'["ohlcv"]'::jsonb),
('obv_confirmation','OBV 资金回流','indicator','OBV 在指定回看区间内出现正向变化。',
 '{"type":"object","required":["lookbackBars","minChangePercent"],"properties":{"lookbackBars":{"type":"integer","title":"回看根数","minimum":2,"maximum":200},"minChangePercent":{"type":"number","title":"最小变化 (%)","minimum":0,"maximum":100}}}'::jsonb,
 '{"type":"obv_confirmation","lookbackBars":10,"minChangePercent":10}'::jsonb,'1.0.0',true,'["ohlcv"]'::jsonb),
('break_fib_invalidation','跌破 Fib 失效','invalidation','收盘价跌破指定 Fib 位及可选缓冲。',
 '{"type":"object","required":["ratio"],"properties":{"ratio":{"type":"number","title":"Fib 位","enum":[0.382,0.5,0.618,0.65,0.786,0.886]},"bufferPercent":{"type":"number","title":"缓冲 (%)","minimum":0,"maximum":20}}}'::jsonb,
 '{"type":"break_fib_invalidation","ratio":0.886,"bufferPercent":0}'::jsonb,'1.0.0',true,'["ohlcv"]'::jsonb),
('break_swing_low_invalidation','跌破 Swing Low 失效','invalidation','收盘价跌破本次拉升前低。',
 '{"type":"object","properties":{"bufferPercent":{"type":"number","title":"缓冲 (%)","minimum":0,"maximum":20}}}'::jsonb,
 '{"type":"break_swing_low_invalidation","bufferPercent":0}'::jsonb,'1.0.0',true,'["ohlcv"]'::jsonb),
('bearish_volume_invalidation','放量大阴线失效','invalidation','实体跌幅和成交量同时达到阈值时使信号失效。',
 '{"type":"object","required":["period","minRatio","minBodyPercent"],"properties":{"period":{"type":"integer","title":"均量周期","minimum":2,"maximum":200},"minRatio":{"type":"number","title":"最小放量倍数","minimum":0.1,"maximum":20},"minBodyPercent":{"type":"number","title":"最小实体跌幅 (%)","minimum":0,"maximum":100}}}'::jsonb,
 '{"type":"bearish_volume_invalidation","period":10,"minRatio":2,"minBodyPercent":8}'::jsonb,'1.0.0',true,'["ohlcv"]'::jsonb),
('liquidity_drop','流动性骤降','invalidation','需要历史流动性快照，首期不可用。','{"type":"object","properties":{"maxDropPercent":{"type":"number","title":"最大降幅 (%)"}}}'::jsonb,'{"type":"liquidity_drop","maxDropPercent":20}'::jsonb,'0.1.0',false,'["liquidity_snapshot"]'::jsonb),
('holder_change','持有人变化','indicator','需要历史持有人快照，首期不可用。','{"type":"object","properties":{}}'::jsonb,'{"type":"holder_change"}'::jsonb,'0.1.0',false,'["holder_snapshot"]'::jsonb),
('top10_concentration','Top10 持仓占比','indicator','需要历史持仓结构快照，首期不可用。','{"type":"object","properties":{}}'::jsonb,'{"type":"top10_concentration"}'::jsonb,'0.1.0',false,'["holder_snapshot"]'::jsonb),
('bundle_wallet','Bundle 钱包','indicator','需要历史 Bundle 钱包识别数据，首期不可用。','{"type":"object","properties":{}}'::jsonb,'{"type":"bundle_wallet"}'::jsonb,'0.1.0',false,'["bundle_snapshot"]'::jsonb),
('liquidity_lock','流动性锁定','indicator','需要历史流动性锁定快照，首期不可用。','{"type":"object","properties":{}}'::jsonb,'{"type":"liquidity_lock"}'::jsonb,'0.1.0',false,'["liquidity_lock_snapshot"]'::jsonb)
ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, description=EXCLUDED.description, parameter_schema=EXCLUDED.parameter_schema, default_parameters=EXCLUDED.default_parameters, implementation_version=EXCLUDED.implementation_version, enabled=EXCLUDED.enabled, data_requirements=EXCLUDED.data_requirements, updated_at=now();

DO $$
DECLARE template_id uuid; version_id uuid; strategy jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM backtest_strategy_templates WHERE name='Meme Fib 黄金口袋回撤') THEN
    strategy := '{"schemaVersion":1,"impulseCondition":{"type":"impulse_fractal_swing","leftBars":2,"rightBars":2,"lookbackBars":300,"minGainPercent":80,"maxDurationBars":100,"requireVolumeExpansion":false,"volumeExpansionRatio":1.5},"entryConditionGroup":{"mode":"all","conditions":[{"type":"fib_retracement","zoneLow":0.618,"zoneHigh":0.786},{"type":"volume_contraction","period":10,"maxRatio":0.7},{"mode":"at_least","minMatches":1,"conditions":[{"type":"candle_pattern","patterns":["hammer","bullish_engulfing","pin_bar","long_lower_wick"]},{"type":"bullish_volume_confirmation","period":10,"minRatio":1.5}]}]},"invalidationConditionGroup":{"mode":"any","conditions":[{"type":"break_fib_invalidation","ratio":0.886,"bufferPercent":0},{"type":"break_swing_low_invalidation","bufferPercent":0}]},"addConditionGroup":{"mode":"all","enabled":false,"conditions":[]},"exitConfig":{"stopLoss":{"type":"percent","value":10},"takeProfit":{"type":"risk_reward","ratio":2},"closeAtEnd":true,"maxHoldingBars":200},"positionConfig":{"mode":"single_entry","maxEntries":1,"maxConcurrentPositions":1,"allowReentry":false,"sizing":{"type":"fixed_percent","value":10}},"executionConfig":{"initialCapital":10000,"feePercent":0.3,"slippagePercent":1,"buyTaxPercent":0,"sellTaxPercent":0,"fillMode":"current_bar_close"}}'::jsonb;
    INSERT INTO backtest_strategy_templates(name,description,status) VALUES('Meme Fib 黄金口袋回撤','Fractal Pivot 拉升后进入 0.618–0.786 黄金口袋，结合缩量与反转确认。','active') RETURNING id INTO template_id;
    INSERT INTO backtest_strategy_versions(template_id,version,schema_version,strategy_json,checksum) VALUES(template_id,1,1,strategy,encode(digest(strategy::text,'sha256'),'hex')) RETURNING id INTO version_id;
    UPDATE backtest_strategy_templates SET current_version_id=version_id WHERE id=template_id;
  END IF;
END $$;

COMMENT ON TABLE backtest_condition_definitions IS '回测条件定义表，使用 JSON Schema 描述指标参数、默认值、校验规则及数据依赖。';
COMMENT ON COLUMN backtest_condition_definitions.id IS '配置项定义唯一标识。';
COMMENT ON COLUMN backtest_condition_definitions.code IS '配置项稳定唯一代码，与引擎条件 type 对应。';
COMMENT ON COLUMN backtest_condition_definitions.name IS '配置项中文名称。';
COMMENT ON COLUMN backtest_condition_definitions.category IS '配置项分类：impulse、retracement、volume、candle、indicator、invalidation。';
COMMENT ON COLUMN backtest_condition_definitions.description IS '配置项用途及计算口径说明。';
COMMENT ON COLUMN backtest_condition_definitions.parameter_schema IS '参数 JSON Schema，用于前端生成表单及后端校验。';
COMMENT ON COLUMN backtest_condition_definitions.default_parameters IS '新建条件时使用的默认参数 JSON。';
COMMENT ON COLUMN backtest_condition_definitions.implementation_version IS '对应计算实现版本。';
COMMENT ON COLUMN backtest_condition_definitions.enabled IS '当前数据与引擎是否支持启用该条件。';
COMMENT ON COLUMN backtest_condition_definitions.data_requirements IS '所需历史数据类型数组，例如 ohlcv、holder_snapshot。';
COMMENT ON COLUMN backtest_condition_definitions.created_at IS '配置项定义创建时间。';
COMMENT ON COLUMN backtest_condition_definitions.updated_at IS '配置项定义最后更新时间。';

COMMENT ON TABLE backtest_strategy_templates IS '回测策略模板表，保存策略身份、说明、生命周期状态和当前版本指针。';
COMMENT ON COLUMN backtest_strategy_templates.id IS '策略模板唯一标识。';
COMMENT ON COLUMN backtest_strategy_templates.name IS '策略模板名称。';
COMMENT ON COLUMN backtest_strategy_templates.description IS '策略目标和适用场景说明。';
COMMENT ON COLUMN backtest_strategy_templates.status IS '模板状态：draft、active、archived。';
COMMENT ON COLUMN backtest_strategy_templates.current_version_id IS '模板当前使用的不可变策略版本。';
COMMENT ON COLUMN backtest_strategy_templates.created_at IS '模板创建时间。';
COMMENT ON COLUMN backtest_strategy_templates.updated_at IS '模板最后更新时间。';

COMMENT ON TABLE backtest_strategy_versions IS '不可变策略版本表，每次保存策略配置均新增一个版本。';
COMMENT ON COLUMN backtest_strategy_versions.id IS '策略版本唯一标识。';
COMMENT ON COLUMN backtest_strategy_versions.template_id IS '所属策略模板。';
COMMENT ON COLUMN backtest_strategy_versions.version IS '模板内单调递增的版本号。';
COMMENT ON COLUMN backtest_strategy_versions.schema_version IS '策略 JSON 公共结构版本。';
COMMENT ON COLUMN backtest_strategy_versions.strategy_json IS '完整策略规则 JSON，不包含链、CA、周期和时间范围。';
COMMENT ON COLUMN backtest_strategy_versions.checksum IS '规范化策略 JSON 的 SHA-256 校验值。';
COMMENT ON COLUMN backtest_strategy_versions.created_at IS '策略版本创建时间。';

COMMENT ON COLUMN backtest_runs.strategy_template_id IS '任务创建时选择的策略模板，旧任务允许为空。';
COMMENT ON COLUMN backtest_runs.strategy_version_id IS '任务引用的不可变策略版本，旧任务允许为空。';
COMMENT ON COLUMN backtest_runs.dataset_json IS '本次任务选择的链、CA、交易池、周期、K 线类型和时间范围。';
