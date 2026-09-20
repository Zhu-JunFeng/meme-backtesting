# 交易 Fib 核验

点击交易明细的“买 N / 卖 N”，默认显示原始 Swing Low 至卖出前后的完整行情；“买卖区间”可放大成交区间，“显示 Fib”只控制覆盖图层，不影响交易标记。

`GET /api/backtests/:id/locate` 保留既有 from/to/start/end，追加 fibFrom/fibTo 和 fib。fib.status 为 available 或 unavailable，包含原因、来源、原始 impulse、锚点、确认点、levels、zones、thresholds 和 buys。时间均为毫秒，界面核验时间为 UTC。水平值统一为 `high - (high-low)*ratio`。

新信号在 reason_json.impulse 增加可选的 lowTime/highTime/confirmedTime 和对应 Synthetic 标识。引擎版本及检查点版本不变：新增字段不参与成交规则，旧持仓继续使用原 Impulse。参考引擎和续跑引擎均输出这些元数据。

历史 portfolio-3/4 仅通过冻结输入逐块还原索引；补齐数量与 FrozenReader 相同，非整周期原始时间也保留。缺少冻结输入、分块、唯一入场关联或数值校验失败，返回不可用，绝不查询最新行情重找高低点。旧交易和报告无任何回写。

图表不会把缺失/补齐时间的 Pivot 吸附到邻近真实 K 线。此类锚点在明细中标注来源并保留精确时间和值，缺失端点的连接线不绘制；不会为可视化生成虚拟成交 K 线。水平线只是历史核验参考，不表示确认前就可以交易；高点确认时间单列。

部署无数据库迁移，仍需检查进行中任务及兼容性。验证：`pnpm -r build`、`TEST_DATABASE_URL=<隔离测试数据库> pnpm -r test`，再以只读预览核查真实交易及视野切换。
