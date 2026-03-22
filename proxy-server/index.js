#!/usr/bin/env node
'use strict';

const http = require('node:http');
const https = require('node:https');
const { WebSocketServer } = require('ws');
const fs = require('node:fs');
const path = require('node:path');

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
const LOG_DIR = arg('log-dir', '/app/logs');
const ENABLE_LOGGING = args.includes('--enable-logging');

let target;
try { target = new URL(TARGET_URL); } catch { console.error('Invalid --target URL:', TARGET_URL); process.exit(1); }
const targetHostname = target.hostname;
const targetPort = parseInt(target.port, 10) || (target.protocol === 'https:' ? 443 : 80);
const transport = target.protocol === 'https:' ? https : http;

// ── Logging utilities ───────────────────────────────────────────────────────
function initLogDir() {
  if (!ENABLE_LOGGING) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    console.log(`  Logging:   ${LOG_DIR} (enabled)`);
  } catch (err) {
    console.error(`Failed to create log directory: ${err.message}`);
    process.exit(1);
  }
}

function analyzeMessage(bodyObj) {
  if (!bodyObj) return null;

  const analysis = {
    model: bodyObj.model || 'unknown',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalCost: 0,
  };

  // Extract usage from response
  if (bodyObj.usage) {
    analysis.inputTokens = bodyObj.usage.input_tokens || 0;
    analysis.outputTokens = bodyObj.usage.output_tokens || 0;
    analysis.cacheCreationTokens = bodyObj.usage.cache_creation_input_tokens || 0;
    analysis.cacheReadTokens = bodyObj.usage.cache_read_input_tokens || 0;
  }

  // Calculate cost (simplified, based on Claude Sonnet pricing)
  const inputCostPer1M = 3.0;   // $3 per 1M input tokens
  const outputCostPer1M = 15.0; // $15 per 1M output tokens
  const cacheCostPer1M = 3.75;  // $3.75 per 1M cache write tokens
  const cacheReadCostPer1M = 0.3; // $0.30 per 1M cache read tokens

  analysis.totalCost =
    (analysis.inputTokens / 1_000_000) * inputCostPer1M +
    (analysis.outputTokens / 1_000_000) * outputCostPer1M +
    (analysis.cacheCreationTokens / 1_000_000) * cacheCostPer1M +
    (analysis.cacheReadTokens / 1_000_000) * cacheReadCostPer1M;

  return analysis;
}

function writeLog(reqId, reqData, respData, analysis) {
  if (!ENABLE_LOGGING) return;

  try {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      id: reqId,
      request: reqData,
      response: respData,
      analysis: analysis || {},
    };

    const fileName = `${timestamp.replace(/[:.]/g, '-')}_${reqId}.json`;
    const filePath = path.join(LOG_DIR, fileName);

    fs.writeFileSync(filePath, JSON.stringify(logEntry, null, 2));
  } catch (err) {
    console.error(`Failed to write log: ${err.message}`);
  }
}

// ── Bedrock AWS Event Stream parser ─────────────────────────────────────────
function parseBedrockEventStream(buf) {
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
    const str = buf.toString('utf8');
    const regex = /\{"bytes":"([A-Za-z0-9+/=]+)"/g;
    let m;
    while ((m = regex.exec(str)) !== null) {
      try {
        const decoded = Buffer.from(m[1], 'base64').toString('utf8');
        processEvent(decoded);
      } catch {}
    }
    return msg || null;
  } catch { return null; }
}

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
          const respBuf = Buffer.concat(respChunks);
          const respStr = respBuf.toString('utf8');
          let respObj = null;
          try { respObj = JSON.parse(respStr); } catch {}
          if (!respObj && isBedrock) respObj = parseBedrockEventStream(respBuf);
          if (!respObj) respObj = parseSseStream(respStr);

          const respData = {
            id: reqId,
            status: proxyRes.statusCode,
            headers: proxyRes.headers,
            body: respObj || respStr.slice(0, 4000),
          };

          broadcast('proxy-response', respData);

          // Write log if enabled
          if (ENABLE_LOGGING && respObj) {
            const analysis = analyzeMessage(respObj);
            writeLog(reqId, reqData, respData, analysis);
          }
        });
      });
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      const respData = { id: reqId, status: 502, error: err.message };
      broadcast('proxy-response', respData);

      // Write error log if enabled
      if (ENABLE_LOGGING) {
        writeLog(reqId, reqData, respData, { error: err.message });
      }
    });

    proxyReq.end(bodyBuf);
  });
});

const isBedrock = targetHostname.includes('bedrock-runtime');
const envVar = isBedrock ? 'ANTHROPIC_BEDROCK_BASE_URL' : 'ANTHROPIC_BASE_URL';
const extraEnv = isBedrock ? ' CLAUDE_CODE_USE_BEDROCK=1' : '';

// Initialize log directory
initLogDir();

server.listen(PROXY_PORT, BIND_HOST, () => {
  console.log(`Claude Inspector Proxy`);
  console.log(`  Proxy:     http://${BIND_HOST}:${PROXY_PORT}`);
  console.log(`  WebSocket: ws://${BIND_HOST}:${WS_PORT}`);
  console.log(`  Target:    ${TARGET_URL}`);
  if (!ENABLE_LOGGING) {
    console.log(`  Logging:   disabled (use --enable-logging to enable)`);
  }
  console.log(`\nRun Claude Code with:`);
  console.log(`  ${envVar}=http://<this-host>:${PROXY_PORT}${extraEnv} claude`);
});
