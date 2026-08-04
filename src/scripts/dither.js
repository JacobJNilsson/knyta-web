// Two-tone ordered (Bayer) dithering, animated, framework-free.
//
// Renders an animated grayscale "field" into a low-res buffer, quantises each
// pixel to one of two colours via an ordered Bayer threshold matrix, and scales
// the result up with pixelated rendering to get chunky, authentic dithering.
// One neutral + one accent colour per instance — never black/white by default.

// ---- Bayer threshold matrices (normalised 0..1) ---------------------------

function bayer(n) {
  // Recursive Bayer matrix of size n (n = power of two), values 0..(n*n-1).
  if (n === 1) return [[0]];
  const half = bayer(n / 2);
  const h = n / 2;
  const m = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < h; x++) {
      const base = half[y][x] * 4;
      m[y][x] = base + 0;
      m[y][x + h] = base + 2;
      m[y + h][x] = base + 3;
      m[y + h][x + h] = base + 1;
    }
  }
  return m;
}

function bayerNorm(n) {
  const m = bayer(n);
  const denom = n * n;
  return m.map((row) => row.map((v) => (v + 0.5) / denom));
}

const MATRICES = { 2: bayerNorm(2), 4: bayerNorm(4), 8: bayerNorm(8) };

// ---- Field functions: (x, y, t) -> 0..1 -----------------------------------
// x, y are normalised 0..1 across the buffer; t is seconds.

const TAU = Math.PI * 2;

// Precomputed trefoil-knot polyline in a centred ~[-1,1] space. The parametric
// trefoil traces the whole over-under knot in one continuous pass, so revealing
// it point-by-point along the parameter reads as "tying"; hiding it reads as
// "untying".
const KNOT_PTS = (() => {
  const N = 150;
  const pts = new Array(N);
  for (let i = 0; i < N; i++) {
    const th = (i / N) * TAU;
    const x = Math.sin(th) + 2 * Math.sin(2 * th);
    const y = Math.cos(th) - 2 * Math.cos(2 * th);
    pts[i] = [x / 3.2, y / 3.2];
  }
  return pts;
})();

const FIELDS = {
  // Soft plasma — good for full-bleed moody backgrounds.
  plasma(x, y, t) {
    const v =
      Math.sin(x * 6 + t) +
      Math.sin(y * 5 - t * 0.8) +
      Math.sin((x + y) * 4 + t * 0.6) +
      Math.sin(Math.hypot(x - 0.5, y - 0.5) * 10 - t * 1.2);
    return (v + 4) / 8;
  },

  // Concentric ripples radiating from centre — the "tie" developing.
  ripple(x, y, t) {
    const d = Math.hypot(x - 0.5, y - 0.5);
    const v = Math.sin(d * 26 - t * 2.2) * (1 - d) + (1 - d) * 0.6;
    return Math.min(1, Math.max(0, (v + 1) / 2));
  },

  // Horizontal flowing bands — a data stream moving left.
  stream(x, y, t) {
    const v =
      Math.sin((x * 9 - t * 1.6) + Math.sin(y * 7 + t * 0.4) * 1.4) * 0.7 +
      Math.sin(y * 22 - t * 0.6) * 0.3;
    return (v + 1) / 2;
  },

  // A breathing focal orb: a radial base (bright centre, dark rim — keeps
  // overlaid text legible) broken up by plasma-like turbulence so the palette
  // transitions dither as rich grain instead of flat concentric bands.
  orb(x, y, t) {
    const d = Math.hypot(x - 0.5, y - 0.5);
    let base = 1 - d / 0.5; // 1 at centre -> 0 at rim
    // High-frequency turbulence — the texture that reads as good dithering.
    const turb =
      Math.sin(x * 15 + t) +
      Math.sin(y * 13 - t * 0.8) +
      Math.sin((x + y) * 11 + t * 0.6) +
      Math.sin((x - y) * 17 - t * 0.5);
    base += turb * 0.045;
    // Slow breathing + a soft turbulent rim.
    base += Math.sin(t * 0.7) * 0.02 + Math.sin(d * 20 - t * 1.4) * 0.02;
    return Math.min(1, Math.max(0, base));
  },

  // An interactive turbulent blob. Its centre follows the cursor (ctx.px/py),
  // it swells slightly while pressed, and clicks send expanding dithered rings.
  // Falls back to a centred, breathing blob when no pointer context is given.
  blob(x, y, t, ctx) {
    const cx = ctx ? ctx.bx : 0.5;
    const cy = ctx ? ctx.by : 0.5;
    const press = ctx ? ctx.pd : 0;
    const d = Math.hypot(x - cx, y - cy);
    const radius = 0.34 + press * 0.06 + Math.sin(t * 0.7) * 0.02;
    let base = 1 - d / radius;
    // High-frequency turbulence — the lively grain the flat orb lacked.
    base +=
      (Math.sin(x * 15 + t) +
        Math.sin(y * 13 - t * 0.8) +
        Math.sin((x + y) * 11 + t * 0.6) +
        Math.sin((x - y) * 17 - t * 0.5)) *
      0.05;
    base += Math.sin(d * 22 - t * 1.4) * 0.025; // soft ragged rim
    // Expanding rings from clicks.
    if (ctx && ctx.ripples) {
      for (let i = 0; i < ctx.ripples.length; i++) {
        const r = ctx.ripples[i];
        const age = t - r.t;
        if (age <= 0 || age >= 1.8) continue;
        const rd = Math.hypot(x - r.x, y - r.y);
        const ring = Math.max(0, 1 - Math.abs(rd - age * 0.55) / 0.05);
        base += ring * (1 - age / 1.8) * 0.9;
      }
    }
    return base;
  },

  // A trefoil knot that ties itself on, then unties, while slowly rotating.
  // The accent traces the drawn portion of the curve; the rest is neutral.
  knot(x, y, t) {
    const N = KNOT_PTS.length;
    // Tie (0->1) then untie (1->0) via a triangle wave; ease the ends so the
    // reveal lingers at fully-tied and fully-untied for a beat.
    const phase = (t * 0.32) % 2;
    let rev = phase < 1 ? phase : 2 - phase;
    rev = rev * rev * (3 - 2 * rev); // smoothstep
    const count = Math.max(2, Math.floor(rev * N));
    // Rotate the query point instead of the whole knot (cheaper), and add a
    // gentle breathing scale so it feels alive.
    const ang = t * 0.18;
    const ca = Math.cos(-ang), sa = Math.sin(-ang);
    const qx = x - 0.5, qy = y - 0.5;
    const rx = qx * ca - qy * sa;
    const ry = qx * sa + qy * ca;
    const S = 0.4 + Math.sin(t * 0.9) * 0.015;
    let best = 1e9;
    for (let i = 0; i < count; i++) {
      const dx = rx - KNOT_PTS[i][0] * S;
      const dy = ry - KNOT_PTS[i][1] * S;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    const dist = Math.sqrt(best);
    const core = Math.max(0, 1 - dist / 0.055); // solid stroke
    const glow = Math.max(0, 1 - dist / 0.15) * 0.55; // dithered halo
    return Math.min(1, core + glow);
  },

  // Interfering diagonal gratings — a woven / moiré weave, scrolling.
  weave(x, y, t) {
    const a = Math.sin((x + y) * 26 - t * 1.3);
    const b = Math.sin((x - y) * 26 + t * 0.9);
    const flow = Math.sin(x * 4 - t * 0.5) * 0.4;
    return (a * 0.5 + b * 0.5 + flow + 1.4) / 2.8;
  },
};

// ---- Renderer -------------------------------------------------------------

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * startDither(canvas, opts)
 *  colorA   neutral (low)  hex        — where the field is dark
 *  colorB   accent (high)  hex        — where the field is bright
 *  palette  optional [hex, hex, hex, ...] — dark→light ordered colour ramp.
 *           When given (length >= 2) it overrides colorA/colorB and the field
 *           is ordered-dithered across the whole ramp. Use 3+ entries for a
 *           multi-colour variant.
 *  field    name of a FIELDS function ('plasma'|'ripple'|'stream'|'orb'|'weave')
 *  matrix   2 | 4 | 8   Bayer size (bigger = finer dither)
 *  scale    px size of one dither cell on screen (bigger = chunkier)
 *  speed    time multiplier
 */
export function startDither(canvas, opts = {}) {
  const {
    colorA = '#1a1712',
    colorB = '#e0684a',
    palette = null,
    field = 'plasma',
    matrix = 4,
    speed = 1,
    respectReducedMotion = true,
    interactive = false,
    // { radius, feather, color } — clear the dither to a solid colour in a
    // disc that follows the cursor (a "clean" area over the "messy" field).
    clear = null,
    // Couple the field to page scroll so the background drifts as you scroll.
    scroll = false,
    scrollFactor = 0.25,
  } = opts;

  let scale = opts.scale ?? 4;
  let boidCount = opts.boidCount ?? 90;

  // Boid/render config. Callers can override any field via opts.cfg; it stays
  // live-tunable at runtime through the returned controller / canvas.__dither.
  const cfg = {
    maxSpeed: 0.0034, maxForce: 0.00026,
    perception: 0.4, separationDist: 0.055,
    cohesion: 1.6, alignment: 0.7, separation: 1.1,
    flee: 3.0, fleeRadius: 0.26, centering: 0.0003,
    homeSpeed: 0.06,   // how fast the wandering "home" roams the page
    edgeRepel: 0.0012, // strength of the off-screen repellent around the edges
    edgeMargin: 0.06,  // how close to an edge before the repellent kicks in
    damping: 0.9, // velocity retention per frame; <1 settles the swarm
    splatSize: 0.045, splatIntensity: 2.6,
    blur: 0.06, blurPasses: 3,
    holdMs: 0, // a cell can't switch colour again until this many ms have passed
    ...(opts.cfg || {}),
  };

  const ctx = canvas.getContext('2d', { alpha: false });
  const M = MATRICES[matrix] || MATRICES[4];
  const mN = M.length;
  const fieldFn = FIELDS[field] || FIELDS.plasma;
  // Build the colour ramp: an explicit palette, or the two-tone [A, B].
  const PAL = (palette && palette.length >= 2 ? palette : [colorA, colorB]).map(hexToRgb);
  const steps = PAL.length - 1;
  const reduce =
    respectReducedMotion &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let bw = 0, bh = 0, img = null, raf = 0, start = null;

  // Pointer/interaction state, exposed to fields via the ctx arg. `px,py` ease
  // toward the cursor (`tx,ty`); `pd` is a smoothed press amount; `ripples`
  // holds expanding click rings, each { x, y, t } in field/time units.
  // px/py: precise eased pointer (used by the clear disc). bx/by: the blob's
  // own centre — a slow, wandering drift *toward* the pointer, so it feels alive
  // rather than glued under the cursor.
  const P = { px: 0.5, py: 0.5, tx: 0.5, ty: 0.5, bx: 0.5, by: 0.5, hx: 0.8, hy: 0.5, pd: 0, down: 0, active: 0, ripples: [] };
  // Active touch points (pointerId -> {tx, ty}). On mobile each finger is a
  // repellent the swarm flees, so it dodges touches.
  const touches = new Map();
  let curT = 0;
  let prevSoff = 0;         // previous scroll offset, to detect active scrolling
  let lastScrollMs = -1e9;  // timestamp of the last scroll movement
  // Fixed-timestep integration: advance the boid physics a steady N steps per
  // second regardless of the display's refresh rate. This decouples speed from
  // frame rate (no 2x on 120 Hz). Fewer steps/sec = slower + lighter but choppier
  // motion; more = smoother. Runtime-adjustable via the controller.
  let stepMs = 1000 / Math.max(1, Math.min(60, opts.stepsPerSec ?? 20));
  let lastNow = null;       // timestamp of the previous frame
  let acc = 0;              // unspent real time, in ms, awaiting fixed steps
  const cleanups = [];
  const clearRGB = clear ? hexToRgb(clear.color || '#f3ede1') : null;
  const clearR = clear ? (clear.radius ?? 0.16) : 0;
  const clearF = clear ? (clear.feather ?? 0.09) : 0;

  // Boid swarm: agents that flock (separation / alignment / cohesion), drift
  // toward the cursor, and are splatted into the field so the dither renders a
  // living swarm instead of a single blob.
  const isBoids = field === 'boids';
  const boids = [];
  function initBoids(n) {
    boids.length = 0;
    const aspectInv = bw / vhCells;                // viewport width in heights
    const s = scrollY / (window.innerHeight || 1); // viewport top, in heights
    for (let i = 0; i < n; i++) {
      boids.push({
        // Scatter within the current viewport (kept just inside the 5% edge).
        x: (0.05 + Math.random() * 0.9) * aspectInv,
        y: s + (0.05 + Math.random() * 0.9),
        vx: (Math.random() - 0.5) * 0.003,
        vy: (Math.random() - 0.5) * 0.003,
      });
    }
  }

  // boidCount is a DENSITY: agents per reference viewport (~1440x840). The
  // actual agent count scales with the viewport's pixel area, so density is
  // consistent per screen area. (Only the count scales — never intensity.)
  function targetCount() {
    const vpArea = (window.innerWidth || 1) * (window.innerHeight || 1);
    return Math.max(6, Math.round(boidCount * vpArea / (1440 * 840)));
  }

  let fieldArr = null; // accumulation buffer for boid splats (with margin)
  let fieldTmp = null; // scratch for the separable blur
  let blurPref = null; // reusable prefix-sum scratch for the O(1) box blur
  let holdSel = null;  // last committed palette index per cell (255 = unset)
  let holdTime = null; // ms timestamp of each cell's last colour switch
  let creamData = null; // full-canvas fill of the low palette colour (out-of-band rows)
  // The boid field is rendered into a buffer padded by PAD cells on every side so
  // boids just off-screen still contribute to on-screen density and the blur has
  // real neighbour data past the visible edge (no edge thinning / flicker).
  let PAD = 0, fw = 0, fh = 0;
  // Boids simulate in PAGE space normalised by viewport HEIGHT: 1 unit = one
  // viewport height (= vhCells cells). The viewport is [0, aspectInv] wide and 1
  // tall; the document runs to y = S. Height-normalising keeps flocking spacing
  // and blob size consistent across aspect ratios, and lets agent count scale
  // with the viewport's area (a true density).
  let vhCells = 1, cw = 1, chpx = 1;

  // Scroll coupling.
  let scrollY = 0;
  let homeScrollU = null; // viewport top (in heights) at the previous boid step
  if (scroll) {
    const onScroll = () => {
      const y = window.scrollY || window.pageYOffset || 0;
      // P.ty and the touch points are document-relative, but a cursor or finger
      // is fixed to the viewport. Carry the stored targets with the page so they
      // keep pointing at the real input while the user scrolls without moving.
      const dy = (y - scrollY) / chpx;
      if (P.active) P.ty += dy;
      for (const tp of touches.values()) tp.ty += dy;
      scrollY = y;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    cleanups.push(() => window.removeEventListener('scroll', onScroll));
  }

  // Reynolds/Shiffman flocking: each rule produces a steering force
  // (desired - velocity) clamped to maxForce; velocity is clamped to maxSpeed.
  // scale factor that limits (fx,fy) to a max magnitude
  const lf = (fx, fy, max) => { const m = Math.hypot(fx, fy); return m > max && m > 1e-9 ? max / m : 1; };

  function stepBoids(t) {
    const MS = cfg.maxSpeed, MF = cfg.maxForce;
    const PERC2 = cfg.perception * cfg.perception;
    const SEP2 = cfg.separationDist * cfg.separationDist;
    const FLEE_R = cfg.fleeRadius;
    // Page space, normalised by viewport height: viewport is [0,aspectInv] x 1,
    // document runs to y = S. Home tracks the current viewport (scroll offset).
    const aspectInv = bw / vhCells;                      // viewport width in heights
    const S = bh / vhCells;                              // document height in heights
    const scrollU = scrollY / (window.innerHeight || 1); // viewport top, in heights
    const curX = P.px * aspectInv;                       // cursor x (P.px is width-norm)
    const curY = P.py * S;                               // cursor y (P.py is doc-norm)
    const press = P.pd; // smoothed press amount 0..1
    // Home wanders within the current viewport, but slides to the cursor while
    // pressed so the swarm gathers there through the gentle centering force.
    // Carry home with the page. Home lives in document space, so a scroll
    // leaves it behind: the easing below moves 2.5% per step and can never
    // catch a scroll gesture. Only home moves — the swarm keeps its absolute
    // position in the document and must fly to the new home on its own.
    if (homeScrollU === null) homeScrollU = scrollU;
    P.hy += scrollU - homeScrollU;
    homeScrollU = scrollU;
    // Wandering target within the current viewport.
    const wanderX = aspectInv * (0.5 + 0.45 * Math.sin(t * cfg.homeSpeed));
    const wanderY = scrollU + (0.5 + 0.45 * Math.sin(t * cfg.homeSpeed * 0.73 + 2.1));
    if (P.down) {
      // Teleport to and stay exactly under the pointer while held.
      P.hx = P.tx * aspectInv; P.hy = P.ty * S;
    } else {
      // On release, resume wandering FROM the current position: ease the
      // persistent home toward the (moving) wander target.
      P.hx += (wanderX - P.hx) * 0.025;
      P.hy += (wanderY - P.hy) * 0.025;
    }
    // Hard clamp home into the visible band. The carry above handles smooth
    // scrolling; this catches everything else that can strand it (a resize, an
    // anchor jump, a document that grew, a press near the viewport edge).
    const HM = Math.min(0.03, S * 0.5);
    P.hy = Math.min(Math.max(P.hy, scrollU + HM), scrollU + Math.min(1, S) - HM);
    P.hx = Math.min(Math.max(P.hx, HM), Math.max(HM, aspectInv - HM));
    const homeX = P.hx, homeY = P.hy;
    const em = cfg.edgeMargin, er = cfg.edgeRepel;
    for (let i = 0; i < boids.length; i++) {
      const b = boids[i];
      let alx = 0, aly = 0, cox = 0, coy = 0, sepx = 0, sepy = 0, nc = 0;
      for (let j = 0; j < boids.length; j++) {
        if (i === j) continue;
        const o = boids[j];
        const dx = b.x - o.x, dy = b.y - o.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < PERC2) { alx += o.vx; aly += o.vy; cox += o.x; coy += o.y; nc++; }
        if (d2 < SEP2 && d2 > 1e-9) { const d = Math.sqrt(d2); sepx += dx / d / d; sepy += dy / d / d; }
      }
      let ax = 0, ay = 0;
      if (nc > 0) {
        let avx = alx / nc, avy = aly / nc; let m = Math.hypot(avx, avy);
        if (m > 1e-9) { avx = avx / m * MS; avy = avy / m * MS; }
        let sx = avx - b.vx, sy = avy - b.vy; let f = lf(sx, sy, MF);
        ax += sx * f * cfg.alignment; ay += sy * f * cfg.alignment;
        let cdx = cox / nc - b.x, cdy = coy / nc - b.y; m = Math.hypot(cdx, cdy);
        if (m > 1e-9) { cdx = cdx / m * MS; cdy = cdy / m * MS; }
        sx = cdx - b.vx; sy = cdy - b.vy; f = lf(sx, sy, MF);
        ax += sx * f * cfg.cohesion; ay += sy * f * cfg.cohesion;
      }
      let sm = Math.hypot(sepx, sepy);
      if (sm > 1e-9) {
        let dsx = sepx / sm * MS, dsy = sepy / sm * MS;
        let sx = dsx - b.vx, sy = dsy - b.vy; let f = lf(sx, sy, MF);
        ax += sx * f * cfg.separation; ay += sy * f * cfg.separation;
      }
      if (P.active) {
        const toX = curX - b.x, toY = curY - b.y; const fd = Math.hypot(toX, toY);
        // Flee the cursor, within the flee radius, when not pressed. The flee
        // fades out as you press (home has moved to the cursor, so the swarm
        // gathers there instead of being repelled).
        if (fd < FLEE_R && fd > 1e-4) {
          const dfx = -toX / fd * MS, dfy = -toY / fd * MS;
          const sx = dfx - b.vx, sy = dfy - b.vy; const f = lf(sx, sy, MF);
          const e = 1 - fd / FLEE_R;
          const w = cfg.flee * e * e * (1 - press);
          ax += sx * f * w; ay += sy * f * w;
        }
      }
      // Flee every active touch point (mobile has no hover, so touches are the
      // only thing to avoid).
      if (touches.size) {
        for (const tp of touches.values()) {
          const dx = tp.tx * aspectInv - b.x, dy = tp.ty * S - b.y;
          const fd = Math.hypot(dx, dy);
          if (fd < FLEE_R && fd > 1e-4) {
            const dfx = -dx / fd * MS, dfy = -dy / fd * MS;
            const sx = dfx - b.vx, sy = dfy - b.vy; const f = lf(sx, sy, MF);
            const e = 1 - fd / FLEE_R;
            const w = cfg.flee * e * e;
            ax += sx * f * w; ay += sy * f * w;
          }
        }
      }
      ax += (homeX - b.x) * cfg.centering; ay += (homeY - b.y) * cfg.centering;
      // Edge repellent all around the screen — push inward, stronger the deeper
      // a boid strays into the margin, so the swarm avoids leaving the viewport.
      if (b.x < em) ax += (1 - b.x / em) * er;
      else if (b.x > aspectInv - em) ax -= (1 - (aspectInv - b.x) / em) * er;
      if (b.y < em) ay += (1 - b.y / em) * er;
      else if (b.y > S - em) ay -= (1 - (S - b.y) / em) * er;
      // Damping bleeds off momentum so the swarm settles instead of oscillating.
      b.vx = (b.vx + ax) * cfg.damping; b.vy = (b.vy + ay) * cfg.damping;
      const f = lf(b.vx, b.vy, MS); b.vx *= f; b.vy *= f;
      b.x += b.vx; b.y += b.vy;
    }
  }

  function splatBoids() {
    fieldArr.fill(0);
    const R = Math.max(2, Math.round(vhCells * cfg.splatSize));
    const inv = 1 / (R * R);
    const intensity = cfg.splatIntensity;
    for (let k = 0; k < boids.length; k++) {
      const b = boids[k];
      // Page space -> padded buffer. 1 height-unit = vhCells cells in both axes.
      // No scroll term: the canvas is document-anchored, so it scrolls with the
      // page natively.
      const cx = Math.round(PAD + b.x * vhCells);
      const cy = Math.round(PAD + b.y * vhCells);
      for (let dy = -R; dy <= R; dy++) {
        const yy = cy + dy; if (yy < 0 || yy >= fh) continue;
        const row = yy * fw;
        for (let dx = -R; dx <= R; dx++) {
          const xx = cx + dx; if (xx < 0 || xx >= fw) continue;
          const dd = dx * dx + dy * dy; if (dd > R * R) continue;
          const f = 1 - dd * inv;
          fieldArr[row + xx] += f * f * intensity;
        }
      }
    }
  }

  if (interactive) {
    const rectNorm = (e) => {
      if (e.clientX == null || e.clientY == null) return null;
      const r = canvas.getBoundingClientRect();
      return { tx: (e.clientX - r.left) / r.width, ty: (e.clientY - r.top) / r.height };
    };
    const isTouch = (e) => e.pointerType === 'touch';
    const setTarget = (e) => { const n = rectNorm(e); if (n) { P.tx = n.tx; P.ty = n.ty; P.active = 1; } };
    const onMove = (e) => {
      if (isTouch(e)) { if (touches.has(e.pointerId)) { const n = rectNorm(e); if (n) touches.set(e.pointerId, n); } }
      else setTarget(e);
    };
    const onDown = (e) => {
      if (isTouch(e)) {
        // A finger is a repellent the swarm avoids, not a magnet.
        const n = rectNorm(e); if (n) touches.set(e.pointerId, n);
      } else {
        setTarget(e);
        P.down = 1;
        P.ripples.push({ x: P.tx, y: P.ty, t: curT });
        if (P.ripples.length > 6) P.ripples.shift();
      }
    };
    const endTouch = (e) => { if (isTouch(e)) touches.delete(e.pointerId); };
    const onUp = (e) => { endTouch(e); if (!isTouch(e)) P.down = 0; };
    // Stop reacting to a stale cursor once the pointer leaves the page / focus
    // is lost: clear active, held, and any lingering touches.
    const onLeave = () => { P.active = 0; P.down = 0; touches.clear(); };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown, { passive: true });
    window.addEventListener('pointerup', onUp, { passive: true });
    window.addEventListener('pointercancel', endTouch, { passive: true });
    document.addEventListener('pointerleave', onLeave, { passive: true });
    window.addEventListener('blur', onLeave, { passive: true });
    cleanups.push(() => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', endTouch);
      document.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('blur', onLeave);
    });
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    cw = r.width || 1;
    chpx = r.height || 1;
    bw = Math.max(1, Math.ceil(r.width / scale));
    bh = Math.max(1, Math.ceil(r.height / scale));
    canvas.width = bw;
    canvas.height = bh;
    img = ctx.createImageData(bw, bh);
    if (isBoids) {
      vhCells = Math.max(1, Math.round((window.innerHeight || 1) / scale));
      PAD = Math.max(2, Math.round(vhCells * 0.2)); // screen-relative margin
      fw = bw + 2 * PAD; fh = bh + 2 * PAD;
      fieldArr = new Float32Array(fw * fh);
      fieldTmp = new Float32Array(fw * fh);
      blurPref = new Float64Array(Math.max(fw, fh) + 1);
    }
    holdSel = new Uint8Array(bw * bh).fill(255);
    holdTime = new Float64Array(bw * bh);
    // Precompute a solid fill of the low palette colour; the viewport-band
    // renderer copies it in so off-band rows always show the page cream.
    creamData = new Uint8ClampedArray(bw * bh * 4);
    for (let i = 0; i < creamData.length; i += 4) {
      creamData[i] = PAL[0][0]; creamData[i + 1] = PAL[0][1]; creamData[i + 2] = PAL[0][2]; creamData[i + 3] = 255;
    }
    img.data.set(creamData);
    if (isBoids) {
      const target = targetCount();
      if (boids.length !== target) initBoids(target);
    }
  }

  // Separable box blur over the accumulation buffer, so the discrete boid
  // splats merge into one smooth blob *before* it gets dithered. This keeps the
  // chunky dither texture (unlike a CSS blur, which would smooth it away).
  //
  // Implemented with prefix sums (a row/column integral), so each output pixel
  // costs O(1) regardless of the blur radius r — one linear pass to build the
  // prefix, one to read windows. This replaces the old O(r)-per-pixel kernel,
  // which dominated frame time at large radii and capped the frame rate.
  //
  // Blur only the row range [ry0, ry1) of the padded buffer (defaults to all).
  // The horizontal pass covers ry0-r..ry1+r so the vertical pass has valid data.
  // Windows are normalised by their actual (edge-clamped) width — no darkening
  // at the buffer edges, and no division by zero (width >= 1 always).
  function blurBuffer(r, ry0, ry1) {
    const a0 = ry0 == null ? 0 : ry0, a1 = ry1 == null ? fh : ry1;
    const hy0 = Math.max(0, a0 - r), hy1 = Math.min(fh, a1 + r);
    const pref = blurPref;
    // Horizontal pass: fieldArr -> fieldTmp, rows [hy0, hy1)
    for (let y = hy0; y < hy1; y++) {
      const o = y * fw;
      let s = 0; pref[0] = 0;
      for (let x = 0; x < fw; x++) { s += fieldArr[o + x]; pref[x + 1] = s; }
      for (let x = 0; x < fw; x++) {
        const lo = x - r < 0 ? 0 : x - r;
        const hi = x + r >= fw ? fw - 1 : x + r;
        fieldTmp[o + x] = (pref[hi + 1] - pref[lo]) / (hi - lo + 1);
      }
    }
    // Vertical pass: fieldTmp -> fieldArr, rows [a0, a1). pref is indexed by row.
    for (let x = 0; x < fw; x++) {
      let s = 0; pref[hy0] = 0;
      for (let y = hy0; y < hy1; y++) { s += fieldTmp[y * fw + x]; pref[y + 1] = s; }
      for (let y = a0; y < a1; y++) {
        const lo = y - r < hy0 ? hy0 : y - r;
        const hi = y + r >= hy1 ? hy1 - 1 : y + r;
        fieldArr[y * fw + x] = (pref[hi + 1] - pref[lo]) / (hi - lo + 1);
      }
    }
  }

  function frame(now) {
    if (start === null) start = now;
    const t = ((now - start) / 1000) * speed;
    curT = t;
    // Real time since the last frame, scaled by `speed`. Clamp to ~5 steps so a
    // stalled/backgrounded tab doesn't unleash a burst of catch-up steps.
    let dt = (lastNow === null ? stepMs : now - lastNow) * speed;
    lastNow = now;
    if (dt > stepMs * 5) dt = stepMs * 5;
    if (dt < 0) dt = 0;
    // Frame-rate-independent exponential smoothing: a per-1/60s-step factor,
    // compounded over however many steps this frame spans, so easings converge
    // at the same wall-clock rate on 60 Hz and 120 Hz alike.
    const dtSteps = dt / stepMs;
    const ease = (base) => 1 - Math.pow(1 - base, dtSteps);
    // Ease pointer toward its target and smooth the press amount.
    P.px += (P.tx - P.px) * ease(0.12);
    P.py += (P.ty - P.py) * ease(0.12);
    P.pd += (P.down - P.pd) * ease(0.15);
    // Blob centre: a slow drift toward the pointer (or screen centre when idle)
    // plus organic wander, so it moves *toward* the cursor and feels alive.
    const gx = P.active ? P.tx : 0.5;
    const gy = P.active ? P.ty : 0.5;
    const wanderX = Math.sin(t * 0.5) * 0.05 + Math.sin(t * 1.13 + 1.7) * 0.03;
    const wanderY = Math.cos(t * 0.43) * 0.05 + Math.sin(t * 0.97 + 0.6) * 0.03;
    P.bx += (gx + wanderX - P.bx) * ease(0.045);
    P.by += (gy + wanderY - P.by) * ease(0.045);
    // Drop expired ripples (rings live ~1.8s).
    if (P.ripples.length) P.ripples = P.ripples.filter((r) => t - r.t < 1.8);
    const fctx = P;
    const aspect = bw / bh;
    // Scroll offset: shift the field vertically as the page scrolls.
    const soff = scroll ? (scrollY / (window.innerHeight || 1)) * scrollFactor : 0;
    // While actively scrolling, the content moving through each screen cell
    // changes legitimately, so the per-cell colour hold must not freeze it.
    // Debounced (held ~180ms past the last movement) so momentum/jitter scroll
    // doesn't rapidly toggle the hold and flicker the edges.
    if (Math.abs(soff - prevSoff) > 1e-5) lastScrollMs = now;
    prevSoff = soff;
    const scrolling = now - lastScrollMs < 180;
    // Only render the band of buffer rows near the viewport. The swarm's home
    // tracks the view, so the field is cream everywhere else; off-band rows are
    // filled from creamData. Huge saving on a tall (document-anchored) page.
    let vy0 = 0, vy1 = bh;
    if (isBoids && scroll) {
      const m = Math.round(vhCells * 0.6); // margin absorbs blur + swarm lag on scroll
      vy0 = Math.max(0, Math.floor(scrollY / scale) - m);
      vy1 = Math.min(bh, Math.ceil((scrollY + (window.innerHeight || 1)) / scale) + m);
      img.data.set(creamData);
    }
    if (isBoids) {
      // The boid canvas is document-anchored (position: absolute over the whole
      // page), so scrolling is handled natively by the browser — no offset here.
      // Advance the physics in fixed 1/60s steps, running as many as the real
      // elapsed time calls for (0..5). This decouples swarm speed from refresh
      // rate: 120 Hz renders twice as often but steps the boids just as fast.
      acc += dt;
      let steps = 0;
      while (acc >= stepMs && steps < 5) { stepBoids(t); acc -= stepMs; steps++; }
      splatBoids();
      const br = Math.max(1, Math.round(vhCells * cfg.blur));
      for (let p = 0; p < cfg.blurPasses; p++) blurBuffer(br, vy0 + PAD, vy1 + PAD);
    }
    const data = img.data;
    for (let y = vy0; y < vy1; y++) {
      const ny = y / bh;
      const mrow = M[y % mN];
      for (let x = 0; x < bw; x++) {
        let v = isBoids ? fieldArr[(y + PAD) * fw + (x + PAD)] : fieldFn(x / bw, ny + soff, t, fctx);
        // Clamp to [0,1]; NaN (which fails both comparisons) collapses to the
        // hot end so it blends into a dense core instead of rendering black.
        if (v > 1 || v !== v) v = 1; else if (v < 0) v = 0;
        const thr = mrow[x % mN];
        // Ordered dithering across the ramp: pick a discrete palette colour,
        // nudging to the next stop when the field exceeds the Bayer threshold.
        const scaled = v * steps;
        const low = Math.floor(scaled);
        const frac = scaled - low;
        let sel = frac > thr ? low + 1 : low;
        if (sel > steps) sel = steps;
        // Temporal hold: a cell keeps its colour for holdMs after a switch, so
        // cells near a threshold stop flickering frame-to-frame.
        if (cfg.holdMs > 0) {
          const cell = y * bw + x;
          if (scrolling) {
            // Suspend the hold during scroll; keep buffers fresh so anti-flicker
            // resumes cleanly the moment scrolling stops.
            holdSel[cell] = sel; holdTime[cell] = now;
          } else {
            const prev = holdSel[cell];
            if (prev === 255) { holdSel[cell] = sel; holdTime[cell] = now; }
            else if (sel !== prev) {
              if (now - holdTime[cell] < cfg.holdMs) sel = prev;
              else { holdSel[cell] = sel; holdTime[cell] = now; }
            }
          }
        }
        const c = PAL[sel];
        let r0 = c[0], g0 = c[1], b0 = c[2];
        // Clean disc: blend toward the solid clear colour near the cursor.
        if (clearRGB && P.active) {
          const dxx = (x / bw - P.px) * aspect;
          const dyy = y / bh - P.py;
          const dist = Math.sqrt(dxx * dxx + dyy * dyy);
          let amt = (clearR - dist) / clearF; // 1 inside, 0 outside
          if (amt > 1) amt = 1; else if (amt < 0) amt = 0;
          if (amt > 0) {
            r0 += (clearRGB[0] - r0) * amt;
            g0 += (clearRGB[1] - g0) * amt;
            b0 += (clearRGB[2] - b0) * amt;
          }
        }
        const idx = (y * bw + x) * 4;
        data[idx] = r0;
        data[idx + 1] = g0;
        data[idx + 2] = b0;
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    if (!reduce) raf = requestAnimationFrame(frame);
  }

  resize();
  let rt;
  const onResize = () => {
    clearTimeout(rt);
    // Redraw immediately after resize (setting canvas.width clears it). Cancel
    // the pending rAF first so we don't start a second animation loop.
    rt = setTimeout(() => { cancelAnimationFrame(raf); resize(); frame(performance.now()); }, 120);
  };
  window.addEventListener('resize', onResize);
  cleanups.push(() => { window.removeEventListener('resize', onResize); clearTimeout(rt); });

  // Paint one frame immediately so the canvas is never blank (rAF is paused in
  // background tabs). When not reduced, frame() self-schedules the next rAF.
  frame(performance.now());

  const controller = {
    cfg,
    setCount: (n) => { boidCount = Math.max(1, Math.round(n)); if (isBoids) initBoids(targetCount()); },
    getCount: () => boidCount,
    setScale: (s) => { cancelAnimationFrame(raf); scale = Math.max(1, s); resize(); frame(performance.now()); },
    getScale: () => scale,
    // Simulation cadence, in physics steps per second (1..60).
    setStepRate: (n) => { stepMs = 1000 / Math.max(1, Math.min(60, n)); },
    getStepRate: () => 1000 / stepMs,
    dispose: () => { cancelAnimationFrame(raf); cleanups.forEach((f) => f()); },
  };
  canvas.__dither = controller;
  return controller;
}
