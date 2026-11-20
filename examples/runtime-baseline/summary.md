# Local software runtime observations

Recorded 2026-11-16T16:24:50.196Z; engine 0.1.0-execution.20; v24.22.3 / win32 x64.
AMD Ryzen 9 9950X 16-Core Processor            ; 32 logical CPUs; 47.65 GiB host memory. Shared desktop, not an isolated benchmark host.

Each operation has one warmup and three measured runs in its own fresh child. Times are median monotonic milliseconds; input loading, setup, GC and result assertions are excluded. The raw JSON retains all samples and byte snapshots. RSS below is the range of three after-operation snapshots including retained output/runtime/setup, not a peak or incremental allocation.

| Input | Expanded leaves per call | Parse ms | Expand ms | Analyze ms | Root canvas ms | Dense canvas ms / visible | Analyze after-RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| qwen3-0.6b-prefill | 395 | 1.630 | 70.466 | 468.842 | 0.463 | 0.339 / 16 | 299.1–304.3 |
| qwen3-0.6b-decode | 395 | 1.593 | 65.853 | 2432.749 | 0.397 | 0.291 / 16 | 632.8–636.2 |
| deepseek-v2-lite-expanded | 697 | 3.394 | 113.604 | 1195.987 | 0.734 | 0.508 / 28 | 445.5–447.4 |
| deepseek-v2-lite-absorbed | 724 | 3.392 | 121.257 | 1249.059 | 0.719 | 0.513 / 29 | 439.5–443.8 |
| glm-4-9b-prefill | 686 | 2.144 | 111.517 | 963.965 | 0.858 | 0.561 / 21 | 412.2–413.5 |
| glm-4-9b-decode | 686 | 2.072 | 113.314 | 961.871 | 0.898 | 0.592 / 21 | 408.0–409.4 |
| synthetic-inline-9999 | 9999 | 0.202 | 73.102 | 1307.458 | 63.763 | 8.189 / 9999 | 333.2–337.7 |
| synthetic-operator-9999 | 9999 | 0.203 | 236.759 | 1518.793 | 62.059 | 9.017 / 9999 | 367.4–368.1 |
| synthetic-chain-9999 | 9999 | 0.275 | 1259.966 | 5698.673 | 64.270 | 15.127 / 10001 | 379.6–382.4 |

The leaf count is one phase expansion, not the sum of executions across a multi-step decode workload. Full analysis uses all configured steps from the fixed input. Canvas timing covers Node projection and layout only. It excludes browser DOM/SVG, painting, input handling and GPU work. Dense scope is an actual hierarchy scope with the most direct visible children; no fictional flatten-all mode is introduced. Browser observations are separately linked from the documentation.

The synthetic connected case declares 9,999 one-microsecond leaves and 16 bytes of HBM traffic per leaf: 0.009999 authored model seconds and 159,984 theoretical bytes. Neither is the software wall time or a real device measurement. All baseline-boundary cases use the existing default budget; 10,000 leaves exceed its 10,000 expansion units once the root is included. Repeat-wrapper metadata containers are not an extra spent unit. Reference depth64 succeeds and depth65 is rejected.

These observations are for fixed specific inputs and this machine, not a service-level guarantee or an upper bound for every valid tensor/formula graph. See [raw complete observations](observations.json) for input/source SHA256, exact child flags, phase values, memory snapshots and guard diagnostics.
