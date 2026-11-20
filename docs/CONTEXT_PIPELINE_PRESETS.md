# PCP、DCP、PP 快捷预设

检查点40，2026-11-15。新增三个模型根及实际快捷入口，沿用[声明式设备绑定](NAMED_PARALLEL_PRESETS.md)的预览→应用→保存→重开流程。至此，原F03列出的TP、DP、EP、SP、PCP、DCP、PP均有说明实际语义的快捷方案；支持范围由具体固定模型声明，完整项目仍按[剩余项](REMAINING_PRD.md)推进。

## 操作和固定范围

| 模型 ID | base 项目（未应用布局） | 已应用可移植项目 | 阶段和布局 |
| --- | --- | --- | --- |
| `builtin:model:parallel-pcp2` | [PCP2 base](../examples/context-pipeline/pcp2-base.json) | [PCP2 项目](../examples/context-pipeline/pcp2-project.json) | prefill；两卡连续均匀切分查询，KV完整复制 |
| `builtin:model:parallel-dcp2` | [DCP2 base](../examples/context-pipeline/dcp2-base.json) | [DCP2 项目](../examples/context-pipeline/dcp2-project.json) | decode；两卡固定KV序列槽位，Q和权重复制 |
| `builtin:model:parallel-pp2` | [PP2 base](../examples/context-pipeline/pp2-base.json) | [PP2 项目](../examples/context-pipeline/pp2-project.json) | prefill/decode；两个独立attention/residual阶段、一个microbatch |

导入base项目后，打开“并行预设与物理设备”，选择`physical-pool`，填写网络1000 bytes/s、单轮延迟0.001秒，预览后应用并计算。也可从普通“新增方案”选择内置模型和硬件，添加第二个真实设备并建立设备组。模型参数、各阶段局部方程、布局、通信和其他覆盖均通过原有表单/高级项目JSON编辑与自动保存。

三模板都要求恰好两张所选实际设备；模板槽位按组成员顺序绑定，多个角色不会增加卡数。PP的world组复用stage0/stage1两张实际卡；每个阶段只在自己的单卡子组运行。预览显示真实SendRecv发送/接收设备、完整payload，以及各卡权重/状态分配合计。合计不是生命周期峰值。

所有参考使用人工硬件。PCP/DCP是显式Q/K/V投影与attention子图；PP由两个完整合成GQA attention/residual子图组成，均未声称完整语言模型、实际内核或实卡性能。PP是单microbatch串行基线，没有把阶段数作为加速系数，也没有推断稳定流水吞吐。

## PCP2：查询位置和因果前缀

PCP把当前Q个查询/投影输出沿query轴均匀切分，K/V当前块各执行一次AllGather，随后每卡写入完整KV缓存。attention仍按各卡查询片计算，完整历史和当前因果前缀均可见，输出保留查询分片。

每卡查询数为q，真实全局起点为a，历史长度为C。该片的有效query-key对数为：

`q * (C + a) + q * (q + 1) / 2`

矩阵QK/AV各为`2 * B * H * pairs * D`，softmax向量代理为`5 * B * H * pairs`；执行量采用物化矩形`q * (C+Q)`。默认Q=4时，两卡起点0/2、有效对数3/7，QK有效工作分别24/56，不能把尾片重新当作从0开始的查询。

新增通用局部绑定`LocalCostSource.kind=tensor_slice`，读取实际分布的连续切片`start/end`。模块展开时与tensor_axis一样映射真实轴身份；求值和结果校验都核对真实设备切片。没有坐标的manual布局不能被猜成起点0。原有tensor_axis仍用于逻辑/分配尺寸。

默认B=1、Q=4、C=0、H=2、D=2、M=8。Q必须整除2，C+Q不能超过M。此方案使用连续片，明确没有实现head-tail负载均衡或paged cache。KV按当前C+Q在每卡完整驻留。

每次AllGather的发送payload是本卡16 B tile，接收payload表示完整32 B结果buffer，包含本卡已有tile；它们不是两边链路远程字节数的守恒账本。远程算法发送量单独按`tile * (P−1)`计算，默认16 B，耗时据此加一轮延迟。相关本地复制/HBM仍需单独声明。

## DCP2：固定KV槽位和稳定softmax归约

DCP沿序列维把固定容量M的KV缓存分成两段，每卡拥有M/2个固定槽位。当前有效前缀为C+1；只有当前token所属卡写入对应K/V槽位。C增长不改变槽位归属，不会隐式搬迁历史KV。Q、权重及当前投影复制，并按每张卡的实际工作计费。

每步只接受一个query token，M必须整除2且C+1≤M。有效键数来自当前前缀与本卡切片的交集，执行矩形与缓存读写仍按明确声明的固定槽位计费。因此默认参考在C=0与C=5的时间相同、有效工作不同，是固定容量物化假设的结果。

稳定softmax图按以下顺序展开：

1. 对本地有效scores求最大值；空片贡献负无穷。
2. `AllReduce(max)`得到全局m。
3. 本地计算`exp(score-m)`；无效槽位为0，分别形成FP32分母与未归一化加权值分子。
4. 对分母、分子分别`AllReduce(sum)`，再做全局分子/分母。

这三次归约使用FP32 payload：默认8 B、8 B、16 B；声明ring系数`2(P−1)/P`、`2(P−1)`轮。没有直接相加各片独立归一化的attention输出。独立数值见证使用大幅偏移的scores、空分片及相差很大的分片softmax质量，验证全局结果和稠密稳定softmax一致。

默认B=1、Q=1、C=5、H=2、D=2、M=8；KV每卡64 B，单卡同容量基线128 B。使用固定连续槽位是本项目明确的数学选择，未声称复现发布框架的交错/paged缓存。超过M时报告模型域错误，不能当成物理OOM或自动迁移；需要扩容时显式修改M。

## PP2：阶段驻留和完整激活传输

stage0和stage1各使用一个新固定模块包装原GQA attention/residual图，复用原公式，不修改原GQA资产修订。每阶段包含Q/K/V投影、KV append、因果QK、物化softmax、AV、输出投影与残差；不包含MLP、norm、RoPE、embedding或LM head。

每阶段的权重和KV分别驻留在其真实设备。边界B0/B1用明确manual布局表示拥有者，另一卡token行数为0；SendRecv只从stage0发送到stage1。默认BF16激活为`2 * B * Q * H=16 B`，不除以PP大小。局部投影按本阶段权重分配参与，避免把零行的非拥有卡当作额外执行设备。

默认B=1、Q=1、C=2、hidden=8、NH=4、NK=2、D=2。每阶段848 B已知叶HBM、8.48秒；一次网络传输0.017秒，模型共16.977秒，每卡峰值544 B。两步decode在C=2/3分别求值，总35.554秒、序列峰值592 B/卡；两个阶段的KV状态身份和版本分别保存。

## 独立账本和容量

| 默认参考 | 通信 | 权重 B/卡 | 状态 B/卡 | 已知叶HBM B/卡 | 峰值 B/卡 | 串行跨度 s | 明确检查范围内最大Batch |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: |
| PCP2 | 2×AllGather | 96 | 64 | 736 / 736 | 320 | 7.394 | 17，4096 B容量 |
| DCP2 | max、分母sum、分子sum | 96 | 64 | 456 / 472 | 216 | 4.758 | 33，4096 B容量 |
| PP2 | 1×SendRecv | 384 | 48 | 848 / 848 | 544 | 16.977 | 4，1024 B容量 |

默认两卡batch峰值分别为`96+224B`、`96+120B`、`384+160B`，独立检查最大值前后各一个整数。所有网络仅计声明的传输：未给出的通信本地HBM、归约算术、staging与转换不补零。因此表中HBM是已知叶成本，完整HBM合计保持unavailable。

[参考账本](../examples/context-pipeline/reference.json)包含八个case：三个默认、PCP历史/较大batch、DCP空有效片/三步增长、PP prefill/两步增长。PP较大prefill例峰值1376 B超过人工1024 B容量，保持exceeded结论。账本代码`context-pipeline-oracle.ts`只做独立标量运算，不读取引擎、图或资产；另有PCP/DCP单卡基线11.84/6.8秒，峰值480/328 B。

账本的`allocationsByStep`和`communicationsByStep`记录每次实际调用，连同各自inputHash；每次权重/状态分配再次对照独立oracle。默认三份容量证明通过`defaultWorkloadCapacity`绑定到默认workload，其他case不继承其标签。五份其他workload项目使用独立项目/方案ID，可同时导入。DCP三步的通信总次数为9，PP两步为2。

来源概念固定到[vLLM Ascend context设计](https://raw.githubusercontent.com/vllm-project/vllm-ascend/4b3bd7ebe51094f3afa5288bb7a3316d12d3154e/docs/source/developer_guide/Design_Documents/context_parallel.md)及[PP设计](https://raw.githubusercontent.com/vllm-project/vllm-ascend/4b3bd7ebe51094f3afa5288bb7a3316d12d3154e/docs/source/user_guide/feature_guide/pipeline_parallel.md)，commit和两份SHA见[source lock](../references/parallel/context-pipeline-source-lock.json)。只据此确认查询/KV/阶段分片及稳定partial-merge概念；具体连续切片、固定容量、三次归约、人工速率与向量代理均是本项目显式作者选择，不受某框架当前是否支持该组合限制。

## 发布与验证

`npm run reference:context-pipeline`核对两份固定来源SHA、八case手算与整数容量边界，再检查全部固定资产身份后发布。闭包79份资产，其中29份复用已有固定资产，新增50个head；当前内置578head/581JSON。三份base、三份已应用项目、五份其他workload项目、三份容量证明与参考账本都可从上述目录查阅。

发布时按完整assetId/revision寻找旧文件并核对内容，新路径使用完整ID哈希；先校验整个待发布集合，不因命名冲突覆盖其他资产。发布中断可重跑，不承诺跨文件事务。

13个领域测试覆盖独立work/HBM/峰值/time/容量、真实因果起点和伪造证据拒绝、稳定softmax数值见证、空片、固定槽位跨步、阶段权重/KV/传输、快照重开及错误阶段/度数/整除/切片坐标/归约/发送端点拒绝。4个新Chrome场景完成三个预设的预览/应用/计算/导出/离线快照复算/重开、自定义轴前缀恢复、DCP三步和普通PP新建，原7个并行Chrome也通过。

首次完整Chrome运行中，GLM硬件导入和用户模型第二次提交各发生一次5秒提交等待超时，其余95个场景通过。定位到资产提交反复全工作区扫描，读取全部项目快照/归档索引。修订读取现只取同一套新鲜资产闭包，提交内复用该快照，发布head前仍重新验证；显式完整扫描继续保留项目/草稿/坏文件诊断。没有持久缓存旧修订或改变回执/原子发布顺序。新测试验证闭包一致、外部文件更新可见和完整扫描诊断；持久化13项及两个失败文件的6个Chrome场景通过；完整门禁重新运行退出0：458单元/契约、3HTTP、97Chrome、架构/严格编译、Schema/正反、构建、全部型号/成本账本、七研究与两条真实文件复算通过。最终八case元数据也已按每次调用独立核对并重新生成，严格编译通过。一次当前工作区观测中修订读取约488→163 ms，数值不是通用性能保证。

完整组合门禁：`npm run acceptance:context-pipeline`，包含本次参考和全部原`acceptance:parallel`链。引擎更新为`0.1.0-execution.14`，契约193根/84联合/216分支/206非法判别值；全局验收状态以[验收记录](ACCEPTANCE_STATUS.md)为准。

已检查真实Chrome预览：[PCP2](images/context-pcp2-preview.png)、[DCP2](images/context-dcp2-preview.png)、[PP2](images/context-pp2-preview.png)，以及[DCP逐步结果](images/context-dcp-growing.png)。
