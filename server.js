import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
const OPENCLAW_AGENT = process.env.OPENCLAW_AGENT || 'main';
const OPENCLAW_PROXY_API_KEY = process.env.OPENCLAW_PROXY_API_KEY || '';
const OPENCLAW_MODEL = process.env.OPENCLAW_MODEL || 'openclaw/main';
const OPENCLAW_TIMEOUT_SECONDS = Number(process.env.OPENCLAW_TIMEOUT_SECONDS || 600);
const OPENCLAW_THINKING = process.env.OPENCLAW_THINKING || '';
const OPENCLAW_DEFAULT_MODE = process.env.OPENCLAW_DEFAULT_MODE || 'light';
const OPENCLAW_STREAM_CHUNK_SIZE = Number(process.env.OPENCLAW_STREAM_CHUNK_SIZE || 24);
const OPENCLAW_HOST = process.env.OPENCLAW_HOST || '127.0.0.1';

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendSseHeaders(res) {
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
    if (idx >= 0) {
      out = out.slice(0, idx);
    }
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

function runOpenClaw(prompt, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = ['agent', '--agent', OPENCLAW_AGENT, '--message', prompt, '--json', '--session-id', opts.sessionId];
    if (opts.thinking) {
      args.push('--thinking', opts.thinking);
    }

    const child = spawn('openclaw', args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`openclaw agent timed out after ${OPENCLAW_TIMEOUT_SECONDS}s`));
    }, OPENCLAW_TIMEOUT_SECONDS * 1000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
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
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `openclaw exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`Failed to parse openclaw JSON: ${err.message}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
      }
    });
  });
}

function makeChatCompletionResponse({ model, messageText, promptTokens, completionTokens, meta }) {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: messageText,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
    ...(meta ? { openclaw: meta } : {}),
  };
}

function chunkText(text, chunkSize) {
  const chunks = [];
  if (!text) return [''];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

function writeFakeStream(res, { model, messageText, includeUsage = true, usage, meta }) {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${randomUUID()}`;

  const startChunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  };
  res.write(`data: ${JSON.stringify(startChunk)}\n\n`);

  for (const piece of chunkText(messageText, OPENCLAW_STREAM_CHUNK_SIZE)) {
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  const endChunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    ...(includeUsage && usage ? { usage } : {}),
    ...(meta ? { openclaw: meta } : {}),
  };
  res.write(`data: ${JSON.stringify(endChunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const url = new URL(req.url || '/', `http://${req.headers.host || `${OPENCLAW_HOST}:${PORT}`}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'openclaw-openai-proxy',
        model: OPENCLAW_MODEL,
        agent: OPENCLAW_AGENT,
        defaultMode: OPENCLAW_DEFAULT_MODE,
      });
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return sendJson(res, 200, {
        object: 'list',
        data: [
          {
            id: OPENCLAW_MODEL,
            object: 'model',
            created: 0,
            owned_by: 'openclaw',
          },
        ],
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = await parseJsonBody(req);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const model = body.model || OPENCLAW_MODEL;
      const stream = Boolean(body.stream);
      const mode = resolveMode(body, req);
      const sessionKey = deriveSessionKey(body, req);
      const sessionId = `openclaw-proxy-${sessionKey}`;

      if (!messages.length) {
        return sendJson(res, 400, {
          error: {
            message: 'messages is required',
            type: 'invalid_request_error',
            code: 'bad_request',
          },
        });
      }

      const thinking = body?.openclaw?.thinking || req.headers['x-openclaw-thinking'] || OPENCLAW_THINKING;
      const prompt = buildPromptFromMessages(messages, body, mode, { sessionKey });
      const result = await runOpenClaw(prompt, { sessionId, thinking });
      const rawMessageText = extractAssistantText(result) || '';
      const messageText = sanitizeStop(rawMessageText, body.stop);
      const promptTokens = result?.result?.meta?.agentMeta?.usage?.input ?? estimateTokens(prompt);
      const completionTokens = result?.result?.meta?.agentMeta?.usage?.output ?? estimateTokens(messageText);
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
      const meta = {
        mode,
        agent: OPENCLAW_AGENT,
        sessionKey,
        upstreamModel: result?.result?.meta?.agentMeta?.model || null,
        provider: result?.result?.meta?.agentMeta?.provider || null,
      };

      if (stream) {
        sendSseHeaders(res);
        return writeFakeStream(res, { model, messageText, includeUsage: true, usage, meta });
      }

      return sendJson(
        res,
        200,
        makeChatCompletionResponse({ model, messageText, promptTokens, completionTokens, meta })
      );
    }

    sendJson(res, 404, {
      error: {
        message: 'Not found',
        type: 'invalid_request_error',
        code: 'not_found',
      },
    });
  } catch (err) {
    sendJson(res, 500, {
      error: {
        message: err?.message || String(err),
        type: 'server_error',
        code: 'internal_error',
      },
    });
  }
});

server.listen(PORT, OPENCLAW_HOST, () => {
  console.log(`[openclaw-openai-proxy] listening on http://${OPENCLAW_HOST}:${PORT}`);
  console.log(`[openclaw-openai-proxy] model=${OPENCLAW_MODEL} agent=${OPENCLAW_AGENT} defaultMode=${OPENCLAW_DEFAULT_MODE}`);
});
