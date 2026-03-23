try { require('@sentry/electron/renderer').init(); } catch {}

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  proxyStart: (port, targetUrl) => ipcRenderer.invoke('proxy-start', port, targetUrl),
  proxyStop: () => ipcRenderer.invoke('proxy-stop'),
  proxyStatus: () => ipcRenderer.invoke('proxy-status'),
  onProxyRequest: (cb) => ipcRenderer.on('proxy-request', (_, data) => cb(data)),
  onProxyResponse: (cb) => ipcRenderer.on('proxy-response', (_, data) => cb(data)),
  offProxy: () => {
    ipcRenderer.removeAllListeners('proxy-request');
    ipcRenderer.removeAllListeners('proxy-response');
  },
  historySave: (data) => ipcRenderer.invoke('history-save', data),
  historyList: () => ipcRenderer.invoke('history-list'),
  historyLoad: (filename) => ipcRenderer.invoke('history-load', { filename }),
  historyDelete: (filename) => ipcRenderer.invoke('history-delete', { filename }),
  historyExport: (data) => ipcRenderer.invoke('history-export', data),
  historyImport: () => ipcRenderer.invoke('history-import'),
});
