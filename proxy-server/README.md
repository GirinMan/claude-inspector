# Claude Inspector Proxy (Standalone)

Standalone proxy server for [Claude Inspector](../README.md).
Intercepts Claude Code API traffic and broadcasts captured data via WebSocket.

## Usage

```bash
cd proxy-server
npm install
node index.js --target https://api.anthropic.com --port 9090 --ws-port 9091
```

Then run Claude Code through the proxy:

```bash
ANTHROPIC_BASE_URL=http://<this-host>:9090 claude
```

Connect the Claude Inspector desktop app in **Remote** mode using `ws://<this-host>:9091`.

## Docker

```bash
docker build -t claude-inspector-proxy .
docker run -p 9090:9090 -p 9091:9091 claude-inspector-proxy \
  --target https://api.anthropic.com
```

### AWS Bedrock

```bash
docker run -p 9090:9090 -p 9091:9091 claude-inspector-proxy \
  --target https://bedrock-runtime.ap-northeast-2.amazonaws.com
```

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `9090` | HTTP proxy listen port |
| `--ws-port` | `9091` | WebSocket broadcast port |
| `--target` | `https://api.anthropic.com` | URL to forward requests to |
| `--host` | `0.0.0.0` | Bind address |
