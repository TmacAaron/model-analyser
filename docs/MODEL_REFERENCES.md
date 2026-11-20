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
