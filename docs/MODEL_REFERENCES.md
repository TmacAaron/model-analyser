# 固定来源模型与理论执行口径

核对日期：2026-11-14。模型 JSON 是可编辑的分析资产，不加载或执行 Python，不执行推理。已固定的源码仅用于离线核对结构；没有下载权重张量。

本文保留首批三个根模型的原始口径；2026-11-15检查点37另增[Qwen3-1.7B与GLM-4-9B BASE 8K](EXPANDED_MODEL_PRESETS.md)，使用独立扩充来源锁及六份项目，不改动首批模块/公式修订。GLM包含完整M的RoPE表构造代理，不能套用下文首批模型“不计表构造”的范围说明。当前内置累计449个head/452份JSON；各研究片段和完整型号的范围分别列明。

运行 `npm run reference:models`，先核对本地来源文件的 SHA256、配置与参数清单，再确定性生成内置资产、四个可移植项目和 [独立参考摘要](../examples/computed/real-model-reference.json)。正常使用和生成参考都不访问网络。资产由通用图、模块、repeat、状态、存储与公式组成，core 没有模型名称分支。

| 资产 | 结构与已验证范围 | 执行假设 |
| --- | --- | --- |
| `builtin:model:qwen3-0.6b` | 28 层 Dense/GQA；16 query heads、8 KV heads、head dim 128；独立 Q/K RMSNorm；共享 embedding/head | BF16、单卡、显式物化矩形 attention；有效工作按因果 token 对计数；完整位置 logits |
| `builtin:model:deepseek-v2-lite-expanded` | 首层 Dense、后 26 层 MoE；64 routed、Top-6、2 shared；MLA rank 512、rotary dim 64；独立 embedding/head | 发布方 HF 代码的 KV-B 展开后缓存 K/V；完整位置 logits，最终转 FP32 |
| `builtin:model:deepseek-v2-lite-absorbed` | 同一参数清单，另一个显式执行图 | 数学吸收 MLA 理论变体；缓存 normalized latent 和共享 rotary key，query 吸收 K-up，value 在加权 latent 后投影；**不是固定 HF 实现，也不保证重排后 BF16 数值逐位相同** |

内置结构支持 prefill 和 decode，根参数 B/Q/C 默认绑定当前 workload。显式 scenario binding、scenario/node 数值覆盖继续优先。Query tokens 表示本次调用处理的位置数；不会依据 `chunkTokens` 自动拆成多次 prefill。全位置 logits、矩形 attention 和 HBM 访问假设可以通过复制资产、修改图/公式或显式覆盖来研究其他执行。

检查点 22 为上述三个根模型发布 r2，新增声明式 config 映射元数据，图与原数值参数不变。原 r1 文件保留，现有项目快照不静默升级；模块与公式仍为原修订。上述真实模型及 GEMM 为 84 个资产 head；检查点 23 另增 30 个合成 GQA 参考资产，检查点25另增两份固定来源硬件，当时共116个head、三个模型历史根文件（119份JSON），见[硬件说明](HARDWARE_PROFILES.md)。GQA 参考是 attention/residual 子图，未扩张这三个真实模型的单卡执行范围，见 [并行说明](PARALLEL_PRESETS.md)。config 按该模板创建的是新模型草稿，映射范围、未知字段与量化核对见 [导入说明](CONFIG_IMPORT.md)；不把相近模板当作新家族的自动适配。

## 来源与许可

- Qwen 模型仓库提交 [`c1899de…`](https://huggingface.co/Qwen/Qwen3-0.6B/tree/c1899de289a04d12100db370d81485cdf75e47ca)，包含 config、Apache-2.0 LICENSE 及 safetensors 元数据头。
- Qwen 结构使用 Transformers v4.51.0 的提交 [`0720e206…`](https://github.com/huggingface/transformers/blob/0720e206c6ba28887e4d60ef60a6a089f6c1cc76/src/transformers/models/qwen3/modeling_qwen3.py)。本地副本保留原版权/Apache-2.0 头。
- DeepSeek 模型仓库提交 [`604d5664…`](https://huggingface.co/deepseek-ai/DeepSeek-V2-Lite/tree/604d5664dddd88a0433dbae533b7fe9472482de0)，固定 config、带 Apache-2.0 版权头的 modeling 文件及分片索引。模型权重许可与代码许可分别适用；本项目不分发模型权重。
- 七份文件、原始 URL、长度和 SHA256 见 [source-lock.json](../references/models/source-lock.json)。重新获取使用 `scripts/fetch-model-sources.ts`；Windows 可运行 `scripts/fetch-model-sources.ps1`。两者在读取 body 前检查 Range 响应，并限制读取字节数。Qwen 仅请求前 8 字节长度和随后 35,552 字节 JSON 元数据，拒绝服务器忽略 Range 的响应。

## 独立算术核对

| 项目 | Qwen3-0.6B | DeepSeek-V2-Lite |
| --- | ---: | ---: |
| 唯一参数 | 596,049,920 | 15,706,484,224 |
| BF16 权重常驻 bytes | 1,192,099,840 | 31,412,968,448 |
| 每请求、每缓存 token 的 state bytes | 114,688 | expanded：276,480；absorbed：31,104 |

Qwen 每层参数为 `6,291,456 attention + 9,437,184 MLP + 2,048 input/post norm + 256 Q/K norm = 15,730,944`。总计为 `28 × 15,730,944 + 151,936 × 1,024 + 1,024`。Q/K gamma 各只有 128 个参数，按 head 广播。检查点头含 embedding 和 lm_head 两个独立序列化条目，合计 751,632,384 个 BF16 元素；运行时按 config 的 tying 去掉重复的 155,582,464 个常驻参数。该结论不依赖模型昵称中的“0.6B”。

DeepSeek 每层 attention 矩阵为 `6,291,456 Q + 1,179,648 KV-A + 2,097,152 KV-B + 4,194,304 O`，再加 512 latent norm 和 4,096 input/post norm。首层 MLP 为 67,239,936；每个 MoE FFN 包含 553,648,128 routed、17,301,504 shared 和 131,072 router 参数。与 embedding/head/final norm 合计，与固定索引的 31,412,968,448 BF16 权重 bytes 一致。

GQA cache 使用 `layers × 2(K,V) × KVheads × headDim × BF16bytes`，不能使用 query heads。DeepSeek HF expanded cache 使用 `layers × heads × (nopeDim + ropeDim + valueDim) × BF16bytes`；absorbed 使用 `layers × (rank + ropeDim) × BF16bytes`。三者再乘 B 和本次调用结束的 `C+Q`。

小尺寸 Dense+MoE/MLA 独立案例见 `tests/real-models.test.ts`：H=4、两层、8 routed/Top-2/1 shared、B=2/Q=3/C=1，总计 718 参数、1,436 weight bytes、384 state bytes；matrix useful/executed 为 5,712/6,000，selection proxy 为 96 次。权重驻留全部专家，执行只计 TopK；FP32 router 和选择代理不会混入 BF16 matrix 类别。

## 限制与使用

- 默认每个声明的缓冲读写使用 HBM factor=1；不是实测流量，不保证缓存复用、repeat_kv 物化或实际内核实现。矩形 scores/probabilities 和 FP32 softmax workspace 显式计空间/流量；不声称 FlashAttention。
- norm/softmax/SiLU、RoPE application 等 vector 计数是明示近似；不计 rotary/YaRN 表及三角函数构造、具体排序算法、运行时/分配器开销。TopK 使用独立 custom comparison 代理。DeepSeek router 按固定代码 FP32、softmax、greedy/no-renormalization 口径；auxiliary training loss 不在推理图。
- routed 专家权重读取按 `min(E,B×Q×K)` 个不同专家、每矩阵读一次的上界假设；token 分配与负载不均未知。没有自动 EP、TP 或网络转换；多卡必须补齐明确布局和局部方程。
- Decode cache 声明 `allocationBasis=step_end`，分配已包含本步 query 写入；序列保存上步物理容量与当前调用预留，避免再加一个 Q。copy/reallocation 开销仍需显式节点。状态和权重不会跨步骤相加。
- 示例硬件为虚构的十进制 80 GB、matrix/vector/selection 各 1 TOP/s、HBM 1 TB/s，仅用于复算。不提供实卡性能或精度结论。大型完整 JSON 仍包含逐指标来源，文件可能较大。

可直接导入：[Qwen decode](../examples/projects/qwen3-0.6b-decode.json)、[Qwen prefill](../examples/projects/qwen3-0.6b-prefill.json)、[DeepSeek expanded](../examples/projects/deepseek-v2-lite-expanded.json)、[DeepSeek absorbed](../examples/projects/deepseek-v2-lite-absorbed.json)。也可从资产库选择内置模型并手工创建硬件；工作台新增方案不需要手写 B/Q/C 绑定。

## DeepSeek-V3 与 DeepSeek-R1

画布下拉列表的 DeepSeek 分类包含两个独立型号。两份固定发布配置在主 decoder 结构上相同，共用模块和公式。画布显示 `3 ×` Dense 和 `58 ×` MoE。进入一个 MoE block 可查看投影、MLA、两处 residual，以及 Routed Experts 和 Shared Expert 的分支与汇合。路由分支可下钻到 sigmoid、校正偏置、组选择、专家 TopK 与原始亲和度归一化。

| 核对项 | 两个型号的主模型 |
| --- | --- |
| Attention | 128 heads，Q 低秩维度 1536，KV 潜向量 512，共享 rotary key 64 |
| MoE | 256 routed experts，8 个组，选择 4 个组与 8 个 routed experts，另有 1 个 shared expert |
| 参数 | 671,026,419,200，含分组路由校正参数 |
| 张量权重 | 1,342,052,868,096 B，BF16 权重与 FP32 路由校正 |
| BF16 KV | 每请求每 token 70,272 B，即 `61 × (512 + 64) × 2` |

预设分析主 decoder 的 absorbed MLA 数学路径。显式物化矩形 attention 临时张量，权重采用 BF16 理论口径，路由与选择分别采用向量及比较代理。发布检查点的 FP8 分块格式、MTP、投机解码、YaRN 表构造和分布式布局需单独建模。默认单卡显存不足时，容量仍显示 KV 单 token 占用与零槽位预算。

`npm run reference:deepseek-v3` 校验两份原始配置的 SHA-256、内置资产和旧 V2-Lite 修订。生成新缺失文件时追加 `-- --write`。数值回归由 `tests/deepseek-v3.test.ts` 直接构建项目并独立复算，无需模型权重或大型示例文件。

修订 r3 提供逐卡方程与设备布局。请求 DP 按 batch 分片。Attention TP 按头分片并复制 MLA KV。MoE EP 按交错专家归属分片，并可与 Attention TP 共用一个卡池。EP 的整除条件作用于专家总数，每个 token 的全局 TopK 保持不变，逐卡路由成本按均衡负载估算。 [并行说明](PARALLEL_PRESETS.md#deepseek-v3-与-deepseek-r1-全模型)

修订 r4 增加理论 MoE TP，可切分路由专家的中间通道并与 MoE EP 组合。沿用 BF16 权重分析和 r3 的全局 Top‑8 路由规则。 [逐卡布局](PARALLEL_PRESETS.md#deepseek-v3-与-deepseek-r1-全模型)

修订 r5 可在「量化」选择「官方 FP8 权重」。主解码器的 MLA 投影、Dense SwiGLU 和路由／共享专家矩阵使用 E4M3FN，每个 128 × 128 块计一个 FP32 反缩放因子。吸收式 MLA 的 K／V 矩阵沿完整块拆分，路由专家读取按每卡命中的专家数计入权重与缩放因子。嵌入、输出头、归一化和路由器权重为 BF16，路由校正为 FP32。该预设沿用 BF16 矩阵执行与 MLA KV 格式。 [官方权重说明](https://huggingface.co/deepseek-ai/DeepSeek-V3/blob/e815299b0bcbac849fa540c768ef21845365c9eb/README_WEIGHTS.md) · [检查点索引与抽样头部摘要](../references/models/deepseek-v3/fp8-manifest.json)

修订 r6 将 Dense 与 MoE 层纳入同一条可按阶段切分的流水线，支持在「并行方式」设置 PP，并与请求 DP、阶段内 Attention TP、MoE EP × TP 及固定发布权重组合。 [逐卡权重、KV 与传输](PARALLEL_PRESETS.md#deepseek-v3-与-deepseek-r1-全模型)

在画布中选中吸收式 MLA、分组 MoE 路由或 SwiGLU 的算子，可以查看实际计算步骤及固定推理源码。路由步骤区分参与排序的修正分数与用于加权的原始分数，并保留全局 Top‑K 的口径。 [DeepSeek 固定推理源码](https://github.com/deepseek-ai/DeepSeek-V3/blob/b15f0dbbbe6a4bc403306175698439ef380f5fb5/inference/model.py)

来源为固定的 [DeepSeek-V3 配置](https://huggingface.co/deepseek-ai/DeepSeek-V3/blob/bd0dd75c911b4a171ae9b1e0a71f7ae45641cf65/config.json)、[DeepSeek-R1 配置](https://huggingface.co/deepseek-ai/DeepSeek-R1/blob/00c6b9d6b8308971df69134e7b421ab7a7fe6f66/config.json)、[V3 推理结构源码](https://huggingface.co/deepseek-ai/DeepSeek-V3/resolve/bd0dd75c911b4a171ae9b1e0a71f7ae45641cf65/modeling_deepseek.py)和[架构报告](https://arxiv.org/html/2412.19437#S2.SS1)。

## DeepSeek-V4-Flash

画布从两层滑窗加哈希路由开始，随后是一层 CSA 加哈希路由，以及 20 个 HCA → CSA 周期。主解码器共 43 层，含 21 层 CSA、20 层 HCA。CSA 使用 4 token 分组和独立索引，HCA 使用 128 token 分组，两类都保留 128 token 的局部窗口。进入 block 可查看投影、Hyper-Connections 的原始残差流，以及 Routed Experts 和 Shared Expert 的分支与汇合。

每请求的 BF16 缓存字节按 `2 × [43 × 128 × 512 + 21 × floor(L / 4) × (512 + 128) + 20 × floor(L / 128) × 512]` 计算。公式分别计入固定滑窗、CSA 潜向量与索引、HCA 潜向量。池化的 FP32 值与得分缓冲另占 12,206,080 B／请求。容量固定当前推理配置的理论非 KV 峰值，并按显存上限及缓存量化计算 token 槽位。平均占用随当前长度变化，分组完成时才增加一行。

早期预设采用大矩阵 BF16 参考口径和推理源码中的 FP32 特定权重，包含 570,412,548,444 B 张量权重。稀疏注意力以显式分数矩形估算临时缓冲，非线性及选择开销使用分项近似。r2 可用同一批设备组合 Attention TP 与 MoE EP，r3 可进一步切分路由专家的中间通道。r4 可在「量化」选「官方 FP4／FP8 权重」，按每 32 输入通道计路由专家的 FP4 缩放因子，FP8 投影与共享专家按 128×128 计块，均使用 E8M0。 [并行口径](PARALLEL_PRESETS.md#deepseek-v4-flash-系列) · [发布权重索引及分片头摘要](../references/models/deepseek-v4/weight-manifest.json)

`npm run reference:deepseek-v4` 校验两份原始配置摘要和内置资产。固定来源为 [模型配置](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/blob/60d8d70770c6776ff598c94bb586a859a38244f1/config.json)、[推理配置](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/blob/60d8d70770c6776ff598c94bb586a859a38244f1/inference/config.json)、[解码器实现](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/blob/60d8d70770c6776ff598c94bb586a859a38244f1/inference/model.py)和 [Sinkhorn 内核](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/blob/60d8d70770c6776ff598c94bb586a859a38244f1/inference/kernel.py)。

## DeepSeek-V4.1-Flash

内置预设按发布的 40 层主文本解码器展开。前两层使用局部滑窗；第 2–19 层采用 R2 分组，第 20–39 层采用 R1。层号从 0 开始。第 2、8、14、20 层各自写入一组共享 KV 和索引 K。第 24、28、32、36 层重新评分时读取第 20 层的索引 K 和候选掩码。其他复用层读取对应索引源选择好的位置。两条 Hyper-Connections 路径传递实际残差和下一子层的混合系数。

第 1、14 层通过 Engram 向各自的残差流注入查表结果。两张 FP8 表与 E8M0 scale 合计 202,758,032,400 B。r2／r3 的参考权重合计 1,307,953,639,888 B，由 BF16 矩阵基线、源码中的 FP32 权重及 Engram 表组成。文本路径采用发布的专家选择规则。r2 在同池 TP／EP 布局下分片 Engram 表，并保留跨层共享 KV 和索引。r3 在专家归属和中间通道同时切分时沿用整池 Engram 分片。r4 提供「官方 FP4／FP8 权重」，路由专家按每 32 输入通道计 FP4 缩放因子，FP8 矩阵（含 Engram 投影）按 32×32 计 E8M0 缩放因子。理论执行、图像分支与 DSpark 各自使用对应模型的建模范围。 [并行口径](PARALLEL_PRESETS.md#deepseek-v4-flash-系列) · [发布权重索引及分片头摘要](../references/models/deepseek-v41/weight-manifest.json)

每请求的滑窗、全局 KV 和索引缓存为 `2 × [40 × 128 × 512 + (3 × floor(L / 2) + L) × (512 + 128)]` B。固定状态另含三组 R2 的 FP32 压缩缓冲和 Engram 的 INT64 历史区；历史区按配置的上下文容量预留。容量预算在当前非 KV 峰值下计算，跨层复用只保留一次物理分配。索引计算先对可用位置求完整分数，再应用候选掩码。

`npm run reference:deepseek-v41` 校验发布配置及内置资产。固定来源为 [模型配置](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/314113f8a7dadb388215396ba5fbee2c610a04d6/config.json)、[推理配置](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/314113f8a7dadb388215396ba5fbee2c610a04d6/inference/config.json)、[主解码器](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/314113f8a7dadb388215396ba5fbee2c610a04d6/inference/model.py)和 [Engram 哈希](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/314113f8a7dadb388215396ba5fbee2c610a04d6/inference/engram.py)。

## Qwen3.5-397B-A17B 与 Qwen3.8-27B

两个文本解码器都采用三个 Gated DeltaNet 层接一个 Gated GQA 层的周期。进入周期可查看 DeltaNet、GQA、各自的外部投影及 residual。397B 使用带独立门控的 Shared Expert 和 Top-10 Routed Experts，27B 使用 Dense SwiGLU。

| 核对项 | Qwen3.5-397B-A17B | Qwen3.8-27B |
| --- | ---: | ---: |
| DeltaNet / GQA 层数 | 45 / 15 | 48 / 16 |
| BF16 KV 每请求每 token | 30,720 B | 65,536 B |
| 每请求固定 DeltaNet 状态 | 193,167,360 B | 154,927,104 B |

KV 槽位计算只伸缩 GQA 的 K/V 张量。DeltaNet 的 BF16 卷积缓冲及 FP32 递推状态计入固定占用。预设按 BF16 文本主解码器、串行递推方程和显式 attention 临时缓冲估算。r2 增加[全模型并行配置](PARALLEL_PRESETS.md#qwen35-与-qwen38-混合注意力全模型)。视觉分支、MTP 和实际 chunk 内核需要各自的定义。

397B r3 增加 MoE EP。512 个路由专家按其全局编号均分到卡，每个 token 的 TopK 仍为 10。逐卡路由成本按均衡负载估算。 [并行口径](PARALLEL_PRESETS.md#qwen35-与-qwen38-混合注意力全模型)

397B r4 和 r5 的「量化」提供「官方 FP8 权重」和「FP8 执行」。两种模式都按发布格式计算注意力投影、路由专家和共享专家矩阵的空间与读量。E4M3 权重按 128×128 矩阵块存放，每块一个 BF16 `weight_scale_inv`。Embedding、LM head、路由器、共享专家的门控、DeltaNet 卷积及 a/b 投影采用 BF16。DeltaNet 的 `A_log` 和门控归一化权重按 FP32 计入。 [官方 FP8 配置](https://huggingface.co/Qwen/Qwen3.5-397B-A17B-FP8/blob/ea5b4f81096f3901c91dea97f81324302495781d/config.json) · [官方权重索引](https://huggingface.co/Qwen/Qwen3.5-397B-A17B-FP8/blob/ea5b4f81096f3901c91dea97f81324302495781d/model.safetensors.index.json)

- 「官方 FP8 权重」沿用 BF16 矩阵算力。「FP8 执行」对这些投影使用 E4M3FN 矩阵乘法和 FP32 累加。每个输入行沿收缩维每 128 个值生成一个动态 FP32 缩放。设逐卡分配的输入、输出元素数为 `N`、`O`，收缩宽度为 `F`，转换近似为 `6N + (N/F) ceil(F/128)` 次向量操作，块缩放及累加近似为 `3O ceil(F/128)` 次向量操作。该理论预设把中间量保留在片上。输出、通信和 BF16 KV 使用各自声明的格式。设备缺少对应 FP8 算力时，显存和算量仍可计算。 [vLLM 动态分组缩放](https://docs.vllm.ai/en/v0.15.0/api/vllm/model_executor/layers/quantization/utils/quant_utils/#vllm.model_executor.layers.quantization.utils.quant_utils.kDynamic128Scale)

`npm run reference:qwen-hybrid` 核对三份发布配置、FP8 结构摘要及 103 份内置资产。FP8 摘要根据完整索引统计各类张量，并用五个分片的头部抽查 dtype、缩放网格与矩阵形状。Git 保存配置和摘要。数值测试独立核对权重、缓存、实际 Decode 步骤和逐卡成本。 [精简 FP8 元数据](../references/models/qwen-hybrid/qwen35-fp8-weight-manifest.json)

固定来源包括 [397B 发布配置](https://huggingface.co/Qwen/Qwen3.5-397B-A17B/blob/6fe6a3a85cefe43a807df708dccc4e44b02e2955/config.json)、[27B 发布配置](https://huggingface.co/Qwen/Qwen3.8-27B/blob/72a217afab8029b39e4af1c7273a829995a3dbaf/config.json)与 Transformers v5.8.0 的 [MoE 实现](https://github.com/huggingface/transformers/blob/049d2bf1220747b6d39e2a978b9f5fe0defa1dca/src/transformers/models/qwen3_5_moe/modeling_qwen3_5_moe.py)和 [Dense 实现](https://github.com/huggingface/transformers/blob/049d2bf1220747b6d39e2a978b9f5fe0defa1dca/src/transformers/models/qwen3_5/modeling_qwen3_5.py)。

## GLM-5.2

内置 GLM-5.2 预设包含发布配置的 78 层主文本解码器。模型画布显示前三层 Dense、紧接的三层 MoE 索引复用，以及随后 18 组由一层重新索引、三层复用组成的周期。每次重算向后传递 TopK 行号。每层仍然各自写入 MLA 缓存。进入 Block 后可分别查看 DSA Indexer、Sparse MLA、残差连接、Routed Experts 和 Shared Expert。查询与 KV 投影在注意力模块外。

BF16 基线下，每层每 token 追加 512 维潜向量和 64 维旋转位置键。只在 21 个索引拥有层追加 128 维索引键。两者合计 `2 × (78 × (512 + 64) + 21 × 128) = 95,232 B` 每请求每 token。选中行号属于当前前向的激活。MoE 使用加偏置的 sigmoid 分数选出 8 个专家，以原始选中分数归一化并缩放 2.5，再加共享专家输出。

分析使用吸收 K/V 上投影的稀疏 MLA 理论路径。索引计算用 BF16 点积与 FP32 得分，注意力显式物化矩形分数块并区分因果有效计算与执行计算。设备上真实 FP8 索引封装、融合内核、多卡布局和 MTP 需要各自的配置。默认单张 A100 放不下主解码器，容量显示 `0 token / 请求`，仍可查看 BF16 理论成本。

r2 提供请求 DP、Attention TP、MoE EP／TP 及同池组合的理论估算。`npm run reference:glm52` 校对固定配置、索引中的层归属和 86 份内置资产。 [并行口径](PARALLEL_PRESETS.md#glm-52) · [GLM-5.2 配置](https://huggingface.co/zai-org/GLM-5.2/blob/cf457fa734ab149ffef225f80893eb38c6ff5cdc/config.json) · [权重索引](https://huggingface.co/zai-org/GLM-5.2/blob/cf457fa734ab149ffef225f80893eb38c6ff5cdc/model.safetensors.index.json) · [Transformers 模型实现](https://github.com/huggingface/transformers/blob/e0e7504bca2bfd1b85bb0eedb148f7b250226f06/src/transformers/models/glm_moe_dsa/modeling_glm_moe_dsa.py) · [vLLM 稀疏 MLA](https://github.com/vllm-project/vllm/blob/2cf0a6915ce544dc493a0990f2ea38d81601128a/vllm/v1/attention/backends/mla/flashmla_sparse.py)

r3 在「量化」提供「官方 FP8 权重」。发布权重覆盖 MLA、DSA 的 Q／K 投影以及 Dense、Routed Expert 和 Shared Expert 的矩阵，采用 E4M3 和每 128 × 128 块一个 FP32 逆缩放因子。索引器的权重投影和归一化参数、词嵌入、输出头与路由矩阵保留 BF16，路由偏置为 FP32。K／V 上投影共用发布文件的权重存储，理论读量按一次读取并按投影行数归属。计算类别和 KV 缓存采用 BF16 基线。仓库保存发布配置、索引摘要及四个 Safetensors 文件头的张量元数据。 [官方 FP8 配置](https://huggingface.co/zai-org/GLM-5.2-FP8/blob/f33c6dc501ee5a2c7e35155653b1b1abbc320951/config.json) · [官方 FP8 权重索引](https://huggingface.co/zai-org/GLM-5.2-FP8/blob/f33c6dc501ee5a2c7e35155653b1b1abbc320951/model.safetensors.index.json)

## Kimi-K3

内置 Kimi-K3 预设包含发布配置的 93 层主文本解码器，其中 69 层 Kimi Delta Attention、24 层 Gated MLA。画布按 12 层的 Attention Residuals 块组织，首块单独显示，中间 6 个同构块折叠为 `6 ×`，末块保留 9 层的实际排布。历史块归档与当前块累加值沿两条数据流传递。每个 Attention Residuals 节点使用同一 token 的历史块和当前块做深度 softmax，最终混合读取八个归档和末块的累加值。

Gated MLA 的 NoPE 路径直接使用额外的 64 个通道。吸收键和值的上投影后，每层每 token 保存 512 维潜向量和 64 维共享键，BF16 合计 **27,648 B／token／请求**。KDA 的 FP32 递推矩阵和 BF16 短卷积缓冲合计 **454,459,392 B／请求**，计入固定显存。跨层残差归档是本次前向的激活。首层使用 Dense SiTU-GLU；后续 92 层从 896 个窄专家中选择 16 个，并将归一化后的窄空间汇总投影回隐藏宽度，再加两个共享专家的输出。

原始权重配置采用 BF16 矩阵、FP32 递推状态、逐 token 的理论 KDA 算式和紧凑 MLA 缓存。默认单张 A100 的 KV 预算为 `0 token / 请求`，可查看理论成本和每 token 的缓存占用。

r2、r3 提供请求 DP、Attention TP、MoE EP／TP 及同池组合的理论估算。`npm run reference:kimi-k3` 校对发布配置的 SHA‑256 和 115 份内置资产。 [并行口径](PARALLEL_PRESETS.md#kimi-k3) · [Kimi-K3 发布配置](https://huggingface.co/moonshotai/Kimi-K3/blob/1f5d44f794ef598de7b6f529ef7923729b7e5408/config.json) · [主解码器实现](https://huggingface.co/moonshotai/Kimi-K3/blob/1f5d44f794ef598de7b6f529ef7923729b7e5408/modeling_kimi_linear.py) · [FLA 的有限下界门控](https://github.com/fla-org/flash-linear-attention/blob/479745d8a009a87fba4a4ab2440deede85b6e974/fla/ops/kda/gate.py) · [vLLM 混合缓存说明](https://vllm.ai/blog/2026-07-27-k3)

r3 可在画布「量化」中选择「官方 MXFP4 权重」。92 个 MoE 层的路由专家 gate、up 和 down 权重采用 E2M1，每字节打包两个权重，每组 32 个输入通道附带 1 B 的 E8M0 缩放因子。逐卡账本计入各卡分片及对应的缩放因子，稀疏 HBM 读取按该卡被选中的专家矩阵计量。矩阵执行沿用 BF16 理论口径。 [NVIDIA 的 Kimi-K3 权重转换说明](https://github.com/NVIDIA/Model-Optimizer/tree/main/examples/kimi)

## 目标型号来源

列表用于核对型号身份和后续建模来源。可计算的预设以已有固定资产及该型号的验收记录为准。

| 家族 | 发布者的型号资料 |
| --- | --- |
| DeepSeek | [V3](https://huggingface.co/deepseek-ai/DeepSeek-V3)、[R1](https://huggingface.co/deepseek-ai/DeepSeek-R1)、[V4-Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash)、[V4.1-Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash) |
| GLM | [GLM-5.2](https://huggingface.co/zai-org/GLM-5.2) |
| Kimi | [Kimi-K3](https://huggingface.co/moonshotai/Kimi-K3) |
| Qwen | [Qwen3.5-397B-A17B](https://huggingface.co/Qwen/Qwen3.5-397B-A17B)、[Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B) |
