# 运行时基线

本页固定Node运行时与来源校验。代表模型、实际最大展开、软件耗时／进程内存和Chrome观测另见[软件运行规模基线](RUNTIME_BASELINE.md)。

固定 Node.js **24.22.3**，与 `.node-version` / `.nvmrc` 一致，继续使用 Node.js 24 LTS 分支。依赖精确版本见唯一 `package-lock.json`。

核对来源：[Node.js 官方 latest-v24.x 校验清单](https://nodejs.org/download/release/latest-v24.x/SHASUMS256.txt)。可复查的固定版本清单：[v24.22.3 SHASUMS256.txt](https://nodejs.org/download/release/v24.22.3/SHASUMS256.txt)。

本次 Windows x64 验证使用官方 `win-x64/node.exe`，SHA256：

```text
86fc4785327db5f5c7558dc6156c543b433c313e813a222e088086222ab4afa6
```

本地验证副本放在 `.runtime/node-v24.22.3/node.exe`，该目录不纳入源代码。不更改系统级 Node，也不将运行时二进制作为产品源码资产。

使用版本管理器选择 24.22.3 后按根 README 运行命令。运行时升级需同时更新两个版本文件、核对官方版本/校验清单并重新执行检查、测试与构建，不使用长期漂移的 `latest` 作为固定版本。
