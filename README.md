# OpenClaw OpenAI Proxy Prototype

现在这个项目已经支持：

- 作为 systemd 服务运行（建议服务名：`claw-proxy`）
- 使用 `config.json` 做手工配置
- 使用 `.env` 覆盖部分配置
- 对外暴露 OpenAI-compatible 接口
- 通过 OpenClaw 处理请求
- 在配置中**显式指定上游模型**，而不是依赖 OpenClaw 默认模型

## 目录结构

- `server.js`：主服务
- `config.json`：主配置文件（推荐手工改这里）
- `.env`：可选环境变量覆盖
- `claw-proxy.service`：systemd 单元文件模板

## 配置文件

主配置文件：

`/root/.openclaw/workspace/projects/openclaw-openai-proxy/config.json`

示例：

```json
{
  "host": "0.0.0.0",
  "port": 8787,
  "apiKey": "change-me",
  "corsOrigin": "*",
  "agent": "main",
  "publicModel": "openclaw/main",
  "upstreamModel": "998code/gpt-5.4",
  "thinking": "",
  "defaultMode": "light",
  "streamChunkSize": 24,
  "timeoutSeconds": 600,
  "includeOpenClawMeta": false
}
```

## 关键配置说明

### `host`
- 控制监听地址
- 如果要让另一台机器（如 246）访问，设成：`0.0.0.0`

### `port`
- 默认 `8787`

### `apiKey`
- 外部客户端访问时使用的 Bearer key
- 建议一定设置，不要裸奔

### `publicModel`
- 暴露给 OpenAI-compatible 客户端的模型名
- 例如：`openclaw/main`
- 这是客户端看到并填写的 model

### `upstreamModel`
- **真正发给 OpenClaw 会话使用的模型**
- 例如：`998code/gpt-5.4`
- 这样就不需要依赖 OpenClaw 当前默认模型

### `includeOpenClawMeta`
- 是否在响应里带 `openclaw` 调试字段
- 为了兼容客户端，默认建议 `false`

## `.env`

`.env` 不是必须，但可以覆盖配置。

路径：

`/root/.openclaw/workspace/projects/openclaw-openai-proxy/.env`

注意：
- **优先推荐改 `config.json`**
- `.env` 更适合临时覆盖

## 接口

- `GET /`
- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/completions`

## systemd

服务名建议：

`claw-proxy`

单元文件模板：

`/root/.openclaw/workspace/projects/openclaw-openai-proxy/claw-proxy.service`

推荐安装到：

`/etc/systemd/system/claw-proxy.service`

## 启动后检查

```bash
systemctl status claw-proxy --no-pager -l
curl http://127.0.0.1:8787/
```

如果是跨机器：

```bash
curl http://192.168.1.247:8787/v1/models -H 'Authorization: Bearer <apiKey>'
```

## SillyTavern 建议

因为你现在是：
- OpenClaw + claw-proxy 在 `192.168.1.247`
- SillyTavern 在 `192.168.1.246`

所以建议这样填：

- Base URL：`http://192.168.1.247:8787/v1`
- API Key：`config.json` 里的 `apiKey`
- Model：`config.json` 里的 `publicModel`

## 备注

当前仍然是原型：
- 流式仍是伪流式
- 还没做原生 Gateway WS 真流式
- 但已经适合做 SillyTavern 第一轮联调
