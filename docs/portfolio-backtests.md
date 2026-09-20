# 批量 CA 与共享账户回测

## 使用

- 策略配置中选择已归档模板，点击「恢复启用」；仅更改状态，不产生版本。
- 创建回测选择周期、价格/市值维度；选择 SOL 等链后自动选中全部匹配 CA，支持多链。可取消个别 CA，排除项跨周期、类型和时间范围变化保留。取消链会清除该链的选择与排除项，重新选中从全选开始。
- 完整 CA 搜索和分页仅影响展示，不缩小整链选择范围。表头操作当前页，「全选展示结果」恢复展示范围内的排除项；「清空选择」清除链、已选项及排除项。未选择链时可手动勾选 CA。
- 全量分页名单成功后一次性应用；加载或查询失败时禁止提交并提供重试。查看任务详情再返回仍保留创建页面选择状态。快照筛选信息包含 `selectedChains` 与 `excludedCas`。
- 开始/结束时间独立可选，均留空时各池使用自己的完整有效历史。时间按有效 K 线存在性筛选，不按代币创建时间。
- 选择 CA 纳入该链该 CA 的全部交易池。提交前预检展示 CA 数、总池数、可回测池数、无数据池数；无数据池保留在明细但不撮合。
- 点击历史任务进入详情，再点击 CA 下钻交易池、交易及事件。图表锁定任务的周期和价值维度，点击事件时间定位。

## 结果口径

新报告 `engineVersion=portfolio-2`。全部交易池共享现金和持仓上限，按 K 线时间合并；同时间先退出，后按 `(chain, ca, pairId)` 固定顺序处理买入/加仓。每个池按自己最后已知行情估值。

- `netPnl`：已平仓交易的已实现净盈亏。
- `unrealizedPnl`：未平仓的浮动盈亏，扣已经发生的买入费用、滑点和税，不扣假设的未来卖出成本。
- `totalNetPnl`：上述两项之和，等于期末权益减初始资金（允许浮点误差）。
- `returnPercent`：整体净盈亏 / 初始资金。
- 胜率、交易次数：仅统计已平仓交易。CA「有交易」包含未平仓买入；零交易 CA 也保留。
- CA 和池的「总成本」包含手续费、滑点、买卖税。
- 权益图对长序列进行抽样，报告最大回撤仍由所有时间点计算。
- 保留既有引擎缺口补平 K 线逻辑；真实图表只显示数据库有效 K 线，不补造历史事件。

旧任务不重算。缺失的浮动盈亏、期末权益、无数据池状态显示不可用；详情使用原快照和已有信号，而非策略当前版本。

## API

- `GET /api/market/cas`：`chains`（逗号分隔）、`ca`（完整地址、大小写敏感）、`interval`、`type`、`startTime`、`endTime`、`page`、`pageSize`、`sort`（`ca/minTime/maxTime`）。返回 `{items,total,page,pageSize}`。相同筛选缓存 30 秒，创建时重新检查。
- `POST /api/market/dataset-preview`：接收数据集选择并返回冻结池清单与数量，不创建任务。
- `POST /api/backtests`：数据集支持 `cas:[{chain,ca}]`；旧 `symbols:[{chain,ca,pairId}]` 保留。返回创建任务；完整快照保存在 `config_json/dataset_json`。
- `GET /api/backtests/:id/cas`：`ca/chain/page/pageSize/sort=pnl_asc|pnl_desc`。
- `GET /api/backtests/:id/ca`：`chain/ca`，返回该 CA 全部池统计。
- `GET /api/backtests/:id/signals|trades`：`chain/ca/pairId/from/to/page/pageSize`；时间毫秒。分页返回 `{items,total,page,pageSize}`，旧未传分页参数请求继续返回数组。
- `GET /api/backtests/:id/equity`：有界抽样权益曲线。
- `GET /api/tv/history`：`runId` 会锁定快照维度、池和范围；`countBack` 按实际 K 线根数回溯，跨越数据缺口，不把缺口误认作历史终点。

## 部署与验证

先应用 `apps/api/migrations/003_portfolio_indexes.sql`，再发布 API、worker、前端。`meme_kline` 是 TimescaleDB 超表，两个行情索引使用普通建索引，首次迁移建议低峰期执行；信号/交易表使用并发索引。迁移为幂等操作，不修改已有任务或行情。

worker 每批最多 1000 行写入，在一个事务内替换该次任务结果；进度每 2 秒最多更新一次，引擎协作式让出事件循环，避免阻断 BullMQ 锁续期。已完成/取消任务不会被重复消费重跑。

验证：`pnpm test`、`pnpm -r build`；引擎覆盖确定性、共享资金与费用、全局持仓、生命周期错开、退出优先、独立估值、原始加仓点；API 覆盖恢复不增版本、时间边界、全池解析、无数据状态、零交易、历史兼容、过滤分页。
