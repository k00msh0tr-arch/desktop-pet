'use strict';
// Turns Claude Code hook events into what the pet should show.
// A persistent "base" state (idle/thinking/working/waiting/sleeping) sits under
// short-lived overlays (happy/oops/thanks) that fall back to it when they expire.

const { EventEmitter } = require('events');

class Pet extends EventEmitter {
  // Claude Code sends nothing while it is generating, so a long file write is a silent gap of
  // minutes; staleMs only exists to recover from an interrupted turn (which sends no Stop).
  constructor({ sleepAfterMs = 5 * 60_000, staleMs = 10 * 60_000 } = {}) {
    super();
    this.sleepAfterMs = sleepAfterMs;
    this.staleMs = staleMs;
    this.base = 'idle';
    this.overlay = null;
    this.overlayTimer = null;
    this.sleepTimer = null;
    this.staleTimer = null;
    this.touch();
  }

  get state() {
    return this.overlay || this.base;
  }

  emitChange(confetti = false) {
    this.emit('change', { state: this.state, confetti });
  }

  // every event pushes back the sleep and "stuck on thinking" timers
  touch() {
    clearTimeout(this.sleepTimer);
    clearTimeout(this.staleTimer);
    this.sleepTimer = setTimeout(() => {
      if (this.base === 'idle') this.setBase('sleeping');
    }, this.sleepAfterMs);
    this.staleTimer = setTimeout(() => {
      if (this.base === 'thinking' || this.base === 'working') this.setBase('idle');
    }, this.staleMs);
    this.sleepTimer.unref?.();
    this.staleTimer.unref?.();
  }

  setBase(state) {
    this.base = state;
    this.emitChange();
  }

  flash(state, ms, confetti = false) {
    clearTimeout(this.overlayTimer);
    this.overlay = state;
    this.emitChange(confetti);
    this.overlayTimer = setTimeout(() => {
      this.overlay = null;
      this.emitChange();
    }, ms);
  }

  clearOverlay() {
    clearTimeout(this.overlayTimer);
    this.overlay = null;
  }

  handleHook(p) {
    const ev = p && p.hook_event_name;
    if (!ev) return;
    this.touch();

    switch (ev) {
      case 'SessionStart':
      case 'SessionEnd':
        this.clearOverlay();
        this.setBase('idle');
        break;
      case 'UserPromptSubmit':
        this.clearOverlay();
        this.setBase('thinking');
        break;
      case 'PreToolUse':
      case 'PostToolUse':
        if (this.base === 'waiting') {
          // she was waiting for an approval and the tool is running now
          this.base = 'working';
          this.flash('thanks', 1800);
        } else if (this.base !== 'working') {
          this.setBase('working');
        }
        break;
      case 'PostToolUseFailure':
        this.flash('oops', 2400);
        break;
      case 'StopFailure':
        this.base = 'idle';
        this.flash('oops', 2800);
        break;
      case 'PermissionRequest':
        this.clearOverlay();
        this.setBase('waiting');
        break;
      case 'Notification':
        if (p.notification_type === 'auth_success') break;
        this.clearOverlay();
        this.setBase('waiting');
        break;
      case 'Stop':
        this.base = 'idle';
        this.flash('happy', 3600, true);
        break;
      case 'SubagentStart':
        if (this.base !== 'waiting') this.setBase('working');
        break;
      default:
        break;
    }
  }

  // used by the tray's preview menu and POST /debug
  debug(state, _text, confetti = false) {
    if (state === 'happy' || state === 'oops' || state === 'thanks') {
      this.flash(state, 3600, confetti);
    } else {
      this.clearOverlay();
      this.setBase(state);
    }
  }

  click() {
    if (this.base === 'waiting') {
      this.setBase('idle');
      return;
    }
    if (this.base === 'sleeping') this.base = 'idle';
    this.touch();
    this.flash('happy', 1400);
  }

  dispose() {
    clearTimeout(this.sleepTimer);
    clearTimeout(this.staleTimer);
    clearTimeout(this.overlayTimer);
  }
}

module.exports = { Pet };
