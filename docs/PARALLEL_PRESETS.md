# 并行预设与 GQA 独立参考

检查点39补充：[SP2、EP2、EP2×TP2具名快捷预设](NAMED_PARALLEL_PRESETS.md)已接入同一预览/应用入口，使用声明式角色组和原生通信绑定。下文保留GQA的具体范围与手算；检查点40又增加[PCP2/DCP2/PP2](CONTEXT_PIPELINE_PRESETS.md)，实际因果查询片、KV槽位/归约及阶段传输均有独立证据。

检查点 23（2026-11-14）。核心、独立参考、预设/来源交互及最终完整回归已验证，P3 按原工作项验收通过，见 [P3 验收记录](P3_ACCEPTANCE.md)。

## 模型画布

画布的「并行方式」按 Attention、MoE、序列与流水线录入并行度。Qwen3-0.6B r3 与 Qwen3-1.7B r2 支持 Attention TP 和请求 DP。内置 GQA 参考图也支持这两种方式，专用研究图支持 SP2、EP2、EP2×TP2、PCP2、DCP2 与 PP2。逻辑预览显示当前模型和阶段声明的分片、槽位和通信。「设备」为当前配置统一选择一种型号，也可在此自定义每卡参数。校验布局时，从已声明的逻辑槽位取得卡数并复用设备映射，或按所选型号生成所需设备。应用后，画布分析和 KV 容量使用同一份布局。

需要手工维护拓扑时，在「高级配置」中展开「高级设备与拓扑」。

### Qwen3 全模型

- Attention TP 均分 query heads 和 KV heads，切分 Q/K/V 与 O 权重及每卡 KV。每次 decoder 调用在输出投影与残差之间插入一次显式 AllReduce。FFN、归一化中未按 head 切分的部分、embedding 和 LM head 在各卡重复。两张卡运行默认的 28 层时共有 28 次归约。
- DP 均分独立请求。Batch 必须整除并行度。各卡驻留完整权重，独立计算自己的请求和 KV，无推理 collective。
- 旧工作区可在「并行方式」更新当前配置的固定模型修订。硬件映射、工作负载和旧配置仍按各自快照核对。Attention TP 和 DP 各自独立验证。环形 AllReduce 的消息按 BF16 隐藏张量计算，使用明示的带宽与延迟。
- TP 的模块规则引用固定模块修订，通过展开图的对象绑定逐次映射张量与轴。通信消息表达式使用模型根参数。改变层数或结构后重新校验并应用布局。
- 多步 Decode 的预览显示第一步分配，应用后按完整步骤更新 KV。包含通信的分析可分别给出算子 HBM 小计与通信耗时，通信节点的本地 HBM 待核定。

## 旧工作台操作与范围

1. 导入 `examples/gqa/tp-heads-project.json`，打开“并行预设与物理设备”。参考项目使用人工硬件，不表示实卡性能。
2. 设备列表中的每一项是一个实际物理设备。可复制首设备的硬件增加设备，再用全部设备建立一维组；组名复用不会产生新设备。复杂子组、坐标和多维布局继续在高级项目 JSON 编辑。
3. 选择固定模型声明的预设、实际组和全组 mesh 轴。TP 需要明确填写网络 bytes/s 与每轮延迟；可用参考值 1000、0.001。
4. 预览会实际展开模型，验证局部方程、整除、存储分配、归约和执行依赖。表格是全部已声明存储的分配合计；应用后“计算理论结果”才显示生命周期峰值。
5. 应用替换当前方案的 `parallelPlan`，固定新增公式依赖并沿原项目自动保存链保存。工作负载、量化/数值覆盖、融合和流配置保留；旧配置若与新布局冲突会明确报错，需要用户调整。

预览在 Worker 中运行，支持取消。输入、方案或资产快照改变后旧预览失效；依赖读取晚到也不能在取消后启动计算。生成来源仅记录模板历史，后续高级 JSON 修改不会被描述成仍与模板一致。

基础快捷生成器使用一个 1–64 成员的显式一维组和均匀分片，局部成本由作者提供的 `parallelPresets` 与 `localCost` 确定。DeepSeek 完整模型当前保留单卡理论参考。SP、EP、PP、PCP、DCP 和多维组合按 P5/P6 的实际研究项目验收。

## 四种明确语义

| presetId | 实际布局 | 通信与额外成本 |
| --- | --- | --- |
| replicated | 所有存储复制，每个 rank 执行同一逻辑批次 | 冗余副本，无推理 collective；物理工作随副本数增加 |
| dp-batch | 沿明确标注的 batch 轴均匀分请求，权重复制 | batch 必须整除；独立请求不生成推理 collective |
| tp-heads | Q/K/V head、对应权重及 attention 临时量分片；输入与 residual 复制 | output projection 产出 partial，AllReduce 后 residual 才执行；query/KV heads 均须整除 |
| tp-kv-replicated | query heads 分片，完整 KV 池及 K/V 投影权重复制 | 允许 rank 数大于 KV heads；每 rank 重复 K/V 投影和整池读取，再归约输出。不是按 query group 选择最小 KV 子集的优化实现 |

TP degree=1 不生成归约。多卡归约使用 BF16 完整输出 `2*B*Q*H` byte 作为消息量，算法系数 `2*(P-1)/P` 仅施加一次，启动轮数 `2*(P-1)`。网络耗时为消息量×系数/带宽 + 轮数×延迟；发送与接收分别展示，不相加后再次当作同一链路流量。AllReduce 的数学语义见 [NCCL 文档](https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/usage/collectives.html)，完整消息量修正系数见 [nccl-tests PERFORMANCE](https://github.com/NVIDIA/nccl-tests/blob/master/doc/PERFORMANCE.md)。模型声明 ring 分阶段假设，未模拟 NCCL 的 kernel、拓扑或协议。

归约原位更新输出、无额外通信 scratch 是本参考的明确假设。通信本地 HBM、归约算术和转换没有建模，完整 HBM 汇总保留 unavailable；不能用网络时间下界声称已得到真实 kernel 时间。

## DeepSeek-V3 与 DeepSeek-R1 全模型

模型修订 r2 支持请求 DP、Attention TP、MoE EP，以及共用设备的 Attention TP ＋ MoE EP。并行入口中的 `Attention TP=8`、`MoE EP=8` 使用同一个 8 卡设备池。设备型号在「设备」选择。已有 r1 工作区可以升级后应用布局。

Attention TP 沿查询头切分 Q 上投影、吸收后的 K／V 上投影权重、注意力分数和输出投影。每卡保留完整的 MLA 潜向量和位置键。输出投影后的 BF16 隐藏向量在加入注意力残差前执行 AllReduce。61 层共插入 61 次归约。

MoE EP 保留完整路由、分组 TopK、归一化权重和共享专家。按 `expert_id mod EP` 交错分配专家，再按拥有设备排列权重轴；每个原始路由组的专家分布到不同设备。各卡从复制的 token 和路由记录打包自己拥有的专家输入、ID 和权重。负载模型按每 token 选中位置均分，各卡完成本地专家后，在合并共享专家之前执行 AllReduce。58 个 MoE 层共插入 58 次归约。EP 的分析预算适用于选中专家数和专家总数均可整除的配置。实际路由倾斜、互连拓扑与内核开销需要各自的测量或配置。 [DeepSeek 官方推理参考](https://github.com/deepseek-ai/DeepSeek-V3/blob/b15f0dbbbe6a4bc403306175698439ef380f5fb5/inference/model.py)

同池 TP8 ＋ EP8 的 BF16 权重为每卡 `179,355,099,136 B`。每卡每 token 保存 `70,272 B` 的 MLA 缓存，八个物理副本合计 `562,176 B`。DeepSeek-V3 在 8 张 192 GB MI300X、默认单请求单 token 的 Prefill 配置下，显存预算为 `179,931 token / 请求`。可用上下文长度由模型配置决定。通信预填可编辑的理论参考带宽 `100 GB/s`、每轮延迟 `3 µs`，算子 HBM 与通信本地 HBM 分别展示。 [模型和配置来源](MODEL_REFERENCES.md#deepseek-v3-与-deepseek-r1)

## 独立 GQA 模型

这是一个完整的**合成 attention/residual 子图**，包括 Q/K/V 投影、cache append、QK、softmax 代理、AV、输出投影和 residual 九个节点。它不包含 norm、RoPE、MLP、embedding 或 logits head，不称为完整生产语言模型。矩阵/存储为 BF16；softmax 使用 FP32 scratch，向量工作为显式代理。cache append 只写当前 BF16 token tile，已有缓存仍被 attention 读取。

默认 B=1、Q=1、C=2、H=8、NH=4、NK=2、D=2；S=C+Q=3。因果有效 token 对 `C*Q+Q*(Q+1)/2`；矩形执行 token 对 `Q*S`。

- 参数数：`H*NH*D + 2*H*NK*D + NH*D*H = 192`，BF16 权重 384 B。
- KV：`2*B*S*NK*D*2 = 48 B`。TP head 两卡各 24 B，整池复制各 48 B。
- 矩阵工作：Q/K/V/output 投影分别 128/64/64/128 operations，QK/AV 各 48，总计 480。
- 向量代理：softmax `5*B*NH*Q*S=60`，residual 8，总计 68。复制的 residual 不应增加模型一次有效工作的分子。
- 单卡理论 HBM：按节点顺序为 160、88、88、32、64、144、64、160、48 B，总计 848 B。scratch 写入和读取都计入。

人工硬件每卡容量 1024 B，矩阵/向量能力各 1000 operations/s，HBM 100 B/s；网络 1000 B/s、每轮 0.001 s。以下耗时仅为这些声明下的理论串行结果。

| 两卡布局 | 全局 batch | 每卡权重 B | 每卡 state B | 每卡生命周期峰值 B | 物理矩阵 operations | 每卡已知叶节点 HBM B | 串行跨度 s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TP heads | 1 | 192 | 24 | 280 | 480 | 480 | 4.818 |
| TP，整池 KV 复制 | 1 | 256 | 48 | 368 | 608 | 592 | 5.938 |
| 同批次冗余复制 | 1 | 384 | 48 | 544 | 960 | 848 | 8.48 |
| DP 请求分片 | 2 | 384 | 48 | 544 | 960 | 848 | 8.48 |

TP 网络完整消息 16 B/rank，两卡系数为 1、两轮，耗时 `16/1000+2*0.001=0.018 s`。KV 复制多出的 128 矩阵 operations 来自重复 K/V 投影。所有 reference 均使用同一实际分析器生成结果，再与独立常数核对。

容量也使用完整生命周期，而非仅除 KV：固定 C=2 时两种 TP 的峰值分别为 `192+88*B`、`256+112*B`，最大 batch 分别为 9、6。固定 B=1 时峰值为 `max(240+8*S,208+24*S)`、`max(304+16*S,272+32*S)`，S=C+1，最大 context 为 33、22。扫描边界附近三个整数，确认后一整数超容。该结论仅针对声明的原位通信/临时量与人工容量。

更改已应用计划到 prefill B=2/Q=2/C=1 后，payload 随公式成为 64 B/rank；矩阵 useful/executed 分别 1856/1920。预设保存的是动态方程，不冻结生成时的 workload。

运行 `npm run reference:gqa` 重建 30 个内置资产、四份可移植项目及结果/布局/预览、两种 TP 的 batch/context 容量边界和 `examples/gqa/reference.json`。单元证据位于 `tests/parallel-presets.test.ts`；Chrome 场景位于 `tests/e2e/parallel-presets.spec.ts`。

## 查看成本与覆盖来源

计算完成后打开“成本与覆盖来源”，按节点、模块、规范存储或设备 ID 查找范围，再选耗时、读写、HBM、工作量、通信消息/算法流量或显存。多流/分布的局部结果与模型汇总分别查看；逐步 decode 可切换到具体步骤。分配总量和生命周期峰值不混用。

所选指标显示原始数值、单位、basis、固定公式的表达式、资产/参数引用、假设及缺项。引擎来源可能含所属范围共用依赖，面板说明这不表示每个公式都对该指标单独贡献。覆盖声明表保留输入目标、字段、数量/单位和作者说明；实际生效结果按所选指标核对，量化和布局的生效/被覆盖规则仍在原结果表查看。固定硬件定义和作者来源也可展开。

`tests/e2e/cost-sources.spec.ts` 使用同一 C01 图，明确覆盖 weight=72 B、traffic=448 B、time=2 s，复算得到 264 B 峰值、448 B HBM、2 s，矩阵工作保持 1024 operations。面板显示三份原始声明、求值记录与 `2*M*N*K` 公式；重开保留相同结果。这里的 72 B 是用户固定分配假设，没有声称自动选择量化 kernel。

[并行预览截图](images/gqa-preset-preview.png)与[来源面板截图](images/cost-source-inspector.png)来自真实 Chrome 验证；两者均已检查布局。
