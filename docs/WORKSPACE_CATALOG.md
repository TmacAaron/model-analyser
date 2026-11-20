# 模型工作台的摘要目录

主画布和辅助算法库使用摘要目录加载导航。`GET /api/v1/catalog` 返回资产索引、模型工作区名称／修订／配置模型引用，以及草稿身份、代次、基线和格式；不返回项目资产快照、测量正文或草稿候选正文。

选中后，工作台按身份读取完整项目或草稿。`POST /api/v1/project` 接受 `ReadProjectRequest`；`POST /api/v1/project-draft` 与 `POST /api/v1/asset-draft` 接受严格的 `ReadDraftRequest`。完整内容仍通过现有版本、Schema、路径身份与语义校验。不存在、损坏、未来版本及身份冲突保持不同错误。迟到草稿回复不能替换用户随后打开的项目。

目录缓存只保存脱离原始解析缓冲区的摘要，按文件设备／inode／大小／纳秒修改及变更时间检查有效性，最多 4096 项、16 MiB。完整正文不进入此缓存。扫描同时发生写入时重试稳定读取；持续变化报告诊断。写入开始及结束会改变目录请求代次。手动刷新使用 `?fresh=true` 绕过摘要缓存；完整诊断接口 `/api/v1/scan` 保持原有返回内容。

此变更保留全部存储文件和既有修订，不迁移或固定用户的模型配置。当前工作区数据以实际保存内容为准。

专项验证：760 项单元／契约、16 项 HTTP、同一大文件累积目录上的 3 项原失败流程及 23 项恢复／导航／YAML 流程通过。该目录项目及草稿文件约 342 MB，目录响应约 194 KB；这是固定数据集的观察，不是所有输入的延迟保证。完整 58 步验收在第五次冻结源码上已全部通过，最终状态见[检查点68结果](../_local/history/checkpoint68-result.json)。前四次失败日志保留，不能作为通过证据。

证据：[专项单元](../_local/history/checkpoint68-catalog-units2.log)、[HTTP](../_local/history/checkpoint68-catalog-http.log)、[原失败流程](../_local/history/checkpoint68-catalog-accumulated1.log)、[相关流程](../_local/history/checkpoint68-catalog-related1.log)、[目录测量](../_local/history/checkpoint68-catalog-accumulated-observation.json)、[完整门禁日志](../_local/history/checkpoint68-acceptance5.log)。
