'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('lib', {
  platform: process.platform,
  list: call('lib:list'),
  catalog: call('lib:catalog'),
  equip: call('lib:equip'),
  install: call('lib:install'),
  remove: call('lib:remove'),
  exportPack: call('lib:export'),
  importPack: call('lib:import'),
  create: call('lib:create'),
  openFolder: call('lib:open-folder'),
  openStudio: call('lib:open-studio'),
  pathFor: (file) => webUtils.getPathForFile(file), // the real path of a picture dropped on the page
  onChanged: (cb) => ipcRenderer.on('changed', () => cb()),
});
