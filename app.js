// ═══════════════════════════════════════════════════════════════════════════
//  GESTURAL — app.js
//
//  Gesture system:
//    • Index fingertip (lm[8])  → YELLOW DOT — aims / moves shape
//    • Thumb tip (lm[4])        → MAGENTA DOT
//    • All other fingertips     → CYAN DOTS
//    • Dashed line between thumb + index shows current spread distance
//
//  Scale control (V-spread / Pinch):
//    • Distance between thumb tip and index tip (normalised)
//    • Tips touching (pinch) → shape SMALL
//    • Fingers spread in V   → shape LARGE
//    • Continuous real-time mapping — no button needed
//
//  Rotation:
//    • Angle of wrist → middle-MCP axis drives rotation continuously
//
//  Reset:
//    • Open palm (4+ fingers extended) → reset position, scale, rotation
//
//  Shape ALWAYS renders — never disappears when hand is absent
// ═══════════════════════════════════════════════════════════════════════════

// ── App state ────────────────────────────────────────────────────────────────
let mode       = 'direct';   // 'direct' | 'mirror' | 'mirror-flip'
let facingMode = 'user';
let showFeed   = false;
let shapeIndex = 0;

const SHAPES      = ['diamond','circle','hexagon','triangle','star'];
const SHAPE_ICONS = ['◆','●','⬡','▲','★'];

// ── Shape state ──────────────────────────────────────────────────────────────
const shape = {
  x: null, y: null,       // smoothed render position
  tx: null, ty: null,     // target position
  scale: 1, tScale: 1,   // smoothed / target scale
  rot: 0,   tRot: 0,     // smoothed / target rotation
  baseR: 80,             // base radius px (set on resize)
};

// ── Hand ghost state ─────────────────────────────────────────────────────────
let lastLandmarks  = null;   // raw normalised landmarks from MediaPipe
let handDetected   = false;  // true only during the current frame callback
let ghostFadeCount = 0;      // frames since hand last seen

// ── Trails ───────────────────────────────────────────────────────────────────
const trails    = [];
const MAX_TRAIL = 28;

// ── FPS ──────────────────────────────────────────────────────────────────────
let fps = 0, frameCount = 0, fpsAcc = 0;

// ── Canvas ───────────────────────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');

// ── Resize ───────────────────────────────────────────────────────────────────
function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  shape.baseR   = Math.min(canvas.width, canvas.height) * 0.13;
  if (shape.x == null) {
    shape.x  = shape.tx = canvas.width  / 2;
    shape.y  = shape.ty = canvas.height / 2;
  }
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ── UI helpers ───────────────────────────────────────────────────────────────
function setMode(m) {
  mode = m;
  document.getElementById('btn-direct').classList.toggle('active', m === 'direct');
  document.getElementById('btn-mirror').classList.toggle('active', m === 'mirror');
  document.getElementById('btn-mflip' ).classList.toggle('active', m === 'mirror-flip');
}

function switchCamera(facing) {
  facingMode = facing;
  document.getElementById('btn-front').classList.toggle('active', facing === 'user');
  document.getElementById('btn-back' ).classList.toggle('active', facing === 'environment');
  startCamera();
}

function toggleFeed() {
  showFeed = !showFeed;
  document.getElementById('btn-feed').textContent = showFeed ? 'FEED:ON' : 'FEED:OFF';
  document.getElementById('btn-feed').classList.toggle('active', showFeed);
  document.body.classList.toggle('show-video', showFeed);
}

function cycleShape() {
  shapeIndex = (shapeIndex + 1) % SHAPES.length;
  document.getElementById('btn-shape').textContent = 'SHAPE:' + SHAPE_ICONS[shapeIndex];
  flashText(SHAPES[shapeIndex].toUpperCase());
}

let flashTimer = null;
function flashText(text) {
  const el = document.getElementById('gesture-flash');
  el.textContent  = text;
  el.style.opacity = '1';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.style.opacity = '0'; }, 950);
}

function setStatus(id, html) {
  document.getElementById(id).innerHTML = html;
}

// ── Coordinate mapping ───────────────────────────────────────────────────────
//   Takes normalised [0..1] coords from MediaPipe and maps to canvas pixels
//   according to the current mode.
function mapCoord(nx, ny) {
  const W = canvas.width, H = canvas.height;
  let x = mode === 'direct' ? nx * W : (1 - nx) * W;
  let y = mode === 'mirror-flip' ? (1 - ny) * H : ny * H;
  return { x, y };
}

// Map all 21 landmarks through the current mode
function mapAllLandmarks(lm) {
  return lm.map(p => mapCoord(p.x, p.y));
}

// ── Maths ────────────────────────────────────────────────────────────────────
function dist(a, b)       { return Math.hypot(a.x - b.x, a.y - b.y); }
function lerp(a, b, t)    { return a + (b - a) * t; }
function angle(a, b)      { return Math.atan2(b.y - a.y, b.x - a.x); }

// ── V-Spread / Pinch → Scale ─────────────────────────────────────────────────
//
//   We compute the NORMALISED distance between:
//     lm[4]  = thumb tip
//     lm[8]  = index finger tip
//
//   Normalised means the coordinates are already in [0..1] space from MediaPipe
//   so the distance is also in that space (~0 to ~0.65 max physically possible).
//
//   Mapping:
//     PINCH_DIST (≈0.025) → SCALE_MIN (0.20) — nearly touching = tiny shape
//     SPREAD_DIST (≈0.40) → SCALE_MAX (4.00) — full V open     = huge shape
//
//   This is a direct, continuous linear interpolation — no gestures, no events.
//   The shape simply mirrors the opening / closing of your fingers in real time.
//
const PINCH_DIST  = 0.025;   // normalised — fingertips nearly touching
const SPREAD_DIST = 0.40;    // normalised — full thumb+index V spread
const SCALE_MIN   = 0.20;
const SCALE_MAX   = 4.00;

function spreadDistToScale(normDist) {
  const t = Math.max(0, Math.min(1,
    (normDist - PINCH_DIST) / (SPREAD_DIST - PINCH_DIST)
  ));
  return SCALE_MIN + t * (SCALE_MAX - SCALE_MIN);
}

// ── Count extended fingers ────────────────────────────────────────────────────
function countExtended(lm) {
  const pairs = [[8,6],[12,10],[16,14],[20,18]];
  let n = 0;
  for (const [tip, pip] of pairs) {
    if (lm[tip].y < lm[pip].y) n++;
  }
  const thumbOut = (facingMode === 'user') ? lm[4].x < lm[3].x : lm[4].x > lm[3].x;
  if (thumbOut) n++;
  return n;
}

// ── Reset cooldown ────────────────────────────────────────────────────────────
let resetCooldown    = 0;
let prevGestureName  = '';

// ── Core hand processor ───────────────────────────────────────────────────────
function processHand(lm) {
  handDetected  = true;
  lastLandmarks = lm;
  ghostFadeCount = 0;

  // 1. MOVE — index fingertip (lm[8]) drives the shape position
  const tip = mapCoord(lm[8].x, lm[8].y);
  shape.tx = tip.x;
  shape.ty = tip.y;

  // 2. SCALE — normalised distance between thumb tip (lm[4]) and index tip (lm[8])
  //    This is the key calculation: dist() on the RAW normalised coords
  const normDist  = dist(lm[4], lm[8]);   // stays in [0..1] space
  shape.tScale    = spreadDistToScale(normDist);

  // Update the visual spread meter
  const meterPct = Math.max(0, Math.min(100,
    ((normDist - PINCH_DIST) / (SPREAD_DIST - PINCH_DIST)) * 100
  ));
  document.getElementById('pm-bar').style.height = meterPct + '%';

  // 3. ROTATE — wrist (lm[0]) → middle-MCP (lm[9]) vector angle
  shape.tRot = angle(lm[0], lm[9]) + Math.PI / 2;

  // 4. RESET — open palm
  const ext = countExtended(lm);
  if (ext >= 4 && resetCooldown <= 0) {
    shape.tScale = 1;
    shape.tRot   = 0;
    shape.tx     = canvas.width  / 2;
    shape.ty     = canvas.height / 2;
    flashText('RESET');
    resetCooldown = 50;
  }
  if (resetCooldown > 0) resetCooldown--;

  // 5. Gesture label
  let name;
  if (ext >= 4)                       name = 'OPEN PALM';
  else if (normDist < PINCH_DIST * 2.5) name = 'PINCH ↓';
  else if (normDist > SPREAD_DIST * 0.7) name = 'V-SPREAD ↑';
  else                                name = 'TRACKING';

  if (name !== prevGestureName) {
    prevGestureName = name;
    setStatus('s-gesture', `GESTURE: <em class="active">${name}</em>`);
  }

  // 6. Trail from index tip
  trails.push({ x: tip.x, y: tip.y, age: 0 });
  if (trails.length > MAX_TRAIL) trails.shift();
}

// ── Hand skeleton connection pairs ───────────────────────────────────────────
const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17],
];
const TIPS = [4,8,12,16,20];  // landmark indices of all fingertips

// ── Draw hand ghost ───────────────────────────────────────────────────────────
function drawHandGhost(mapped) {
  // Skeleton
  ctx.save();
  ctx.strokeStyle = 'rgba(0,255,255,0.15)';
  ctx.lineWidth   = 1;
  for (const [a, b] of CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo(mapped[a].x, mapped[a].y);
    ctx.lineTo(mapped[b].x, mapped[b].y);
    ctx.stroke();
  }

  // Joint knuckle dots (non-tips)
  for (let i = 0; i < 21; i++) {
    if (TIPS.includes(i)) continue;
    ctx.beginPath();
    ctx.arc(mapped[i].x, mapped[i].y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,255,255,0.3)';
    ctx.fill();
  }

  // Middle / Ring / Pinky fingertips — cyan glow dots
  for (const ti of [12, 16, 20]) {
    const p = mapped[ti];
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5.5, 0, Math.PI * 2);
    ctx.fillStyle   = '#00ffff';
    ctx.shadowColor = '#00ffff';
    ctx.shadowBlur  = 12;
    ctx.fill();
    ctx.restore();
  }

  // THUMB TIP lm[4] — magenta dot (the spread anchor)
  {
    const p = mapped[4];
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
    ctx.fillStyle   = '#ff00ff';
    ctx.shadowColor = '#ff00ff';
    ctx.shadowBlur  = 20;
    ctx.fill();
    ctx.restore();
  }

  // INDEX TIP lm[8] — yellow pointer dot with crosshair
  {
    const p = mapped[8];
    ctx.save();

    // Dot
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.fillStyle   = '#ffee00';
    ctx.shadowColor = '#ffee00';
    ctx.shadowBlur  = 24;
    ctx.fill();

    // Crosshair
    ctx.strokeStyle = 'rgba(255,238,0,0.5)';
    ctx.lineWidth   = 1;
    ctx.shadowBlur  = 0;
    const ch = 22;
    ctx.beginPath();
    ctx.moveTo(p.x - ch, p.y); ctx.lineTo(p.x + ch, p.y);
    ctx.moveTo(p.x, p.y - ch); ctx.lineTo(p.x, p.y + ch);
    ctx.stroke();
    ctx.restore();
  }

  // Dashed line: thumb tip → index tip (spread visualiser)
  // Colour blends magenta→cyan as distance increases
  {
    const normDist  = dist(lastLandmarks[4], lastLandmarks[8]); // normalised
    const t         = Math.max(0, Math.min(1,
      (normDist - PINCH_DIST) / (SPREAD_DIST - PINCH_DIST)
    ));
    const r = Math.round(255 * (1 - t));
    const g = Math.round(255 * t);
    ctx.save();
    ctx.strokeStyle = `rgba(${r},${g},255,0.75)`;
    ctx.lineWidth   = 2;
    ctx.setLineDash([5, 5]);
    ctx.shadowColor = `rgba(${r},${g},255,0.5)`;
    ctx.shadowBlur  = 8;
    ctx.beginPath();
    ctx.moveTo(mapped[4].x, mapped[4].y);
    ctx.lineTo(mapped[8].x, mapped[8].y);
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}

// ── Draw shape ────────────────────────────────────────────────────────────────
function drawShape(x, y, r, rot) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);

  const type = SHAPES[shapeIndex];

  // 3 glow passes
  for (let pass = 0; pass < 3; pass++) {
    ctx.save();
    ctx.shadowColor = '#00ffff';
    ctx.shadowBlur  = 8 + pass * 22;
    ctx.strokeStyle = pass < 2 ? 'rgba(0,255,255,0.35)' : '#00ffff';
    ctx.lineWidth   = pass < 2 ? 1 : 2.5;
    ctx.fillStyle   = pass === 2 ? 'rgba(255,0,255,0.06)' : 'transparent';
    ctx.beginPath();
    buildShapePath(ctx, type, r);
    if (pass === 2) ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // Inner ring
  ctx.save();
  ctx.strokeStyle = 'rgba(255,0,255,0.35)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  buildShapePath(ctx, type, r * 0.8);
  ctx.stroke();
  ctx.restore();

  // Centre dot
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, 3.5, 0, Math.PI * 2);
  ctx.fillStyle   = '#00ffff';
  ctx.shadowColor = '#00ffff';
  ctx.shadowBlur  = 14;
  ctx.fill();
  ctx.restore();

  ctx.restore();
}

function buildShapePath(ctx, type, r) {
  switch (type) {
    case 'circle':
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      break;
    case 'diamond':
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.62, 0);
      ctx.lineTo(0,  r);
      ctx.lineTo(-r * 0.62, 0);
      ctx.closePath();
      break;
    case 'hexagon':
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 - Math.PI / 6;
        ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      break;
    case 'triangle':
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
        ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      break;
    case 'star':
      for (let i = 0; i < 10; i++) {
        const a  = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const ri = i % 2 === 0 ? r : r * 0.42;
        ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * ri, Math.sin(a) * ri);
      }
      ctx.closePath();
      break;
  }
}

// ── Draw trails ───────────────────────────────────────────────────────────────
function drawTrails() {
  for (let i = trails.length - 1; i >= 0; i--) {
    const t    = trails[i];
    const life = 1 - t.age / MAX_TRAIL;
    ctx.save();
    ctx.beginPath();
    ctx.arc(t.x, t.y, 3.5 * life, 0, Math.PI * 2);
    ctx.fillStyle   = `rgba(0,255,255,${life * 0.4})`;
    ctx.shadowColor = 'rgba(0,255,255,0.3)';
    ctx.shadowBlur  = 5;
    ctx.fill();
    ctx.restore();
    t.age++;
  }
}

// ── Draw HUD grid ─────────────────────────────────────────────────────────────
function drawGrid() {
  ctx.save();
  ctx.strokeStyle = 'rgba(0,255,255,0.022)';
  ctx.lineWidth   = 1;
  const step = 70;
  for (let x = 0; x < canvas.width;  x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }
  ctx.restore();
}

// ── No-hand prompt ────────────────────────────────────────────────────────────
function drawNoHandPrompt() {
  ctx.save();
  ctx.font        = '11px "Share Tech Mono"';
  ctx.fillStyle   = 'rgba(255,102,0,0.38)';
  ctx.textAlign   = 'center';
  const yBelow    = shape.y + shape.baseR * Math.max(1, shape.scale) * 1.7 + 20;
  const yClamped  = Math.min(yBelow, canvas.height - 110);
  ctx.fillText('[ SHOW HAND TO CAMERA ]', canvas.width / 2, yClamped);
  ctx.restore();
}

// ── Mode label ────────────────────────────────────────────────────────────────
const MODE_COLORS = { direct:'#39ff14', mirror:'#00ffff', 'mirror-flip':'#ff00ff' };
const MODE_LABELS = { direct:'DIRECT',  mirror:'MIRROR',  'mirror-flip':'MIR+FLIP'};
function drawModeLabel() {
  ctx.save();
  ctx.font        = '10px "Share Tech Mono"';
  ctx.fillStyle   = (MODE_COLORS[mode] || '#fff') + 'aa';
  ctx.textAlign   = 'right';
  ctx.fillText('MODE: ' + (MODE_LABELS[mode] || mode), canvas.width - 18, canvas.height - 130);
  ctx.restore();
}

// ── Render loop ───────────────────────────────────────────────────────────────
const EASE = 0.11;
let lastTime = 0;

function render(now) {
  requestAnimationFrame(render);

  const dt = now - lastTime;
  lastTime = now;

  // FPS
  frameCount++;
  fpsAcc += dt;
  if (fpsAcc > 500) {
    fps        = Math.round(frameCount * 1000 / fpsAcc);
    frameCount = 0;
    fpsAcc     = 0;
    setStatus('s-fps', `FPS: <em class="${fps > 24 ? 'active' : 'warn'}">${fps}</em>`);
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid();

  // Smooth shape towards targets
  shape.x     = lerp(shape.x  ?? canvas.width  / 2, shape.tx ?? canvas.width  / 2, EASE);
  shape.y     = lerp(shape.y  ?? canvas.height / 2, shape.ty ?? canvas.height / 2, EASE);
  shape.scale = lerp(shape.scale, shape.tScale, EASE);
  shape.rot   = lerp(shape.rot,   shape.tRot,   EASE * 1.5);

  drawTrails();

  // SHAPE — always renders regardless of hand
  drawShape(shape.x, shape.y, shape.baseR * shape.scale, shape.rot);

  // Hand ghost — draw if landmarks available
  if (lastLandmarks) {
    const mapped = mapAllLandmarks(lastLandmarks);
    drawHandGhost(mapped);
  }

  // No-hand prompt
  if (!handDetected) {
    drawNoHandPrompt();
    trails.forEach(t => t.age++);
    // Fade ghost out after ~40 frames with no hand
    ghostFadeCount++;
    if (ghostFadeCount > 40) {
      lastLandmarks  = null;
      ghostFadeCount = 0;
    }
  }

  drawModeLabel();

  // Reset per-frame detection flag
  handDetected = false;
}

requestAnimationFrame(render);

// ── MediaPipe Hands ───────────────────────────────────────────────────────────
let mpCamera = null;

const hands = new Hands({
  locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
});

hands.setOptions({
  maxNumHands:            1,
  modelComplexity:        1,
  minDetectionConfidence: 0.65,
  minTrackingConfidence:  0.55,
});

hands.onResults(results => {
  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    processHand(results.multiHandLandmarks[0]);
    setStatus('s-tracking', 'TRACKING: <em class="active">ACTIVE</em>');
  } else {
    setStatus('s-tracking', 'TRACKING: <em class="warn">SEARCHING...</em>');
    setStatus('s-gesture',  'GESTURE: <em>—</em>');
    prevGestureName = '';
  }
});

// ── Camera ────────────────────────────────────────────────────────────────────
async function startCamera() {
  if (mpCamera) { mpCamera.stop(); mpCamera = null; }
  const vid = document.getElementById('video-bg');
  if (vid.srcObject) vid.srcObject.getTracks().forEach(t => t.stop());

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 640 }, height: { ideal: 480 } }
    });
    vid.srcObject  = stream;
    vid.style.transform = facingMode === 'user' ? 'scaleX(-1)' : 'none';

    mpCamera = new Camera(vid, {
      onFrame: async () => { await hands.send({ image: vid }); },
      width: 640, height: 480,
    });
    mpCamera.start();
    document.getElementById('loading').style.display = 'none';
    setStatus('s-tracking', 'TRACKING: <em class="warn">SEARCHING...</em>');
  } catch (err) {
    document.getElementById('load-status').textContent = 'CAMERA ERROR: ' + err.message;
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
hands.initialize()
  .then(() => {
    document.getElementById('load-status').textContent      = 'READY — TAP TO START';
    document.getElementById('start-btn').style.display      = 'block';
    document.getElementById('permission-msg').style.display = 'block';
  })
  .catch(err => {
    document.getElementById('load-status').textContent = 'INIT ERROR: ' + err.message;
  });

document.getElementById('start-btn').addEventListener('click', startCamera);
