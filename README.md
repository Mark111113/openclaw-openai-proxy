# OpenClaw OpenAI Proxy Prototype

现在这个项目已经支持：

- 作为 systemd 服务运行（服务名：`claw-proxy`）
- 使用 `config.json` 做主配置
- 使用 `routes.json` 做通用路由配置
- 对外暴露 OpenAI-compatible 接口
- 按 `public model -> agent` 路由到不同 OpenClaw agent
- 记录 usage 并通过 `/debug/usage` 查看

## 目录结构

- `server.js`：主服务
- `config.json`：基础配置
- `routes.json`：模型/agent 路由配置
- `.env`：可选环境变量覆盖
- `claw-proxy.service`：systemd 单元文件模板
- `data/usage.jsonl`：usage 记录

## 当前对外模型

`/v1/models` 现在返回：

- `openclaw/st`
- `openclaw/main`
- `openclaw/writer`
- `openclaw/coder`
- `openclaw/research`

## 路由规则

当前主要按：

1. `Authorization: Bearer <apiKey>` 识别 client
2. 请求里的 `model`
3. 映射到 `routes.json` 中的 agent / mode / configuredUpstreamModel

## routes.json 示例

```json
{
  "defaults": {
    "agent": "main",
    "mode": "light"
  },
  "clients": {
    "default": {
      "apiKey": "mcquay2011",
      "defaultModel": "openclaw/st",
      "allowedModels": [
        "openclaw/st",
        "openclaw/main",
        "openclaw/writer",
        "openclaw/coder",
        "openclaw/research"
      ]
    }
  },
  "models": {
    "openclaw/st": {
      "agent": "st",
      "mode": "light",
      "configuredUpstreamModel": "bailian/kimi-k2.5"
    },
    "openclaw/main": {
      "agent": "main",
      "mode": "light",
      "configuredUpstreamModel": "998code/gpt-5.4"
    }
  }
}
```

## 典型用法

### SillyTavern

- Base URL：`http://192.168.1.247:8787/v1`
- API Key：`mcquay2011`
- Model：`openclaw/st`

### 普通自定义聊天应用

- Base URL：`http://192.168.1.247:8787/v1`
- API Key：`mcquay2011`
- Model：`openclaw/main`

### 写作类应用

- Base URL：`http://192.168.1.247:8787/v1`
- API Key：`mcquay2011`
- Model：`openclaw/writer`

## 调试响应头

每次生成请求都会带：

- `X-Claw-Proxy-Mode`
- `X-Claw-Proxy-Agent`
- `X-Claw-Proxy-Session`
- `X-Claw-Proxy-Configured-Upstream-Model`
- `X-Claw-Proxy-Actual-Upstream-Model`
- `X-Claw-Proxy-Actual-Provider`
- `X-Claw-Proxy-Prompt-Tokens`
- `X-Claw-Proxy-Completion-Tokens`
- `X-Claw-Proxy-Total-Tokens`

## Usage 调试端点

- `GET /debug/usage?limit=50`

注意：
- 只能看到启用 usage 记录之后的新请求
- 历史请求不会自动回填逐条明细

## 说明

当前流式仍是**伪流式**（先拿完整结果，再以 SSE chunk 回放）。
