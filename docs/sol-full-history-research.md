# SOL 全历史本地策略搜索

这是独立的研究入口，不改变旧研究命令的默认信号限制、训练／验证口径，也不提交生产回测任务。

## 固定口径

- 生产 PostgreSQL 只读、可重复读快照，SOL 已有的 30s／1m 市值行情；固定截止时间，仅使用已收盘且合法的 OHLCV，不请求上游行情。
- `entryAfterSignal=false`、`pullback-v2`，信号前历史及没有信号的 CA 均参与。保持原有内部缺口补线语义，不延长池生命周期。
- 10,000 USD 共享资金；手续费、滑点、买税、卖税各 1%；无杠杆、无加仓，末根收盘平仓。
- 每周期 512 个候选，固定种子 20261012。默认模板、E0056、E0129、E0103 为对照，统一规则和成本。固定金额模板按 10,000 USD 初始资金转换为等值的可用现金比例，并记录调整。
- 首轮总榜前五各最多 200 个邻域候选，全局去重；按全历史净收益率、最大回撤、交易笔数、编号排序。少于十笔标记样本不足，零成交不参与排名。
- 每 50 个保存进度；所有候选保留配置、摘要，仅最终前十保留完整压缩明细。前三另外测试滑点 2% 及移除最大盈利 CA。
- **历史拟合，非独立验证。** 没有未来函数不等于没有事后项目发现偏差；不能把信号前盈利当作模拟盘可捕获收益。

## 冻结与执行

从环境读取远程连接串，禁止将密码写入研究输出或 Git。使用全新快照目录，已完成快照不可覆盖：

```sh
node --input-type=module -e 'import {snapshot} from "./scripts/cohort-snapshot.mjs"; await snapshot({connectionString:process.env.DATABASE_URL,output:"output/sol-study/frozen",allKlines:true,researchMcapOnly:true,selectedChains:["sol"],closedOnly:true});'
node --expose-gc --max-old-space-size=8192 scripts/sol-full-history-research.mjs output/sol-study/frozen output/sol-study/results
```

此前 E0103 对照默认读取 `output/holdout-5050-20261007/sol/report.json`，必须存在且标识正确。其他位置可通过模块函数的 `priorPath` 指定。完成快照后研究只读取本地文件，不需要数据库连接。

默认 4 路本地 Worker 并行，只共享读取同一份冻结文件；可在命令末尾传入 1–8 调整并发，内存不足时使用 1。并发数量不改变结果或排名。

再次执行同一命令即可从 `progress.json` 续跑；快照哈希、引擎版本、种子、候选或研究口径变化会拒绝复用结果。中断最多重算未保存的一批，不覆盖生产任务。明细复算会校验收益、回撤及交易／信号哈希与摘要完全一致。

结果包括 `coverage.json`、`protocol.json`、`progress.json`、`round2.json`、`report.json`、中文 `report.md` 及前十的 `*.details.jsonl.gz`。覆盖报告保留缺失信号、无对应周期行情池清单；信号归因严格区分信号前／等时、信号后、无信号。输出目录不应提交大体量行情或敏感配置。

验证：`pnpm test:research`。研究不会更改服务器回测、纸面策略、实盘权限或历史排名。
