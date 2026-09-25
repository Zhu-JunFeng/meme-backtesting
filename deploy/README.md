# Production deployment

GitHub Actions 需要以下 `production` secrets：

- `DEPLOY_HOST`：PG/Redis 所在服务器 IP 或域名
- `DEPLOY_USER`：部署用户，推荐专用非 root 用户
- `DEPLOY_PATH`：服务器上的项目目录，例如 `/opt/meme-backtesting`
- `DEPLOY_SSH_KEY`：部署用户私钥
- `DATABASE_URL`：服务器可访问的 PostgreSQL 连接串
- `REDIS_PASSWORD`：远程 Redis 密码

每次 push 到 `main` 会执行测试、构建、上传源码、数据库迁移并重建 API、worker 和 web 容器。

TradingView Advanced Charts 本地授权资源不会随 workflow 上传。若生产环境需要完整图表，请在服务器的项目目录中预置：

```text
apps/web/public/charting_library/
```

## 实时模块的上线门槛

新部署只发布“模拟盘”和“实盘”页面及数据库结构，不会自动创建或启动任务。`LIVE_TRADING_ENABLED=false` 在部署流程中固定写入，真实下单保持关闭。历史回测任务不会重跑。

模拟盘需要在 GitHub `production` secrets 中配置 `MEMEINFO_SIGNAL_TOKEN`；用户本次明确要求继续使用之前的令牌，该令牌已在对话中暴露，仍建议尽快轮换。2026-09-25 已只读连接 XXYY `/data` Socket.IO 验证：项目主池订阅频道为 `D_TOKEN_DETAIL_{dexId}_{pairId}`，事件为 `NEW_TRADE`，载荷是 JSON 交易数组及频道参数；成交含 `timestamp`、`txHash`、`priceUsd`、`marketCapUSD`、`usdAmount`。这两个 XXYY 配置有代码默认值，不需要另设 Secret；若覆盖频道模板，必须同时包含 `{dexId}` 与 `{pairId}`。模拟盘不需要 XXYY 交易 API Key。

实盘额外需要 `XXYY_API_KEY`、`LIVE_ADMIN_PASSWORD_HASH`（`salt:scrypt64_hex`）和可信 HTTPS 反向代理。目前部署的公开 HTTP `:5173` 仅提供脱敏只读视图，不发送管理员口令；生产 API 只监听本机。实盘仅支持 SOL/BSC，ROBIN 无已核实的 XXYY 下单接口。即使单独打开下单开关，也必须先完成模拟盘持续观察、真实成交/钱包/美元成本对账及小额人工验收；已提交或状态不明的订单会使任务进入“待人工处理”，不会自动重发或冒充已确认持仓。

管理员口令哈希可在受控终端生成，原文不得写入仓库或部署日志；只保存哈希到 Secret。服务器密钥配置与公网 HTTPS 均未随本次代码提交自动开通。
# 按信号来源隔离的模拟盘实验

`live_runs.signal_source` 将模拟盘任务限制为一个 MemeInfo 来源。旧任务保持 `all` 兼容行为；新建页面要求明确选择来源。ROBIN `1m-E0345` 和 BSC `30s-E0119` 的两个来源分别创建暂停任务，不混合样本，不代表实盘稳定盈利。上线并核对策略版本后，显式运行：

```sh
node scripts/seed-profitable-paper-runs.mjs --api=https://YOUR_HOST/api
node scripts/seed-profitable-paper-runs.mjs --api=https://YOUR_HOST/api --execute
```

脚本使用幂等键，重复执行不会重复建任务；它不会启动任务。令牌只放在服务器密钥配置中，不写入代码或日志；没有可信实时成交时，不应把运行中任务视为已经完成策略验证。
