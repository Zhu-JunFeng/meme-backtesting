# 本地行情与策略研究

本工具只使用本机 PostgreSQL，拒绝远程主机及 `connectionString` 覆盖。
不会创建生产任务、修改策略版本、调整批量排名或写回行情。

## 数据快照

本机 `output/local-market-data/` 存放：

- `meme_kline-20260921.csv.gz`：`public.meme_kline` 的完整 CSV 压缩快照，包含原始数据、有效状态与异常原因。
- `source-schema.sql`：可移植的列定义，不依赖生产 TimescaleDB。
- `manifest.json`：导出快照、时间、压缩文件 SHA-256 与逐链／周期／类型的核验结果。只有校验成功才生成此文件。
- `pgdata/`：本地 PostgreSQL 数据目录。
- `socket/`：仅本机访问的 Unix socket；不监听 TCP。

导出在同一 PostgreSQL repeatable-read 快照下进行，逐组校验行数、CA／池数、有效行数、起止时间和 OHLCV 精确数值总和。服务器端 gzip 流式传输不落远程备份文件，也不建立数据库 SSH 隧道。归档和本地数据库不是未来数据自动同步服务。

这些大文件不应上传 GitHub。本机 `.git/info/exclude` 已排除本地快照和研究结果目录；其他检出也应设置对应排除规则。

## 执行

先构建引擎并测试研究工具：

```sh
pnpm --filter @meme/domain build
pnpm --filter @meme/engine build
node --test scripts/offline-strategy-research.test.mjs
node scripts/offline-strategy-research.mjs robin 30s mcap output/research-stable5-20260921/local/robin-30s-mcap
```

位置参数依次为链（`sol`／`robin`）、周期（`30s`／`1m`）、价值维度（`price`／`mcap`）、新的输出目录。已有研究目录不会被覆盖。

默认读取 `output/local-market-data/manifest.json` 与 `output/research-stable5-20260921/<chain>/protocol.json`。也可通过 `RESEARCH_MANIFEST`、`RESEARCH_PROTOCOL` 指定本地 JSON 文件。协议包含完整候选配置 `candidates: [{id, config}]`、四个递增的 UTC 时间边界 `boundaries` 和 `warmupBars`。不需要生产密码，不使用 `DATABASE_URL`。

本机数据库使用 PostgreSQL 17、端口标识 55433、数据库 `meme_research`、当前用户及 manifest 指定的 socket。若停止过数据库，可用本机实际目录运行 `pg_ctl -D <pgdata绝对路径> -l <日志绝对路径> -o "-p 55433 -k <socket绝对路径> -c listen_addresses=''" start`。不要将生产连接配置复制进本地应用 `.env`。

## 搜索口径

- 相同候选参数分别在 SOL 与 ROBIN 运行；每次测试初始资金独立，不跨窗口滚存收益。
- 第一窗口只用于训练排序；固定前十候选后再评估第二、第三窗口，不用验证结果自动修改候选。
- 当前研究初步门槛：三段完整账户净收益率和正常平仓净收益率均 ≥5%，每段真实账户最大回撤 ≤10%，每段至少 20 笔正常平仓。这是研究筛选门槛，不是用户承诺或收益保证。
- 第一批使用固定金额／资金比例模型，暂不使用已知首笔仓位计算存在偏差的 `risk_percent`。
- 维持现有手续费、滑点、税费和当前收盘成交语义；窗口结束和各池数据结束执行结束平仓，同时独立记录被过滤的盈亏。不会靠隐藏期末亏损满足目标。
- 指标先用此前 1500 根理论周期范围预热，预热期间不允许交易。缺口按生产引擎的上一收盘、零成交量规则补齐；不伪装成原始成交 K 线。
- 第一批窗口：SOL 为 UTC 9/13–9/15、9/15–9/17、9/17–9/19；ROBIN 为 9/18–9/19、9/19–9/20、9/20–9/21。全部左闭右开。两条链的窗口长度不同，不能直接横向比较收益率。
- `training.json`、`shortlist.json`、`validation.json`、`results.json` 分步保存。结果包括两种收益口径、账户回撤、交易数、排除订单、最佳 CA 贡献和数据 hash。

## 限制

这些历史区间已经被查看过；后续更换周期／价值维度继续筛选属于探索性验证，不是新的盲测。每链仅有三段，且 CA 来自信号文件，存在样本选择与参数多重筛选偏差。即使全部通过，也不能声称未来“稳定 5%”。仍需要锁定候选后，用新增且未参与筛选的数据前向验证。当前收盘成交、同根触发优先级、补齐 K 线和流动性模型的限制继续存在。

## 第二轮：邻域与组合探索

```sh
node scripts/explore-strategy-neighborhood.mjs robin 30s output/research-stable5-20260921/round2/robin-30s
```

分别运行 `sol/robin × 30s/1m`，本轮价值维度固定为市值。需要前一轮的 `<chain>-candidate.json`（其中 `strategy` 为完整策略配置）和 `<chain>/protocol.json`（四个时间边界）。输出目录必须未使用过；工具只读本地库，不创建线上任务，也不修改旧研究结果。

- 固定随机种子，默认每个数据集 256 组：先保留两条链的前一轮候选，再做单参数邻域与随机组合。改变拉升、回撤、确认条件、退出、锁盈及仓位；固定原有成本，不使用风险比例仓位、杠杆和加仓。
- 为减少无效计算，首段两种净收益均不负、真实账户回撤不超过 10%、正常平仓不少于 20 笔的候选才运行另外两段。未完整运行的候选不会被列为稳健候选；这可能遗漏后两段更好、但首段不满足条件的策略。
- 排名先要求三段均满足上述正收益、回撤、交易数门槛，再比较三段两种收益口径的最差值。三段都达到 5% 才标为 `pass`；这是历史搜索门槛，并非未来收益保证。
- 选出的前三名分别复核：滑点增加 1 个百分点、拉升门槛上下浮动 10%、最大持仓根数缩短 20%。压力结果不能反过来伪装成独立盲测。
- 输出 `protocol.json`、`dataset.json`、逐候选 `trials.json`、`stress.json` 和 `results.json`，保留源快照摘要与引擎版本。程序中断时已完成候选仍可审计，但本工具不承诺自动断点续跑。
- `withoutBestCaNormalReturn` 仅为从已实现利润中扣去最大贡献 CA 的诊断值，**不是**移除该 CA 后重新撮合的反事实收益。

## 包含最后一根平仓的账户口径

```sh
node scripts/explore-strategy-neighborhood.mjs robin 30s output/research-stable5-20260921/terminal-close/robin-30s terminal-close
```

`terminal-close` 模式从第二轮保存的 `round2/<chain>-candidate-research-only.json` 和原始 `<chain>-candidate.json` 生成 192 个候选，固定随机种子 20260924。它与旧模式分别保存研究记录，不覆盖旧结果。

- 所有候选强制 `exitConfig.closeAtEnd=true`，不预热（`warmupBars=0`），对齐服务器从所选起点计算的语义。
- 每个池在所选范围内的最后一根有效原始 K 线结束时，如仍持仓，按该根收盘值退出。价格与市值任务使用各自的价值维度。卖出仍计入手续费、滑点、税费；已有止盈止损优先级不变。不创造末尾缺失行情，不按零价值清算。
- **排名和目标只使用完整账户净收益**，包括结束平仓。首段门槛为完整账户收益非负、实际最大回撤不超过 10%、总平仓不少于 20 笔；后续比较三段最低完整账户收益。每段达到 5% 才标记历史目标通过。正常平仓收益仅作为诊断字段，不参与筛选门槛。
- 先固定三段选出的前十名，再检查较短的历史后续片段：SOL UTC 9/19 00:00–17:00、ROBIN UTC 9/21 00:00–09:00。片段长度不同，不把它们当成同周期收益或新的盲测；这些日期在此前研究中已被部分查看。
- 输出 `totalTrades` 和 `accountWinRate` 包括结束平仓。兼容旧字段 `excludedCount/excludedNet` 仅表示旧口径会排除的结束交易，**不意味着在本模式账户收益里扣除了它们**。
- 生产页面若关闭“包含结束强平及未平仓交易”，显示的统计不是本研究排名口径；查看服务器复核时应开启此开关。本工具不修改前端默认值或任何历史报告。
