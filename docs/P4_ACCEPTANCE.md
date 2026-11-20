# P4 理论耗时、Roofline、测量与比较核验

状态：检查点27（2026-11-14）逐项验收通过。最终完整acceptance:p4退出0：331项单元/契约、3项真实HTTP、55项Chrome，架构/严格编译、Schema/全部联合正反、独立参考与构建通过。按原[实施计划](IMPLEMENTATION_PLAN.md) P4、PRD F06–F08/F10 与 V0.1 退出条件逐项对照。P5/P6原研究与适配条件保留。

## 原 P4 工作项

| 原工作项 | 当前实现及权威证据 |
| --- | --- |
| 硬件算力/带宽/通信可编辑 | HardwareDefinition及硬件草稿表单，`tests/hardware.test.ts`、`tests/e2e/hardware.spec.ts`；正式值、空值草稿、恢复、内置副本及固定项目修订分别验证 |
| 首批核对来源，未知值留空或假设 | A100/H100官方固定PDF、型号列、dense精度、SI单位、页码和SHA256；`references/hardware/source-lock.json`、`reference:hardware`、[硬件说明](HARDWARE_PROFILES.md)；没有拿NVLink总速率冒充collective有效速率 |
| 节点公式/效率串行基线及有效参数估算 | `cost-primitives.test.ts`、`analyze.test.ts`、`streams.test.ts`；peak与effective、计算/带宽效率、理想/串行重叠、固定/公式/直接覆盖，缺能力不补值；新屋顶研究独立保留硬件与有效参数 |
| 明确payload、延迟与算法系数 | `distribution.test.ts`、`serial-execution.test.ts`、`native-collective.test.ts`；完整消息、实际网络流量、启动轮数和分组/物理设备分别求值，不拟合拥塞或虚构通信HBM |
| batch/长度扫描、精度Roofline和方案交叉 | 既有`capacity.test.ts`与GQA batch/context参考；`roofline-study.test.ts`的节点/模块/模型、明确decode步骤、4与2 op/B屋顶、相等/侧改变/多个/无事件/缺项/取消；`scenario-comparison.test.ts`的成对整数时间交叉、范围容量、逻辑/物理工作；Chrome两类研究流程 |
| 手工及统一CSV/JSON测量，范围/次数校验 | `measurement.test.ts`、`measurement-import.test.ts`与真实HTTP/Chrome导入；single/mean/sum/span、秒/byte/调用、目标/phase/设备/hash、待映射/历史与冲突保留，见[统一测量](MEASUREMENT_IMPORT.md) |
| 匹配MFU/MBU，理论bytes标估算 | `measurement.test.ts`、`distributed-analysis.test.ts`及`reference:measurements`；有效与执行工作分开、每精度峰值/参与设备范围、真实/估算bytes、融合独立性；缺失通信HBM保持MBU不可用，超过100%不裁剪 |
| 方案复制、结果表/差异和项目导入导出 | `project.test.ts`、`tests/e2e/projects.spec.ts`、`scenario-comparison.spec.ts`；同项目2–4方案、稳定模块对齐、计算输入JSON Pointer差异、SI CSV/完整JSON、重开/快照固定与源变化失效 |

## F06–F08 与 F10 的具体边界

F06依赖与流顺序、重叠/同步/共享资源、串行基线和显存由原P3及已实现研究基础核心及`streams.test.ts`、`decode.test.ts`、`serial-execution.test.ts`复核。它是明确假设的确定性估算，不是指令级仿真或最佳流搜索。

F07不由模型总时间生成子模块实测；融合内部成员的独立时间被拒绝，MFU/MBU按实际目标设备匹配。测量变化不使纯理论hash漂移，计算输入变化使旧测量stale；已有独立`inputHash/measurementHash`及导入重开测试覆盖。

F08现在具备节点/模块/模型的分精度点，独立硬件声明/用户有效屋顶，以及可复算整数拐点。池化提示异构/局部瓶颈，logical代理明确区别于完整HBM；多步decode选步骤。通信以累计节点成本占比和绝对区间并集覆盖展示，缺项不出完整百分比；`execution-shares.test.ts`独立核对0.018/4.818和重叠50%成本/80%覆盖。通信时刻仍在原时间线，不挤进单一HBM屋顶。

F10的差异与结果变化并列，不自动生成因果/优化建议；点击已有成本来源可查看固定公式、参数、单位、覆盖及假设。不同精度、物理执行与模型有效工作不相加混用。相邻整数排序改变不是连续精确交点，未知或范围外不下结论，见[方案比较](SCENARIO_COMPARISON.md)和[Roofline研究](ROOFLINE_STUDY.md)。

## V0.1 全流程退出条件

原计划：用户可独立添加资产、选择并行/量化、计算并对照手工时间，不需要采集端。

`tests/e2e/v01-workflow.spec.ts`使用真实Chrome与本地HTTP，仅通过界面写入：

1. 发布新的用户模型、人工硬件、量化资产。模型是明确来源的合成GQA attention/residual子图，引用已有固定基础定义；不是新生产模型适配。完全从零创建模块/模型/公式另由P2的`graph-editor.spec.ts`和`dependency-upgrade.spec.ts`逐条覆盖。
2. 新建项目并选择这些资产，设置上下文2，添加第二物理设备和一维组，预览/应用TP heads及明确网络参数1000 B/s、0.001 s。
3. 得到独立原GQA的4.818 s、每卡280 B；选择新用户W4覆盖后容量下降，计算仍为BF16，模型有效矩阵仍480 operations。转换、通信HBM等未声明项保持原边界。
4. 录入人工10 s，对照矩阵MFU `480/(10×2×1000)=2.4%`。它不是GPU测量；完整HBM缺项不变成有效MBU。
5. 复制方案，计算比较并导出完整项目。只用导出快照在纯core复算相同hash和MFU；重新打开本地项目后，方案、量化、测量与数值保持。

这条演示补充已有独立Dense/GQA与MoE/MLA代表模型、config草稿、结构/公式编辑、量化和持久化验收。它不宣称完整语言模型已自动支持TP，也不代替P5混合并行研究或P6真实Trace适配。

## 执行门禁

固定Node.js 24.22.3下运行 `npm run acceptance:p4`，组合全部P3/P2/P1/P0门禁、真实HTTP、完整Chrome、固定硬件、统一测量、方案比较及Roofline独立参考。最终日志checkpoint27-acceptance.log，退出码0；331项单元、3项HTTP、55项Chrome及全部独立参考通过。随后为人工变体分配独立资产/项目身份并核对来源，补强重复物理设备/资产身份拒绝；最终独立参考、331项单元、构建及5项研究/V0.1 Chrome再通过，见checkpoint27-unit-final.log、checkpoint27-build-final.log、checkpoint27-e2e-final.log。截图也已单独检查。约756kB主包的Vite提示仍在，构建成功。

结构契约新增独立研究报告，所有根与联合继续Zod/Ajv正反对照；原AnalysisResult数值算法未改，引擎仍为`0.1.0-execution.11`。研究报告以`roofline-study.1`独立记录新派生视图。

检查点51补主要指标直接来源和逐调用实际参数；完整手工测量输入、比较等其余指标入口仍需按原PRD审计。 原阶段证据不替代[剩余项](REMAINING_PRD.md)的当前要求。

检查点52已补single／mean／sum／span、次数、单位、区间、精确设备、实测bytes和实际Decode调用的手工记录／比较；来源面板身份及融合选择修正后新的完整门禁591单元／7HTTP／152Chrome通过。其他指标入口、时间线与长路径仍按[剩余项](REMAINING_PRD.md)推进。
