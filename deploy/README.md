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

模拟盘需要在 GitHub `production` secrets 中配置 `MEMEINFO_SIGNAL_TOKEN`；曾在对话中暴露的令牌建议尽快轮换。实时成交现在使用 Meme Market 协议 2，不再配置 XXYY Socket.IO 频道。模拟盘不需要 XXYY 交易 API Key。

实盘额外需要 `XXYY_API_KEY`、`LIVE_ADMIN_PASSWORD_HASH`（`salt:scrypt64_hex`）和可信 HTTPS 反向代理。目前部署的公开 HTTP `:5173` 仅提供脱敏只读视图，不发送管理员口令；生产 API 只监听本机。实盘仅支持 SOL/BSC，ROBIN 无已核实的 XXYY 下单接口。即使单独打开下单开关，也必须先完成模拟盘持续观察、真实成交/钱包/美元成本对账及小额人工验收；已提交或状态不明的订单会使任务进入“待人工处理”，不会自动重发或冒充已确认持仓。

管理员口令哈希可在受控终端生成，原文不得写入仓库或部署日志；只保存哈希到 Secret。服务器密钥配置与公网 HTTPS 均未随本次代码提交自动开通。
# 按信号来源隔离的模拟盘实验

`live_runs.signal_source` 将模拟盘任务限制为一个 MemeInfo 来源。旧任务保持 `all` 兼容行为；新建页面要求明确选择来源。ROBIN `1m-E0345` 和 BSC `30s-E0119` 的两个来源分别创建暂停任务，不混合样本，不代表实盘稳定盈利。上线并核对策略版本后，显式运行：

```sh
node scripts/seed-profitable-paper-runs.mjs --api=https://YOUR_HOST/api
node scripts/seed-profitable-paper-runs.mjs --api=https://YOUR_HOST/api --execute
```

脚本使用幂等键，重复执行不会重复建任务；它不会启动任务。令牌只放在服务器密钥配置中，不写入代码或日志；没有可信实时成交时，不应把运行中任务视为已经完成策略验证。

## Meme Market 协议 2 切换门槛

实时成交使用 `MEME_MARKET_URL`（默认 `wss://app.memeinfo.net/api/ws/meme-market/v1`）；必须先在生产确认 `hello.protocol_version=2`、订阅 ack 和真实 trade，再发布此版本。路径中的 v1 不表示协议版本。收到协议 1 时客户端停止接入并提示，不回退到 XXYY Socket.IO。

保留 XXYY 历史补数和真实下单／核验。迁移 016 记录行情源、切换时间及健康信息；历史成交不重算。发布前检查持仓和未决订单，发布后核验订阅数、就绪数、消息时间及预热进度，不将任务心跳当作可交易证明。

协议 2 是尽力投递。健康连接下零成交量平线仅表示推定无成交，无法证明上游没有漏成交。已知断线、序号缺口或本地溢出暂停判断并重新补数；补数失败且有持仓时暂停策略交易，止损可能无法及时执行。无持仓时允许在新健康连接区间重新积累连续 K 线预热，不跨断线区间补平线。来源字段 `meme_market_v2` 与旧行情分开标识，但沿用原唯一键且不覆盖旧行情。

## 供应量与缺失市值

合法正数 WS 市值优先；缺失时使用同笔美元价格乘以缓存实际供应量。当前 lookup 合约规定 `project_meta.total_supply` 为原始整数，必须用 `decimals` 除以精度；只有明确 `total_supply_unit=tokens` 才直接使用。Decimal 运算保留原始字符串，不按数值大小猜单位。缺失资料、未知单位或非法精度会暂停项目，不能把部分成交形成的市值桶用于交易。

`meme:project-info:v1:{chain}:{ca}` 是持久化缓存键，SOL 地址保留大小写，其余地址小写。成功无 TTL；失败记录次数及下一次重试时间，最多三次，Worker 重启不重置。内存单次并发查询复用于准入、恢复及多个任务；Redis 故障降级为当前进程内缓存并显示状态。需要重新查询已耗尽项目时，运维显式清除该项目精确缓存键后重启 Worker；禁止清空整个 Redis。缓存不自动刷新供应量或主池。

等待资料时每 CA 最多缓冲 256 笔，所有等待及处理队列总计上限 2000 笔；溢出丢弃受影响桶并重新预热。断线后旧缓冲不能重放成订单。行情 `raw_data` 和订单依据保存 `marketCapBasis`、`derivedSupply`、`hasDerivedMarketCap`，区分 WS 原值与价格乘供应量；混合来源桶也保留计算供应量。定时市值门槛检查只读最近一分钟有效成交，不把 lookup 历史市值当实时行情。
