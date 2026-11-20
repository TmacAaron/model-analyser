# 正式项目文件的字节边界

检查点67补充独立验收证据，产品源码、计算算法和引擎.20相对66保持不变。恢复文件的独立容量规则见[恢复往返](RECOVERY_SIZE_BOUNDARY_AUDIT.md)；此处核对正式ProjectDocument本身。

正式项目按两空格JSON及末尾换行计算32 MiB存储限额。测试使用中文、emoji、反斜杠和换行组成说明文字，按原生JSON与UTF-8字节独立构造恰好33,554,432B的合法C01项目。它实际写入、重读后，界面导出省略末尾换行，得到33,554,431B，仍在普通源文件32 MiB限额内。浏览器刷新和新工作区身份重新导入后，完整项目值与资产快照保持，并能完成分析。另在没有资产库的独立FileStore中重新保存并从快照复算，完整结果一致；重新打开原FileStore后以原请求ID重放，修订与文件清单保持。

把项目名称增加一个ASCII字符，正式文件就超出1B。直接提交与原文草稿提交均明确拒绝，失败前后文件清单一致，没有修订2或提交回执；原正式文件SHA保持，失败草稿跨重开后仍完整保留。这里验证的是固定大小文件的完整保存／导出／重开与边界拒绝，不把说明文字当作模型展开规模或帧率样本。

正式导出会按Schema重排字段；JSON表示的字段顺序不属于正式项目值。用例保留源文件和导出文件各自SHA，同时核对规范化完整值及快照SHA，不要求两个文件的字节顺序相同。恢复草稿的原始正文仍按原文SHA核对。前两次Chrome运行分别在这两个字段顺序假设上失败，最终用例修正后全部断言通过，未修改产品或放宽字节／数据断言。

最终类型／架构检查、全部12HTTP（8文件，8.57s）、1项新Chrome（22.2s）通过。先前66的738单元、构建／Schema和32项相关Chrome对应的产品源码全部未改；本轮只新增三份测试来源，没有重复运行单元／生产构建或完整58步组合。795份来源冻结无漂移，原980段保持原位置；原用户项目仍修订1、1配置、0测量，589资产、0扫描问题、0项目草稿。整个docs目标继续进行，一般精确来源、其他数据处理／DOM路径及原935项最终证据复核保留。

证据：[增量结果](../_local/history/checkpoint67-result.json)、[边界文件独立构造](../tests/project-export-fixture.ts)、[磁盘／HTTP断言](../tests/integration/project-export-size.integration.ts)、[HTTP日志](../_local/history/checkpoint67-http2.log)、[Chrome断言](../tests/e2e/project-export-size.spec.ts)、[Chrome日志](../_local/history/checkpoint67-formal-chrome3.log)、[浏览器摘要](../_local/history/checkpoint67-artifacts/formal-boundary-browser.json)、[原工作区核验](../_local/history/checkpoint67-production.json)。
