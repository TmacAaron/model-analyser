# Model Analyser 技术与数据契约规范

- 版本：0.2，实施基线
- 日期：2026-11-13
- 关联文档：[PRD](./PRD.md)、[实施计划](./IMPLEMENTATION_PLAN.md)
- 字段细则与样例：[数据契约细则与验收案例](./DATA_CONTRACT_DETAILS.md)。技术决策以本文为准，字段细则不得引入另一套类型体系。
- 状态：规范已确定，本文不代表代码、Schema 文件或测试已经实现。

实施状态以 [PROGRESS](./PROGRESS.md) 为准。本文原设计轮次的“尚未实现”描述不覆盖后续实现记录。

## 1. 技术选型与边界

| 部分 | 确定选型 | 约束 |
| --- | --- | --- |
| 产品开发语言 | TypeScript | 界面、本地服务、计算核心、契约、测试使用同一语言 |
| 运行时 | Node.js 24 LTS 系列 | 初始化时固定仍受支持的安全补丁版本，记录在运行时配置中 |
| 模块 | ESM | 不混用 CommonJS；核心不依赖 Node 专属 API |
| 界面 | React + Vite | 单页、本地优先；无需 Next.js、SSR 或桌面容器 |
| 包管理 | npm workspaces | 一个仓库和一份 package-lock.json；不另引入任务编排平台 |
| 契约 | Zod 4 | 从 Schema 推导类型，生成 JSON Schema Draft 2020-12 |
| 元数据 | UTF-8 JSON / YAML 1.2 | 默认写 JSON，两者解析到同一契约 |
| 本地服务 | Node.js HTTP 与文件 API | 提供受控资源接口；不建设采集端或远程执行服务 |
| 计算 | TypeScript 纯函数 | 独立于 UI、文件系统、框架、GPU/NPU |
| 单元/契约测试 | Vitest | 覆盖公式、成本、引用、持久化和协议边界 |
| 端到端验证 | Playwright | 仅覆盖关键闭环，不为所有 UI 细节建测试 |
| 数据存储 | 普通文件 | 不引入数据库、ORM、消息队列或对象存储 |

TypeScript 编译必须启用 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`、`noFallthroughCasesInSwitch`，并使用 `unknown` 处理外部输入。领域模型禁止 `any`、非空断言绕过校验和无判别字段的任意对象集合。

除 Node.js/Zod 的上述基线外，其余依赖的精确版本在初始化时核对兼容性并写入锁文件，不在规划阶段编造版本号。Python 仅可用于外部用户脚本/Agent 转换，不成为产品运行依赖。库选择如需调整，应修改本规范并说明原因。

## 2. 仓库与依赖方向

以下为后续目录约定，不在本轮创建实现文件：

```text
apps/web/                 React 界面、视图模型、文件导入交互
apps/local/               本地 HTTP、目录扫描、原子写入、修订管理
packages/contracts/       Zod Schema、推导类型、协议、迁移入口
packages/core/            公式、实例化、分片、成本、调度与指标
assets/builtin/           内置 JSON/YAML 资产
data/assets/              用户资产、草稿、历史修订
data/projects/            项目与测量记录
schemas/generated/        导出的 JSON Schema，仅生成不手工维护
docs/                     需求、计划与规范
```

依赖方向：`web → core/contracts`，`local → contracts`，`core → contracts`。contracts 不依赖其他产品包；core 不调用服务和 UI。web 与 local 通过共享 DTO 通信，不直接互相导入实现。

默认由 local 提供 UI 静态文件和同源 API，监听本机回环地址。开发环境使用 Vite 代理。客户端传资源 ID，不传任意文件路径。

## 3. Schema 单一来源与校验链

### 3.1 权威来源

- `packages/contracts` 中的 Zod Schema 是权威定义。
- TypeScript 领域类型由 `z.infer` 推导，不手写第二套同名 interface。
- JSON Schema 由 `z.toJSONSchema` 导出，目标固定为 Draft 2020-12，供编辑器、用户和外部 Agent 使用。
- 正式持久化契约不使用 Zod transform、隐式 coercion 或自动 default；默认值由创建/归一化步骤显式写入。
- 引用完整性、维度约束、单位关系、图环及容量单调性等采用独立语义校验。JSON Schema 不负责表达所有领域约束，外部通过 JSON Schema 后仍需导入校验。
- 正式对象未知字段报错，不静默丢弃。第三方额外信息只可进入显式 `extensions`，其类型为递归 `JsonValue`，不参与计算。

### 3.2 数据流

```text
JSON/YAML/外部文件
  → unknown
  → 文件类型与格式版本识别
  → 已知旧版本迁移（如有）
  → Zod 结构校验
  → 引用/公式/图/领域语义校验
  → 已验证的领域对象
  → core 计算或正式保存
```

创建时默认值填充是显式步骤，并记录来源。读取正式文件不重新应用可能已变化的默认值。JSON Schema 生成遇到不可表达字段必须失败，不生成放宽为任意类型的 Schema。

草稿使用独立严格外壳，正文为 `JsonValue`，允许字段未完成；草稿内容绝不能直接进入计算核心。YAML 限制为 JSON 兼容值，禁止自定义 tag，拒绝重复键；限制别名展开与文件规模。YAML 注释/排版不承诺原样保留。

## 4. 基础类型与数值约定

以下 TypeScript 片段用于精确说明契约形状；落地时以 Zod 推导类型为准，不复制为另一套定义。

```ts
type JsonValue = null | boolean | number | string
  | JsonValue[] | { [key: string]: JsonValue };

type AssetKind = 'model' | 'module' | 'operator' | 'formula'
  | 'parallel' | 'quantization' | 'hardware';
type Phase = 'prefill' | 'decode';
type Unit = 'scalar' | 'count' | 'ratio' | 'byte' | 'second'
  | 'operation' | 'operation_per_second' | 'byte_per_second';
type Quantity = { value: number; unit: Unit };
type AssetRef = { assetId: string; revision: number; kind: AssetKind };
type FormulaRef = { formula: AssetRef; bindings: Record<string, ValueExpr> };
type ValueExpr =
  | { kind: 'literal'; quantity: Quantity }
  | { kind: 'symbol'; name: string }
  | { kind: 'formula'; call: FormulaRef };
```

- ID 持久化为非空字符串；运行时通过 Schema brand 区分 AssetId、NodeId、TensorId、StorageId、StateId、DeviceId 等，不混传。
- 应用创建的新资产/项目/测量 ID 使用 UUID。内置资产可用稳定命名空间 ID，不能由显示名称临时生成。
- 正式资产引用必须固定正整数修订号，不允许 `latest`。嵌套资产引用组成无环图；模块引用自身也不允许。
- 节点和端口 ID 为稳定本地 ID，不用数组下标或名称作为身份。重复展开采用“模板节点 ID＋重复索引路径”，改名称不影响映射。
- 时间内部一律秒，容量为 byte，带宽为 byte/s，计算能力为 operation/s；UI 在边界换算 TFLOPS/TOPS、TB/s、GiB、ms/us。
- 工作负载、shape、次数、分片尺寸和精确分配字节必须是非负/正的安全整数，具体字段规定零是否允许。
- 估算 FLOPs、累计流量、比例和耗时使用有限 `number`。超过安全整数的工作量视为浮点估计并附精度提示，不承诺逐整数精确；不能用其进行数组索引或精确分配。非法溢出/NaN/Infinity 返回诊断，不截断。
- 缺项不等于零；可选字段缺失表示未提供，只有明确允许的字段可为 null。零是合法明确数值时必须保留。
- 第一版不引入大数库或通用量纲代数系统；执行声明单位和领域规则校验。需要精确到超大整数的未来功能再扩展格式版本。

## 5. 资产、草稿与修订

```ts
type AssetDocument = {
  documentType: 'asset';
  schemaVersion: 1;
  assetId: string;
  revision: number;
  name: string;
  description?: string;
  tags: string[];
  parameters: ParameterDef[];
  sources: SourceRef[];
  definition: AssetDefinition;
  extensions?: Record<string, JsonValue>;
};

type AssetDefinition =
  | { kind: 'model'; family: string; variant: string; graph: GraphTemplate }
  | { kind: 'module'; graph: GraphTemplate }
  | { kind: 'operator'; operator: OperatorDefinition }
  | { kind: 'formula'; formula: FormulaDefinition }
  | { kind: 'parallel'; plan: ParallelTemplate }
  | { kind: 'quantization'; quantization: QuantizationDefinition }
  | { kind: 'hardware'; hardware: HardwareDefinition };

type AssetDraft = {
  documentType: 'asset_draft'; schemaVersion: 1;
  draftId: string; assetId: string; assetKind: AssetKind;
  baseRevision: number | null;
  draftGeneration: number;
  updatedAt: string;
  candidate: JsonValue;
  storageFormat?: 'json' | 'yaml';
  importIntent?: { source: AssetRef; mode: 'preserve' | 'next' };
};
```

所有带名称的子类型必须在 contracts 中有严格 Schema；不能把上表中的命名类型落地成任意字典。

补充规则：

- `SourceRef` 固定为 `{kind:'url',url,checkedOn?}` / `{kind:'note',text}` 的联合，checkedOn 使用 YYYY-MM-DD；不执行来源内容。
- 内置/用户目录、归档状态和文件格式由 `AssetIndexEntry` 管理，不作为公式输入，也不因归档修改历史定义。
- `AssetIndexEntry` 包含 ID、类型、当前修订、origin、archived、format；索引可从定义文件、head 和归档标记重建。
- 正式类型仅从 `definition.kind` 判别，避免顶层 kind 与正文 kind 不一致。AssetRef.kind 必须与目标一致。
- 修订文件不可变；新修订写完后再更新 head。head 是当前版本指针，不是第二份定义。
- 固定文件导入以`importIntent.mode=preserve`保留来源ID／修订；普通编辑或明确选择next沿当前head创建本地下一修订，副本使用新ID。历史插入不回退head，head的可选`publishedRevisions`明确列出已发布成员，跳高不隐式发布中间孤立文件；旧head首次新发布冻结原范围。`CommitResponse.headRevision`可选并固定该次提交的编辑基线，保存的历史版本仍由asset.revision表示；回执重放不跟随后来head，详见[固定修订导入](FIXED_REVISION_IMPORT.md)。
- 导入可选择转JSON或保留输入格式；`AssetDraft.storageFormat`固定本次提交格式，缺省时新定义用JSON、已有定义继承基线格式。相同修订不改写格式，可按所选格式创建独立副本。JSON／YAML多份同修订权威文件即使内容相同也隔离；回执／恢复及显式升级按唯一文件核对，详见[YAML保存格式](YAML_STORAGE_FORMAT.md)。
- `draftGeneration` 处理连续自动保存；只有最后一代响应能更新当前“已保存”状态。
- 保存基于 baseRevision 检测外部修改/并发覆盖；冲突保留草稿，不能自动覆盖。
- 普通正式编辑比较归一化内容，语义未变则不增加修订；固定导入仍保留明确来源版本。时间戳和索引状态不计入语义比较。
- 提交时先确保依赖正式修订已存在，再写不可变修订，最后替换 head；失败可留下未引用修订，不得留下指向不完整数据的 head。
- 自定义资产有效且持久化成功后立即可选；草稿和失败状态不伪装成正式资产。

## 6. 参数与受控公式

### 6.1 ParameterDef

参数以 `type` 判别，固定支持 `integer`、`number`、`boolean`、`enum`。每个参数有稳定 key、名称、说明、单位；数值类型可设 min/max，enum 有明确候选值；可选 default 必须与类型和范围一致。

参数值单独使用对应的判别联合，不用字符串同时承载数字、布尔和表达式。由 config 导入时显式转换并给出诊断。

### 6.2 FormulaDefinition

| 字段 | 类型与含义 |
| --- | --- |
| inputs | 按名称定义的数值输入，含单位、整数性和范围 |
| expression | 受控表达式字符串 |
| output | unit、integerRequired、nonNegative 等输出约束 |
| description | 数学含义和统计口径 |

inputs 的值固定为 `{unit, integerRequired, min?, max?}`，key 是输入符号；output 固定为 `{unit, integerRequired, nonNegative}`。所有绑定都按输入声明校验；不能把任意额外符号传进公式。

以下是可作为首批契约样例的完整公式资产，尚未作为产品资产文件落地：

```json
{
  "documentType": "asset",
  "schemaVersion": 1,
  "assetId": "builtin:formula:gemm-operations",
  "revision": 1,
  "name": "GEMM 运算量",
  "tags": ["gemm"],
  "parameters": [],
  "sources": [{"kind": "note", "text": "一次乘加计两次运算"}],
  "definition": {
    "kind": "formula",
    "formula": {
      "inputs": {
        "M": {"unit": "count", "integerRequired": true, "min": 1},
        "N": {"unit": "count", "integerRequired": true, "min": 1},
        "K": {"unit": "count", "integerRequired": true, "min": 1}
      },
      "expression": "2 * M * N * K",
      "output": {"unit": "operation", "integerRequired": false, "nonNegative": true},
      "description": "输出数学运算次数；计算精度由使用该公式的算子计算段声明"
    }
  }
}
```

表达式语法首批限定为：数值字面量、已声明输入、括号、`+ - * /`、比较、`if`、`min/max`、`ceil/floor`、`abs`、`pow`、`sum`。`sum` 仅接收显式上下界与局部变量，设置固定迭代上限；`if` 仅求值选中分支。无属性访问、赋值、网络、I/O 和任意函数调用。

表达式解析成内部 AST，仅缓存在内存中，不把 AST 写入资产；不使用 eval/new Function。FormulaRef 的 bindings 使公式可组合，公式调用图也必须无环并限制深度。

首版单位检查验证绑定和输出的声明单位，以及核心规则需要的单位；不声称完整证明表达式量纲。形状与成本公式的数值范围分别检查。除零、未绑定、无效范围或输出非法时返回 unavailable 与诊断，不返回零。

## 7. 模型结构与依赖图

### 7.1 GraphTemplate

```ts
type GraphTemplate = {
  inputs: PortSpec[];
  outputs: PortSpec[];
  nodes: TemplateNode[];
  edges: DataEdge[];
  dependencies: DependencyEdge[];
  tensors: TensorSpec[];
  storages: StorageSpec[];
  states: StateSpec[];
};

type TemplateNode = {
  nodeId: string;
  name: string;
  phases: Phase[];
  portBindings: { portId: string; tensorId: string }[];
  stateBindings: { localStateId: string; parentStateId: string }[];
  repeat?: {
    axis: string; count: ValueExpr;
    wiring: 'chain' | 'independent';
    carry: { outputPortId: string; inputPortId: string }[];
  };
  body: NodeBody;
};

type NodeBody =
  | { kind: 'module'; asset: AssetRef; bindings: ParameterBinding[] }
  | { kind: 'operator'; asset: AssetRef; bindings: ParameterBinding[] }
  | { kind: 'opaque'; cost: CostDefinition; inputs: PortSpec[]; outputs: PortSpec[] }
  | { kind: 'collective'; communication: CommunicationDefinition };
```

- `PortSpec`：portId、TensorId；输入输出通过端口显式连接。
- `DataEdge`：edgeId、from、to、tensorId。端点为 node（nodeId＋portId）、graph_input（portId）、graph_output（portId）的判别联合；graph_input 只能作为起点，graph_output 只能作为终点。
- `DependencyEdge`：edgeId、fromNodeId、toNodeId、kind（control/synchronization）；数据依赖从 DataEdge 推导。
- `ParameterBinding`：目标参数 key 与带类型的值/ValueExpr；禁止任意 JSON Patch 修改对象内部。
- portBindings 将被引用模块/算子的本地端口映射到父图 TensorId；stateBindings 将本地状态连接到父图状态，允许不同模块显式引用同一状态。不存在绑定时必须使用本地声明，不能靠重名猜测共享。
- 每个连边的 tensorId 必须与端点绑定一致；shape/dtype 在边界兼容。状态/权重读取可来自已初始化 Storage/State，不伪造 activation producer；状态读写先后由专用访问关系校验。
- 复用模块是资产引用；未拆解模块使用 opaque，成本只记 opaque，不额外叠加不可见子图。
- repeat 的展开顺序与 ID 固定，count 必须为正整数。chain 使用 carry 将第 i 个实例输出接到第 i+1 个输入，未被 carry 的输入显式广播；对外输出来自末实例。independent 的 carry 必须为空，输出保留重复轴。需要其他归并方式时显式添加节点，不隐式选择求和/拼接。
- repeat 的局部索引可以作为参数绑定传入实例；端点使用稳定模板 ID＋索引路径。若不同重复实例需不同结构，以独立节点/分段 repeat 表达，第一版不建设任意图改写语言。
- 实例化后生成 `ResolvedGraph`，全部引用和参数绑定完成，但仍是同一种节点/边语义；这不是另一套框架执行 IR。
- 单步阶段的数据/控制图必须是 DAG；状态跨步更新单独记录，不能用隐藏边绕过检查。
- 父模块为汇总容器，计算在当前生效叶节点执行；禁止父子两份成本重复累计。

### 7.2 融合与可视化

`FusionGroup` 包含 groupId、成员 NodeId、被取消物化的 TensorId、额外成本和时间策略。只有确认无其他消费者、无状态用途的中间张量才能取消物化。

界面坐标、折叠、颜色保存到独立 ViewState，不进入计算图或结果 hash。融合分组、同步和存储共享会影响计算，必须进入方案数据。

## 8. 张量、存储与状态分离

| 对象 | 必填信息 | 用途 |
| --- | --- | --- |
| TensorSpec | tensorId、shape 轴、dtype、storageId、producer/输入归属 | 逻辑数据与传输 |
| StorageSpec | storageId、category、allocation、sharingDomain | 显存分配与去重 |
| StateSpec | stateId、storageIds、creator、readers、writers、updatePolicy | 持久状态及更新依赖 |

shape 由有序 `{axisId, semantic, size: ValueExpr}` 组成；semantic 可为 batch/token/head/hidden/expert/vocab/custom。分片通过 axisId，不靠 semantic 名称唯一定位。

TensorSpec 的 producer 由图连接解析后生成；模板文件以端口和 DataEdge 为权威，不保存可与连边冲突的第二份生产关系。StateSpec 的 readers/writers 引用实际端口；校验其访问与节点声明一致。

`DTypeSpec` 为 `{category: 'float'|'int'|'uint'|'custom', bits: positiveInteger, format: string}`。存储位宽与运算精度使用不同字段；format 可扩展，不将全部 dtype 名称写死为不可扩展枚举。

`StorageSpec.category` 固定为 weight/state/activation/workspace/communication/graph/runtime/reserve。allocation 是以下判别联合：

- `tensor`：shape、存储 dtype 及可选量化辅助数据，自动推导。
- `bytes`：显式 byte 公式或数值。
- `alias`：指向另一个 storageId，不新增分配；alias 引用必须无环。

`sharingDomain` 明确为 request/instance/device_group；设备副本仍需通过逻辑分布推导。驻留显存按“最终 storageId＋共享域实例＋物理设备”去重；不能只按显示名称去重。

`StateSpec` 包含 stateKind（kv/latent/indexer/indices/recurrent/window/custom）、创建节点、读写节点与 policy（append/windowed/replace/static）。复杂状态通过 allocation 公式表达；policy 只规定更新语义，不替代大小公式。

计算成本与读取流量由节点声明，读取同一 storageId 仍逐次计量。复用计算结果必须显式连接既有 producer，不能因 storage alias 自动删掉节点 FLOPs。

## 9. 量化与计算精度

`QuantizationDefinition` 包含应用范围及权重/激活/状态各类 `QuantizedStorageSpec`，后者记录：

- payloadBits、packingUnitElements、alignmentBytes。
- scale/zero point 等辅助张量的 dtype、数量公式或分组规则。
- 分组支持 tensor/channel/block/group；用轴 ID 与块尺寸定义作用范围。
- 边缘块默认按 ceil 计辅助项；不同规则用显式数量公式覆盖。

`ComputeClass` 包含 arithmetic（float/integer）、inputDtypes、multiplyDtype、accumulateDtype 和资源类别（matrix/vector/custom）。输出存储 dtype 来自 TensorSpec，不能反向强制内部精度一致。

一个算子可有多个 compute segment，每段绑定 ComputeClass 和工作量；混合 8/16 bit 由多段表达。量化/反量化以独立节点或融合组附加成本二选一。

通信使用通信节点上的 payload dtype；未填时由源张量明确继承，归一化后保存，不永久依赖隐式默认。

## 10. 设备、逻辑分布与并行

### 10.1 HardwareDefinition

- capacityBytes：显存容量。
- computeCapabilities：ComputeClass 匹配条件、峰值 operation/s 或有效 operation/s；使用 kind 判别，只能选择一套生效口径。
- memoryCapabilities：通路 key、峰值或有效 byte/s，默认 hbm；mte2 等通路可单独增加。
- communicationDefaults：组内/组间带宽、延迟和说明，不宣称代表真实网络。
- 缺少所需精度能力时，相关耗时 unavailable；不按 dtype 位宽自动推断倍速。

### 10.2 DeviceTopology

使用 `DeviceInstance[]` 定义唯一物理 DeviceId，每个设备引用硬件修订；`DeviceGroup[]` 明确 members。多个组可共享设备，物理卡数按 DeviceId 去重。

每个 group 可选声明 MeshAxis 与坐标到 DeviceId 的映射，轴乘积必须等于该组成员数。计算时可对对称坐标压缩为等价类，存档仍保留可还原的映射规则。第一版不模拟物理网络路由。

### 10.3 TensorDistribution

分布采用 `replicated`、`sharded`、`partial`、`manual` 判别联合：

- replicated：groupId，每成员持有逻辑完整副本。
- sharded：groupId、轴映射 `{tensorAxisId, meshAxisId}`、切分策略 even/padded/explicit；explicit 给出切片范围。
- partial：groupId、reduceOperation，表示待归约部分结果；不能当作完成输出。
- manual：每成员/等价类的本地 shape、复制数及说明，标记用户假设，适合先期探索。

`ParallelTemplate/ParallelPlan` 定义 target NodeId/模块范围、适用阶段、各 TensorId/StorageId 的 distribution、插入通信、边界假设。名称 TP/SP/EP 等仅为预设标签，不决定 world size。

通信 `CommunicationDefinition` 固定支持 all_reduce/all_gather/reduce_scatter/all_to_all/send_recv，字段包含 groupId、输入输出分布、每成员发送 payloadBytes、算法流量系数、启动轮数、带宽、延迟及可选直接耗时覆盖。接收 bytes 独立声明/推导，不和发送简单相加后再次套带宽。

`send_recv` 必须给 source/destination；collective 的组内汇总与每成员成本分别输出。复杂算法先由用户系数/公式表达，不增加框架专用参数。

## 11. 方案、执行计划与成本

### 11.1 Scenario

方案固定包含 scenarioId、名称、model AssetRef、参数绑定、workload、deviceTopology、parallelPlan、executionPlan、quantizationOverrides、numericOverrides。

workload 采用判别联合：

- prefill：batchSize、queryTokensPerRequest、pastTokensPerRequest、可选 chunkTokens。
- decode：batchSize、contextTokensPerRequest、queryTokensPerRequest（默认 1）、steps。

第一版等长请求；总 token 是派生值，不能同时保存一个可与分项冲突的总数。多步 decode 默认逐步更新上下文后累计；若使用固定上下文近似必须显式设置 approximation 并标注。

Override 为带目标 ID、字段 key、类型化值和说明的联合，禁止任意对象路径修改。覆盖顺序与 PRD 一致，结果记录最终来源。

### 11.2 ExecutionPlan

采用 `{kind:'serial'}` 或 `{kind:'streams', assignments, extraDependencies, resourcePolicy}`。assignment 指定 NodeId、DeviceGroupId 和 StreamId。相同物理设备上的流内顺序与设备组重叠都需要检查。

resourcePolicy 为 ideal/shared_bandwidth/user_efficiency；其名称与参数写入结果。调度输出 `{nodeId, deviceScope, streamId, startSeconds, endSeconds}`。时间线用于当前假设下的生命周期估算，不声称是真实硬件 trace。

### 11.3 CostDefinition 与结果

- compute：各 ComputeClass 的 workOperations，分别记录 useful 与 executed。
- memoryAccess：read/write StorageId、逻辑 byte 公式，可选重读/有效 HBM 公式。
- communication：独立节点的发送/接收和算法流量。
- temporaryStorageIds：引用 StorageSpec；禁止同时在 cost 与 storage 两处独立累加同一份空间。
- timing：roofline_bound/custom_formula/fixed 的判别联合；roofline_bound 中计算段默认求和，计算与搬运如何重叠明确设置。

采用以下统一结果外壳区分缺失和有效数值：

```ts
type MetricValue =
  | { status: 'available'; quantity: Quantity;
      basis: 'theoretical' | 'estimated' | 'measured';
      provenance: Provenance; diagnosticIds: string[] }
  | { status: 'unavailable'; diagnosticIds: string[] };
```

`Provenance` 明确资产引用、公式引用、输入/覆盖来源与假设；诊断数量不代表测量置信度。部分节点不可计算时相关完整汇总 unavailable，可另外展示明确标注的已知小计。

`AnalysisResult` 包含 engineVersion、inputHash、scenarioId、阶段与范围、各节点成本、模块汇总、按物理设备/等价类的显存、调度、容量、Roofline 和诊断。hash 对归一化计算输入和传递依赖快照计算，不包含坐标、颜色、注释和测量值。

实测对比单独以 inputHash 与 measurementHash 关联，修改测量不使纯理论结果失效。代码算法变更通过 engineVersion 区分，不伪装成相同版本的可复算结果。

## 12. 项目、测量与文件协议

### 12.1 ProjectDocument

字段固定为 documentType='project'、schemaVersion、projectId、projectRevision、名称、scenarios、assetSnapshots、measurements、viewState。assetSnapshots 包含全部传递依赖的正式 AssetDocument；重复引用按 `(assetId, revision)` 去重。

项目草稿独立保存，不将不完整 AssetDraft 放入正式快照。若项目有未确认修改，导出必须注明草稿状态并附恢复内容，不能声称可完整复算。

保存项目使用 projectRevision 检查覆盖；所有引用先从项目快照解析，再考虑用户显式导入的资产。项目打开不自动替换资产版本。

### 12.2 MeasurementRecord

- measurementId、scenarioId、inputHash（无法确定时留空待确认）。
- target：node/module/model/unmapped 的判别联合；unmapped 只含原事件名与来源，不能计算目标指标。
- phase、DeviceId 范围、step/区间说明、count。
- time：`single`、`mean`、`sum`（各含 seconds）或 `span`（startSeconds/endSeconds），以 kind 判别。count 只在记录顶层保存一次；single 要求 count=1，mean/sum/span 的 count 为该区间明确覆盖的调用数。
- 可选实际 read/writeBytes；必须声明 per_call 或 interval_total。
- source：manual/import/agent、原文件/事件 ID、可选映射依据。

单次和平均值乘次数仅得到累计工作时间，不能自动作为多流端到端跨度。缺少目标范围或时间口径时不计算 MFU/MBU。CSV 为该契约的受控扁平映射，导入后仍通过同一 Schema 和语义校验。

### 12.3 本地 API

只实现资源级接口：列举/读取资产、保存草稿、提交有效修订、归档、读取/保存项目、导入校验和重新扫描。路径版本统一 `/api/v1`。

请求和响应都在 contracts 定义 Schema；响应采用 `{ok:true,data}` / `{ok:false,error}`。error 包含 code、message、fieldIssues、可选 currentRevision；首批 code 为 validation/reference/conflict/io/not_found/unsupported_version。

写请求包含 requestId、expectedRevision（或 draftGeneration），写入确认后返回实际 revision/generation。客户端按 requestId 对齐响应，冲突显式返回，不能把旧响应应用为最新状态。单进程对同一资源串行写入；不建设多用户事务系统。

## 13. 版本、迁移与兼容性

- schemaVersion 表示文件格式；revision 表示资产内容；engineVersion 表示算法，三者不能混用。
- 首版 schemaVersion=1。仅支持明确实现的版本，遇到未来版本保留文件并拒绝计算/覆盖。
- 迁移为显式纯函数链，先读取旧结构、生成新数据并校验；不破坏性覆盖原文件。
- 迁移、YAML/JSON 转换和项目快照不得改变 ID、修订引用或数值单位而不记录变化。
- 纯资产新增无需 schemaVersion 变化；增加全新字段语义则根据兼容规则升级格式并提供迁移。

## 14. 契约验收与实施要求

1. 每种资产和项目至少提供一份有效样例；关键联合的每个分支都有样例。
2. JSON/YAML 对等输入归一化后得到相同对象与 inputHash。
3. Zod 校验和导出 JSON Schema 的结构接受范围通过代表性正反例对照；额外语义校验单独测试。
4. 非法字段、未知判别值、缺失引用、错误单位、循环图、溢出和无效公式均返回可定位诊断。
5. 验证 storage 去重不抹掉读取流量；group 复用不重复增加设备；partial 结果必须归约。
6. 草稿、有效修订、旧项目快照、保存冲突和失败恢复均有跨重启验证。
7. core 在不启动 UI 和本地服务时可独立计算手算样例。
8. 新增一个已有语义下的模块/公式/模型 JSON 文件并重新扫描，无需改 TypeScript 即可使用。
9. 所有契约作为实现起点，P0 编写 Schema 和样例并验证后才能宣告契约落地；本文不将设计片段当作已实现类型。

## 15. 选型依据

- [Zod 的 JSON Schema 导出与不可表达类型限制](https://zod.dev/json-schema)
- [TypeScript 严格编译选项](https://www.typescriptlang.org/tsconfig/)
- [Node.js 官方发布与支持周期](https://github.com/nodejs/Release)

## 16. 已落地字段补充

为使结果接口可生成严格 JSON Schema，实现使用以下明确字段；不改变前文的单位/统计语义。

- Scenario 增加必填 `fusionGroups: FusionGroup[]`，未融合时显式写 `[]`。FusionGroup 为 `groupId`、`memberNodeIds`、`eliminatedTensorIds`、`extraCost` 与 `timeStrategy`。`sum_members` 累计成员时间和附加成本时间；`override` 用 `timing` 与 `description` 声明整个融合组时间，不能再叠加成员/附加成本的 timing。数学成本仍保留成员成本与明确的附加成本。
- AnalysisResult 的主体为 `engineVersion/inputHash/scenarioId/phase/scope/nodes/modules/total/memory/schedule/roofline/diagnostics`。节点、模块分别包含稳定 `nodeId` 与 CostResult；模块另列 `leafNodeIds`，不会将容器再算一次成本。
- CostResult 为 `scope/compute/logicalReadBytes/logicalWriteBytes/hbmBytes/communications/seconds`。不同运算精度分别进入 compute 数组，通信同时明确每成员与组汇总发送/接收。
- MetricScope 使用 `phase/target/deviceIds/aggregation`；DeviceScope 为 `per_device(deviceId)` 或 `equivalence_class(classId,deviceIds)`。等价类里的 bytes 表示每个成员设备的值，不能冒充组汇总值。
- MemoryPeak 为 `deviceScope/categoryBreakdown/peakBytes/peakPoint/capacityBytes/capacityStatus`。categoryBreakdown 是 `{category,bytes}` 数组；峰值时刻的分解应与 peakBytes 一致。peakPoint 为 `{kind:'time',seconds,nodeId?}` 或 `{kind:'order',index,nodeId?}`；耗时未知时只能给执行序号，不虚构秒数。容量使用 `kind=solved/point_only/unavailable`；solved 包含 `fixedVariables/solveVariable/maximum/searchRange/limitingDeviceIds`。
- RooflinePoint 的 `arithmeticIntensity` 使用 `status=available` 与 `operationsPerByte`，或 `status=unavailable` 与诊断 ID。流量为零时不持久化 Infinity，也不伪造零强度。
- RooflinePoint 明确包含 `computeCeiling`（operation_per_second）和 `memoryBandwidth`（byte_per_second），用于复算曲线。当前理论点以 executed work 为分子，各 ComputeClass 分开；每类使用该叶节点完整流量作为明确共享流量假设。若 HBM 假设缺失而采用逻辑流量，trafficBasis 必须保留该区别，不能作为物理 MBU 的流量。
- AnalysisAttempt 与 MeasurementComparisonAttempt 均以 available/unavailable 判别；可生成部分分析报告时，个别 MetricValue 仍可能 unavailable。MeasurementComparison 记录 `measurementId/inputHash/measurementHash/engineVersion/scope/normalizedTime/mfu/mbu/mbuBasis/diagnostics`。normalizedTime 保留 single/mean/sum/span、count、intervalSeconds 与 perCallEquivalentSeconds；span/count 只是区间归一化量，不冒充单次延迟。
- MFU 使用各计算精度的 useful work 和同设备范围唯一峰值，不以 effective 能力冒充峰值。MBU 在 actualBytes 明确为物理 HBM 计数时使用 measured_hbm，否则只可使用 estimated_hbm，不能直接代入逻辑读写。比值超过 100% 保留原值并诊断，正值下溢也不能伪装成零利用率。
- inputHash 采用规范 UTF-16 键序列化与 SHA-256，范围为当前方案计算字段和可达固定依赖快照；名称、视图、测量、无关资产不改变理论输入 hash。engineVersion 独立记录算法版本，测量另有 measurementHash。当前引擎标识 `0.1.0-execution.10`，支持方案融合、原生通信、逐步 decode 和下述多流资源模型。
- CapacitySearchRequest 使用 `variable`（workload 字段或根模型整数 parameterKey）及显式整数 `searchRange={min,max}`；当前单次最多 512 点，方法为 exhaustive_integer，无须假设单调。CapacitySearchResult 包含 `engineVersion/baseInputHash/baseScenario/request/method/completion/points/capacityStatus/diagnostics`；每点保留 value、inputHash、各设备 peakBytes/capacityBytes、fit、分精度 compute、HBM/seconds 与诊断，计算失败点单独 unavailable。
- 容量搜索不修改基础方案。工作负载扫描仅改变该字段；根参数扫描替换该参数绑定及项目/方案/根节点参数覆盖，保留所有其他参数与子节点覆盖。fixedVariables 用 workload./binding. 前缀区分名字，完整基础方案另存 baseScenario，表达式绑定保持原定义。
- 容量 solved 表示完整指定区间中的最大可容纳整数；逐点检查允许后续出现非单调的可行区间。若最大已知可行值以上仍有不可计算点，则 unavailable；区间没有可行点也不返回虚构的 0。上界仍可容纳时必须诊断范围受限；limitingDeviceIds 在下一整数记录实际超限设备，在区间上界记录剩余 bytes 最少的设备，后者不代表已证明全局瓶颈。
- 搜索在 Web Worker 中执行，逐点让出消息处理以接收取消；取消保留已完成点但 capacityStatus unavailable。计算输入或搜索条件改变后终止过期 worker，隐藏旧结论。单点分析报告的 point_only 与独立容量搜索报告分开，搜索结果不覆盖基础方案的 inputHash。
- 搜索结果除结构 Schema 外另经 `validateCapacitySearch` 核对完整枚举、点顺序、设备范围、fit 与峰值/容量、最大值证据、取消状态和诊断引用；格式合法不代表容量结论成立。
- TensorPartitionResult 包含 tensorId/dtype/groupId/distribution/globalShape、coverage、placements 和诊断。每个 placement 保留设备、logicalShape/allocatedShape、每份 logicalElements/allocatedElements、copies 及 `[start,end)` 全局 slices/paddedExtent。unused mesh 轴保留副本；padded 不能将物理补齐元素算作有效逻辑元素；manual 不证明全局覆盖，partial 不代表已归约。
- 显式分片对每个设备的每个分片轴提供唯一非空切片；按已用 mesh 坐标去除副本后，检查盒子无重叠且体积完整覆盖逻辑张量。同一未分片 mesh 坐标上的副本必须相同；不同分片轴不复用同一 mesh 轴。单组分布上限 1024 设备，张量/mesh 上限 32 维。
- StoragePartitionResult 包含请求 storageId、canonicalStorageId、distribution、perDevice 和诊断。每设备提供 copies、一份完整 StorageAllocationResult 及 totalBytes；一份局部存储先按物理局部 shape 重新分配，再乘 copies，不能先把各份元素拼起来再对齐。显式辅助数公式使用当前求值上下文，不自动猜测局部参数绑定。bytes 分配没有轴，不能隐式切分。
- CommunicationEvaluation 保留完整 definition、源/目标分布、CostResult、逐物理设备发送/接收/算法流量和诊断。当前独立求值要求 group_total 范围精确匹配实际参与设备，seconds 为该次通信跨度；组发送/接收 payload 是成员值求和，算法系数只作用于发送路径一次。send_recv 的发送与接收值仅应用于对应端点。网络 payload 不确定本地读写、HBM、归约算术或 staging 分配，这些成本必须另行声明。
- 独立设备映射/通信原语本身不构成完整多设备 AnalysisResult；逻辑全局成本不能只依据 tensor 分片比例推断任意 GEMM/attention/自定义算子的局部工作量。局部数学成本使用下述显式 LocalCostRule，完整通信与执行边界仍需处理。
- ParallelResolution 是独立布局结果，包含 engineVersion/inputHash/scenarioId/phase、tensorLayouts、storageLayouts、storageAllocations、communications、deviceAllocations、localCosts、execution、memory、未配置对象/节点使用和诊断。tensorLayouts 与显式 storageLayouts 按 `(nodeId, objectId)` 保留生效 assignmentIndices 及 overriddenIndices；storageAllocations 按规范 StorageId 保留 category、aliasIds、使用节点和唯一物理分配。deviceAllocations.knownBytes 是已声明分配合计，memory 才是按每设备实际存活区间计算的峰值。
- 布局作用范围仅应用当前 phase。选择器使用展开节点/容器路径，`$model` 选择整个模型；repeat 根覆盖实际实例。作用域内可见的全局对象 ID 优先，否则通过 objectBindings 映射局部对象；局部张量轴随绑定映射。存储分片使用展开存储的轴名，不猜测 view 与 backing 的维度变换。
- 明确指定实际叶节点的 nodes 规则优先于容器/subtree 范围。相同优先级有不同布局则诊断，不能依数组顺序覆盖；先决定优先级，再求值生效布局。复用不同组名时按实际设备/切片比较，不能只凭分配 bytes 相同认定布局相同。
- 多个节点要求同一规范存储采取不同物理分配时拒绝，需统一 backing 或拆成独立存储。明确的较大 backing 可容纳局部张量需求；张量 view 与底层 shape 不同而缺少明确维度映射时拒绝隐式分片。分配只按规范身份计算一次，规则及张量使用分别保留。
- 布局边界区分完全一致、同卡已有有效切片的本地 view、待补通信以及已声明但尚未插入顺序的通信。partial 的最终核对在展开后按对象/实际组/归约操作进行；导入阶段只有潜在匹配而对象或组别名尚未绑定时，给出 deferred_partial_binding warning，不能当成归约已完成。
- validateParallelResolution 独立检查唯一规范分配、alias/设备行、类别合计、每份×copies、节点使用缺项与布局互斥和诊断引用；精确字节求和溢出保留 unavailable。布局解析最多 20000 个作用项，在独立 Web Worker 中运行，取消或输入改变时终止旧线程。局部算子成本由下述 localCosts 提供；validateExecution 另检查屏障耗时、绝对时刻、已知区间、缺项传播、峰值分类及物理分配边界。
- OperatorDefinition 与 opaque body 可选声明 LocalCostRule（字段 localCost）：`participation/bindings/cost/description`。participation 为 tensor_layout(tensorId) 或 storage_layout(storageId)，明确参与设备；bindings 为唯一 symbol 与类型化 source，不提供任意脚本。cost 仍是 CostDefinition，继续使用固定修订的受控公式。
- LocalCostSource 包括 tensor_axis(tensorId,axisId,basis=logical/allocated)、tensor_elements(tensorId,basis)、tensor_copies(tensorId) 和 storage_bytes(storageId,basis=per_copy/all_copies)。前者单位 count，storage_bytes 单位 byte；有效切片与 padding 分开。copies 不自动乘工作量或流量，存储位宽也不自动改变 ComputeClass/峰值。
- 实例化将全局资产参数绑定成 literal，只保留显式 local binding 符号；张量、存储及轴引用转换为规范展开对象。相同 rank 的边界轴按实际绑定位置映射，不能因局部/全局名字恰好相同而映射到错误维度；repeat view 需要可确定的轴。引用、重复 symbol、单位和未知表达式在正式校验/实例化中拒绝。
- ParallelResolution.localCosts 为 DistributedCosts：`version/nodes/logicalModelCompute/deviceSubtotals`，当前局部版本 `0.1.0-local-cost.1`。节点 placement 为 placed（各设备 outcome available/unavailable）、unplaced（参与范围/方程缺项）或 no_work（明确声明零资源元数据叶节点）。单设备缺项不抹掉其他设备的已知成本，硬件能力缺项保留已知 work/traffic；没有已评估节点的设备不伪造零合计。
- logicalModelCompute 是逻辑图一次的数学定义，各卡 useful work 仍属于局部范围，复制执行不能累加为独立模型有效工作量。deviceSubtotals.knownLeafCost 只累计已评估叶节点；seconds 是这些节点的串行工作累计，不包含通信、缺项或未定位节点，不能当作整图调度跨度。绑定数值及来源随每卡结果保存，单节点参数来源仅包括本实例与祖先，不复制兄弟实例参数。
- 节点固定时间/效率/流量覆盖在局部维度绑定后应用；未知实际叶节点、同字段重复及固定时间/效率冲突均拒绝。局部成本原语仍只接受一个明确步骤；多步 decode 由下述序列分析器逐步调用，不生成伪局部常数倍累计。validateLocalCosts 核对绑定与实际布局/存储、节点/设备范围、工作量关系、缺项、精度分类及叶节点合计。
- CommunicationDefinition 可选 placement=`{nodeId,phases,afterNodeIds,beforeNodeIds}`，稳定 ID 不能与展开叶节点/容器/其他有效通信冲突；前后依赖可指叶节点、容器/repeat 范围或其他有效通信。临时缓冲通过 temporaryStorageIds 引用显式存储，未声明不自动分配。无 placement 的旧定义保留独立网络成本，但不被默默追加到执行尾部。非当前 phase 的命名通信不参与求值/依赖。
- execution 使用 available/unavailable 判别，成功建立顺序的结果包含 `version/policy/completeness/orderedNodeIds/dependencies/steps/intervals/makespan/unplacedCommunicationIndices/blockedNodeIds`。当前版本 `0.1.0-serial-barrier.1`，策略 serial_barrier：逻辑节点内各参与设备同时开始，下一节点等待最慢设备；串行阶段总时长不按卡数累加。计算平局保留展开顺序，通信平局按稳定 ID，数据/控制/同步及显式通信依赖优先。通信可来自方案 placement 或模型图原生 collective，均以唯一稳定 ID 执行。
- 通信从唯一源 producer 后插入，目标可满足消费者且原布局无法满足时建立通信到消费者的依赖；显式依赖支持通信链。数据就绪按每设备的有效切片并集检查，重复/重叠切片不冒充完整覆盖，空有效区域允许零元素。本地 view 必须可证明同设备覆盖；partial 不能未经归约变为完整对象，send_recv 也不能提供发送者不存在的区域。当前未提供多写入版本推断和任意共享视图变换，遇到歧义保留阻塞。
- 未定位通信或数据就绪缺项使完整跨度不可用；未知耗时保留已知局部成本和时间前缀，不能生成其后的绝对时刻。可表示性溢出/非零区间被浮点精度吞掉同样停止时间线。每卡 intervals 保留本卡实际结束时刻，step.endSeconds 表示所有参与设备屏障结束。
- memory 按规范物理存储逐设备扫描。weight/state/graph/runtime/reserve 常驻；激活按 producer 到最后 reader，初始输入计入开始状态，图输出保留到阶段结束；workspace/communication 仅在显式使用步骤存活，承载图输出或数据边时维持其生命周期。未引用 scratch 保守常驻。alias 去重，copies 与量化辅助 bytes 已包含在分配中。无绝对时间但顺序可靠时 peakPoint 使用 order；顺序/设备/分配/数据就绪缺项时完整峰值 unavailable。单点容量状态保持 point_only，不声称执行过搜索。
- 布局 worker/界面显示每卡时间线、步骤/依赖、总跨度和峰值分类，输入变化后失效；导出包含全部执行证据。网络流量不隐式增加本地 HBM、归约算术或 staging。analyzeScenario 已根据设备/布局自动选择单卡基线或下述多卡投影；未声明局部方程时返回部分报告，不能将逻辑全局成本当作局部已知成本。
- 多卡 AnalysisResult 增加可选 distributed=`{layout,logicalCompute}`，layout 是完整 ParallelResolution，logicalCompute 为 `{scope,compute}` 数组（LogicalComputeResult）。主报告 scope/节点/模块使用 group_total，对各物理设备的实际工作与流量求和；node.seconds 是最慢参与设备，total.seconds 来自 execution.makespan，不能累加每卡时间。节点范围只包含实际参与设备；模型范围包含整个方案拓扑，空闲设备保留明确的零分配及容量。未知局部结果使完整组成本缺项，但底层 layout 仍保留其他设备证据。
- logicalCompute 单独保存 model_useful 范围下的模型/模块/节点一次数学工作量，从已展开资产原始 cost 计算，不依赖局部分片比例或复制次数。设备组 useful/executed 是物理统计，不能直接用作模型 MFU 的分子。模块仅汇总容器的唯一展开叶节点，方案级通信属于模型层；模块 seconds 是其声明叶节点屏障耗时合计，不冒充包含其他工作/外部通信的整段 wall span。通信没有隐式模块归属。
- 多卡 schedule 直接投影每设备 intervals，memory 复用同一顺序的逐设备峰值。Roofline 由各设备局部成本和实际硬件生成，保留每设备/计算类别，不拼接异构硬件为一条伪曲线。聚合节点的参数来源只含当前实例和祖先，逐设备来源保留局部绑定；方案 assumptions 随成本和执行来源保存。
- validateDistributedResult 在 validateResult 中独立核对布局/输入/版本、完整节点与通信清单、组工作与流量、屏障时间、模块唯一叶节点、模型一次工作量合计、时间线/显存原始证据及 Roofline 范围。嵌入布局也经过 validateParallelResolution；结构合法但加倍模型工作/按卡累加时间/删减每卡区间等投影均拒绝。
- 多卡 compareMeasurement 保留原始物理成本范围 scope，新增 mfuScope 与 mbuScope，分别明确 model_useful 与 group_total。匹配仍要求目标/阶段/输入 hash/实际参与设备完全一致；模型/模块 MFU 使用对应一次有效工作量和这些设备的同类别峰值之和。MBU 使用实际物理 HBM（如明确提供），或对应物理组成本的已知估计；通信 HBM 未建模时不补零。比较前再次检查理论结果语义。
- 容量搜索复用统一 analyzeScenario，每个整数重展开布局、局部方程、通信和生命周期，并同时核对全部物理设备。CapacitySearchPoint 可增加 scope 与 modelUsefulCompute：前者说明 compute/HBM/seconds 的物理成本口径，后者保留独立模型一次工作量，不能混合。仍只证明给定整数区间，不根据采样假定单调。
- 理论分析已迁入独立 Worker，支持取消、输入变化时终止旧任务和隐藏旧结果。界面区分模型一次有效工作、设备组合计有效/执行、最大每卡峰值；测量录入使用选定目标的设备范围。JSON 导出保留完整多卡证据；历史未包含 distributed 的单卡结果仍按原契约解释。
- 每个具体结果指标的 Schema 固定其单位；单位错误在结构校验阶段即可拒绝。语义校验另核对诊断引用、范围、有效/执行工作量、缺项汇总、峰值分解、调度引用与算术强度。
- ProjectDraft 使用 `documentType='project_draft'/schemaVersion/draftId/projectId/baseProjectRevision/draftGeneration/updatedAt/candidate`。正文 candidate 为 JsonValue，不直接计算；项目草稿位于 projects/drafts，历史正式项目位于 projects/revisions，当前正式项目仍是项目目录中的资源文件。
- 恢复导出使用 ProjectRecoveryDocument：`documentType='project_recovery'/schemaVersion/status='draft'/projectId/baseProjectRevision/formalProject/editorText`。editorText 保留非法 JSON 的原文；formalProject 可为 null，非空时必须属于同一 projectId。ProjectImportDocument 明确接受正式项目或恢复文件；恢复到存在的项目时继续使用导出时基线，基线变化产生冲突，不静默覆盖新内容。
- QuantizedStorageSpec 的 `packingUnitElements` 控制 payload 元素补齐，`alignmentBytes` 作用于 payload 字节数，辅助张量按各自 dtype 紧密打包后附加。group 辅助数为 `ceil(elements/groupSize)`；channel 为对应轴长度；block 为所有轴的块数乘积，未声明块长的轴取块长 1；空 payload 不分配 tensor/channel scale。量化存储不改变 ComputeClass。
- quantizationOverrides 现按展开后的 selector 应用于 weight/activation/state 类别的规范物理存储。实际叶节点的明确 nodes 规则优先于容器/子树规则，同优先级冲突拒绝；失败的被覆盖轴/公式不被当作生效规则求值。同一共享/alias 规范存储的所有实际使用必须要求同一格式，不能仅因选中了一个消费者就偷偷改变另一个消费者的格式。需不同格式时必须拆分存储。bytes-only 分配缺少元素/shape，不能按 bit 比例量化。
- QuantizationDefinition 可选 preset AssetRef，必须固定 quantization 修订；复制的 weight/activation/state 数据与该修订相符，selector 可按当前场景改变。自定义编辑格式时需移除 preset 来源。数量公式按实际实例/祖先参数和 workload 求值；channel/block 轴使用规范 storage shape 的轴 ID，缺失时拒绝猜测。group/channel/block 的辅助项随局部分配重算；显式数量公式是已绑定的作者数量，不隐式按卡数缩放。
- 量化作用于展开副本，不写回原始资产或项目快照。ResolvedGraph、ParallelResolution 与 AnalysisResult（可选字段兼容旧单卡结果）保存 quantizationApplications，含规范 storageId/category/nodeIds、assignmentIndices/overriddenIndices、已绑定 shape/dtype、beforeBytes/afterBytes、specification/previousSpecification 及显式 allocationOverrideBytes。全局格式变化不等于每卡总和；StoragePartitionResult 每卡新增 allocatedShape，以支持独立复算 packing/辅助项。
- 数值 memory_bytes 覆盖最后作用于分配，并在量化来源中标明最终字节值；不会又加一份 q 辅助数据。单卡先应用全部分配覆盖，再绑定访问流量，结果不依 numericOverrides 数组顺序。验证器采用独立 BigInt 整数参考，核对全局前后值、实际局部 payload/辅助项/每份合计及覆盖来源；不调用 core 的分配函数。
- MemoryAccess.logicalBytes 新增 storage_allocation(passes)，使用当前单卡或实际设备的完整规范分配乘非负安全整数 count，包含局部 padding/packing/辅助数据/copies；0 passes 是明确零访问，不释放驻留分配。原 byte ValueExpr 保持作者定义；HBM factor/bytes 假设继续单独生效。单卡与局部成本均支持该来源以及分配完成后的 traffic_bytes 比例覆盖。
- ComputeClass、useful/executed 工作量、通信 payload 与量化/反量化开销仍来自显式资产/节点/方程；量化选择器不按位宽猜测算力或自动生成转换节点。W4A4/W4A8 存储与内部 BF16 可同时表达，不能据此宣称 INT4/INT8 kernel 或精度评估已实现。融合聚合成员及显式附加成本各一次，转换作者应选用独立节点或附加成本；目前不推断两份任意方程是否表达同一转换。
- 项目界面支持选择固定快照/库中量化资产、子树/节点列表、添加/移除覆盖与来源表。载入库资产时将传递依赖并入快照；期间文本、项目或选中方案变化则拒绝应用过期结果。库中后续修订不替换项目固定来源，修改原始 preset 数据也不会绕过项目校验。理论分析/布局导出包含全部量化证据，容量候选逐点重新应用格式。
- ResolvedGraph 为 `phase/graph/containers/parameters/assetRefs/objectBindings/quantizationApplications/fusionApplications`。graph 仍使用 GraphTemplate，引用与数值表达式完成绑定，成本只留在有效叶节点；containers 为 `nodeId/name/asset/leafNodeIds`。objectBindings 保留局部张量/存储/状态到规范对象及轴的映射。InstantiationResult 以 available/unavailable 判别，错误不会伪装成空图/零成本。
- 节点路径逐段转义本地 ID，并以 `/` 分隔；repeat 实例追加 `[index]`。根模型容器使用 `$model`，内部 repeat 输出视图使用 `/$outputs:<port>`，用户本地同类字符会转义，不占用这些派生标识。
- OperatorDefinition 内的 StateSpec 若引用该逻辑算子自身端口，使用 `nodeId='$self'`；实例化后替换为实际稳定节点路径。模块内状态继续引用本图稳定节点 ID。状态绑定不引入单步数据边，其 creator/readers/writers 必须对应实际端口和声明的底层存储读写。

- FusionGroup 可选 `extraLocalCost={contextNodeId,rule}`，rule 复用 LocalCostRule。多设备非零附加资源必须显式给出局部方程；单设备且未声明布局/通信时建立精确全量复制布局，沿用全局成员/附加方程一次，不强制用户补写相同局部方程。纯零资源时间开销可作为一个组屏障。
- ResolvedGraph 必含 `fusionApplications`，每项保留绑定后的规则、实际叶成员、`nodeId/extraNodeId/ownerNodeId/eliminatedStorageIds`。数学图不收缩，执行时派生 `$fusion:<groupId转义>` 原子节点；附加事件使用其 `/extra` 路径。成员不得重叠，收缩不得形成环；显式通信的前后依赖映射到组边界，不能在组内隐式插入交换。
- 取消物化按规范 storage 检查，包括 alias、成员成本、额外成本、通信、外部消费者与图接口。weight/state、输出/输入边界、外部使用或缺少内部生产/消费证据时拒绝。取消存储分配保留原规范身份和格式证据，`StoragePartitionResult.materialization='elided'`，物理 payload/auxiliary/total 为零，不把源 StorageSpec 改成假 alias。成员对该存储的读写移除，数学工作不因物理 bytes 减少而缩小；依赖该存储 bytes 推导工作量的规则需先改成逻辑维度方程。
- ParallelResolution 必含 `fusions: FusionEvaluation[]`，可含 `singleDeviceBaseline`。FusionEvaluation 包含 application、participation、逐卡组成本、逐卡附加成本与全局 `logicalExtraCompute`。AnalysisResult 可含 `fusions=[{evaluation,cost}]`；总量用未融合节点与融合组一次聚合，模型有效工作量保留所有数学成员及附加工作各一次。成员保留工作/流量明细，seconds 为 unavailable；只包含组部分成员的模块也不能独立测量时间。
- `sum_members` 对每个原始成员先取参与设备时间最大值，再按原数学顺序累加，最后加附加成本屏障；所有参与卡预留整个组跨度。不能先按卡求和再取最大值，否则交替瓶颈会低估。`override` 的 fixed/custom/roofline 覆盖整个组，roofline 使用每卡聚合后的 executed work 和 HBM；成员/附加 timing 不再叠加。组时间修改使用 timeStrategy，高级 numericOverrides 目前不接受派生融合节点。
- 保留的边界/内部成员缓冲与附加 workspace 保守驻留整个原子组，不暗中复用。SerialExecution 可含 `memoryOrder={nodeId,executionNodeId,startSeconds?}[]`，将组展开为数学成员及附加事件，用于容量/显存来源核对；内部不填写绝对秒数，峰值可用 order 表示。外部时间线只有一个组区间。组内同卡布局必须能证明覆盖所需数据，未解决的跨卡交换或非嵌套视图合并保留不可用。
- `validateFusions` 独立核对成员唯一性、规范取消存储、逐卡资源求和、累计屏障/固定覆盖、附加局部绑定和数学工作量；执行/结果验证器进一步检查组区间、内存顺序、完整模型/模块聚合与测量范围。执行成本 CSV 省略已被组替换的数学成员；JSON 保留全部明细。描述性文本不改变输入 hash，实际成员、物化、方程及时间策略改变 hash。

- GraphTemplate 的 collective body 继续直接包含 CommunicationDefinition，端口固定为 source（输入）与 destination（输出）；portBindings 必须与其端点张量一致。节点可以位于模型或模块内，按当前阶段、重复实例与实际边界张量展开。payload/custom timing/manual local shape 的公式在所在实例求值，存储及分片轴映射到规范展开对象；不把 collective 转换成零成本 opaque。
- 图内通信无需另写 placement；执行 ID 为其展开稳定 NodeId，阶段来自节点。如填写 placement，其本地 nodeId/适用阶段必须匹配本节点，前后依赖引用同图节点并在展开时映射到实际叶集合。数据边、control/synchronization 和额外 placement 共同决定 DAG；依赖展开也消耗预算，环/未知阶段节点不会被忽略。
- ParallelResolution.communications 的图内项有 `origin={kind:'graph',nodeId}`；index 在方案通信数组后按有效图节点顺序分配，只用于证据引用。每个 native 项只进通信成本与执行一次，不再进 localCosts.nodes。图内通信属于其实际容器模块，方案层通信仍只归模型。两种来源的执行 ID 不得冲突；覆盖均指向稳定 nodeId。结果验证器检查来源 ID、唯一性及计算/通信互斥。
- 图内通信依照已声明 source/destination distribution 检查实际数据可读性，partial 是否已归约在展开后的规范张量/设备组上核对；资产局部 ID 只能作为待绑定证据。send_recv 只在实际 sender 读取并在 receiver 产生输出，图输出不要求凭空增加 sender 副本。StateSpec 可明确引用通信的 source/destination 状态端口，但这不声明本地 HBM 次数。
- 单卡且没有手动布局/方案层通信时，含原生通信或融合的图可以建立全量复制基线并沿用全局数学方程一次。通信仍需已有实际拓扑/组与合法源/目标分布；需要 partial 或其他布局语义时须显式提供，不能为得到完整结果而猜测。多卡计算继续要求 LocalCostRule；网络本地 HBM、归约算术、staging/转换成本没有声明时保持缺项。
- 阶段内不同数据版本使用不同 TensorId，可通过同一规范存储显式共享 backing。原生 collective 支持已有 repeat 机制，链式实例按 carry 产生实际版本；任意多写入数据版本推断仍未实现。逐步状态和多流使用下述显式执行模型。结构检查器展示通信定义，布局展示图内来源；可导入 native-gather 参考项目复算与绑定测量。

- AnalysisResult 的单步主体另命名 SingleStepAnalysisResult；序列结果可含 decode={baseScenario,mode,allocationStrategy,logicalCompute,unmeasurableTargetIds,fusedMemberNodeIds,steps}。steps 至少 2 项，每项保存 index/contextBefore/contextAfter/evaluatedContext/scenario、独立单步 result、stateTransitions、含状态预留的 memory 与可选绝对 startSeconds/endSeconds。不把某一步的 distributed/fusions/quantization/Roofline 证据冒充序列证据；逐步查看/导出保留原结果。
- 多步默认 contextBefore=C0+i×query、contextAfter=contextBefore+query，每步重绑参数与公式、布局/量化/融合、通信、成本和显存；固定近似须使用已有 approximation=fixed_context，求值上下文/状态容量冻结在 C0，但实际上下文进度仍记录并显示警告。最多 256 步、累计 100000 个叶事件；超预算或安全整数溢出明确失败，不暗中乘固定成本。
- 每步 DecodeStepContext={index,parentInputHash,carriedStateIds} 进入该步 inputHash；第二步起已有状态以 initialized 来源读取，原 creator 的写入角色保留。状态 ID/规范 backing 必须稳定。static 版本不变且只读，append/windowed/replace 每次声明更新产生新逻辑版本；首步没有初始化而在 creator 完成前读取非空状态则拒绝。空状态可由首步创建。append/windowed 记录 token 范围，window 大小与容量仍由作者的显式表达式规定，policy 不代替分配方程。
- DecodeStateTransition 保留 stateId、前后 policy、beforeVersion/afterVersion、beforeInitialized、可选 token 范围与每规范存储/设备的 beforeBytes/afterBytes/reservedBytes、前后 StorageSpec、copies 和局部 allocatedShape。独立 BigInt 参考复算普通/量化 payload、辅助项和每份×copies；共享 StateId 引用同一 backing 只预留一次。static 分配改变、append 隐式缩小、缺少 writer 或物理类别不是 state 均拒绝。
- allocationStrategy=in_place_reserve_max：每步对每卡状态预留 max(before,after)，将唯一增量加到原步骤的 state 驻留/峰值。权重等常驻对象和整序列显存不跨步求和，序列峰值取各步最大值并保留实际分类/位置。模型/节点/模块成本和网络工作逐步累计；读写流量仍来自作者方程，不因预留增长自动产生复制流量。需要旧/新双缓冲、迁移或转换时须另外明确成本和空间；本策略不模拟隐式重分配。
- 保留既有状态的局部切片必须在下一容量分布中仍可本地读取；增长使既有 token 移卡而未建模跨步通信时返回 decode_state_redistribution。任意请求压缩、动态批次、跨步重叠、隐式重分布和任意阶段内多写入版本推断仍不作为已支持能力。
- 序列的 logicalCompute 保存所有目标跨步累计的模型有效工作量，复制物理成本与 MFU 分子继续分开；同范围 single/mean/sum/span 的一次调用表示整个序列。融合内部/部分模块仍不可独立测量。ScheduleEntry 可带 decodeStepIndex，按已知串行起点偏移各步区间；未知时间后不补绝对秒数。容量搜索每候选运行整个序列，判定最坏设备/步骤。
- validateDecodeResult 独立核对上下文/子方案、版本 carry、策略/分配参考、共享去重/预留、逐步子结果、成本/逻辑工作合计、时间线、峰值分类与来源、诊断和不可测目标。UI 提供步骤选择、状态范围/分配、单步证据导出、时间线/Roofline、显式近似选择；计算在可终止 Worker 中执行。

- 执行字段继续名为 execution，复用 SerialExecution DTO；policy 现在为 serial_barrier/streams。streams 可含 StreamExecutionDetails：资源 policy、展开分配、逐节点/设备 isolated seconds/HBM/可用带宽、事件 slices 的真实进度、serialMakespan、有符号 timeSavedSeconds 与 assumptions。串行结果不允许混入多流进度。多流同时保存 ParallelResolution.serialBaseline={execution,memory}，基线不施加额外资源效率折减。
- 流分配可引用稳定叶/容器或整个融合执行节点；明确叶优先，较深容器优先，同级冲突拒绝。融合所有成员必须整体映射到同一流/实际设备集合；不能只分配部分成员。指定设备组必须匹配节点实际参与设备，组名别名不增加设备。未指定节点使用实际设备上的 $default。资源为零的元数据节点可显式绑定控制流组；它不凭空增加成本。
- 相同物理设备与 streamId 的流内顺序使用基础 DAG 的稳定拓扑次序，extraDependencies 可改变依赖/同步。所有数据边、原生/方案通信前后关系继续保留；不同组重用同卡/流仍序列化。额外推导规范存储的 RAW/WAR/WAW 与 workspace 排他依赖，按数学顺序保存共享身份，不因 alias/共享域而抹去读取，也不推断同 backing 视图天然互不重叠。
- 多设备逻辑节点同时开始，设备区间可先后完成，但后继逻辑节点/同设备流等待该节点全部参与设备完成。ideal 的设备进度速率为 1；user_efficiency 对所有非零设备时间（包括固定/通信时间）统一施加给定进度倍率；不会再次改写硬件峰值或物理工作量。共享 HBM 只针对 compute 事件，以 D=declaredHBM/isolatedSeconds 得到均匀需求，同卡 active 进度为 min(1,peakHBM/sum(D))，在完成边界重新分配；零 HBM 不争用。正流量/零隔离时间、缺少时间/HBM/所需峰值时不能生成完整时间线。
- shared_bandwidth 不推断网络、SM、cache、staging 或未声明的本地归约/转换争用；网络事件沿用其独立网络时间，额外 HBM 应由显式计算节点声明。该假设与所有局部开销进入结果，不能称为真实硬件调度仿真。最多 50000 个设备区间、100000 个事件、500000 项进度证据，依赖展开上限 160000；预算/非零时间数值问题明确诊断。
- 多流总时间为最后完成事件；节点时间是当前资源模型下跨度，模块时间为其完整执行事件最早开始到最晚结束的 span，可能包含等待。部分覆盖融合的模块仍没有独立时间。物理 work/traffic 只求和一次，逻辑 MFU 分子不变，Roofline 预测点使用当前设备区间，硬件 ceiling 不被替换。序列 decode 在每步内部使用多流，调用之间仍串行；容量搜索重算重叠峰值。
- ParallelResolution.temporalMemory 保存规范 initial/output/carried 对象、每个数学/执行事件/设备的 read/write/temporary 使用，以及各物理分配的区间并集。persistent 类别驻留全阶段；激活从产生到最后使用、图输入从 0、输出到阶段结束；不承载数据的 scratch 只在显式使用区间活跃，未引用 scratch 保守常驻。同一规范分配只计一次，缓冲保守持有到逻辑节点屏障，保留融合内部缓冲直到原子组结束。相邻不同 scratch 先释放旧区间再开始新区间，零耗时使用在其瞬时计入峰值。
- validateStreamsExecution 独立重放就绪/完成事件、物理流顺序、隔离成本、共享进度/效率、逐设备区间/组屏障和有符号收益，并复核串行基线；validateTemporalMemory 重新构造使用区间并集与时间扫描，核对规范存储冲突依赖、每卡峰值/分类/位置/容量。未知时间或分配时保留成本缺项，不伪造已知重叠峰值。
- 项目提供执行策略/资源策略、稳定节点/容器与实际组/流分配、跨流同步及移除入口；编辑只改变方案，自动保存并使旧结果/测量失效。SVG 按 device/stream 分泳道，展示串行基线和多流收益、同时展示基线与当前显存，完整 JSON 保留事件和生命周期证据。C05 streams 参考可直接导入复算。

补充字段仍处于首个未发布的契约实施期；后续发布后改变持久化格式必须按 schemaVersion 与显式迁移规则处理。

### 检查点 18 补充：工作负载默认绑定与调用结束分配

- Model definition 可选 `workloadBindings=[{phase,parameterKey,value:ValueExpr}]`，只接受已声明数值参数、当前阶段的 workload 字段和单位一致表达式；同 phase/key 重复拒绝。prefill 的 C 可绑定 pastTokens，decode 绑定 contextTokens。参数优先级为项目 fallback、资产 default、资产 workload binding、显式 scenario binding、scenario/node 数值覆盖；项目 fallback 不覆盖已有值。ResolvedParameter.source 新增 asset_workload_binding（固定 asset/phase）。绑定默认值仍是资产数据，不由 core 根据模型名猜测。模板的绑定语义在展开前验证，不能被绑定后的空参数表掩盖。
- Model definition 可选 `assumptions:string[]` 保存影响执行解释的声明，参与 inputHash，进入单卡/多卡和 decode 的指标来源；名称、来源注释仍按既有非计算元数据处理。单卡叶节点/Roofline 只带自身和祖先参数来源；模块另外带子树来源，模型总计保留完整来源，避免把无关层参数重复到每个叶指标。
- StateSpec 可选 `allocationBasis=context_boundary|step_end`；缺省保持原 context_boundary。前者在逐步序列内按 C 与 C+Q 两个边界求值，reserve=max；后者资产已为本次调用写入预留（例如 cache shape B×(C+Q)×heads×D），after 使用当前分配，不再求一个未来调用或重复增加 Q。子状态绑定须匹配归一化后的分配口径。
- DecodeStateTransition 保留 allocationBasis；step_end 每个存储增加 carriedBytes，首步等于当前预留，后续等于上一调用 afterBytes。当前 beforeBytes 是本调用开始要求的完整容量，可大于 carriedBytes；static 不可改变，append 不可缩小，旧数据局部切片仍须可读。窗口策略按明确公式/范围处理，共享 backing 去重。验证器独立核对 carry、相同 before/after 分配、策略连续性与预留峰值。
- 新内置模型和四个项目按 [模型来源说明](MODEL_REFERENCES.md) 的边界验收；拓扑/矩阵/状态全部来自资产，不在 core 新增 Qwen/DeepSeek 类型分支。人工硬件不是实卡性能结论，absorbed MLA 不是固定 HF 代码的执行承诺。

### 检查点 20 补充：显式传递依赖升级

- 契约层新增 `DependencyUpgradeIntent`（requestId/projectId/expectedProjectRevision/scenarioId/selections）、`DependencyUpgradeProposal`、带 SHA256 planHash 的 `DependencyUpgradePlan`、`ApplyDependencyUpgradeRequest`、`DependencyUpgradeOperation` 和历史/操作请求 DTO。selections 为固定 `from/to:AssetRef`，要求同类型、非空、无重复；同 ID 只能前进。version 为 `dependency-upgrade.1`。仍处首个未发布实施期，资产/项目 schemaVersion 保持 1。
- 纯规划器位于 contracts，不依赖 core/Node。从所选方案模型出发，沿 definition 的固定引用向下遍历，再自下向上替换。来源必须实际可达；被其他选择完全绕过的选择拒绝，防止静默忽略。引用内容冲突、环和规模超限返回定位错误。项目其他方案与旧快照保留。
- 父级是当前用户 head 时创建同 ID 新修订；内置、仅快照存在或 head 已前进时创建确定 ID 的用户副本。快照独有的依赖也先导入为用户副本，不能让新发布库资产引用库中缺失对象。既有目标可重用。没有自动绑定/shape 迁移；UI 在应用前使用通用 core 展开预览，local 只调用 contracts 的结构/语义验证，保持依赖方向。
- `POST /api/v1/dependency-upgrade-preview` 接收 Intent，只读生成计划。`POST /api/v1/dependency-upgrade-apply` 接收原 Intent 加 planHash，服务重新计算并核对项目修订和相关 head/content；不信任客户端上传的完整计划。`GET /api/v1/dependency-upgrades?projectId=…` 返回 operations/issues；`POST /api/v1/dependency-upgrade-resume`、`…-cancel` 接收 `{requestId}`。沿用统一响应、同源检查和错误分类。
- 私有持久回执位于 `data/dependency-upgrades/<SHA256(requestId)>.json`，schemaVersion=1，包含请求指纹和完整 operation/plan。读入验证请求身份、路径、指纹与计划 hash；坏文件/未来版本隔离为诊断，保留原字节。状态为 prepared/complete/cancelled；相同请求只恢复原计划，不能改内容复用 ID。
- 应用先保存 prepared，再按依赖顺序写不可变修订及 head，最后通过既有项目回执发布新项目。预览后过期则拒绝重新预览；恢复时校验不可变内容，不覆盖较新 head。单进程串行化不等于跨文件原子事务：失败可以留下合法已发布前缀，重试或重启后恢复不得多生成版本。
- 未准备项目历史时允许停止，已生成修订保留；项目历史或回执已准备后须继续恢复，避免孤立未来修订阻断下一次提交。项目阶段尚未准备时新草稿阻止切换；已经准备时可完成原发布，保留新草稿原字节。UI 对有新编辑的恢复只刷新操作记录，不替换编辑器；提示导出后合并。异步完成也不能覆盖用户后来打开的项目。
- `reference:upgrade`、8 项升级单元场景、真实 HTTP 集成及 7 项升级/持久化浏览器场景提供 C06 与六处中断证据，详见 [P1 验收](P1_ACCEPTANCE.md)。不扩展到所有项目自动升级、硬件/独立预设重映射或多进程事务。

### 检查点 21 补充：结构配置表与包含树

- 模型/模块结构表直接编辑 AssetDocument 的 parameters/definition.graph，没有新增持久化 DTO 或第二份图。GraphTemplate/ParameterDef 的编辑缓冲从现有 Zod 派生，仅放宽临时空名称/参数键；新建旧式缺 nodes 的草稿可显示空节点列表，第一次表单编辑后写完整候选。正式保存仍使用未放宽的 AssetDocument 与 validateAssets。
- 节点插入/替换使用固定 AssetRef。改名、重排、阶段、repeat、参数/端口/状态绑定保留 nodeId；更换目标不隐式重写旧绑定。删除仅清理 incident 数据/控制边、读写引用和通信 placement 先后依赖，共享对象保留。创建者节点被删除后保留悬空引用并阻止发布，不伪造 initialized。
- validateAssets 增补引用节点的端口完整性/未知映射、父图张量存在、显式参数绑定重复/目标键/类型/单位/范围，以及子/父状态引用。图状态 creator/readers/writers 检查实际接口；$self 通过图边界接口核对。模块和算子都可绑定共享状态。符号值、动态 shape 及需场景默认/覆盖的值仍在实例化阶段求值，不猜测缺少绑定为零。
- 结构树从 ResolvedGraph 的编码稳定路径构建，区分普通 / 子路径和 repeat 的 [index] 容器；最近实际容器作为父级，$model 为根。分支按需挂载，每次显示 30 个直属叶节点。只改变查看方式，不生成额外执行节点、不修改成本算法。数据/控制图和状态关系仍独立展示。
- 模块摘要/公式读取使用固定修订缓存并合并重复请求。异步插入核对候选是否变化；公式读取回调采用当前编辑回调，不能覆盖读取期间的新节点名称等字段。选中节点或资产切换后废弃旧回调。
- 可编辑字段、仍用高级 JSON 的部分、独立 9 s 项目和测试见 [结构编辑说明](STRUCTURE_EDITING.md)。首个未发布 schemaVersion 仍为 1；计算算法未变，引擎保持 0.1.0-execution.10。P2 config 草稿映射尚未完成，本项不代表 P2 整阶段通过。

### 检查点 22 补充：config 草稿、规则快照与公式来源

- AssetDocument 可选 `configMapping:ConfigMappingProfile` 与 `configImport:ConfigImportMetadata`，只用于模型。Profile 声明 modelTypes、JSON Pointer 参数映射/整数偏移/必需性、固定结构条件、忽略字段及原因和模板假设；执行器按数据处理，不在 core 增加品牌数学分支。内置三份根模型发布 r2，原 r1 保留；模块与公式仍固定原修订。索引增加可选 family/configModelTypes，从扫描对象导出。
- `POST /api/v1/decode-config` 接收 DecodeConfigRequest（sourceName/format/text），返回 ConfigSource（归一化原对象）。沿用大小上限、JSON/YAML 解析、同源与统一响应；config 自身的 schemaVersion 是外部字段，不按本应用项目格式解释。根必须是对象，不执行 auto_map/远端代码。
- ConfigImportSeed 在选模板前即可作为 AssetDraft.candidate 持久化，包含稳定 assetId、名称、文件名/格式及完整 rawConfig。选模板后生成新模型候选：固定模板引用、profile 快照、参数 resolutions（value/origin=config|manual）、核对 decisions（key/note）、status=review|confirmed。引用自旧模板的根 provenance 不作为执行依赖；候选图的实际子资产仍须正式存在并进入项目快照。
- 必需映射缺失或不合法时移除模板默认值；不把数字字符串转为数值、不补零。字段可显式改映射，或提供类型/单位/范围一致的手工值。DeepSeek 总层数明确减一得到 Lmoe。直接修改参数造成与记录不符时阻止发布，需显式采用当前值。约束差异、未知字段和量化元数据必须说明未采用/手工修改/模板近似，原值保留。
- config review 未确认、未解决错误/说明、重复/多余映射、来源记录与值不符、缺少披露假设等由 contracts 校验阻止 FileStore 正式发布；不信任 UI 按钮或单一 status 字段。核对后的未自动映射内容进入模型 assumptions。原模板的固定型号数字标为来源说明，当前层数/专家数以新参数表为准；导入 repeat 名称不硬编码旧层数。
- UI 确认前用 B=Q=1、C=0 分别 instantiateModel 检查默认 prefill/decode；实际库依赖通过 snapshot 读取，local 不依赖 core。该检查不代表全部工作负载/并行边界验证。检查期间候选改变或导航后丢弃旧结果。确认仅进入原自动保存链，文件成功后才显示已保存；失败/响应丢失/冲突继续沿 P1 协议处理。
- ResolvedParameter.source 增加 config_import（asset/sourceName/field/origin），场景绑定、工作负载绑定和数值覆盖的优先级保持原规则。原始候选先完整校验；参数已绑定的派生 resolvedRoot 去掉已验证的 config 元数据，避免把不存在的模板参数再次当作未完成导入。来源分支更新引擎至 0.1.0-execution.11，不改变数值成本方程。
- 原始公式面板按编码稳定路径追踪根→模块→算子/opaque 源定义，展示固定公式资产的表达式和单位；不以已求值常数冒充原公式。配置来源和参数覆盖在同一 inspector 展示。参考、范围和执行证据见 [config 说明](CONFIG_IMPORT.md)、[P2 验收](P2_ACCEPTANCE.md)。首个未发布文件格式仍为 schemaVersion=1；发布后的格式变更继续要求版本与显式迁移。

### 检查点 23 补充：作者声明的并行预设

- AssetDocument 增加可选 `parallelPresets:ParallelPresetTemplate[]`，仅允许模型。模板声明 presetId、阶段、replicated/batch_sharded/tensor_sharded 策略、稳定 tensor/axis 分片和 tensor/producer/consumers/payloadBytes/payloadDtype 归约。重复 ID、重复 tensor 规则及复制/DP 夹带 TP 规则由 contracts 拒绝。复杂嵌套图需作者填展开后的稳定 ID，生成器不猜轴映射。
- `ParallelPresetRequest` 接收完整 scenario/assets、presetId、实际 groupId、meshAxisId 和可选明确 network。`ParallelPresetAttempt` 返回 available+Preview 或 unavailable+message；Preview 包含原 sourceInputHash、固定 sourceModel、生成 scenario、执行所需 assets、实际成员、规则/通信计数、每卡权重/state/全部声明分配及 warnings。全部分配不冒充生命周期峰值。
- core `previewParallelPreset` 是纯函数异步接口，先展开固定模型，再生成一个实际一维组的均匀布局。DP 只沿明确 semantic=batch 轴；TP 只沿模板给出的 tensor axis；缺少局部方程拒绝，不能机械除全局成本。1–64 成员预算；多维混合布局由高级 JSON 明确表达，不把重用组的度数相乘。
- 归约在 producer 输出设 partial sum，生成 after producer/before consumers 的稳定 `$reduce:<producer>:<tensor>` AllReduce 节点，目标 replicate；degree=1 保持 replicate 且无归约。payload 保存动态 ValueExpr，ring 流量因子 2(P-1)/P 与启动 2(P-1) 轮由现有通信求值器施加一次。缺少网络、未归约/未定位边界、未分配对象或不可用局部方程拒绝预览。硬件/网络 HBM 等已知缺项保留 warning/unavailable，不伪造零成本。
- ParallelPlan 的 `generatedFrom` 使用 version=parallel-preset.1，保存 presetId/modelId/modelRevision/groupId/meshAxisId。modelId/modelRevision 是历史信息，不是执行 AssetRef；手动替换模型后不能产生旧模型的隐式引用。标记仅描述生成历史，不证明高级 JSON 尚等于模板。当前首个未发布 schemaVersion=1；引擎仍为 0.1.0-execution.11，生成器未改变已有数学计算算法。
- 外层模板元数据不属于数学 definition 的依赖与哈希内容；应用后的计划及实际公式引用进入 calculationInput。模型 revision 和实际资产内容继续受固定快照约束。UI 预览选中模板时为缺少的公式调用现有 snapshot API；应用只合并执行所需依赖，不以模板历史来源增加无关执行依赖。模板以外未来 recipe 的依赖不承诺自动随当前项目全部携带。
- 独立 Worker 执行预览；UI 以 scenario/assetSnapshots/选项指纹及 generation 废弃旧响应，取消依赖读取期间的生成也不会启动晚到 Worker。依赖失败的晚到 catch 同样检查 generation。应用检查同身份内容冲突，更新当前方案并沿原 ProjectAutosaver 保存；其他方案不漂移。
- “成本与覆盖来源”按需挂载，选择模型/模块/节点/融合、每卡局部、逻辑有效汇总、规范存储、通信或生命周期显存，再选择具体指标；逐步 decode 可切换步骤。只展示已有 MetricValue、Provenance 和方案声明，不运行另一套计算。大结果范围列表限制为匹配的前 100 项，可按完整 ID 继续查找，关闭后卸载。
- 面板显示原始数量/单位/basis、结果携带的固定公式及其原始表达式、资产/参数来源、求值假设与诊断。Provenance 可能含范围共用依赖，明确说明不是每个公式都单独贡献于当前指标。numericOverrides 原始目标/字段/值/作者说明与生效结果分开，避免把输入声明重复当作执行成本；固定硬件定义和作者来源也可查看。量化/布局优先级沿已有生效/被覆盖规则表，不另行推断。
- 合成 GQA 资产和独立算术见 [并行说明](PARALLEL_PRESETS.md)。此前自动审批连接故障与浏览器权限拒绝已在用户调整后恢复；最终完整门禁通过 297 项单元/契约、2 项 HTTP、41 项 Chrome、所有独立参考与生产构建。P3 已逐项验收，范围见 [验收记录](P3_ACCEPTANCE.md)，不把中途失败当作仍然阻塞。

### 检查点 24 补充：统一测量文件与明确确认

- MeasurementFile 使用 `documentType=measurements/schemaVersion=1/records:MeasurementRecord[]`，每文件 1–1000 条。DecodeMeasurementsRequest 为 sourceName/format=csv|json/text；`POST /api/v1/decode-measurements` 只解码与校验，不直接写项目。UTF-8 最大 2 MiB，沿既有 4 MiB HTTP body、同源和统一错误规则。contracts 中纯解码器可独立使用，local 不引入 core。
- CSV 是明确的 SI 扁平映射：完整稳定 target/device IDs、秒、byte、正次数；引号、双引号转义、换行/BOM 与行号诊断；禁止未知/重复表头、错列数、条件字段混用、模糊单位和非有限/下溢数。JSON 沿同一 MeasurementRecord 严格结构和共享 measurementProblems；single/count、span 区间、重复 device IDs、归一化溢出同时用于文件、项目和直接比较验证。
- source 可选 `importedFrom` 保存实际导入文件名，原 manual/import/agent、file/eventId/mappingBasis 保留。它不作为路径执行。相同 measurementId 除 importedFrom 外全部内容一致则跳过并保留原记录；其他字段不同为冲突。显式复制生成新 UUID，并记录原 ID。mergeMeasurements 不修改原数组，冲突时不返回部分合并结果。
- MeasurementImportPreviewRequest 包含 file/scenario/assets、可选当前 result 和已有记录；Preview version=measurement-import.1，逐行 ready/needs_confirmation/unmatched/stale/needs_analysis/duplicate/conflict、真实比较结果、canApply 和新增数。没有理论结果可保留记录，缺少 hash 时仅试验范围是否可匹配，禁止返回利用率。事件名称不作启发式映射；已有历史 hash 不改绑。
- `confirmMeasurementBinding` 仅由明确确认动作调用。可使用原目标或用户选择的当前模型/模块/节点/融合目标；只补当前 hash 与明确的映射依据，不替换阶段/设备；原 hash 已存在或比较范围不合法时拒绝。沿已有 compareMeasurement 验证融合独立性、实际参与设备、次数、有效工作、precision 峰值与 estimated/measured HBM。理论算法与引擎保持 0.1.0-execution.11；文件/比较身份新增元数据会改变 measurementHash，不改变纯理论 inputHash。
- Web 文件读取、解码 API、Worker 预览与确认使用上下文指纹、generation 和 mounted guard；取消/切换/后来输入使晚到响应无效。应用前核对快照并沿原 ProjectAutosaver 保存项目，成功以正式回执为准。JSON/CSV 导出保留统计语义，项目超过 1000 条时分批；结果比较按最新记录每页 20 条，可查看全部记录。
- JSON Schema 统一通过 contractJsonSchema 使用 Draft 2020-12 与 Zod `reused=ref`，将重复节点提取为 `$defs`，避免预览请求的内联结构使 Ajv 生成巨型校验函数。没有删除字段/跳过根或分支；结构样例生成器解析 `$ref` 时保留其 sibling 约束，例如 revision 的 minimum=1。根/HTTP/联合全部继续做 Zod/Ajv 正反对照，生成文件不手工修改。
- 格式、操作和独立 C01 数值见 [统一测量说明](MEASUREMENT_IMPORT.md)。P4 的固定来源硬件、方案差异/交叉点与全流程退出条件尚未全部完成；真实 profiler/Trace 适配另按 P6 验收。

### 检查点25补充：硬件来源、编辑与固定选择

- 首批固定来源硬件、PDF页码/列/SHA256、十进制标称容量、dense精度分类和显式代理假设见[硬件说明](HARDWARE_PROFILES.md)。只声明确切ComputeClass，不补未知通信或效率；同精确计算分类、memoryKey、通信scope重复时由语义验证拒绝，peak/effective不能并存形成歧义。
- 硬件表单缓冲允许未填数字，正式AssetDocument仍要求合法值；沿现有草稿、自动保存和修订链处理。修改内置资产创建用户副本，数值修改附用户声明。显示使用明确SI单位，小值不舍入成零。
- 物理设备明确选择库或项目快照的固定AssetRef；只更新当前方案所选deviceId并合并所需快照。依赖读取有session/token和最新文本检查，晚到响应不覆盖后续编辑或其他项目。库修改不影响旧快照。数学算法与引擎仍为0.1.0-execution.11。

### 检查点26补充：多方案结果、差异与整数交叉证据

- ScenarioComparisonRequest 选择2–4个唯一scenarioId，可选复用CapacitySearchRequest。core compareScenarios在首次await前固定所有选中方案及可达依赖快照，复用analyzeScenario/searchCapacity；基础与扫描合计最多512次分析。不同阶段可看基础结果，交叉扫描要求同阶段。
- version=scenario-comparison.1 的报告携带请求、完成状态、固定资产、每方案完整分析/扫描尝试、与基准的归一化计算输入JSON Pointer差异及成对覆盖/交叉事件。名称等编辑元数据不进入差异；自身scenarioId与自身覆盖目标身份归一化，仅比较实际内容。不推断相似资产相同。
- sampledCrossings只依据实际整数点时间：严格相等的相邻采样合并equal_samples，严格快慢反转记录ordering_change的相邻整数区间。缺项断开，不线性插值，不声明连续根、唯一交点或范围外行为。validateScenarioComparison独立验证方案/引擎/hash/请求身份、嵌套分析与容量、完整性、每对共同点和交叉事件；结构Schema与所有联合正反对照继续生成。
- Web Worker报告进度和取消，项目/快照/选项变化终止并失效旧结果，晚到消息需同时匹配实例和指纹。取消可保留完成证据，不将未扫描方案或中断扫描当作完整。比较不写候选参数或额外结果存储。JSON导出完整证据，CSV为原始SI值和有符号差值；不同ComputeClass分列、模型有效与物理执行分开，缺项不补零。
- 现有CostSourceInspector复用于每方案的固定报告/资产；模块按稳定ID对齐、父子不重复累计。界面表格/差异分别限300/200行，导出完整内容。说明和独立人工案例见[方案比较](SCENARIO_COMPARISON.md)。分析算法与引擎保持0.1.0-execution.11。

### 检查点27补充：范围屋顶、整数拐点与P4验收

- RooflineStudyRequest/Result/Attempt使用独立roofline-study.1，目标为MetricTarget，可选decodeStep与既有CapacitySearchRequest。固定输入/可达资产在await前归一化；基础完整AnalysisAttempt保留，每点保存实际hash、选定步骤hash/上下文、观测/诊断与两类屋顶事件。
- searchCapacity新增可选只读onAnalysis观察回调；候选生成、覆盖处理、完整分析和容量验证仍为同一代码。研究基础+候选最多512次。Worker以实例/指纹处理进度/取消和失效，不修改正式方案。
- 节点沿原RooflinePoint；模块/模型从物理成本与完整范围流量/跨度派生点，匹配精确ComputeClass、物理设备去重。硬件原始声明peak/effective/mixed独立保留；局部有效屋顶每卡唯一时才池化，否则unavailable。不同精度不合并，logical代理不冒充完整HBM，池化提示异构/局部/争用假设。多步decode逐步选择，不混合不同上下文的屋顶。
- RooflineBalance使用P/B与operations/P、bytes/B，严格侧相等；溢出/下溢、空工作或缺项不生成有限结论。整数连续平衡段与相邻侧改变区间分开，缺项断开，不推断连续根或区间外性质。validateRooflineStudy独立检查身份/hash、算术、固定硬件池化、诊断引用、样本连续性和事件覆盖；结构根/联合全部继续Zod/Ajv对照。
- executionCostShares从已有SerialExecution派生累计节点成本比例及通信绝对区间并集覆盖。累计分母区别于端到端跨度；网络覆盖不是独占/关键路径/可消除开销。未知范围/时间、零分母或不可表示之和时不出完整百分比，不把通信并入HBM屋顶。
- 原AnalysisResult数值计算和引擎保持0.1.0-execution.11。P4原工作项与V0.1综合界面演示已逐项通过，见[P4验收](P4_ACCEPTANCE.md)。P5/P6不因基础功能通过而扩张支持声明。

### 检查点28补充：Ulysses风格模块研究与实际通信布局

- 使用既有GraphTemplate模块、LocalCostRule、图内collective、三组别名和显式一维mesh，形成SP投影→三次Q/K/V AllToAll→完整序列head分片attention→返回AllToAll→SP输出/残差。已有框架可执行完整子图，本轮不新增绕过核心的族别计算分支。来源提交、SHA256、作者假设与独立算术见[Ulysses研究](ULYSSES_RESEARCH.md)。
- 每个模块声明实际局部轴和物理存储流量；复制权重保持完整。源/目标buffer分开，显式pairwise系数(P−1)/P仅施加一次、启动P−1轮；完整本地payload包含self份额，远端网络流量另列。通信本地HBM未知，不按网络payload补值。度数1无交换，非整除/错误阶段/缺少变换保留失败。
- sequence/heads/exchange可复用同一批物理设备，设备数不乘组大小。人工无mask/past=0子图用正式C=0参数约束与prefill节点范围；完整模型、缓存、训练等其他语义仍需独立资产。
- ParallelView通信详情新增源/目标逐设备逻辑/分配形状、元素和copies，直接读取已有TensorPartitionResult，不重算布局/成本。结果/输入变化仍沿原Worker指纹失效；Schema与原数值算法/引擎0.1.0-execution.11不变。P5整体及P6保持待验收。

### 检查点29补充：逐rank通信与MoE混合研究

- `CommunicationMemberPayload` 定义 deviceId、sendBytes/receiveBytes ValueExpr 和非负 trafficFactor；`CommunicationDefinition.perDevicePayloads` 为可选非空数组。存在时必须完整唯一覆盖集体通信实际成员；send_recv 保持原显式发送/接收设备路径。模块内所有payload表达式沿当前参数帧展开，逐设备记录与原始定义进入结果/输入指纹。
- 逐rank路径覆盖uniform数量/算法系数的实际计算；uniform字段仍须是合法表达式。每rank发送量乘其系数一次，groupSend/Receive求和，bandwidth_latency为最大实际算法流量/带宽+启动轮数×延迟。非统一per-member单值返回unavailable及`nonuniform_member_quantity`，不伪造平均值；明细和可计算总量保持available。fixed/custom_formula时间仍沿作者显式声明，不能据此推断网络争用。
- contracts独立结果校验核对成员、字面量、系数、组总量、共同标量及最大rank时间，core处理单位/公式、溢出/下溢与布局。旧uniform路径不变；新数值语义将引擎升为0.1.0-execution.12。当前未发布schemaVersion=1，字段为向后兼容可选；新增结构根使当前182根/83联合/213分支，非法判别值203。
- 通用界面显示每rank系数、完整send/receive/algorithm traffic，解释单值不统一与最慢rank。MoE的路由固定说明放在作者扩展，通用core不解释扩展或动态执行router；专家驻留和读取、packet元数据、打包/解包独立backing分别由正式图/成本描述。项目、来源锁、独立公式、容量与Chrome证据见[MoE研究](MOE_RESEARCH.md)。P5特殊机制资产/第三案例整体复核及P6仍待完成。

### 检查点30补充：CSA2独立共享对象与第三研究案例

- 固定V4.1 Flash官方推理代码/config提交与SHA，以普通模块/StateSpec/stateBindings/数据边表达四个decoder片段的Full/Reuse/Reindex/Reuse。主KV、indexer K使用独立常驻backing，一个creator/writer按请求append；各层window独立。Top-K及候选掩码是前向局部activation，通过正式边共享并按最后读取释放，不虚构跨调用持久状态或按比例删除全部成本。
- packed理论缓存使用既有QuantizedStorageSpec，payload与row-local scale分开，缩小维度末块按ceil；BF16 cache变体独立标识。所有计算仍使用显式BF16矩阵/FP32代理，norm、rotary、选取和解包读写分别计费。indexer K解包在score叶内声明独立vector段及寄存器内处理假设，未隐式分配额外HBM暂存；gather则有独立BF16 backing。源码demo仍持浮点buffer，研究不声称kernel形状兼容、逐位等价、完整型号性能或有界index score扫描；细节见[CSA2研究](CSA2_REUSE_RESEARCH.md)。
- 三分支重叠与shared_bandwidth沿既有执行/生命周期核心。每层依赖前层residual，未越过真实数据边重叠层。六个持久状态按step_end预留；逐步decode每次重算索引/候选，携带状态版本而不累加所有历史分配。默认shared 62.18s/2242B，ideal49.44s，HBM争用回62.18s；动态候选部分块会使耗时非单调。
- SerialExecutionView支持每批60步展开/收起及输入变化重置，时间线横轴使用全部已知区间的终点，初始截断不改变比例；完整数据继续沿原JSON导出。两份source-pattern模型及八模块/公式/硬件由文件扫描加载；反事实对照保持独立项目。`reference:research`共同复算三案例并保存独立算术/容量，逐项证据见[P5研究清单](P5_RESEARCH_CASES.md)。
- 本轮不改变core数值语义或Schema，引擎保持0.1.0-execution.12、182根/83联合/213分支。三研究证据成立不表示P5其余DSA/KDA/ratio>1压缩预设或P6完成。

### 检查点31补充：完整压缩组与双FP32部分状态

- 采用普通图/公式/StateSpec实现固定来源ratio1/2的压缩与独立window准备，prefill C=0、decode Q=1沿正式参数约束。ratio>1的value/gate权重、投影、pool使用FP32，显式cast后进入BF16 norm；各精度ComputeClass独立汇总。转换只增加执行工作。没有core品牌分支、压缩系数折扣或Schema变更，引擎保持0.1.0-execution.12。
- 主cache只append完整组；未完成组保留两个独立B×R×D FP32缓冲，余数零也不释放容量。logical partial状态包含两个storage，另有主cache append和window windowed状态；step_end版本表示调用快照，空append不意味着新增latent。输出暴露完整capacity buffer，实际完整组和待完成槽数由研究摘要单列，不能当成有效attention token。
- dynamic预留调用后floor((C+Q)/R)行，provisioned预留floor(M/R)行并拒绝超M。浮点demo的最大容量预分配与packed理论变体分开；主行payload/scale、window及FP32物化中间量独立计费。所有缓存迁移、真实allocator或attention/indexer成本均不隐式推断。
- 完成组与未完成组的workspace交替产生真实非单调峰值，沿既有整数穷举搜索。人工4096B下ratio2在[623,652]最大serial646/ideal650；ratio1重叠增加32B激活，在各自扫描区间容量404降至400。独立账本不调用core/生成器/解析器；项目、来源锁、47份内置资产、跨步/容量和Chrome证据见[压缩研究](COMPRESSION_RESEARCH.md)。P5仍需DSA、KDA/递归混合，P6仍未完成。

### 检查点32补充：DSA完整前缀indexer与源码/理论路径

- 固定V3.2 Exp官方model/kernel及两份config的提交与SHA，以普通资产表达单query MLA decode。source-mask保留demo完整前缀latent/PE QK、dense mask、softmax/AV；sparse-gather是独立作者理论路径，显式分配跨head共享的BF16 selected KV/PE并读写staging；dense为无indexer、输出语义不同的反事实。不把Top-K比例自动施加到完整成本。
- indexer仍全前缀FP8 dot，在同叶声明FP32 rectify/weight/head-reduce/key-scale段，内部logits在片上，物化BL份FP32 score。查询量化scale已乘入最终head权重；cache分别保存FP8 key和FP32 scale，不将ue8m0数值取整误当成单byte存储。模型有KV、PE和index三个逻辑append状态，index含两个storage；Top-K为每次重算的int64 activation。
- 普通矩阵/主attention使用明示BF16变体，index weights_proj为FP32，原RMSNorm与LayerNorm affine参数保持FP32，index matrix为E4M3→FP32。核心已有精确ComputeClass可直接分析；缺FP8能力保持相关时间不可用，不借用BF16/其他峰值。动态/预留缓存、显式转换、同卡main/index流及HBM共享沿既有执行/容量路径。
- 默认人工source-mask为53.52s/2568B，sparse为30.96s/2360B，dense33.64s/1776B；indexer完整扫描成本在前两者相同，source/provisioned理论峰值5640B超容量。独立DAG/byte/精度账本及连续HBM服务核对状态和真实重叠峰值。来源、57份新增资产、三步/容量及Chrome证据见[DSA研究](DSA_RESEARCH.md)。core/Schema及引擎0.1.0-execution.12不变；P5仍需KDA/递归混合，P6仍未完成。

### 检查点33补充：KDA混合decode与原子分配模型

- 固定Kimi Linear官方model/config与FLA v0.4.0提交/SHA，用普通模块表达首组三KDA/一MLA attention/input norm/residual片段。KDA含三独立short conv、channel decay、beta、FP32矩阵递归与sigmoid输出gate；MLA按HF源码使用直接Q、NoPE和展开后的K/V cache，不套用其他模型的latent cache或RoPE假设。
- 每KDA两个逻辑状态：conv有三个完整W槽BF16 backing，matrix为FP32 key×value矩阵。三实例不共享权重或状态；MLA单逻辑cache有独立K/V。source矩阵新分配增加一份state-sized temporary，K/V拼接作为一个保守原子叶保留旧/新tuple，workspace不重复收读写流量；Python分次赋值可能更早释放一份旧cache。inplace为单独作者理论变体，不冒充源码。固定storage名称表示逻辑携带，非物理地址。
- 独立矩阵夹具验证先row decay、再delta、outer update、query scale/readout；独立DAG账本核对算术/流量/所有驻留峰值。默认hybrid source98.64s/6012B，inplace86.64s/5480B；全KDA source91.2s/5768B与上下文无关，三步hybrid状态仍含增长MLA。详见[KDA研究](KDA_RESEARCH.md)和48份新增资产；core/Schema及引擎0.1.0-execution.12不变。
- 单卡Timeline补每批60项展开/收起、结果变化重置和全量已知时段横轴，零范围展示真实0；按reduce求最大，避免长序列spread参数上限。Chrome核对60→65→60和98.64s完整轴。原F04的KDA prefill/decode不同公式仍未完成，不能据decode签收P5；P6仍保留。

### 检查点34补充：KDA阶段专用prefill与P5组合核验

- 以独立固定身份补齐C0短prefill Q2..64、chunk Q65..256及dense causal MLA；旧decode不变。批量叶按BQ工作、权重读一次，短递归核矩阵读写一次；卷积采用明确stencil/final-tail访问，旧/新conv tuple保守跨KDA attention保留，不再收一份虚构复制。源模式和作者物化/资源假设独立列明。
- chunk沿固定64边界表达Q/K norm、gate prefix、FP32 intra系数、triangular solve、BF16 WY/inter/output、BF16 chunk history与FP32 final state。系数实际分配Q×64，history ceil(Q/64)，数学有效pairs与64-tile执行工作分开。标量/nonlinear/solve为声明代理，不推断channel/CUDA tile padding、真实kernel吞吐、训练或varlen。
- 一个共享BF16 causal mask连接全部MLA reader；实际执行Q² QK/AV，useful用因果pairs；FP32 probability和BF16 cast为独立存储/节点。独立三角系统数学实现与逐token递归在边界/部分块交叉验证；独立成本账本不调用core/生成器/解析器。71份新增资产及范围见[prefill研究](KDA_PREFILL_RESEARCH.md)。
- 原P5工作项/V0.2/三研究退出条件按[P5验收](P5_ACCEPTANCE.md)逐项核对；新增acceptance:p5将全部既有门禁与七研究共同复算串行执行。core/Schema/引擎0.1.0-execution.12不变。P6型号、更多预设及真实文件适配继续保留，不以P5研究签收替代总目标。

### 检查点35：有限Trace边界与外部转换

- 新增TraceEvent/TraceImport/TraceSelection/TraceMappingTarget/TraceMappingRule/TraceMappingRequest六个严格契约根；独立于持久化MeasurementRecord/MeasurementFile，不扩展MeasurementRecord时间语义。当前188根/83联合/213分支/203非法判别值，原项目/资产schemaVersion=1兼容，理论引擎仍0.1.0-execution.12。
- 原始Chrome JSON允许第三方字段，解码器只读取complete X的name/cat/pid/tid/ts/dur及display-only设备/correlation；未知阶段计数、零时长单列，负/不完整/非有限X拒绝整文件。支持JSON对象或事件数组、gzip、64MiB解压/100000事件，UTF-8 fatal解码；浏览器Worker带取消/代次/输入指纹防迟到应用，不把原始35MB源内容放进项目。
- 时间单位固定微秒；保留原始数值和来源索引，最早正时长X为相对原点。pid/tid以JSON标量表示保留数字/字符串区别。范围为完整包含，不剪裁；筛选/索引选择最多1000条，每事件仍single/count1。累计/首末跨度/重叠分别展示，不自动聚合或反推self/model时间。
- 精确规则、typed轨道/类别限定、候选去重、歧义和逐行覆盖输出未绑定记录。明确物理设备/阶段/区间并确认后，复用原confirmMeasurementBinding检查完整目标、融合/decode、hash和设备；全部准备成功才走项目原合并/自动保存。unmatched/ambiguous保留source与无hash目标，不提供利用率或actualBytes。
- source.mappingBasis包含内容SHA、原始事件索引/时间、源轨道/设备/correlation、筛选/规则及用户确认。显式索引列表不逐记录重复，输出2MiB按记录累计并最终检查，过大须分批。trace-targets.1摘要包含稳定target、物理scope、叶集合和不可独立测量原因；trace-rules.1规则可离线往返。
- convert:chrome-trace按显式scope离线生成统一未绑定文件，输出新路径不覆盖；不执行在线Agent或从测量表推断隐藏模型结构。固定官方真实采集文件、独立计数/SHA/换算、人工映射算术与浏览器闭环分别验证；支持边界见[Trace说明](TRACE_IMPORT.md)。更多真实算子CSV和原P6其余预设保持待完成。
- 回归暴露导航竞态：selectCurrentProject开始递增navigation ticket时，异步硬件/量化/模型/新方案/升级必须立即以该ticket失效，不能只等新项目载入后session改变。统一编辑update同时检查pendingNavigation、workspace session、navigation和实际projectId，拒绝旧子组件回调。导航失败/结束按当前ticket清理pending；openDraft开启新session。autosaver保留独立session守卫，旧项目已有草稿/提交仍可完成，不用提前递增session吞掉回执。硬件E2E通过阻塞新项目read、先释放旧snapshot来确定性验证此顺序。

### 检查点36：多格式Profiler与ROCm CSV整数时钟

- 保留原TraceEvent/TraceImport；新增RocmTraceEvent/RocmTraceImport及按version判别的ProfilerImport，TraceMappingRequest接受此联合。ROCm原始uint64纳秒/原点为字符串，Chrome微秒仍为number；测量外壳schemaVersion=1不变，原Chrome转换样例逐字节不变。当前191根/84联合/215分支/205非法判别值；新版本联合也纳入非法version探针。理论计算引擎仍0.1.0-execution.12。
- rocm-import对选定8必需/21允许列表头校验，源pid/GPU/dispatch去重，zero duration单列，DispatchNs/CompleteNs只保留/核对顺序；原始clock BigInt差后转秒、显式精确相对范围限制。共用筛选的CSV归一化时间须与原始ns一致，累计和重叠保留整数比较；无隐式微秒epoch代理。
- 共享contracts/csv tokenizer保持原统一测量规则，按调用方限制行/列/字段并提前停止。Profiler Worker统一UTF-8/gzip/64MiB边界，明确format选择；源设备/队列可用于筛选或规则，不替代实际物理设备确认。CSV行号、dispatch、原始时钟和源范围写入mappingBasis，其他硬件/counter列不变成HBM测量。
- 新离线convert:rocm-csv与Chrome共用Node文件包装，输出统一未绑定记录、不覆盖已有路径。独立原始CSV账本与生产解析分别复算，真实源数据不与人工利用率fixture混用。支持/降级范围和复现命令见[ROCm CSV](ROCM_CSV_IMPORT.md)；P6其他工作继续保留。

### 检查点44：Ascend完整来源与精确存储量化

- ProjectDocument增加可选quantizationSources，保存原始UTF-8文本、文件名、ascend-description.1、完整SHA256及由摘要确定的sourceId；Scenario的ascendQuantizationImports分别保存未完成draft、待确认mappings、已应用appliedMappings及确认说明。同一工作区配置复用一份原文，未映射／未知字段保留。
- QuantizationDefinition增加可选storageIds（精确canonical范围）和importOrigin；QuantizationApplication记录获胜来源。精确规则优先于节点／子树，同级不兼容格式和共享使用冲突拒绝；每个明确目标必须实际匹配类别／节点范围。FLOAT只保留目标原始浮点位宽／packing／alignment、无辅助；源标签不能推断辅助dtype/count或内部计算精度。
- 确认先核验原文身份、逐字段规格及真实目标，再实例化整张图，全部成功才返回新工作区；生效规则与已确认记录必须完全一致。未确认draft/mappings不收集计算引用、不进入inputHash，允许无效JSON或尚未存在的公式引用作为待编辑内容。已应用规格／来源仍进入计算hash；移除规则同时更新appliedMappings，草稿与原文保留。
- 描述单文件8MiB／100000顶层项，48层／250000节点，工作区原文合计16MiB。专用DecodeProjectRequest为32MiB；project/decode-project/project-drafts HTTP正文64MiB，正式项目读写／扫描32MiB，项目草稿读写／扫描64MiB；普通资产解码与文件限制4MiB不变。正式项目读取及扫描重新验证原文SHA、完整来源与生效映射对应，损坏文件隔离并保留。
- 浏览器以fatal UTF-8读取，保留BOM；文件异步结果同时检查组件存活与工作区／配置／资产指纹，不能覆盖晚到后的编辑或配置切换。列表25条分页，当前Qwen3模板精确字段候选与未知项预览分开，手工辅助布局和明确确认必填。详见[操作与真实文件证明](ASCEND_QUANTIZATION_IMPORT.md)。引擎0.1.0-execution.17，201契约根／86联合／221分支；不扩大为完整源MoE或权重头适配。

### 检查点45：画布配置编辑与独立草稿

- ConfigurationFields为Scenario排除scenarioId/model/Ascend导入审阅记录后的完整配置字段；ConfigurationDraft保存所属scenarioId、固定model、基线字段、固定资产SHA256指纹、候选text和未加入表单inputs。ProjectDocument.configurationDrafts可选，旧输入不自动添加字段；每配置唯一并检查所属身份，未确认内容不收集数学引用，不进入计算inputHash。
- 表单先写候选草稿，完整JSON可未完成；未加入表单内容阻止应用。ConfigurationEditRequest/Attempt提供独立Worker协议；prepareConfigurationEdit核验有效配置／模型／资产与基线一致、严格字段和身份，core applyConfigurationEdit再验证Project与完整analyzeScenario（包括逐步decode），全部成功后才返回替换当前配置并清除本条草稿的新项目。缺少硬件能力可保持指标未知；非法结构／引用／公式不应用。
- 同模型配置复制独立复制草稿，合法候选和基线中的scenario数值目标按新身份映射；未完成JSON逐字保留。较新的有效配置／固定资产不会被陈旧草稿覆盖，UI提供差异、导出及明确重新开始；异步验证同时以组件存活、Worker身份和完整项目指纹守卫，编辑／导航／复制／取消使旧结果失效。
- 画布提供参数、任意物理设备组／mesh、模块／节点／阶段布局、五类手工通信／独立收发／dtype／算法／启动／依赖／临时存储、数值覆盖表单；动态消息、逐rank、manual等复杂字段在同一画布完整配置JSON中编辑。组复用不增卡；所有分片、共享、边界与成本仍沿通用核心。Ascend来源和确认记录保留，不能以删除生效规则孤立已确认记录。操作与独立参考见[画布高级配置](CANVAS_CONFIGURATION_EDITING.md)。
- 新增4根后205Schema根／87联合／223分支；数学引擎保持0.1.0-execution.17，无额外成本折扣或模型品牌分支。三独立标量案例及未完成草稿共8份可移植证据，由reference:configuration重建。

### 检查点46：显示单位与数学单位分离

- 显示偏好仅存于浏览器localStorage（model-analyser:display-units.1），严格接受memory=binary/decimal/byte与time=auto/s/ms/us；损坏／禁止存储回退默认，禁止存储仍支持本次会话切换。storage事件同步同源标签，清除恢复默认。
- web层统一格式器按1024／1000与秒倍率转换，只读MetricValue保留unknown／zero／负差。操作数、B/s／op/s、op/B和原始输入／证据维持其声明单位；极小非零值科学计数，显示倍率溢出明确不可表示。
- 偏好不进入Scenario、ProjectDocument、Worker key/request或任何核心计算。JSON／CSV仍输出原byte／second，图形坐标与排序／容量判定仍用原始数值；来源同时显示转换值与原值。操作和独立证据见[显示单位](DISPLAY_UNITS.md)。契约205根／87联合／223分支和引擎0.1.0-execution.17不变。

### 检查点47：固定来源的逐调用融合预设

- AssetDocument.fusionPresets仅允许模型／模块声明FusionPresetTemplate：预设身份、阶段、说明／假设与局部直接成员／张量、附加成本、时间策略。实际绑定通过ResolvedGraph.containers和objectBindings，不推测跨调用成员或仅按字符串替换存储ID；重复容器外壳没有对象绑定时不提供候选。
- FusionGroup.origin可选，固定来源资产修订／预设ID与实际scopeNodeId；载入仅填候选并高亮画布，添加时重新校验。附加成本与整体时间公式使用该实际调用的参数，参数变化后重新求值；未知范围／阶段／来源／非法物化拒绝。现有复杂extraLocalCost仍可在完整配置编辑，未声明时不推断局部成本。引擎增加此作用域语义后为0.1.0-execution.18。
- assetDependencies统一收集definition、parallelPresets与fusionPresets的固定引用；文件快照、算法来源、结构副本／内容冲突、显式依赖升级和编辑器依赖加载沿此闭包，复制／升级同时重写两类元数据。数学hash与实例化的活动公式跟踪仍只使用实际定义和当前应用组，未应用元数据不改变数学输入；来源资产／实际作用域与生效方程保持可追溯。
- ParallelPresetTemplate.networkDefaults为可选显式scope／bytesPerSecond／latencySeconds／description，UI仅在用户点击时载入可修改字段，预览／应用仍沿既有网络绑定。厂商未知通信项保持缺失。新增206根／87联合／223分支；来源与独立账本见[预设扩充](PRESET_EXPANSION.md)。

检查点47进一步明确calculationInput.assets为完整可复现数据闭包，completeAssetSnapshots纳入两类候选专用引用并验证类型／同修订冲突／64层与10000资产预算；canonicalInput单独保持活动数学资产，不因未应用预设改变hash。分析、容量、并行预览、算法库等可以使用完整资产，避免在原完整工作区中提前过滤必需的元数据依赖。

### 检查点51：实际规格、逐调用参数证据与后台融合

- SingleStepAnalysisResult 增加可选 parameterTrace:ResolvedParameter[]，记录该实际调用的 nodeId／parameterKey／value／unit／source。单卡与多卡保留一次全表；指标仍沿原Provenance.parameterSources关联相关键，不在每个指标重复表。Decode序列各步骤保留自身表，顶层不以某一步冒充全部步骤。旧结果缺表明确重算，禁止从当前默认值或基础画布补填。此为证据元数据，数值算法／inputHash与引擎.18不变，Schema重生成，根／联合／分支206／87／223不变。
- 主画布使用已有ResolvedGraph/objectBindings读取自身模块接口与重复容器的调用方完整边界；逻辑dtype、规范存储位宽／量化与计算精度分别显示。模块计算列表来自真实数学叶节点，公式沿固定引用闭包展示。大列表限制显示，不再次同步实例化。
- 指标卡、模块耗时、成本排序数值与Decode本步耗时可直接选择对应来源。实际参数按作用域和步骤保留，输入覆盖声明与生效记录分开；比较等其余数值入口继续逐项审计，不把部分动作宣称为全部完成。
- 融合候选／预设求值／应用前校验使用可终止Worker，依据当前配置、资产、层级、选择和表单身份拒绝迟到结果；完整选中成员缺失即拒绝候选，不以子集通过。原融合约束／耗时／物化语义不变。详见[画布规格与来源](CANVAS_EVIDENCE.md)。

### 检查点52：画布上下文与手工记录

- web层AnalysisFocus读取稳定NodeId／真实容器／完整生效融合组，传递到成本／Roofline／手工测量。显式上下文身份改变才替换该控件的手动改选；未知目标和部分融合保持缺项，禁止静默回退模型。CostSelection增加可选nodeId／unavailableReason，精确节点结果与模块／全局范围分开，CSV保留实际范围；只改变派生视图，不改变Scenario／ProjectDocument／hash。
- 主画布状态详情依据ResolvedGraph的状态ID、对象绑定、实际端口和规范存储，显示creator／readers／writers／policy／allocationBasis／sharingDomain。不同名称不参与去重，跨调用状态关系不变成单步环。
- 手工表单沿原MeasurementRecord支持single／mean／sum／span、count、显式时间单位／区间、设备和actualBytes。单次count1、多次声明区间，时间换算有限且为正；测量设备必须完全匹配目标实际scope，缺失读写bytes不补零。原始单位／值／调用范围写入manual.source.mappingBasis，实际bytes仅按原有实测HBM口径使用。
- manualFrame选择实际Decode调用的result／scenario／hash；比较按当前序列中匹配该hash的真实步骤路由，旧输入仍拒绝。分析取消／重试不卸载原始手工草稿；保存只发生在用户明确记录后，沿项目自动持久化。现有比较核心公式不改，数学引擎.18、Schema／文件格式与206根／87联合／223分支不变。类型MetricTarget仅增加z.infer导出，不增加运行时契约字段。
- 时间线、其他指标来源及同步重计算路径继续按原文审计，不以本轮三类控件联动替代全部派生交互。具体操作／独立账本见[画布上下文](CANVAS_CONTEXT.md)。

### 检查点54：当前调用的规范存储证据

- 新增可选 `MemoryEvidence`（version=`canonical-memory.1`）。普通SingleStepAnalysisResult通过memoryEvidence保存；分布式／多流放在ParallelResolution.memoryEvidence，各Decode步骤保留自身证据，序列根不伪装为某一步。旧结果缺该字段仍可读取；界面明确重算，不从当前默认值补造证据。
- 每份证据绑定一个实际deviceId，包含canonical allocations、别名、allocationKind／category／sharingDomain、原始byte指标、可选每副本payload／auxiliary／total与copies、生命周期区间、实际数学节点及原子执行单元的访问关系、初始／输出／跨调用存储和声明接口。order轴是原存储事件闭区间，second轴为实际绝对秒数；缺区间和明确空区间分别保留。融合消除的对象明确eliminatedBy与0 B，数学身份不删除。
- 指标来源通过provenancePool及provenanceIndex关联，同一来源不逐分配复制。常规单卡沿用本次求值的共享Provenance，多卡保留各实际分配的来源。契约核对池引用、canonical／alias唯一性、物理设备／节点／边界身份、非负整数字节和区间。每副本payload＋auxiliary=total、total×copies=当前原始分配；分布式还与实际storageAllocations、fusions、temporalMemory核对，不能伪造另一张分配或生命周期表。
- 证据在原serial／distributed／temporal memory路径捕获既有分配及存活结果，不再运行一套显存计算；接口来自固定资产调用边界与objectBindings，repeat外壳按实际调用方绑定。没有访问者的预留不推断私有归属。原memory.peakBytes、状态预留、模块私有预算及设备总量覆盖各保留原口径。
- web的selectedMemoryView投影当前真实调用／画布范围／物理设备：同一设备canonical去重，完整接口／常驻／范围外共享与私有分别说明。Decode读取该步stateTransitions.reservedBytes，显示开始／结束／预留和该步hash；原每副本格式仍标调用开始。匹配行合计不是模块生命周期峰值，不把共享分配按比例分摊。
- `selected-memory.1` 是派生视图导出，保留范围、真实步骤hash、池与存储事件顺序；不改变ProjectDocument／Scenario。公式／参数证据按需展开，目标／设备候选有界、分配40行翻页。详细使用与手算见[所选范围存储](SELECTED_MEMORY.md)。数学引擎仍为0.1.0-execution.18，数值算法和inputHash不变；Schema结构清单为207根／88联合／225分支。

### 检查点55：比较单元格与混合类别的来源身份

- web层comparisonRows保留原表格值／排序／CSV口径；comparisonMetricEvidence在点击时按当前报告的配置索引、完整ComputeClass键、模块ID或物理deviceId定位原MetricValue和目标／指标身份。逻辑模型工作使用实际logicalCompute中的模型条目，物理执行使用total.compute，各自找本数组索引，不假定分类顺序相同。不存在的目标／分类／设备明确缺失。
- 硬件容量沿当前Scenario的Device.hardware到报告固定assets查找原修订，显示结果记录值、声明值、作者来源及一致性；它不被包装成虚构MetricValue。通信group-send以原total.communications中每个真实事件的groupSendBytes相加，逐事件指标保留原basis／来源，任一缺项或合计非有限时整体不可用。
- 差值由本行当前与基准原值相减，保留两侧配置ID／实际输入hash／单位及各自来源；不声称单一因果。Decode根结果仍按原累计成本／最坏步骤显存口径，未选择某一步；聚合未提供单次参数表时说明需到实际步骤查看，不拿当前默认或第三步代替。
- ComparisonSourceSelection只属于web显示状态，绑定报告对象及行／配置／差值身份。重算清理旧选择，输入key或报告对象不同使旧来源不可见。投影按报告缓存，打开／关闭来源和显示单位不改变配置／计算hash；原始JSON按需展开，公式／资产每批12、通信事件每批20。
- 模型概览以实际modelComputeFrame逐类打开useful索引；分类数量是说明文本，不再默认指向第一类。共用Provenance仍如实标明非独立分量依赖，原指标记录不改变。详见[同模型指标与差值来源](METRIC_SOURCES.md)。本轮没有修改core／contracts字段、数值算法或引擎0.1.0-execution.18，Schema保持207／88／225；其他F10标量和精确分量来源粒度继续审计。

### 检查点57：执行工作利用率与测量比较报告

- MeasurementComparison可选executedUtilization带独立版本`executed-utilization.1`、物理MetricScope及逐完整ComputeClass的ratio MetricValue。分子直接取已匹配目标cost.compute中的executedOperations，分母为原记录归一化的每调用秒数乘实际设备唯一匹配peak能力之和。原mfu／mbu及其诊断保持；执行项使用独立指标工厂和诊断，不增加设备副本或使用effective替代缺失峰值。旧比较缺字段明确重比。
- web来源严格定位原inputHash对应真实调用、目标、设备与分类；执行从物理cost.compute取值，有效MFU从logicalCompute取值，不假定两个数组索引相同。导入文件预览也提供执行数值依据，预览不持久化记录。缺项／零／上下溢／超过100%分别保留原语义，执行利用率不声称硬件计数器实测。
- 新公共MeasurementComparisonReport版本`measurement-comparison-report.1`包含固定Scenario／资产快照、分析引擎和根hash、20条页范围、完成状态、每条原记录及可选ComparisonAttempt。构造时检查原记录SHA、实际Decode调用、目标／范围、页身份及顺序。CSV保留原ratio／单位、完整分类／scope、原统计时间与bytes及缺项诊断。取消的部分页可导出，未完成条目保持pending；输入／页／组件变化拒绝旧下载。
- 分析数学、inputHash及原MFU／MBU计算未改变，引擎仍`0.1.0-execution.18`；新增比较字段和报告各自版本化，不把旧结果当新证据。公共Schema结构清单208根／88联合／225分支。五项目离线重读复算、旧冻结比较字段回归及主画布操作详见[执行工作量利用率](EXECUTED_UTILIZATION.md)，完整门禁状态单独记录。

### 检查点58：预算原输入复核与私有成本推导

- fusionSymbols与预算来源共用scopedNumericSymbols：先工作负载，再根参数，最后按实际祖先到具体调用覆盖。`$model`必须显式先于短模块名，不能按字符串长度使根值最后覆盖局部值。该修复作用于模块预算、融合来源作用域及局部附加成本，引擎升为`0.1.0-execution.19`；输入hash仍仅描述输入，算法版本独立标识。原固定历史记录不静默改写。
- evaluateValue与explainValue共享同一受控递归求值。可选记录保留嵌套公式实参、单位、实际if分支、sum局部符号与区间；正常分析不记录该解释树。解释最多256个ValueExpr、1000条实际事件，超出明确标记部分记录但继续完整求值；它不是所有成本表达式的完整依赖链。
- 私有声明Worker先按原Scenario／assets／stepContext核对inputHash并重新分析，核对原参数Trace、实际物理设备、获胜规则ID／表达式和原evaluatedBytes，再生成实参依据。规则或参数不一致、缺失固定修订、冲突内容及缺失实际调用均拒绝，不取当前默认。请求绑定来源对象与Worker实例，新选择立即隐藏旧状态，取消终止任务并忽略排队回复。
- Web成本ViewValue的私有calculation树保留metric、sum、difference、maximum、interval及模块span，复用原数值／MetricValue引用。来源逐层按真实Decode index选调用；CSV缺失步骤hash写null，不回退序列根。比例保留未过滤执行项分母，正值下溢或不可表示不补零，先乘100溢出时改用可表示的等价顺序。单卡真实Decode详情增加该步显存／设备预算，序列汇总仍不使用单次参数。
- 公共AnalysisResult／ProjectDocument及Schema结构208根／88联合／225分支不新增字段。使用、独立七项目账本及完整回归状态见[预算实参与成本构成来源](DECLARATION_COST_SOURCES.md)。一般MetricValue的范围共用Provenance、精确表达式依赖采集、同步结构准备与错误普通项目恢复继续审计。

## 检查点59追加说明：具体叶表达式

[精确叶表达式来源](LEAF_COST_SOURCES.md)按实际字段选择器在后台复核，实例化观察器于literal折叠前捕获指定调用及规范存储的实际符号。原引擎版本、固定hash、完整MetricValue及真实stepContext全部核对后才呈现所选表达式和实际运算。支持范围与未采集变换明确区分，部分页／预算截断不称完整链，原公共AnalysisResult契约和.19数值算法保持。本追加说明不改写或签收原文未复核要求。

## 检查点60追加说明：量化数字作用域

[量化作用域修复](QUANTIZATION_SCOPE.md)让辅助公式与预算／融合共用根在前的数字作用域顺序，使用已绑定的真实调用参数。短节点P3不再被根P2覆盖，单份14B反例、共享冲突、真实Decode与容量候选有独立证明；数学引擎升.20，输入hash和公共结果契约保持。旧19数据独立保留，来源报告跨算法须重新计算。本追加说明不改变原要求或关闭原文最终审计。
