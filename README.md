# Model Analyser

源码、固定预设与测试输入由普通 Git 跟踪。大型计算结果按需生成，历史检查点和日志保存在本机。详见[仓库目录说明](docs/REPOSITORY_LAYOUT.md)。

本地优先的大模型推理理论分析工具，以[可编辑模型画布](docs/CANVAS_WORKBENCH.md)为主界面，按 [docs 实施计划](docs/IMPLEMENTATION_PLAN.md) 建设中。

当前已实现契约、受控公式、可恢复文件存储、模型画布，以及单卡/显式多卡理论分析、串行/多流、逐步decode、同范围测量比较和逐设备容量搜索。P0 [契约与手算](docs/P0_ACCEPTANCE.md)、P1 [自动持久化与显式升级](docs/P1_ACCEPTANCE.md)、P2 [结构与公式](docs/P2_ACCEPTANCE.md)、P3 [静态成本闭环](docs/P3_ACCEPTANCE.md)、P4 [耗时/比较与V0.1](docs/P4_ACCEPTANCE.md)、P5 [复杂结构与研究](docs/P5_ACCEPTANCE.md)、P6 [具体预设与文件适配](docs/P6_ACCEPTANCE.md)保留各次列明范围的验收证据。检查点51–56已补实际规格、主要指标来源、后台融合／测量比较、成本／显存参与关系／时间线／Roofline／测量选择联动、状态关系和手工统计；其余指标入口、同步长路径和一般精确来源等[明确剩余项](docs/REMAINING_PRD.md)，全项目尚未完成；当前支持边界与后续任务见[阶段清单](docs/ACCEPTANCE_STATUS.md)和[实施记录](docs/PROGRESS.md)。

检查点37新增[GLM-4-9B BASE 8K与Qwen3-1.7B](docs/EXPANDED_MODEL_PRESETS.md)两个具体型号，固定公开config/实现/索引与参数账本，复用原Qwen模块/公式修订。GLM显式区分半头RoPE、QKV bias、组缓存与全头激活；属于声明假设的数学/物化参考，不能当作真实SDPA后端或全系适配。六份项目支持直接导入，`npm run reference:expanded-models`离线复算，`npm run acceptance:models`包含既有文件/研究门禁。

计算核心可独立展开模型、汇总叶节点成本、估算生命周期显存、生成串行时间线与分精度 Roofline。[契约样例项目](examples/contracts/project.json) 包含七类资产与可移植快照，可导入工作台计算；目录中预先生成的结果文件仍只是契约样例，不代表执行过分析。

检查点41接入[设备／组总峰值覆盖](docs/MEMORY_PEAK_OVERRIDES.md)，支持每物理成员的明确预算、阶段、固定公式与来源，独立保留原理论峰值，解码与容量逐点求值；分类和位置未知时明确标注。检查点43增加[模块私有峰值预算](docs/MODULE_PEAK_OVERRIDES.md)：从画布选择实际调用，保留常驻／边界／共享对象，按调用跨度叠加私有预算，支持多流、逐步decode和整数容量复算。

检查点44新增[Ascend量化描述导入](docs/ASCEND_QUANTIZATION_IMPORT.md)：画布内预览精确字段／存储、声明辅助布局并明确确认，原文和未知项随工作区保存。真实4.2MB／56,888项来源、单Q存储32→104B独立参考及复制／撤销证明已提供；完整MoE与权重头范围未扩大。运行 `npm run reference:ascend` 复算，`npm run acceptance:ascend` 执行组合门禁。

检查点45将[高级配置编辑](docs/CANVAS_CONFIGURATION_EDITING.md)迁入画布侧栏，包含参数、任意设备组／mesh、作用范围／布局、手工通信和数值覆盖；未完成表单／JSON独立保存，完整验证后应用，配置复制／迟到取消和固定来源保留。独立参考：`npm run reference:configuration`；组合门禁：`npm run acceptance:configuration`。

检查点46增加[显示单位](docs/DISPLAY_UNITS.md)：画布右上角可切换二进制／十进制容量和s／ms／µs时间，立即作用于分析与各派生视图；原始结果、导出、配置和inputHash保持不变。`npm run reference:display`复算，`npm run acceptance:display`执行组合门禁。

检查点47补充[P6可编辑预设](docs/PRESET_EXPANSION.md)：MI300X明确型号硬件、人工组内／跨组链路、W4／W8 group32和实际Qwen模块融合候选，画布按家族组织并可定位选中算子。原修订和配置保持固定；`npm run reference:presets`复算，`npm run acceptance:presets`执行完整组合。

检查点48补齐[YAML导入存储格式选择](docs/YAML_STORAGE_FORMAT.md)：在画布辅助定义入口选择转JSON或保留文件格式，后续编辑、草稿恢复、回执重放与依赖升级沿用明确格式；同修订多份权威文件会隔离。`npm run reference:storage-format`生成独立格式／手算参考，`npm run acceptance:storage-format`包含全部既有门禁。

检查点49修复[独立文件固定修订导入](docs/FIXED_REVISION_IMPORT.md)：r7保持r7、补入历史不回退head、普通编辑从当前head继续；发布成员明确隔离未确认文件，冲突副本／回执／恢复保留来源及格式。`npm run reference:fixed-import`复算完整r7模型、历史与显式升级，`npm run acceptance:fixed-import`执行新的完整组合。

检查点50补充[软件运行规模基线](docs/RUNTIME_BASELINE.md)：六个代表模型／三种9,999叶边界输入，独立记录解析、展开、完整分析、画布投影布局和内存快照；修复预算内长连线校验栈溢出及大图适配，并提供后台展开的取消／重试。`npm run reference:runtime`重测，`npm run acceptance:runtime`先测量后运行完整门禁；浏览器DOM成本另记，不以Node计时承诺帧率。

检查点56补充[画布内标量依据](docs/SCALAR_SOURCES.md)：显存分类／状态预留、MFU／MBU分子与实际逐卡分母、Roofline两套屋顶，以及容量／配置对比的固定整数点复核。点击数值查看原始值、单位、真实调用参数和固定来源；后台复核可取消重试，旧配置回复不替换新选择。`npm run reference:scalar-sources`核对五份项目和独立账本，`npm run acceptance:scalar-sources`执行完整组合。

检查点57新增[执行工作量利用率与比较导出](docs/EXECUTED_UTILIZATION.md)：在画布分析及导入预览中，将模型有效MFU与实际执行工作分别列出，点击查看实际分子、统计时间和逐卡峰值；当前页比较JSON／CSV保留固定快照、原记录、不可用和未完成项。五份可移植项目及独立账本由`npm run reference:executed-utilization`复算。完整`npm run acceptance:executed-utilization`已退出0：655单元／契约、7HTTP、186Chrome、45运行组及全部组合参考通过，另五基础参考通过；更细公式链、同步结构编辑、错误项目修复及原文最终审计继续推进。

检查点58补充[预算公式实参与成本构成来源](docs/DECLARATION_COST_SOURCES.md)：预算按原固定输入后台复核，成本占比／合计／构成值可直接查看实际运算和步骤；单卡Decode也可查看实际设备预算。修复短模块路径被根参数覆盖的计算问题，引擎升至`.19`；七份独立项目包含200／300／500 B、真实融合5ms、实际Decode与16／32=50%的账本。完整`npm run acceptance:declaration-sources`已退出0：671单元／契约、7HTTP、191Chrome、45运行组及全部组合参考通过，另五基础参考通过；精确表达式依赖、同步结构编辑、错误项目修复及原文最终审计继续推进。

检查点63增加[模型原文修复](docs/PROJECT_REPAIR.md)：错误项目可保留JSON／YAML原文为恢复草稿，修复后通过完整校验再返回画布；正式基线、显式身份与冲突选择、重开、导出和迟到回复均有专项验证。713单元／7HTTP／29相关Chrome通过；本轮未重跑完整组合，临界尺寸恢复包和原文最终审计继续保留。

检查点64新增[可取消的后台结构准备](docs/CANVAS_EDIT_PREPARATION.md)，连线改写与全部相关配置校验完成后才发布；失败重试复用原身份，移除操作保持。兼容结构展开和依赖图索引同时改进。两个配置各9,999算子的真实浏览器取消／重试已核对；其他同步路径与全项目审计继续推进。

检查点65新增[辅助后台校验](docs/BACKGROUND_MODEL_VALIDATION.md)：执行目标、config双阶段、升级结构、Ascend确认及兼容目标展开均支持取消，迟到回复不覆盖新输入或新布局。当前733单元／契约与专项浏览器通过；完整组合签收状态见实施记录，其他原文剩余项继续推进。

检查点66增加[大恢复文件往返与后台读取](docs/RECOVERY_SIZE_BOUNDARY_AUDIT.md)：普通源限32 MiB，恢复文件使用独立限额及紧凑导出，保留完整原文与正式基线。真实大文件保存／刷新／下载／重导入、取消及超限拒绝通过；738单元、10HTTP、32相关Chrome与构建通过，原工作区不变。其余原文剩余项继续实施。

## 启动

使用固定的 Node.js 24.22.3 LTS 及 npm（见 `.node-version` / [运行时基线](docs/RUNTIME.md)）：

```powershell
npm ci
npm run build
npm run dev
```

访问 http://127.0.0.1:4310 。服务仅绑定本机回环地址。资产文件位于 `data/assets`，项目位于 `data/projects`；用 `MODEL_ANALYSER_DATA` 环境变量更改数据根目录。内置资产位于 `assets/builtin`。

开发界面时另开终端运行 `npm run web`，访问 http://127.0.0.1:5173 。

## 已可操作

- 选择模型直接打开模块结构画布，点击模块逐层进入算子依赖，悬浮查看所涉及的算子与计算。
- 拖动节点、滚轮缩放、中键/空格平移、适配全图；布局自动保存并随模型工作区导出。
- 框选多个算子查看结构融合候选并配置融合，按明确约束选择内部结果物化与时间策略。
- 同一模型下复制/切换配置，在侧边查看并行、量化、执行、显存、容量、对比与分析结果；选择范围来自当前画布。
- 分析后点击“查看所选范围存储”，查看当前模块／算子涉及的真实规范分配、共享／常驻／私有／接口关系、量化payload与辅助数据，以及固定公式和实际调用参数；[使用说明](docs/SELECTED_MEMORY.md)列明与全模型峰值的区别。
- 拖出数据/控制/同步连线，校验后保存真实依赖与绑定，生成可复用用户定义；原固定修订保留。
- 在辅助“模块与算法库”查看所属模块/算子的算法、公式、单位和来源，支持工作区内联算子与尚未全局发布的固定快照。

### 高级定义与既有分析能力

- 打开内置 GEMM 公式，填写 M=4、N=8、K=16，得到 1024 operations。
- 新建公式并编辑 JSON，停止输入 650 ms 后自动写入草稿，校验通过自动提交修订。
- 非法公式仍保存为草稿，正式资产保留最近有效修订；重开页面从“恢复草稿”继续。
- 编辑内置资产自动创建用户副本；用户资产按固定 ID 与修订引用。
- 写入失败保留编辑内容，可以重试或导出恢复文件。
- JSON/YAML 导入、JSON 导出；导入冲突可显式选择独立副本或新修订，既有历史内容不被覆盖。
- 复制、归档与取消归档；扫描诊断隔离损坏/未来版本文件；未发布修订可验证后显式恢复。
- 提交使用持久回执：响应丢失后重试返回同一修订，重启后也可重放，旧请求不回退当前版本。
- “项目与方案”支持项目/方案复制、工作负载编辑、JSON/YAML 项目导入、固定快照、显式模型引用更新、恢复文件导出与重新导入。项目修改自动保存，不生成额外资产。
- 在“模型依赖升级 · 预览与恢复”选择公式/模块等固定依赖的新修订或同类替代，预览父级影响后应用：按依赖顺序发布父级新修订或用户副本，最后切换当前方案。旧项目和其他方案不漂移；响应丢失可重试同一请求，重启可恢复未完成升级，较新草稿保留。已发布的部分修订在失败或停止后仍保留。
- 七类资产均有新建入口；模型/模块提供[结构配置表](docs/STRUCTURE_EDITING.md)，可编辑节点、阶段、重复层、参数/绑定与数据/控制/同步连接。其他必要高级字段在 JSON 编辑器补齐，未完成内容自动保留为草稿。
- 在项目中点击“展开模型结构”，查看当前阶段的模块/算子、重复层、依赖图、shape、精度、成本表达式和参数来源。
- 打开“模块容器与有效叶节点”逐层查看包含树和重复实例，选择叶节点检查公式；包含层级与执行依赖分别展示，不重复汇总父模块。
- 资产库支持类型/模型家族筛选；从 JSON/YAML config 创建持久草稿，按固定模板映射层数、维度、heads、专家与 MLA 参数。缺项需修复，未知/量化字段需逐项说明；确认后默认两阶段结构检查并自动发布。相近模板不代表未知架构已适配，量化元数据不会自动改变位宽。见 [config 操作说明](docs/CONFIG_IMPORT.md)。
- 结构 inspector 可沿固定模块/算子追踪原始公式表达式、单位与绑定结果；config 导入参数保留文件、字段路径和 config/manual 来源。
- 点击“计算理论结果”，在后台计算单卡或具有显式布局/局部方程的多卡方案，查看节点/模块成本、每设备生命周期显存、串行时间线与分设备/精度 Roofline，导出完整结果 JSON 或执行成本 CSV（融合组替换其成员，只计一次）。支持取消；缺失硬件能力或流量假设保留为不可用，已知成本仍可查看。
- 在结果的“成本与覆盖来源”查找模型/模块/叶节点、每卡局部成本、存储/通信或显存指标，查看原始数值、单位、固定公式、参数来源、假设和覆盖说明；逐步 Decode 可按步骤检查。输入覆盖清单与实际结果分开，范围共用的公式引用不会被描述成每项都独立贡献。
- [成本排序与贡献](docs/COST_RANKING.md)可按模型/模块、设备/已有组及decode步骤，分完整ComputeClass排序有效/执行工作与范围差，或查看读写/HBM/分别统计的网络流量。融合计一次、嵌套模块不相加；时间占比使用执行耗时预算并保留原跨度。查找/40行翻页保持分母，支持构成/公式展开与全部匹配项CSV，不修改分析、项目或inputHash。
- 选择模型、模块或节点并录入同范围单次耗时，记录自动绑定当前 inputHash；按计算精度分别比较 MFU，未录入物理 HBM 流量时明确显示“估算 MBU”。修改计算输入后旧结果失效，旧测量不会套用到新输入。
- [统一测量 CSV/JSON](docs/MEASUREMENT_IMPORT.md) 支持 single/mean/sum/span、次数和明确 HBM bytes；先预览，再确认目标/输入 hash 并加入项目自动保存。未映射或历史输入保留，不猜测事件名或单位；同 ID 同内容跳过，冲突需明确新 ID。可跨重开和分批导出，比较结果按最新记录分页。
- [Chrome Trace导入](docs/TRACE_IMPORT.md)支持明确范围内的complete X事件、gzip/JSON、轨道/类别筛选、精确规则、未匹配/歧义及确认保存；固定真实Kineto样本离线验证。源设备号不自动映射物理设备，不重建B/E或异步跨度；可导出稳定节点摘要供外部转换，检查点36另有[ROCm timestamps CSV](docs/ROCM_CSV_IMPORT.md)纳秒/源GPU/队列路径，当前列明的P6预设及有限文件范围已签收，完整边界见顶部阶段清单。
- 在“容量搜索与整数扫描”选择并发、阶段长度或整数模型参数，指定最多 512 个整数的范围，在后台逐点计算显存和成本，求区间内最大可容纳值。支持取消、查看每点诊断与输入 hash、导出完整证据；取整和非单调公式也不靠猜测二分。
- 在“设备布局与通信”解析方案高级 JSON 中的当前阶段规则，查看节点局部张量、生效/被覆盖规则、唯一底层存储、每卡分配与局部算子成本、显式网络通信。通信声明稳定节点与依赖后，可查看串行屏障时间线、总跨度和每设备生命周期峰值。alias 和复用设备组不会重复增加分配；缺少的对象、方程、节点使用和待补通信边界分别显示，可导出完整结果。
- 在“方案量化覆盖”选择项目快照或资产库中的量化预设，填写子树/节点范围，添加或移除当前方案覆盖；资产库预设连同依赖固定到项目。结果展示规范存储、生效/被覆盖规则、packing 与辅助项、全局格式分配前后值；分片按每设备实际形状重新计算。
- [SP2、EP2与EP2×TP2快捷预设](docs/NAMED_PARALLEL_PRESETS.md)已发布三份新模型根，映射任意真实设备身份、复用角色组、保留原生AllToAll/Gather/Scatter与非均匀逐卡消息，支持预览/应用/保存重开；固定子图范围与人工参数见说明。检查点40增加[PCP2/DCP2/PP2](docs/CONTEXT_PIPELINE_PRESETS.md)，保留真实查询因果起点、固定KV槽位与稳定归约、独立阶段状态/SendRecv；均有手算、应用和重开证据。
- “并行预设与物理设备”可增设实际设备、建立全设备一维组，预览并应用固定模型作者声明的布局与通信。合成 GQA attention/residual 参考声明冗余复制、DP 请求分片、TP heads 与整池 KV 复制四种方案；完整语言模型的未知局部成本不会按卡数猜测。预览/应用/重开及取消已通过 Chrome 验证，手算与范围见 [并行说明](docs/PARALLEL_PRESETS.md)。
- 在“方案融合”填写成员和可取消物化的内部张量，选择累计成员屏障或覆盖整体时间，声明附加成本。数学成员保留，执行和汇总以融合组计一次；不安全的边界/状态/外部消费者物化取消会被拒绝。融合组可单独绑定测量，成员不伪造独立时间区间。
- 模型/模块资产可直接包含 collective 节点，用固定 source/destination 端口连接数据边。通信公式和临时存储按实例参数与边界对象展开，归属所在模块；布局/分析中显示图内来源，和方案层通信共用串行执行、显存及测量路径，只计一次。
- Decode steps 大于 1 时逐步更新上下文、重算显式状态分配与成本，查看每步输入、状态版本、token 范围、预留容量、时间线与 Roofline。默认增长；“固定上下文近似”必须显式选择并显示警告。一次测量在序列报告中表示完整序列，容量搜索使用最坏步骤峰值。
- 在“执行计划与资源假设”选择多流，将稳定叶节点/容器分配到实际设备组与流，添加跨流同步，选择理想重叠、声明的 HBM 共享或用户效率。结果显示分设备/流泳道、串行基线、时间节省或增加、重叠显存和资源进度；共享 backing 冲突会形成依赖，不能靠复用组名绕过。

导入样例项目后，将容量变量选为“模型参数 M”、范围设为 1–100，可复算区间最大值 80（4096 byte），81 开始超容量。该结果使用人工硬件和 GEMM 样例，不能当作真实模型容量。

运行 `npm run reference:upgrade` 生成 [C06 升级演示](examples/upgrades/reference.json) 和可移植的前/后项目：公式更新后需显式升级算子→模块→模型，旧项目保持 4.48 s，新方案为 10.24 s。操作步骤与失败边界见 [P1 验收记录](docs/P1_ACCEPTANCE.md)。`npm run test:api` 执行真实本地 HTTP 集成；`npm run acceptance:p1` 合并 P0 门禁、HTTP、升级参考、构建与 Chrome 全回归。测试需要本机回环网络与 Chrome。

运行 `npm run reference:editing` 生成[结构表单参考项目](examples/editing/project.json)与[独立摘要](examples/editing/reference.json)：模块参数绑定为 3，重复 3 个两秒节点，再执行三秒 tail，总计 9 秒。可直接导入、计算并查看层级；这些是人工时间。

运行 `npm run reference:config` 生成[config 独立摘要](examples/config-import/reference.json)及两份可移植项目：小尺寸 Qwen 为 616 B 权重/32 B 状态/624 matrix operations；DeepSeek 为 1436/384 B、5712 operations。`npm run acceptance:p2` 合并全部既有门禁与结构/config 参考生成。当前引擎为 `0.1.0-execution.12`。

运行 `npm run reference:gqa` 生成[四种并行独立摘要](examples/gqa/reference.json)及可移植项目。两卡 TP heads 每卡权重/state/峰值为 192/24/280 B，整池 KV 复制为 256/48/368 B；复制增加 K/V 投影和读取，完整通信 HBM 缺项不会补零。`npm run acceptance:p3` 组合 GQA 参考与完整 P2/P1/P0 门禁，最终通过 297 项单元/契约、2 项真实 HTTP、41 项 Chrome、架构/严格编译、Schema/样例、独立参考和生产构建，详见 [P3 验收](docs/P3_ACCEPTANCE.md)。

运行 `npm run reference:measurements` 生成[七条测量独立摘要](examples/measurements/reference.json)、统一 CSV/JSON 和确认后的可移植项目。C01 人工 5 s/调用得到 MFU 20.48%、估算或 measured MBU 89.6%；mean/sum/span 的次数和区间独立核对。它是 P4 测量文件部分的证据，完整基础闭环见[P4验收](docs/P4_ACCEPTANCE.md)。

运行 `npm run reference:hardware` 生成固定来源 A100/H100 硬件、C01 可移植项目和独立摘要；[硬件说明](docs/HARDWARE_PROFILES.md) 列明官方版本、精度/单位及缺项。硬件表单沿原草稿/修订链保存，已有物理设备可明确选择库中的固定硬件；库编辑不会改变旧项目快照。检查点25完整门禁通过310单元/3HTTP/47Chrome，最终数值显示补测后311单元、构建与3项硬件Chrome通过；当时P4整体仍未签收；检查点27已完成相关条件。

运行 `npm run reference:comparison` 生成[三方案可移植项目](examples/comparison/project.json)与[独立摘要](examples/comparison/reference.json)。[方案比较](docs/SCENARIO_COMPARISON.md)支持2–4方案结果/输入差异、来源、CSV/JSON与整数扫描；人工A=X、B=4.5、C=max(3,X)在[4,5]改变排序，A/C在整数3..8相等，容量分别4/8/2。缺失点不跨越，不将相邻排序变化当作连续精确交点。检查点26完整门禁319单元/3HTTP/50Chrome通过，最后展示折叠调整后构建与3项比较Chrome再通过；检查点27已补齐参数拐点与V0.1逐项签收。

运行 `npm run reference:roofline` 生成[独立屋顶摘要](examples/roofline/reference.json)与两份可移植GEMM项目。[范围Roofline研究](docs/ROOFLINE_STUDY.md)支持节点/模块/模型与明确decode步骤、硬件/有效屋顶、整数拐点和通信成本/覆盖占比；400 op/s与100 B/s下M=16平衡，计算效率0.5后只报告整数[3,4]侧改变。`npm run acceptance:p4`完整通过331项单元/契约、3项HTTP、55项Chrome及全部独立参考，P4逐项验收通过；P5/P6原研究和适配条件保留。

运行 `npm run reference:ulysses` 生成[Ulysses完整模块项目](examples/ulysses/sequence-heads-project.json)、单卡/双卡冗余对照、容量与[独立摘要](examples/ulysses/reference.json)。[研究说明](docs/ULYSSES_RESEARCH.md)列明固定官方布局来源、作者网络/缓冲假设和SP→head→SP实际形状；两卡为6.276s/288B，单卡11.2s/448B。新增回归后339单元/3HTTP/58Chrome通过；这是P5首个完整研究案例；检查点29已补齐MoE，特殊机制与P5/P6整体验收仍待完成。

运行 `npm run reference:moe` 生成[MoE混合项目](examples/moe/mixed-project.json)、EP-only/理想双流/集中路由对照及[独立摘要](examples/moe/reference.json)。[研究说明](docs/MOE_RESEARCH.md)列明固定官方来源、SP/EP/专家TP、逐rank非统一流量与metadata/缓冲：四卡21.525 s/392 B，理想重叠12.267 s，批次容量23；两卡34.363 s/672 B、容量14。全部专家驻留与本批次触及分开；完整通信HBM仍缺项。新增可选逐设备payload契约并将引擎升为0.1.0-execution.12，旧uniform路径保留。检查点30已补齐CSA2第三案例与三案复核；P5其余特殊机制和P6仍待完成。

运行 `npm run reference:csa2` 生成[CSA2复用项目](examples/csa2/shared-project.json)、独立/仅缓存共享/三流与HBM争用/BF16 cache对照及[独立摘要](examples/csa2/reference.json)。[研究说明](docs/CSA2_REUSE_RESEARCH.md)固定核对V4.1 Flash源码/config，独立声明主KV、indexer K、Top-K、候选与四份window。四层片段从87.72 s/3862 B降至62.18 s/2242 B；理想49.44 s，HBM争用回62.18 s；共享批次容量5对独立1。packed是理论变体，非浮点demo实测峰值或完整型号支持。两份模型及依赖已录入内置库。`npm run reference:research`共同复算[三研究案例](docs/P5_RESEARCH_CASES.md)，检查点31/32追加下面的压缩和DSA组件复算；P5的KDA/递归混合与P6仍待完成。

运行 `npm run reference:compression` 生成[ratio2压缩项目](examples/compression/r2-decode-project.json)、ratio1/预填充/预留容量/两流/HBM共享/BF16对照、[三调用项目](examples/compression/r2-sequence-project.json)及[独立摘要](examples/compression/reference.json)。[压缩研究](docs/COMPRESSION_RESEARCH.md)核对固定来源的FP32双尾部、仅完整组写入和有效条目/容量区别。人工条件下ratio2三步新cache写9/0/9 B，最坏2443 B；上下文[623,652]内非单调容量serial646/ideal650。完整压缩器及window准备按显式成本计算，不包含attention/indexer或完整模型。新增五模型及依赖共47份资产，8项研究单元与3项Chrome通过；P5/P6整体仍未签收。

运行 `npm run reference:dsa` 生成[DSA源码mask项目](examples/dsa/source-mask-project.json)、[显式gather理论项目](examples/dsa/sparse-project.json)、dense/双流/HBM/预留容量对照、三调用项目及[独立摘要](examples/dsa/reference.json)。[DSA研究](docs/DSA_RESEARCH.md)固定官方V3.2 Exp源码/kernel/config，源码路径保留完整QK/AV，理论路径仅缩减显式gather后的attention；两者indexer仍扫描全部前缀，FP8 payload和FP32 scale分别驻留。人工默认53.52s/2568B对30.96s/2360B，后者三步最坏2432B；其[77,81]上下文扫描最大79。四模型及依赖共57份资产、8项单元和3项Chrome通过。它是单query attention片段，不代表完整型号/实卡kernel或精度等价。

运行 `npm run reference:kda` 生成[KDA混合decode项目](examples/kda/hybrid-source-project.json)、source/inplace、全KDA/全MLA四片段对照、三步与[独立摘要](examples/kda/reference.json)。[KDA研究](docs/KDA_RESEARCH.md)锁定Kimi Linear/FLA v0.4.0，分别表达三份BF16短卷积、FP32矩阵和expanded MLA；源拼接的保守原子分配与作者预分配变体分开。人工默认98.64s/6012B对86.64s/5480B，三步最坏6172B；混合source在[40,44]最大42。新增48份资产，8项单元/3项Chrome通过。原F04的prefill差异在检查点34另以独立资产补齐，旧decode约束保持不变。

运行 `npm run reference:kda-prefill` 生成[短prefill项目](examples/kda-prefill/hybrid-short-project.json)、[chunk项目](examples/kda-prefill/hybrid-chunk-project.json)、Q64/128/129与同Q65三机制对照和[独立摘要](examples/kda-prefill/reference.json)。[prefill研究](docs/KDA_PREFILL_RESEARCH.md)补齐批量权重读取、一次矩阵读写、Q-by-64 FP32系数、BF16 history、FP32概率及有用/执行分子；独立三角系统与递归核数学关系交叉验证。新增71资产、8单元/3Chrome通过；人工256 KiB下hybrid在query[142,146]最大144。`acceptance:p5`组合全量既有门禁和七套研究复算，逐项范围见[P5验收](docs/P5_ACCEPTANCE.md)；不表示完整型号/实际kernel性能或P6完成。

多卡 AnalysisResult 已接入理论分析、测量与容量搜索：设备组成本累加物理工作/流量，模型有效工作量单独保存并用于 MFU，复制执行不会重复增加模型分子。模块仅汇总自身展开叶节点，方案通信在模型层单列；测量绑定所选目标的实际参与设备。未声明的通信 HBM 不作为零流量，因此模型估算 MBU 可能不可用。方案量化覆盖现支持 weight/activation/state 存储格式；ComputeClass、通信 payload 和转换开销仍需显式定义。具体真实模型已提供下述单卡理论资产；快捷多卡生成目前限于作者提供局部方程与 recipe 的 GQA 合成子图。基于单调性证明的大范围快速求解尚未实现。容量结论仅针对指定范围；取消或最大候选以上存在缺项时不声称已求得最大值。

多设备核心提供 `partitionTensor`、`allocateDistributedStorage`、`evaluateCommunication`、`resolveParallelPlan` 和 `evaluateDistributedCosts`，由 `analyzeScenario` 组成统一报告。算子或 opaque 叶节点可声明 `localCost`，从每卡有效/分配维度、元素数、copies 和存储 bytes 绑定受控公式，计算每卡工作量、流量与耗时；未声明方程时保留缺项。运行 `npm run reference:distributed` 可复算 C03 KV 与人工 ring 案例。

同一命令还生成可直接导入的 [两卡布局项目](examples/computed/parallel-plan-project.json) 和 [布局求值结果](examples/computed/parallel-plan-result.json)。导入后点击“解析设备布局”，可核对每卡 128 B 的权重分配和未配置的激活项。

运行 `npm run reference:local-cost` 可生成并核对[局部 GEMM 项目](examples/computed/local-gemm-project.json)和 [N=9 padding 项目](examples/computed/local-gemm-padded-project.json)。导入后点击“解析设备布局”：普通案例每卡 512 operations / 288 B / 2.88 s；padding 案例两卡 useful work 为 640/512、executed work 为 640/640、流量各 328 B。结果中的叶节点串行累计不含通信、缺项和未定位节点。

运行 `npm run reference:serial` 生成[串行 GEMM + AllGather 项目](examples/computed/serial-gather-project.json)与[计算结果](examples/computed/serial-gather-result.json)：每卡 GEMM 2.88 s，通信 0.033 s，串行跨度 2.913 s。每卡已声明分配 520 B；输入 X 在通信前释放，200 B scratch 只在通信期间存活，实际峰值为 392 B。通信的 `placement` 声明稳定 nodeId、phases 与前后依赖；`temporaryStorageIds` 引用显式分配。旧通信定义仍可计算独立网络成本，缺少 placement 时总跨度与完整显存峰值不可用。网络模型不推断未声明的本地 HBM 或归约算术。

同一命令还生成[统一分析报告](examples/computed/serial-gather-analysis.json)、[测量比较证据](examples/computed/serial-gather-measurement.json)与[多卡容量搜索](examples/computed/serial-gather-capacity.json)。输入人工 5 s 时间，模型 MFU 为 10.24%，未录入通信 HBM 时 MBU 不可用；在 [80,84] 搜索 M，最大值为 82，两卡峰值各 4064 B，83 为 4112 B 并超出 4096 B。通信 payload 随 M/N 方程重算。该结果仍是人工 GEMM 参考，不是真实模型预设。

运行 `npm run reference:quantization` 生成 [W4A4 项目](examples/computed/w4a4-project.json)、[W4A8 项目](examples/computed/w4a8-project.json)和[两卡 W4A8 项目](examples/computed/w4a8-local-project.json)及真实结果。单卡含辅助数据的峰值/完整访问流量分别为 124 B、172 B；两卡 W4A8 为 120 B/卡。内部计算保持作者声明的 BF16，不声称 INT4/INT8 kernel 吞吐或精度效果。MemoryAccess 可用 `logicalBytes={kind:'storage_allocation',passes:<count表达式>}` 明确按完整物理分配（含 packing/padding/辅助项）计流量；已有 byte 表达式仍按作者定义，量化不会自动改写它。转换算术和 workspace 必须在节点中声明；目前没有自动转换节点生成。

运行 `npm run reference:fusion` 生成[未融合项目](examples/computed/fusion-unfused-project.json)、[累计屏障融合项目](examples/computed/fusion-sum-project.json)与[整体覆盖融合项目](examples/computed/fusion-override-project.json)。人工案例有效工作均为 5，融合显式附加工作使执行工作从 5 增为 6；取消中间物化后 HBM 从 20 B 降为 4 B，峰值从 10 B 降为 4 B。累计时间为 3.1 s，整体覆盖为 0.5 s。保留的成员/附加缓冲在整个原子组期间驻留；没有取消物化时不自动复用存储。多卡非零附加资源需通过高级 JSON 声明 `extraLocalCost`，不按卡数猜测工作量；组内通信变换须先解决。转换成本由作者明确选用独立节点或附加成本，目前没有自动生成/语义去重。

运行 `npm run reference:native-collective` 生成[原生 AllGather 项目](examples/computed/native-gather-project.json)与[实际分析结果](examples/computed/native-gather-analysis.json)：GEMM 2.88 s + 图内通信 0.033 s，跨度 2.913 s，峰值 392 B/卡。输出使用独立逻辑张量 Yg 并共享显式 backing，避免将同一逻辑张量的前后版本混为多个 producer。支持模块边界轴映射、链式 repeat、声明的状态引用与通信数值覆盖；分布和 payload 由作者明确声明，不自动推断网络算法、本地 HBM 或转换成本。

运行 `npm run reference:decode` 生成[增长上下文项目](examples/computed/decode-growing-project.json)、[固定近似项目](examples/computed/decode-fixed-project.json)与[窗口状态项目](examples/computed/decode-window-project.json)及逐步证据。人工三步从 context=2、每步 query=1 开始，增长案例为 0.24 s/18 B 峰值，固定近似为 0.18 s/12 B，window=3 为 0.22 s/14 B。状态在同一 backing 中预留每步前后最大容量，重分配复制/转换成本需显式声明；append/window/replace 须有实际写入来源，static 只读。最多 256 步、100000 个累计叶事件；会迁移既有数据的跨步重分片明确拒绝，不以零通信冒充支持。

运行 `npm run reference:streams` 生成 [C05 串行](examples/computed/streams-serial-project.json)、[理想多流](examples/computed/streams-ideal-project.json)、[HBM 共享](examples/computed/streams-shared-project.json)及[效率折减](examples/computed/streams-efficiency-project.json)项目/结果。串行 8.5 ms、峰值 3 GiB；理想多流 6.5 ms、峰值 5 GiB。共享带宽参考的总时间为 8.5 ms；效率 0.5 时为 13 ms，保留负收益。shared_bandwidth 仅按声明的 compute HBM 需求/隔离时间共享每卡峰值带宽；网络保持独立通信模型，不模拟链路、SM、cache 或 staging 的未声明争用。多卡节点保留逻辑屏障，缓冲保守存活到节点结束；数据不完整时不输出伪重叠峰值。

运行 `npm run reference:models` 可核对固定来源并生成 [Qwen decode](examples/projects/qwen3-0.6b-decode.json)、[Qwen prefill](examples/projects/qwen3-0.6b-prefill.json)、[DeepSeek HF expanded-cache](examples/projects/deepseek-v2-lite-expanded.json) 和 [DeepSeek absorbed MLA 理论变体](examples/projects/deepseek-v2-lite-absorbed.json)。内置模型在新增方案时自动绑定 workload；两者分别核对为 596,049,920 / 15,706,484,224 个唯一参数。示例硬件是人工算术参考；完整来源、缓存差异、MoE 激活/驻留与未建模开销见 [模型说明](docs/MODEL_REFERENCES.md)，原计划退出条件见 [验收清单](docs/ACCEPTANCE_STATUS.md)。

运行 `npm run reference:state` 可生成 [C04 共享状态串行项目](examples/computed/state-shared-serial-project.json)、[双流独立读取项目](examples/computed/state-shared-ideal-project.json)、[共享 HBM 项目](examples/computed/state-shared-bandwidth-project.json) 和 [三次递归更新项目](examples/computed/state-recurrent-sequence-project.json)。共享案例在 B=3 时只有 192 B 常驻，仍读取 384 B；递归案例每调用 1.76 s，三次为 5.28 s、峰值保持 128 B。均使用明示人工硬件与数学假设。

运行 `npm run reference:contracts` 重建 [结构分支清单](examples/contracts/union-coverage.json)，包含 182 个 Schema/API 根、83 组不同联合、213 个分支及 203 个非法判别值的正反样例。导出的重复节点使用标准 $defs/$ref，字段与校验约束保持。清单只证明结构接受/拒绝，引用、图、状态与算术仍由独立语义测试和可复算项目证明。

## 验证

固定 Node 下可用 `npm run acceptance:p0` 重跑契约与手算基线门禁；整体项目仍按 [阶段验收清单](docs/ACCEPTANCE_STATUS.md) 继续。

```powershell
npm run check
npm run architecture:check
npm test
npm run schemas
npm run examples
npm run reference:distributed
npm run reference:local-cost
npm run reference:serial
npm run reference:quantization
npm run reference:fusion
npm run reference:native-collective
npm run reference:decode
npm run reference:streams
npm run reference:models
npm run reference:contracts
npm run reference:state
npm run reference:measurements
npm run reference:trace
npm run reference:file-samples
npm run reference:rocm
npm run reference:hardware
npm run reference:comparison
npm run reference:roofline
npm run reference:ulysses
npm run reference:moe
npm run reference:csa2
npm run reference:compression
npm run reference:dsa
npm run reference:kda
npm run reference:kda-prefill
npm run reference:research
npm run acceptance:p5
npm run acceptance:files
npm run reference:expanded-models
npm run acceptance:models
npm run reference:cost-ranking
npm run acceptance:context-pipeline
# 包含原完整链及设备/组总峰值参考
npm run reference:memory-peaks
npm run acceptance:memory-peaks
# 模型画布及此前完整门禁
npm run acceptance:canvas
npm run reference:module-peaks
npm run acceptance:module-peaks
npm run reference:ascend
npm run acceptance:ascend
npm run reference:configuration
npm run acceptance:configuration
# 当前指标来源、所选存储及全部既有组合门禁
npm run reference:selected-memory
npm run acceptance:selected-memory
npm run reference:metric-sources
npm run acceptance:metric-sources
npm run acceptance:p4
npm run build
npm run test:e2e
```

浏览器测试默认使用已安装的 Chrome，每次运行使用独立的 `data/e2e/runs/<UUID>`，自动启动 4311 端口服务，生成资产和项目工作台截图。单元测试在工作区内创建并清理独立临时目录。JSON Schema 全部从 Zod 生成，勿直接修改 `schemas/generated`。

目录依赖：`web → core/contracts`、`core → contracts`、`local → contracts`。共享结构校验、语义检查和公式语法位于 contracts；公式执行位于纯函数 core，不依赖 UI、文件系统或 GPU。

检查点51的[实际规格与来源](docs/CANVAS_EVIDENCE.md)显示真实模块／算子shape、逻辑／存储量化精度和计算段；点击主要指标可查看实际参数值与单位，Decode按步骤保留证据。融合推荐／预设／添加验证在可取消后台线程执行。`npm run reference:canvas-evidence`复算独立账本，`npm run acceptance:canvas-evidence`运行包含运行基线的完整组合。

检查点52提供[画布选择、状态关系与手工测量](docs/CANVAS_CONTEXT.md)：选中真实模块／算子带入成本表、Roofline和测量；状态按实际ID查看创建／读写／共享。手工支持single／mean／sum／span、次数、时间单位、区间、设备、实际bytes和Decode实际步骤。`npm run reference:canvas-context`复算独立账本，`npm run acceptance:canvas-context`执行全部既有门禁。

检查点53补充[时间线上下文与后台测量比较](docs/CANVAS_DERIVED_VIEWS.md)：按实际执行ID／步骤筛选并保留全局时刻，比较可取消／重试，来源缺失不回退。其余原文缺口继续见验收状态。

检查点54增加[所选范围存储](docs/SELECTED_MEMORY.md)：从画布选择定位真实canonical分配、共享／常驻／私有／完整接口、量化payload／辅助布局、生命周期和实际调用来源。每卡峰值、私有预算、总量覆盖与分配合计保持不同口径；旧结果缺证据明确重算，导出保留实际步骤hash与来源池。`npm run reference:selected-memory`复算八份独立项目账本，`npm run acceptance:selected-memory`继承全部旧门禁。全项目仍须完成剩余原文审计。

检查点55补[同模型指标与差值来源](docs/METRIC_SOURCES.md)：配置对比数值可直接打开当前配置／完整分类／物理设备的依据，Δ展示两侧原值与来源；硬件容量沿固定修订，通信合计逐事件检查，混合分类逐类选择。四同模型项目账本可独立复算，原计算数值／hash不改。`npm run acceptance:metric-sources`继承全部旧门禁；其余F10标量入口、来源粒度与原文剩余项继续实施。

检查点59增加[精确叶表达式来源](docs/LEAF_COST_SOURCES.md)，按实际字段／调用／固定版本后台复核，Qwen embedding显示32+8192+8192=16416B，并支持含固定输入的来源报告离线重读。14新领域和5新Chrome等专项通过，完整`npm run acceptance:leaf-sources`已观察退出0：685单元／契约、7HTTP、196Chrome、45运行组及全部组合参考通过，另五基础参考通过；735份冻结来源无漂移，原Qwen工作区未改动。只签收列明的单设备叶指标，其他精确变换链与原文最终审计仍继续。

检查点60已修复[量化辅助公式作用域](docs/QUANTIZATION_SCOPE.md)：根参数不再覆盖短节点局部参数，反例从12B恢复14B，共享格式冲突与容量最大值也正确处理，引擎升.20。15新领域和16相关Chrome等专项通过；700单元／7HTTP已通过，完整58叶门禁重跑的201Chrome仍运行中。一般来源、编辑长路径及错误普通项目修复等[剩余项](docs/REMAINING_PRD.md)继续保留。

检查点60重跑说明：完整58叶命令首次会话35818已观察退出1：199项Chrome通过，9999节点来源用例失败。保留原失败日志后，受控迟到回复分别复现了语义选择器对象变化、相同项目正文重新解析导致的错误失效；修复按语义选择器复用及按正文缓存解析，真实打开工作区则重置画布任务。新身份用例与9999节点各连续三次通过，确认只启动一个来源Worker，15s断言时限未改变。第二次完整门禁会话78160正在运行，预计201项Chrome；尚未终端签收。

检查点60最终重跑说明：第二次完整运行会话78160在Ascend初次载入面板丢失的回归被复现后主动停止，实际退出-1，记录为attempt2，未签收完整结果。修复只在已有工作区真实导航时重置画布，初次载入保留面板；Ascend、叶来源、模型画布、旧项目持久化和量化作用域共23项Chrome全部通过（1.7m）。第三次完整58叶运行会话52655已开始，764份来源重新冻结，当前仍待真实终端。

2026-11-16 用户画布修订已加入[真实数据流与重复模块导航](docs/CANVAS_DATAFLOW.md)：实际residual与MoE双分支、n ×模块入口、直接进入单实例内部及现代浅色画布。702单元与9项相关Chrome通过，完整组合门禁尚待本次变更后重跑。

当前状态校正：检查点60的最终完整58叶运行52655已完成（退出0，201Chrome），仅对应61画布修订前源码。其后画布修订与重复算子联动分别验收，旧“运行中”段落属于过程记录；原项目整体目标仍active。

检查点62已完成[数据流画布与实际调用联动](docs/CANVAS_DATAFLOW.md)的完整验收：703单元／7HTTP／203Chrome、45运行组及全部组合参考通过，767份冻结来源无漂移，原工作区保持。普通错误项目修复等原目标继续实施，见[剩余项](docs/REMAINING_PRD.md)；当前证据为checkpoint62-result.json，旧“运行中”段落仅是历史过程。
