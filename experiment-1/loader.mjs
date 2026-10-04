/**
 * sensenova 429 触发限制实验 · 压测加载器（loader.mjs）v2
 *
 * 目标：用受控的「小臂 / 大臂」请求打到 token.sensenova.cn，精确测量
 *   A 类 429（token plan entitlement exhausted, code 8）在哪个尝试序号触发；
 *   并在封板后继续低频观察，记录模型在 5h 窗口重置后何时恢复。
 *
 * 设计要点：
 *   - 直连上游（不经过网关），避免网关的 per_node_rpm / 冷却 / banned429 污染测量。
 *   - 全局按任务队列串行；同一账号同一时刻只有一个在途请求（分流到账号级 B 类退避）。
 *   - NDJSON 全量落盘 + 每 50 次尝试 checkpoint；断点续跑。
 *   - A 类封板判据：同一任务连续 2 个 A 类 429 → 封板（成功门槛 = N-1）。
 *   - 封板后进入观察模式：每 5 分钟 1 次小请求，记录 429/200，直到 5h 窗口重置恢复或全局 deadline。
 *   - 账号级 B 类退避（tpm/rpm/rps exhausted 是瞬时闸；A 类不靠退避，靠封板）。
 *   - 池用量采样：开场 / 每次封板 / 收尾各抓一次 pool-usage（仅当 token 文件可用）。
 *   - 心跳：每 30 次尝试输出一行进度。
 *
 * 用法：  node loader.mjs
 * 环境：  若所在网络需代理才能访问平台，设置 HTTPS_PROXY=http://<host>:<port>
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));

// ========== 纯工具（先定义，state 初始化依赖它们） ==========
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 估算 token（汉字≈1.6token/字，ASCII≈0.25；两臂区分度够用）
function estimateTokens(prompt) {
  let cjk = 0, ascii = 0;
  for (const ch of prompt) (ch.codePointAt(0) > 0x2e7f ? cjk++ : ascii++);
  return Math.round(cjk * 1.6 + ascii * 0.25);
}

// 凭证文件（用于读取额度池用量，可选；不存在则跳过池采样）
function tokenCandidates(account) {
  const f = account.endsWith('1') ? 'sensenova-token-1.txt' : 'sensenova-token-2.txt';
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return [
    join(HERE, f),
    join(HERE, '..', f),
    join(home, f),
  ];
}

function readAccessToken(account) {
  for (const p of tokenCandidates(account)) {
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

/** 拉取账号的 5h/7d 积分池用量；失败返回 null（不影响主流程） */
async function fetchPoolPct(account) {
  const tok = readAccessToken(account);
  if (!tok) return null;
  const url = 'https://platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage';
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(20000) });
    if (!resp.ok) return null;
    const text = await resp.text();
    const j = JSON.parse(text);
    const pools = j?.data?.pools ?? j?.pools ?? [];
    const pool = (Array.isArray(pools) ? pools : []).find((p) => p?.pool_type !== 'dedicated');
    const w5 = pool?.window_5h ?? pool?.window5h ?? null;
    if (!w5) return null;
    const used = Number(w5.used ?? w5.usage ?? w5.consumed ?? NaN);
    const limit = Number(w5.limit ?? NaN);
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
    return { used, limit, pct: used / limit };
  } catch { return null; }
}

function buildPrompt(task) {
  if (task.arm === 'small') return CFG.prompts.small;
  const seed = CFG.prompts.large_seed;
  const per = estimateTokens(seed) || 1;
  return seed.repeat(Math.max(1, Math.round(CFG.large_target_tokens / per)));
}

function classify429(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  const m = /"message"\s*:\s*"([^"]+)"/.exec(text);
  const c = /"code"\s*:\s*"?([^",}\s]+)"?/.exec(text);
  const retry = /re(?:try_after|tryAfter)\s*["']?\s*:\s*"?(\d+)"?/.exec(text);
  return {
    message: m?.[1] ?? '(no message)',
    code: c?.[1] ?? '',
    retryAfterSec: retry ? Number(retry[1]) : null,
    kind: /entitlement/i.test(text) && c?.[1] === '8' ? 'A'
      : /tpm exhausted|rpm exhausted|rps exhausted|exceeds tpm\/rpm|\b(?:tpm|rpm|rps)\s*(?:limit|exhausted)/i.test(text) ? 'B'
      : 'other',
  };
}

function createInitialState() {
  return {
    startedAt: nowIso(),
    tasks: CFG.tasks.reduce((acc, t) => {
      acc[t.id] = {
        ...t,
        attempts: 0, ok: 0, n429A: 0, n429B: 0, nOther: 0,
        sealed: false, sealedReason: null, nAtSeal: null,
        firstWallIndex: null, last429AAt: null,
        observeMode: false, recoveredAt: null, observeOk: 0, observe429: 0,
      };
      return acc;
    }, {}),
    order: CFG.tasks.map((t) => t.id),
  };
}

// ====== 顶层状态（在 createInitialState 定义后） ======
const state = createInitialState();
// 账号无关：每个账号一个 B 类退避状态（tpm/rpm/rps 瞬时闸）
const bStateByAcct = { 'sensenova-1': { until: 0, pending: 0 }, 'sensenova-2': { until: 0, pending: 0 } };

const CP_PATH = join(HERE, 'checkpoint.json');
const NDJSON_PATH = join(HERE, 'results.ndjson');
const LOG_PATH = join(HERE, 'loader.log');

function saveCheckpoint() { writeFileSync(CP_PATH, JSON.stringify({ savedAt: nowIso(), state }, null, 2)); }
function loadCheckpoint() {
  if (!existsSync(CP_PATH)) return false;
  try {
    const cp = JSON.parse(readFileSync(CP_PATH, 'utf8'));
    if (cp?.state?.tasks) { mergeState(cp.state); return true; }
  } catch (e) { log(`checkpoint 读取失败（忽略）: ${e.message}`); }
  return false;
}
function mergeState(past) {
  state.startedAt = past.startedAt ?? state.startedAt;
  for (const tid of Object.keys(state.tasks)) {
    if (past.tasks?.[tid]) Object.assign(state.tasks[tid], past.tasks[tid]);
  }
  state.order = past.order ?? state.order;
}
function log(line) {
  const l = `[${nowIso()}] ${line}`;
  console.log(l);
  appendFileSync(LOG_PATH, l + '\n');
}
function record(row) { appendFileSync(NDJSON_PATH, JSON.stringify(row) + '\n'); }

// ---------- HTTP 请求 ----------
async function doRequest({ account, task, prompt, attemptLabel }) {
  const body = JSON.stringify({
    model: task.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: CFG.max_tokens,
    stream: false,
  });
  const row = { ts: nowIso(), account, task: task.id, model: task.model, arm: task.arm, attemptLabel, promptTokens: estimateTokens(prompt) };
  const t0 = Date.now();
  let resp, text, status, err = null;
  let key;
  try {
    key = await getApiKey(account); // 找 key：失败直接抛（暴露配置问题，不伪装成网络错误）
  } catch (e) {
    throw new Error(`[${account}] 获取 API key 失败: ${e.message}`);
  }
  try {
    resp = await fetch(`${CFG.base_url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await getApiKey(account)}` },
      body,
      signal: AbortSignal.timeout(CFG.request_timeout_ms),
    });
    status = resp.status;
    text = (await resp.text()).slice(0, 800);
  } catch (e) {
    err = e; status = 0;
  }
  row.status = status;
  row.latencyMs = Date.now() - t0;
  if (err) row.netError = err.name === 'TimeoutError' ? 'timeout' : (err.name || 'network');
  if (text) {
    row.bodyLen = text.length;
    try {
      const j = JSON.parse(text);
      if (j?.error) {
        row.errorMessage = j.error.message;
        row.errorCode = j.error.code;
        if (j.error.retry_after != null) row.retryAfterSec = j.error.retry_after;
        if (j.error.retryAfter != null) row.retryAfterSec = j.error.retryAfter;
      }
      if (j?.usage) { row.promptTokensActual = j.usage.prompt_tokens; row.completionTokens = j.usage.completion_tokens; }
    } catch { /* 非 JSON */ }
  } else if (resp?.headers?.get?.('retry-after')) {
    row.retryAfterSec = Number(resp.headers.get('retry-after'));
  }
  let kind = null;
  if (status === 429) {
    const cls = classify429(row.errorMessage || text);
    row.class429 = cls.kind;
    if (cls.retryAfterSec != null && row.retryAfterSec == null) row.retryAfterSec = cls.retryAfterSec;
    kind = cls.kind;
  }
  return { row, kind };
}

// ---------- 主流程 ----------
async function run() {
  mkdirSync(HERE, { recursive: true });
  const resumed = loadCheckpoint();
  log(`=== 启动（${resumed ? '从断点续跑' : '全新'}） ===`);
  log(`节点: ${CFG.base_url} | 任务: ${state.order.length} | 硬线: ${CFG.global_deadline_hours}h`);

  const deadline = Date.parse(state.startedAt) + CFG.global_deadline_hours * 3600e3;
  const startedWall = Date.now();

  await samplePools('start');

  let attemptsSinceCp = 0;
  outer:
  for (const tid of state.order) {
    const task = state.tasks[tid];
    if (Date.now() > deadline) { log(`[${tid}] 全局超时，结束（提前中断实验）`); break outer; }
    if (task.sealed) continue; // 封板任务统一到观察阶段处理

    const acct = task.account;
    const b = bStateByAcct[acct];
    const startIdx = task.attempts;
    const prompt = buildPrompt(task);
    log(`[${tid}] 开始：model=${task.model} arm=${task.arm} 节奏=${task.interval_ms}ms 上限=${task.max_attempts}（断点后已尝试 ${task.attempts}）`);

    for (let i = startIdx; i < task.max_attempts; i++) {
      if (Date.now() > deadline) { log(`[${tid}] 全局超时，中断当前任务`); break outer; }
      if (task.sealed) break;

      // 账号级 B 类退避（消费 pending / 等待 until）
      if (b.pending > 0) { await sleep(b.pending); b.pending = 0; }
      while (Date.now() < b.until) await sleep(Math.min(500, b.until - Date.now()));
      // 任务节奏间隔
      if (i > startIdx) await sleep(task.interval_ms);

      const { row, kind } = await doRequest({ account: acct, task, prompt, attemptLabel: i + 1 });

      task.attempts++;
      const st = row.status;
      if (st >= 200 && st < 400) task.ok++;
      else if (st === 429 && kind === 'A') {
        task.n429A++; task.last429AAt = row.ts;
        if (task.firstWallIndex == null) task.firstWallIndex = task.attempts;
        b.pending = 0; // A 类不退避（封板判据）
      } else if (st === 429 && kind === 'B') {
        task.n429B++;
        const back = Math.min(CFG.b429_backoff_max_ms, Math.max(CFG.b429_backoff_min_ms, (row.retryAfterSec ?? 11) * 1000));
        b.pending = b.pending || back; // 响应回来后的下一次请求前退避
      } else if (st !== 0) task.nOther++;

      record({ ...row, attemptsSoFar: task.attempts });

      if (task.attempts % 30 === 0) {
        log(`[${tid}] ${task.attempts}/${task.max_attempts} ok=${task.ok} A=${task.n429A} B=${task.n429B} other=${task.nOther} last429A=${task.last429AAt ?? '-'}`);
      }

      // A 类封板：连续 2 个
      if (task.n429A >= 2) {
        task.sealed = true; task.sealedReason = 'A-class x2'; task.nAtSeal = task.attempts;
        log(`[${tid}] 🔴 封板：连续 A 类 429（在第 ${task.nAtSeal} 次尝试处），进入恢复观察`);
        await samplePools(`seal:${tid}`);
        break;
      }
      if (task.attempts >= task.max_attempts) {
        task.sealed = true; task.sealedReason = 'max_attempts';
        log(`[${tid}] 达到硬上限 ${task.max_attempts}（未触发 A 类墙）`);
      }

      if (++attemptsSinceCp >= 50) { saveCheckpoint(); attemptsSinceCp = 0; }
    }

    saveCheckpoint();
    log(`[${tid}] 压测完成：attempts=${task.attempts} ok=${task.ok} A=${task.n429A} B=${task.n429B} other=${task.nOther} sealed=${task.sealed}（${task.sealedReason ?? ''}）`);
  }

  // ---- 观察阶段：全部压测跑完后，用剩余时间轮询所有封板任务，探测 5h 窗口恢复 ----
  {
    const pending = state.order.map((t) => state.tasks[t]).filter((t) => t.sealed && !t.recoveredAt);
    if (pending.length && Date.now() < deadline) {
      log(`观察阶段开始：${pending.length} 个封板任务等待恢复（剩余 ${((deadline - Date.now()) / 3600e3).toFixed(2)}h）`);
      while (Date.now() < deadline && pending.some((t) => !t.recoveredAt)) {
        const slice = Math.min(CFG.observe_interval_ms, 60000, deadline - Date.now());
        if (slice <= 0) break;
        await sleep(slice);
        for (const task of pending) {
          if (task.recoveredAt) continue;
          const { row, kind } = await doRequest({ account: task.account, task, prompt: CFG.prompts.small, attemptLabel: `observe:${task.observeOk + task.observe429 + 1}` });
          if (row.status >= 200 && row.status < 400) {
            task.observeOk++;
            task.recoveredAt = row.ts;
            record({ ...row, attemptsSoFar: task.attempts, observeRecovered: true });
            log(`[${task.id}] ✅ 恢复：${row.ts}（观察 ok=${task.observeOk}, 429=${task.observe429}）`);
          } else {
            if (row.status === 429 && kind === 'A') task.observe429++;
            record({ ...row, attemptsSoFar: task.attempts });
            log(`[${task.id}] 观察: status=${row.status} kind=${kind ?? '-'}（累计 429A=${task.observe429}）`);
          }
          saveCheckpoint();
        }
      }
      log(`观察阶段结束（${pending.filter((t) => t.recoveredAt).length}/${pending.length} 恢复）`);
    }
  }

  await samplePools('end');
  saveCheckpoint();
  log(`=== 全部结束（总耗时 ${((Date.now() - startedWall) / 3600e3).toFixed(2)}h） ===`);
}

async function samplePools(tag) {
  for (const acct of ['sensenova-1', 'sensenova-2']) {
    const pct = await fetchPoolPct(acct);
    if (pct) record({ ts: nowIso(), kind: 'pool_sample', tag, account: acct, poolUsed: pct.used, poolLimit: pct.limit, poolPct: +pct.pct.toFixed(4) });
    else record({ ts: nowIso(), kind: 'pool_sample', tag, account: acct, poolPct: null });
  }
}

const keyCache = {};
async function getApiKey(account) {
  const envName = account.endsWith('1') ? 'SENSENOVA1_API_KEY' : 'SENSENOVA2_API_KEY';
  if (process.env[envName]) return process.env[envName];
  if (keyCache[account]) return keyCache[account];
  const home = process.env.HOME || process.env.USERPROFILE || '';
  // API key 候选位置（按优先级）：项目根 nodes.csv → 上级目录 → 用户目录下
  const candidates = [
    join(HERE, '..', '..', 'nodes.csv'),      // <项目根>/nodes.csv
    join(HERE, '..', 'nodes.csv'),            // data/nodes.csv（兜底）
    join(home, 'nodes.csv'),                  // 用户目录
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/).slice(1)) {
      const cols = line.split(',');
      if (cols[0] === account && cols[3]) { keyCache[account] = cols[3].trim(); return keyCache[account]; }
    }
  }
  throw new Error(`找不到 ${account} 的 API key（候选路径: ${candidates.join(' / ')}）`);
}

run().catch((e) => { log(`FATAL: ${e.stack ?? e}`); saveCheckpoint(); process.exit(1); });