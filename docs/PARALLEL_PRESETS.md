# 并行预设与 GQA 独立参考

检查点39补充：[SP2、EP2、EP2×TP2具名快捷预设](NAMED_PARALLEL_PRESETS.md)已接入同一预览/应用入口，使用声明式角色组和原生通信绑定。下文保留GQA的具体范围与手算；检查点40又增加[PCP2/DCP2/PP2](CONTEXT_PIPELINE_PRESETS.md)，实际因果查询片、KV槽位/归约及阶段传输均有独立证据。

检查点 23（2026-11-14）。核心、独立参考、预设/来源交互及最终完整回归已验证，P3 按原工作项验收通过，见 [P3 验收记录](P3_ACCEPTANCE.md)。

## 模型画布

画布的「并行方式」按 Attention、MoE、序列与流水线录入并行度。Qwen3-0.6B r3 与 Qwen3-1.7B r2 支持 Attention TP 和请求 DP。内置 GQA 参考图也支持这两种方式，专用研究图支持 SP2、EP2、EP2×TP2、PCP2、DCP2 与 PP2。逻辑预览显示当前模型和阶段声明的分片、槽位和通信。「设备」为当前配置统一选择一种型号，也可在此自定义每卡参数。校验布局时，从已声明的逻辑槽位取得卡数并复用设备映射，或按所选型号生成所需设备。应用后，画布分析和 KV 容量使用同一份布局。

## Qwen 解码层流水线

Qwen3-0.6B r4、Qwen3-1.7B r3 和 Qwen3.8-27B r3 可在「并行方式」填写 PP。每个阶段使用一张卡，按顺序均分连续层块，有余数时从第一阶段开始每阶段多放一个块。Qwen3.8 以实际的 GQA／DeltaNet 重复周期为分割单位，每个阶段保存所属层的权重和缓存。

Qwen3-1.7B 的 PP3 将 28 层分为 10、9、9 层。绑权的 embedding 和输出头各需要一份物理权重，分别驻留首尾卡。阶段之间以 SendRecv 发送完整 BF16 激活，Batch 2、单查询 token 时每处发送 8,192 B。Qwen3.8-27B 的 PP2 每卡各有 8 个 GQA／DeltaNet 周期，KV 合计为 65,536 B／token／请求。耗时使用单 microbatch 依次经过所有阶段的基线。

## Qwen3 Prefill 查询分片

Qwen3-0.6B r5 和 Qwen3-1.7B r4 可在 Prefill 的「并行方式」填写 PCP。当前查询 token 按连续位置均分，各卡执行自己的 embedding、投影、Attention、MLP 和输出头。每层先对当前 BF16 K 和 V 分别做 AllGather，再在各卡更新完整的 KV 缓存。历史 KV 和权重按卡复制，logits 保留查询分片。查询数须整除 PCP，点击应用 PP、TP 或其他度数时会生成相应的新布局。

对每卡的查询长度 `q`、切片起点 `a`、历史长度 `C`，有效查询键对数为 `q(C+a) + q(q+1)/2`。物化矩形执行量使用 `q(C+Q)`，其中 `Q` 是当前全部查询数。Prefill 的 KV 预算逐卡包含复制量，两个型号的 BF16 缓存均为每卡 **114,688 B／token／请求**。理论通信按本卡当前 K/V tile 和环形模型计算。当前 K/V 激活沿用 BF16，KV 缓存存储可按配置单独量化。

Qwen3-0.6B r8 和 Qwen3-1.7B r7 可以同时填写 Attention DP 和 PCP。DP2、PCP2、Batch 4 使用四张卡。每组独立处理两条请求，组内按查询位置分片并收集本组当前 K/V。每卡缓存本组请求的历史和当前 K/V，输出保留本组请求及查询分片。Batch 须整除 DP，当前查询数须整除 PCP。旧 PCP 工作区可在「并行方式」更新模型并保留现有布局。

## Qwen3 Decode KV 分片

Qwen3-0.6B r6 和 Qwen3-1.7B r5 可在 Decode 的「并行方式」填写 DCP。每步处理一个查询 token，各卡复制权重并按连续位置均分预留 KV 槽位。新 token 只写入其槽位所在的卡。每层通过 FP32 的最大值、分母和加权向量归约合并 GQA 输出。

槽位数由模型参数 `M` 决定，须整除 DCP 度，且能容纳本次 Decode 的上下文与生成 token。以 8 槽位、DCP2 为例，两卡各预留 4 个槽位。理论矩阵计算按预留长度计入执行量，按有效 token 计入有效工作量。容量面板显示每请求固定槽位和当前已用量。

Qwen3-0.6B r7 和 Qwen3-1.7B r6 可以同时填写 Attention DP 和 DCP。DP2、DCP2、Batch 4 使用四张卡。两组各处理两条请求，组内两张卡均分每条请求的固定 KV 槽位。计算、缓存写入和三次归约都使用本组的请求范围。Batch 须整除 DP，槽位数须整除 DCP。采用 8 槽位时，每张卡预留两条请求各 4 个槽位，BF16 合计 896 KiB。已应用 DCP 的工作区可在同一入口更新模型，校验通过后继续使用当前布局。

## 请求 DP 与张量分片组合

模型在当前阶段同时声明请求 DP 和张量分片时，可以组合两者。Attention DP2、TP2 使用两组独立请求，每组两张卡，共四张卡。Batch 4 会在每组安排两条请求，组内按原 TP 规则分配 Attention 权重和 KV 头。模型支持的 MoE EP 或 TP 布局也能在每个请求组内应用，沿用各自分片和全局 TopK。

每组在原数据流合并点归约自己的请求切片。通信按组内设备数计算环形归约轮数与流量，并按同构请求组并行执行计算跨度。通信来源保留组内消息公式以及逐卡请求范围。Batch 须整除请求组数，前向与 Decode 的缓存容量均按当前逐卡布局计算。均匀请求分片还会在容量面板给出本组每卡的单请求、单 token KV 字节数。

## 全模型 MoE EP × TP

Qwen3.5-397B-A17B r3／r4、GLM-5.2 r2 和 Kimi-K3 r2／r3 可同时填写 MoE EP 和 MoE TP。以 EP2、TP2 为例，路由专家分成两组，每组两张卡切分专家的中间维度。四张卡共用一份逻辑请求，每个 token 仍按模型的全局 TopK 选专家。EP 按商和余数分发有效路由，TP 分片共享其专家组的路由，每卡用本地权重和有效槽位计算。专家数及专家中间维度须分别整除 EP 和 TP 度。

「Attention TP」设为 `1` 时 Attention 在原设备上逐卡复制。设为 `EP × TP` 时 Attention 在同一批设备上分片，GPU 数仍为 `EP × TP`。每个 MoE 层在原合并点进行一次全池 AllReduce，对每张卡的局部专家贡献求和。Qwen／GLM 先归约再加共享专家，Kimi‑K3 在潜向量 RMSNorm 前归约。通信采用配置的环形模型，Attention 的归约单独计算。各卡的 KV 与发布权重缩放因子按生效布局计算。快捷入口支持最多 64 个实际设备槽位。

需要手工维护拓扑时，在「高级配置」中展开「高级设备与拓扑」。

### Qwen3 全模型

- Attention TP 均分 query heads 和 KV heads，切分 Q/K/V 与 O 权重及每卡 KV。每次 decoder 调用在输出投影与残差之间插入一次显式 AllReduce。FFN、归一化中未按 head 切分的部分、embedding 和 LM head 在各卡重复。两张卡运行默认的 28 层时共有 28 次归约。
- DP 均分独立请求。Batch 必须整除并行度。各卡驻留完整权重，独立计算自己的请求和 KV，无推理 collective。
- 旧工作区可在「并行方式」更新当前配置的固定模型修订。硬件映射、工作负载和旧配置仍按各自快照核对。Attention TP 和 DP 各自独立验证。环形 AllReduce 的消息按 BF16 隐藏张量计算，使用明示的带宽与延迟。
- TP 的模块规则引用固定模块修订，通过展开图的对象绑定逐次映射张量与轴。通信消息表达式使用模型根参数。改变层数或结构后重新校验并应用布局。
- 多步 Decode 的预览显示第一步分配，应用后按完整步骤更新 KV。包含通信的分析可分别给出算子 HBM 小计与通信耗时，通信节点的本地 HBM 待核定。

### Qwen3.5 与 Qwen3.8 混合注意力全模型

- Qwen3.5-397B-A17B r2 和 Qwen3.8-27B r2 支持 Attention TP 和请求 DP。默认配置的 Attention TP 分别可取 2 及 2／4，各卡保留完整的 KV 头与对应的查询组。DeltaNet 分别切分 Q、K、V 卷积通道、历史缓冲及 FP32 递推矩阵的值头。每层注意力输出在残差相加前执行一次 AllReduce。DP 按 batch 均分请求，各卡持有完整权重和本地请求的状态。
- 397B 可单独设置 MoE TP。每张卡都接收相同的 Top-10 专家 ID 与归一化权重，切分每个路由专家的 gate、up 和 down 中间维度。每卡先加权合并路由贡献，AllReduce 之后再加入本卡完整的共享专家输出。默认专家中间维度为 1024，须整除 TP 度。60 层各插入一次归约。Attention TP 2 和 MoE TP 2 可以共用两张卡，两处归约各自保留。
- 397B r3 支持 MoE EP。EP 8 时每卡驻留 512 个路由专家中的 64 个，每个 token 仍在 512 个专家里全局选 10 个。按均衡负载估算，八卡平均每卡 1.25 条有效路由，整数有效工作量按 `2、2、1、1、1、1、1、1` 记录。每卡按 2 个预留槽位估算填充后的执行量，权重读取按有效路由估算。真实路由量取决于选中专家的位置。各卡本地打包自己的路由，归约后再合并共享专家。Attention TP 2 和 MoE EP 2 也可共用两张卡。 [专家并行参考](https://github.com/huggingface/transformers/blob/506ac612812b9682dfcfea300b71c1b709cfbae0/docs/source/en/expert_parallelism.md)
- 容量首页显示合计及均匀每卡分片或复制的 KV 开销。27B 的 Attention TP 4 总计 `65,536 B/token`，每卡分片 `16,384 B/token`，另有 `38,731,776 B` 的每请求固定 DeltaNet 状态。397B 的 MoE TP 8 复制注意力，每卡 `30,720 B/token`，总计 `245,760 B/token`。理论通信采用可编辑的带宽和延迟，通信本地 HBM 单独列为待核定。现有 r1 工作区可在「并行方式」切换到 r2。

DeltaNet 分片参考了各 Q/K/V 投影和 depthwise 卷积的实际加载方式。成本继续采用串行递推算式与明示的 BF16／FP32 状态。397B 的 TopK 比较以标量向量吞吐估算。 [固定实现](https://github.com/vllm-project/vllm/blob/9a4930a797846e4d57af7f72df20d82acaeb9c10/vllm/model_executor/layers/mamba/gdn/qwen_gdn_linear_attn.py)

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

模型修订 r3 支持请求 DP、Attention TP、MoE EP，以及共用设备的 Attention TP ＋ MoE EP。并行入口中的 `Attention TP=8`、`MoE EP=8` 使用同一个 8 卡设备池。设备型号在「设备」选择。已有工作区可升级到 r3 后重新应用布局。

Attention TP 沿查询头切分 Q 上投影、吸收后的 K／V 上投影权重、注意力分数和输出投影。每卡保留完整的 MLA 潜向量和位置键。输出投影后的 BF16 隐藏向量在加入注意力残差前执行 AllReduce。61 层共插入 61 次归约。

MoE EP 将 256 个路由专家的权重按 `expert_id mod EP` 分给各卡，并要求专家总数能整除 EP。每个 token 在全局仍选择 8 个专家，并保留分组 TopK、归一化权重和共享专家。理论负载按商和余数分配，EP16 时 8 张卡各处理 1 个有效槽位，另外 8 张卡处理 0 个。每卡按 `ceil(TopK / EP)` 预留槽位，理论执行计算包括填充，有效计算与路由专家权重读取按实际有效槽位计入。各卡完成本地专家后，在合并共享专家之前执行 AllReduce。58 个 MoE 层共插入 58 次归约。真实路由偏斜、互连拓扑与内核开销由实际执行决定。 [DeepSeek 官方推理参考](https://github.com/deepseek-ai/DeepSeek-V3/blob/b15f0dbbbe6a4bc403306175698439ef380f5fb5/inference/model.py)

同池 TP8 ＋ EP8 的 BF16 权重为每卡 `179,355,099,136 B`。每卡每 token 保存 `70,272 B` 的 MLA 缓存，八个物理副本合计 `562,176 B`。DeepSeek-V3 在 8 张 192 GB MI300X、默认单请求单 token 的 Prefill 配置下，显存预算为 `179,931 token / 请求`。可用上下文长度由模型配置决定。通信预填可编辑的理论参考带宽 `100 GB/s`、每轮延迟 `3 µs`，算子 HBM 与通信本地 HBM 分别展示。 [模型和配置来源](MODEL_REFERENCES.md#deepseek-v3-与-deepseek-r1)

## DeepSeek-V4 Flash 系列

V4-Flash 和 V4.1-Flash r2 支持请求 DP、Attention TP、MoE EP，以及共用卡池的 Attention TP ＋ MoE EP。已有工作区可在「并行方式」更新模型，再校验并应用布局。请求 DP 均分完整请求，每卡持有全模型权重。 [V4 官方参考实现](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/blob/60d8d70770c6776ff598c94bb586a859a38244f1/inference/model.py) · [V4.1 官方参考实现](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/314113f8a7dadb388215396ba5fbee2c610a04d6/inference/model.py)

- Attention TP 切分查询头、索引头及匹配的输出组。索引分数在 Top‑K、候选块选择或候选掩码前执行 FP32 AllReduce。注意力输出在转换到 BF16 前执行 FP32 AllReduce。滑窗、压缩 KV、索引 K 和压缩历史在每卡复制。V4.1 的跨层共享缓存每卡只分配一次。
- MoE EP 均分 256 或 384 个路由专家。每个 token 的全局 Top‑K 都是 6。EP8 的理论负载是 6 个有效槽位分到 6 张卡，每卡预留 1 个槽位。有效槽位决定有用工作和专家权重读量。每层先归约 FP32 路由输出，再加共享专家。
- V4.1 同池预设还按行分片两张 Engram 表及缩放项，每卡按向上取整的行数分配。每卡查有效行或掩蔽的占位行，随后归约 BF16 查表结果。投影仍在各卡计算。整层的权重保留当前 BF16／FP32 理论格式，以及 Engram 的原有 FP8 表和 E8M0 缩放项。

在单请求、Prefill 结束时 4 个 token 的 TP8 ＋ EP8 参考配置下，以下为每卡分配和全模型归约数量。网络使用可编辑的带宽和延迟，路由负载按均衡假设估算。

| 型号 | 每卡权重 | 每卡 KV 含索引 | AllReduce |
| --- | ---: | ---: | ---: |
| DeepSeek-V4-Flash | 77,725,277,116 B | 5,662,976 B | 107 |
| DeepSeek-V4.1-Flash | 170,975,675,656 B | 5,255,680 B | 90 |

## GLM-5.2

GLM-5.2 r2 支持请求 DP、Attention TP、MoE EP、MoE TP，以及 Attention TP 与同规模 MoE 并行共用卡池。请求 DP 分片完整请求与对应 KV，各卡持有完整权重。Attention TP 分片 MLA 查询头和相应投影，在残差前归约 BF16 输出。21 个索引计算和选中行号在各卡复制，78 层仍各自保存 MLA 缓存。 [vLLM GLM 路由](https://github.com/vllm-project/vllm/blob/2cf0a6915ce544dc493a0990f2ea38d81601128a/vllm/model_executor/models/registry.py) · [MLA 与 DSA 实现](https://github.com/vllm-project/vllm/blob/2cf0a6915ce544dc493a0990f2ea38d81601128a/vllm/model_executor/models/deepseek_v2.py)

MoE EP 均分 256 个路由专家的权重。每个 token 选择 8 个专家，理论有效槽位按商和余数分配。MoE TP 在每个专家内部切分成对的 gate／up 中间特征及 down 投影的对应输入维。两种方式都在 75 个 MoE 层归约 BF16 路由输出，再加共享专家。

在 BF16 的 TP8 ＋ EP8 配置中，每卡权重为 198,072,000,000 B，每卡每请求每 token 的 MLA 与索引缓存合计 95,232 B，完整解码器有 153 个 AllReduce。该配置按 192 GB／卡估算时无剩余 KV 预算。浏览器正向用例采用显式设置的 256 GB／卡容量，网络耗时按可编辑的环形归约模型估算。

## Kimi-K3

Kimi-K3 r2 和 r3 支持请求 DP、Attention TP、MoE EP、MoE TP，以及 Attention TP 和同规模 MoE 并行共用卡池。请求 DP 分片完整请求及其深度归档、KDA 状态和 MLA 缓存，每卡持有完整权重。

Attention TP 分片 KDA 和 MLA 查询头。KDA 为每个头保存独立的卷积历史与递推矩阵，固定状态随头数分片。MLA 使用共享的潜向量和 NoPE 键缓存，在每卡复制。Attention 输出归约结束后再进入深度混合或残差累加。 [vLLM 的 Kimi-K3 并行说明](https://vllm.ai/blog/2026-07-27-k3) · [MLA 缓存与并行说明](https://vllm.ai/blog/2026-09-08-vllm-agentx)

MoE EP 均分 896 个路由专家，每个 token 仍选择 16 个专家。理论有效槽位按商和余数分配，逐卡按向上取整的槽位数预留。MoE TP 切分每个专家内成对的 gate／up 特征和对应的 down 输入。两种方式都先归约 BF16 潜向量，再执行 RMSNorm 和升维投影。

BF16 的 TP8＋EP8 配置每卡权重为 731,585,710,576 B。每个活跃请求每卡另有 56,807,424 B 的固定 KDA 状态，MLA 每 token 占 27,648 B。93 层 Attention 和 92 层 Latent MoE 共 185 次 AllReduce。正向浏览器测试采用自定义的 750 GB／卡容量，耗时使用可编辑的环形归约参数。

r3 的同卡池 TP8＋EP8 配置选择「官方 MXFP4 权重」后，每卡权重为 231,707,511,280 B，含 112 个路由专家在各 MoE 层的本地缩放因子。以 256 GB／卡的自定义容量可获得正的 KV token 预算。 [权重覆盖范围](MODEL_REFERENCES.md#kimi-k3)

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
