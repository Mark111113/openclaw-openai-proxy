#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${1:-/opt/claw-proxy}"
SERVICE_NAME="claw-proxy"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

mkdir -p "$PROJECT_DIR"

if [[ ! -f "$PROJECT_DIR/config.json" && -f "$PROJECT_DIR/config.example.json" ]]; then
  cp "$PROJECT_DIR/config.example.json" "$PROJECT_DIR/config.json"
  echo "Created $PROJECT_DIR/config.json from example"
fi

if [[ ! -f "$PROJECT_DIR/routes.json" && -f "$PROJECT_DIR/routes.example.json" ]]; then
  cp "$PROJECT_DIR/routes.example.json" "$PROJECT_DIR/routes.json"
  echo "Created $PROJECT_DIR/routes.json from example"
fi

if [[ ! -f "$PROJECT_DIR/.env" && -f "$PROJECT_DIR/.env.example" ]]; then
  cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
  echo "Created $PROJECT_DIR/.env from example"
fi

NODE_PATH="$(command -v node || true)"
if [[ -z "$NODE_PATH" ]]; then
  echo "node not found in PATH" >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE_PATH")"
OPENCLAW_BIN="$(command -v openclaw || true)"
EXTRA_PATH=""
if [[ -n "$OPENCLAW_BIN" ]]; then
  EXTRA_PATH="$(dirname "$OPENCLAW_BIN")"
fi

TMP_SERVICE="$(mktemp)"
cat > "$TMP_SERVICE" <<EOF
[Unit]
Description=Claw Proxy (OpenAI-compatible proxy via OpenClaw)
After=network.target openclaw-gateway.service
Wants=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${PROJECT_DIR}
EnvironmentFile=-${PROJECT_DIR}/.env
Environment=PATH=${EXTRA_PATH:+${EXTRA_PATH}:}${NODE_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=${NODE_PATH} ${PROJECT_DIR}/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

install -m 0644 "$TMP_SERVICE" "$SERVICE_PATH"
rm -f "$TMP_SERVICE"

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
sleep 2
systemctl --no-pager --full status "$SERVICE_NAME" | sed -n '1,40p'

PORT="$(python3 - "$PROJECT_DIR/config.json" <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1])
print(json.loads(p.read_text()).get('port', 8780))
PY
)"

echo
echo "Health check:"
curl -s "http://127.0.0.1:${PORT}/" || true
