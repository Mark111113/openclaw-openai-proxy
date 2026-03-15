# OpenClaw OpenAI Proxy Prototype

一个最小但更整洁的原型：对外暴露 OpenAI-compatible HTTP 接口，对内通过 `openclaw agent` 把请求送进 OpenClaw。

## 当前能力

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- 支持 `stream: false`
- 支持 `stream: true`（当前仍然是**伪流式**：先拿完整结果，再按 SSE chunk 回放）
- 支持基础模式切换：`passthrough | light | heavy`
- 支持基础会话映射骨架（按 `user` / 请求头 派生 session key）
- 支持基础 stop 截断

## 当前限制

这还是原型，所以限制仍然明确：

1. **不是原生 token streaming**，而是结果生成完再以 SSE 回放。
2. **不支持 tool calls / images / embeddings / responses API**。
3. 目前仍是把 OpenAI messages 转成一段文本提示，再交给 OpenClaw agent。
4. 目前的“会话”是 proxy 层派生的 session id，不是完整的原生多轮对话映射方案。

## 环境变量

- `PORT`：监听端口，默认 `8787`
- `OPENCLAW_HOST`：监听地址，默认 `127.0.0.1`
- `OPENCLAW_AGENT`：默认 `main`
- `OPENCLAW_PROXY_API_KEY`：可选；设置后要求 `Authorization: Bearer <key>`
- `OPENCLAW_MODEL`：`/v1/models` 默认展示名，默认 `openclaw/main`
- `OPENCLAW_TIMEOUT_SECONDS`：调用 `openclaw agent` 的超时，默认 `600`
- `OPENCLAW_THINKING`：可选，传给 `openclaw agent --thinking`
- `OPENCLAW_DEFAULT_MODE`：默认 `light`
- `OPENCLAW_STREAM_CHUNK_SIZE`：伪流式 chunk 大小，默认 `24`

## 模式

可通过以下方式指定：

- 请求体：`openclaw.mode`
- Header：`x-openclaw-mode`
- 环境变量默认：`OPENCLAW_DEFAULT_MODE`

可选值：

- `passthrough`：尽量少加工
- `light`：默认，轻处理
- `heavy`：允许更重一点的回答风格

## 会话派生

当前按以下来源派生 session key：

1. `body.user`
2. `x-openclaw-user`
3. `x-session-id`
4. 请求来源地址

这只是为了让后续接 SillyTavern 时有“会话粘性”骨架，不是最终设计。

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

### 指定 mode

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-mode: heavy' \
  -d '{
    "model": "openclaw/main",
    "messages": [
      {"role": "user", "content": "解释一下 OpenClaw 适合做什么"}
    ]
  }'
```

### stream

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
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

下一步最值得做：

1. 改成直接对 Gateway WS 调 `chat.send`
2. 做真正的 streaming
3. 做更稳定的 session 映射
4. 增加审计日志和请求记录
5. 加 SillyTavern 兼容细节（stop strings, preset mapping, token usage估算）
