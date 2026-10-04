/**
 * 实验二运行器：sensenova 429 的 TPM / RPM 维度分离（2×2 析因 · 区组随机化）
 *
 * 修正实验一缺陷（账号×臂混淆）的做法：
 *   - 【同一账号、同一模型】内跑全部 4 条臂 → 臂效应不含账号差异
 *   - 【相位分离】：同一账号同一时刻只跑一条臂 → 无臂间 TPM 桶串扰，429 可归因
 *   - 【区组随机化】：每轮 4 臂随机排序 + 多轮重复 → 消除时间趋势
 *   - 【双账号并行】：两账号配额独立，并行执行；账号是重复样本（replicate）
 *
 * 2×2 析因：RPM(1 vs 4/min) × 输入规模(90 vs 8000 tok)
 *   A1 lo_lo(90tpm)  A2 lo_hi(8000tpm)  A3 hi_lo(360tpm)  A4 hi_hi(32000tpm)
 *
 * 用法：
 *   node runner.mjs --dry-run    只打印调度计划（不发请求）—— 默认安全
 *   node runner.mjs --self-test  用本地 mock 上游验证控制流（不发真实请求）
 *   node runner.mjs --go         真正开始实验（需显式加 --go 以防误启动）
 *
 * 环境：若所在网络需代理才能访问平台，设置 HTTPS_PROXY=http://<host>:<port>
 * 产物：results.ndjson（每次请求）/ blocks.ndjson（每块汇总）/ runner.log / checkpoint.json
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const MODE = process.argv.includes('--go') ? 'go'
  : process.argv.includes('--self-test') ? 'selftest'
  : 'dry';

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PATHS = {
  results: join(HERE, 'results.ndjson'),
  blocks: join(HERE, 'blocks.ndjson'),
  log: join(HERE, 'runner.log'),
  cp: join(HERE, 'checkpoint.json'),
};

function log(msg) {
  const l = `[${nowIso()}] ${msg}`;
  console.log(l);
  try { appendFileSync(PATHS.log, l + '\n'); } catch { /* dry 模式目录可能未建 */ }
}
function emit(file, obj) {
  try { appendFileSync(file, JSON.stringify(obj) + '\n'); } catch { /* ignore */ }
}

// ---------- 确定性随机（mulberry32）----------
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- 提示词（可按真实 usage 自动重校准）----------
function estimateTokens(text) {
  let cjk = 0, ascii = 0;
  for (const ch of text) (ch.codePointAt(0) > 0x2e7f ? cjk++ : ascii++);
  return Math.round(cjk * 1.6 + ascii * 0.25);
}
const calibration = new Map(); // armId → { ratio, samples }
const CAL_RATIO_MIN = 0.15, CAL_RATIO_MAX = 1.6; // 合理范围钳制，防异常值污染
function buildPrompt(arm) {
  if (arm.promptKind === 'small') return CFG.prompts.small; // small 臂是固定短提示词，不参与校准
  const seed = CFG.prompts.seed;
  const per = estimateTokens(seed) || 1;
  const cal = calibration.get(arm.id);
  const ratio = cal?.ratio ?? CFG.prompt_calibration_init;
  const reps = Math.max(1, Math.round((arm.targetTokens / ratio) / per));
  return seed.repeat(reps);
}
function recalibrate(arm, estTokens, realTokens) {
  // 只校准 seed 臂（small 臂的提示词不按 target 构造，校准无意义且会污染）
  if (arm.promptKind === 'small') return;
  if (!realTokens || realTokens <= 0 || !estTokens) return;
  const raw = realTokens / estTokens;
  if (raw < CAL_RATIO_MIN || raw > CAL_RATIO_MAX) {
    log(`  ↳ 校准 臂${arm.name}(${arm.id}) 跳过：比例 ${raw.toFixed(3)} 超出合理范围 [${CAL_RATIO_MIN}, ${CAL_RATIO_MAX}]`);
    return;
  }
  const prev = calibration.get(arm.id);
  if (!prev) {
    calibration.set(arm.id, { ratio: raw, samples: 1 });
    log(`  ↳ 校准 臂${arm.name}(${arm.id}): 估算 ${estTokens} → 真实 ${realTokens}（比例 ${raw.toFixed(3)}，下一块生效）`);
  } else {
    const smoothed = prev.ratio * 0.7 + raw * 0.3;
    calibration.set(arm.id, { ratio: smoothed, samples: prev.samples + 1 });
    if (prev.samples < 3) log(`  ↳ 校准 臂${arm.name}(${arm.id}) 更新: 比例 ${prev.ratio.toFixed(3)} → ${smoothed.toFixed(3)}（样本 ${prev.samples + 1}）`);
  }
}

// ---------- 429 分类：按【文案】而非 code（实验一的结论）----------
function classify(status, bodyText) {
  if (status !== 429) return null;
  const t = String(bodyText ?? '');
  if (/entitlement/i.test(t)) return 'A'; // 唯一可靠 A 类判据
  if (/tpm|rpm|rps|rate.?limit|throttl|insufficient_quota|429003/i.test(t)) return 'B';
  return 'X';
}

// ---------- API key ----------
const keyCache = {};
function getApiKey(account) {
  const envName = account.endsWith('1') ? 'SENSENOVA1_API_KEY' : 'SENSENOVA2_API_KEY';
  if (process.env[envName]) return process.env[envName];
  if (keyCache[account]) return keyCache[account];
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    join(HERE, '..', '..', 'nodes.csv'),      // <项目根>/nodes.csv
    join(HERE, '..', 'nodes.csv'),            // 上级目录（兜底）
    join(home, 'nodes.csv'),                  // 用户目录
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/).slice(1)) {
      const cols = line.split(',');
      if (cols[0] === account && cols[3]) { keyCache[account] = cols[3].trim(); return keyCache[account]; }
    }
  }
  throw new Error(`找不到 ${account} 的 API key（候选: ${candidates.join(' / ')}）`);
}

// ---------- 请求 ----------
let MOCK_BASE = null;
async function doRequest(account, arm, prompt, ctx) {
  const body = JSON.stringify({
    model: CFG.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: CFG.max_tokens, stream: false,
  });
  const rec = {
    ts: nowIso(), account, armId: arm.id, arm: arm.name, size: arm.size, rpmBand: arm.rpm,
    cycle: ctx.cycle, blockIdx: ctx.blockIdx, reqInBlock: ctx.reqInBlock,
    intervalMs: arm.intervalMs, targetTokens: arm.targetTokens, estTokens: estimateTokens(prompt),
  };
  const t0 = Date.now();
  let status = 0, text = '', netErr = null;
  for (let attempt = 0; attempt <= CFG.net_retry; attempt++) {
    try {
      const resp = await fetch(`${MOCK_BASE ?? CFG.base_url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${getApiKey(account)}` },
        body, signal: AbortSignal.timeout(CFG.request_timeout_ms),
      });
      status = resp.status;
      text = (await resp.text()).slice(0, 1200);
      netErr = null;
      break;
    } catch (e) {
      netErr = e.name === 'TimeoutError' ? 'timeout' : (e.name || 'network');
      status = 0;
      if (attempt < CFG.net_retry) await sleep(CFG.net_retry_backoff_ms);
    }
  }
  rec.status = status;
  rec.latencyMs = Date.now() - t0;
  if (netErr) rec.netError = netErr;
  if (text) {
    rec.bodyLen = text.length;
    try {
      const j = JSON.parse(text);
      if (j?.error) { rec.errorMessage = j.error.message; rec.errorCode = j.error.code; rec.errorType = j.error.type; }
      if (j?.usage) { rec.promptTokensActual = j.usage.prompt_tokens; rec.completionTokens = j.usage.completion_tokens; }
    } catch { /* 非 JSON */ }
  }
  rec.class429 = classify(status, rec.errorMessage ?? text);
  return rec;
}

// ---------- 一个块（一条臂在一个账号上连续跑 N 次，节奏固定）----------
async function runBlock(account, arm, ctx) {
  const prompt = buildPrompt(arm);
  const block = {
    ts: nowIso(), account, armId: arm.id, arm: arm.name, size: arm.size, rpmBand: arm.rpm,
    cycle: ctx.cycle, blockIdx: ctx.blockIdx,
    planned: arm.requestsPerBlock, intervalMs: arm.intervalMs, targetTokens: arm.targetTokens,
    estTokens: estimateTokens(prompt), startTs: nowIso(),
    sent: 0, ok: 0, b429: 0, a429: 0, x429: 0, net: 0, other: 0,
    realTokensSum: 0, realTokensN: 0,
  };
  for (let i = 0; i < arm.requestsPerBlock; i++) {
    if (Date.now() > ctx.deadline) { log(`[${account}/${arm.name}] deadline，块提前结束`); break; }
    if (ctx.shouldStop()) { log(`[${account}/${arm.name}] 停止条件触发，块提前结束`); break; }
    if (i > 0) await sleep(arm.intervalMs);

    const rec = await doRequest(account, arm, prompt, { ...ctx, reqInBlock: i + 1 });
    rec.blockTs = block.startTs;
    emit(PATHS.results, rec);

    block.sent++;
    if (rec.status >= 200 && rec.status < 400) {
      block.ok++;
      if (rec.promptTokensActual) {
        block.realTokensSum += rec.promptTokensActual;
        block.realTokensN++;
        recalibrate(arm, rec.estTokens, rec.promptTokensActual);
      }
    } else if (rec.status === 429) {
      if (rec.class429 === 'A') block.a429++;
      else if (rec.class429 === 'B') block.b429++;
      else block.x429++;
    } else if (rec.status === 0) block.net++;
    else block.other++;

    if (rec.class429 === 'A') log(`🔴 [${account}/${arm.name}] A 类 entitlement（cycle ${ctx.cycle} 第 ${i + 1} 次）`);
  }
  block.endTs = nowIso();
  const secs = Math.max(1, (Date.parse(block.endTs) - Date.parse(block.startTs)) / 1000);
  block.durationSec = +secs.toFixed(1);
  block.realizedRpm = +(block.sent / (secs / 60)).toFixed(2);
  block.realizedTpm = block.realTokensN ? Math.round(block.realTokensSum / (secs / 60)) : null;
  block.bRate = block.sent ? +(block.b429 / block.sent).toFixed(4) : null;
  emit(PATHS.blocks, block);
  return block;
}

// ---------- 积分池护栏 ----------
function readAccessToken(account) {
  const f = account.endsWith('1') ? 'sensenova-token-1.txt' : 'sensenova-token-2.txt';
  const home = process.env.HOME || process.env.USERPROFILE || '';
  for (const p of [join(HERE, f), join(HERE, '..', f), join(home, f)]) {
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, 'utf8').trim();
    if (!raw) continue;
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object') {
        if (typeof j.access_token === 'string') return j.access_token;
        if (typeof j.token === 'string') return j.token;
      }
    } catch { /* 纯 token */ }
    return raw;
  }
  return null;
}
async function fetchPoolPct(account) {
  const tok = readAccessToken(account);
  if (!tok) return null;
  try {
    const r = await fetch('https://platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage', {
      headers: { authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return null;
    const j = JSON.parse(await r.text());
    const pools = j?.data?.pools ?? j?.pools ?? [];
    const pool = (Array.isArray(pools) ? pools : []).find((p) => p?.pool_type !== 'dedicated');
    const w5 = pool?.window_5h ?? pool?.window5h ?? null;
    if (!w5) return null;
    const used = Number(w5.used ?? NaN), limit = Number(w5.limit ?? NaN);
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
    return { used, limit, pct: used / limit };
  } catch { return null; }
}
async function samplePool(account, tag) {
  const p = await fetchPoolPct(account);
  emit(PATHS.results, {
    ts: nowIso(), kind: 'pool_sample', tag, account,
    ...(p ? { poolUsed: p.used, poolLimit: p.limit, poolPct: +p.pct.toFixed(4) } : { poolPct: null }),
  });
  if (p) log(`[pool] ${account} ${(p.pct * 100).toFixed(1)}%（${p.used}/${p.limit}）tag=${tag}`);
  else log(`[pool] ${account} 拉取失败（token 可能过期）tag=${tag}`);
  return p;
}

// ---------- 调度（每账号独立随机序）----------
function buildPlan(cycles = CFG.cycles, accounts = CFG.accounts) {
  const rng = makeRng(CFG.random_seed);
  const plan = [];
  let idx = 0;
  for (let cycle = 1; cycle <= cycles; cycle++) {
    for (const account of accounts) {
      const order = shuffle(CFG.arms.map((a) => a.id), rng);
      for (const armId of order) {
        plan.push({ idx: idx++, cycle, account, arm: CFG.arms.find((a) => a.id === armId) });
      }
    }
  }
  return plan;
}
function printPlan(plan, accounts = CFG.accounts) {
  console.log('\n调度计划（相位分离 · 每轮随机块序）：');
  let last = '';
  for (const b of plan) {
    const key = `cycle${b.cycle}/${b.account}`;
    if (key !== last) { console.log(`  —— ${key}`); last = key; }
    console.log(`    #${String(b.idx).padStart(3)} ${b.arm.name}(${b.arm.id.padEnd(5)}) ${String(b.arm.intervalMs / 1000).padStart(3)}s × ${String(b.arm.requestsPerBlock).padStart(2)} 次  target≈${String(b.arm.targetTokens).padStart(5)} tok`);
  }
  console.log('\n  总块数:', plan.length);
  const perAcct = {};
  for (const b of plan) perAcct[b.account] = (perAcct[b.account] ?? 0) + b.arm.requestsPerBlock;
  for (const [a, n] of Object.entries(perAcct)) console.log(`  ${a}: ${n} 请求`);
  const blocksPerAcct = plan.length / accounts.length;
  const blockSec = Math.max(...CFG.arms.map((a) => a.requestsPerBlock * a.intervalMs)) / 1000;
  const est = (blocksPerAcct * (blockSec + CFG.inter_block_gap_ms / 1000)) / 3600;
  console.log(`  预计挂钟时长: ${est.toFixed(2)} h（账号并行；按最长块 ${blockSec}s 估算）`);
}

// ---------- 断点续跑：读出已完成块，跳过 ----------
function completedBlocks() {
  if (!existsSync(PATHS.blocks)) return new Set();
  const done = new Set();
  for (const line of readFileSync(PATHS.blocks, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const b = JSON.parse(line); if (b && Number.isInteger(b.blockIdx)) done.add(b.blockIdx); } catch { /* 跳过坏行 */ }
  }
  return done;
}

// ---------- 主流程 ----------
async function main() {
  mkdirSync(HERE, { recursive: true });
  const plan = buildPlan();

  if (MODE === 'dry') {
    printPlan(plan);
    console.log('\n[dry-run] 未发送任何请求。正式运行请加 --go\n');
    return;
  }
  if (MODE === 'selftest') return selfTest();

  // ===== 正式运行 =====
  // 防误启动二次确认：要求存在 GO 标记文件（由用户/我显式创建）
  if (!existsSync(join(HERE, 'GO'))) {
    console.error('拒绝启动：缺少 GO 标记文件。请先创建 data/429-experiment-2/GO 再运行 --go。');
    process.exit(2);
  }
  // 已有结果的保护：非空 results.ndjson 时要求 --append 或清空
  if (existsSync(PATHS.results) && readFileSync(PATHS.results, 'utf8').trim() && !process.argv.includes('--append')) {
    console.error('拒绝启动：results.ndjson 已有数据。请清空或加 --append。');
    process.exit(3);
  }

  log('===== 实验二启动 =====');
  log(`模型=${CFG.model} | 账号=${CFG.accounts.join(',')} | 轮数=${CFG.cycles} | 4 臂 × 每轮`);
  log(`析因：RPM(1 vs 4/min) × 尺寸(90 vs 8000 tok) | B 类退避=${CFG.b429_backoff_ms}ms`);
  printPlan(plan);

  const startedAt = Date.now();
  const deadline = startedAt + CFG.global_deadline_hours * 3600e3;
  const stopState = { pool: false };

  const poolTimer = setInterval(async () => {
    for (const a of CFG.accounts) {
      const p = await samplePool(a, 'periodic');
      if (p && p.pct >= CFG.pool_stop_pct && !stopState.pool) {
        stopState.pool = true;
        log(`🛑 池用量 ≥ ${(CFG.pool_stop_pct * 100).toFixed(0)}%，停止启动新块`);
      }
    }
  }, CFG.pool_poll_interval_ms);
  poolTimer.unref?.();

  for (const a of CFG.accounts) await samplePool(a, 'start');

  // 每账号一个串行执行器（并行）
  async function runAccount(account) {
    const done = completedBlocks();
    const mine = plan.filter((b) => b.account === account);
    const todo = mine.filter((b) => !done.has(b.idx));
    if (done.size) log(`[${account}] 断点续跑：已完成 ${mine.length - todo.length} 块，待跑 ${todo.length} 块`);
    let netFailStreak = 0;
    for (const b of todo) {
      if (Date.now() > deadline) { log(`[${account}] deadline，本账号停止`); break; }
      if (stopState.pool) { log(`[${account}] 池护栏，本账号停止`); break; }
      const ctx = {
        cycle: b.cycle, blockIdx: b.idx, deadline,
        shouldStop: () => stopState.pool || Date.now() > deadline,
      };
      log(`── [${account}] 块 #${b.idx} 臂=${b.arm.name}(${b.arm.id}) cycle=${b.cycle}`);
      const blk = await runBlock(account, b.arm, ctx);
      log(`   [${account}] 块 #${b.idx} 完成 sent=${blk.sent} ok=${blk.ok} B=${blk.b429} A=${blk.a429} X=${blk.x429} net=${blk.net} B率=${blk.bRate == null ? '-' : (blk.bRate * 100).toFixed(0) + '%'} RPM=${blk.realizedRpm} TPM=${blk.realizedTpm ?? '-'}`);
      emit(PATHS.cp, { savedAt: nowIso(), account, blockIdx: b.idx, arm: b.arm.id, sent: blk.sent });
      netFailStreak = blk.net > 0 && blk.net === blk.sent ? netFailStreak + 1 : 0;
      if (netFailStreak >= 20) { log(`💥 [${account}] 连续 20 块全网络失败，中止本账号`); break; }
      await sleep(CFG.inter_block_gap_ms);
    }
  }

  await Promise.all(CFG.accounts.map((a) => runAccount(a)));

  clearInterval(poolTimer);
  for (const a of CFG.accounts) await samplePool(a, 'end');
  log(`===== 实验二结束（耗时 ${((Date.now() - startedAt) / 3600e3).toFixed(2)} h）=====`);
}

// ---------- 自检（mock 上游，不发真实请求）----------
async function selfTest() {
  let n = 0;
  const server = createServer((req, res) => {
    n++;
    const isB = n % 7 === 0;   // 每 7 次一个 B 类，验证分类
    const isA = n % 53 === 0;  // 偶发 A 类，验证 A 类识别
    if (isA) {
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'token plan entitlement exhausted', code: '8', type: 'quota_exceeded_error' } }));
    }
    if (isB) {
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'inference exceeds tpm/rpm limit', code: 'RateLimitExceeded.EndpointTPMExceeded' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '好的' } }],
      usage: { prompt_tokens: 3120, completion_tokens: 5 },  // 用于验证自动校准
    }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  MOCK_BASE = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.SENSENOVA1_API_KEY = 'mock-key-1';
  process.env.SENSENOVA2_API_KEY = 'mock-key-2';

  console.log('=== self-test：控制流验证（本地 mock 上游，不触及真实 API）===');
  const arms = CFG.arms.map((a) => ({ ...a, requestsPerBlock: 6, intervalMs: 20 }));
  for (const arm of arms) {
    const blk = await runBlock('sensenova-1', arm, { cycle: 0, blockIdx: 0, reqInBlock: 0, deadline: Date.now() + 60000, shouldStop: () => false });
    console.log(`  ${arm.name}(${arm.id}): sent=${blk.sent} ok=${blk.ok} B=${blk.b429} A=${blk.a429} X=${blk.x429} net=${blk.net} B率=${(blk.bRate * 100).toFixed(0)}% 校准后 est=${blk.estTokens}`);
  }
  const cal = [...calibration.entries()].map(([k, v]) => `${k}:${v.ratio.toFixed(3)}`).join(' ');
  console.log(`  校准表: ${cal || '(无)'}`);
  console.log('  分类抽检:');
  console.log(`    429+entitlement  → ${classify(429, 'token plan entitlement exhausted')}  (期望 A)`);
  console.log(`    429+tpm/rpm      → ${classify(429, 'inference exceeds tpm/rpm limit')}  (期望 B)`);
  console.log(`    429+code8+rpm    → ${classify(429, '{"message":"rpm exhausted","code":"8"}')}  (期望 B — 实验一关键反例)`);
  console.log(`    429+insufficient → ${classify(429, '{"message":"inference exceeds tpm/rpm limit","code":"insufficient_quota"}')}  (期望 B)`);
  console.log(`    200              → ${classify(200, '{}')}  (期望 null)`);
  server.close();
  console.log('\n[self-test] 通过（未使用真实上游）。');
}

main().catch((e) => { log(`FATAL: ${e.stack ?? e}`); process.exit(1); });
