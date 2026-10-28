'use strict';
// Adds / removes the pet's HTTP hooks in ~/.claude/settings.json.
//   node tools/hooks.js install | uninstall | status
// Only entries pointing at the pet's own URL are touched, a timestamped backup is
// written before every change, and a file that doesn't parse is left alone.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PORT } = require('../src/server');

const URL = `http://127.0.0.1:${PORT}/hook`;
const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
];

const settingsPath = () => path.join(os.homedir(), '.claude', 'settings.json');

function load(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); // Notepad and PowerShell like to add a BOM
  return text.trim() ? JSON.parse(text) : {};
}

const isOurs = (group) =>
  Array.isArray(group && group.hooks) &&
  group.hooks.some((h) => h.type === 'http' && typeof h.url === 'string' && h.url.startsWith(URL));

function strip(settings) {
  const hooks = settings.hooks;
  if (!hooks) return;
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    hooks[ev] = hooks[ev].filter((g) => !isOurs(g));
    if (!hooks[ev].length) delete hooks[ev];
  }
  if (!Object.keys(hooks).length) delete settings.hooks;
}

function save(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.pet-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const dest = `${file}.pet-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, dest);
  return dest;
}

function status() {
  const file = settingsPath();
  const hooks = load(file).hooks || {};
  const installed = EVENTS.filter((ev) => Array.isArray(hooks[ev]) && hooks[ev].some(isOurs));
  return { file, installed, complete: installed.length === EVENTS.length };
}

function install() {
  const file = settingsPath();
  const settings = load(file);
  const saved = backup(file);
  strip(settings);
  settings.hooks = settings.hooks || {};
  for (const ev of EVENTS) {
    settings.hooks[ev] = settings.hooks[ev] || [];
    // short timeout so a stopped pet can never slow Claude down
    settings.hooks[ev].push({ hooks: [{ type: 'http', url: URL, timeout: 2 }] });
  }
  save(file, settings);
  return { file, backup: saved, events: EVENTS };
}

function uninstall() {
  const file = settingsPath();
  const settings = load(file);
  const saved = backup(file);
  strip(settings);
  save(file, settings);
  return { file, backup: saved };
}

module.exports = { install, uninstall, status, EVENTS, URL };

if (require.main === module) {
  const cmd = process.argv[2];
  const actions = { install, uninstall, status };
  if (!actions[cmd]) {
    console.error('usage: node tools/hooks.js install | uninstall | status');
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(actions[cmd](), null, 2));
  } catch (err) {
    console.error(`Could not ${cmd}: ${err.message}\nNothing was changed.`);
    process.exit(1);
  }
}
