# 统一测量 CSV / JSON

检查点24实现P4统一测量文件路径，接收外部程序或人工整理的明确记录；本入口不解析profiler Trace，也不按显示名称推断节点或单位。检查点35另增[有限Chrome Trace入口](TRACE_IMPORT.md)，基于真实Kineto样本读取complete X事件、选择范围、规则/歧义和确认应用。检查点36另有[ROCm CSV](ROCM_CSV_IMPORT.md)明确纳秒字段/源设备队列路径；其他专有格式不自动识别。[固定来源硬件](HARDWARE_PROFILES.md)、[方案差异/整数交叉点](SCENARIO_COMPARISON.md)和[P4验收](P4_ACCEPTANCE.md)保留原基础闭环范围。

## 操作

1. 打开项目与方案，在“理论分析与测量比较”展开“统一测量 CSV / JSON 导入与导出”。可以先导入，也可以先计算理论结果。
2. 选择统一格式文件；解析成功后点击“预览测量匹配与指标”。此时尚未更改项目。文件最多 2 MiB UTF-8、1000 条，全部记录通过结构及时间/设备语义检查才接受。
3. 有 inputHash 且匹配当前输入、阶段、目标和实际设备范围的记录显示指标。缺少 hash 的记录保留“待确认输入”；确认当前输入后才会绑定并显示指标。未映射事件需明确选择模型、模块、叶节点或融合组后确认，显示名称不会自动转换为稳定 ID。
4. 历史 hash 保留，不自动改绑当前输入。阶段或设备范围不符时确认失败，不替换成当前值。可保留为待确认记录，或修正外部文件并使用明确的新 measurementId。
5. 同 ID、同内容记录跳过；不同内容显示冲突并阻止整批加入。可明确“为此记录创建新 ID”，原 ID 与原内容保留。只有本次导入文件名 importedFrom 不同不构成冲突，保留先前记录的来源。
6. 点击“加入项目（保留待确认记录）”一次合并本批记录，沿项目既有自动保存链提交；实际成功以项目“已保存 · 修订”状态为准。未匹配记录也可保存，不能据此生成利用率。

文件读取、预览和绑定期间支持取消；切换项目/方案、更改理论输入、结果或已有测量后旧预览失效。晚到读取/Worker/确认结果不能覆盖后来打开的内容。无理论结果时显示“待理论分析”，仍可明确保存原记录。

项目测量按最多 1000 条一批导出 JSON/CSV，保留 ID、时间口径、次数、输入 hash、原始来源与测量字节。结果区按最新顺序分页，每页 20 条，可查看全部记录，不再静默丢弃超过 20 条的比较。测量改变不会使纯理论结果失效。

## JSON 外壳

```json
{
  "documentType": "measurements",
  "schemaVersion": 1,
  "records": [
    {
      "measurementId": "external:run-1:model",
      "scenarioId": "example:scenario:c01",
      "target": {"kind": "model"},
      "phase": "decode",
      "deviceIds": ["gpu0"],
      "interval": "一次明确的模型调用",
      "count": 1,
      "time": {"kind": "single", "seconds": 5},
      "source": {"kind": "import", "file": "run-1.csv", "eventId": "model"}
    }
  ]
}
```

此例故意没有 inputHash：它可保存，但必须核对后绑定才能比较。records 使用同一 `MeasurementRecord`，严格拒绝额外字段、数字字符串、未来 schemaVersion、重复记录 ID/设备 ID、零或非有限时间、非法 span 以及不合法的次数。inputHash 存在时是原记录身份，不能仅因当前同名模型就认定匹配。

原 source.kind（manual/import/agent）、file、eventId 和 mappingBasis 保留。解码器把实际上传文件名记录在 source.importedFrom，明确区分本次导入文件和原记录的来源文件；它不是可执行路径，不读取该路径。没有来源声明的 CSV 默认 kind=import、file=上传文件名。

## CSV 扁平列

CSV 采用逗号分隔、UTF-8，可带 BOM，支持 CRLF/LF、引号内换行与双写引号。表头名称和枚举区分大小写；未知或重复列、错列数、未闭合引号、闭合引号后额外文字均拒绝，并给出物理行号。空行可忽略，非空坏行不会被静默跳过。

| 列 | 规则 |
| --- | --- |
| measurementId、scenarioId | 必需、非空、稳定身份；文件内 measurementId 不重复 |
| inputHash | 可空；不以当前输入自动补齐 |
| targetKind | 必需：model/module/node/unmapped |
| nodeId | module/node 必需，model/unmapped 必须空；使用完整稳定 ID |
| eventName、eventSource | unmapped 必需，其他目标必须空；保留原事件 |
| phase | 必需：prefill/decode |
| deviceIds | 必需，JSON 字符串数组；CSV 引号转义后例如 `"[""gpu0""]"`，不是逗号/分号拼接的模糊列表 |
| interval | 必需，对统计区间的明确说明 |
| count | 必需，正安全整数；single 必须为 1 |
| timeKind | 必需：single/mean/sum/span |
| seconds | single/mean/sum 必需；span 必须空；单位固定秒 |
| startSeconds、endSeconds | 仅 span，结束晚于开始；单位固定秒 |
| readBytes、writeBytes、bytesBasis | 全空或一起填写；非负 byte，basis 为 per_call/interval_total；仅在确实测得 HBM bytes 时填写 |
| sourceKind、sourceFile、eventId、mappingBasis | 可选原始来源；sourceKind 为 manual/import/agent |
| importedFrom | 导出时保留；读取时以实际上传文件名记录本次导入，不信任文件自己声明的导入位置 |

必需表头：measurementId、scenarioId、targetKind、phase、deviceIds、interval、count、timeKind。条件列需要时必须存在且填写。数值用普通十进制或科学计数法，不接受 `5 ms`、千分位、十六进制、NaN/Infinity 或下溢后伪装成零的数。更换单位必须先在外部显式转换。

## 时间与利用率

single 是一次调用，mean 是 count 次的每次均值；sum 是 count 次累计耗时；span 是明确区间的起止时间。mean×count 只是累计工作时间，不能自动宣称为多流端到端跨度。sum 和 span 除以 count 是每调用等价时间，不是其中某次调用的实测延迟。

actualBytes.basis=interval_total 时先除以次数；per_call 已是每调用字节。未声明 actualBytes 时只能用理论 HBM，并标为“估算 MBU”；缺少理论 HBM 也不补零。矩阵/向量等精度独立计算 MFU，使用一次模型有效工作与同范围实际参与设备的峰值能力。融合内部不可独立测量的数学步骤不接受单独绑定。超过 100% 保留原值并提示口径检查，不截断。

`npm run reference:measurements` 从实际 C01 分析器生成 `examples/measurements` 中七条 CSV/JSON、预览、确认后可移植项目、理论结果与独立摘要。人工 C01 为 1024 operations、448 B 理论 HBM；5 s 下 MFU=20.48%、估算 MBU=89.6%。mean=5 s/count2、sum=10 s/count2、span=[2,12] s/count2 都得到每调用等价 5 s；测得区间 768+128=896 B 后为 448 B/调用，measured MBU 也为 89.6%。这些是人工算术参考，不是 profiler 样本或实卡结果。

检查点24证据：`tests/measurement-import.test.ts`、`tests/integration/measurement-api.integration.ts`、`tests/e2e/measurement-import.spec.ts`。当时完整回归通过305项单元/契约、3项HTTP、44项Chrome；最终时间说明调整后的构建与3项导入Chrome再次通过。[预览截图](images/measurement-import.png)已检查，窄面板可直接查看确认操作。检查点35的真实Trace路径见[有限导入说明](TRACE_IMPORT.md)；专有格式、更多真实CSV和未支持的事件重建继续保留在P6范围内。
