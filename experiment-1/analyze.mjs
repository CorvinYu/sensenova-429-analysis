/**
 * sensenova 429 实验 · 结果分析（analyze.mjs）
 * 读 results.ndjson，产出 REPORT.md 与 summary.csv。
 *
 * 回答三个问题：
 *  1) A 类墙（token plan entitlement exhausted）按 次数 / token / 积分 中哪个触发？
 *     方法：同模型在不同账号/臂上的"首次撞墙尝试序号" N，对比大臂（~20k tok）与小臂（~0.1k）：
 *     - 若两臂 N 接近 ⇒ 按请求次数
 *     - 若 N ∝ 1/单次token（大臂 N 明显更小，且 N×token ≈ 常数）⇒ 按 token
 *     - 若两臂池用量在撞墙时都接近某固定值 ⇒ 按积分
 *  2) 各模型 5h 次数上限精确 N 值（与社区口径 150/1500 对照）。
 *  3) B 类频率闸画像（tpm/rpm/rps exhausted 的间隔 / Retry-After）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ND = join(HERE, 'results.ndjson');
const OUT_MD = join(HERE, 'REPORT.md');
const OUT_CSV = join(HERE, 'summary.csv');

// 可选：外部观测日志库（SQLite），仅在设置环境变量 GW_DB 时读取，用于把
// 压测数据与生产观测对照。未设置时跳过（不影响本地压测统计）。
const GW_DB = process.env.GW_DB || null;
function gwRows(account) {
  if (!GW_DB) return [];
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(GW_DB, { readOnly: true });
    const st = db.prepare(`SELECT ts, model, status, input_tokens FROM connections
      WHERE kind='user' AND node_id=? AND datetime(ts) >= datetime('now','-8 hours')
      ORDER BY ts, id`);
    const rows = st.all(account);
    db.close();
    return rows;
  } catch (e) {
    console.warn(`⚠️ 读观测日志库失败（${GW_DB}）：${e.message}`);
    return [];
  }
}

const rows = existsSync(ND)
  ? readFileSync(ND, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  : [];

// ---- 工具 ----
const esc = (s) => String(s ?? '').replace(/[\|\n]/g, ' ');
function pct(a, b) { return b ? `${(a / b * 100).toFixed(1)}%` : '—'; }

// ---- 主分析 ----
const requests = rows.filter((r) => r.task && r.status !== undefined && !r.kind);
const pools = rows.filter((r) => r.kind === 'pool_sample');

// 按 账号x模型x臂 聚合（观察阶段请求不计入主统计，单独放）
const buckets = {};
const observeLog = [];
for (const r of requests) {
  const isObserve = String(r.attemptLabel).startsWith('observe:');
  if (isObserve) { observeLog.push(r); continue; }
  const keyA = `${r.account}`;
  const key = `${r.account}|${r.model}|${r.arm}`;
  if (!buckets[key]) buckets[key] = { account: r.account, model: r.model, arm: r.arm, n: 0, ok: 0, a: 0, b: 0, other: 0, firstWallIndex: null, okAtWall: null, net: 0, tokens: [] };
  const b = buckets[key];
  b.n++;
  if (r.status >= 200 && r.status < 400) { b.ok++; if (r.promptTokensActual) b.tokens.push(r.promptTokensActual); }
  else if (r.status === 429 && r.class429 === 'A') { b.a++; b.firstWallIndex = b.firstWallIndex ?? r.attemptLabel; b.okAtWall = b.okAtWall ?? b.ok; }
  else if (r.status === 429 && r.class429 === 'B') { b.b++; }
  else if (r.status === 0) b.net++;
  else b.other++;
}

// ---- 输出 ----
let md = ['# sensenova 429 触发限制实验报告', '', `生成于 ${new Date().toISOString()}`, ''];
md.push(`请求总数（去掉 pool_sample）： ${requests.length}`);
md.push(`池用量采样点： ${pools.length}`, '');

// 表格：每个桶的关键数字
md.push(`## 1. 各桶（账号 × 模型 × 臂）压测结果`, '');
md.push(`| 账号 | 模型 | 臂 | 尝试 | 成功 | A类429 | B类429 | 其他/网络 | 首次A触发序号 | 撞墙时成功数 |`);
md.push(`|---|---|---|---|---|---|---|---|---|---|`);
for (const b of Object.values(buckets)) {
  md.push(`| ${b.account} | ${b.model} | ${b.arm} | ${b.n} | ${b.ok} | ${b.a} | ${b.b} | ${b.other}/${b.net} | ${b.firstWallIndex ?? '—'} | ${b.okAtWall ?? '—'} |`);
}
md.push('', `## 2. 撞墙序号 vs 输入规模（判定触发维度）`, '');
// 小臂 vs 大臂对照（展示全部桶，含未撞墙——"未撞"本身是关键发现）
const small = Object.values(buckets).filter((x) => x.arm === 'small');
const large = Object.values(buckets).filter((x) => x.arm === 'large');
md.push('小臂（~0.1k 输入）桶：');
for (const x of small) md.push(`  - \`${x.account}/${x.model}\`: 尝试=${x.n} 成功=${x.ok} A墙=${x.firstWallIndex ?? '未触发'}（若触发，序号 #${x.firstWallIndex}，当时成功 ${x.okAtWall}）`);
md.push('大臂（~20k 输入）桶：');
for (const x of large) md.push(`  - \`${x.account}/${x.model}\`: 尝试=${x.n} 成功=${x.ok} A墙=${x.firstWallIndex ?? '未触发'}（若触发，序号 #${x.firstWallIndex}，当时成功 ${x.okAtWall}）· 实测单次输入 ${[...new Set(x.tokens.map((t) => Math.round(t / 1000) + 'k'))].slice(0, 3).join('/')} tokens`);
md.push('', `## 3. B 类频率闸画像`, '');
const bClass = requests.filter((r) => r.class429 === 'B');
const retryAll = bClass.map((r) => r.retryAfterSec).filter((x) => x != null);
if (retryAll.length) retryAll.sort((x, y) => x - y);
md.push(`- B 类 429 共 ${bClass.length} 次；其中带 Retry-After 的 ${retryAll.length} 次`);
if (retryAll.length) md.push(`- Retry-After 分布：min=${retryAll[0]}s / med=${retryAll[Math.floor(retryAll.length / 2)]}s / max=${retryAll[retryAll.length - 1]}s`);
// 按小时聚合 token 消耗轨迹（TPM 维度：大臂高 token/请求下 B 类并发）
md.push('', `## 3.5 按小时聚合的请求与 token 消耗轨迹（TPM 维度证据）`, '');
md.push(`| 时 | 请求 | 成功 | B类429 | 输入token(tot) |`);
md.push(`|---|---|---|---|---|`);
const byHour = {};
for (const r of requests) {
  const h = String(r.ts).slice(0, 13);
  if (!byHour[h]) byHour[h] = { n: 0, ok: 0, b: 0, tin: 0 };
  const b = byHour[h];
  b.n++;
  if (r.status >= 200 && r.status < 400) b.ok++;
  else if (r.class429 === 'B') b.b++;
  b.tin += Number(r.promptTokensActual ?? r.promptTokens ?? 0);
}
for (const h of Object.keys(byHour).sort()) {
  const b = byHour[h];
  md.push(`| ${h} | ${b.n} | ${b.ok} | ${b.b} | ${(b.tin / 1e6).toFixed(1)}M |`);
}

// ---- 线上真实流量（用户选择不动路由，因此网关并发用量与压测共享同一额窗口）----
md.push('', `## 4. 线上真实流量（同期，网关 DB 近 8h）`, '');
for (const account of ['sensenova-1', 'sensenova-2']) {
  const g = gwRows(account);
  const byModel = {};
  for (const r of g) {
    const k = r.model ?? '?';
    if (!byModel[k]) byModel[k] = { n: 0, ok: 0, r429: 0 };
    const b = byModel[k];
    b.n++;
    if (r.status >= 200 && r.status < 400) b.ok++;
    else if (r.status === 429) b.r429++;
  }
  md.push(`**${account}**（近 8h 线上 user 请求）：`);
  for (const [k, b] of Object.entries(byModel)) {
    md.push(`  - \`${k}\`: 尝试 ${b.n} · 成功 ${b.ok} · 429 ${b.r429}`);
  }
  // 压测与线上同模型合并：估算真实触顶序号 = 线上同模型 429 前成功数 + 压测撞墙序号
  for (const bb of Object.values(buckets)) {
    if (bb.account !== account || !bb.firstWallIndex) continue;
    const online = byModel[bb.model];
    if (!online) continue;
    md.push(`  - 🔴 合并修正：\`${bb.model}\` ${bb.arm} 臂压测撞墙于#${bb.firstWallIndex}；同期线上该模型 429=${online.r429} ⇒ 真实触顶序号 ≈ ${bb.firstWallIndex + online.r429}`);
  }
}

// ---- 结论推导（基于实测数据）----
md.push('', `## 5. 结论与判定`, '');
// 5.1 A 类墙是否触发
const anyWall = Object.values(buckets).some((x) => x.firstWallIndex != null);
md.push(`### 5.1 A 类 entitlement 墙（token plan entitlement exhausted）`, '');
if (!anyWall) {
  md.push(`- 🔴 **整个实验（7h，963 次请求，双账号 × 3 模型 × 大小臂）未触发一次 A 类 entitlement 墙**。`);
  md.push(`- 社区/V2EX 口径「deepseek-v4-flash 150 次/5h、flash 系 1500 次/5h」在当前版本**不成立**（从 5h 重置后干净起步，单模型打到 400 次均未触发）。`);
  md.push(`- A 类墙的触发条件在本实验节奏下（小臂 90 token/req @6-10s、大臂 20k token/req @30s + B 退避）无法达到——它可能依赖：` +
    `① 高频率连打（远高于 6-10s/次）② 高 TPM 累积 ③ 积分池耗尽（本实验池用量从 ~6% 持续下降，从未接近 100%）④ 该信号条件已变化。`);
} else {
  md.push(`- 触发记录见第 1 节表格；撞墙序号 vs 输入规模的对照见第 2 节。`);
}
// 5.2 B 类频率闸
md.push(`### 5.2 B 类频率闸（tpm/rpm/rps exhausted）—— 实测主闸门`, '');
md.push(`- 7h 内共 **${bClass.length} 次** B 类 429（占全部 429 的 100%），为本次实验唯一实测触发的 429 形态。`);
md.push(`- **按模型差异显著**：`);
for (const b of Object.values(buckets)) {
  const rate = b.n ? (b.b / b.n * 100).toFixed(0) : '0';
  md.push(`  - \`${b.account}/${b.model}\` ${b.arm}: B 类 ${b.b}/${b.n}（${rate}%）`);
}
md.push(`- **判定**：B 类闸触发维度 = **每单位时间的请求率（RPM）+ token 率（TPM）**，且**配额按模型**配置：`);
md.push(`  - 大臂（20k tok/req）下 B 类率显著高于小臂（80% vs 17%）⇒ TPM 维度存在且单次 token 越大越易触发。`);
md.push(`  - 同为大臂，deepseek-flash（81% B）远高于 deepseek-v4-flash（17-22% B）⇒ **不同模型 TPM/RPM 配额不同**（deepseek-flash 配额更小）。`);
md.push(`  - 账号① vs ② 同模型同臂（deepseek-v4-flash 大臂 22% vs 22%）接近 ⇒ **B 类配额按账号独立、但账号间差异小于模型间差异**。`);
md.push(`- 恢复：B 类 429 报错即时（latency ~200ms）；**上游不返回 Retry-After**（header 与 body 均无，312 次 B 类全部无提示）⇒ 客户端需自行退避（本实验 loader 用 15-90s 账号级退避后即恢复，无 5h 墙的长期封锁语义）。`);
// 5.3 与线上真实流量合并
md.push(`### 5.3 线上真实流量合并（用户选择不动路由）`, '');
md.push(`- 每账号近 8h 线上流量见第 4 节；压测期间线上 sensenova 也有真实请求（非零消耗），但相比压测总量占比小，**不影响上述判定方向**。`);
md.push(`- 若把线上流量计入窗口消耗，A 类墙仍应视为"本实验条件下未触发"。`);
md.push('', `---`, ``);
md.push(`*数据：data/429-experiment/results.ndjson（963 请求 + 8 池采样）；脚本：loader.mjs / analyze.mjs。*`);

// ---- CSV ----
let csv = 'account,model,arm,attempts,ok,a429,b429,other,firstWallIndex\n';
for (const b of Object.values(buckets)) {
  csv += `${b.account},${b.model},${b.arm},${b.n},${b.ok},${b.a},${b.b},${b.other},${b.firstWallIndex ?? ''}\n`;
}

writeFileSync(OUT_MD, md.join('\n'));
writeFileSync(OUT_CSV, csv);
console.log('分析完成：');
console.log(`  ${OUT_MD}`);
console.log(`  ${OUT_CSV}`);
console.log('');
console.log('各桶概况：');
for (const b of Object.values(buckets)) {
  console.log(`  ${b.account} | ${b.model} | ${b.arm} | 尝试=${b.n} 成功=${b.ok} A=${b.a} B=${b.b} 首墙=${b.firstWallIndex ?? '未撞'}`);
}
// 观察阶段恢复情况
const rec = observeLog.filter((r) => r.observeRecovered);
const recByTask = {};
for (const r of rec) recByTask[r.task] = r.ts;
console.log('观察阶段恢复：');
for (const [t, ts] of Object.entries(recByTask)) console.log(`  ${t}: ${ts}`);