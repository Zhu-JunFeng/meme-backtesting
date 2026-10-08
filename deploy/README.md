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

`live_runs.signal_sources` 保存任务明确选择的来源集合，`signal_source` 仅为兼容摘要。迁移 017 将旧 `all` 固定为原两类（扩大信号、Top Cluster 首买），不会因新增来源自动扩大旧任务。支持 `fomo_trending_new_project`（FOMO 新上榜项目）；模拟盘支持 SOL/BSC/ROBIN，实盘仍仅 SOL/BSC 且保持管理员与全局开关保护。多选任意子集，历史 CA 的入组来源和持仓不会因配置更新被改写。

Trending 沿用现有外部信号 WS，使用 `trigger_time_ms` 入场门禁，不使用榜单完成时间替代；保留排名、榜单时间及原因摘要。倍数通知不作为新入组信号。仅接收任务启动后的新触发，不回放旧信号；沿用市值准入、容量及行情预热门槛。

ROBIN `1m-E0345` 和 BSC `30s-E0119` 的旧实验脚本仍按来源分别创建暂停任务，不混合样本，不代表实盘稳定盈利。上线并核对策略版本后，显式运行：

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

## 历史补数与增量订阅

模拟盘／实盘启动预热与恢复统一调用 `MEMEINFO_HISTORY_URL`，默认 `https://app.memeinfo.net/api/project-overview/xxyy-klines`，不再直连 XXYY 历史接口。无需鉴权，按实际交易池、30s/1m、price/market_cap 和固定毫秒窗口查询。Worker 共享最多两个 HTTP 并发，同窗口请求合并；单次 30 秒超时，临时错误最多三次尝试（1 秒、3 秒退避），失败项目 60 秒后重试，不阻塞实时事件队列。部署使用默认地址；需要覆盖时将变量加入 Worker 环境，不填写凭证。

只有 HTTP 成功且 `success=true, code="200"`、响应身份和 OHLCV 校验通过的已收盘数据可入库。新数据来源为 `memeinfo_xxyy`，原始十进制保留，元数据记录接口、上游及 traceId，唯一键冲突不覆盖原行情。空响应、尾部过旧、数据不足和具体接口错误分别显示；不将最后旧价格补到当前时间以宣告就绪。已存在历史与当前健康连接的连续 WS 尾部可以衔接；补数只恢复指标，绝不补发历史订单或重置持仓锁盈。

历史补数按根丢弃非法时间、字段或 OHLCV 数据，其余有效 K 线继续入库和预热，不因一根异常拒绝整个窗口。相同时间的有效记录若互相冲突则整组丢弃，不任选一个值。通过 `history_candles_discarded` 事件记录维度、丢弃数量、原因、最多 10 个时间样本和 traceId；重复相同诊断不反复插入。非法原值不落库、不覆盖已有行情；指标内部原有的缺口补线语义保持不变，补线不写作真实历史行情。响应身份／业务错误仍拒绝整批，预热不足或尾部未衔接仍暂停交易，不通过跳过数据绕过就绪条件。

WS 使用稳定连接分组和 `subscribe`/`unsubscribe`，仅新增项目收到初始化通知；保留项目不重连、不重置预热或未完成桶。同 CA 多任务共享订阅，新增任务不重置既有任务。订阅 ACK 串行确认，序号属于连接而非订阅版本；真实断线、缺口、确认超时和缓冲溢出仍安全暂停。日志和恢复原因应区分名单调整与实际数据中断。
