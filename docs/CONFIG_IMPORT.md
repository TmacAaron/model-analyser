# 从 config 创建模型草稿

检查点 22 实现 JSON/YAML config 导入、声明式映射、缺项/未知字段核对和固定模板复用。它不加载权重、不执行来源中的 auto_map/远端代码，也不把相近模板当作未知型号已被适配。阶段证据见 [P2 验收](P2_ACCEPTANCE.md)。

## 使用路径

1. 资产库点击“从 config 创建模型草稿”。解析成功立即创建稳定 ID 的草稿；尚未选模板也能关闭后从“恢复草稿”继续。
2. 声明匹配 model_type 时建议已有模板；仍需点击确认选用。未匹配时显式选择相近模型。内置/用户模型都可作为模板，没有映射描述的用户模型按非 B/Q/C 参数键建立待补规则。
3. 检查来源字段、原值、目标参数、单位/范围、当前值与来源。缺失或非法的必需映射移除模板默认值，不补零、不把数字字符串转成数值。可以手工填写，或用 JSON Pointer 修改来源路径后“应用字段映射”。例如 `/hidden_size`，带特殊字符的键按 JSON Pointer 的 `~0`/`~1` 转义。
4. 逐项填写模板范围、未知字段、不支持的结构条件和量化元数据的核对说明。说明需要明确手工修正了什么，或哪些字段未采用、按什么模板近似。错误映射必须修复，不能仅填说明跳过。
5. 可在下方结构配置/高级 JSON 中修正节点、状态或成本，再点击“确认映射与假设，自动发布模型”。界面先用 B=Q=1、C=0 分别展开 prefill/decode，检查默认结构；随后走既有草稿/契约/依赖/修订保存。失败保留草稿。该预检不证明所有长度、覆盖和并行组合都可用。
6. 成功后模型进入资产库，可按家族筛选、创建方案、导出完整快照并在空库复算。项目继续固定资产修订；库中的后续修改需显式升级。

映射和核对说明修改后自动保存并回到待核对状态。直接在结构表修改已映射默认值时，导入表会指出与记录不符；可选择“采用当前资产值”明确记录为手工覆盖。高级完整 JSON 也不能仅把 status 改成 confirmed 跳过未解决的核对项。

## 当前映射范围

| 模板 | 自动映射 | 固定结构条件 |
| --- | --- | --- |
| Qwen3 Dense/GQA | 层数 L、H/I、head dim D、query/KV heads NH/NK、词表 V、最大上下文 M | SiLU/SwiGLU、共享 embedding/head、BF16、无 QKV bias/dropout、无自动滑窗/RoPE 扩展变换 |
| DeepSeek-V2-Lite MLA | 总层数减一 → Lmoe；H/NH、DN/DR/DV、KV rank R、Dense I、MoE J、routed/TopK/shared E/K/S、V/M | 一层 Dense，其余每层 MoE；直接 Q、greedy softmax TopK、不重归一化、无分组选择；缓存执行采用显式选择的 expanded 或 absorbed 变体 |
| GLM-4-9B BASE 8K | num_layers→L、hidden_size→H、ffn_hidden_size→I、kv_channels→D、num_attention_heads→NH、multi_query_group_num→NK、padded_vocab_size→V、seq_length→M | biased QKV、无其他线性bias/无QK norm、半头RoPE、RMSNorm/最终norm、BF16、untied embedding/head、SDPA数学参考；LAST为手工输出策略，group预分配KV与额外物化假设见[范围说明](EXPANDED_MODEL_PRESETS.md) |

精确字段和条件在内置模型的 `configMapping` 中，来源于已固定的 [模型资料](MODEL_REFERENCES.md)。映射执行器不根据品牌增加数学分支；同样的描述可用于用户模板。B/Q/C 保留工作负载绑定，不由模型 config 猜测本次 batch/长度。

检查点37新增Qwen3-1.7B仍共用Qwen3配置规则和原decoder/公式修订；GLM使用新增的声明式配置规则，`chatglm`名称并不保证所有变体与此固定BASE模板兼容。未匹配条件及未知字段仍须明确核对。

`quantization_config` 的 quant_method、bits/w_bit、group_size/q_group_size、desc_act、sym、zero_point、version、modules_to_not_convert 可识别为待核对元数据。它们**不会自动应用**存储 packing、辅助项、转换开销或 ComputeClass；需要显式配置量化，或说明当前未采用。其他量化键仍列为未知。torch_dtype 不符合模板时也需说明，不能仅凭字符串套用硬件峰值。

token ID、训练辅助字段及模板不计成本的配置会在“已识别但不参与当前成本的元数据”中列出理由。原始字段全部保留；未知字段不静默删除。来源里的固定型号说明会标为模板参考，当前层数/专家数以新参数表为准，不把原模板的“26 层/64 专家”等描述冒充导入后的数字。

## 保存、来源与验证

未选模板使用 `ConfigImportSeed` 作为 AssetDraft.candidate；选模板后是带 `configImport` 的模型候选。原 config、文件名/格式、模板固定引用、规则快照、值的 config/manual 来源、核对说明和状态一并保存。缺项、错误类型/范围、过期映射记录或未解决说明阻止正式提交；不会覆盖既有资产。

发布后 `ResolvedParameter.source.kind=config_import` 保留文件、JSON Pointer 和 config/manual 来源；场景/节点覆盖仍优先。选中展开叶节点可查看“原始公式与固定来源”，沿固定模块/算子追踪公式表达式、输入单位及已绑定结果。未自动采用的字段与用户说明进入模型假设和结果来源。

`npm run reference:config` 生成可移植项目与独立摘要：

| 项目 | 权重 | 状态 | matrix useful operations |
| --- | ---: | ---: | ---: |
| `examples/config-import/qwen-small/project.json` | 616 B | 32 B | 624 |
| `examples/config-import/deepseek-small/project.json` | 1436 B | 384 B | 5712 |

这些是人工尺寸、人工硬件案例，不是真实型号性能。`unknown` 子目录提供保留缺项/未知状态/量化信息的未完成草稿，不能当作已适配模型计算。

验证包括 `tests/config-import.test.ts` 的独立算术与跨服务重启、`tests/integration/config-api.integration.ts` 的类型化解码/同源与 YAML 拒绝路径，以及 `tests/e2e/config-import.spec.ts` 的已知/未知草稿、重开修复、正式发布、导出复算、shape 拒绝和延迟响应保留新编辑。完整门禁为 `npm run acceptance:p2`。
