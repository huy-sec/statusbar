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
  // Nothing in progress: awake only while the model is up, asleep when it's offline.
  return j?.online ? 'idle' : 'sleep';
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
    default: return h?.available === false ? 'Hermes not found' : j?.online ? 'asleep' : 'asleep · model offline';
  }
}

// Characters to choose from (menu > Character, or click the avatar).
// Each: body shape, where the eyes sit, and any extra parts.
const CHARACTERS = {
  banner: {
    eyes: [[9.5, 10.5], [14.5, 10.5]],
    body: <rect className="body" x="3" y="2" width="18" height="16" rx="5.5" />,
    under: null,
    over: <g className="legs"><rect x="7" y="17.5" width="3" height="5" rx="1.5" /><rect x="14" y="17.5" width="3" height="5" rx="1.5" /></g>,
  },
  wings: {
    eyes: [[9.5, 11.5], [14.5, 11.5]],
    under: <g className="wings"><path className="wing l" d="M4 10 Q-3 4 -2.5 12.5 Q0.5 14.5 4 13.5Z" /><path className="wing r" d="M20 10 Q27 4 26.5 12.5 Q23.5 14.5 20 13.5Z" /></g>,
    body: <rect className="body" x="3" y="3" width="18" height="17" rx="5.5" />,
  },
  blob: {
    eyes: [[9.5, 13], [14.5, 13]],
    body: <path className="body" d="M2.5 22 V10.5 Q2.5 5 8 5 H16 Q21.5 5 21.5 10.5 V22 Q21.5 22.6 20.5 22.6 H3.5 Q2.5 22.6 2.5 22Z" />,
    squish: true,
  },
  ghost: {
    eyes: [[9, 11], [15, 11]],
    body: <path className="body" d="M3 22.5 V11 Q3 2 12 2 Q21 2 21 11 V22.5 L18 20 L15 22.5 L12 20 L9 22.5 L6 20Z" />,
    float: true,
  },
  robot: {
    eyes: [[9.5, 11.5], [14.5, 11.5]],
    under: <><line className="mast" x1="12" y1="1.5" x2="12" y2="5" /><circle className="ant" cx="12" cy="1.5" r="1.7" /></>,
    body: <><rect className="body" x="3" y="5" width="18" height="14" rx="3" /><rect className="screen" x="5.5" y="7.5" width="13" height="8" rx="2" /></>,
    over: <circle className="cog" cx="12" cy="21.5" r="2.4" />,
  },
  pixel: {
    eyes: [[9, 10.5], [15, 10.5]],
    body: <path className="body" d="M5 2h14v2h2v13h-2v2H5v-2H3V4h2z" />,
    over: <g className="legs"><rect x="6" y="19" width="4" height="3" /><rect x="14" y="19" width="4" height="3" /></g>,
    square: true,
  },
};
export const CHARACTER_IDS = ['classic', ...Object.keys(CHARACTERS)];

function CharacterFace({ mood, kind }) {
  const c = CHARACTERS[kind];
  const [[lx, ly], [rx, ry]] = c.eyes;
  let eyes;
  if (mood === 'sleep') {
    eyes = <path className="lids" d={`M${lx - 2.1} ${ly} q2.1 1.5 4.2 0 M${rx - 2.1} ${ry} q2.1 1.5 4.2 0`} />;
  } else if (mood === 'happy') {
    eyes = <path className="lids" d={`M${lx - 2.1} ${ly + 1} l2.1 -2.3 l2.1 2.3 M${rx - 2.1} ${ry + 1} l2.1 -2.3 l2.1 2.3`} />;
  } else {
    eyes = (
      <g className="gaze">
        {c.square
          ? <><rect className="eye oval" x={lx - 1} y={ly - 2.5} width="2" height="5" /><rect className="eye oval" x={rx - 1} y={ry - 2.5} width="2" height="5" /></>
          : <><ellipse className="eye oval" cx={lx} cy={ly} rx="1.9" ry="3.1" /><ellipse className="eye oval" cx={rx} cy={ry} rx="1.9" ry="3.1" /></>}
      </g>
    );
  }
  const inner = <>{c.under}{c.body}{eyes}{c.over}</>;
  return (
    <svg className={`face k-${kind}`} viewBox="0 0 24 24" width="22" height="22" shapeRendering={c.square ? 'crispEdges' : undefined}>
      {c.squish ? <g className="squish">{inner}</g> : c.float ? <g className="float">{inner}</g> : inner}
    </svg>
  );
}

function Face({ mood, kind }) {
  if (CHARACTERS[kind]) return <CharacterFace mood={mood} kind={kind} />;
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

export function HermesStage({ h, j, now, character = 'banner' }) {
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
    'Click to change character',
  ].filter(Boolean).join('\n');

  return (
    <div className="stage" ref={stage}>
      <div className={`hermes ${mood}`} ref={actor} title={tip} onClick={() => window.bar.nextCharacter()}>
        <span className="avatar">
          <Face mood={mood} kind={character} />
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
