# 商汤 SenseNova API 429 限流触发机制研究

**——两次受控实验（3043 次请求）+ 生产数据佐证**

**版本 v1.0** · 发布于 2026-10-04

| | |
|---|---|
| **作者** | Corvin Yu |
| **联系** | <https://github.com/CorvinYu> |
| **日期** | 2026-10-04 |
| **实验一** | 2026-10-03 白天（北京 09:03–16:06），963 请求 |
| **实验二** | 北京 2026-10-04 凌晨（01:55–09:25），2080 请求 |
| **数据源二** | 生产网关日志，近 7 天 2820 次真实请求 |
| **协议** | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| **结论状态** | **探索性研究**，所有结论均标注置信度与局限 |

---

## Abstract (English)

SenseNova's free Token Plan OpenAI-compatible endpoint returns HTTP 429 under intensive
calling. A widely circulated claim attributes this to a fixed per-5-hour request cap
(e.g. "150 requests / 5h for deepseek-v4-flash"). Through **two controlled experiments
(3,043 requests total) plus analysis of 2,820 production requests**, this study finds:

1. **The "150 requests / 5h" claim does not hold** — the entitlement-exhaustion wall
   (`token plan entitlement exhausted`) never triggered in 3,043 requests; a single
   model reached 390 successful requests in one window without hitting it.
2. **The B-class rate limiter (TPM/RPM) is the actual primary gate** — all observed
   429s belong to this class.
3. **Under controlled conditions within a single account, neither RPM nor input size
   significantly affects the B-class rate** — a 2×2 factorial design
   (1 vs 4 req/min × 90 vs 8,000 tokens) showed no significant difference across four
   arms (only 2 B-class 429s in 2,080 requests), disproving the TPM-causation
   hypothesis suggested by the first experiment.
4. **Time-of-day is the largest observed variable** — B-class rate by single-model
   cohort: 3.4% (late night) → 25.4% (daytime) → **43.3% (evening)**, a ~13× spread.
5. **B-class triggering is burst-driven** — 255 errors within a single 10-minute
   window (78% of that hour), then an abrupt drop.
6. **Model quotas differ substantially** — deepseek-flash 76% vs deepseek-v4-flash 32%.

**Methodological contributions**: (a) 429 classification must rely on the response
*message text*, not error codes — the same rate limiter surfaced at least 7 distinct
error codes, including `code 8` on a B-class error; (b) production-log token fields
**cannot** be used for rate-limit attribution, because failed requests always report
`NULL` tokens, creating a spurious negative correlation.

**External corroboration**: Anthropic has publicly acknowledged adjusting five-hour
usage limits *during peak hours* while keeping weekly totals unchanged — a mechanism
description closely matching our observations.

**Keywords**: SenseNova; rate limiting; HTTP 429; TPM; RPM; API measurement;
controlled experiment; LLM infrastructure

---

---

## 摘要

商汤日日新（SenseNova）免费 Token Plan 的 OpenAI 兼容接口在密集调用时返回 HTTP 429。社区流传的说法是"每 5 小时固定请求次数上限"（如 deepseek-v4-flash 150 次/5h）。本研究通过两次受控实验与生产数据分析，得出以下结论：

1. **"150 次/5h"口径不成立** —— 两次实验共 3043 次请求，`token plan entitlement exhausted`（次数墙）**一次未触发**；单模型单窗口内累计成功请求达 390 次仍未触发
2. **B 类频率闸（tpm/rpm）是实测主闸门** —— 全部 429 均为该类
3. **同账号受控实验中，RPM 与输入规模都不显著影响 B 类率** —— 实验二 2×2 析因（1 vs 4 rpm × 90 vs 8000 tok）四单元均无显著差异，全实验仅 2 次 B 类
4. **时段是最大的观测到的变量** —— 生产数据显示 B 类率：深夜 3.4% → 白天 25.4% → **傍晚 43.3%**（单模型口径，13 倍差异）
5. **B 类触发呈突发性** —— 某十分钟内爆发 255 次（占该小时 78%），随后骤降
6. **模型间配额差异显著** —— deepseek-flash 76% vs deepseek-v4-flash 32%
7. **方法与工程结论**：429 分类必须依据响应文案而非错误码；积分池与 429 无关；上游不返回 Retry-After；生产日志的 token 字段不能用于限流归因

**外部佐证**：Anthropic 已官方公开承认"按高峰时段动态收紧用量限制"，其机制描述（总配额不变、只改时间分配）与本研究观测高度吻合。

---

## 1. 研究背景

### 1.1 问题

SenseNova 免费 Token Plan 在 agent 场景密集调用时频繁返回 429。用户体感是"发送带很长上下文的内容会一下子占很大额度，再次发送长上下文就返回 429"——即疑似 **TPM（每分钟 token 数）** 触发。

关键困惑：**积分池（5h 窗口 60000 credits）仅消耗 19% 时就频繁 429**，说明 429 与积分池并非同一配额。

### 1.2 术语

| 术语 | 全称 | 含义 |
|---|---|---|
| **RPM** | Requests Per Minute | 每分钟请求**次数** |
| **TPM** | Tokens Per Minute | 每分钟 token **总量** |
| **A 类 429** | `token plan entitlement exhausted` | 次数/权益墙（长期封锁语义） |
| **B 类 429** | `inference exceeds tpm/rpm limit` | 频率闸（退避即恢复） |

---

## 2. 实验设计

### 2.1 实验一（探索性，白天）

- 双账号 × 双输入规模（臂）× 受控节奏
- 6 个任务：3 模型（kimi-k3 / deepseek-v4-flash / deepseek-flash）× 大小臂，两账号间臂互换
- 7 小时，963 请求，**直连上游绕过网关**
- **事后发现的缺陷**：每个（账号, 模型）组合只测一条臂 ⇒ 臂效应与账号效应**完全混淆**

### 2.2 实验二（验证性，凌晨）

- **2×2 析因**：RPM(1 vs 4/min) × 输入规模(90 vs 8000 tok)
- **三条防线**：① 同账号内跑全部 4 臂（消除账号差异）② 相位分离（同时刻仅一臂）③ 区组随机化（13 轮，固定随机种子）
- 7.5 小时，2080 请求，双账号并行
- **预注册**：假设、端点、停止规则、分析计划在运行前冻结

| 臂 | RPM | 输入 | 目标 TPM | 请求数 |
|---|---|---|---|---|
| A1 lo_lo | 1/min | 90 tok | ≈90 | 208 |
| A2 lo_hi | 1/min | 8000 tok | ≈8000 | 208 |
| A3 hi_lo | 4/min | 90 tok | ≈360 | 832 |
| A4 hi_hi | 4/min | 8000 tok | ≈32000 | 832 |

### 2.3 共同方法学决策

1. 直连上游，避免网关自身的限速/冷却污染测量
2. **429 分类按响应文案**（见 §4.1）
3. 全字段记录（状态码、报文、错误码、实测 token 数、延迟）
4. 断点续跑 + 进程守护 + 积分池护栏
5. 实验二：按真实 usage 自动校准提示词长度（比例 0.391 收敛）

---

## 3. 实验结果

### 3.1 实验一

| 任务 | 账号 | 模型 | 臂 | 请求 | 成功 | B 类率 | A 类 |
|---|---|---|---|---|---|---|---|
| v4-flash 小臂 | ① | deepseek-v4-flash | 90 tok | 400 | 390 | 2.5% | 0 |
| deepseek-flash 大臂 | ① | deepseek-flash | 7.7k tok | 250 | 48 | 80.8% | 0 |
| v4-flash 大臂 | ② | deepseek-v4-flash | 7.7k tok | 250 | 192 | 23.2% | 0 |
| deepseek-flash 小臂 | ② | deepseek-flash | 90 tok | 39 | 6 | 84.6% | 0 |
| kimi-k3 小臂 | ①/② | kimi-k3 | 90 tok | 24 | 15 | 0% / 75% | 0 |

**合计**：963 请求，312 次 B 类（32.4%），**A 类 0 次**

**初步判断（后被实验二修正）**：v4-flash 大臂 23.2% vs 小臂 2.5%，疑似 TPM 效应。

### 3.2 实验二

| 臂 | 设计 | 请求 | B 类 | B 类率 |
|---|---|---|---|---|
| A1 lo_lo | 1rpm × 90tok | 208 | 1 | 0.48% |
| A2 lo_hi | 1rpm × 8000tok | 208 | 1 | 0.48% |
| A3 hi_lo | 4rpm × 90tok | 832 | 0 | 0.00% |
| A4 hi_hi | 4rpm × 8000tok | 832 | 0 | 0.00% |

**合计**：2080 请求，2 次 B 类（0.10%），A 类 0 次

- 2 次 B 类都在**启动后 5 分钟内**，此后连续 6 小时零 429
- **A4 臂在 TPM ≈ 29,000/min 负载下跑 832 次，零 B 类**
- 两账号完全对称（各 1 次）

### 3.3 假设检验（Fisher 精确检验，Bonferroni α=0.0125）

| 假设 | 对比 | Δ | p 值 | 结论 |
|---|---|---|---|---|
| H1 TPM 主效应 @1rpm | A1 vs A2 | 0.0 pp | 1.0000 | 不显著 |
| H2 RPM 主效应 @90tok | A1 vs A3 | −0.48 pp | 0.2000 | 不显著（方向反） |
| H4 TPM @4rpm | A3 vs A4 | 0.0 pp | 1.0000 | 不显著 |

**⇒ 实验一的"大臂效应"确认为账号×臂混淆的假象，而非 TPM 因果。**

### 3.4 生产数据佐证

分析生产网关日志（近 7 天 2820 次真实请求）：

**按时段的 B 类率（单模型 deepseek-v4-flash，控制模型变量）**：

| 时段（北京） | B 类率 | 样本 |
|---|---|---|
| 深夜 01–04 | **3.4%** | n=206 |
| 清晨 05–08 | 20.2% | n=203 |
| 白天 09–16 | 25.4% | n=197 |
| **傍晚 17–23** | **43.3%** | n=922 |

**突发性**：某日傍晚 18 时逐 10 分钟统计——18:10 (28 次) → **18:20 (255 次)** → 18:30 (33 次) → 18:40 (1 次)。**十分钟洪流后骤降**。

**模型差异**（同口径）：deepseek-flash 76% / deepseek-v4-pro 67% / deepseek-v4-flash 32%。

> ⚠️ 生产数据为观测性证据，样本不均衡（各时段 n 差异大），且观测窗口落在国庆假期，详见 §6。

---

## 4. 方法学发现

### 4.1 429 分类必须依据响应文案，而非错误码

实测同一 B 类频率闸至少有 **7 种错误码写法**：

| 错误码 | 出现次数 | 语义 |
|---|---|---|
| `RateLimitExceeded.EndpointTPMExceeded` | 135 | TPM 端点级 |
| `RateLimitExceeded.EndpointRPMExceeded` | 100 | RPM 端点级 |
| `insufficient_quota` | 42 | 频率闸（报文仍为 tpm/rpm） |
| `429003` | 24 | 通用频率闸 |
| `ModelAccountTpmRateLimitExceeded` | 7 | TPM 账号×模型级 |
| `ModelAccountRpmRateLimitExceeded` | 2 | RPM 账号×模型级 |
| `Throttling.BurstRate` | 1 | 突发节流 |
| **`8`** | **1** | **code=8 但报文为 `rpm exhausted`（B 类！）** |

**两个反例**：
- `code 8` 不一定是 A 类（有一条报文为 `rpm exhausted`，属 B 类）
- `insufficient_quota` 不代表额度墙（报文为 tpm/rpm 频率闸）

**唯一可靠的 A 类判据**：文案 `token plan entitlement exhausted` + type `quota_exceeded_error`。

**工程含义**：任何按错误码分类 429 的实现都会误判（例如把 B 类误判为 A 类，错误地下架模型 5 小时）。

### 4.2 生产日志的 token 字段不能用于限流归因（因果倒置陷阱）

按"上游回报的 input_tokens"分组统计 429 率，会得到荒谬结果：

| 分组 | 429 率 |
|---|---|
| 大输入（>10k tok） | **0.0%** |
| 无 token 记录（null） | **90%+** |

**真相**：请求**失败时上游不返回 usage**，token 字段恒为 NULL ⇒ "null 组 429 率高"纯粹是"因为失败了所以没 token"。

**正确做法**：在**请求侧**独立记录预期/实际发出的 token 数（本研究的压测器即如此）。

### 4.3 积分池与 429 脱钩

| 实验 | 积分池峰值 | B 类 429 状态 |
|---|---|---|
| 实验一 | ~19% | 高频 |
| 实验二 | 12.5% | 几乎为零 |

两个方向都证明积分池消耗与 429 无单调关系。**盯积分没有预警价值。**

### 4.4 上游不返回 Retry-After

312 次 B 类 429 的响应头与响应体**均无 `Retry-After` 字段**，客户端只能自行设计退避策略。

---

## 5. 讨论：429 由什么驱动？

综合两次实验与生产数据，B 类 429 的频率由**三个因素叠加**驱动：

| 因素 | 证据 | 影响量级 |
|---|---|---|
| **时段** | 深夜 3.4% → 傍晚 43.3%（单模型） | 约 13 倍 |
| **突发性** | 十分钟内 255 次后骤降 | 突发 >> 平稳 |
| **模型** | deepseek-flash 76% vs v4-flash 32% | 约 2.4 倍 |

**而非**单次请求的 token 量（实验二已证伪）。

### 5.1 外部佐证

检索发现 **Anthropic 已官方公开承认**采用"高峰时段动态收紧"机制
（[The Register, 2026-03-26](https://www.theregister.com/2026/03/26/anthropic_tweaks_usage_limits/)）：

> "To manage growing demand for Claude we're adjusting our five hour session limits ... **during peak hours**."
> （为管理需求增长，我们在**高峰时段**调整 5 小时会话限制）

| 项 | Anthropic 官方 |
|---|---|
| 高峰时段 | 05:00–11:00 PT（= 北京 20:00–02:00） |
| 机制 | **总周配额不变，只改变它在时间上的分配** |
| 官方建议 | **"把 token 密集型后台任务挪到非高峰时段，能延长会话限制"** |
| 影响面 | 约 7% 用户会撞到以前不会撞的限制 |

**这条佐证的意义**：
1. "动态分时限流"是业界真实做法，非臆测
2. 其机制描述（总配额不变、只改时间分配）与本研究观测高度一致
3. 官方建议与本研究工程结论（深夜是安全窗口）吻合

**但必须说明**：Anthropic 的做法是**公告过的**；SenseNova 是否也如此**没有公开确认**，本研究的判断属于**基于观测的假设**。

### 5.2 佐证强度评估（诚实标注）

| 结论 | 强度 | 依据 |
|---|---|---|
| 动态分时限流存在 | 🟢 强 | Anthropic 官方公告 |
| SenseNova 也是动态分时 | 🟡 中 | 仅本研究观测推断，无官方确认 |
| TPM/RPM 双闸存在 | 🟢 强 | SenseNova 官方[计费文档](https://console.sensecore.cn/micro/help/docs/model-as-a-service/nova/pricing/)明确 |
| "150 次/5h"不成立 | 🟢 强 | 本研究 3043 次请求实证 |
| 傍晚高峰 / 深夜低谷 | 🟡 中 | 单数据源 + 假期窗口，需工作日复验 |

---

## 6. 局限（完整清单）

1. 🔴 **时段不可比**：实验一白天、实验二凌晨，跨实验对比有时段混淆
2. 🔴 **假期/周末混杂（重要）**：两次实验均落在**国庆黄金周 + 周末**（2026-10-03 周六 / 10-04 周日）。假期用户结构异于工作日，可能影响平台负载与活跃时段分布。**所有时段结论严格限定为"假期期间观测"**
3. **生产数据样本不均衡**：深夜 n=13–263、白天 n=9–278、傍晚 n=75–473；小样本时段置信度低
4. **突发性结论基于单次事件**：某日傍晚 18:20 的 255 次爆发是否可复现，需更多天数据；观测期仅 5 天
5. **实验二仅单模型**：deepseek-v4-flash；实验一提示 deepseek-flash 的 B 类率远高（~80%），未在受控实验复现
6. **实验一部分任务未跑满**（被 7h 时限截断）
7. **积分池采样部分失败**（凭证过期），护栏仅单账号生效
8. **A 类墙"未触发"≠"不存在"**：本实验节奏下不可达，不排除更高频/打满积分池时会触发
9. **平台策略可能随时间调整**：社区 2026-05 口径与本研究 2026-10 观测已不一致
10. **时段与突发性在观测数据中难以完全分离**：傍晚高峰也可能是"傍晚用户更爱跑批量任务"

---

## 7. 后续实验建议

若要在工作日复验并分离三因素，建议六段对照（每段 3 小时）：

| 段 | 时段 | 星期 | 模型 | 负载 | 目的 |
|---|---|---|---|---|---|
| S1 | 深夜 02–05 | 任意 | v4-flash | 平稳 | 低谷基线 |
| S2 | 白天 10–13 | 任意 | v4-flash | 平稳 | 白天对照 |
| S3 | 傍晚 18–21 | 任意 | v4-flash | 平稳 | 高峰验证 |
| S4 | 傍晚 18–21 | 同 S3 | v4-flash | **突发** | 突发性验证 |
| S5 | 傍晚 18–21 | 同 S3 | deepseek-flash | 平稳 | 模型差异 |
| S6 | 傍晚 18–21 | **工作日** | v4-flash | 平稳 | **假期 vs 工作日** |

总计约 2160 请求，积分消耗约 1.2%。判定标准：Fisher 精确检验，α=0.0125。

---

## 8. 数据与复现

- `experiment-1/results.ndjson` — 963 请求全字段
- `experiment-2/results.ndjson` — 2080 请求全字段
- `experiment-2/blocks.ndjson` — 104 块级汇总
- `charts/` — 4 张图表源文件
- 复现程序：`loader.mjs` / `runner.mjs`（压测器）、`analyze.mjs`（分析器）、`config.json`（配置）
- 运行环境：Node.js ≥ 20（原生 fetch + node:sqlite）

**复现命令**：
```bash
# 需自行准备 SenseNova 账号的 API key，写入环境变量或 nodes.csv
cd experiment-2
touch GO
node runner.mjs --go
node analyze.mjs
```

---

## 9. 致谢

感谢商汤 SenseNova 免费 Token Plan 提供的测试资源。

---

## 10. AI 使用声明

本研究在**人类作者主导**的前提下，部分环节使用了 AI 助手（大语言模型）辅助，具体分工如下：

### 由人类作者完成

- 研究问题的提出与界定
- 实验方案的方向性决策（是否做对照、做几组、跑多久）
- 实验的实际执行环境与账号资源
- 对结论的审阅、判断与最终认可
- 对 AI 产出的逐项核查与修正

### 由 AI 助手辅助完成

- **代码实现**：压测器、分析器的代码编写（`loader.mjs` / `runner.mjs` / `analyze.mjs`）
- **数据整理**：原始请求记录的结构化与聚合统计
- **图表绘制**：4 张图表的绘制脚本
- **文稿起草**：本报告的结构编排与初稿撰写
- **文献检索**：外部佐证材料的检索（如 Anthropic 相关公开报道）

### 声明要点

1. **所有实验数据均由真实请求产生**，未经 AI 生成或修改。原始数据文件（`results.ndjson`）可供独立核验。
2. **所有统计结论均可由随附数据与脚本复现**——读者可运行 `analyze.mjs` 自行验证每一个数字。
3. **AI 产出的内容经过人类作者审阅**，但**作者对本文的全部内容负责**，包括可能存在的错误。
4. 本声明遵循学术出版中日益通行的 AI 使用透明化原则（如 COPE、ICMJE 的相关指引精神）。

> 若读者发现任何与数据不符之处，欢迎通过仓库 Issues 反馈。

---

*本文档采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 协议授权：允许自由转载、改编、商用，仅需保留署名并注明是否修改。*

*所有数字均可由随附数据文件复现。本研究为个人探索性研究，欢迎指正与继续研究。*
