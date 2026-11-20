# P6真实文件样本与格式边界

检查点35先固定少量真实发布文件，再实现解析器；检查点36交付选定ROCm CSV路径。样本、单位与生产格式支持分别核验，不能由某个样本能读出推断全系profiler支持。

| 来源 | 固定文件与证据 | 当前产品状态 |
| --- | --- | --- |
| Kineto官方ResNet50采集 | v0.4.0提交486c083b84a53c60aec0d2c522c1fc5b99ce5284；[来源锁](../references/trace/kineto-source-lock.json)、原始gzip和BSD许可；75,718事件、43,187正时长X | [Chrome JSON/gzip X入口](TRACE_IMPORT.md)已实现，范围、规则、歧义、确认及持久化有真实浏览器证据 |
| ROCm Compute Profiler官方MI200 device-filter workload | 提交4ac6c9c5f4422c2029335e222b7190758dc2368e的[源目录](https://github.com/ROCm/rocprofiler-compute/tree/4ac6c9c5f4422c2029335e222b7190758dc2368e/tests/workloads/device_filter/MI200)，[timestamps.csv](../references/trace/rocm-mi200-timestamps.csv)、[sysinfo.csv](../references/trace/rocm-mi200-sysinfo.csv)、[MIT许可](../references/trace/ROCM_LICENSE.md)和[来源锁](../references/trace/rocm-source-lock.json) | [ROCm timestamps CSV适配](ROCM_CSV_IMPORT.md)已实现，双SHA/字节、整数账本、源GPU/队列规则、确认保存/重开/导出与离线转换已验证 |

ROCm样本保留原始字段和值：三个`vecCopy`dispatch，源GPU_ID=2、queue-id=0；sysinfo记录原始vcopy命令、MI200/gfx90a等环境字段。这是源环境说明，不自动创建当前设备/硬件预设，也不说明任何内置模型已匹配。

算子CSV路径明确限定这份`timestamps.csv`的字段组合。`Start_Timestamp/End_Timestamp`采用纳秒，[官方时间戳说明](https://rocm.docs.amd.com/projects/rocprofiler/en/docs-6.1.0/rocprofv1.html)与Ns字段分别核对。先用整数减法求kernel执行区间，再转秒；不能以DispatchNs→CompleteNs代替kernel耗时，不能把counter行重复计作调用。

三次kernel时长为20,640/15,520/16,480 ns，累计52,640 ns，首末跨度133,760 ns；`npm run reference:file-samples`核对签入源文件SHA和精确整数差，生成[原始账本](../examples/trace/rocm-source-summary.json)。这个命令仍是独立固定样本核验；生产CSV解析器由`reference:rocm`单独与其对照。产品复用已有范围/映射/确认路径，拒绝未知表头、重复dispatch身份、负/不完整时间；未经确认不绑定设备/输入，不从LDS/寄存器/计数器推断HBM测量。

另查看了Ascend/msprof-analyze官方kernel_details测试表，其字段含大数带小数微秒、制表符和CSV引号。测试表与实际采集来源不能混称；暂不纳入已支持格式。若后续支持，须以保留十进制原文/精确相对差的方式处理epoch小数，不能先强制转IEEE Number再声称无精度丢失。

这些文件只证明具体采集/发布文件的格式和算术。Prefill/decode阶段、一次完整模型/模块调用和当前实际设备范围必须由用户核对；缺失时不伪造测量指标。更大文件、B/E/async、专有二进制及其他算子CSV均继续走明确的统一表格/外部转换范围。
