import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const APP_DIR = path.dirname(new URL(import.meta.url).pathname);
const CONFIG_PATH = process.env.CLAW_PROXY_CONFIG || path.join(APP_DIR, 'config.json');
const ENV_PATH = path.join(APP_DIR, '.env');
const DATA_DIR = path.join(APP_DIR, 'data');
const USAGE_LOG_PATH = path.join(DATA_DIR, 'usage.jsonl');

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

function loadJsonConfig(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

loadDotEnv(ENV_PATH);
const fileConfig = loadJsonConfig(CONFIG_PATH);
fs.mkdirSync(DATA_DIR, { recursive: true });

function pick(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function pickString(...values) {
  const value = pick(...values);
  return value === undefined ? '' : String(value);
}

function pickNumber(...values) {
  const value = pick(...values);
  return value === undefined ? undefined : Number(value);
}

function pickBoolean(...values) {
  const value = pick(...values);
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

const PORT = pickNumber(process.env.PORT, fileConfig.port, 8787);
const OPENCLAW_AGENT = pickString(process.env.OPENCLAW_AGENT, fileConfig.agent, 'main');
const OPENCLAW_PROXY_API_KEY = pickString(process.env.OPENCLAW_PROXY_API_KEY, fileConfig.apiKey, '');
const OPENCLAW_MODEL = pickString(process.env.OPENCLAW_MODEL, fileConfig.publicModel, 'openclaw/main');
const OPENCLAW_UPSTREAM_MODEL = pickString(process.env.OPENCLAW_UPSTREAM_MODEL, fileConfig.upstreamModel, '');
const OPENCLAW_TIMEOUT_SECONDS = pickNumber(process.env.OPENCLAW_TIMEOUT_SECONDS, fileConfig.timeoutSeconds, 600);
const OPENCLAW_THINKING = pickString(process.env.OPENCLAW_THINKING, fileConfig.thinking, '');
const OPENCLAW_DEFAULT_MODE = pickString(process.env.OPENCLAW_DEFAULT_MODE, fileConfig.defaultMode, 'light');
const OPENCLAW_STREAM_CHUNK_SIZE = pickNumber(process.env.OPENCLAW_STREAM_CHUNK_SIZE, fileConfig.streamChunkSize, 24);
const OPENCLAW_HOST = pickString(process.env.OPENCLAW_HOST, fileConfig.host, '127.0.0.1');
const OPENCLAW_CORS_ORIGIN = pickString(process.env.OPENCLAW_CORS_ORIGIN, fileConfig.corsOrigin, '*');
const INCLUDE_OPENCLAW_META = pickBoolean(process.env.OPENCLAW_INCLUDE_META, fileConfig.includeOpenClawMeta, false);

function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', OPENCLAW_CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-openclaw-mode, x-openclaw-thinking, x-openclaw-user, x-session-id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type, X-Claw-Proxy-Mode, X-Claw-Proxy-Session, X-Claw-Proxy-Configured-Upstream-Model, X-Claw-Proxy-Actual-Upstream-Model, X-Claw-Proxy-Actual-Provider, X-Claw-Proxy-Prompt-Tokens, X-Claw-Proxy-Completion-Tokens, X-Claw-Proxy-Total-Tokens');
}

function setDebugHeaders(res, meta = {}, usage = null) {
  if (meta.mode) res.setHeader('X-Claw-Proxy-Mode', String(meta.mode));
  if (meta.sessionKey) res.setHeader('X-Claw-Proxy-Session', String(meta.sessionKey));
  if (meta.configuredUpstreamModel) res.setHeader('X-Claw-Proxy-Configured-Upstream-Model', String(meta.configuredUpstreamModel));
  if (meta.upstreamModel) res.setHeader('X-Claw-Proxy-Actual-Upstream-Model', String(meta.upstreamModel));
  if (meta.provider) res.setHeader('X-Claw-Proxy-Actual-Provider', String(meta.provider));
  if (usage) {
    res.setHeader('X-Claw-Proxy-Prompt-Tokens', String(usage.prompt_tokens ?? 0));
    res.setHeader('X-Claw-Proxy-Completion-Tokens', String(usage.completion_tokens ?? 0));
    res.setHeader('X-Claw-Proxy-Total-Tokens', String(usage.total_tokens ?? 0));
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  applyCors(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendNoContent(res) {
  applyCors(res);
  res.writeHead(204);
  res.end();
}

function sendSseHeaders(res) {
  applyCors(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 10 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function requireAuth(req, res) {
  if (!OPENCLAW_PROXY_API_KEY) return true;
  const auth = req.headers.authorization || '';
  const expected = `Bearer ${OPENCLAW_PROXY_API_KEY}`;
  if (auth !== expected) {
    sendJson(res, 401, {
      error: {
        message: 'Unauthorized',
        type: 'invalid_request_error',
        code: 'unauthorized',
      },
    });
    return false;
  }
  return true;
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (part.type === 'text') return part.text || '';
        if (part.type === 'input_text') return part.text || '';
        if (part.type === 'image_url') return `[image_url: ${JSON.stringify(part.image_url || {})}]`;
        return `[unsupported_part: ${JSON.stringify(part)}]`;
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  return String(content);
}

function normalizePrompt(prompt) {
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) return prompt.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
  if (prompt == null) return '';
  return String(prompt);
}

function promptToMessages(body) {
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: body.system });
  const prompt = normalizePrompt(body.prompt);
  if (prompt) messages.push({ role: 'user', content: prompt });
  return messages;
}

function resolveMode(body, req) {
  const requested = body?.openclaw?.mode || req.headers['x-openclaw-mode'] || OPENCLAW_DEFAULT_MODE;
  if (['passthrough', 'light', 'heavy'].includes(requested)) return requested;
  return OPENCLAW_DEFAULT_MODE;
}

function buildModeInstructions(mode) {
  if (mode === 'passthrough') {
    return [
      'Proxy mode: passthrough.',
      'Minimize extra interpretation. Preserve the original conversation intent closely.',
      'Do not add extra framing unless required by the conversation.',
    ];
  }
  if (mode === 'heavy') {
    return [
      'Proxy mode: heavy.',
      'You may do stronger reasoning and produce a more fully-developed answer when useful.',
      'Still return only the assistant reply content, with no proxy metadata.',
    ];
  }
  return [
    'Proxy mode: light.',
    'Be faithful to the conversation and respond normally without extra meta commentary.',
  ];
}

function sanitizeStop(text, stop) {
  if (!text || stop == null) return text;
  const stops = Array.isArray(stop) ? stop : [stop];
  let out = text;
  for (const s of stops) {
    if (!s || typeof s !== 'string') continue;
    const idx = out.indexOf(s);
    if (idx >= 0) out = out.slice(0, idx);
  }
  return out;
}

function buildPromptFromMessages(messages, body, mode, sessionInfo) {
  const lines = [];
  lines.push('You are serving as an OpenAI-compatible backend proxy for an external app.');
  lines.push('Return only the assistant reply content. Do not add metadata, role labels, or explanations about the proxy.');
  lines.push(...buildModeInstructions(mode));
  lines.push('');

  if (sessionInfo?.sessionKey) {
    lines.push(`Proxy session key: ${sessionInfo.sessionKey}`);
    lines.push('');
  }

  const extras = [];
  if (body.temperature != null) extras.push(`temperature=${body.temperature}`);
  if (body.top_p != null) extras.push(`top_p=${body.top_p}`);
  if (body.presence_penalty != null) extras.push(`presence_penalty=${body.presence_penalty}`);
  if (body.frequency_penalty != null) extras.push(`frequency_penalty=${body.frequency_penalty}`);
  if (body.max_tokens != null) extras.push(`max_tokens=${body.max_tokens}`);
  if (body.max_completion_tokens != null) extras.push(`max_completion_tokens=${body.max_completion_tokens}`);
  if (body.stop != null) extras.push(`stop=${JSON.stringify(body.stop)}`);
  if (extras.length) {
    lines.push('Requested generation params:');
    lines.push(...extras.map((v) => `- ${v}`));
    lines.push('');
  }

  lines.push('Conversation:');
  for (const msg of messages || []) {
    const role = msg?.role || 'user';
    const content = flattenContent(msg?.content);
    lines.push(`<<${role}>>`);
    lines.push(content || '[empty]');
    lines.push('');
  }

  lines.push('Now produce the next assistant reply to continue this conversation.');
  return lines.join('\n');
}

function extractAssistantText(resultJson) {
  const payloads = resultJson?.result?.payloads;
  if (Array.isArray(payloads) && payloads.length) {
    return payloads
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }
  return '';
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(String(text).length / 4));
}

function deriveSessionKey(body, req) {
  const explicit = body?.user || req.headers['x-openclaw-user'] || req.headers['x-session-id'];
  const source = explicit || req.socket.remoteAddress || 'anonymous';
  const hash = createHash('sha1').update(String(source)).digest('hex').slice(0, 16);
  return `proxy:${hash}`;
}

function patchSessionModel(sessionKey, model) {
  if (!model) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const args = ['gateway', 'call', 'sessions.patch', '--json', '--params', JSON.stringify({ key: sessionKey, model })];
    const child = spawn('openclaw', args, { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || stdout.trim() || `sessions.patch exited ${code}`));
      resolve();
    });
  });
}

function runOpenClaw(prompt, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = ['agent', '--agent', OPENCLAW_AGENT, '--message', prompt, '--json', '--session-id', opts.sessionId];
    if (opts.thinking) args.push('--thinking', opts.thinking);
    const child = spawn('openclaw', args, { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`openclaw agent timed out after ${OPENCLAW_TIMEOUT_SECONDS}s`));
    }, OPENCLAW_TIMEOUT_SECONDS * 1000);

    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || stdout.trim() || `openclaw exited with code ${code}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`Failed to parse openclaw JSON: ${err.message}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
      }
    });
  });
}

function buildOpenClawMeta(result, mode, sessionKey) {
  return {
    mode,
    agent: OPENCLAW_AGENT,
    sessionKey,
    configuredUpstreamModel: OPENCLAW_UPSTREAM_MODEL || null,
    upstreamModel: result?.result?.meta?.agentMeta?.model || null,
    provider: result?.result?.meta?.agentMeta?.provider || null,
  };
}

function maybeAttachMeta(obj, meta) {
  if (!INCLUDE_OPENCLAW_META || !meta) return obj;
  return { ...obj, openclaw: meta };
}

function appendUsageRecord(record) {
  try {
    fs.appendFileSync(USAGE_LOG_PATH, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    console.error('[claw-proxy] failed to append usage record:', err?.message || err);
  }
}

function readUsageRecords(limit = 50) {
  if (!fs.existsSync(USAGE_LOG_PATH)) return [];
  const raw = fs.readFileSync(USAGE_LOG_PATH, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const sliced = lines.slice(-Math.max(1, Math.min(limit, 500)));
  return sliced
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

function makeChatCompletionResponse({ model, messageText, promptTokens, completionTokens, meta }) {
  const created = Math.floor(Date.now() / 1000);
  return maybeAttachMeta({
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: messageText }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }, meta);
}

function makeCompletionResponse({ model, text, promptTokens, completionTokens, meta }) {
  const created = Math.floor(Date.now() / 1000);
  return maybeAttachMeta({
    id: `cmpl-${randomUUID()}`,
    object: 'text_completion',
    created,
    model,
    choices: [{ text, index: 0, logprobs: null, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }, meta);
}

function chunkText(text, chunkSize) {
  const chunks = [];
  if (!text) return [''];
  for (let i = 0; i < text.length; i += chunkSize) chunks.push(text.slice(i, i + chunkSize));
  return chunks;
}

function writeFakeChatStream(res, { model, messageText, usage, meta }) {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${randomUUID()}`;
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
  for (const piece of chunkText(messageText, OPENCLAW_STREAM_CHUNK_SIZE)) {
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify(maybeAttachMeta({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }, meta))}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function writeFakeCompletionStream(res, { model, text, usage, meta }) {
  const created = Math.floor(Date.now() / 1000);
  const id = `cmpl-${randomUUID()}`;
  for (const piece of chunkText(text, OPENCLAW_STREAM_CHUNK_SIZE)) {
    res.write(`data: ${JSON.stringify({ id, object: 'text_completion', created, model, choices: [{ text: piece, index: 0, logprobs: null, finish_reason: null }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify(maybeAttachMeta({ id, object: 'text_completion', created, model, choices: [{ text: '', index: 0, logprobs: null, finish_reason: 'stop' }], usage }, meta))}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

async function handleGeneration({ req, res, body, endpoint }) {
  const isChat = endpoint === 'chat';
  const messages = isChat ? (Array.isArray(body.messages) ? body.messages : []) : promptToMessages(body);
  const model = body.model || OPENCLAW_MODEL;
  const stream = Boolean(body.stream);
  const mode = resolveMode(body, req);
  const sessionKeyShort = deriveSessionKey(body, req);
  const gatewaySessionKey = `agent:${OPENCLAW_AGENT}:${sessionKeyShort}`;
  const sessionId = `openclaw-proxy-${sessionKeyShort}`;

  if (!messages.length) {
    return sendJson(res, 400, { error: { message: isChat ? 'messages is required' : 'prompt is required', type: 'invalid_request_error', code: 'bad_request' } });
  }

  const thinking = body?.openclaw?.thinking || req.headers['x-openclaw-thinking'] || OPENCLAW_THINKING;
  if (OPENCLAW_UPSTREAM_MODEL) {
    await patchSessionModel(gatewaySessionKey, OPENCLAW_UPSTREAM_MODEL);
  }
  const prompt = buildPromptFromMessages(messages, body, mode, { sessionKey: sessionKeyShort });
  const result = await runOpenClaw(prompt, { sessionId, thinking });
  const rawText = extractAssistantText(result) || '';
  const text = sanitizeStop(rawText, body.stop);
  const promptTokens = result?.result?.meta?.agentMeta?.usage?.input ?? estimateTokens(prompt);
  const completionTokens = result?.result?.meta?.agentMeta?.usage?.output ?? estimateTokens(text);
  const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
  const meta = buildOpenClawMeta(result, mode, sessionKeyShort);
  setDebugHeaders(res, meta, usage);

  appendUsageRecord({
    ts: new Date().toISOString(),
    endpoint,
    stream,
    mode,
    agent: OPENCLAW_AGENT,
    publicModel: model,
    configuredUpstreamModel: meta.configuredUpstreamModel,
    actualUpstreamModel: meta.upstreamModel,
    actualProvider: meta.provider,
    sessionKey: sessionKeyShort,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
  });

  if (stream) {
    sendSseHeaders(res);
    if (isChat) return writeFakeChatStream(res, { model, messageText: text, usage, meta });
    return writeFakeCompletionStream(res, { model, text, usage, meta });
  }

  if (isChat) return sendJson(res, 200, makeChatCompletionResponse({ model, messageText: text, promptTokens, completionTokens, meta }));
  return sendJson(res, 200, makeCompletionResponse({ model, text, promptTokens, completionTokens, meta }));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return sendNoContent(res);
    if (!requireAuth(req, res)) return;

    const url = new URL(req.url || '/', `http://${req.headers.host || `${OPENCLAW_HOST}:${PORT}`}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return sendJson(res, 200, {
        ok: true,
        service: 'openclaw-openai-proxy',
        configPath: CONFIG_PATH,
        model: OPENCLAW_MODEL,
        upstreamModel: OPENCLAW_UPSTREAM_MODEL || null,
        agent: OPENCLAW_AGENT,
        defaultMode: OPENCLAW_DEFAULT_MODE,
        host: OPENCLAW_HOST,
        port: PORT,
        includeOpenClawMeta: INCLUDE_OPENCLAW_META,
        endpoints: ['/v1/models', '/v1/chat/completions', '/v1/completions', '/debug/usage'],
      });
    }

    if (req.method === 'GET' && url.pathname === '/debug/usage') {
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 50), 500));
      const rows = readUsageRecords(limit);
      return sendJson(res, 200, {
        ok: true,
        logPath: USAGE_LOG_PATH,
        count: rows.length,
        note: 'Only requests made after usage logging was added are available here.',
        rows,
      });
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return sendJson(res, 200, {
        object: 'list',
        data: [{ id: OPENCLAW_MODEL, object: 'model', created: 0, owned_by: 'openclaw', permission: [], root: OPENCLAW_MODEL, parent: null }],
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = await parseJsonBody(req);
      return handleGeneration({ req, res, body, endpoint: 'chat' });
    }

    if (req.method === 'POST' && url.pathname === '/v1/completions') {
      const body = await parseJsonBody(req);
      return handleGeneration({ req, res, body, endpoint: 'completion' });
    }

    return sendJson(res, 404, { error: { message: 'Not found', type: 'invalid_request_error', code: 'not_found' } });
  } catch (err) {
    return sendJson(res, 500, { error: { message: err?.message || String(err), type: 'server_error', code: 'internal_error' } });
  }
});

server.listen(PORT, OPENCLAW_HOST, () => {
  console.log(`[claw-proxy] listening on http://${OPENCLAW_HOST}:${PORT}`);
  console.log(`[claw-proxy] config=${CONFIG_PATH}`);
  console.log(`[claw-proxy] publicModel=${OPENCLAW_MODEL} upstreamModel=${OPENCLAW_UPSTREAM_MODEL || '(default)'} agent=${OPENCLAW_AGENT} defaultMode=${OPENCLAW_DEFAULT_MODE}`);
  console.log(`[claw-proxy] usageLog=${USAGE_LOG_PATH}`);
});
