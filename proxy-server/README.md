# Claude Inspector Proxy (Standalone)

Standalone proxy server for [Claude Inspector](../README.md).
Intercepts Claude Code API traffic and broadcasts captured data via WebSocket.

## Usage

```bash
cd proxy-server
npm install
node index.js --target https://api.anthropic.com --port 9090 --ws-port 9091
```

**Enable request/response logging:**
```bash
node index.js --enable-logging --log-dir ./logs
```

Then run Claude Code through the proxy:

```bash
ANTHROPIC_BASE_URL=http://<this-host>:9090 claude
```

Connect the Claude Inspector desktop app in **Remote** mode using `ws://<this-host>:9091`.

## Docker

**Basic usage:**
```bash
docker build -t claude-inspector-proxy .
docker run -p 9090:9090 -p 9091:9091 claude-inspector-proxy \
  --target https://api.anthropic.com
```

**With persistent logging:**
```bash
docker run -p 9090:9090 -p 9091:9091 \
  -v $(pwd)/logs:/app/logs \
  claude-inspector-proxy \
  --target https://api.anthropic.com \
  --enable-logging
```

This mounts `./logs` on your host to `/app/logs` in the container. All request/response logs will be saved as JSON files in this directory and persist across container restarts.

**Log file format:**
```
2025-03-22T14-30-45-123Z_1711115445123.json
```

Each log contains:
- `timestamp`: ISO 8601 timestamp
- `id`: Unique request ID
- `request`: Full request data (method, path, headers, body)
- `response`: Full response data (status, headers, body)
- `analysis`: Token usage and cost breakdown

### AWS Bedrock

```bash
docker run -p 9090:9090 -p 9091:9091 \
  -v $(pwd)/logs:/app/logs \
  claude-inspector-proxy \
  --target https://bedrock-runtime.ap-northeast-2.amazonaws.com \
  --enable-logging
```

### Docker Compose

For easier management with logging enabled:

```bash
docker-compose up -d
```

This uses the included `docker-compose.yml` which automatically:
- Mounts `./logs` directory for persistent logging
- Enables logging by default
- Restarts automatically unless stopped

**View logs:**
```bash
docker-compose logs -f
```

**Stop:**
```bash
docker-compose down
```

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `9090` | HTTP proxy listen port |
| `--ws-port` | `9091` | WebSocket broadcast port |
| `--target` | `https://api.anthropic.com` | URL to forward requests to |
| `--host` | `0.0.0.0` | Bind address |
| `--enable-logging` | `false` | Enable request/response/analysis logging |
| `--log-dir` | `/app/logs` | Directory to save log files |

## Log File Structure

When `--enable-logging` is enabled, each API request/response is saved as a JSON file:

```json
{
  "timestamp": "2025-03-22T14:30:45.123Z",
  "id": 1711115445123,
  "request": {
    "id": 1711115445123,
    "ts": "14:30:45",
    "method": "POST",
    "path": "/v1/messages",
    "body": {
      "model": "claude-sonnet-4.5-20250929",
      "max_tokens": 4096,
      "messages": [...]
    }
  },
  "response": {
    "id": 1711115445123,
    "status": 200,
    "headers": {...},
    "body": {
      "id": "msg_...",
      "type": "message",
      "role": "assistant",
      "content": [...],
      "usage": {
        "input_tokens": 1523,
        "output_tokens": 847,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0
      }
    }
  },
  "analysis": {
    "model": "claude-sonnet-4.5-20250929",
    "inputTokens": 1523,
    "outputTokens": 847,
    "cacheCreationTokens": 0,
    "cacheReadTokens": 0,
    "totalCost": 0.017199
  }
}
```

Logs are named: `<ISO-timestamp>_<request-id>.json`
Example: `2025-03-22T14-30-45-123Z_1711115445123.json`
