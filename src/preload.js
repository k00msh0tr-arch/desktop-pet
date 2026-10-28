'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld('pet', {
  ready: () => ipcRenderer.send('ready'),
  onInit: on('init'),
  onState: on('state'),
  onGeometry: on('geometry'),
  onWindows: on('windows'),
  onSettings: on('settings'),
  onPreview: on('preview'),
  onDrop: on('drop'),
  setIgnore: (ignore) => ipcRenderer.send('ignore', ignore),
  click: () => ipcRenderer.send('click'),
  contextMenu: () => ipcRenderer.send('context-menu'),
  dragOut: (sx, sy) => ipcRenderer.send('drag-out', sx, sy),
});
