import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
const OPENCLAW_AGENT = process.env.OPENCLAW_AGENT || 'main';
const OPENCLAW_PROXY_API_KEY = process.env.OPENCLAW_PROXY_API_KEY || '';
const OPENCLAW_MODEL = process.env.OPENCLAW_MODEL || 'openclaw/main';
const OPENCLAW_TIMEOUT_SECONDS = Number(process.env.OPENCLAW_TIMEOUT_SECONDS || 600);
const OPENCLAW_THINKING = process.env.OPENCLAW_THINKING || '';

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

function buildPromptFromMessages(messages, body) {
  const lines = [];
  lines.push('You are serving as an OpenAI-compatible backend proxy for an external app.');
  lines.push('Return only the assistant reply content. Do not add metadata, role labels, or explanations about the proxy.');
  lines.push('');

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

function runOpenClaw(prompt) {
  return new Promise((resolve, reject) => {
    const args = ['agent', '--agent', OPENCLAW_AGENT, '--message', prompt, '--json'];
    if (OPENCLAW_THINKING) {
      args.push('--thinking', OPENCLAW_THINKING);
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

function makeChatCompletionResponse({ model, messageText, promptTokens, completionTokens }) {
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
  };
}

function writeFakeStream(res, { model, messageText }) {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${randomUUID()}`;

  const chunks = [
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { content: messageText }, finish_reason: null }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ];

  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, service: 'openclaw-openai-proxy', model: OPENCLAW_MODEL });
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

      if (!messages.length) {
        return sendJson(res, 400, {
          error: {
            message: 'messages is required',
            type: 'invalid_request_error',
            code: 'bad_request',
          },
        });
      }

      const prompt = buildPromptFromMessages(messages, body);
      const result = await runOpenClaw(prompt);
      const messageText = extractAssistantText(result) || '';
      const promptTokens = result?.result?.meta?.agentMeta?.usage?.input ?? estimateTokens(prompt);
      const completionTokens = result?.result?.meta?.agentMeta?.usage?.output ?? estimateTokens(messageText);

      if (stream) {
        sendSseHeaders(res);
        return writeFakeStream(res, { model, messageText });
      }

      return sendJson(
        res,
        200,
        makeChatCompletionResponse({ model, messageText, promptTokens, completionTokens })
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[openclaw-openai-proxy] listening on http://127.0.0.1:${PORT}`);
  console.log(`[openclaw-openai-proxy] model=${OPENCLAW_MODEL} agent=${OPENCLAW_AGENT}`);
});
