require('dotenv').config();
const Sentry = require('@sentry/electron/main');
Sentry.init({
  dsn: process.env.SENTRY_DSN || process.env.SENTRY_CLIENT_KEY || '',
  environment: process.env.NODE_ENV || 'development',
  release: `claude-inspector@${require('./package.json').version}`,
  beforeSend(event) {
    if (event.breadcrumbs) {
      event.breadcrumbs = event.breadcrumbs.map(bc => {
        if (bc.data) {
          delete bc.data['x-api-key'];
          delete bc.data['X-Api-Key'];
          delete bc.data['authorization'];
          delete bc.data['Authorization'];
        }
        return bc;
      });
    }
    return event;
  },
});

const analytics = require('./analytics');

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('node:http');
const https = require('node:https');

let mainWin = null;
let proxyServer = null;

// Parse Bedrock AWS Event Stream into a reconstructed Anthropic message object
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

// Parse SSE stream into a reconstructed Anthropic message object
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
      if (line === '' && events.data) {
        processEvent(events.data);
        events.event = undefined;
        events.data = undefined;
      }
    }
    if (events.data) processEvent(events.data);
    return msg || null;
  } catch { return null; }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    icon: path.join(__dirname, 'assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 19 } } : {}),
    title: 'Claude Inspector',
    backgroundColor: '#1e1e1e',
    show: false,
  });

  win.loadFile(path.join(__dirname, 'public/index.html'));

  // Retry on load failure (macOS quarantine scan can lock the asar on first launch)
  win.webContents.on('did-fail-load', () => {
    setTimeout(() => {
      if (!win.isDestroyed()) win.loadFile(path.join(__dirname, 'public/index.html'));
    }, 1500);
  });

  win.once('ready-to-show', () => win.show());
  // Fallback: force show if ready-to-show never fires
  setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) win.show(); }, 3000);
  mainWin = win;

  // Open external links in browser, not Electron
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  analytics.init(app.getPath('userData'));
  analytics.trackEvent('app_open');
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, 'assets/icon.png'));
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWin && !mainWin.isDestroyed()) {
      mainWin.show();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('proxy-start', (_event, port = 9090, targetUrl = 'https://api.anthropic.com') => {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return { error: 'Invalid port: must be 1024–65535' };
  }
  if (proxyServer) return { running: true, port: proxyServer.address().port };

  let target;
  try { target = new URL(targetUrl); } catch { return { error: 'Invalid target URL' }; }
  const targetHostname = target.hostname;
  const targetPort = target.port || (target.protocol === 'https:' ? 443 : 80);
  const targetProtocol = target.protocol;
  const transport = targetProtocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.on('error', () => {
        if (!res.headersSent) res.writeHead(400);
        res.end();
      });
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const bodyBuf = Buffer.concat(chunks);
        let bodyObj = null;
        try { bodyObj = JSON.parse(bodyBuf.toString()); } catch (e) { console.warn('req body parse failed:', e.message); }

        const reqId = Date.now();
        const reqData = {
          id: reqId,
          ts: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          method: req.method,
          path: req.url,
          body: bodyObj,
        };
        if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('proxy-request', reqData);

        const headers = Object.assign({}, req.headers, { host: targetHostname });
        delete headers['accept-encoding']; // Prevent gzip response so we can parse it
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
              try { respObj = JSON.parse(respStr); } catch { /* streaming — JSON.parse expected to fail */ }
              if (!respObj && targetHostname.includes('bedrock-runtime')) respObj = parseBedrockEventStream(respBuf);
              if (!respObj) respObj = parseSseStream(respStr);
              if (mainWin && !mainWin.isDestroyed()) {
                mainWin.webContents.send('proxy-response', {
                  id: reqId, status: proxyRes.statusCode,
                  body: respObj || respStr.slice(0, 4000),
                });
              }
            });
          });
        });

        proxyReq.on('error', (err) => {
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          if (mainWin && !mainWin.isDestroyed()) {
            mainWin.webContents.send('proxy-response', { id: reqId, error: err.message });
          }
        });

        proxyReq.end(bodyBuf);
      });
    });

    server.on('listening', () => {
      proxyServer = server;
      analytics.trackEvent('proxy_started');
      resolve({ running: true, port: server.address().port });
    });
    let retried = false;
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && !retried) {
        retried = true;
        server.listen(0, '127.0.0.1');
      } else {
        resolve({ error: err.message });
      }
    });
    server.listen(port, '127.0.0.1');
  });
});

ipcMain.handle('proxy-status', () => {
  if (proxyServer) {
    try { return { running: true, port: proxyServer.address().port }; }
    catch { return { running: false }; }
  }
  return { running: false };
});

ipcMain.handle('proxy-stop', () => {
  if (!proxyServer) return { stopped: true };
  const srv = proxyServer;
  proxyServer = null;
  return new Promise((resolve) => {
    srv.close(() => { resolve({ stopped: true }); });
  });
});

app.on('before-quit', () => { if (proxyServer) proxyServer.close(); });

// ─── History ──────────────────────────────────────────────────────────────
function getHistoryDir() {
  const dir = path.join(app.getPath('userData'), 'history');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeFilename(s) {
  return String(s).replace(/[^a-zA-Z0-9가-힣_-]/g, '_').slice(0, 60);
}

ipcMain.handle('history-save', (_event, { label, captures }) => {
  const dir = getHistoryDir();
  const ts = new Date().toISOString();
  const fname = `${ts.replace(/[:.]/g, '-')}-${sanitizeFilename(label)}.json`;
  const data = { version: 1, savedAt: ts, label, captures };
  fs.writeFileSync(path.join(dir, fname), JSON.stringify(data, null, 2), 'utf8');
  return { ok: true, filename: fname };
});

ipcMain.handle('history-list', () => {
  const dir = getHistoryDir();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const list = files.map(f => {
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const d = JSON.parse(raw);
      return { filename: f, label: d.label || f, savedAt: d.savedAt, count: (d.captures || []).length };
    } catch { return null; }
  }).filter(Boolean);
  list.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  return list;
});

ipcMain.handle('history-load', (_event, { filename }) => {
  const fpath = path.join(getHistoryDir(), path.basename(filename));
  if (!fs.existsSync(fpath)) return { error: 'File not found' };
  const raw = fs.readFileSync(fpath, 'utf8');
  return JSON.parse(raw);
});

ipcMain.handle('history-delete', (_event, { filename }) => {
  const fpath = path.join(getHistoryDir(), path.basename(filename));
  if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
  return { ok: true };
});

ipcMain.handle('history-export', async (_event, { label, captures }) => {
  const ts = new Date().toISOString();
  const data = { version: 1, savedAt: ts, label, captures };
  const result = await dialog.showSaveDialog(mainWin, {
    defaultPath: `claude-inspector-${sanitizeFilename(label)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf8');
  return { ok: true, filePath: result.filePath };
});

ipcMain.handle('history-import', async () => {
  const result = await dialog.showOpenDialog(mainWin, {
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const raw = fs.readFileSync(result.filePaths[0], 'utf8');
  const data = JSON.parse(raw);
  if (!data.captures || !Array.isArray(data.captures)) return { error: 'Invalid format' };
  return data;
});
