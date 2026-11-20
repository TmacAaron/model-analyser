# Model Analyser 数据契约细则与验收案例

- 版本：0.1
- 日期：2026-11-13
- 上位规范：[技术与数据契约规范](./TECHNICAL_SPEC.md)
- 关联：[PRD](./PRD.md)、[实施计划](./IMPLEMENTATION_PLAN.md)
- 状态：设计文档；尚未生成运行时 Schema、产品资产或测试程序。

## 1. 文档职责

技术规范确定语言、契约来源和核心对象；本文补足字段约束、对象连接方式、保存行为及可手算的验收样例。

本轮不实现 P0。后续在 contracts 包中将这些约定落地为 Zod Schema，推导 TypeScript 类型并生成 JSON Schema。下述样例不代替真实 Schema 校验。

## 2. 字段通用规则

| 项目 | 明确约定 |
| --- | --- |
| 命名 | JSON/YAML 字段为 lowerCamelCase，判别值为 lower_snake_case |
| 必填 | 文档列出的字段默认必填；明确标注可选的字段才允许缺失 |
| ID | 非空、区分大小写；资产新 ID 为 UUID；内部端口/轴 ID 在所属定义内唯一 |
| 名称 | 非空，可重复、可修改，不参与引用解析 |
| 数组 | 空数组需显式保存；不通过缺失数组猜测空列表 |
| 可选值 | 缺失表示未提供，禁止持久化 undefined；null 仅允许在明示位置使用 |
| 关联对象 | 用稳定 ID/固定修订引用；禁止按名称匹配正式依赖 |
| 错误 | 有错误的项目可打开修复；正式计算只接受已验证的相关输入 |
| 外部字段 | 不静默吞掉未知字段；原文件信息可放 extensions，不参与计算 |
| 默认值 | 创建时一次性显式写入；已保存数据读取时不重新推断 |

### 2.1 ParameterDef 与 ParameterBinding

ParameterDef 公共字段为 key、name、description（可选）、type、unit、default（可选）。type 联合规则如下：

| type | 约束字段 | default 与绑定值 |
| --- | --- | --- |
| integer | min/max 可选，均为安全整数 | `{kind:'integer',value:安全整数}` |
| number | min/max 可选，有限数 | `{kind:'number',value:有限数}` |
| boolean | unit 必须 scalar，不允许数值范围字段 | `{kind:'boolean',value:boolean}` |
| enum | choices 为非空、不重复字符串数组；unit 必须 scalar | `{kind:'enum',value:choices 中的字符串}` |

ParameterBinding 固定为 `{parameterKey, value}`，value 为上述参数值或数值 ValueExpr。enum/boolean 不接受数值表达式；引用目标存在且类型一致。数值默认值同时受单位与范围约束。

实例化后的参数表每项含 parameterKey、最终值、source。source 以 asset_default/project_default/scenario_override/node_override/config_import 判别，并记录适用 ID。绑定完成后才求值，缺失必需参数不补零。

### 2.2 统一诊断

Diagnostic 固定字段：diagnosticId、severity（error/warning/info）、code、message、location。location 为 asset/node/scenario/file 的判别联合，分别记录相关 ID、可选字段路径、文件显示名和行列。

首批领域 code 包括 missing_reference、reference_kind_mismatch、duplicate_id、invalid_formula、unbound_symbol、invalid_unit、invalid_shape、dependency_cycle、unresolved_partial、missing_communication、numeric_overflow、precision_estimate、unknown_measurement_scope。

错误阻止受影响计算；警告保留显式假设。不能仅因某节点失败而将整个结果替换成一个零值。

## 3. 对象连接与归属

### 3.1 结构连接

| 对象 | 字段 | 校验 |
| --- | --- | --- |
| PortSpec | portId、tensorId | portId 在当前输入/输出接口中唯一；tensorId 在本图存在 |
| AxisSpec | axisId、semantic、size | axisId 在张量内唯一；size 求值后为合法安全整数 |
| DataEdge | edgeId、from、to、tensorId | 端点存在且绑定到同一张量；禁止冲突生产者 |
| DependencyEdge | edgeId、fromNodeId、toNodeId、kind | kind 为 control/synchronization；无自环和数据/控制组合环 |
| PortBinding | portId、tensorId | 子模块接口映射到父图张量；不改变子资产定义 |
| StateBinding | localStateId、parentStateId | 子状态映射到父状态，状态类型与容量约束兼容 |

图内 ID 先在各自对象类别内唯一；解析实例时加上模块路径和重复索引，生成稳定实例 ID。不同模块局部同名不意味着共享。

模块边界端点明确为：

- `{kind:'graph_input',portId}`：从当前图输入出发。
- `{kind:'node',nodeId,portId}`：节点端口。
- `{kind:'graph_output',portId}`：到当前图输出结束。

一个输入端口只能绑定一个来源；多来源合并必须显式使用加法、拼接、归约或自定义算子。一个输出可以被多个消费者读取。多个消费者不自动复制底层显存，但会产生多次节点访问。

### 3.2 重复层

chain repeat 使用 outputPortId → inputPortId 的 carry 建立相邻实例依赖；外部连线对接首输入和末输出。未被 carry 的输入显式广播，不能误连成逐层更新。

例如重复 L 次的 block，hidden 为 carry，位置参数可广播。若第 0–2 层为 Dense、之后为 MoE，则建立两个 repeat 段，不使用“按层号自动猜结构”。

需要跨层复用的状态在共同父图声明，再经 stateBindings 连接到各层。不能按“重复层数×单层状态”计算此类状态总量。

## 4. 算子与成本字段

### 4.1 OperatorDefinition

| 字段 | 类型/含义 |
| --- | --- |
| category | linear/norm/position/activation/attention/router/expert/elementwise/custom |
| inputs、outputs | PortSpec 数组 |
| tensors | 接口和内部逻辑张量的 TensorSpec 数组 |
| storages | 本算子声明的 StorageSpec 数组 |
| states | 本算子拥有或要求绑定的 StateSpec 数组 |
| phases | prefill/decode 的非空子集 |
| cost | CostDefinition |

模块和模型通过图组合；算子描述单个逻辑计算单元。算子不依赖框架、设备型号或真实 kernel 名。算子可以有多个计算段，便于表示内部混合精度。

### 4.2 CostDefinition

| 字段 | 结构 |
| --- | --- |
| compute | ComputeSegment 数组 |
| memoryAccess | MemoryAccess 数组 |
| temporaryStorageIds | 当前节点使用的临时 StorageId 数组 |
| timing | TimingDefinition |

ComputeSegment = segmentId、computeClass、usefulOperations、executedOperations；两种工作量均为 operation 单位 ValueExpr。executedOperations 不得小于 usefulOperations，若需要不同语义，应新增明确统计项，不能借此使用负成本。

ComputeClass 固定字段为 arithmetic、inputDtypes、multiplyDtype、accumulateDtype、resource。inputDtypes 是有序 DTypeSpec 数组；resource 为 matrix/vector/custom，custom 使用额外 resourceKey。

MemoryAccess = accessId、storageId、mode（read/write）、logicalBytes、hbmEstimate（可选）。hbmEstimate 为 `{kind:'factor',value:非负有限数}` 或 `{kind:'bytes',value:byte 单位 ValueExpr}`。未配置 HBM 估计时只展示逻辑流量，不将逻辑流量伪称测量值。

实施补充：logicalBytes 可为原 byte 单位 ValueExpr，或 `{kind:'storage_allocation',passes:count 单位 ValueExpr}`。后者显式读取当前范围下规范存储的完整分配（packing/padding/辅助数据与局部 copies 已含），乘非负安全整数 passes；不是全局表达式的新任意对象查询。量化或 memory_bytes 改变分配后重新绑定；多个访问仍分别计流量，resident bytes 不因 passes 重复增加。未提供当前设备分配则缺项，不按位宽比猜测。

若采用逻辑流量作为理论 HBM 假设，创建器显式写入 factor=1，并记录为假设。factor 作用于该项 logicalBytes，不再叠加第二个未声明系数。

### 4.3 TimingDefinition

| kind | 必填字段 | 含义 |
| --- | --- | --- |
| roofline_bound | computeEfficiency、memoryEfficiency、computeMemoryOverlap、launchSeconds | 按计算段与指定内存通路计算理论耗时 |
| custom_formula | seconds、description | seconds 为 second 单位 ValueExpr |
| fixed | seconds、description | seconds 为非负有限数 |

computeMemoryOverlap 为 ideal/serial：ideal 使用 max(计算时间, 搬运时间)，serial 使用两者之和。先汇总各计算段时间，再应用当前选择；不默认不同精度计算段能同时占满独立资源。

效率范围为 `(0,1]`。硬件已配置有效能力时，不再次应用同类效率；如用户需要额外折减，必须显式转换为新有效能力或选择峰值＋效率，不能隐式相乘。

通信节点的成本由 CommunicationDefinition 处理，不在 CostDefinition 里再登记一份通信 payload。timing 不存在跨节点重叠含义，跨节点重叠只由 ExecutionPlan 控制。

## 5. 存储与共享边界

StorageSpec 固定包含 storageId、name、category、allocation、sharingDomain。allocation 分支：

| kind | 字段 |
| --- | --- |
| tensor | shape、dtype、quantization（可选） |
| bytes | value：byte 单位 ValueExpr |
| alias | targetStorageId |

TensorSpec 为 tensorId、name、shape、dtype、storageId。存储大小与张量物理占用的匹配由语义校验处理。alias 不得环引用，生命周期覆盖所有引用者；不是靠将一项 bytes 设为 0 来假装共享。

StateSpec 为 stateId、name、stateKind、storageIds、creator、readers、writers、updatePolicy。creator 允许节点端口或显式 initialized 来源；读写集合引用节点端口。updatePolicy 是 append/windowed/replace/static 联合，windowed 要求窗口 ValueExpr，其他分支不允许多余 window 字段。

状态实际大小由 allocation 决定。用于简化的 bytes 公式和某个分项已展开张量不能同时计量；二者是替代表达，不是可累加的两项。

共享域解释：

- request：每个请求有独立对象，可在其层间共享。
- instance：当前模型实例拥有，可供其请求共享，例如常驻权重。
- device_group：逻辑上属于设备组，实际副本/分片仍按设备分布展开，不能因此只算一张卡的容量。

第一版不实现真实跨请求 prefix page 共享的精细分配；需要研究时用明确的状态公式/覆盖值表达并标注。

## 6. 并行配置补充

### 6.1 目标选择

NodeSelector 固定支持 `{kind:'nodes',nodeIds}` 与 `{kind:'subtree',rootNodeId}`。不引入任意脚本选择器。重复实例选择使用已展开路径或整个 repeat 根，空匹配报错。

ParallelPlan 包含 assignments、communications、assumptions。每项 assignment 包含 selector、phases、tensorDistributions、storageDistributions。分布项均用对象 ID 定位，后者以底层 StorageId 为准，不能由 alias 独立设置冲突分布。

相同对象在同一阶段的多个范围发生覆盖时，必须显式给出节点级覆盖或消除重叠；不按资产扫描顺序决定最终分布。

### 6.2 通信与指标口径

CommunicationDefinition 包含 operation、groupId、source、destination、payloadDtype、sendBytesPerMember、receiveBytesPerMember、algorithm、timing。source/destination 各为 `{tensorId, distribution}`，描述通信前后张量与分布；send_recv 另需 sourceDeviceId、destinationDeviceId。两端名称为 source/destination，而非可包含斜杠的字段名。

algorithm 为 name（说明字符串）、trafficFactor、startupRounds；timing 为 bandwidthLatency（bytePerSecond、latencySeconds）或 fixed/formula。简单估算按发送路径有效流量除带宽，加启动轮数乘延迟。所有数值明确是每成员还是组汇总，界面展示时不得混用。

为避免两个字段名体系，上位规范中的 payloadBytes 指此处的 sendBytesPerMember，输入/输出分布分别归入 source/destination。实施字段一律使用此处明确名称。

流量系数表示算法在当前发送 payload 基础上的放大量，不从 collective 名称再自动乘一次。复杂拓扑或读写链路不对称时使用自定义通信耗时，不在首版推断路由。

## 7. 项目保存与自动持久化状态机

### 7.1 草稿与正式定义

```text
用户新增或编辑
  → dirty
  → saving_draft
  → draft_saved
  → validating
       ├─ 不完整/不合法：保留草稿＋诊断
       └─ 合法：committing
                  ├─ 成功：committed（新修订可选）
                  ├─ 冲突：conflict（保留草稿）
                  └─ 写入失败：save_failed（保留待写数据）
```

状态机是 UI/本地服务协调约定，不写入正式资产内容。新的编辑使当前代变为 dirty；旧代响应不得覆盖新代状态。validating 和提交在防抖编辑批次结束后自动执行，无需用户点“保存为预设”。

### 7.2 修订与依赖

1. 新定义创建 draftId、assetId；新资产 baseRevision=null。
2. 草稿先落盘，合法后提交正文。子资产依赖必须先有有效修订。
3. 不可变修订写入成功后，替换 head；随后清理已提交草稿或保留较新编辑代。
4. 未引用的写入残留不自动当作有效 head；重启扫描给出可恢复记录。
5. 用户当前正在编辑的项目可明确跟随该次编辑产生的新修订并重算；其他项目固定旧快照，不自动升级。
6. 修改内置资产先生成用户副本；当前编辑引用切换到副本，旧内置仍可用。
7. 独立文件导入显式记录来源并保留ID／revision；普通编辑和冲突后明确创建的本地修订从当前head继续。head的发布成员列表隔离跨版本跳跃中的残留文件，补入历史不回退head；保存版本与后续编辑基线分开，详见[固定修订导入](FIXED_REVISION_IMPORT.md)。

不使用复杂数据库事务；以草稿先存、修订不可变、head 最后替换的顺序实现失败可恢复。

### 7.3 项目参数覆盖

NumericOverride = target、field、value、description（可选）。target 为 project/scenario/node/storage/device 的判别联合；field 使用各目标的白名单键，不能输入任意 JSON 路径。

首批覆盖项限定为参数值、固定耗时、效率、显存 bytes、流量 bytes、通信带宽/延迟；改变结构、公式正文或算子定义要走资产编辑。结构新增自动入库，不偷偷变成只能在当前项目存在的匿名定义。

## 8. 结果与测量范围

MetricScope 为 `{phase, target, deviceIds, aggregation}`，aggregation 为 per_device/group_total/model_useful；不同 scope 不直接相加或比较。跨多张卡的有效模型成本不再次乘设备数。

Provenance 为 assetRefs、formulaRefs、parameterSources、assumptions；数组允许空但必须显式出现。available 数值必须有 basis；unavailable 必须有至少一条错误或缺项诊断。

AnalysisResult 的显存部分至少包含 perDevice/equivalenceClass 的 categoryBreakdown、peakBytes、peakPoint、capacityStatus。capacityStatus 为 solved/point_only/unavailable 联合；solved 包含固定变量、求解变量、最大值、搜索范围和 limitingDeviceIds。

RooflinePoint 包含 scope、computeClass、operations、trafficBytes、arithmeticIntensity、roofPerformance、actualOrPredictedPerformance、trafficBasis。operation/byte 是图表派生数值，UI 明示其定义；不把它当作普通 byte/second 的 Quantity。

测量匹配须同时满足：目标存在、阶段一致、设备范围明确、统计方式明确、对应工作量区间可确定。时间统一秒，实际 bytes 的 per_call/interval_total 与时间方式一起换算。

inputHash 未提供的导入记录处于待绑定状态。用户确认绑定某方案的输入版本后保存绑定依据；不能把数据自动挂到当前最新方案后直接宣称是匹配实测。

## 9. 贯通的手算案例

### C01：自定义 GEMM，从公式到指标

设 M=4、N=8、K=16，输入 X[4,16]、权重 W[16,8]、输出 Y[4,8] 全部 BF16。

| 项目 | 算式 | 预期 |
| --- | --- | --- |
| 有效/执行工作量 | 2×4×8×16 | 1024 operations |
| 输入读取 | 4×16×2 | 128 byte |
| 权重读取 | 16×8×2 | 256 byte |
| 输出写入 | 4×8×2 | 64 byte |
| 逻辑流量 | 128+256+64 | 448 byte |
| 权重驻留 | 16×8×2 | 256 byte |
| 算术强度 | 1024/448 | 16/7 operation/byte |

测试硬件是人为构造值：1000 operation/s、100 byte/s、启动开销 0，效率均 1，显式采用 HBM factor=1。理想计算/搬运重叠下，理论耗时 max(1.024,4.48)=4.48 second。

输入实测时间 5 second，单卡同范围：MFU=1024/(5×1000)=20.48%；估算 MBU=448/(5×100)=89.6%。未提供测量 bytes，因此标签必须是估算 MBU。该案例仅为口径验证，不代表真实硬件速度。

验证路径：新建公式 → 新建算子 → 创建模型图 → 硬件 → 方案 → 计算 → 手工测量 → 关闭重开。新增定义均应自动成为资产。

### C02：W4 权重与分组 scale

沿用 W[16,8]，128 个权重，payloadBits=4，无额外 padding，group size=32，每组一个 FP16 scale，无 zero point。

- 权重 payload：128×4/8=64 byte。
- scale 数量：ceil(128/32)=4，占 4×2=8 byte。
- 合计：72 byte。
- 输入输出仍 BF16 时，逻辑流量为 128+72+64=264 byte；该值假设一次读取权重与 scale，无额外中间读写。
- 数学工作量仍为 1024；实际计算分类取决于用户指定，不能自动标为 INT4 或自动获得四倍速度。
- 若显式增加量化/反量化步骤，其额外 FLOPs、流量和临时空间另列；不重新加一份权重驻留。

再把权重元素数改为 130：紧密 4 bit payload 为 65 byte，scale 为 ceil(130/32)×2=10 byte，合计 75 byte。若明确选择每组 payload 补齐到 32 元素，则 payload=80 byte，总量=90 byte，不能把两种打包假设混用。

### C03：GQA 复制、TP 与设备组复用

构造 B=2、历史长度 T=16、KV heads=2、headDim=4、KV BF16、1 层普通 KV。

- 逻辑总 KV：2×B×T×KV heads×headDim×2=1024 byte。
- head 按 TP=2 均分：每卡 512 byte，总物理 1024 byte。
- 两卡均复制完整 KV：每卡 1024 byte，总物理 2048 byte。
- 如果另一个模块使用同两张卡组成 SP 组，物理设备数仍为 2；不能变为 TP×SP=4。
- 该例不含 DCP/序列切分，不能在结果上额外除以某个未声明的并行度。

### C04：状态共享与独立读取

两个模块引用同一请求内的一份 64 byte 状态；每个模块都完整读取一次。

- 每请求每设备驻留：64 byte，不能计算为 128。
- 逻辑读取：128 byte，不能因共享降到 64。
- B=3 且请求不共享：驻留为 192 byte，逻辑读取为 384 byte。
- 若第二模块仅复用已有 Top-K 索引，去掉它的选择计算；后续 attention 仍保留自身工作量和读取。

### C05：多流耗时与临时空间

构造固定耗时节点：准备 1 ms → A 2 ms 与 B 5 ms → 汇合 0.5 ms。A/B 同时依赖准备完成，汇合依赖 A/B。资源策略设 ideal，无启动与争用额外开销。

- 串行：1+2+5+0.5=8.5 ms。
- 双流：1+max(2,5)+0.5=6.5 ms。
- 理论掩盖收益：2 ms。
- A 在自身执行期间使用 2 GiB workspace，B 使用 3 GiB，结束即释放，输出和其他空间另计：串行 workspace 峰值 3 GiB，重叠峰值 5 GiB。
- 添加 A→B 依赖后，不能继续报告 6.5 ms。
- 改为共享带宽或用户效率折减后必须重新估算，不能沿用 ideal 数字。

### C06：版本与保存恢复

1. 创建公式 A@1、模块 B@1 引用 A@1，模型 C@1 引用 B@1。
2. 项目 P 保存完整 A@1、B@1、C@1 快照。
3. A 编辑成 A@2；B@1 仍指向 A@1，不会自动改变。
4. 当前用户显式更新 B 对 A 的引用，生成 B@2；若模型要采用 B@2，还需生成相应 C 新修订并更新项目引用。
5. UI 可提供一次“更新依赖并复算”操作完成这串显式更新，但不能静默递归更新全部项目。
6. 制造公式非法编辑，草稿保留，A@2 继续有效；恢复合法后再生成修订。
7. head 替换前模拟写入失败，重启仍能打开旧正式资产和新草稿。

### C07：融合物化、附加工作与整体时间

独立人工资产有输入 X（BF16 N 元素）、中间 T（BF16 4N 元素）和输出 Y（BF16 N 元素）。A 做 2 operations、耗时 1 s，读 X 写 T；B 做 3 operations、耗时 2 s，读 T 写 Y。完整读写以实际分配计 HBM。N=1 时：

| 方案 | 模型有效工作 | 实际执行工作 | HBM | 生命周期峰值 | 串行跨度 |
| --- | --- | --- | --- | --- | --- |
| 未融合 | 5 | 5 | 20 B | 10 B | 3 s |
| A+B 取消 T，附加 1 operation/0.1 s，sum_members | 5 | 6 | 4 B | 4 B | 3.1 s |
| 同上，整个组 fixed 0.5 s | 5 | 6 | 4 B | 4 B | 0.5 s |

成员数学明细保留，组只在执行/汇总中出现一次。取消 T 不能取消其数学运算；不取消 T 时保守整组驻留为 12 B，没有自动内存复用。若增加 6 B workspace，只在原子组期间存在；无关步骤不会带着该 workspace。容量 8 B，N=[1,3] 的融合峰值为 4/8/12 B，区间最大 N=2。

多卡 sum_members 以原始全局屏障累计：若 A 两卡耗时为 2/0.2 s，B 为 0.3/3 s，附加屏障 0.1 s，组跨度为 5.1 s，不能报成 max(2.3,3.2)+0.1。多卡非零附加成本需明确 extraLocalCost；effective work、packing 辅助项与实际参与设备都由显式方程和布局计算。组内需要跨卡交换时拒绝隐式融合。

运行 `npm run reference:fusion` 生成三份项目及实际 AnalysisAttempt，可导入 UI 复算。数学成员不单独提供时间区间或测量目标，融合组可作为同范围测量目标。转换的独立节点与附加成本由作者选用，当前不自动识别任意方程的语义重复。

## 10. P0 设计验收矩阵

本表保留设计验收要求；当前实现证据与尚未关闭项见 [实施记录](PROGRESS.md) 和 [验收清单](ACCEPTANCE_STATUS.md)。不能仅根据文档样例将其标为测试通过。

| 编号 | 输入/条件 | 预期 | 负责层 |
| --- | --- | --- | --- |
| S01 | 任一正式对象多一个未知字段 | 结构错误，指出路径 | Schema |
| S02 | 正式资产 revision=0 或 latest | 拒绝 | Schema |
| S03 | 数字写为字符串 | 拒绝；导入器可显式转换后再校验 | Schema/导入 |
| S04 | 草稿正文缺关键字段 | 可保存草稿，不可正式提交 | 持久化 |
| S05 | AssetRef.kind 与目标不同 | 引用错误 | 语义 |
| S06 | 模块或公式循环引用 | 显示引用链，拒绝正式提交 | 语义 |
| S07 | 引用缺失或未来格式版本 | 保留源数据，拒绝计算与覆盖 | 导入/语义 |
| G01 | 输入多来源但无合并算子 | 拒绝并定位端口 | 图校验 |
| G02 | repeat 重命名、重新打开 | 已有稳定节点映射不变 | 实例化 |
| G03 | 状态跨步更新 | 不作为单步环；验证读写时机 | 图/状态 |
| N01 | 除零、NaN、Infinity、负 shape | unavailable，不能补零 | 公式 |
| N02 | byte 输入绑定到 second 参数 | 单位错误 | 语义 |
| N03 | 估算工作量超过安全整数 | 精度提示；有限值可估算 | 数值 |
| D01 | 同两设备用于 TP 和 SP | 设备数 2，结果按实际分布计量 | 分布 |
| D02 | partial 输出未归约 | 标出未完成结果 | 分布 |
| M01 | C01–C04 的数值 | 与手算一致 | 成本 |
| T01 | C05 的依赖与流 | 8.5/6.5 ms、3/5 GiB | 调度/内存 |
| P01 | C06 的修订与恢复 | 旧项目稳定、草稿可恢复 | 文件 |
| P02 | JSON/YAML 同语义数据 | 归一化对象和计算 hash 相同 | 契约 |
| P03 | 同 ID 同修订不同内容 | 冲突，不能静默覆盖 | 导入 |
| R01 | 仅模型总时间 | 不生成子算子实测指标 | 测量 |
| R02 | 端到端 span 与累计 kernel 时间不同 | 分栏保存，不互相替代 | 测量 |
| R03 | 无对应精度算力 | 该项耗时 unavailable | 硬件 |

## 11. 文档完成与实现启动边界

本轮完成语言、强类型契约来源、结构、字段约束与数值案例。后续只有在明确开始实现后，才创建 packages/contracts、生成 JSON Schema、录入实际资产和编写验证程序。

仍允许按实现反馈收敛非核心字段，但不能另起一套任意对象模型、依赖字符串名称匹配、隐式丢弃错误或把草稿直接拿去计算。新增资产应优先复用以上结构，而不是扩展框架专用代码。
