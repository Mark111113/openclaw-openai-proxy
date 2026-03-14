# OpenClaw OpenAI Proxy Prototype

一个最小原型：对外暴露 OpenAI-compatible HTTP 接口，对内通过 `openclaw agent` 把请求送进 OpenClaw。

## 当前能力

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- 支持 `stream: false`
- 支持 `stream: true`（当前是**伪流式**：一次性拿到完整结果后，用 SSE 包装回放）

## 当前限制

这还是第一版原型，所以有一些明确限制：

1. **不是原生 token streaming**，而是结果生成完再以 SSE 返回。
2. **不支持 tool calls / images / embeddings / responses API**。
3. 会把 OpenAI messages 转成一段文本提示，再交给 OpenClaw agent。
4. 默认通过 `openclaw agent --agent main` 运行，因此真正的“重/轻模式”还没拆开。

## 环境变量

- `PORT`：监听端口，默认 `8787`
- `OPENCLAW_AGENT`：默认 `main`
- `OPENCLAW_PROXY_API_KEY`：可选；设置后要求 `Authorization: Bearer <key>`
- `OPENCLAW_MODEL`：`/v1/models` 默认展示名，默认 `openclaw/main`
- `OPENCLAW_TIMEOUT_SECONDS`：调用 `openclaw agent` 的超时，默认 `600`
- `OPENCLAW_THINKING`：可选，传给 `openclaw agent --thinking`

## 启动

```bash
cd /root/.openclaw/workspace/projects/openclaw-openai-proxy
node server.js
```

或

```bash
npm start
```

## 测试

### models

```bash
curl http://127.0.0.1:8787/v1/models
```

### chat completions

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "openclaw/main",
    "messages": [
      {"role": "system", "content": "You are concise."},
      {"role": "user", "content": "用一句话介绍 OpenClaw"}
    ]
  }'
```

### stream

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "openclaw/main",
    "stream": true,
    "messages": [
      {"role": "user", "content": "说一句 hello"}
    ]
  }'
```

## 后续建议

下一步适合做：

1. 改成直接对 Gateway WS 调 `chat.send`
2. 做真正的 streaming
3. 增加 `mode=passthrough|light|heavy`
4. 增加会话映射与审计日志
5. 加 SillyTavern 兼容细节（stop strings, preset mapping, token usage估算）
