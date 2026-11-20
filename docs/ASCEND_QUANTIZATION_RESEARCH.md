# Ascend量化描述：格式与固定来源核对

2026-11-15的F09格式调查。检查点44已实现[描述文件导入与精确存储映射](ASCEND_QUANTIZATION_IMPORT.md)，固定一份发布者的完整真实描述/config/README；未取得权重头或实际索引元数据，辅助布局必须明确声明。本文保留来源与推断边界，产品验收见操作说明。

已查到以下官方版本文档，可以作为后续格式边界的来源：

- [MindIE 2.2.RC1 W8A8](https://www.hiascend.com/document/detail/zh/mindie/22RC1/mindiellm/llmdev/mindie_llm0449.html)：给出描述JSON的局部示例，含总体类型、逐权重名称和量化标签，以及input_scale/input_offset/quant_bias/deq_scale。
- [MindIE KV Cache int8](https://www.hiascend.com/document/detail/en/mindie/310/LLMframe/llmdev/mindie_llm/user_guide/feature/kv_cache_int8.md)：描述另含kv_cache_type及KV辅助权重条目。
- [msModelSlim权重使用说明](https://www.hiascend.com/document/detail/en/mindstudio/2610/TITools/msModelSlim/docs/en/best_practices/quantization_weight_use_cases_in_acceleration_and_mindie_torch.md)：区分描述文件与实际safetensors权重，提供Linear名称对应关系。

由这些示例得到的实现约束（推断）：总体标签不能覆盖逐条FLOAT例外；名称出现scale/offset不等于已知其shape、dtype或分组数；FLOAT本身也不能确定FP16/BF16/FP32。适配须保留完整原文与未知条目，先固定实际公开产物和来源SHA，再预览已知模型的精确调用／存储映射。缺失辅助元数据和内部计算精度必须明确补充，不能仅凭W8A8名称给共享BF16残差或所有内核改精度。

验收范围按[剩余项F09](REMAINING_PRD.md)：固定真实样本、精确映射预览、用户确认、未知项保留、工作区往返与离线复算。上述官方片段只用于格式核对；现已另固定[真实公开样本](../references/ascend-quantization/README.md)：vllm-ascend的Qwen3-30B-A3B-W8A8，提交87e5d6cda41c04ba8e2850933e2d7815c4475514，完整描述4,218,198字节、56,888项及逐文件SHA256。它是MoE产物，不代表现有Dense模板已整模型适配。检查点44已用完整文件完成预览、精确字段／存储映射、明确确认、未知项保留和工作区重开／离线复算；只签收列明的模板路径与人工辅助规格，不扩大为整模型适配或真实权重头证明。
