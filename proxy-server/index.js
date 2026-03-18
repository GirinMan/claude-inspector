#!/usr/bin/env node
'use strict';

const http = require('node:http');
const https = require('node:https');
const { WebSocketServer } = require('ws');

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const PROXY_PORT = parseInt(arg('port', '9090'), 10);
const WS_PORT = parseInt(arg('ws-port', '9091'), 10);
const TARGET_URL = arg('target', 'https://api.anthropic.com');
const BIND_HOST = arg('host', '0.0.0.0');

let target;
try { target = new URL(TARGET_URL); } catch { console.error('Invalid --target URL:', TARGET_URL); process.exit(1); }
const targetHostname = target.hostname;
const targetPort = parseInt(target.port, 10) || (target.protocol === 'https:' ? 443 : 80);
const transport = target.protocol === 'https:' ? https : http;

// ── SSE parser (same logic as Electron app) ─────────────────────────────────
function parseSseStream(text) {
  try {
    let msg = null;
    function processEvent(data) {
      try {
        const d = JSON.parse(data);
        if (d.type === 'message_start') msg = Object.assign({}, d.message, { _streaming: true });
        if (d.type === 'content_block_start' && msg) { msg.content = msg.content || []; msg.content[d.index] = Object.assign({}, d.content_block); }
        if (d.type === 'content_block_delta' && msg) { const block = msg.content && msg.content[d.index]; if (block) { if (d.delta.type === 'text_delta') block.text = (block.text || '') + d.delta.text; if (d.delta.type === 'thinking_delta') block.thinking = (block.thinking || '') + d.delta.thinking; } }
        if (d.type === 'message_delta' && msg) { if (d.delta) Object.assign(msg, d.delta); if (d.usage) msg.usage = Object.assign({}, msg.usage, d.usage); }
      } catch {}
    }
    const events = {};
    for (const rawLine of text.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      const m = line.match(/^(event|data):\s?(.*)/);
      if (m) events[m[1]] = m[2].trimEnd();
      if (line === '' && events.data) { processEvent(events.data); events.event = undefined; events.data = undefined; }
    }
    if (events.data) processEvent(events.data);
    return msg || null;
  } catch { return null; }
}

// ── WebSocket server ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: WS_PORT, host: BIND_HOST });
const wsClients = new Set();
wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ── HTTP proxy server ───────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  req.on('error', () => { if (!res.headersSent) res.writeHead(400); res.end(); });

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const bodyBuf = Buffer.concat(chunks);
    let bodyObj = null;
    try { bodyObj = JSON.parse(bodyBuf.toString()); } catch {}

    const reqId = Date.now();
    const reqData = {
      id: reqId,
      ts: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      method: req.method,
      path: req.url,
      body: bodyObj,
    };
    broadcast('proxy-request', reqData);

    const headers = Object.assign({}, req.headers, { host: targetHostname });
    delete headers['accept-encoding'];
    const options = { hostname: targetHostname, port: targetPort, path: req.url, method: req.method, headers };

    const proxyReq = transport.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      const respChunks = [];
      proxyRes.on('data', chunk => { respChunks.push(chunk); res.write(chunk); });
      proxyRes.on('error', () => { res.end(); });
      proxyRes.on('end', () => {
        res.end();
        setImmediate(() => {
          const respStr = Buffer.concat(respChunks).toString('utf8');
          let respObj = null;
          try { respObj = JSON.parse(respStr); } catch {}
          if (!respObj) respObj = parseSseStream(respStr);
          broadcast('proxy-response', {
            id: reqId, status: proxyRes.statusCode,
            body: respObj || respStr.slice(0, 4000),
          });
        });
      });
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      broadcast('proxy-response', { id: reqId, error: err.message });
    });

    proxyReq.end(bodyBuf);
  });
});

const isBedrock = targetHostname.includes('bedrock-runtime');
const envVar = isBedrock ? 'ANTHROPIC_BEDROCK_BASE_URL' : 'ANTHROPIC_BASE_URL';
const extraEnv = isBedrock ? ' CLAUDE_CODE_USE_BEDROCK=1' : '';

server.listen(PROXY_PORT, BIND_HOST, () => {
  console.log(`Claude Inspector Proxy`);
  console.log(`  Proxy:     http://${BIND_HOST}:${PROXY_PORT}`);
  console.log(`  WebSocket: ws://${BIND_HOST}:${WS_PORT}`);
  console.log(`  Target:    ${TARGET_URL}`);
  console.log(`\nRun Claude Code with:`);
  console.log(`  ${envVar}=http://<this-host>:${PROXY_PORT}${extraEnv} claude`);
});
