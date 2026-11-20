# P0 契约与手算基线验收

状态：2026-11-14 检查点 19 首次通过；检查点 20、22、23、24 新增升级/config/并行/测量 DTO 后的合并门禁通过。检查点24另将重复Schema提取为标准引用，保留全部结构/语义校验。历史覆盖计数保留于实施记录，本页为当前计数。检查点25硬件分类唯一性及来源参考并入回归，结构计数不变。检查点26新增方案比较DTO及独立语义验证，合并门禁通过，当前结构计数同步如下。检查点27新增独立Roofline研究与语义验证，P4合并门禁通过，当前计数已同步。检查点28新增完整Ulysses研究并入回归，结构计数不变，算术、引用和边界语义继续独立核对。

本页按原始 P0 工作项和技术规范第 14 节逐项对应证据。P0 的范围是契约、样例、单位、独立算术与两个代表模型的固定来源；P1/P2 另行验收，不代表 P3–P6 的全部成本预设、研究案例或文件适配完成。

复核命令：在固定 Node.js 24.22.3 下运行 `npm run acceptance:p0`。该命令依次执行架构/严格编译、全部单元测试、Schema 与契约样例、联合分支、C03 分布、量化、C05 多流、状态及真实模型参考生成。浏览器另用 `npm run test:e2e` 验证应用路径。命令会重建对应生成文件。

## 技术规范第 14 节

| 条目 | 要证明的内容 | 当前权威证据 |
| --- | --- | --- |
| 1 | 每种资产/项目有效样例，关键联合每个分支有样例 | `examples/contracts/assets` 的七类资产与 project；`tests/result-contracts.test.ts` 验证引用/图/结果语义。`examples/contracts/union-coverage.json` 对所有导出 Schema、HTTP 响应结构及嵌套联合提供正反结构样例；`tests/contract-coverage.test.ts` 从当前 Zod 重新发现并对照，新增/删改/漏分支会失败 |
| 2 | JSON/YAML 归一化对象和 inputHash 一致 | `tests/contracts.test.ts` 的解析对照、重复键/危险标签拒绝；`tests/analyze.test.ts` 对完整 scenario/assets 的 YAML 转换和 Unicode 键序核对 hash；`tests/state-models.test.ts` 的混合 JSON/YAML 文件扫描后空库复算 |
| 3 | Zod 与导出 JSON Schema 代表性正反例一致，语义另测 | 当前清单 181 个 Schema/API 根、83 组不同联合、213 个分支及 203 个非法判别值均通过 Zod 与 Ajv Draft 2020-12（含标准 $defs/$ref）；`tests/contracts.test.ts`、`tests/result-contracts.test.ts` 另测非法字段/数字字符串/错误单位；图、分布、状态、结果算术与持久化使用各自独立测试 |
| 4 | 非法字段/判别值、引用、单位、环、溢出和公式有定位诊断 | `tests/contracts.test.ts`、`tests/formula.test.ts`、`tests/result-contracts.test.ts`、`tests/instantiate.test.ts`、`tests/cost-primitives.test.ts`、`tests/decode.test.ts` 覆盖未知字段、缺失/错误引用、数值范围/单位、数据/控制/引用/alias 环、NaN/Infinity/除零与安全整数边界；新状态案例断言具体失配/未初始化/参数诊断 |
| 5 | 存储共享不删除读取，设备组复用不增加卡数，partial 必须归约 | `tests/state-models.test.ts` 的跨模块 C04、理想/共享 HBM 并发读；`tests/distribution.test.ts`、`tests/parallel-plan.test.ts`、`tests/result-contracts.test.ts` 的物理组复用、alias 去重及 partial 边界/归约 |
| 6 | 草稿/修订/快照/冲突/失败恢复跨重启验证 | `tests/store.test.ts`、`tests/scan.test.ts`、`tests/project.test.ts`、`tests/project-persistence.test.ts` 覆盖基线/代次、未来/损坏文件隔离、幂等回执、发布前中断、较新草稿保留、旧快照与空库打开；检查点 20 新增的统一升级交互见 P1 验收 |
| 7 | core 无 UI/服务仍可独立复算手算 | `tests/cost-primitives.test.ts` C01/C02；`tests/distribution.test.ts` C03；`tests/state-models.test.ts` C04/递归状态；`tests/streams.test.ts` C05；`tests/real-models.test.ts` 的小尺寸 MoE、真实结构参数/KV 核对。core 架构检查拒绝 Node API 和 UI 依赖 |
| 8 | 新增已有语义的模块/公式/模型 JSON 可扫描使用，无需改 TS | `tests/state-models.test.ts` 将新模块/公式/模型作为普通 JSON/YAML 文件放进目录，重扫、按固定引用取快照，换空资产目录/重启后得到同一 5.28 s、128 B 结果。`tests/e2e/real-models.spec.ts` 从扫描到的内置模型直接新建无手写 B/Q/C 绑定方案 |
| 9 | Schema/样例通过后才称契约落地 | `packages/contracts/src/index.ts` 是类型来源，`scripts/export-schemas.ts` 只从 Zod 导出；真实执行门禁与各检查点记录对应。本页未把规划片段或 DTO 的存在当作高级运行能力 |

联合清单按实际 Zod 节点发现嵌套/匿名联合和 nullable，按结构指纹归并相同联合，保留来源位置。未知的新包装节点必须显式增加遍历规则，不能静默漏掉其分支。它是**结构覆盖清单**：其中的最小对象可能没有可解析引用或可执行图，不是模型/结果的语义有效样例。`z.json()` 接受任意 JSON，其反例明确编码为运行时 undefined 探针，不把无法序列化的值偷偷转成 null。全局语义证据是上表的完整资产、项目和独立算术测试。

## P0 工作项的独立输入与数值

| 手算案例 | 输入/固定预期 | 文件或命令 |
| --- | --- | --- |
| GEMM / C01 | M=4/N=8/K=16；1024 ops、384 read B、64 write B、4.48 s | `examples/contracts/hand-calculations.json`、`tests/cost-primitives.test.ts` |
| 量化 / C02 | 128/130 元素 W4：72 B、紧密 75 B、group32 padding 90 B，BF16 计算不自动改变 | `reference:quantization`、`tests/quantization.test.ts` |
| GQA KV / C03 | B=2/T=16/KVheads=2/D=4：总量 1024 B；两卡 head 分片 512 B/卡、复制 1024 B/卡 | `reference:distributed`；新增完整合成 attention/residual 子图见 `reference:gqa`，P3 交互及最终门禁已通过 |
| MoE/MLA 小尺寸 | 两层、H=4、8 routed/Top-2/1 shared、B=2/Q=3/C=1：718 参数、1436 weight B、384 state B、5712 useful / 6000 executed matrix ops | `tests/real-models.test.ts`、`reference:models` |
| 跨模块共享 / C04 | 每请求 64 B；两个模块读取。B=1：64 resident / 128 read B；B=3：192 resident / 384 read B | `reference:state`；串行 3.84 s，双流理想 1.92 s，声明 HBM 共享后 3.84 s，显存始终 192 B |
| 递归状态 | B=2/H=4：两份 BF16 H×H weight 共 64 B、state 16 B、input 16 B、投影 32 B；每调用 128 matrix ops + 16 vector proxy ops、176 HBM B、1.76 s | `reference:state`；三调用 5.28 s、峰值 128 B、状态 v0→v1→v2→v3；4096 B 设备下 `64+32B` 最大 batch=126 |
| 双分支 / C05 | prepare=1 ms、A=2 ms/2 GiB、B=5 ms/3 GiB、join=0.5 ms：串行 8.5 ms/3 GiB，理想双流 6.5 ms/5 GiB | `reference:streams`、`tests/streams.test.ts` |
| 快照与恢复 / C06 | 公式/模块/模型固定修订；更新库不漂移旧项目，持久回执和非法草稿跨重启保留 | `tests/project.test.ts`、`tests/project-persistence.test.ts`、`tests/store.test.ts`；统一升级交互已由检查点 20 的 P1 单独验收 |

Qwen3-0.6B 和 DeepSeek-V2-Lite 的具体提交、SHA256、本地资料、独立参数/KV 公式及未细化部分见 [模型来源说明](MODEL_REFERENCES.md)。仅其列明的理论变体通过，不宣称全系、真实内核精确流量或实卡性能。

TypeScript 的 strict/noUncheckedIndexedAccess/exactOptionalPropertyTypes 与分层依赖在 `tsconfig.json`、`scripts/check-architecture.ts` 中持续检查。SI 字节/秒、compute class、有效/执行工作、通信 payload、设备局部/组/模型有效汇总在契约与独立验证器中分别检查。受控公式仅使用 AST 解析和白名单函数，不执行传入脚本。固定运行时的版本与官方 SHA256 本地复核记录见 [RUNTIME.md](RUNTIME.md)。
