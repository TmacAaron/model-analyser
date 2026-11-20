# ROCm timestamps CSV：核对范围后导入

检查点36实现P6的选定算子CSV路径，复用[Profiler映射界面](TRACE_IMPORT.md)、统一测量记录、确认输入与项目自动保存。它针对固定真实样本的字段组合，不表示所有ROCm CSV、统计表、counter导出或二进制报告已适配。P6更多型号/预设和[原PRD剩余功能](REMAINING_PRD.md)继续保留。

## 真实文件与独立时间账本

来源为ROCm Compute Profiler官方提交`4ac6c9c5f4422c2029335e222b7190758dc2368e`的[MI200 device-filter工作负载](https://github.com/ROCm/rocprofiler-compute/tree/4ac6c9c5f4422c2029335e222b7190758dc2368e/tests/workloads/device_filter/MI200)。签入未修改的[timestamps.csv](../references/trace/rocm-mi200-timestamps.csv)、[sysinfo.csv](../references/trace/rocm-mi200-sysinfo.csv)、[来源锁](../references/trace/rocm-source-lock.json)及[MIT许可](../references/trace/ROCM_LICENSE.md)，源文件字节/SHA与检查点35一致。

三行kernel执行时长为20,640/15,520/16,480 ns，累计52,640 ns，首末跨度133,760 ns；对应秒为0.00002064/0.00001552/0.00001648。第一行`Start_Timestamp=1412702536508356`、`End_Timestamp=1412702536528996`，源GPU_ID=2、queue-id=0、pid/tid=4159385。**这些vecCopy数据不是内置LLM或C01的实测。**实际样本只验证来源、时间转换、筛选、未匹配保存和导出；C01的20.48%利用率用另一个明确人工5 s fixture验证。

`reference:file-samples`按原始文件末列做独立BigInt差分账本；生产解析器另由`reference:rocm`对照，不用解析器输出证明自身。sysinfo只作为源环境说明，不自动安装MI200硬件预设，也不自动把源GPU2改成当前gpu0。时间戳单位依据[官方纳秒说明](https://rocm.docs.amd.com/projects/rocprofiler/en/docs-6.1.0/rocprofv1.html)与原始Ns字段核对。

## 界面操作

1. 在项目“理论分析与测量比较”展开“Profiler事件导入与映射（Chrome Trace / ROCm CSV）”，文件格式选择“ROCm timestamps CSV / gzip · ns”，再选择`.csv`或`.csv.gz`。格式由用户选择，不按数值大小猜单位。Chrome路径保留原微秒含义。
2. 查看原始/正时长/零时长计数、SHA、纳秒原点及未用于时间/指标的列。列表显示相对秒、原始行索引、CSV物理行号、源设备/队列/dispatch。可按完整包含的起止区间、类别、pid/tid、源设备、源队列和名称筛选；每页50条，也可只选择本页。
3. 添加精确名称规则，可明确限定源设备与队列；JSON规则还可限定pid/tid。多个不同候选保留歧义，逐行手选可覆盖。源设备和队列筛选**不会勾选物理设备**，也不会绑定输入hash。
4. 明确选择当前方案的物理设备，填写完整调用/区间说明，预览映射，核对每事件是否代表所选目标的一次完整调用、当前prefill/decode阶段和实际物理范围，再勾选确认并加入项目。复用已有hash、融合/decode和设备校验；整批准备成功才合并，不部分写入。
5. 未匹配/歧义保留来源和无hash记录，不能产生利用率。刷新重开后仍保留原始纳秒字符串/dispatch身份，可用统一CSV/JSON分批导出。格式/范围/规则/输入变化使旧预览和确认失效；取消的Worker不能把旧CSV带到后来选择的Chrome文件。

真实样本[预览截图](images/rocm-real-preview.png)与人工确认[映射截图](images/rocm-mapping-preview.png)已经检查。界面持续显示事件累计和首末跨度，不把重叠累计当作模型端到端时间；每条记录仍为`single/count=1`，不自动生成聚合/子模块实测。

## 表头与严格边界

CSV为UTF-8，可有BOM，逗号分隔；支持CRLF/LF、引号内逗号/换行和双写引号，报错带物理行号。表头区分大小写，可重排，不做别名猜测。未知/重复/缺失列、错列数、坏引号、任一不完整数据行拒绝整文件。

| 字段 | 作用与约束 |
| --- | --- |
| Dispatch_ID、GPU_ID、queue-id、pid、tid | 必需，规范无符号十进制uint64文本。保留字符串，不提前转Number。dispatch身份按(pid,GPU_ID,Dispatch_ID)去重；换queue也不能把同一dispatch重复计调用 |
| Kernel_Name | 必需、非空、保留原文。作为事件名，不按显示名称自动认定模型节点 |
| Start_Timestamp、End_Timestamp | 必需，uint64整数纳秒；end≥start。正时长才生成可选事件，零时长单列；负区间拒绝 |
| DispatchNs、CompleteNs | 可选；列存在时必须有有效整数，要求dispatch≤start≤end≤complete。只保留原文/核对顺序，不用于kernel执行时长 |
| queue-index、Grid_Size、Workgroup_Size、LDS_Per_Workgroup、Scratch_Per_Workitem、Arch_VGPR、Accum_VGPR、SGPR、wave_size、sig、obj | 允许的辅助列，界面列出未用于时间/指标；不从它们推断HBM bytes、调用次数或当前设备配置 |

必须提供8列：Dispatch_ID、Kernel_Name、GPU_ID、queue-id、pid、tid、Start_Timestamp、End_Timestamp。允许表头最多21列。原文件及解压后最多64 MiB、100,000数据行；单CSV字段最多1 MiB；每次选择1–1000正时长事件，同时保证输出统一JSON不超过2 MiB，过大须分批。共享CSV tokenizer在超出行/列/字段界限时提前停止；原统一测量CSV仍保持自己的23列表头和2 MiB/1000条限制。

纳秒原文范围0..2^64−1，不接受前导零（0本身除外）、符号、小数、指数、空值、单位后缀或尾部制表符。先以BigInt做原始差、相对原点、累计/跨度和重叠比较，再转换为双精度秒；相对起点/结束、单次时长和所选累计/跨度限定在2^53−1 ns以内，超出明确拒绝。原始整数字符串保留，秒作为数值显示/比较，不声称十进制逐位精确。

来源中的文件SHA、行/dispatch身份、原始start/end/dispatch/complete、纳秒原点、规则及手工确认依据写入`source.mappingBasis`。新格式标为`rocm-timestamps.1`，与`chrome-trace.1`的原始微秒字段分开；不制造微秒epoch近似值来套用旧时钟。原Chrome转换样例已核对逐字节不变。

## 离线转换与复算

```powershell
npm run reference:rocm
npm run convert:rocm-csv -- references/trace/rocm-mi200-timestamps.csv examples/trace/rocm-explicit-scope.json converted-rocm.json
npm run acceptance:files
```

转换器与Chrome共用文件/解压/scope校验/新路径不覆盖逻辑。`rocm-explicit-scope.json`、[统一未匹配样例](../examples/trace/rocm-unmapped.json)和[生产/独立对照摘要](../examples/trace/rocm-reference.json)可复核。**样例phase/device是作者明确填写的演示占位，真实使用必须核对替换。**CLI输出不带当前inputHash，不自动确认，不生成MFU/MBU。已有输出路径拒绝覆盖，未知文件可以由外部工具转换为[统一测量格式](MEASUREMENT_IMPORT.md)。

`acceptance:files`组合完整P5/P0–P4门禁、七研究、Chrome真实Trace和ROCm CSV两条复算路径；它是有限文件能力的回归命令，不替代P6/V0.3全部退出条件。

## 已验证范围

8项新单元覆盖真实源SHA/计数、uint64 epoch中1 ns差值、引号/行号、严格字段/单位、重复dispatch、零时长、GPU/队列筛选、歧义/覆盖、1000条往返、伪造归一化时钟、明确确认及错误物理范围。3项新Chrome覆盖真实CSV未匹配保存/重开/导出、人工大epoch同名多GPU/队列映射/利用率、取消与格式/输入变化/非法文件不写入；原3项Chrome路径和统一CSV单元共同复验通过。完整组合门禁结果记于[检查点36](PROGRESS.md)。

最终`acceptance:files`退出0：407单元/契约、3HTTP、82Chrome（10.3分钟）、架构/严格编译、191根Schema/结构正反、生产构建、全部既有独立参考、七研究及两条真实文件复算通过。CLI的plain/gzip、已有输出保护和旧Chrome逐字节兼容另有专项证据。P6其余型号/预设及原PRD剩余功能继续进行。

目前不读取ROCm汇总/统计CSV、counter逐项行、rocpd/SQLite、Nsight、Ascend专有格式，不自动合并多个进程/文件/时钟域，不从counter/LDS/寄存器/分配量生成测量HBM。未知文件必须沿明确的统一记录或外部转换路径保留未知项。
