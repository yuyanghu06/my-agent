import net from 'net';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = process.env.CLAUDE_AGENT_ROOT || path.dirname(fileURLToPath(import.meta.url));
const SOCKET_PATH = process.env.CLAUDE_AGENT_SOCKET || '/tmp/claude-agent.sock';
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'daemon.log');
const MEMORY_PATH = path.join(ROOT, 'MEMORY.md');
const QUERY_TIMEOUT_MS = 600_000;
const MEMORY_IDLE_REFRESH_MS = 5 * 60_000;

fs.mkdirSync(LOG_DIR, { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  logStream.write(line);
  process.stdout.write(line);
}

let activeQuery = null;
const queue = [];
let lastActivity = Date.now();
let memoryDirty = false;
let forceFresh = false;
// One-shot override: when set, the next runQuery uses `--resume <uuid>` so
// claude reattaches to the conversation behind that session id (instead of
// --continue, which always resumes whichever was most recent).
let resumeSessionId = null;
let lastMemoryMtime = 0;
try { lastMemoryMtime = fs.statSync(MEMORY_PATH).mtimeMs; } catch {}

try {
  fs.watch(MEMORY_PATH, () => {
    try {
      const m = fs.statSync(MEMORY_PATH).mtimeMs;
      if (m !== lastMemoryMtime) {
        lastMemoryMtime = m;
        memoryDirty = true;
        log('MEMORY.md changed — next idle session will start fresh');
      }
    } catch {}
  });
} catch (e) {
  log('memory watch failed:', e.message);
}

try { fs.unlinkSync(SOCKET_PATH); } catch {}

// Per-socket "current session UUID" — captured from claude's system event
// on every spawn, then fed back as --resume <uuid> on the next turn. This
// is the canonical multi-turn mechanism: each socket gets its own session,
// the daemon never uses --continue (which picks "most recently touched on
// disk" and races against concurrent sockets like side-chat windows).
const socketSession = new WeakMap();

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
      // fresh: drop --continue on the next query so claude starts a new
      // session. Used by spotlight on app launch and on /clear.
      if (msg.fresh === true) {
        forceFresh = true;
        resumeSessionId = null;
        log('forceFresh requested — next query starts a fresh session');
        continue;
      }
      // resume: use --resume <uuid> on the next query so claude reattaches
      // to a specific prior session. Used by spotlight when restoring a
      // saved session via /sessions.
      if (typeof msg.resume === 'string' && msg.resume.length > 0) {
        resumeSessionId = msg.resume;
        forceFresh = false;
        log(`resume requested — next query will --resume ${msg.resume}`);
        continue;
      }
      // cancel: stop the in-flight child for THIS connection
      if (msg.cancel === true) {
        if (activeQuery && activeQuery.socket === socket) {
          log('cancel requested by client');
          try { activeQuery.child.kill('SIGTERM'); } catch {}
          // child 'exit' handler will call finishQuery; we beat it to the
          // punch with an explicit cancel signal.
          clearTimeout(activeQuery.timer);
          activeQuery = null;
          try { socket.write(JSON.stringify({ error: 'Cancelled', cancelled: true }) + '\n'); } catch {}
          processQueue();
        }
        continue;
      }
      if (!msg.query) {
        socket.write(JSON.stringify({ error: 'Missing query field' }) + '\n');
        continue;
      }
      // interrupt: cancel current and immediately start the new query.
      // runQuery picks up this socket's saved session UUID automatically,
      // so the re-spawn naturally --resumes the same conversation.
      if (msg.interrupt === true && activeQuery && activeQuery.socket === socket) {
        log('interrupt requested — swapping query');
        try { activeQuery.child.kill('SIGTERM'); } catch {}
        clearTimeout(activeQuery.timer);
        activeQuery = null;
        // brief delay so the SIGTERM is processed before respawning
        setTimeout(() => runQuery(socket, msg.query), 80);
        continue;
      }
      if (activeQuery) queue.push({ socket, query: msg.query });
      else runQuery(socket, msg.query);
    }
  });
  socket.on('error', (e) => log('socket error:', e.message));
});

server.listen(SOCKET_PATH, () => {
  fs.chmodSync(SOCKET_PATH, 0o600);
  log('listening on', SOCKET_PATH);
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

function runQuery(socket, query) {
  const idleElapsed = Date.now() - lastActivity > MEMORY_IDLE_REFRESH_MS;
  const memoryFresh = memoryDirty && idleElapsed;
  const startFresh = memoryFresh || forceFresh;
  if (memoryFresh) {
    memoryDirty = false;
    log('starting fresh session — memory updated, idle elapsed');
  }
  if (forceFresh) {
    forceFresh = false;
    log('starting fresh session — explicit fresh request from client');
  }

  // Pick the session UUID to resume:
  //   1. fresh requested  → no flag, claude generates a new uuid; socketSession
  //      cleared now and rewritten when the system event arrives.
  //   2. client sent {resume:<uuid>}  → one-shot override (e.g. /sessions load).
  //   3. socket already has a captured uuid from a prior turn  → resume it.
  //   4. first-ever turn on this socket  → no flag, capture the new uuid.
  let sessionToResume = null;
  if (startFresh) {
    socketSession.delete(socket);
  } else if (resumeSessionId) {
    sessionToResume = resumeSessionId;
    resumeSessionId = null; // one-shot
  } else {
    sessionToResume = socketSession.get(socket) || null;
  }

  const args = [
    '--print',
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
  ];
  if (sessionToResume) {
    args.push('--resume', sessionToResume);
    log(`resuming claude session ${sessionToResume}`);
  } else {
    log('starting fresh claude session (no saved uuid)');
  }
  args.push(query);

  log(`query (fresh=${startFresh}):`, query.slice(0, 200));
  lastActivity = Date.now();

  const child = spawn('claude', args, {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let collected = '';
  let finalResult = null;
  let lineBuf = '';
  // Track in-flight tool_use blocks: index -> { name, inputBuf }
  const partialBlocks = {};

  const timer = setTimeout(() => {
    log('query timeout');
    try { child.kill('SIGTERM'); } catch {}
    finishQuery({ error: `Timed out after ${QUERY_TIMEOUT_MS / 1000}s` });
  }, QUERY_TIMEOUT_MS);

  activeQuery = { socket, child, timer };

  child.stdout.on('data', (data) => {
    lineBuf += data.toString('utf8');
    let idx;
    while ((idx = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.slice(0, idx);
      lineBuf = lineBuf.slice(idx + 1);
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }

      // claude session id from the init system message — forward so the
      // client can persist it for later --resume <uuid>.
      if (evt.type === 'system' && evt.session_id) {
        socketSession.set(socket, evt.session_id);
        try {
          socket.write(JSON.stringify({ session_id: evt.session_id, done: false }) + '\n');
        } catch {}
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
        const idx = evt.event.index;
        partialBlocks[idx] = { name: evt.event.content_block.name || 'tool', inputBuf: '' };
      }
      // tool_use input chunks
      else if (
        evt.type === 'stream_event' &&
        evt.event?.type === 'content_block_delta' &&
        evt.event.delta?.type === 'input_json_delta'
      ) {
        const idx = evt.event.index;
        if (partialBlocks[idx]) {
          partialBlocks[idx].inputBuf += evt.event.delta.partial_json || '';
        }
      }
      // tool_use end — parse the input, extract a human label, forward
      else if (
        evt.type === 'stream_event' &&
        evt.event?.type === 'content_block_stop'
      ) {
        const idx = evt.event.index;
        const blk = partialBlocks[idx];
        if (blk) {
          let label = '';
          try {
            const parsed = JSON.parse(blk.inputBuf);
            label = extractToolLabel(blk.name, parsed);
          } catch {}
          try { socket.write(JSON.stringify({ tool: blk.name, label, done: false }) + '\n'); } catch {}
          delete partialBlocks[idx];
        }
      }
      // final result
      else if (evt.type === 'result') {
        if (evt.is_error) {
          finalResult = { error: evt.result || 'claude reported an error' };
        } else {
          finalResult = { response: (evt.result || collected).trim() };
        }
      }
    }
  });

  child.stderr.on('data', (chunk) => log('claude stderr:', chunk.toString().trim()));

  child.on('exit', (code, signal) => {
    // Race guard: if the interrupt path SIGTERM'd this child and replaced
    // activeQuery with a NEW query, ignore this exit completely. Otherwise
    // we'd write a spurious `claude exited with code 143` against the new
    // query's socket and tear it down. The interrupt handler already cleared
    // its own timer; only finish for OUR own activeQuery.
    if (!activeQuery || activeQuery.child !== child) return;
    clearTimeout(timer);
    // Also ignore explicit SIGTERM exits with no result — those are us.
    if (signal === 'SIGTERM' && !finalResult) return;
    if (finalResult?.error) {
      finishQuery({ error: finalResult.error });
    } else if (finalResult?.response !== undefined) {
      finishQuery({ chunk: '', response: finalResult.response, done: true });
    } else if (code !== 0 && code != null) {
      finishQuery({ error: `claude exited with code ${code}` });
    } else {
      finishQuery({ chunk: '', response: collected.trim(), done: true });
    }
  });

  child.on('error', (err) => {
    if (!activeQuery || activeQuery.child !== child) return;
    clearTimeout(timer);
    finishQuery({ error: `spawn failed: ${err.message}` });
  });
}

function finishQuery(payload) {
  if (!activeQuery) return;
  const { socket } = activeQuery;
  activeQuery = null;
  lastActivity = Date.now();
  try { socket.write(JSON.stringify(payload) + '\n'); }
  catch (e) { log('write failed:', e.message); }
  processQueue();
}

function processQueue() {
  if (activeQuery || queue.length === 0) return;
  const next = queue.shift();
  if (next.socket.destroyed) return processQueue();
  runQuery(next.socket, next.query);
}

function shutdown(sig) {
  log(`received ${sig} — shutting down`);
  server.close();
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  if (activeQuery?.child) activeQuery.child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
