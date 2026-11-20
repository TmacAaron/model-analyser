# P5复杂结构与研究能力核验

状态：检查点34（2026-11-15）按原P5工作项与V0.2逐项验收通过。完整acceptance:p5退出0：391单元/契约、3HTTP、76Chrome、架构/严格编译、Schema/结构正反、生产构建及七研究共同复算通过。依据原[实施计划](IMPLEMENTATION_PLAN.md)P5和[PRD](PRD.md)的研究阶段条件，区分固定来源事实、作者数学/物化/硬件假设与实际可验证范围。P6真实文件、更多预设及原PRD尚未覆盖的具名快捷入口仍须完成，不由本阶段签收替代。

## 原工作项

| 原P5工作项 | 当前实现与可检查证据 |
| --- | --- |
| 模块级SP/TP/EP、attention前后A2A、不同范围设备组复用 | [Ulysses](ULYSSES_RESEARCH.md)完整SP→head→SP，三次Q/K/V及返回A2A；[MoE](MOE_RESEARCH.md)SP packet、EP owner、expert TP、逆交换与合并。实际设备别名不新增物理卡；`ulysses.test.ts`、`moe-research.test.ts`、`distribution.test.ts`、图内collective及两套Chrome核对shape、缺失变换/不整除拒绝和逐rank负载 |
| 流内顺序、跨流依赖/同步、简单多流时间线 | `streams.test.ts`与Chrome含同步、依赖、错误/修复、user_efficiency；三研究的ideal/共享资源沿同一执行核心。单卡和多设备时间线支持按批展开，输入变化失效；不自动搜索流划分 |
| 时间线决定存活峰值，展示收益和额外buffer | Ulysses源/目标独立buffer、MoE packet/metadata、CSA2源索引最后使用及部分候选、KDA新矩阵/旧新conv tuple、prefill FP32概率与chunk coefficient/history均为正式storage。oracle独立枚举出生/最后读取与同时workspace，Chrome显示分类峰值；不把memory saving机械等同time saving |
| 共享资源折减/带宽共享、未知争用标理想 | C05及Ulysses/MoE/CSA2的serial/ideal/shared/user_efficiency有独立数值；HBM共享按声明资源连续服务，用户效率保留负收益；网络与未声明SM/cache争用不捏造。`streams.test.ts`、`csa2.test.ts`与原始JSON |
| 混合attention、滑窗、DSA/indexer、KDA/递归、序列压缩预设 | [DSA](DSA_RESEARCH.md)主KV/PE、FP8 key/FP32 scale、全前缀scan与Top-K、源码mask/显式gather理论分开；[压缩](COMPRESSION_RESEARCH.md)ratio1/2、完整组/部分组、双FP32尾部和独立window；[KDA decode](KDA_RESEARCH.md)三conv/矩阵与expanded MLA；[prefill](KDA_PREFILL_RESEARCH.md)Q2..64递归、Q65..256 chunk及dense causal MLA。F04要求的阶段不同公式已分别建模，不用decode×Q冒充prefill |
| 跨层KV、indexer、索引结果等独立共享关系 | [CSA2](CSA2_REUSE_RESEARCH.md)主KV四reader、indexer K两reader、四window独立，Top-K/候选为前向activation；正式StateSpec/stateBindings/数据边将创建、读取和存活分开。`state-models.test.ts`、`csa2.test.ts`及Chrome；不因同名跨请求去重 |
| V4.1 Flash来源片段逐项核对，不用统一比例 | 固定model/config提交与SHA的Full/Reuse/Reindex/Reuse四片段，比较独立、只共享cache、完整共享、三流、HBM、BF16。省创建、缓存和索引的角色不同，仍保留多次gather/attention读取及格式转换。来源锁、`csa2-oracle.ts`和三Chrome可复核 |
| 分段/取整及递归容量、非单调时有界扫描 | 既有`searchCapacity`逐整数最多512候选，缺项/取消不假造极值。压缩完成组workspace使fits/exceeds交替，serial/ideal区间边界646/650；MoE不整除缺口unknown；KDA finite state与增长MLA分开，prefill chunk边界有单独公式。各容量原始点/hash/diagnostics与独立账本及Chrome |

## V0.2与三个退出案例

原V0.2三项分别由模块级SP/TP/EP与执行/峰值证据、DSA/KDA/压缩/CSA2具体资产及混合prefill/decode、完整有界容量/差异/来源UI证明。三个原案例的逐项映射见[P5研究清单](P5_RESEARCH_CASES.md)，不是把七套补充研究的数量当作退出条件。

| 案例 | 固定可复算结果与边界 |
| --- | --- |
| Ulysses布局交换 | 单卡11.2s/448B、两卡6.276s/288B，四次A2A；每卡完整权重保留，通信self/远端和source/destination buffer分开；批次容量12/24 |
| MoE混合并行 | EP-only34.363s/672B、mixed21.525s/392B、ideal12.267s；逐rank远端20/40/40/20B，最慢rank；所有专家驻留与本批触及分开，批次14/23 |
| 多流与状态复用 | 四层独立87.72s/3862B、完整CSA2 62.18s/2242B、ideal49.44s、HBM共享回62.18s；六持久状态、前向Top-K/候选，三步最坏2272B；共享batch5对独立1 |

均为声明硬件/维度和完整所选片段下的理论值，不是实卡benchmark或整个语言模型。所有项目含固定依赖、可导出并在空库纯core复算，Chrome核对编辑、错误与修复、策略/容量/比较及重开。数值账本不调用core、生成器或公式解析器，避免用被测实现给自己生成期望值。

## 组合门禁与支持边界

`npm run acceptance:p5`按顺序执行完整P4/P3/P2/P1/P0门禁，再运行七套`reference:research`。包括架构/严格编译、契约正反、全部单元、真实HTTP、生产构建、完整Chrome及原始结果/独立算术。checkpoint34-acceptance.log退出0，Chrome9.6分钟；全部391/3/76及七研究断言在同一组合门禁通过。结构清单182根/83联合/213分支/203非法判别值，core引擎仍为0.1.0-execution.12。当前421内置head/424JSON修订；数据资产和研究脚本不引入品牌算法分支。

支持的是各预设明确声明的phase、尺寸、精度与作者物化/资源模型。短prefill Q2..64、chunk Q65..256、C0；decode Q1。预留/packed/inplace为不同假设，超容量点不成为运行建议；不补缺少的通信HBM/归约、allocator、未声明cache/SM争用、varlen、训练或source kernel channel tiling。KDA source的原子分配是保守模型，不能当作Python allocator实测峰值。具体型号、硬件、Trace/CSV映射与外部转换继续按P6和原PRD整体核验，P5通过不代表总目标完成。

原F03的PCP/DCP/PP等具名快捷入口仍未在当前代码生成器中实现；高级JSON可表达的边界不等于这些快捷预设已交付。SP/EP的研究项目已证明布局/通信能力，更多快捷入口与模型预设进入后续扩充清单。不得因本表研究退出条件成立而遗漏原始需求。
