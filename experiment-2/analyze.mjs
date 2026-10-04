/**
 * 实验二分析器：按预注册的分析计划（PREREGISTRATION.md §8）执行。
 *
 * 双形态：
 *   - 命令行：node analyze.mjs            → 读同目录 results.ndjson / blocks.ndjson，产出 ANALYSIS.md 等
 *   - 模块：  import { runAnalysis } from './analyze.mjs'  → 供自检脚本直接调用（避免 spawn 子进程）
 *
 * 输出：ANALYSIS.md / arm-summary.csv / block-series.csv
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * @param {object} o
 * @param {string} o.resultsPath  results.ndjson 路径
 * @param {string} o.blocksPath   blocks.ndjson 路径
 * @param {string} o.outDir       输出目录
 * @param {boolean} [o.quiet]     不打印摘要
 * @returns {{analysisPath:string, arms:object, totals:object, hypotheses:object}}
 */
export function runAnalysis({ resultsPath, blocksPath, outDir, quiet = false }) {
const RD = resultsPath;
const BD = blocksPath;

if (!existsSync(RD)) throw new Error(`缺少 ${RD}`);
const all = readFileSync(RD, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const reqs = all.filter((r) => !r.kind && r.status !== undefined);
const pools = all.filter((r) => r.kind === 'pool_sample');
const blocks = existsSync(BD) ? readFileSync(BD, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];

// ---------- 工具 ----------
const pct = (a, b) => (b ? (a / b * 100) : 0);
const f1 = (x) => (x == null ? '—' : Number(x).toFixed(1));
const f2 = (x) => (x == null ? '—' : Number(x).toFixed(2));
function med(arr) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function quant(arr, q) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; }

/** Fisher 精确检验（双侧），返回 p 值 */
function fisher2x2(a, b, c, d) {
  // 表: [[a,b],[c,d]]
  const n = a + b + c + d;
  const logFact = (x) => { let s = 0; for (let i = 2; i <= x; i++) s += Math.log(i); return s; };
  const pOf = (x) => Math.exp(logFact(a + b) + logFact(c + d) + logFact(a + c) + logFact(b + d) - logFact(n) - logFact(x) - logFact(a + b - x) - logFact(a + c - x) - logFact(d - a + x));
  const r1 = a + b, r2 = c + d, c1 = a + c;
  const lo = Math.max(0, c1 - r2), hi = Math.min(r1, c1);
  const pObs = pOf(a);
  let p = 0;
  for (let x = lo; x <= hi; x++) { const px = pOf(x); if (px <= pObs + 1e-12) p += px; }
  return Math.min(1, p);
}

// ---------- 聚合 ----------
const buckets = {}; // account|armId
const armMeta = {};
for (const r of reqs) {
  const key = `${r.account}|${r.armId}`;
  if (!buckets[key]) buckets[key] = { account: r.account, armId: r.armId, arm: r.arm, size: r.size, rpmBand: r.rpmBand, n: 0, ok: 0, b: 0, a: 0, x: 0, net: 0, other: 0, lat200: [], lat429: [], realTok: [], estTok: [] };
  const b = buckets[key];
  b.n++;
  if (r.status >= 200 && r.status < 400) { b.ok++; if (r.latencyMs) b.lat200.push(r.latencyMs); if (r.promptTokensActual) b.realTok.push(r.promptTokensActual); }
  else if (r.status === 429) {
    if (r.latencyMs) b.lat429.push(r.latencyMs);
    if (r.class429 === 'A') b.a++; else if (r.class429 === 'B') b.b++; else b.x++;
  } else if (r.status === 0) b.net++; else b.other++;
  if (r.estTokens) b.estTok.push(r.estTokens);
  armMeta[r.armId] = { arm: r.arm, size: r.size, rpmBand: r.rpmBand };
}

// 按臂合并两账号（用于主对照；账号为 replicate）
const byArm = {};
for (const b of Object.values(buckets)) {
  byArm[b.armId] ??= { armId: b.armId, arm: b.arm, size: b.size, rpmBand: b.rpmBand, n: 0, ok: 0, b: 0, a: 0, x: 0, net: 0, other: 0, realTok: [] };
  const t = byArm[b.armId];
  t.n += b.n; t.ok += b.ok; t.b += b.b; t.a += b.a; t.x += b.x; t.net += b.net; t.other += b.other;
  t.realTok.push(...b.realTok);
}
for (const t of Object.values(byArm)) {
  t.bRate = t.n ? t.b / t.n : 0;
  t.realTokMed = med(t.realTok);
}

// ---------- 报告 ----------
const md = [];
md.push('# 实验二分析报告：sensenova 429 的 TPM / RPM 维度分离', '');
md.push(`生成于 ${new Date().toISOString()}`, '');
md.push(`- 请求总数：${reqs.length} · 块数：${blocks.length} · 池采样：${pools.length}`);
md.push(`- 分类口径：按响应文案（entitlement → A；tpm/rpm/rps/rate limit/throttl/insufficient_quota/429003 → B）`, '');

// §1 总览
const totalB = reqs.filter((r) => r.class429 === 'B').length;
const totalA = reqs.filter((r) => r.class429 === 'A').length;
const totalX = reqs.filter((r) => r.class429 === 'X').length;
md.push('## 1. 总览', '');
md.push('| 指标 | 值 |');
md.push('|---|---|');
md.push(`| 请求总数 | ${reqs.length} |`);
md.push(`| 成功（2xx/3xx） | ${reqs.filter((r) => r.status >= 200 && r.status < 400).length} |`);
md.push(`| 429 总数 | ${reqs.filter((r) => r.status === 429).length} |`);
md.push(`| **B 类（频率闸）** | **${totalB}** |`);
md.push(`| **A 类（entitlement）** | **${totalA}** |`);
md.push(`| X 类（未归类，需人工检查） | ${totalX} |`);
md.push(`| 网络层失败 | ${reqs.filter((r) => r.status === 0).length} |`);
md.push('');
if (totalX > 0) {
  md.push('⚠️ 存在未归类 429，原文抽检：');
  const xs = reqs.filter((r) => r.class429 === 'X').slice(0, 5);
  for (const x of xs) md.push(`  - \`${String(x.errorMessage ?? '(无 message)').slice(0, 90)}\` code=${x.errorCode ?? '-'}`);
  md.push('');
}

// §2 每臂汇总
md.push('## 2. 各臂汇总（两账号合并，账号为重复样本）', '');
md.push('| 臂 | 代号 | RPM档 | 尺寸 | 尝试 | 成功 | B类 | A类 | **B类率** | 实测单次输入(中位) |');
md.push('|---|---|---|---|---|---|---|---|---|---|');
for (const id of ['lo_lo', 'lo_hi', 'hi_lo', 'hi_hi']) {
  const t = byArm[id]; if (!t) continue;
  md.push(`| ${t.arm} | ${id} | ${t.rpmBand} | ${t.size} | ${t.n} | ${t.ok} | ${t.b} | ${t.a} | **${f1(t.bRate)}%** | ${t.realTokMed ?? '—'} |`);
}
md.push('');
md.push('### 2.1 分账号明细', '');
md.push('| 账号 | 臂 | 代号 | 尝试 | 成功 | B类 | A类 | B类率 |');
md.push('|---|---|---|---|---|---|---|---|');
for (const k of Object.keys(buckets).sort()) {
  const b = buckets[k];
  md.push(`| ${b.account} | ${b.arm} | ${b.armId} | ${b.n} | ${b.ok} | ${b.b} | ${b.a} | ${f1(pct(b.b, b.n))}% |`);
}
md.push('');

// §3 假设检验
md.push('## 3. 假设检验（预注册 §2）', '');
const cmp = (idA, idB) => {
  const A = byArm[idA], B = byArm[idB];
  if (!A || !B) return null;
  const p = fisher2x2(A.b, A.n - A.b, B.b, B.n - B.b);
  return { A, B, p, diff: (B.bRate - A.bRate) * 100 };
};
function line(name, r, alpha) {
  if (!r) return `- ${name}：数据不足`;
  const sig = r.p < alpha ? '✅ 显著' : '❌ 不显著';
  return `- **${name}**：${r.A.arm}(${r.A.b}/${r.A.n}=${f1(r.A.bRate)}%) vs ${r.B.arm}(${r.B.b}/${r.B.n}=${f1(r.B.bRate)}%)，Δ=${r.diff >= 0 ? '+' : ''}${f1(r.diff)} pp，Fisher p=${r.p.toFixed(4)} → ${sig}`;
}
md.push('Bonferroni 校正：4 个对照 ⇒ α = 0.0125', '');
const h1 = cmp('lo_lo', 'lo_hi');
const h2 = cmp('lo_lo', 'hi_lo');
const h3 = cmp('lo_hi', 'hi_lo');   // 同 TPM 附近? 注意 A2=8000tpm, A3=360tpm，非同TPM；见下方说明
const h4 = cmp('hi_lo', 'hi_hi');
md.push(line('H1 · TPM 主效应（RPM 固定 1/min：90 → 8000 tok）', h1, 0.0125));
md.push(line('H2 · RPM 主效应（尺寸固定 90 tok：1 → 4 rpm）', h2, 0.0125));
md.push(line('H4 · 高 RPM 下的 TPM 效应（RPM 固定 4/min：90 → 8000 tok）', h4, 0.0125));
md.push(line('H3 · 参照：A2(8000tok@1rpm) vs A3(90tok@4rpm)', h3, 0.0125));
md.push('');
md.push('> 注：H3 原设计意图是"固定 TPM 变 RPM"，但 A2 的 TPM≈8000、A3 的 TPM≈360，**二者并非等 TPM**。')
md.push('> 本实验的四单元无法构造严格等 TPM 的 RPM 对照（这是 §9 局限 1 所述的设计限制）。')
md.push('> 因此 H3 仅作参照，**真正的 RPM 主效应以 H2（尺寸固定）为准**。');
md.push('');
md.push('**交互作用（H4 检验）**：');
if (h1 && h4) {
  const diffLow = h1.diff, diffHigh = h4.diff;
  md.push(`- 低 RPM 下尺寸效应：${diffLow >= 0 ? '+' : ''}${f1(diffLow)} pp`);
  md.push(`- 高 RPM 下尺寸效应：${diffHigh >= 0 ? '+' : ''}${f1(diffHigh)} pp`);
  md.push(`- 交互量（差之差）：${f1(diffHigh - diffLow)} pp ${Math.abs(diffHigh - diffLow) > 10 ? '（提示存在交互）' : '（未见明显交互）'}`);
}
md.push('');

// §4 A 类审计
md.push('## 4. A 类（entitlement）审计', '');
if (totalA === 0) {
  md.push(`- **全实验 ${reqs.length} 次请求，A 类 entitlement 0 次** —— 复现实验一结论：该墙在 1–4 rpm / 90–8000 tok 的节奏下不触发。`);
} else {
  md.push(`- 出现 **${totalA}** 次 A 类 429：`);
  md.push('');
  md.push('| ts | 账号 | 臂 | cycle | 块内序号 | 报文 | code |');
  md.push('|---|---|---|---|---|---|---|');
  for (const r of reqs.filter((x) => x.class429 === 'A')) {
    md.push(`| ${r.ts} | ${r.account} | ${r.arm} | ${r.cycle} | ${r.reqInBlock} | ${String(r.errorMessage).slice(0, 60)} | ${r.errorCode} |`);
  }
}
md.push('');

// §5 实现速率校验
md.push('## 5. 实现速率校验（自变量是否如设计达成）', '');
if (blocks.length) {
  md.push('| 臂 | 块数 | 计划速率 | 实测 RPM(中位) | 实测 TPM(中位) |');
  md.push('|---|---|---|---|---|');
  const byArmBlocks = {};
  for (const b of blocks) { byArmBlocks[b.armId] ??= []; byArmBlocks[b.armId].push(b); }
  const design = { lo_lo: '1 rpm / ~90 tpm', lo_hi: '1 rpm / ~8000 tpm', hi_lo: '4 rpm / ~360 tpm', hi_hi: '4 rpm / ~32000 tpm' };
  for (const id of ['lo_lo', 'lo_hi', 'hi_lo', 'hi_hi']) {
    const list = byArmBlocks[id]; if (!list) continue;
    md.push(`| ${list[0].arm} | ${list.length} | ${design[id]} | ${f2(med(list.map((x) => x.realizedRpm)))} | ${med(list.map((x) => x.realizedTpm).filter((x) => x != null)) ?? '—'} |`);
  }
  md.push('');
  // 校准效果
  const seedBlocks = blocks.filter((b) => b.armId === 'lo_hi' || b.armId === 'hi_hi').sort((a, b) => a.blockIdx - b.blockIdx);
  if (seedBlocks.length >= 2) {
    const first = seedBlocks[0], last = seedBlocks[seedBlocks.length - 1];
    md.push(`- 校准效果（seed 臂）：首块实测单次输入估算 ${first.estTokens} → 末块 ${last.estTokens}（目标 8000）`);
  }
}

// §6 区组 / 趋势效应
md.push('## 6. 区组与趋势检查', '');
if (blocks.length) {
  const cycles = [...new Set(blocks.map((b) => b.cycle))].sort((a, b) => a - b);
  md.push('| cycle | 尝试 | B类 | B类率 |');
  md.push('|---|---|---|---|');
  for (const c of cycles) {
    const list = blocks.filter((b) => b.cycle === c);
    const n = list.reduce((s, b) => s + b.sent, 0);
    const bb = list.reduce((s, b) => s + b.b429, 0);
    md.push(`| ${c} | ${n} | ${bb} | ${f1(pct(bb, n))}% |`);
  }
  md.push('');
  const firstHalf = cycles.slice(0, Math.ceil(cycles.length / 2));
  const secondHalf = cycles.slice(Math.ceil(cycles.length / 2));
  const rate = (cs) => { const l = blocks.filter((b) => cs.includes(b.cycle)); const n = l.reduce((s, b) => s + b.sent, 0); const bb = l.reduce((s, b) => s + b.b429, 0); return { n, bb, r: pct(bb, n) }; };
  const A = rate(firstHalf), B = rate(secondHalf);
  md.push(`- 前半程 B 类率 ${f1(A.r)}%（${A.bb}/${A.n}） · 后半程 ${f1(B.r)}%（${B.bb}/${B.n}）`);
  md.push(`- ⇒ ${Math.abs(A.r - B.r) > 15 ? '⚠️ 存在明显时间漂移，臂间比较需谨慎' : '未见明显时间漂移'}`);
}

// §6.5 按小时时段聚合（检验昼夜效应：实验二深夜启动、上午结束）
md.push('## 6.5 按小时时段聚合（昼夜效应检验）', '');
{
  const byHour = {};
  for (const r of reqs) {
    const h = String(r.ts).slice(11, 13) + ':00'; // UTC 小时
    byHour[h] ??= { n: 0, ok: 0, b: 0, a: 0, x: 0, net: 0 };
    const a = byHour[h];
    a.n++;
    if (r.status >= 200 && r.status < 400) a.ok++;
    else if (r.status === 429) {
      if (r.class429 === 'A') a.a++; else if (r.class429 === 'B') a.b++; else a.x++;
    } else if (r.status === 0) a.net++;
  }
  md.push('| 小时 (UTC) | 尝试 | 成功 | B类 | A类 | X/网络 | B类率 |');
  md.push('|---|---|---|---|---|---|---|');
  for (const h of Object.keys(byHour).sort()) {
    const a = byHour[h];
    md.push(`| ${h} | ${a.n} | ${a.ok} | ${a.b} | ${a.a} | ${a.x}/${a.net} | ${f1(pct(a.b, a.n))}% |`);
  }
  md.push('');
  // 昼夜对比：UTC 01-05（北京 09-13，白天）vs UTC 18-00（北京凌晨夜间）
  const dayHours = Object.keys(byHour).filter((h) => Number(h.slice(0, 2)) >= 1 && Number(h.slice(0, 2)) < 6);
  const nightHours = Object.keys(byHour).filter((h) => Number(h.slice(0, 2)) >= 18 || Number(h.slice(0, 2)) < 1);
  const agg = (hs) => hs.reduce((acc, h) => { const a = byHour[h]; acc.n += a.n; acc.b += a.b; return acc; }, { n: 0, b: 0 });
  const day = agg(dayHours), night = agg(nightHours);
  md.push(`- **日间（UTC 01–05，北京 09–13）**：${night.n ? `—` : '—'}（本实验夜跑，日间数据待早晨负载回升后出现）`);
  if (day.n && night.n) {
    md.push(`- 夜间（北京凌晨）：${f1(pct(night.b, night.n))}% (${night.b}/${night.n}) · 日间（北京上午）：${f1(pct(day.b, day.n))}% (${day.b}/${day.n})`);
    md.push(`- ⇒ ${day.b / day.n > night.b / night.n * 2 ? '⚠️ 昼夜效应显著：日间 B 类率远高于夜间' : '昼夜差异不显著'}`);
  }
}
md.push('');

// §7 块内位置效应
md.push('## 7. 块内位置效应', '');
const pos = {};
for (const r of reqs) {
  const k = r.reqInBlock <= 2 ? '前 2 次' : '第 3 次及以后';
  pos[k] ??= { n: 0, b: 0 };
  pos[k].n++;
  if (r.class429 === 'B') pos[k].b++;
}
for (const [k, v] of Object.entries(pos)) md.push(`- ${k}：${v.b}/${v.n} = ${f1(pct(v.b, v.n))}%`);
md.push('');

// §8 延迟
md.push('## 8. 延迟分布', '');
const l200 = reqs.filter((r) => r.status >= 200 && r.status < 400).map((r) => r.latencyMs);
const l429 = reqs.filter((r) => r.status === 429).map((r) => r.latencyMs);
md.push(`- HTTP 200：n=${l200.length} p50=${med(l200) ?? '—'}ms p95=${quant(l200, 0.95) ?? '—'}ms`);
md.push(`- HTTP 429：n=${l429.length} p50=${med(l429) ?? '—'}ms p95=${quant(l429, 0.95) ?? '—'}ms`);
md.push('');

// §9 积分池
md.push('## 9. 积分池轨迹', '');
md.push('| ts | 账号 | tag | 5h用量 | 占比 |');
md.push('|---|---|---|---|---|');
for (const p of pools) md.push(`| ${p.ts} | ${p.account} | ${p.tag} | ${p.poolUsed ?? '—'} / ${p.poolLimit ?? '—'} | ${p.poolPct == null ? '—' : (p.poolPct * 100).toFixed(1) + '%'} |`);
md.push('');

md.push('---', '');
md.push('*本报告由 analyze.mjs 按 PREREGISTRATION.md §8 的分析计划自动生成。*');

writeFileSync(join(outDir, 'ANALYSIS.md'), md.join('\n'));

// CSV
let csv = 'account,armId,arm,rpmBand,size,attempts,ok,b429,a429,x429,net,bRate\n';
for (const k of Object.keys(buckets).sort()) {
  const b = buckets[k];
  csv += `${b.account},${b.armId},${b.arm},${b.rpmBand},${b.size},${b.n},${b.ok},${b.b},${b.a},${b.x},${b.net},${(pct(b.b, b.n)).toFixed(2)}\n`;
}
writeFileSync(join(outDir, 'arm-summary.csv'), csv);

let bcsv = 'blockIdx,cycle,account,armId,arm,sent,ok,b429,a429,x429,realizedRpm,realizedTpm,bRate\n';
for (const b of blocks) {
  bcsv += `${b.blockIdx},${b.cycle},${b.account},${b.armId},${b.arm},${b.sent},${b.ok},${b.b429},${b.a429},${b.x429},${b.realizedRpm},${b.realizedTpm ?? ''},${b.bRate ?? ''}\n`;
}
writeFileSync(join(outDir, 'block-series.csv'), bcsv);

const summary = { analysisPath: join(outDir, 'ANALYSIS.md'), arms: byArm, totals: { n: reqs.length, b: totalB, a: totalA, x: totalX }, hypotheses: { h1, h2, h3, h4 } };
if (!quiet) {
  console.log('分析完成：ANALYSIS.md / arm-summary.csv / block-series.csv');
  console.log('');
  console.log('各臂 B 类率：');
  for (const id of ['lo_lo', 'lo_hi', 'hi_lo', 'hi_hi']) {
    const t = byArm[id]; if (!t) continue;
    console.log(`  ${t.arm} ${id.padEnd(6)} ${t.rpmBand}/${t.size}: ${t.b}/${t.n} = ${f1(t.bRate)}%`);
  }
  console.log(`A 类合计: ${totalA} · X 类: ${totalX}`);
  if (h1) console.log(`H1 (TPM@1rpm): p=${h1.p.toFixed(4)} Δ=${f1(h1.diff)}pp`);
  if (h2) console.log(`H2 (RPM@90tok): p=${h2.p.toFixed(4)} Δ=${f1(h2.diff)}pp`);
  if (h4) console.log(`H4 (TPM@4rpm): p=${h4.p.toFixed(4)} Δ=${f1(h4.diff)}pp`);
}
return summary;
}

// ---------- CLI 入口 ----------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    runAnalysis({
      resultsPath: join(HERE, 'results.ndjson'),
      blocksPath: join(HERE, 'blocks.ndjson'),
      outDir: HERE,
    });
  } catch (e) {
    console.error(`分析失败：${e.message}`);
    process.exit(1);
  }
}
