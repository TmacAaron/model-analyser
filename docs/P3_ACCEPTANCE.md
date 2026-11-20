# P3 静态成本、并行、量化与显存核验

状态：检查点 23（2026-11-14）**逐项验收通过**。完整 `acceptance:p3` 在最终来源面板代码上通过：297 项单元/契约、2 项真实 HTTP、41 项 Chrome、架构/严格编译、Schema/样例、独立参考与生产构建。原自动审批连接故障及浏览器访问拒绝在用户重新设置权限后恢复；内置浏览器也已验证预设应用、数值与跨重开。P4–P6 继续按原退出条件实施。

## 原工作项逐项对照

| 原实施计划 P3 工作项 | 当前实现与证据 |
| --- | --- |
| 分片、复制、物理映射及常用通信生成 | `distribution.test.ts`、`parallel-plan.test.ts`、`parallel-presets.test.ts`；四种作者声明 GQA 预设使用实际设备组，TP 自动生成 partial→AllReduce→replicated 边界；三个预设 Chrome 场景验证预览/应用/跨重开/取消 |
| 模块范围、轴和手动通信高级配置 | `parallel-plan.test.ts`、`native-collective.test.ts`：subtree/nodes 范围、阶段、mesh、显式通信及原生图节点；高级 JSON 不猜复杂边界 |
| 局部/整体工作、读写、payload，有效/额外分开 | `local-cost.test.ts`、`analyze.test.ts`、`parallel-presets.test.ts`：局部方程、padding/副本工作；模块汇总有效叶节点，逻辑与物理工作分开；通信完整消息与算法流量分开 |
| 权重/激活/状态/通信位宽与辅助数据 | `cost-primitives.test.ts`、`quantization.test.ts`、`distribution.test.ts`：packing、group/block/channel/custom 辅助数据、每卡重新打包、显式 payloadDtype；W4A8 的存储变化不会自动改写计算精度 |
| 存储与计算精度分开，按运算类型保存 | ComputeClass、matrix/vector 与量化参考；`quantization.test.ts`、`real-models.test.ts`；缺少计算能力保留 unavailable |
| 静态生命周期、共享状态去重、临时量 | `serial-execution.test.ts`、`analyze.test.ts`、`state-models.test.ts`：最后使用、scratch 释放、alias/backing 去重、持久状态；共享存储仍多次计读取 |
| 固定/公式/张量推导开销 | StorageAllocation 的 bytes ValueExpr/tensor、CostDefinition 的 temporaries，`cost-primitives.test.ts`、`serial-execution.test.ts`；workspace/graph/communication_buffer/runtime_reserve/extra 按显式声明计量 |
| 每设备显存分解、限制及普通状态容量 | `capacity.test.ts`、`parallel-presets.test.ts`、`decode.test.ts`：整数有界扫描、最坏步骤峰值、限制设备、取整/缺项；新增 GQA 两种 TP 的 batch/context 边界 |
| 维度、归约、缺失通信及引用提示 | `contracts.test.ts`、`instantiate.test.ts`、`parallel-plan.test.ts`、`parallel-presets.test.ts`；非整除、未知 tensor/axis、partial 缺归约、未定位通信、缺 localCost 均拒绝或保留缺项 |

## 原退出条件的独立参考

GQA TP/复制的完整 attention/residual 子图与独立算术见 [并行说明](PARALLEL_PRESETS.md) 和 `examples/gqa/reference.json`。它是合成子图，不冒充包含 MLP 等部分的完整语言模型。

MoE 的驻留/激活由 `tests/real-models.test.ts` 小尺寸案例核对：718 参数、1436 B 权重、384 B 状态、5712 useful/6000 executed matrix operations；专家总量、TopK、batch 触及和负载假设独立，固定来源与具体变体见 [模型说明](MODEL_REFERENCES.md)。W4A8 辅助数据由 `reference:quantization` 和 `quantization.test.ts` 核对，单卡峰值/完整访问 172 B，两卡 120 B/卡；BF16 ComputeClass 不自动改成量化计算吞吐。

覆盖来源包括 `MetricValue.provenance`、ResolvedParameter.source、量化生效/被覆盖 indices、布局规则 indices 与项目显式 numericOverrides。“成本与覆盖来源”集中展示各结果范围的原始数量、单位、公式、资产/参数、假设、诊断及覆盖声明，支持每卡/通信/存储/逐步 decode；共用依赖与独立贡献的区别明确说明。`tests/e2e/cost-sources.spec.ts` 验证 72 B 分配、448 B 流量、2 s 耗时覆盖仍保持 1024 operations，峰值 264 B；原始表达式与作者说明可见，重开保持。存储覆盖先于依赖该存储的流量比例求解，次序不改变结果；融合替代成员执行，父/子不再次累加，见 `analyze.test.ts`、`quantization.test.ts`、`fusion.test.ts`。

## 已执行门禁与范围

- 已通过：固定 Node.js 24.22.3 的完整 `acceptance:p3`，组合 GQA 参考与 P2/P1/P0 门禁，包含 297 项单元/契约、2 项真实 HTTP、41 项 Chrome、架构/严格编译、Schema/样例/全部结构分支、独立参考与生产构建。最终日志为工作区 `acceptance-p3-final.log`。
- 当前结构清单：163 个 Schema/API 根、79 组联合、205 分支、195 个非法判别值。历史检查点计数保留。
- 预设/来源最终生产构建已通过；主包约 695 kB，>500 kB 提示仍存在。
- 预览与来源截图已检查，保存于 `docs/images`。内置浏览器在独立本机数据目录验证整池 KV 复制保存为 r2、5.938 s/368 B 与重开来源。

新增四项 Chrome 测试覆盖实际加设备→建立组→TP 预览/应用→KV 复制→重开；DP 非整除→修正 batch→无 collective；延迟依赖读取取消→不启动晚到 Worker→重新应用固定额外公式快照；成本来源/覆盖与独立数值。全部已在最终完整回归中执行通过。

本次签收限定于原 P3 静态成本闭环。快捷生成只适用于提供明确 recipe 与局部方程的模型；没有宣称所有并行名称或完整生产模型都已自动适配。通信本地 HBM/归约算术仍是明示缺项。P4 的硬件核对/方案差异/测量文件、P5 的混合并行研究、P6 的 Trace 样本继续保留原范围。
