# 北京时间与版本说明

所有面向用户的时间使用 `Asia/Shanghai`。日期输入按北京时间解释后发送 UTC ISO，图表仅切换显示时区，不偏移行情、事件、定位查询或信号入场门槛。原始 JSON 明确标注，不转换。

版本说明由 `@meme/domain` 的确定性生成器生成，包括当前引擎真实规则与已知限制，不使用外部 AI。配置页提供即时预览和最多 20000 字符的纯文本补充备注。保存备注也生成新版本。模板简介仍用于描述模板身份。

## 存储与 API

- 迁移 `009_version_descriptions.sql` 增加可空 `backtest_strategy_versions.description_json`，结构为 `{generatedText, notes, generatorVersion}`。现有不可变触发器同时保护说明。旧行保持 null。
- 创建模板与 `POST /api/strategy-templates/:id/versions` 的包装请求增加可选 `notes`。原始策略请求格式兼容。服务端重新生成文本，不接受客户端提供的权威说明。
- 版本查询增加 `versionDescription`；复制时生成独立新说明并继承已有备注。
- `backtest_runs.strategy_description_json` 冻结说明、版本号及 `executionOverrides`。任务详情直接返回该字段；重试不改动，重新回测复制原值。
- 说明不进入 `strategy_json` / `config_json`，不改变引擎哈希或检查点版本。旧版本创建任务仍没有说明，不从当前模板补造。
- 固定历史批次创建全新版本时也保存说明，但不更新已有版本、任务、排名或批次状态。

## 验证

运行 `pnpm build` 与 `TEST_DATABASE_URL=<隔离测试库> pnpm test`。测试库名称必须包含 test；恢复测试初始化相关迁移，然后 API 集成测试覆盖版本不可变、仅备注更新的校验和稳定、克隆、执行覆盖快照及 rerun 复制。

时间测试覆盖 UTC、Asia/Shanghai、America/New_York、跨日、毫秒、epoch 0、无效日期和输入到 UTC 的转换。手机 390×844 与桌面验证说明默认收起、展开阅读、真实执行覆盖值和备注转义。

已知引擎行为会如实写入说明：首次风险仓位按 10% 估算距离；禁用但存在的加仓组不自动回退入场组。本次不修订撮合规则。
