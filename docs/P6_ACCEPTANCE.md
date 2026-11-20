# P6 预设扩充与文件适配验收

检查点47（2026-11-15）按原P6六项工作验收通过。最终完整`acceptance:presets`退出0：536单元／契约、4HTTP、127Chrome与全部组合参考通过。签收范围是下表列明的具体型号、可编辑候选和选定文件适配。原PRD与用户画布修订的全项目逐条验收另行保留，YAML存储格式选择及软件运行规模基线仍待补齐，不能由P6阶段签收替代。

| 原实施工作项 | 当前实际范围与权威证据 |
| --- | --- |
| 按明确型号／变体扩充Qwen、DeepSeek、GLM并复用模块／公式 | [具体型号目录](EXPANDED_MODEL_PRESETS.md)、[原模型来源](MODEL_REFERENCES.md)：Qwen3-0.6B／1.7B，DeepSeek-V2-Lite expanded／absorbed MLA，GLM-4-9B BASE 8K；固定来源与快照、独立参数／工作／存储账本、空库复算。新画布按Qwen／DeepSeek／GLM组织；新增Qwen融合研究变体固定decoder r2，不改变原模型r1引用 |
| 补充硬件、通信、融合与量化的可编辑预设和来源 | [预设扩充](PRESET_EXPANSION.md)、[来源锁](../references/presets/source-lock.json)和[七份独立参考](../examples/preset-expansion/reference.json)：MI300X明确OAM型号、人工两级链路、两卡动态AllGather、W4／W8 group32、实际模块调用的两种SwiGLU物化候选。表单／完整定义编辑、用户副本、明确应用、固定快照与独立配置验证；未知能力不填零、不把理论假设作为实测 |
| 先选择真实样本，再限定Chrome Trace／算子CSV字段与规模 | [样本清单](PROFILER_SAMPLES.md)：固定Kineto提交的ResNet50 gzip与ROCm Compute Profiler MI200 timestamps.csv／sysinfo.csv，原始SHA与许可保留。支持具体X事件、JSON／gzip和列明的ROCm字段；不是全格式／全系profiler适配 |
| 事件导入、范围、规则、未匹配／歧义与确认 | [Trace操作](TRACE_IMPORT.md)、[ROCm适配](ROCM_CSV_IMPORT.md)，以及`trace-import`／`rocm-import`领域和Chrome测试：原始事件索引、源设备／队列、精确整数时间、范围不截断时长、歧义与人工目标、绑定当前输入前确认、保存／重开／取消迟到。未知事件保留；不从总时间反推子模块实测 |
| 统一转换格式、说明与外部脚本样例 | [测量格式](MEASUREMENT_IMPORT.md)与[文件样本说明](PROFILER_SAMPLES.md)，`examples/measurements`、`examples/trace`，离线`convert:chrome-trace`／`convert:rocm-csv`。CSV／JSON执行同一严格结构与范围校验；原始统计次数／区间／bytes保留。未知文件可由外部工具转换为统一记录，未经确认不制造测量 |
| 导出模型／节点摘要供外部映射，不做在线Agent编排 | Trace侧栏“导出模型与节点映射摘要”、`exportTraceTargets`与对应Trace领域／浏览器测试；包含稳定目标、阶段与设备范围。离线转换默认保留未匹配，不建立采集服务或在线Agent控制链 |

## 新增预设的独立退出证据

十二项新增领域用例全部通过；相关既有领域一并纳入最终全单元复核。验证包括不满group32的辅助数据取整、显式HBM公式不随存储位宽猜测、真实两卡及动态payload、固定decoder r1／r2、全部计算分类工作保留、局部参数时间公式重算、未应用元数据不进入数学指纹、非法范围／物化拒绝，以及元数据专用公式的快照／升级／冲突副本。

五个新增画布Chrome用例覆盖家族与厂商硬件副本、W4／W8配置独立、模型选择器直接创建通信工作区／设备组／链路覆盖，以及Qwen实际模块融合／定位／复制／重开、根模型整模块候选从其他算子选择载入后的高亮／摘要／保存与实际叶子工作。普通通信入口从默认prefill显式切换为模板支持的decode；不能用导入完整研究文件替代专用公式闭包与普通创建路径。初轮测试等待／按钮／默认阶段和选择器错误保留在检查点日志中，修正后再跑完整组合。

补充边界用例曾复现：尚未应用的候选专用公式被数学资产筛选提前剔除，导致原本完整的分析输入缺引用。修正为可复现快照闭包与数学canonical输入分开，相关63项通过后重新执行完整门禁；中途旧门禁没有作为最终退出证据。

当前内置589个head／593份JSON，新增12份不可变修订文件，其中decoder r2是既有ID的新修订。旧引用、原图方程、真实源样本和原用户工作区保留；新增公式依赖纳入快照及升级，实际数学输入只收集已经使用的内容。当前206契约根／87联合／223分支；引擎0.1.0-execution.18增加融合预设实际调用作用域求值。

最终完整组合日志为checkpoint47-final-acceptance.log：536单元／契约（58文件）、4HTTP、127Chrome（19.6分钟）、架构／严格编译、206根Schema及全部联合结构正反、生产构建、全部既有型号／并行／成本／七研究／Chrome与ROCm真实文件参考通过。另五项局部成本／串行／融合／原生通信／decode参考退出0。新增五用例与原八画布的13Chrome专项也通过。最终两张截图已检查；4310最新构建由原生内置浏览器核对，原Qwen修订1保留，扫描无问题。

最终组合结果、原生浏览器核对与剩余项见[实施记录](PROGRESS.md)、[阶段状态](ACCEPTANCE_STATUS.md)及[原PRD剩余项](REMAINING_PRD.md)。本阶段范围与原实施计划一致：具体型号、有限样本、来源／假设明确且可扩展；未知格式与新模型不能被视为自动适配完成。
