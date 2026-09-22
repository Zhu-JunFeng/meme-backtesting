BEGIN;
CREATE TABLE IF NOT EXISTS public.token_info (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), chain text NOT NULL, ca text NOT NULL, pair text NOT NULL,
 signal_source text NOT NULL DEFAULT 'fomo_new_project', source_signal jsonb,
 signal_time bigint CHECK(signal_time >= 0), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(chain,ca,pair)
);
COMMENT ON TABLE public.token_info IS '项目交易池及最早外部监控信号；同一合约可有多个池';
COMMENT ON COLUMN public.token_info.id IS '项目交易池记录主键';
COMMENT ON COLUMN public.token_info.chain IS '规范化所属链';
COMMENT ON COLUMN public.token_info.ca IS '合约地址，SOL 保留大小写';
COMMENT ON COLUMN public.token_info.pair IS 'K线交易池标识，对应 meme_kline.pair_id';
COMMENT ON COLUMN public.token_info.signal_source IS '信号业务来源代码';
COMMENT ON COLUMN public.token_info.source_signal IS '最早信号的原始名称、代码及身份信息';
COMMENT ON COLUMN public.token_info.signal_time IS '最早有效触发时间，UTC Unix 毫秒；空表示未知';
COMMENT ON COLUMN public.token_info.created_at IS '记录入库时间，非代币创建时间';
CREATE TABLE IF NOT EXISTS public.token_signal_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), chain text NOT NULL, ca text NOT NULL,
 signal_source text NOT NULL, detail_id text NOT NULL, signal_time bigint NOT NULL CHECK(signal_time>=0),
 source_signal jsonb NOT NULL, provenance jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(chain,ca,signal_source,detail_id)
);
CREATE INDEX IF NOT EXISTS token_signal_events_ca_time ON public.token_signal_events(chain,ca,signal_time,id);
COMMENT ON TABLE public.token_signal_events IS '外部触发信号明细，按合约共享于全部交易池，非回测成交';
COMMENT ON COLUMN public.token_signal_events.id IS '外部信号记录主键';
COMMENT ON COLUMN public.token_signal_events.chain IS '所属链';
COMMENT ON COLUMN public.token_signal_events.ca IS '合约地址';
COMMENT ON COLUMN public.token_signal_events.signal_source IS '业务来源代码，例如 fomo_new_project';
COMMENT ON COLUMN public.token_signal_events.detail_id IS '来源明细ID，用于重复导出去重';
COMMENT ON COLUMN public.token_signal_events.signal_time IS '实际信号触发时间，UTC Unix 毫秒';
COMMENT ON COLUMN public.token_signal_events.source_signal IS '原始信号名称、代码、ID及上游来源';
COMMENT ON COLUMN public.token_signal_events.provenance IS '来源文件校验值、工作表及行号列表';
COMMENT ON COLUMN public.token_signal_events.created_at IS '信号记录入库时间';
COMMIT;
