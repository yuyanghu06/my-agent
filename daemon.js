import net from 'net';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

// The daemon's MCP servers (apple-calendar, google-*, linear, ghl, …) live in
// the classic ~/.claude.json top-level `mcpServers`, NOT in settings.json. The
// SDK's settingSources only loads settings.json, so we read that block once at
// startup and pass it explicitly via the SDK `mcpServers` option — guaranteeing
// the same server set the old `claude` spawn picked up by reading ~/.claude.json.
function loadGlobalMcpServers() {
  try {
    const cfgPath = path.join(process.env.HOME || '/Users/yuyang', '.claude.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const servers = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
    return { servers, count: Object.keys(servers).length };
  } catch (e) {
    return { servers: {}, count: 0, error: e.message };
  }
}
const { servers: GLOBAL_MCP_SERVERS, count: MCP_COUNT, error: MCP_ERR } = loadGlobalMcpServers();

const ROOT = process.env.CLAUDE_AGENT_ROOT || path.dirname(fileURLToPath(import.meta.url));
const SOCKET_PATH = process.env.CLAUDE_AGENT_SOCKET || '/tmp/claude-agent.sock';
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'daemon.log');
const QUERY_TIMEOUT_MS = 600_000;

fs.mkdirSync(LOG_DIR, { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  logStream.write(line);
  process.stdout.write(line);
}

let tabCounter = 0;

// Active model alias passed to the claude CLI via --model. null = CLI default
// (whatever the user's claude config selects). Set globally via the {set_model}
// control message from spotlight; applies to every tab's next query.
let activeModel = null;

// Rolling usage counters since daemon start (or since the last {reset_usage}).
// Fed from each query's `result` event, surfaced via the {usage} request so
// spotlight's /usage command can render a cost/token panel.
const usage = {
  since: Date.now(),
  turns: 0,
  costUsd: 0,
  durationMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreateTokens: 0,
  cacheReadTokens: 0,
  byModel: {}, // model -> { turns, inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens, costUsd }
};

function bucket(model) {
  return usage.byModel[model] || (usage.byModel[model] = {
    turns: 0, inputTokens: 0, outputTokens: 0,
    cacheCreateTokens: 0, cacheReadTokens: 0, costUsd: 0,
  });
}

function recordUsage(evt) {
  usage.turns += 1;
  if (typeof evt.total_cost_usd === 'number') usage.costUsd += evt.total_cost_usd;
  if (typeof evt.duration_ms === 'number') usage.durationMs += evt.duration_ms;
  const u = evt.usage || {};
  const inTok = u.input_tokens || 0;
  const outTok = u.output_tokens || 0;
  const ccTok = u.cache_creation_input_tokens || 0;
  const crTok = u.cache_read_input_tokens || 0;
  usage.inputTokens += inTok;
  usage.outputTokens += outTok;
  usage.cacheCreateTokens += ccTok;
  usage.cacheReadTokens += crTok;
  // Per-model breakdown. claude emits modelUsage keyed by model id; fall back
  // to the active alias (or "default") when it's absent.
  const mu = evt.modelUsage && typeof evt.modelUsage === 'object' ? evt.modelUsage : null;
  if (mu && Object.keys(mu).length) {
    for (const [model, m] of Object.entries(mu)) {
      const b = bucket(model);
      b.turns += 1;
      b.inputTokens += m.inputTokens || m.input_tokens || 0;
      b.outputTokens += m.outputTokens || m.output_tokens || 0;
      b.cacheCreateTokens += m.cacheCreationInputTokens || m.cache_creation_input_tokens || 0;
      b.cacheReadTokens += m.cacheReadInputTokens || m.cache_read_input_tokens || 0;
      b.costUsd += m.costUSD || m.cost_usd || 0;
    }
  } else {
    const b = bucket(activeModel || 'default');
    b.turns += 1;
    b.inputTokens += inTok;
    b.outputTokens += outTok;
    b.cacheCreateTokens += ccTok;
    b.cacheReadTokens += crTok;
    if (typeof evt.total_cost_usd === 'number') b.costUsd += evt.total_cost_usd;
  }
}

try { fs.unlinkSync(SOCKET_PATH); } catch {}

// ============================================================
// Per-tab state — keyed by tab_id STRING (not socket object).
//
// A "tab" is one logical claude conversation. The spotlight UI can run
// several in parallel, each with its own claude child process. Keying by a
// stable string (rather than the per-query socket, which the client opens
// fresh every turn) is what makes both multi-turn continuity AND concurrent
// tabs work: the captured session UUID survives across connections.
//
// Messages without a tab_id fall back to "default", so a single-tab client
// keeps working unchanged.
// ============================================================
const DEFAULT_TAB = 'default';
const tabSession = new Map();    // tabId -> captured claude session uuid
const tabResume = new Map();     // tabId -> one-shot --resume uuid (from {resume})
const tabFresh = new Set();      // tabIds whose next query starts fresh
const activeQueries = new Map(); // tabId -> { socket, q (SDK query handle), timer, aborter }
const tabQueue = new Map();      // tabId -> [ { socket, query } ]

// In-flight AskUserQuestion round-trips. The canUseTool callback parks a promise
// here keyed by a generated request_id; the {answer} control message resolves it,
// killTab/cancel rejects it so the SDK call unwinds instead of hanging forever.
const pendingQuestions = new Map(); // request_id -> { resolve, reject, tabId }

function rejectPendingForTab(tabId, reason) {
  for (const [id, p] of pendingQuestions) {
    if (p.tabId === tabId) {
      try { p.reject(new Error(reason)); } catch {}
      pendingQuestions.delete(id);
    }
  }
}

function tabIdOf(msg) {
  return typeof msg.tab_id === 'string' && msg.tab_id ? msg.tab_id : DEFAULT_TAB;
}

function killTab(tabId) {
  const aq = activeQueries.get(tabId);
  if (aq) {
    rejectPendingForTab(tabId, 'cancelled');
    try { aq.aborter?.abort(); } catch {}
    try { Promise.resolve(aq.q?.interrupt?.()).catch(() => {}); } catch {}
    clearTimeout(aq.timer);
    activeQueries.delete(tabId);
  }
}

const server = net.createServer((socket) => {
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch {
        socket.write(JSON.stringify({ error: 'Invalid JSON' }) + '\n');
        continue;
      }
      const tabId = tabIdOf(msg);

      // new_tab: allocate a fresh tab id and hand it back. The tab carries no
      // session until its first query captures one.
      if (msg.new_tab === true) {
        const id = `tab-${++tabCounter}`;
        log(`new tab ${id}`);
        try { socket.write(JSON.stringify({ new_tab_id: id }) + '\n'); } catch {}
        continue;
      }
      // close_tab: kill any in-flight child and drop all state for the tab.
      if (typeof msg.close_tab === 'string' && msg.close_tab) {
        const id = msg.close_tab;
        killTab(id);
        tabSession.delete(id);
        tabResume.delete(id);
        tabFresh.delete(id);
        tabQueue.delete(id);
        log(`closed tab ${id}`);
        try { socket.write(JSON.stringify({ closed: id }) + '\n'); } catch {}
        continue;
      }
      // set_model: change the model alias passed to claude via --model for all
      // subsequent queries. Empty string / null resets to the CLI default.
      if ('set_model' in msg) {
        const m = typeof msg.set_model === 'string' ? msg.set_model.trim() : '';
        activeModel = m || null;
        log(`model set to ${activeModel || '(default)'}`);
        try { socket.write(JSON.stringify({ model: activeModel }) + '\n'); } catch {}
        continue;
      }
      // get_model: report the currently active model alias.
      if (msg.get_model === true) {
        try { socket.write(JSON.stringify({ model: activeModel }) + '\n'); } catch {}
        continue;
      }
      // usage: report rolling cost/token counters since daemon start.
      if (msg.usage === true) {
        try {
          socket.write(JSON.stringify({ usage_stats: { ...usage, model: activeModel } }) + '\n');
        } catch {}
        continue;
      }
      // reset_usage: zero the counters and restart the window.
      if (msg.reset_usage === true) {
        usage.since = Date.now();
        usage.turns = 0; usage.costUsd = 0; usage.durationMs = 0;
        usage.inputTokens = 0; usage.outputTokens = 0;
        usage.cacheCreateTokens = 0; usage.cacheReadTokens = 0;
        usage.byModel = {};
        log('usage counters reset');
        try { socket.write(JSON.stringify({ usage_reset: true }) + '\n'); } catch {}
        continue;
      }
      // list_tabs: report the tabs that currently hold a captured session.
      if (msg.list_tabs === true) {
        const tabs = [...tabSession.entries()].map(([id, sid]) => ({ id, session_id: sid }));
        try { socket.write(JSON.stringify({ tabs }) + '\n'); } catch {}
        continue;
      }
      // fresh: the next query for this tab drops --resume so claude starts a
      // new session. Used by spotlight on /clear and when opening a new tab.
      if (msg.fresh === true) {
        tabFresh.add(tabId);
        tabResume.delete(tabId);
        log(`fresh requested for ${tabId}`);
        continue;
      }
      // resume: the next query for this tab uses --resume <uuid> so claude
      // reattaches to a specific prior session (e.g. /sessions restore).
      if (typeof msg.resume === 'string' && msg.resume.length > 0) {
        tabResume.set(tabId, msg.resume);
        tabFresh.delete(tabId);
        log(`resume requested for ${tabId} — next query --resume ${msg.resume}`);
        continue;
      }
      // answer: the client's response to an AskUserQuestion prompt. Resolves the
      // parked canUseTool promise so the SDK call continues with the user's pick.
      if (msg.answer && typeof msg.answer === 'object') {
        const { request_id, answers } = msg.answer;
        const pending = request_id && pendingQuestions.get(request_id);
        if (pending) {
          pendingQuestions.delete(request_id);
          log(`answer received for ${tabId} (req ${request_id})`);
          try { pending.resolve(answers || {}); } catch {}
        } else {
          log(`answer for unknown/stale request_id ${request_id} — ignored`);
        }
        continue;
      }
      // cancel: stop the in-flight child for THIS tab.
      if (msg.cancel === true) {
        if (activeQueries.has(tabId)) {
          log(`cancel requested for ${tabId}`);
          killTab(tabId);
          try { socket.write(JSON.stringify({ error: 'Cancelled', cancelled: true }) + '\n'); } catch {}
          processQueue(tabId);
        }
        continue;
      }
      if (!msg.query) {
        socket.write(JSON.stringify({ error: 'Missing query field' }) + '\n');
        continue;
      }
      // interrupt: cancel this tab's current query and immediately start the
      // new one. runQuery picks up the tab's captured session UUID, so the
      // re-spawn naturally --resumes the same conversation.
      if (msg.interrupt === true && activeQueries.has(tabId)) {
        log(`interrupt requested for ${tabId} — swapping query`);
        const aq = activeQueries.get(tabId);
        // Graceful swap: mark the in-flight query self-aborted and hand it the
        // follow-up to respawn once it has ACTUALLY unwound. The respawn is
        // driven by the old query's catch/normal-end (see doSwap in runQuery),
        // not a blind timer, so (a) the old stream can't leak an error/done
        // onto the shared socket and (b) the captured session uuid is preserved
        // — the swapped query --resumes the same conversation.
        aq.selfAborted = true;
        aq.pendingSwap = { socket, query: msg.query };
        rejectPendingForTab(tabId, 'cancelled');
        clearTimeout(aq.timer);
        try { aq.aborter?.abort(); } catch {}
        try { Promise.resolve(aq.q?.interrupt?.()).catch(() => {}); } catch {}
        continue;
      }
      if (activeQueries.has(tabId)) {
        const q = tabQueue.get(tabId) || [];
        q.push({ socket, query: msg.query });
        tabQueue.set(tabId, q);
      } else {
        runQuery(tabId, socket, msg.query);
      }
    }
  });
  socket.on('error', (e) => log('socket error:', e.message));
});

server.listen(SOCKET_PATH, () => {
  fs.chmodSync(SOCKET_PATH, 0o600);
  log('listening on', SOCKET_PATH);
  if (MCP_ERR) log(`WARNING: failed to load MCP servers from ~/.claude.json: ${MCP_ERR}`);
  else log(`loaded ${MCP_COUNT} MCP servers: ${Object.keys(GLOBAL_MCP_SERVERS).join(', ')}`);
});

function extractToolLabel(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['file_path', 'path', 'filePath', 'command', 'pattern', 'url', 'query', 'q']) {
    if (typeof input[k] === 'string' && input[k]) return truncate(input[k], 80);
  }
  const lower = toolName.toLowerCase();
  if (lower.includes('sendemail') || lower.includes('senddraft')) return input.to ? `to ${input.to}` : '';
  if (lower.includes('createevent') || lower.includes('updateevent')) return input.summary || input.title || '';
  if (lower.includes('listevents') || lower.includes('listmessages')) return input.calendarId || input.q || '';
  if (lower.includes('readdocument') || lower.includes('getdocument')) return input.documentId || '';
  if (lower.includes('searchdrive') || lower.includes('searchdocument')) return input.q || input.query || '';
  if (lower.includes('createnote') || lower.includes('readnote') || lower.includes('updatenote')) return input.title || '';
  return '';
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// canUseTool: auto-allow every tool (preserving the old --dangerously-skip-
// permissions behaviour) EXCEPT AskUserQuestion, which we surface to the client
// as a {question} card and block on until the matching {answer} comes back.
function makeCanUseTool(tabId, socket) {
  return async (toolName, input) => {
    if (toolName !== 'AskUserQuestion') {
      return { behavior: 'allow', updatedInput: input };
    }
    const request_id = crypto.randomUUID();
    log(`[${tabId}] AskUserQuestion -> client (req ${request_id})`);
    try {
      const answers = await new Promise((resolve, reject) => {
        pendingQuestions.set(request_id, { resolve, reject, tabId });
        socket.write(JSON.stringify({
          question: { request_id, questions: input.questions || [] },
          done: false,
        }) + '\n');
      });
      // answers: { "<exact question text>": "<chosen label(s)>" } — matches the
      // shape AskUserQuestion's own `answers` field expects.
      return { behavior: 'allow', updatedInput: { ...input, answers: answers || {} } };
    } catch (e) {
      pendingQuestions.delete(request_id);
      return { behavior: 'deny', message: 'Question cancelled' };
    }
  };
}

function runQuery(tabId, socket, query) {
  const startFresh = tabFresh.has(tabId);
  if (startFresh) {
    tabFresh.delete(tabId);
    log(`starting fresh session for ${tabId} — explicit fresh request`);
  }

  // Pick the session UUID to resume:
  //   1. fresh requested  → no resume, SDK generates a new uuid; tabSession
  //      cleared now and rewritten when the system event arrives.
  //   2. client sent {resume:<uuid>}  → one-shot override (e.g. /sessions load).
  //   3. tab already has a captured uuid from a prior turn  → resume it.
  //   4. first-ever turn on this tab  → no resume, capture the new uuid.
  let sessionToResume = null;
  if (startFresh) {
    tabSession.delete(tabId);
  } else if (tabResume.has(tabId)) {
    sessionToResume = tabResume.get(tabId);
    tabResume.delete(tabId); // one-shot
  } else {
    sessionToResume = tabSession.get(tabId) || null;
  }

  if (sessionToResume) log(`[${tabId}] resuming claude session ${sessionToResume}`);
  else log(`[${tabId}] starting fresh claude session (no saved uuid)`);
  if (activeModel) log(`[${tabId}] using model ${activeModel}`);
  log(`[${tabId}] query (fresh=${startFresh}):`, query.slice(0, 200));

  let collected = '';
  let finalResult = null;
  // Track in-flight tool_use blocks: index -> { name, inputBuf }
  const partialBlocks = {};

  const aborter = new AbortController();
  const q = sdkQuery({
    prompt: query,
    options: {
      cwd: ROOT,                                  // load my-agent/CLAUDE.md (+ @MEMORY.md)
      permissionMode: 'default',                  // 'default' so canUseTool fires
      canUseTool: makeCanUseTool(tabId, socket),
      includePartialMessages: true,               // emit stream_event chunks
      settingSources: ['user', 'project', 'local'],
      mcpServers: GLOBAL_MCP_SERVERS,             // from ~/.claude.json (see top)
      abortController: aborter,
      ...(sessionToResume ? { resume: sessionToResume } : {}),
      ...(activeModel ? { model: activeModel } : {}),
    },
  });

  // selfAborted: true only when WE aborted (cancel/interrupt/timeout) —
  // distinguishes an expected unwind from a genuine SDK error in the catch.
  // pendingSwap: set by the interrupt handler with the follow-up to run once
  // this query has unwound. Both live on the slot so the interrupt handler
  // (which holds the slot, not this closure) can mutate them.
  const slot = { socket, q, timer: null, aborter, selfAborted: false, pendingSwap: null };
  const timer = setTimeout(() => {
    log(`[${tabId}] query timeout`);
    slot.selfAborted = true;
    try { aborter.abort(); } catch {}
    try { Promise.resolve(q.interrupt?.()).catch(() => {}); } catch {}
    finishQuery(tabId, { error: `Timed out after ${QUERY_TIMEOUT_MS / 1000}s` });
  }, QUERY_TIMEOUT_MS);
  slot.timer = timer;

  activeQueries.set(tabId, slot);

  // ownsSlot: an interrupt/cancel may have replaced this tab's slot with a newer
  // query (or torn it down). Guard every socket write / finish on still owning it.
  const ownsSlot = () => {
    const owner = activeQueries.get(tabId);
    return owner && owner.q === q;
  };

  // doSwap: respawn the interrupt's follow-up after this query has fully
  // unwound. Release the slot first so the new runQuery can claim it; the
  // session uuid captured in tabSession (below) makes it resume the same
  // conversation. The follow-up streams back on the same socket, so the
  // client sees one continuous turn rather than a torn-down instance.
  const doSwap = () => {
    const sw = slot.pendingSwap;
    slot.pendingSwap = null;
    activeQueries.delete(tabId);
    if (sw && !sw.socket.destroyed) runQuery(tabId, sw.socket, sw.query);
    else processQueue(tabId);
  };

  (async () => {
    try {
      for await (const evt of q) {
        if (!ownsSlot()) return;

        // claude session id from the init system message — capture per-tab and
        // forward so the client can persist it for later resume.
        if (evt.type === 'system' && evt.session_id) {
          tabSession.set(tabId, evt.session_id);
          try { socket.write(JSON.stringify({ session_id: evt.session_id, done: false }) + '\n'); } catch {}
        }

        // text delta — stream to client
        if (
          evt.type === 'stream_event' &&
          evt.event?.type === 'content_block_delta' &&
          evt.event.delta?.type === 'text_delta'
        ) {
          const piece = evt.event.delta.text || '';
          if (piece) {
            collected += piece;
            try { socket.write(JSON.stringify({ chunk: piece, done: false }) + '\n'); } catch {}
          }
        }
        // tool_use start — record so we can buffer the input deltas
        else if (
          evt.type === 'stream_event' &&
          evt.event?.type === 'content_block_start' &&
          evt.event.content_block?.type === 'tool_use'
        ) {
          partialBlocks[evt.event.index] = { name: evt.event.content_block.name || 'tool', inputBuf: '' };
        }
        // tool_use input chunks
        else if (
          evt.type === 'stream_event' &&
          evt.event?.type === 'content_block_delta' &&
          evt.event.delta?.type === 'input_json_delta'
        ) {
          const blk = partialBlocks[evt.event.index];
          if (blk) blk.inputBuf += evt.event.delta.partial_json || '';
        }
        // tool_use end — parse the input, extract a human label, forward.
        // AskUserQuestion gets its own interactive {question} card, so skip the
        // redundant tool chip for it.
        else if (
          evt.type === 'stream_event' &&
          evt.event?.type === 'content_block_stop'
        ) {
          const blk = partialBlocks[evt.event.index];
          if (blk) {
            if (blk.name !== 'AskUserQuestion') {
              let label = '';
              try { label = extractToolLabel(blk.name, JSON.parse(blk.inputBuf)); } catch {}
              try { socket.write(JSON.stringify({ tool: blk.name, label, done: false }) + '\n'); } catch {}
            }
            delete partialBlocks[evt.event.index];
          }
        }
        // final result
        else if (evt.type === 'result') {
          try { recordUsage(evt); } catch (e) { log('usage record failed:', e.message); }
          if (evt.is_error) finalResult = { error: evt.result || 'claude reported an error' };
          else finalResult = { response: (evt.result || collected).trim() };
        }
      }

      // Generator finished normally.
      if (!ownsSlot()) return;
      clearTimeout(timer);
      // An interrupt may have ended the stream cleanly — swap to the follow-up
      // instead of emitting this (now-stale) turn's final result.
      if (slot.pendingSwap) return doSwap();
      if (finalResult?.error) finishQuery(tabId, { error: finalResult.error });
      else if (finalResult?.response !== undefined) finishQuery(tabId, { chunk: '', response: finalResult.response, done: true });
      else finishQuery(tabId, { chunk: '', response: collected.trim(), done: true });
    } catch (err) {
      // Aborts from interrupt/cancel/timeout land here. An interrupt swap takes
      // priority: respawn the follow-up. Otherwise, if we triggered the abort or
      // a newer query owns the slot, this is an expected unwind — stay quiet.
      clearTimeout(timer);
      if (slot.pendingSwap) return doSwap();
      if (slot.selfAborted || !ownsSlot()) return;
      finishQuery(tabId, { error: `claude error: ${err?.message || String(err)}` });
    }
  })();
}

function finishQuery(tabId, payload) {
  const aq = activeQueries.get(tabId);
  if (!aq) return;
  activeQueries.delete(tabId);
  try { aq.socket.write(JSON.stringify(payload) + '\n'); }
  catch (e) { log('write failed:', e.message); }
  processQueue(tabId);
}

function processQueue(tabId) {
  if (activeQueries.has(tabId)) return;
  const q = tabQueue.get(tabId);
  if (!q || q.length === 0) return;
  const next = q.shift();
  if (next.socket.destroyed) return processQueue(tabId);
  runQuery(tabId, next.socket, next.query);
}

function shutdown(sig) {
  log(`received ${sig} — shutting down`);
  server.close();
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  for (const aq of activeQueries.values()) {
    try { aq.aborter?.abort(); } catch {}
    try { Promise.resolve(aq.q?.interrupt?.()).catch(() => {}); } catch {}
  }
  setTimeout(() => process.exit(0), 500);
}
// An always-on daemon must never die from one query's stray async error. The
// Agent SDK can surface out-of-band rejections/errors on abort or interrupt
// (e.g. q.interrupt() rejecting in single-message mode, or the child stream
// erroring after we kill it). Without these, Node's default terminates the
// process — dropping the socket and every active tab, then crash-looping under
// launchd. Log and keep serving; real bugs still show up in the log.
process.on('unhandledRejection', (reason) => {
  log('unhandledRejection (kept alive):', reason instanceof Error ? (reason.stack || reason.message) : String(reason));
});
process.on('uncaughtException', (err) => {
  log('uncaughtException (kept alive):', err?.stack || err?.message || String(err));
});
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
