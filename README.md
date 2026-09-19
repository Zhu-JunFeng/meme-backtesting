# Meme K 线回测系统

第一版基于 TypeScript、NestJS、Vue 3、Ant Design Vue、PostgreSQL 和 BullMQ。

## 开发

```bash
pnpm install --ignore-scripts
pnpm --filter @meme/domain build
pnpm --filter @meme/engine build
pnpm --filter @meme/api build
pnpm --filter @meme/worker build
cd apps/web && pnpm build
```

启动 API、worker 和前端：

```bash
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

需要设置 `DATABASE_URL`，并在 PostgreSQL 中执行 `apps/api/migrations/001_init.sql`。Redis 默认连接 `localhost:6379`。

## TradingView Advanced Charts

组件来源：`/Users/zhujf/Documents/code/tradingview组件/charting_library-master_0421`。

将其中的 `charting_library/` 目录复制到：

```text
apps/web/public/charting_library/
```

也可以直接运行：

```bash
pnpm setup:tradingview
```

前端通过 UDF `/api/tv/*` 接口读取 K 线，并使用 Chart API 标注回测交易点位。
