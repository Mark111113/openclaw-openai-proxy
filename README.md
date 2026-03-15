# OpenClaw OpenAI Proxy

A small OpenAI-compatible gateway that routes requests through OpenClaw agents.

## What it does

- Exposes OpenAI-style endpoints:
  - `GET /v1/models`
  - `POST /v1/chat/completions`
  - `POST /v1/completions`
- Routes public models to different OpenClaw agents
- Adds debug headers for actual upstream/provider visibility
- Records per-request usage to local JSONL
- Works well as a shared gateway for SillyTavern and other custom apps

## Supported public models

By default the example routing exposes:

- `openclaw/st`
- `openclaw/main`
- `openclaw/writer`
- `openclaw/coder`
- `openclaw/research`

## Config files

Tracked in git:

- `config.example.json`
- `routes.example.json`
- `.env.example`
- `claw-proxy.service.example`

Local-only files (ignored by git):

- `config.json`
- `routes.json`
- `.env`
- `data/usage.jsonl`

## Quick start

### 1. Prepare local config

```bash
cp config.example.json config.json
cp routes.example.json routes.json
cp .env.example .env
```

Edit them for the current machine.

### 2. Install service

```bash
chmod +x deploy-install.sh
sudo ./deploy-install.sh /opt/claw-proxy
```

If you keep the project somewhere else, pass that directory instead.

## Example `config.json`

```json
{
  "host": "0.0.0.0",
  "port": 8780,
  "apiKey": "change-me",
  "corsOrigin": "*",
  "agent": "st",
  "publicModel": "openclaw/main",
  "upstreamModel": "bailian/kimi-k2.5",
  "thinking": "",
  "defaultMode": "light",
  "streamChunkSize": 24,
  "timeoutSeconds": 600,
  "includeOpenClawMeta": false
}
```

## Example `routes.json`

```json
{
  "defaults": {
    "agent": "main",
    "mode": "light"
  },
  "clients": {
    "default": {
      "apiKey": "change-me",
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

## Debug headers

Each generation response may include:

- `X-Claw-Proxy-Mode`
- `X-Claw-Proxy-Agent`
- `X-Claw-Proxy-Session`
- `X-Claw-Proxy-Configured-Upstream-Model`
- `X-Claw-Proxy-Actual-Upstream-Model`
- `X-Claw-Proxy-Actual-Provider`
- `X-Claw-Proxy-Prompt-Tokens`
- `X-Claw-Proxy-Completion-Tokens`
- `X-Claw-Proxy-Total-Tokens`

## Usage endpoint

```text
GET /debug/usage?limit=50
```

Notes:
- Only requests made after usage logging was enabled are available
- Existing historical requests are not backfilled

## Current limitation

Streaming is still pseudo-streaming for now: the proxy waits for the full result and then replays SSE-style chunks.
