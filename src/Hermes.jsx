import { useEffect, useRef } from 'react';

// How the avatar behaves in each mood: walking speed (px/s) and pause between walks (ms).
const MOTION = {
  sleep:    { speed: 0,  pause: [0, 0] },
  idle:     { speed: 14, pause: [3500, 9000] },
  reading:  { speed: 24, pause: [700, 1800] },
  thinking: { speed: 55, pause: [250, 1100] },
  tool:     { speed: 95, pause: [120, 500] },
  happy:    { speed: 0,  pause: [0, 0] },
};

function fmtSecs(s) {
  if (s == null) return '';
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

// Hermes's own log says what the agent is doing; Janas says what the model is doing.
export function hermesMood(h, j) {
  if (h?.phase === 'done') return 'happy';
  const a = j?.activity?.kind;
  if (a === 'reading') return 'reading';
  if (h?.phase === 'tool') return 'tool';
  if (a === 'writing' || a === 'working' || h?.phase === 'thinking') return 'thinking';
  if (h?.online || j?.online) return 'idle';
  return 'sleep';
}

function bubbleText(mood, h, j, now) {
  const a = j?.activity || {};
  const elapsed = h?.turnStart ? (now - h.turnStart) / 1000 : null;
  switch (mood) {
    case 'reading': return a.total ? `reading ${Math.round((100 * a.done) / a.total)}%` : 'reading';
    case 'thinking': return [
      'thinking',
      a.kind === 'writing' && a.tps ? `${a.tps.toFixed(0)} tok/s` : null,
      elapsed != null ? fmtSecs(elapsed) : null,
    ].filter(Boolean).join(' · ');
    case 'tool': return elapsed != null ? `using tools · ${fmtSecs(elapsed)}` : 'using tools';
    case 'happy': return h?.lastTurnSecs != null ? `done in ${fmtSecs(h.lastTurnSecs)}` : 'done!';
    case 'idle': return 'idle';
    default: return h?.available === false ? 'Hermes not found' : 'asleep';
  }
}

function Face({ mood }) {
  let eyes;
  if (mood === 'sleep') {
    eyes = <path className="lids" d="M6.4 11.6 q2.2 1.6 4.4 0 M13.2 11.6 q2.2 1.6 4.4 0" />;
  } else if (mood === 'happy') {
    eyes = <path className="lids" d="M6.4 12.4 l2.2 -2.4 l2.2 2.4 M13.2 12.4 l2.2 -2.4 l2.2 2.4" />;
  } else {
    eyes = (
      <g className="gaze">
        <g className="eye"><circle cx="8.6" cy="11.2" r="2.25" /><circle className="glint" cx="9.35" cy="10.45" r="0.75" /></g>
        <g className="eye"><circle cx="15.4" cy="11.2" r="2.25" /><circle className="glint" cx="16.15" cy="10.45" r="0.75" /></g>
      </g>
    );
  }
  return (
    <svg className="face" viewBox="0 0 24 24" width="22" height="22">
      <rect className="body" x="1.5" y="1.5" width="21" height="21" rx="6.5" />
      {eyes}
    </svg>
  );
}

export function HermesStage({ h, j, now }) {
  const mood = hermesMood(h, j);
  const stage = useRef(null);
  const actor = useRef(null);
  const moodRef = useRef(mood);
  moodRef.current = mood;
  const pos = useRef({ x: 8, target: 8, pauseUntil: 0, waiting: true, dir: 1, last: performance.now() });

  useEffect(() => {
    let raf;
    const step = (t) => {
      const p = pos.current;
      const dt = Math.min(0.1, (t - p.last) / 1000);
      p.last = t;
      const el = actor.current, st = stage.current;
      if (el && st) {
        const max = Math.max(0, st.clientWidth - el.offsetWidth - 4);
        const m = MOTION[moodRef.current] || MOTION.idle;
        if (moodRef.current === 'sleep') p.target = Math.min(p.target, max);
        if (p.x > max) p.x = max;
        const d = p.target - p.x;
        let moving = false;
        if (m.speed > 0 && Math.abs(d) > 0.5) {
          // Walking toward the target.
          p.x += Math.sign(d) * Math.min(Math.abs(d), m.speed * dt);
          p.dir = Math.sign(d);
          p.waiting = false;
          moving = true;
        } else if (m.speed > 0 && !p.waiting) {
          // Just arrived: rest a moment.
          p.waiting = true;
          p.pauseUntil = t + m.pause[0] + Math.random() * (m.pause[1] - m.pause[0]);
        } else if (m.speed > 0 && t > p.pauseUntil) {
          // Rested: pick somewhere new, not too close to where it is.
          let nx = Math.random() * max;
          if (Math.abs(nx - p.x) < max * 0.15) nx = (nx + max * 0.5) % Math.max(1, max);
          p.target = nx;
        }
        el.style.transform = `translateX(${p.x.toFixed(1)}px)`;
        el.classList.toggle('moving', moving);
        el.dataset.dir = p.dir > 0 ? 'r' : 'l';
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  // A change of mood gets a fresh, short pause so it reacts quickly.
  useEffect(() => {
    const p = pos.current;
    p.waiting = true;
    p.pauseUntil = performance.now() + (mood === 'idle' ? 1500 : 150);
  }, [mood]);

  const tip = [
    `Hermes: ${h?.available === false ? 'log not found' : h?.online ? 'gateway running' : 'gateway asleep'}`,
    h?.turnsToday ? `Turns today: ${h.turnsToday}` : null,
    h?.lastTurnSecs != null ? `Last turn took ${fmtSecs(h.lastTurnSecs)}` : null,
    j?.online ? `Model: ${j.model}` : 'Model server offline',
  ].filter(Boolean).join('\n');

  return (
    <div className="stage" ref={stage}>
      <div className={`hermes ${mood}`} ref={actor} title={tip}>
        <span className="avatar">
          <Face mood={mood} />
          {mood === 'thinking' && <span className="sparks"><i /><i /><i /></span>}
          {mood === 'tool' && <span className="gear">⚙</span>}
          {mood === 'sleep' && <span className="zzz"><i>z</i><i>z</i></span>}
          {mood === 'happy' && <span className="burst"><i /><i /><i /><i /><i /></span>}
        </span>
        <span className="bubble">{bubbleText(mood, h, j, now)}</span>
      </div>
    </div>
  );
}
