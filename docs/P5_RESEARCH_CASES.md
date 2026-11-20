# P5 三研究案例证据清单

按原[实施计划](IMPLEMENTATION_PLAN.md)“三个研究案例可复现：Ulysses风格布局交换、MoE混合并行、多流与状态复用。结果能解释每项节省或增加的成本”核对。检查点30补齐第三案例；检查点34另完成P5工作项/阶段公式核验。此表只映射原三个案例，整体阶段证据见[P5验收](P5_ACCEPTANCE.md)，P6及原PRD剩余范围见[阶段清单](ACCEPTANCE_STATUS.md)。

运行 `npm run reference:research`，依次生成三套可移植项目、完整原始结果、独立摘要和容量；检查点31–34追加[压缩组件](COMPRESSION_RESEARCH.md)、[DSA/indexer](DSA_RESEARCH.md)、[KDA混合decode](KDA_RESEARCH.md)与[短prefill/chunk](KDA_PREFILL_RESEARCH.md)，共同复算七套研究，不改变本表原三案例范围。每套都使用 `analyzeScenario` 与 `searchCapacity`，无绕过统一引擎的品牌算法。原始来源事实与人工速率、精度/分配、代理方程和理想假设分别保存。

| 原条件 | Ulysses布局交换 | MoE混合并行 | 多流与状态复用 |
| --- | --- | --- | --- |
| 完整可复算片段 | SP投影→Q/K/V三次A2A→head attention→返回A2A→SP输出/残差 | SP router/packet→EP×TP dispatch→两个owner gather/专家FFN/scatter→逆交换/加权/残差 | 四层Full/Reuse/Reindex/Reuse，主KV、indexer K、Top-K、候选和各层独立window，query/attention/output完整片段 |
| 源/作者假设分开 | 官方DeepSpeed提交与SHA；人工卡、未掩码物化MHA与softmax scratch | 官方Megatron提交与SHA；固定路由、显式packet/metadata、分离owner combine | 官方V4.1提交与代码/config SHA；四层小尺寸片段、物化score、packed理论/BF16 cache分开 |
| 实际身份与布局 | sequence/heads/exchange同实际卡；SP↔head局部shape | world/grid复用四卡，EP两个组各两张；源t分片、owner TP、partial→scatter | 单卡六持久状态、同一主KV四reader、indexer K两reader、四window不合并；Top-K仅前向共享 |
| 独立操作/流量口径 | useful 768/176；冗余复制1536/352；交换新增权重读取 | 有效/物理1664/432；驻留专家不按激活数减少；逐rank20/40/40/20B，最慢rank定跨度 | matrix2832、vector执行1968/有用1264；转换只加执行量；省创建/索引，不省四次attention读取；packed状态220B与元数据完整 |
| 时间解释 | 11.2→6.276s，四次网络共0.036s | EP-only34.363→mixed21.525s；ideal12.267s；集中触及读权重少而峰值不减 | 独立87.72→共享62.18s；ideal49.44s；HBM争用回62.18s，字节总量不变 |
| 生命周期/容量 | 两卡峰值288对单卡448；batch24对12；奇数query缺口unknown | 四卡392对两卡672；batch23对14；metadata/copy独立backing | 峰值2242对3862；共享batch5对1；源索引多保留8B；三步最坏2272、B5=4064 |
| 动态/反向证据 | B/S/degree、四卡、缺失A2A、不整除、unknown hole | B/Q/H/I、decode、非法collective类型、逐rank合计/标量伪造 | B/C/H、cold start、多步版本、奇数候选、Q>1与状态binding错误、空库重开 |
| 独立脚本 | `scripts/ulysses-oracle.ts` / `ulysses-reference.ts` | `scripts/moe-oracle.ts` / `moe-reference.ts` | `scripts/csa2-oracle.ts` / `csa2-reference.ts` |
| Chrome与原始结果 | `tests/e2e/ulysses.spec.ts`；`examples/ulysses` | `tests/e2e/moe-research.spec.ts`；`examples/moe` | `tests/e2e/csa2.spec.ts`；`examples/csa2` |

三套Chrome均验证导入、工作负载/策略编辑、结果导出、可移植快照和重开，以及方案比较/容量。时间线和通信的展示读取同一结果，示意图或测试数量不替代数值证据。研究范围都是明确片段，不能据此声明完整生产型号/推理框架的性能支持。

详细计算与限制见[Ulysses](ULYSSES_RESEARCH.md)、[MoE](MOE_RESEARCH.md)、[CSA2复用](CSA2_REUSE_RESEARCH.md)。通信本地HBM/归约算术在前两套仍缺项；CSA2的完整HBM只指已声明四层片段，省略组件未被自动计为完整网络成本。

检查点31补齐[ratio>1压缩及部分组状态](COMPRESSION_RESEARCH.md)，检查点32补齐[DSA](DSA_RESEARCH.md)，检查点33补齐[KDA混合decode](KDA_RESEARCH.md)，检查点34另以独立资产补齐[短prefill/chunk](KDA_PREFILL_RESEARCH.md)，满足原F04阶段不同公式，未用Q=1方程乘Q代替。完整acceptance:p5通过391单元/3HTTP/76Chrome及七研究共同复算；原P5工作项的范围见[P5验收](P5_ACCEPTANCE.md)。P6的更多型号/快捷预设、真实Trace/算子CSV及确认映射仍待完成，不能以研究签收替代。
