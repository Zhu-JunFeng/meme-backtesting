# 项目信号与信号后买入

## 策略与兼容

策略配置 → 入场时间限制 →「仅在信号触发后买入」。`entryAfterSignal` 新配置默认开启；旧版本创建新任务时也默认开启，不修改旧版本。关闭时仍冻结外部信号供展示，但不生成入场时间限制。

创建和带 `strategyVersionId` 的数据集预检从数据库解析最早信号。开启后，无有效信号的 CA 连同全部池排除，全部缺失则拒绝。实际成交 K 线的开盘时间必须**严格大于**毫秒信号时间，首次买入及加仓一致。信号前行情仅用于指标预热。

任务 `config_json` 保存有效开关、`entrySignals`、`externalSignals`、`signalSelection`（排除与无入场机会池）。历史重试与重新回测沿用原快照；引擎与检查点版本不变，不新增运行时默认值。任务创建以数据库解析结果覆盖策略 JSON 的同名附加字段，客户端旧 `entrySignals` 只接受与数据库相符的时间。

## 表及回填

迁移 `008_token_signals.sql` 创建带中文注释的 `token_info` 和 `token_signal_events`。前者每池一条，后者按 `(chain,ca,signal_source,detail_id)` 去重且供多池共享。SOL 地址大小写保留，ROBIN 小写。空信号时间不以代币创建时间或 K 线时间代替。

```sh
python3 scripts/token-signal-manifest.py file1.xlsx file2.xlsx --output output/signals.json
# DATABASE_URL 通过环境提供；默认只读预检
node scripts/backfill-token-signals.mjs output/signals.json output/preflight.json
# 人工核对清单后写入，事务失败整体回滚，可重复执行
node scripts/backfill-token-signals.mjs output/signals.json output/applied.json --yes
```

解析器校验原始毫秒与北京时间一致，保留文件 SHA-256、工作表和行号。导入器仅写两个新表，校验已有报告摘要不变。未有行情的 CA 只列入报告，不导入行情。先保存预检报告再执行回填；不提交用户 Excel 或 `output/`。

2026-09-22 四份文件：553 行、478 条去重信号、75 行重复。生产已有 468 个 CA / 469 个池，匹配 467 条信号，11 条仅在文件中。ROBIN `0x2fc7f9e2911f20b2c4660d2aef808aa91bddb3d3` 无对应文件信号，时间留空；新建且开启信号限制时排除。

## 图表

`GET /api/backtests/:id/external-signals` 支持 `chain/ca/pairId/from/to/page/pageSize`，时间均为 UTC 毫秒。新任务只读冻结数组（空数组也不补查）。旧任务优先显示原 gate，再补充数据库信号并标明「补充展示，非当时回测依据」。

外部信号使用独立蓝色垂直虚线，不附加成交价格、不参与交易统计，不受结束平仓或交易类型筛选影响。图中按真实 K 线桶归位，同桶合并；列表与点击明细保留毫秒时间及身份。无对应已加载 K 线不画；范围外信号仅在列表注明。默认买卖/Fib 视野不变，可点列表定位信号附近。

## 验证

- `pnpm build`、`pnpm test:research`、两个 Python manifest 测试。
- `TEST_DATABASE_URL=... pnpm test`（仅名称含 test 的数据库）：覆盖多池、重复与多次信号、缺失排除、不可变展示、默认开关、旧版本与客户端绕过保护。
- 现有 `entry-gate.test.ts` 覆盖严格时间边界、首次入场、加仓与恢复一致。
- `externalSignals.test.ts` 覆盖 30s/1m、毫秒落桶、同桶聚合以及缺失/未加载时间不得吸附。
- 浏览器检查策略开关、任务快照说明、信号列表定位和手机换行；本次内置浏览器的 TradingView blob iframe 未渲染，真实标线视觉效果需在正常浏览器补验。

不会重跑历史任务，不改变成本、撮合及原报告。
