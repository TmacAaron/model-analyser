# Ascend描述文件固定来源

此目录固定F09的真实来源；检查点44已实现[画布导入／精确映射](../../docs/ASCEND_QUANTIZATION_IMPORT.md)。原始文件保持不变，产品范围与辅助布局假设分开记载。

`qwen3-30b-a3b-w8a8` 保留发布者 [vllm-ascend/Qwen3-30B-A3B-W8A8](https://www.modelscope.cn/models/vllm-ascend/Qwen3-30B-A3B-W8A8) 的真实完整描述文件、config和原始README，固定Git提交 `87e5d6cda41c04ba8e2850933e2d7815c4475514`。每个文件的原始长度、SHA256、下载范围与限制见[source.json](qwen3-30b-a3b-w8a8/source.json)。文件内容未改写；上游README声明Apache License 2.0。

只取得这三个元数据文件，没有下载权重张量。索引JSON在上游使用LFS，其实际内容与safetensors头尚未取得。

描述文件4,218,198字节、56,888项，包含逐项FLOAT、W8A8和W8A8_DYNAMIC标签。总体W8A8不等于每个条目都使用同一格式。`kv_quant_type`、`fa_quant_type` 为null，`group_size`为0；其具体含义仍须结合固定版本导出实现核对。描述标签不足以确定辅助张量的dtype、shape或真实计算/累加精度。

这是48层、128专家的`qwen3_moe`公开产物，不代表现有Dense Qwen模板已适配该完整模型。导入保留未知专家/元数据并明确范围，不能把名称相似当成模型兼容证明。完整F09条件见[调查与边界](../../docs/ASCEND_QUANTIZATION_RESEARCH.md)。
