# 有限Chrome Trace导入与外部映射

检查点35实现P6的第一条真实文件路径。支持Chrome complete `X`事件，不把“可读取JSON”视为所有profiler已适配；[样本清单](PROFILER_SAMPLES.md)另固定ROCm真实CSV，检查点36已实现选定[ROCm CSV](ROCM_CSV_IMPORT.md)；更多型号/预设和PCP/DCP/PP等具名快捷入口仍待完成。

## 固定真实样本

采用[Kineto官方ResNet50样本](https://github.com/pytorch/kineto/tree/486c083b84a53c60aec0d2c522c1fc5b99ce5284/tb_plugin/samples/resnet50_num_workers_0)，固定v0.4.0提交`486c083b84a53c60aec0d2c522c1fc5b99ce5284`。未修改的[gzip采集文件](../references/trace/kineto-resnet50.trace.json.gz)为1,159,569 B，解压35,154,637 B；[来源锁](../references/trace/kineto-source-lock.json)保存两个SHA256，[BSD许可](../references/trace/KINETO_LICENSE)随文件保留。运行时和验收不依赖联网。

该文件有75,718个原始事件，44,666个complete X，其中1,479个零时长；正时长43,187个，包含8,136个Kernel。忽略的`i/f/s/M`分别为12,840/9,096/9,096/20。原始第36,495号事件是2 µs的computeOffsetsKernel，保留原始索引、`ts=1623142623531625`、pid、tid、源设备和correlation。原始Kernel共有8,772个，其中636个零时长，不把它们混入正时长测量。

**这是ResNet50采集文件，不能当作内置LLM或C01的实测。**真实样本只验证读取、筛选、来源、待映射保存和导出；映射/20.48%利用率的浏览器案例另用明确的人工5 s事件与C01，不冒充真实硬件结果。

## 界面路径

1. 打开项目/方案，在“理论分析与测量比较”展开“Profiler事件导入与映射（Chrome Trace / ROCm CSV）”，格式选择Chrome。选择`.json`或`.json.gz`。浏览器Worker解压/解析，可取消；原文件及解压后均最多64 MiB、最多100,000原始事件。
2. 查看原始、可选、零时长及忽略阶段计数和文件内容SHA256。仅接受事件数组，或含`traceEvents`数组的对象。`X`的`ts/dur`固定是微秒；`displayTimeUnit`仅是源文件显示偏好，不能据此把dur当纳秒。原点取正时长X的最早ts，列表显示相对秒。
3. 用相对起止秒、类别、pid/tid、名称包含筛选；每页50条，也可“仅选择本页事件”。只保留完整落入区间的事件，不截断跨边界事件来伪造测量。每批1–1000条；超出时须缩小范围/分批，不静默取前1000条。
4. 先计算理论结果以取得稳定目标。规则按**精确名称**匹配，可限定类别；导入规则JSON还可限定pid/tid。同一事件命中多个不同目标会保留“歧义”；重复规则指向相同目标不会人为制造歧义。逐行明确目标可以覆盖规则。未匹配/歧义均保留原事件，不能生成MFU/MBU。
5. 明确勾选当前方案的物理设备并填写区间/调用说明。源pid、`args.device`、CPU Device字段或stream ID仅作来源，绝不自动当成当前gpu0或设备组。阶段来自当前方案，需用户核对，不能从事件名猜测。
6. “预览Trace映射”展示逐项状态、候选、事件累计时长、首末跨度和重叠提示。逐事件仅生成`single/count=1`；即使无重叠，也不把这批事件自动写成模型端到端测量。嵌套CPU算子的inclusive时间、Runtime、GPU kernel可能重复覆盖，不能相加冒充self time或模型时间。
7. 核对每个映射事件是否代表目标的一次**完整调用**，确认阶段/物理设备/区间，勾选确认后“确认映射并加入项目”。已匹配项再经既有`confirmMeasurementBinding`校验目标、融合边界、decode范围、设备和当前hash，整批准备成功才提交；任何失败不部分加入。未匹配/歧义仍无hash。实际成功以项目“已保存·修订”状态为准。

修改筛选、规则、逐行选择、设备或区间会使确认失效；理论输入/结果变化会清掉预览、确认与物理设备选择。迟到读取、取消的Worker或旧输入绑定不能应用到新输入。已解析源文件可保留，重新核对范围后才能再应用。

项目导航开始时，工作台的导航ticket/pending守卫也会拒绝旧编辑回调，不等待新项目数据读取完成才失效；旧项目已发起的自动保存仍保留其自己的回执/草稿守卫。此项由硬件快照竞态回归确定性核对，适用于统一项目更新边界。

## 规则与摘要

界面可导出/导入`trace-rules.1`规则JSON；最多1000条、1 MiB，拒绝未知字段、版本和重复规则ID。没有正则、脚本或模糊语义匹配。

```json
{"version":"trace-rules.1","rules":[
  {"ruleId":"gemm-1","name":"my_complete_gemm","category":"Kernel",
   "target":{"kind":"node","nodeId":"module/op"}}
]}
```

“导出模型与节点映射摘要”生成`trace-targets.1`，包含scenarioId、inputHash、阶段、model/module/node/融合组稳定ID、实际物理设备范围、叶节点集合以及不可独立测量原因。融合内部、跨融合边界的模块及decode无独立区间目标明确不可选。[C01摘要样例](../examples/trace/c01-mapping-targets.json)用于解释格式，不代表真实采集与该模型匹配。外部Agent/脚本可读取摘要，生成规则或[统一测量表](MEASUREMENT_IMPORT.md)，产品不连接在线Agent。

## 离线转换

```powershell
npm run reference:trace
npm run convert:chrome-trace -- references/trace/kineto-resnet50.trace.json.gz examples/trace/explicit-scope.json converted-trace.json
```

转换器要求显式范围文件，输出路径须是新文件；不覆盖已有文件。它只输出未绑定当前inputHash的统一记录，不能在命令行自动确认或生成利用率。导入工作台后仍须核对确认。范围文件字段与`TraceMappingRequest`一致，但没有`trace`字段：

```json
{
  "selection":{"eventIndices":[36495]},
  "rules":[],"overrides":[],
  "scenarioId":"example:external-capture-review",
  "phase":"decode","deviceIds":["gpu0"],
  "interval":"EXAMPLE ONLY: replace phase/device/interval after inspecting your capture"
}
```

**样例的phase/device是作者填写的演示占位值，采集文件并未证明它们；实际使用必须替换核对。**无法确定阶段/设备/完整调用边界时保留原文件，不伪造可比较记录。[转换样例](../examples/trace/resnet50-unmapped.json)只保存原事件，无inputHash、无actualBytes、无利用率。外部转换无法确定目标时使用`unmapped`，不能由总时间反推子模块实测。

测量ID由内容SHA256、原始事件索引和scenarioId组成，同事件重导可识别重复。改映射/范围但保留同ID会触发已有合并冲突，不覆盖历史测量；确需另一份解释时可先输出统一文件，再使用统一导入界面的“为此记录创建新ID”。原始事件信息与规则依据保存在`source.mappingBasis`，上传文件名/原始索引保留在file/eventId。`args.bytes`、显存分配、tensor尺寸或读写计数不自动成为HBM测量bytes。

## 验证与边界

每条记录保存自己的原始索引和筛选依据，显式索引选择只标注`explicitIndices`，不在1000条记录中重复整批索引列表。转换/预览同时限制可导出的统一JSON为2 MiB，逐记录累计检查，超出则提示缩小范围。普通1000事件批次已核对可由统一入口往返；很长的名称、区间说明或规则依据仍可能要求更小批次。

专项单元核对完整源文件双SHA、计数、单位、typed pid/tid区分、范围完整包含、规则/歧义/覆盖、重叠合计、文件/事件/批次边界、统一格式往返及确认前后指标。三项Chrome覆盖真实gzip离线读取/未匹配持久化/导出、人工映射与歧义/利用率、规则往返和输入变化失效。[独立复算摘要](../examples/trace/reference-summary.json)与[预览截图](images/trace-mapping-preview.png)可检查。

最终完整`acceptance:p5`退出0：399单元/契约、3HTTP、79Chrome（10.1分钟）、架构/严格编译、Schema/正反例、既有独立参考、生产构建及七套研究复算通过；随后`reference:trace`和`reference:file-samples`共同核验两种真实发布样本。过程中修复了Chrome随机禁用端口及既有硬件/项目导航竞态，保留原业务断言；确定性导航、取消Worker、空类别筛选和失败整批不部分应用也已纳入最终浏览器门禁。记录见[检查点35](PROGRESS.md)。

当前不重建B/E、async/flow、采样、调用栈或CPU→GPU correlation归属；不读取Perfetto protobuf、NVTX二进制、Nsight报告或Ascend专有格式；不计算self time、不自动聚合调用、不自动推断模型范围，也不从sourceDevice推断硬件型号。未知格式继续走统一CSV/JSON或外部转换；检查点36已单独交付选定[ROCm CSV](ROCM_CSV_IMPORT.md)的具体字段/纳秒边界，其他CSV/统计表仍不自动识别。P6不因这一条路径成立而整体完成。
