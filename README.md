# SenseNova API 429 限流触发机制研究 · 数据与代码包

**一份关于商汤 SenseNova 免费 Token Plan 的 HTTP 429 限流机制的实证研究**

**版本 v1.0** · 2026-10-04 · 作者：[Corvin Yu](https://github.com/CorvinYu) · 协议：[CC BY 4.0](LICENSE)

- 实验一：2026-10-03 白天（北京 09:03–16:06），963 次请求
- 实验二：北京 2026-10-04 凌晨（01:55–09:25），2080 次请求
- 生产数据佐证：近 7 天 2820 次真实请求
- **合计 3043 次受控请求 + 2820 次观测请求**

---

## 一句话结论

**429 不是"请求次数超限"、不是"积分耗尽"、也不（在受控条件下）是"单次 token 量过大"——它主要由「时段负载 + 突发洪流 + 模型配额」三者叠加驱动。**

---

## 核心发现速览

| # | 发现 | 证据强度 |
|---|---|---|
| 1 | 社区流传的"deepseek-v4-flash 150 次/5h"口径**不成立** | 🟢 强（3043 次实证，A 类墙 0 次触发） |
| 2 | B 类频率闸（tpm/rpm）是实测主闸门（全部 429 均为此类） | 🟢 强 |
| 3 | 同账号受控实验中，RPM 与输入规模**都不显著**影响 B 类率 | 🟢 强（2×2 析因，Fisher 检验） |
| 4 | **时段是最大变量**：深夜 3.4% → 白天 25.4% → 傍晚 43.3% | 🟡 中（观测数据，含假期混杂） |
| 5 | B 类触发呈**突发性**：十分钟内爆发 255 次后骤降 | 🟡 中（单次事件） |
| 6 | **模型间配额差异显著**：deepseek-flash 76% vs v4-flash 32% | 🟢 强 |
| 7 | 429 分类必须依据**响应文案**而非错误码（同一闸有 7 种 code） | 🟢 强 |
| 8 | 生产日志的 token 字段**不能**用于限流归因（因果倒置陷阱） | 🟢 强 |
| 9 | 积分池消耗与 429 **无关** | 🟢 强 |
| 10 | 上游**不返回 Retry-After** | 🟢 强 |

**外部佐证**：Anthropic 已官方公开承认采用"高峰时段动态收紧"机制，其描述（总配额不变、只改时间分配）与本研究观测高度吻合。

---

## 目录结构

```
.
├── REPORT.md                    ← 主报告（建议先读这个）
├── README.md                    ← 本文件
├── LICENSE                      ← 授权协议（CC BY 4.0）
├── charts/                      ← 4 张图表
│   ├── chart1-hourly-peak-valley.png    时段峰谷图（含样本量标注）
│   ├── chart2-segment-v4flash.png       单模型分段对比
│   ├── chart3-burst-and-model.png       突发性与模型差异
│   └── chart4-external-evidence.png     外部佐证对照
├── experiment-1/                ← 实验一（探索性）
│   ├── results.ndjson           963 次请求全字段原始数据
│   ├── summary.csv              按桶汇总
│   ├── loader.mjs               压测器（含断点续跑）
│   ├── analyze.mjs              分析器
│   └── config.json              实验配置
└── experiment-2/                ← 实验二（验证性，2×2 析因）
    ├── results.ndjson           2080 次请求全字段原始数据
    ├── blocks.ndjson            104 个块级汇总
    ├── arm-summary.csv          按臂汇总
    ├── block-series.csv         块级时序
    ├── runner.mjs               运行器（相位分离 + 区组随机化）
    ├── analyze.mjs              析因分析器（含 Fisher 精确检验）
    └── config.json              实验配置（预注册参数）
```

---

## 数据字段说明

### `results.ndjson`（每行一次请求）

| 字段 | 含义 |
|---|---|
| `ts` | UTC 时间戳（注意：需 +8 小时转北京时间） |
| `account` | 账号代号（`sensenova-1` / `sensenova-2`，**非真实账号标识**） |
| `model` | 模型名 |
| `status` | HTTP 状态码 |
| `latencyMs` | 请求耗时（毫秒） |
| `errorMessage` / `errorCode` | 429 时的上游报文与错误码 |
| `class429` | 分类结果：`A`（entitlement 墙）/ `B`（频率闸） |
| `promptTokensActual` | 上游回报的真实输入 token 数 |
| `arm` / `armId` / `cycle` | 实验二的臂与轮次标识 |
| `intervalMs` | 该臂的请求间隔设定 |

### `blocks.ndjson`（实验二，每块一行）

块的汇总统计：`sent` / `ok` / `b429` / `a429` / `realizedRpm` / `realizedTpm` / `bRate`。

---

## 复现方法

### 前置
- Node.js ≥ 20（使用原生 `fetch` 与 `node:sqlite`）
- 自备 SenseNova 账号的 API key

### 提供 key 的两种方式

**方式 A（推荐）**：环境变量
```bash
export SENSENOVA1_API_KEY='你的key1'
export SENSENOVA2_API_KEY='你的key2'
```

**方式 B**：在项目根目录放 `nodes.csv`，格式：
```csv
id,name,base_url,api_key,protocol,note
sensenova-1,Account 1,https://token.sensenova.cn/v1,<key1>,openai,
sensenova-2,Account 2,https://token.sensenova.cn/v1,<key2>,openai,
```

### 运行实验二

```bash
cd experiment-2

# 1) 先干跑，确认调度计划（不发任何请求）
node runner.mjs --dry-run

# 2) mock 自检，验证控制流（不发真实请求）
node runner.mjs --self-test

# 3) 正式运行（需显式 --go）
touch GO
node runner.mjs --go

# 4) 分析
node analyze.mjs     # 产出 ANALYSIS.md / arm-summary.csv / block-series.csv
```

> ⚠️ 注意：`config.json` 里的 `global_deadline_hours` 控制总时长（默认 7.5h），
> `cycles` 控制轮数（默认 13）。跑之前请按需调整。

### 仅分析已有数据

```bash
node analyze.mjs     # 直接读同目录的 results.ndjson / blocks.ndjson
```

---

## 重要提醒（给复现者）

1. **时区**：`results.ndjson` 里的 `ts` 是 **UTC**。做时段分析时务必 `+8` 小时转北京时间，否则会把凌晨当晚上、结论反掉。
2. **429 分类**：必须按**响应文案**判断，不能只看错误码——实测同一频率闸有 7 种错误码写法，且 `code 8` 不一定代表次数墙（详见报告 §4.1）。
3. **不要用生产日志的 token 字段做归因**：失败请求的 token 恒为 NULL，会制造"token 越多越安全"的假象（详见报告 §4.2）。
4. **假期混杂**：本研究两次实验都在国庆假期，时段结论请谨慎外推到工作日（详见报告 §6）。
5. **数据量**：`results.ndjson` 分别为 280 KB（实验一）与 750 KB（实验二），纯文本可直接查看。

---

## 图表说明

| 图 | 内容 | 读图要点 |
|---|---|---|
| `chart1` | 24 小时 B 类率峰谷 | 柱高=率(%)，**斜纹柱=样本<60 不可采信**，灰线=请求量 |
| `chart2` | 单模型分时段对比 | 深夜 3.4% → 傍晚 43.3% 的单调趋势 |
| `chart3` | 突发性 + 模型差异 | 左：十分钟爆发 255 次；右：模型间 32% vs 76% |
| `chart4` | 外部佐证对照 | Anthropic 官方声明 vs 本研究观测 + 佐证强度分级 |

---

## 授权

**CC BY 4.0** —— 允许自由转载、改编、商用，**仅需署名并注明是否修改**。

详见 [LICENSE](LICENSE) 或 <https://creativecommons.org/licenses/by/4.0/>。

---

## 声明

- 本研究为**个人探索性研究**，非商汤官方文档，结论可能存在偏差，欢迎指正。
- 数据来自作者自有账号的实测请求，**不含任何他人隐私信息或账号凭证**。
- 报告中出现的"账号①②"仅为区分两个测试账号的代号。
- 所有实验请求均为受控压测，**未对上游服务造成恶意影响**（速率温和，7.5h 内约 2000 次请求）。
- **AI 使用声明**：本研究由人类作者主导，AI 助手辅助了代码实现、数据整理、图表绘制与文稿起草。所有数据均为真实请求产生，所有结论均可由随附数据与脚本复现。详见 [REPORT.md §10](REPORT.md)。

---

*如有疑问或发现错误，欢迎在本仓库 [Issues](https://github.com/CorvinYu/sensenova-429-study/issues) 中讨论指正。*
