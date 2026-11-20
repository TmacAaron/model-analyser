# P2 结构、依赖与公式验收

状态：检查点 22（2026-11-14）逐项验收通过。本页按原实施计划 P2、PRD F01–F02 对照实际实现。

## 原工作项与退出条件

| 原工作项 | 权威证据与已验证行为 |
| --- | --- |
| 可重复、可混合的模块模板与实例化 | `tests/instantiate.test.ts` 验证 chain/independent、携带接口、重复输出 view、特殊实例覆盖、稳定路径转义、分支、shape 失配和规模预算；DeepSeek 的首层 Dense + MoE repeat 验证混合层型 |
| 配置表增删节点、修改参数与依赖、稳定 ID | `tests/graph-editing.test.ts` 与 `tests/e2e/graph-editor.spec.ts`：新建模块/模型、引用/自定义节点、排序/删除、参数和 repeat/公式绑定、数据/控制/同步边；改名/重排不换 ID，删除只清理关联边，不破坏共享存储 |
| 层级树与按需依赖图，包含/数据/同步/状态区分 | `structure-view.tsx` 的分批依赖图、`structure-tree.tsx` 的按需包含分支与叶节点选择；浏览器生成 4 叶节点/模块/repeat 树；状态列表独立，不能用包含关系代替数据流 |
| 分开 prefill/decode，跨步状态不形成单步环 | `tests/state-models.test.ts`、`tests/decode.test.ts`、`tests/instantiate.test.ts` 的两阶段递归/共享状态与版本 carry；`tests/e2e/state-models.spec.ts` 验证跨重开/测量与序列；非法单步环留为草稿 |
| 受控公式、shape、单位和定位 | `tests/formula.test.ts` 的 AST/白名单/惰性条件/有界 sum/拒绝脚本与溢出；`tests/instantiate.test.ts` 的接口 shape 与单位；结构 inspector 显示 shape/精度/绑定值，固定来源面板追踪原公式表达式与输入单位；config 浏览器核对 QKV 公式 |
| 已知 config 匹配草稿、未识别/缺项清单 | `tests/config-import.test.ts`、真实 HTTP 和 4 个 config 浏览器场景：JSON/YAML、已知声明匹配、未知模型显式选模板、缺项移除默认、数字字符串拒绝、手工修复/改映射、量化元数据、跨重开、核对后发布与默认 shape 拒绝 |
| 两个代表模型与自定义总成本降级 | [固定来源模型](MODEL_REFERENCES.md) 的 Qwen3-0.6B Dense/GQA、DeepSeek-V2-Lite MoE/MLA 及明确缓存变体；`examples/editing` 的自定义 3×2+3=9 s 模块/模型，完整成本/接口/状态公式继续用契约与高级 JSON 表达 |

退出条件“模板修改自动持久化、模型可展开到算子并解释公式、未知结构仍可用户定义继续分析”的对应证据分别为结构表单跨重开、原始公式追踪与绑定结果、可复算自定义模块。config 从未选模板的 seed 开始就持久化；缺项/核对未完成不出现在正式模型选择列表，修正后发布可复用模型。

## F01–F02 的补充核对

- 资产类型和模型家族筛选来自扫描索引，不靠手工总注册表。当前有具体 Qwen/DeepSeek 变体，未知家族来源和用户资产可分类；没有以空 GLM 目录或相近模板声称全系支持。
- repeat、混合层、分支/残差、共享 backing、跨模块状态均在通用图/存储/状态中表达；特殊实例参数覆盖由稳定实例 ID 定位。包含树可折叠 repeat，算子 inspector 保留端口、shape、位宽、计算精度、参数来源和成本。
- 自定义 opaque 节点的简洁表单为固定耗时；输出 shape、参数量对应的权重存储、FLOPs、流量及状态公式由完整 CostDefinition/图对象编辑。原要求不强制拖拽图编辑器；未把这些高级字段宣称为全部已有专用表单。
- Linear/GEMM、Norm、RoPE、attention、激活、router、专家数学节点由固定模型资产展开；原生 collective 与方案通信沿既有通用路径。公式独立资产可复用，带单位、范围、说明和来源；用户自行决定新增定义与融合方案。
- 融合保留数学成员，执行汇总只计生效组，边界/状态/外部消费者约束见 `tests/fusion.test.ts`、`tests/e2e/fusion.spec.ts`。参数变化失效旧结果，shape/状态与计算由同一快照重算；不会父模块、叶节点和融合成员重复累加。
- config 表示解析模板映射；未识别字段/结构条件和量化信息必须明确说明或手工适配。它不是通用源码解析器，也不执行权重推理。确认前的两阶段小工作负载预检只证明默认结构，不代替全部场景边界验证。

## 可复算案例与门禁

`reference:editing`：固定模块绑定 P=3，重复三份 2 s，再执行 3 s tail，总计 9 s、4 个叶节点。

`reference:config`：Qwen 小尺寸 H=4、I=6、D=2、NH=2、NK=1、L=2、V=10，B/Q/C=1/1/1：每层 132 参数、全模型 308 参数/BF16 616 B，state 32 B，matrix useful 624 operations。DeepSeek 小尺寸对应既有 718 参数/BF16 1436 B、384 state B、5712 useful matrix operations。项目与结果均由真正分析器生成，再对照独立常数；未知 config 样例保留未完成状态。

固定 Node.js 24.22.3 下执行 `npm run acceptance:p2`：P1/P0 完整门禁、HTTP、全部 Chrome 回归，再生成结构编辑和 config 参考。新增 config 来源分支使用引擎 `0.1.0-execution.11`；数值成本算法未改。三份内置模型根修订为 r2，保留 r1 基线，模块和公式修订不变。

检查点 22 完整门禁通过：289 项单元/契约、2 项真实 HTTP 集成、37 项 Chrome 测试；架构/严格编译、Schema/契约样例、独立参考与生产构建通过。新增契约的结构清单为 158 根、78 组联合、203 分支、193 个非法判别值；语义另由完整资产/计算/持久化测试证明。截图复查修正了映射表列宽，最终映射/未知字段/公式来源画面已检查。Vite 主包大于 500 kB 的提示仍在，构建成功。

P2 验收不代表 P3–P6 完成。完整 GQA TP/复制及通信预设、硬件核对、多方案差异、统一测量文件和混合并行/外部 Trace 的原退出条件继续保留。

检查点51已补主画布的真实接口／精度／计算段；选中状态关系和所有派生上下文仍继续核对。 原阶段证据不替代[剩余项](REMAINING_PRD.md)的当前要求。

检查点52已补主画布状态读写／共享关系及精确选择到成本／Roofline／测量控件；原阶段不替代其余时间线、错误项目修复和原文[剩余项](REMAINING_PRD.md)。
