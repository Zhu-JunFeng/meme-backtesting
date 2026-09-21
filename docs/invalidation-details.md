# 失效退出细分

`exit_reason` / `signal_type` 继续使用 `invalidation`，不修改撮合顺序、仓位、结果数值、策略版本或检查点结构。

新退出事件在 `reason_json.invalidation` 保存版本 1 的证据：条件组、命中条件路径、参数、实际观测值、阈值和主要原因。支持跌破 Fib、跌破前低、放量大阴线；其他可配置条件保留为其他条件。只收集满足的嵌套分支，不把未达成的 all/at_least 子组中的单个条件描述为触发原因。主要原因取配置顺序第一个有效命中，所有命中均可查看。

查询返回 `invalidation_detail`。新事件优先使用信号快照；旧版 portfolio-3/4 仅在订单关联唯一、原入场 Impulse 有效、冻结输入可用且退出时间/收盘值一致时还原。使用有限历史窗口，沿用原引擎缺口补齐；支持共享冻结输入。不查询可变行情，不回填数据库，无法可靠还原显示“历史原因未明”。完成任务的还原结果使用有上限的进程内缓存。

`GET /api/backtests/:id/statistics` 新增 `invalidationReasons`，每行包括 code、filterType、count、share、netPnl、winRate。share 分母是当前结束强平开关口径内的失效退出总数。每笔订单仅按主要原因计一次；细分净盈亏之和等于原失效退出净盈亏。原 `exitReasons`、顶层汇总和历史报告不变。

交易、CA、信号和定位接口的 `signalTypes` 新增：

- `invalidation:break_fib_invalidation`
- `invalidation:break_swing_low_invalidation`
- `invalidation:bearish_volume_invalidation`
- `invalidation:other_condition`
- `invalidation:unknown`

筛选主要原因，多个标签为交易并集，保留整笔买卖事件，继续与结束强平开关取交集。选择父标签 `invalidation` 时包含所有细分原因；与子标签同时选择不会重复计数。顶层统计不应用标签筛选。

前端保持已有 Ant Design Vue 表格，新增细分统计和“查看依据”展开内容。交易、时间线和图表提示使用同一组标签及阈值解释；多个原因同时命中可见。盈亏颜色仅表达盈亏，不根据退出原因推测亏损。手机表格横向滚动，依据弹层限制在视口内。

本次不修复其他独立问题：收盘失效与盘中止盈的时序优先级、补齐 K 线成交、失效条件否决新买入。不能把展示细分误认为撮合模型已经改变。
