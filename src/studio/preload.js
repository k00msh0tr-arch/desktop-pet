'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(`studio:${channel}`, ...args);

contextBridge.exposeInMainWorld('studio', {
  platform: process.platform,
  projects: call('projects'),
  create: call('create'),
  load: call('load'),
  patch: call('patch'),
  image: call('image'),
  deleteImage: call('delete-image'),
  copyImage: call('copy-image'),
  copyText: call('copy-text'),
  open: call('open'),
  prompts: call('prompts'),
  request: call('request'),
  applyReply: call('apply-reply'),
  upscale: call('upscale'),
  build: call('build'),
  settings: call('settings'),
  saveSettings: call('save-settings'),
  pickProgram: call('pick-program'),
  remove: call('remove'),
});
