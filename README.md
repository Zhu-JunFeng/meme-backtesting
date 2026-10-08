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

需要设置 `DATABASE_URL`，并按文件名顺序执行 `apps/api/migrations/*.sql`。Redis 默认连接 `localhost:6379`。

## 策略配置与回测快照

- `/api/condition-definitions` 提供数据库驱动的 JSON Schema 配置项定义。
- 策略模板每次保存都会新增不可变版本，不能覆盖历史版本。
- 创建回测时只提交策略版本、K 线数据集和允许的成本覆盖项。
- Worker 始终读取 `backtest_runs.config_json` 的完整快照，模板后续更新不会影响历史结果。
- 链上过滤项已经预置，但在历史快照数据接入前保持不可用。

## TradingView Advanced Charts

项目列表和图表区域通过统一组件展示 Logo、Symbol 和缩略 CA，复制与查询始终使用完整地址。`POST /api/projects/lookup` 接收 `{ projects: [{ chain, ca }] }`（每批最多 20 个），代理固定的 MemeInfo lookup 接口。前端最多并发两批，资料仅在当前页面内存中复用；离开页面后清除，不写数据库、Redis 或浏览器持久化存储。加载失败可重试，缺失资料或图片使用占位展示，不阻塞行情和交易记录。

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
