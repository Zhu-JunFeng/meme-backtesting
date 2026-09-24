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

模拟盘启用前，需先轮换曾出现在对话中的 MemeInfo 令牌，并在 GitHub `production` secrets 中配置 `MEMEINFO_SIGNAL_TOKEN`。还需要从脱敏的真实 XXYY Socket.IO 样例核实订阅命令、频道和成交字段，再配置 `XXYY_TRADE_CHANNEL_TEMPLATE`（必须包含 `{pairId}`，可含 `{chain}`）与 `XXYY_TRADE_EVENT`。字段与频道未核实前请留空：Worker 会跳过实时服务，绝不根据猜测的数据格式入场。模拟盘不需要 XXYY 交易 API Key。

实盘额外需要 `XXYY_API_KEY`、`LIVE_ADMIN_PASSWORD_HASH`（`salt:scrypt64_hex`）和可信 HTTPS 反向代理。目前部署的公开 HTTP `:5173` 仅提供脱敏只读视图，不发送管理员口令；生产 API 只监听本机。实盘仅支持 SOL/BSC，ROBIN 无已核实的 XXYY 下单接口。即使单独打开下单开关，也必须先完成模拟盘持续观察、真实成交/钱包/美元成本对账及小额人工验收；已提交或状态不明的订单会使任务进入“待人工处理”，不会自动重发或冒充已确认持仓。

管理员口令哈希可在受控终端生成，原文不得写入仓库或部署日志；只保存哈希到 Secret。服务器密钥配置与公网 HTTPS 均未随本次代码提交自动开通。
