// Janas local model server: online state, loaded model, and live activity.
// Live activity comes from Janas's metrics file (janas-server --metrics FILE), which logs
// counters and timings only, never prompt or reply text. Without it, the process's CPU use
// from the hardware collector is used as a "working" hint.
const fs = require('fs');
const { net } = require('electron');
const { EventEmitter } = require('events');

const ACTIVE_WINDOW_MS = 20000;

class JanasCollector extends EventEmitter {
  constructor(config) {
    super();
    this.url = config.janasUrl.replace(/\/$/, '');
    this.metricsFile = config.metricsFile;
    this.state = {
      online: false, model: null, description: null, sizeBytes: null, ctx: null,
      metrics: { available: false, last: null, lastAt: 0, lastReply: null, replyCount: 0 },
    };
    this.offset = 0;
    this.partial = '';
  }

  async get(path, timeout = 2000) {
    const res = await net.fetch(this.url + path, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  }

  start() {
    this.poll();
    this.healthTimer = setInterval(() => this.poll(), 3000);
    this.infoTimer = setInterval(() => this.info(), 30000);
    this.watchMetrics();
  }

  async poll() {
    const was = this.state.online;
    try {
      await this.get('/health', 1500);
      this.state.online = true;
      if (!was || !this.state.model) await this.info();
    } catch {
      this.state.online = false;
    }
    this.emit('update');
  }

  async info() {
    try {
      const models = await this.get('/v1/models');
      const m = models.data && models.data[0];
      if (m) { this.state.model = m.id; this.state.description = m.description || null; }
    } catch {}
    try {
      const ps = await this.get('/api/ps');
      const m = ps.models && ps.models[0];
      if (m) { this.state.sizeBytes = m.size || null; this.state.ctx = m.context_length || null; }
    } catch {}
    this.emit('update');
  }

  watchMetrics() {
    if (!this.metricsFile) return;
    try {
      // Start at the end: only activity from now on matters.
      this.offset = fs.statSync(this.metricsFile).size;
      this.state.metrics.available = true;
    } catch {
      this.offset = 0;
    }
    fs.watchFile(this.metricsFile, { interval: 700 }, (cur) => {
      if (cur.size === 0 && cur.mtimeMs === 0) { this.state.metrics.available = false; return; }
      this.state.metrics.available = true;
      if (cur.size < this.offset) this.offset = 0; // file was replaced
      if (cur.size === this.offset) return;
      const stream = fs.createReadStream(this.metricsFile, { start: this.offset, end: cur.size - 1, encoding: 'utf8' });
      this.offset = cur.size;
      let chunk = '';
      stream.on('data', (d) => { chunk += d; });
      stream.on('end', () => this.ingest(chunk));
    });
  }

  ingest(text) {
    const lines = (this.partial + text).replace(/﻿/g, '').split('\n');
    this.partial = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        const m = this.state.metrics;
        m.last = ev;
        m.lastAt = Date.now();
        if (ev.event === 'reply') { m.lastReply = ev; m.replyCount++; }
      } catch {}
    }
    this.emit('update');
  }

  // Combines metrics and process CPU into one activity line for the UI.
  snapshot(janasProc) {
    const s = this.state;
    const m = s.metrics;
    let activity = { kind: s.online ? 'idle' : 'offline' };
    const fresh = m.last && Date.now() - m.lastAt < ACTIVE_WINDOW_MS;
    if (s.online && fresh && m.last.event !== 'reply' && m.last.event !== 'refused') {
      const e = m.last;
      if (e.event === 'first_token' || (e.stage && e.stage !== 'input')) {
        activity = { kind: 'writing', tps: e.tokens_per_second ?? null, elapsed: e.elapsed_seconds ?? null };
      } else {
        activity = {
          kind: 'reading',
          done: e.input_done ?? null, total: e.input_tokens ?? null,
          tps: e.tokens_per_second ?? null, eta: e.eta_seconds_estimate ?? null,
        };
      }
    } else if (s.online && janasProc && janasProc.cpu > 15) {
      activity = { kind: 'working', cpu: janasProc.cpu };
    }
    return {
      online: s.online, model: s.model, description: s.description,
      sizeBytes: s.sizeBytes, ctx: s.ctx, proc: janasProc,
      metricsAvailable: m.available, metricsFile: this.metricsFile,
      lastReply: m.lastReply, activity,
    };
  }

  stop() {
    clearInterval(this.healthTimer);
    clearInterval(this.infoTimer);
    if (this.metricsFile) fs.unwatchFile(this.metricsFile);
  }
}

module.exports = { JanasCollector };
