import { useEffect, useRef, useState } from 'react';
import { HermesStage } from './Hermes.jsx';

const GB = 1024 ** 3;

function fmtDur(ms) {
  if (ms == null || !isFinite(ms)) return '';
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// "7:29 PM" if the reset is today, "Fri 4:59 AM" if later.
function fmtClock(iso, now) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return new Date(now).toDateString() === d.toDateString()
    ? time
    : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

function fmtSecs(s) {
  if (s == null) return '';
  if (s < 60) return `${Math.round(s)}s`;
  return fmtDur(s * 1000);
}

const n0 = (v) => (v == null ? '–' : Math.round(v).toLocaleString());
const tone = (v, warn, hot) => (v == null ? '' : v >= hot ? 'hot' : v >= warn ? 'warn' : '');

// Numbers glide to their new value instead of jumping.
function useTween(target, ms = 500) {
  const [v, setV] = useState(target);
  const cur = useRef(target);
  useEffect(() => {
    if (target == null || cur.current == null) { cur.current = target; setV(target); return; }
    const from = cur.current, start = performance.now();
    let raf;
    const tick = (t) => {
      const k = Math.min(1, (t - start) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      cur.current = from + (target - from) * e;
      setV(cur.current);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

function Num({ value, decimals = 0 }) {
  const v = useTween(value);
  if (v == null) return '–';
  return decimals ? v.toFixed(decimals) : Math.round(v).toLocaleString();
}

// Small ring gauge: reads at a glance even when the value is low.
function Ring({ pct, t, size = 16, stroke = 2.5 }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <svg className={`ring ${t}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle className="track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
      <circle
        className="fill" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none"
        strokeDasharray={`${(p / 100) * c} ${c}`} strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

function Stat({ label, pct, num, decimals = 0, unit, t, ring = true, title, width }) {
  return (
    <span className="stat" title={title}>
      <span className="label">{label}</span>
      {ring && <Ring pct={pct} t={t} />}
      <span className={`value ${t}`} style={width ? { minWidth: width } : null}>
        <Num value={num} decimals={decimals} />{unit && <span className="unit">{unit}</span>}
      </span>
    </span>
  );
}

function Temp({ c, warn, hot }) {
  if (c == null) return null;
  return <span className={`temp ${tone(c, warn, hot)}`}>{Math.round(c)}°</span>;
}

function Claude({ c, now }) {
  const head = <span className="brand"><span className="glyph">✳</span>Claude</span>;
  if (!c || c.status === 'loading') return <div className="pill">{head}<span className="muted">loading…</span></div>;
  if (c.status === 'signed-out') {
    return (
      <div className="pill">{head}
        <button className="link" onClick={() => window.bar.signIn()}>Sign in to show limits</button>
      </div>
    );
  }
  if (c.status === 'error') {
    return (
      <div className="pill" title={c.error}>{head}
        <span className="hot">couldn’t load</span>
        <button className="link" onClick={() => window.bar.refreshClaude()}>retry</button>
      </div>
    );
  }
  const shown = c.windows.filter((w) => w.key === 'five_hour' || w.key === 'seven_day' || w.pct > 0);
  const tip = [
    ...c.windows.map((w) => `${w.label}: ${w.pct.toFixed(0)}% used` + (w.resetsAt ? `, resets ${new Date(w.resetsAt).toLocaleString()}` : '')),
    c.extra ? `Extra usage: ${c.extra.is_enabled ? 'on' : 'off'}` : null,
    `Source: ${c.source}`,
    c.updatedAt ? `Updated ${new Date(c.updatedAt).toLocaleTimeString()}` : null,
    c.status === 'stale' ? `Last refresh failed: ${c.error}` : null,
    'Click to refresh',
  ].filter(Boolean).join('\n');
  return (
    <div className="pill clickable" title={tip} onClick={() => window.bar.refreshClaude()}>
      {head}
      {shown.map((w) => {
        const t = tone(w.pct, 70, 90);
        return (
          <span className="limit" key={w.key}>
            <Stat label={w.label} pct={w.pct} num={w.pct} unit="%" t={t} width="3.4ch" />
            {w.resetsAt && (
              <span className="reset">
                <span className="countdown">{fmtDur(new Date(w.resetsAt).getTime() - now)}</span>
                <span className="at">{fmtClock(w.resetsAt, now)}</span>
              </span>
            )}
          </span>
        );
      })}
      {c.status === 'stale' && <span className="warn" title={c.error}>●</span>}
    </div>
  );
}

function Janas({ j }) {
  if (!j) return null;
  const a = j.activity || {};
  const state = j.online ? a.kind : 'offline';
  const tipLines = [
    j.online ? 'Janas online at 127.0.0.1:8080' : 'Janas server is not answering',
    j.description,
    j.proc ? `Process: CPU ${j.proc.cpu}% · RAM ${(j.proc.mem / GB).toFixed(1)} GB` : null,
    j.lastReply ? 'Last reply: ' + Object.entries(j.lastReply).filter(([k]) => !['event', 'time', 'pid'].includes(k)).map(([k, v]) => `${k}=${v}`).join(', ') : null,
    j.online && !j.metricsAvailable ? `Live progress is off. Start janas-server with --metrics "${j.metricsFile}".` : null,
  ].filter(Boolean).join('\n');

  let body;
  if (!j.online) body = <span className="muted">offline</span>;
  else if (a.kind === 'reading') {
    const pct = a.total ? (100 * a.done) / a.total : 0;
    body = (
      <>
        <span className="state reading">Reading</span>
        <span className="progress"><span style={{ width: `${pct}%` }} /></span>
        <span className="value"><Num value={pct} /><span className="unit">%</span></span>
        {a.tps != null && <span className="sub"><b>{n0(a.tps)}</b> tok/s</span>}
        {a.eta != null && <span className="sub">~{fmtSecs(a.eta)}</span>}
      </>
    );
  } else if (a.kind === 'writing') {
    body = (
      <>
        <span className="state writing">Thinking</span>
        {a.tps != null && <span className="value"><Num value={a.tps} decimals={1} /><span className="unit"> tok/s</span></span>}
        {a.elapsed != null && <span className="sub">{fmtSecs(a.elapsed)}</span>}
      </>
    );
  } else if (a.kind === 'working') {
    body = <><span className="state writing">Working</span><span className="sub">CPU {Math.round(a.cpu)}%</span></>;
  } else {
    body = <span className="muted">idle</span>;
  }

  return (
    <div className={`pill janas ${state}`} title={tipLines}>
      <span className={`dot ${state}`} />
      <span className="model">{j.model || 'Janas'}</span>
      {body}
      {j.online && j.proc && (
        <span className="stat" title="Memory used by janas-server">
          <span className="label">Mem</span>
          <span className="value"><Num value={j.proc.mem / GB} decimals={1} /><span className="unit"> GB</span></span>
        </span>
      )}
    </div>
  );
}

function System({ h }) {
  if (!h) return null;
  const ramPct = h.ramUsed && h.ramTotal ? (100 * h.ramUsed) / h.ramTotal : null;
  const g = h.gpu;
  const vramPct = g && g.memTotal ? (100 * g.memUsed) / g.memTotal : null;
  return (
    <div className="pill system">
      <span className="group" title="CPU load (all cores) and hottest thermal-zone reading">
        <Stat label="CPU" pct={h.cpu} num={h.cpu} unit="%" t={tone(h.cpu, 70, 90)} width="3.4ch" />
        <Temp c={h.temp} warn={80} hot={92} />
      </span>
      <span className="divider" />
      <span className="group" title={`RAM ${(h.ramUsed / GB).toFixed(1)} of ${(h.ramTotal / GB).toFixed(1)} GB`}>
        <Stat label="RAM" pct={ramPct} num={h.ramUsed / GB} decimals={1} unit={` / ${Math.round(h.ramTotal / GB)} GB`} t={tone(ramPct, 80, 92)} />
      </span>
      {g && (
        <>
          <span className="divider" />
          <span className="group" title={`${g.name}\nVRAM ${n0(g.memUsed)} of ${n0(g.memTotal)} MiB\nPower ${g.power ?? '–'} W`}>
            <Stat label="GPU" pct={g.util} num={g.util} unit="%" t={tone(g.util, 80, 95)} width="3.4ch" />
            <Temp c={g.temp} warn={75} hot={87} />
            <Stat label="VRAM" pct={vramPct} num={g.memUsed / 1024} decimals={1} unit={` / ${Math.round(g.memTotal / 1024)} GB`} t={tone(vramPct, 85, 95)} />
          </span>
        </>
      )}
    </div>
  );
}

// "Preview Hermes moods" in the menu: cycles the avatar through every state.
const DEMO = ['sleep', 'idle', 'reading', 'thinking', 'tool', 'happy'];
function demoState(now) {
  const mood = DEMO[Math.floor(now / 5000) % DEMO.length];
  const h = { available: true, online: mood !== 'sleep', phase: { thinking: 'thinking', tool: 'tool', happy: 'done' }[mood] || 'idle', turnStart: now - 12000, lastTurnSecs: 14 };
  const activity = mood === 'reading' ? { kind: 'reading', done: 1536, total: 3044 } : mood === 'thinking' ? { kind: 'writing', tps: 11.4 } : { kind: 'idle' };
  return { h, j: { online: mood !== 'sleep', model: 'qwen36', activity } };
}

export default function App() {
  const [s, setS] = useState(null);
  useEffect(() => window.bar.onState(setS), []);
  return (
    <div className="bar" onContextMenu={(e) => { e.preventDefault(); window.bar.menu(); }}>
      <Claude c={s?.claude} now={s?.now ?? Date.now()} />
      <Janas j={s?.janas} />
      <HermesStage {...(s?.demo ? demoState(s.now) : { h: s?.hermes, j: s?.janas })} now={s?.now ?? Date.now()} character={s?.character} />
      <System h={s?.hw} />
      <button className="menu-btn" title="Menu" onClick={() => window.bar.menu()}>
        <svg width="14" height="14" viewBox="0 0 14 14"><circle cx="3" cy="7" r="1.3" /><circle cx="7" cy="7" r="1.3" /><circle cx="11" cy="7" r="1.3" /></svg>
      </button>
    </div>
  );
}
