# SP/EP 具名快捷预设

检查点39，2026-11-15。新增三份固定子图模型，通过原有“并行预设与物理设备”入口生成、预览、应用并保存实际布局。原 GQA 的复制/DP/TP 简写保留。此增量交付 SP/EP 的明确范围；检查点40已另行交付[PCP2、DCP2、PP2](CONTEXT_PIPELINE_PRESETS.md)；本文保留SP/EP的具体范围。

## 使用

可以直接导入下表的 base 项目；它们只包含固定资产、工作负载和真实设备池，尚未应用布局。展开并行预设，选择 `physical-pool`，填写网络 1000 bytes/s、单轮延迟 0.001 s，预览后应用并计算。示例设备是人工参数，用于手算复核。

| 固定模型 | base 项目 | 完整可移植项目 | 所需实际设备 | 阶段 |
| --- | --- | --- | --- | --- |
| `builtin:model:parallel-sp2` | [SP2 base](../examples/named-parallel/sp2-base.json) | [SP2 已应用](../examples/named-parallel/sp2-project.json) | 2 | prefill，past=0 |
| `builtin:model:parallel-ep2` | [EP2 base](../examples/named-parallel/ep2-base.json) | [EP2 已应用](../examples/named-parallel/ep2-project.json) | 2 | prefill/decode |
| `builtin:model:parallel-ep2-tp2` | [EP2×TP2 base](../examples/named-parallel/ep2-tp2-base.json) | [EP2×TP2 已应用](../examples/named-parallel/ep2-tp2-project.json) | 4 | prefill/decode |

也可以从普通项目 UI 新建方案，选择上表模型及硬件，增加实际设备、建立设备组。默认方案为 decode；使用 SP2 时先切换 prefill，设置 Query tokens=4。MoE 默认手算 workload 为 Batch=1、Query tokens=4；decode Query=1 时需要实际可整除的 batch，例如 EP2×TP2 使用 Batch=4。

模型说明直接显示各子图范围。固定度数是作者图的一部分，选择错误的成员数量会拒绝，不能把 SP2 模板改名后当作 SP4。改变当前 workload 会重新求值分片、局部计算和通信消息；奇数序列或不可整除的 token/head/inner 维度不会向下取整。

## 真实设备与原生通信绑定

新增 `declared_plan` 作者模板：`deviceSlots` 列出逻辑设备槽位，`groups` 描述可复用的角色组与 mesh，`plan` 声明 tensor/storage 布局、额外通信和假设。它与旧式 tensorShards/reductions 简写互斥。

生成器按所选组的成员顺序，将槽位一一绑定到现有物理设备，不创建额外设备。组 ID 以所选池、轴前缀、角色名的 JSON tuple 编码，避免字符串拼接歧义；mesh 轴加用户填写的前缀。原有用户组保留，重新应用可替换上一份生成计划拥有的角色组。其他覆盖、融合和执行流保持输入声明，若与新布局冲突则预览失败。

保存的 `parallelPlan.nativeBindings` 明确记录组、mesh 轴、设备槽位和网络值。模型/模块的原生 collective 在各自参数 frame 展开时才应用绑定：

- tensor/node/storage 身份不改写；只映射布局组、mesh 轴、manual/explicit 切片中的设备、send_recv 端点及逐卡 payload 身份。
- 不修改同 ID/revision 的原资产；重复使用原研究模块和公式的字节内容，新增三份模型根来声明快捷模板。
- 带宽/延迟绑定仅可作用于 `bandwidth_latency`。fixed/custom_formula 通信模型不接受这种替换，节点显式覆盖仍沿既有优先级求值。
- native payload 公式继续使用当前 module/workload 参数；预览显示求值后的通信明细，保存的是动态图与绑定。
- 同一物理设备可在多个角色组出现。SP2 的 sequence/heads/exchange 都复用两张卡；EP2×TP2 的 world/grid 都是同四张卡，tp0/tp1 分别取两张，不能累加成更多卡。

预览统计全部实际通信，包括图中 collective，显示 operation、来源/目标布局、真实组、发送/接收字节、系数及轮数，逐卡非均匀声明可展开。分配表仍是全部声明对象的合计，生命周期峰值由应用后的分析单独计算。没有声明的通信 HBM、转换、归约算术保持未知。

## 手算与范围

SP2 复用[Ulysses 研究](ULYSSES_RESEARCH.md)的三段 MHA 子图：token 分片的投影 → 三次 Q/K/V AllToAll → head 分片的物化非因果 attention → 输出 AllToAll → token 分片的输出投影与残差。固定 `B=1,S=4,NH=2,D=2,C=0`。没有完整语言模型或 KV cache 增长语义。

EP 两模板复用[MoE 研究](MOE_RESEARCH.md)的固定平衡 top-2 路由、E=4、每 owner 常驻两专家。通信 packet 宽度为 `2H+12`，包含 BF16 activation、int64 专家索引与 FP32 probability；不凭实际 router 分数预测路由。局部 GEMM、向量代理、读写、归约前后布局和存储驻留沿原研究定义。decode 仅描述此 MoE 子图每步调用，不包含 attention/KV。

| 默认参考 | 物理卡 | 原生通信 | 权重 B/卡 | 已知叶 HBM B/卡 | 生命周期峰值 B/卡 | 串行跨度 s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| SP2 | 2 | 4×AllToAll | 128 | 624 | 288 | 6.276 |
| EP2 | 2 | 3×AllToAll | 416 | 1984 | 672 | 34.363 |
| EP2×TP2 | 4 | 3×AllToAll、2×AllGather、2×ReduceScatter | 224 | 1208 | 392 | 21.525 |

EP2×TP2 dispatch 的四槽位每卡发送 payload 都为40 B，但远程发送流量依次为20/40/40/20 B。此映射在设备名改成 rack/3、rack/1、rack/9、rack/2 后仍按槽位保持；不会按字典序重排或平均。网络时间采用最慢成员与组轮数，组通信时间不乘卡数。Batch 改为2后消息动态变为80 B/卡。

SP2 默认每个 AllToAll 发送16 B、远程8 B、1轮；1000 B/s 下每次0.009 s。改成2000 B/s而延迟不变，四次网络共0.020 s，总跨度6.260 s。所有合计的 HBM 仍因通信本地成本缺项而保持 unavailable；表中的624等数字是明确标注的已知叶合计。

数据与独立 oracle 位于[参考账本](../examples/named-parallel/reference.json)、`scripts/ulysses-oracle.ts`、`scripts/moe-oracle.ts`。来源继续使用原有固定 DeepSpeed/Megatron commit 与 SHA，见[Ulysses source lock](../references/parallel/ulysses-source-lock.json)和[MoE source lock](../references/parallel/moe-source-lock.json)；新快捷入口没有引入新的论文/内核性能声明。

## 验证入口

`npm run reference:named-parallel` 校验固定身份不变，发布79份依赖闭包资产，生成三份 base、三份已应用项目及参考账本。三份模型根均为新 ID，原研究项目身份保持不变。检查点39时内置528个 asset head、531份 JSON。

14个领域测试覆盖三份独立数值账本、原资产不变、真实成员/mesh/分片重映射、逐卡非均匀消息、动态 batch 和 decode、空闲设备不参与、重开/inputHash、重复应用、错误度数/阶段/整除/网络/局部方程/模板和绑定拒绝，以及 send_recv/explicit 切片字段映射。4个新增 Chrome 场景覆盖三个模板的预览→应用→计算→导出→离线快照复算→刷新重开，以及从内置 SP 模型新建方案、阶段/整除失败与旧预览失效。导出与重开也验证自定义 mesh 轴前缀恢复，不能只恢复计算值而显示默认 rank。原3个 DP/TP Chrome 场景也通过。

完整组合命令为 `npm run acceptance:parallel`，包含新账本与原 `acceptance:costs` 链；最终状态记录于[验收状态](ACCEPTANCE_STATUS.md)。引擎更新为 `0.1.0-execution.13`，契约193根/84联合/215分支/205非法判别值；旧输入不含绑定时计算规则保持原样。

实际 Chrome 预览截图已检查：[SP2](images/named-sp2-preview.png)、[EP2](images/named-ep2-preview.png)、[EP2×TP2](images/named-ep2-tp2-preview.png)。
