// Hermes agent activity, read from its log (%LOCALAPPDATA%\hermes\logs\agent.log).
// Only the logger name and event phrase of each line are matched; message text is never
// kept or sent anywhere.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const RULES = [
  [/Starting Hermes Gateway|Turn machinery warmed|gateway\.start/, 'online'],
  [/gateway\.run: Gateway stopped|Exiting: auto-started gateway idle/, 'offline'],
  [/gateway\.run: inbound message/, 'inbound'],
  [/agent\.turn_context: conversation turn/, 'turn'],
  [/agent\.conversation_loop: API call #/, 'api'],
  [/agent\.conversation_loop: Turn ended|gateway\.run: response ready|Sending response/, 'done'],
  [/ tools\.(?!registry|tool_search|lazy_deps)[a-z_]+: /, 'tool'],
];
const DONE_SHOW_MS = 5000;
const STUCK_MS = 10 * 60 * 1000;

function classify(line) {
  for (const [re, ev] of RULES) if (re.test(line)) return ev;
  return null;
}

// "2026-11-07 15:49:23,501 INFO ..." -> epoch ms (local time)
function lineTime(line) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d),(\d{3})/.exec(line);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime();
}

class HermesCollector extends EventEmitter {
  constructor() {
    super();
    this.file = path.join(process.env.LOCALAPPDATA || '', 'hermes', 'logs', 'agent.log');
    this.state = { available: false, online: false, phase: 'offline', phaseAt: Date.now(), turnStart: null, lastTurnSecs: null, apiCalls: 0, turnsToday: 0 };
    this.offset = 0;
    this.partial = '';
  }

  start() {
    this.initialScan();
    fs.watchFile(this.file, { interval: 500 }, (cur) => this.onChange(cur));
    this.timer = setInterval(() => this.tick(), 1000);
  }

  initialScan() {
    try {
      const { size } = fs.statSync(this.file);
      this.state.available = true;
      const start = Math.max(0, size - 256 * 1024);
      const fd = fs.openSync(this.file, 'r');
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      const today = new Date().toDateString();
      for (const line of buf.toString('utf8').split('\n')) {
        const ev = classify(line);
        if (!ev) continue;
        const t = lineTime(line) || Date.now();
        if (ev === 'turn' && new Date(t).toDateString() === today) this.state.turnsToday++;
        this.apply(ev, t, true);
      }
      this.offset = size;
      this.tick();
    } catch {
      this.state.available = false;
    }
    this.emit('update');
  }

  onChange(cur) {
    if (cur.size === 0 && cur.mtimeMs === 0) { this.state.available = false; return; }
    this.state.available = true;
    if (cur.size < this.offset) this.offset = 0; // rotated
    if (cur.size === this.offset) return;
    const stream = fs.createReadStream(this.file, { start: this.offset, end: cur.size - 1, encoding: 'utf8' });
    this.offset = cur.size;
    let chunk = '';
    stream.on('data', (d) => { chunk += d; });
    stream.on('end', () => {
      const lines = (this.partial + chunk).split('\n');
      this.partial = lines.pop();
      let changed = false;
      for (const line of lines) {
        const ev = classify(line);
        if (ev) {
          if (ev === 'turn') this.state.turnsToday++;
          this.apply(ev, Date.now(), false);
          changed = true;
        }
      }
      if (changed) this.emit('update');
    });
  }

  setPhase(phase, t) {
    if (this.state.phase !== phase) { this.state.phase = phase; this.state.phaseAt = t; }
  }

  apply(ev, t) {
    const s = this.state;
    switch (ev) {
      case 'online': s.online = true; this.setPhase('idle', t); break;
      case 'offline': s.online = false; this.setPhase('offline', t); break;
      case 'inbound':
      case 'turn':
        s.online = true;
        if (s.phase !== 'thinking' && s.phase !== 'tool') { s.turnStart = t; s.apiCalls = 0; }
        this.setPhase('thinking', t);
        break;
      case 'api': s.online = true; s.apiCalls++; this.setPhase('thinking', t); s.phaseAt = t; break;
      case 'tool': s.online = true; this.setPhase('tool', t); s.phaseAt = t; break;
      case 'done':
        if (s.turnStart) s.lastTurnSecs = Math.max(0, (t - s.turnStart) / 1000);
        s.turnStart = null;
        this.setPhase('done', t);
        break;
    }
  }

  tick() {
    const s = this.state, now = Date.now();
    let changed = false;
    if (s.phase === 'done' && now - s.phaseAt > DONE_SHOW_MS) { this.setPhase(s.online ? 'idle' : 'offline', now); changed = true; }
    if ((s.phase === 'thinking' || s.phase === 'tool') && now - s.phaseAt > STUCK_MS) { this.setPhase('idle', now); changed = true; }
    if (changed) this.emit('update');
  }

  stop() { clearInterval(this.timer); fs.unwatchFile(this.file); }
}

module.exports = { HermesCollector };
