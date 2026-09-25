BEGIN;
ALTER TABLE public.live_watches ADD COLUMN IF NOT EXISTS dex_id text;
COMMENT ON COLUMN public.live_watches.dex_id IS 'MemeInfo 主池对应的 XXYY DEX 标识，用于构建实时成交订阅频道';
COMMIT;
