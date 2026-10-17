/**
 * app.js — 把「摄像头 -> 手部关键点 -> 手势 -> 粒子」串起来。
 *
 * 一条链路：
 *   getUserMedia 前置摄像头
 *     -> MediaPipe HandLandmarker（本地 wasm + 本地模型，不依赖 CDN）
 *       -> gesture.js 归一化坐标 -> 屏幕像素 + 张开度
 *         -> particles.js 粒子场（吸引子 = 手）
 *           -> canvas 2D 绘制
 *
 * URL 参数（方便调试 / 演示）：
 *   ?demo=1          演示模式：合成手，不需要摄像头
 *   &pose=0.9        固定手势张开度 0..1（配合 demo 使用）
 *   &ff=2.5          先快进 2.5 秒物理再定格（做截图 / 录屏用）
 *   &mode=galaxy     沙尘 sand / 星系 galaxy / 水滴 water / 萤火 firefly
 *   &q=low|balanced|high
 *   &skel=1          显示手部骨架
 *   &selftest=1      只加载识别模型并输出结果（集成自检）
 */

import { HAND_CONNECTIONS, HandTrack, clamp, lerp } from "./src/gesture.js";
import { MODES, ParticleField } from "./src/particles.js";
import { demoHands, makeHand } from "./src/synthetic.js";

const $ = (s) => document.querySelector(s);
const P = new URLSearchParams(location.search);
const numParam = (k, d) => {
  const v = parseFloat(P.get(k));
  return Number.isFinite(v) ? v : d;
};
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem("gp." + k);
      return v === null ? d : v;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem("gp." + k, String(v));
    } catch {
      /* 隐私模式下忽略 */
    }
  },
};
const rnd = (a = 1) => Math.random() * a;

/** 各模式的画面观感（与物理无关，放在这里让粒子引擎保持纯净） */
const LOOK = {
  sand: {
    accent: "#ffd07a",
    count: 1,
    filter: "brightness(0.8) saturate(1.08)",
    wash: "linear-gradient(180deg, rgba(60,37,12,0.5), rgba(20,14,8,0.15))",
  },
  galaxy: {
    accent: "#9fc6ff",
    count: 1.15,
    filter: "brightness(0.4) saturate(0.92) contrast(1.14)",
    wash: "radial-gradient(70% 55% at 50% 45%, rgba(40,26,90,0.55), rgba(4,6,16,0.75))",
  },
  water: {
    accent: "#8fe3ff",
    count: 0.85,
    filter: "brightness(0.62) saturate(1.14)",
    wash: "linear-gradient(180deg, rgba(8,32,54,0.55), rgba(6,18,32,0.35))",
  },
  firefly: {
    accent: "#c8f58a",
    count: 0.9,
    filter: "brightness(0.46) saturate(1.05)",
    wash: "radial-gradient(75% 60% at 50% 55%, rgba(14,40,24,0.5), rgba(4,8,10,0.72))",
  },
};
const SPRITE = {
  grain: { base: 34, px: 5 },
  glow: { base: 72, px: 11 },
  droplet: { base: 56, px: 5.5 },
};
const QUALITY = {
  low: { dprMax: 1.25, detectHz: 18, particles: 850, camW: 640 },
  balanced: { dprMax: 1.75, detectHz: 24, particles: 1900, camW: 960 },
  high: { dprMax: 2, detectHz: 30, particles: 2800, camW: 1280 },
};
const MODEL_URL = "./vendor/models/hand_landmarker.task";
const WASM_DIR = "./vendor/wasm";
/** 模型跑通之后让 Service Worker 把这些存下来，下次打开就不用重下 17MB */
const PRECACHE = [
  "./",
  "./index.html",
  "./app.js",
  "./src/gesture.js",
  "./src/particles.js",
  "./src/synthetic.js",
  "./vendor/vision_bundle.js",
  "./vendor/wasm/vision_wasm_internal.js",
  "./vendor/wasm/vision_wasm_internal.wasm",
  "./vendor/models/hand_landmarker.task",
];

// ---------------------------------------------------------------- 状态
const cfg = {
  mode: P.get("mode") && MODES[P.get("mode")] ? P.get("mode") : store.get("mode", "sand"),
  quality: QUALITY[P.get("q")] ? P.get("q") : store.get("quality", "balanced"),
  gain: P.has("gain") ? numParam("gain", 1) : parseFloat(store.get("gain", "1")) || 1,
  density: parseFloat(store.get("density", "1")) || 1,
  dim: P.has("dim") ? numParam("dim", 0.5) : parseFloat(store.get("dim", "0.5")) || 0.5,
  skeleton: P.get("skel") === "1" || store.get("skel", "0") === "1",
  mirror: store.get("mirror", "1") === "1",
  facing: store.get("facing", "user"),
  demo: P.get("demo") === "1",
  pose: P.has("pose") ? clamp(numParam("pose", 0.5)) : null,
  ff: Math.max(0, numParam("ff", 0)),
};
if (cfg.demo || cfg.pose !== null) cfg.skeleton = cfg.skeleton || !P.has("skel");

const video = $("#cam");
const cvs = $("#fx");
const ctx = cvs.getContext("2d", { alpha: true, desynchronized: true });
const field = new ParticleField(1200);

let dpr = 1;
let W = innerWidth;
let H = innerHeight;
let time = 0;
let running = false;
let frozen = false;
let mode = MODES[cfg.mode];
let look = LOOK[cfg.mode];
let sprites = [];
let spriteScale = 5;
let raf = 0;
let lastTs = 0;
let fps = 60;
let detectMs = 0;
let detectBackend = "-";
let landmarker = null;
let tracking = false;
let camInfo = "";
let modelState = "未加载";
let playPending = false; // iOS 上视频可能要先等一次用户手势才能播
const tracks = [new HandTrack(), new HandTrack()];
const ATT = [0, 1, 2].map(() => ({
  x: 0,
  y: 0,
  scale: 60,
  openness: 0,
  openVel: 0,
  velX: 0,
  velY: 0,
  spin: 0,
  strength: 0,
  radius: 0,
  anchors: [],
}));
const pulses = [];
let view = { vw: 640, vh: 480, scale: 1, ox: 0, oy: 0 };

/** 目标粒子数：随屏幕面积温和变化（大屏多一点，但不是线性），并可被自动降级压低 */
let autoScale = 1;
let lastSig = -1; // 吸引子集合的特征值（几只 + 有没有桥）
let assignEpoch = 0; // 每变一次 +1，触发粒子整体重新归属
const clampCount = () => {
  const areaK = clamp(Math.sqrt(Math.max(1, W * H) / 330000), 0.75, 1.4);
  return Math.round(QUALITY[cfg.quality].particles * areaK * cfg.density * autoScale * look.count);
};

// ---------------------------------------------------------------- 精灵图（预渲染，比每帧画渐变快得多）
const hex2rgb = (h) => {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

function sprite(kind, color, size) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const rgb = hex2rgb(color);
  const h = size / 2;
  if (kind === "grain") {
    const grd = g.createRadialGradient(h, h, 0, h, h, h);
    grd.addColorStop(0, rgba(rgb, 1));
    grd.addColorStop(0.4, rgba(rgb, 0.88));
    grd.addColorStop(0.72, rgba(rgb, 0.26));
    grd.addColorStop(1, rgba(rgb, 0));
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
  } else if (kind === "glow") {
    const grd = g.createRadialGradient(h, h, 0, h, h, h);
    grd.addColorStop(0, rgba(rgb, 1));
    grd.addColorStop(0.07, rgba(rgb, 0.92));
    grd.addColorStop(0.18, rgba(rgb, 0.34));
    grd.addColorStop(0.36, rgba(rgb, 0.09));
    grd.addColorStop(0.62, rgba(rgb, 0.022));
    grd.addColorStop(1, rgba(rgb, 0));
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
  } else {
    // 水滴：柔光晕 + 高光球体 + 一点镜面反射
    const halo = g.createRadialGradient(h, h, 0, h, h, h);
    halo.addColorStop(0, rgba(rgb, 0.5));
    halo.addColorStop(0.5, rgba(rgb, 0.16));
    halo.addColorStop(1, rgba(rgb, 0));
    g.fillStyle = halo;
    g.fillRect(0, 0, size, size);
    const cx = size * 0.44;
    const cy = size * 0.42;
    const r = size * 0.34;
    const body = g.createRadialGradient(cx - r * 0.3, cy - r * 0.34, r * 0.08, cx, cy, r);
    body.addColorStop(0, "rgba(255,255,255,0.95)");
    body.addColorStop(0.3, rgba(rgb, 0.92));
    body.addColorStop(0.72, rgba(rgb, 0.6));
    body.addColorStop(1, rgba(rgb, 0));
    g.fillStyle = body;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    const spec = g.createRadialGradient(cx - r * 0.34, cy - r * 0.4, 0, cx - r * 0.34, cy - r * 0.4, r * 0.42);
    spec.addColorStop(0, "rgba(255,255,255,0.85)");
    spec.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = spec;
    g.beginPath();
    g.arc(cx - r * 0.34, cy - r * 0.4, r * 0.42, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

function buildSprites() {
  const s = SPRITE[mode.sprite];
  spriteScale = s.px;
  sprites = mode.colors.map((c) => sprite(mode.sprite, c, s.base));
}

// ---------------------------------------------------------------- 画面 / 坐标映射
function updateView() {
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const scale = Math.max(W / vw, H / vh);
  view = { vw, vh, scale, ox: (W - vw * scale) / 2, oy: (H - vh * scale) / 2 };
}

/** 归一化视频坐标 -> 屏幕 CSS 像素（考虑 object-fit: cover 与镜像） */
const toScreen = (n) => ({
  x: view.ox + (cfg.mirror ? 1 - n.x : n.x) * view.vw * view.scale,
  y: view.oy + n.y * view.vh * view.scale,
});

function resize() {
  W = Math.max(1, innerWidth);
  H = Math.max(1, innerHeight);
  dpr = Math.min(QUALITY[cfg.quality].dprMax, window.devicePixelRatio || 1);
  cvs.width = Math.round(W * dpr);
  cvs.height = Math.round(H * dpr);
  field.resize(W, H);
  field.setCount(clampCount(), W, H);
  updateView();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  // 定格模式（快进/截图）下没有 rAF，改完尺寸要立刻补画一帧，否则画面是空的
  if (frozen) drawFx(1 / 60);
}

// ---------------------------------------------------------------- 手势 -> 吸引子
function matchTracks(hands) {
  const assign = new Array(hands.length).fill(-1);
  const used = [false, false];
  const palms = hands.map((h) => {
    let x = 0;
    let y = 0;
    for (const i of [0, 5, 9, 13, 17]) {
      x += h[i].x;
      y += h[i].y;
    }
    return { x: x / 5, y: y / 5 };
  });
  // 先让"上一帧还在"的轨道认领最近的手，保持同一只手不会被换到另一个槽位
  for (let ti = 0; ti < 2; ti++) {
    if (!tracks[ti].landmarks) continue;
    let best = -1;
    let bd = Infinity;
    for (let j = 0; j < palms.length; j++) {
      if (assign[j] >= 0) continue;
      const d = Math.hypot(palms[j].x - tracks[ti].palm.x, palms[j].y - tracks[ti].palm.y);
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    if (best >= 0 && bd < Math.min(W, H) * 0.45) {
      assign[best] = ti;
      used[ti] = true;
    }
  }
  for (let j = 0; j < hands.length; j++) {
    if (assign[j] >= 0) continue;
    const free = used[0] ? (used[1] ? -1 : 1) : 0;
    if (free < 0) break;
    used[free] = true;
    assign[j] = free;
  }
  return assign;
}

function updateTracks(dt, hands) {
  const assign = matchTracks(hands);
  const seen = [false, false];
  for (let j = 0; j < hands.length; j++) {
    const ti = assign[j];
    if (ti < 0) continue;
    tracks[ti].feed(hands[j], dt, { gain: cfg.gain });
    seen[ti] = true;
  }
  for (let i = 0; i < 2; i++) if (!seen[i]) tracks[i].coast(dt);
}

function buildAttractors(dt) {
  let live = 0;
  for (let i = 0; i < 2; i++) {
    const tr = tracks[i];
    const a = ATT[i];
    const s = tr.strength;
    if (!tr.landmarks || s <= 0.02) {
      a.strength = 0;
      a.radius = 0;
      continue;
    }
    a.x = tr.palm.x;
    a.y = tr.palm.y;
    a.scale = tr.scale;
    a.openness = tr.openness;
    a.openVel = tr.openVel;
    a.velX = tr.vel.x;
    a.velY = tr.vel.y;
    a.strength = s;
    a.radius = 1e6;
    a.anchors = tr.landmarks;
    tr.spin = (tr.spin || 0) + dt * mode.spinRate * (0.4 + (1 - tr.openness) * 0.9);
    a.spin = tr.spin;
    live++;
    // 快速张开 / 握拳时打一圈冲击波
    const now = time;
    if (Math.abs(tr.openVel) > 2.4 && now - (tr.lastPulse || -9) > 0.42) {
      tr.lastPulse = now;
      const burst = tr.openVel > 0;
      pulses.push({
        x: tr.palm.x,
        y: tr.palm.y,
        r: burst ? tr.scale * 0.6 : tr.scale * 3.4,
        r1: burst ? tr.scale * 3.2 : tr.scale * 0.5,
        life: 0.52,
        max: 0.52,
        w: burst ? 2.2 : 1.6,
      });
    }
  }

  // 双手之间的"桥"：两只手都张开时才出现，把粒子拉成一条带子
  const b = ATT[2];
  let bridgeOn = false;
  if (live === 2) {
    const o = Math.min(tracks[0].openness, tracks[1].openness);
    const k = clamp((o - 0.35) / 0.35);
    const p1 = tracks[0].palm;
    const p2 = tracks[1].palm;
    const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (k > 0.02 && d > Math.min(W, H) * 0.12) {
      b.x = (p1.x + p2.x) / 2;
      b.y = (p1.y + p2.y) / 2;
      // 比手更"收"一些：粒子贴着两掌之间的连线排成一条带子，才看得出是"桥"
      b.scale = Math.min(tracks[0].scale, tracks[1].scale) * 0.55;
      b.openness = 0.35;
      b.openVel = 0;
      b.velX = 0;
      b.velY = 0;
      b.strength = k;
      b.radius = Math.min(Math.max(60, d * 0.9), Math.min(W, H) * 0.35);
      b.spin = (b.spin || 0) + dt * mode.spinRate * 0.3;
      // 锚点沿两手连线排布，并微微下垂一点，看起来像一条挂着的带子而不是直杆
      const nx = -(p2.y - p1.y) / (d || 1);
      const ny = (p2.x - p1.x) / (d || 1);
      const sag = d * 0.07;
      for (let i = 0; i < 7; i++) {
        const t = i / 6;
        const pt = b.anchors[i] || (b.anchors[i] = { x: 0, y: 0 });
        const s = Math.sin(Math.PI * t) * sag;
        pt.x = p1.x + (p2.x - p1.x) * t + nx * s;
        pt.y = p1.y + (p2.y - p1.y) * t + ny * s;
      }
      b.anchors.length = 7;
      bridgeOn = true;
    } else {
      b.strength = 0;
    }
  } else {
    b.strength = 0;
  }
  // 吸引子集合发生变化 -> 换一个版本号，让粒子场整体重新分配一次归属
  const sig = live * 10 + (bridgeOn ? 1 : 0);
  if (sig !== lastSig) {
    lastSig = sig;
    assignEpoch++;
  }
  return live;
}

// ---------------------------------------------------------------- 绘制
function drawFx(dt) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const fade = 1 - Math.exp(-dt / mode.fadeTau);
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = `rgba(0,0,0,${fade.toFixed(4)})`;
  ctx.fillRect(0, 0, W, H);

  ctx.globalCompositeOperation = mode.blend;
  const ps = field.ps;
  const nTone = sprites.length;
  const tw = mode.twinkle > 0;
  const twoPi = Math.PI * 2;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p.x < -60 || p.y < -60 || p.x > W + 60 || p.y > H + 60) continue;
    const img = sprites[Math.min(nTone - 1, (p.ci * nTone) | 0)];
    let a = p.alpha;
    if (tw) a *= 0.58 + 0.42 * Math.sin(time * p.twS * 2.3 + p.phase);
    // 加法混合下，粒子挤成一团会直接爆成白色：用手掌张开度做一次密度补偿
    if (mode.packAlpha && p.att >= 0) a *= 0.45 + 0.55 * ATT[p.att].openness;
    const v = Math.abs(p.vx) + Math.abs(p.vy);
    if (v > 60) a *= 1 + Math.min(1, v / 1200) * 0.9;
    const s = p.size * spriteScale;
    ctx.globalAlpha = a > 1 ? 1 : a < 0.02 ? 0.02 : a;
    ctx.drawImage(img, p.x - s * 0.5, p.y - s * 0.5, s, s);
  }

  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  for (let i = pulses.length - 1; i >= 0; i--) {
    const q = pulses[i];
    q.life -= dt;
    if (q.life <= 0) {
      pulses.splice(i, 1);
      continue;
    }
    const k = 1 - q.life / q.max;
    const r = lerp(q.r, q.r1, k * (2 - k));
    ctx.globalAlpha = 0.34 * (1 - k);
    ctx.strokeStyle = look.accent;
    ctx.lineWidth = q.w * (1 - k * 0.6);
    ctx.beginPath();
    ctx.arc(q.x, q.y, Math.max(1, r), 0, twoPi);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (cfg.skeleton) drawSkeleton();
}

function drawSkeleton() {
  for (let i = 0; i < 2; i++) {
    const tr = tracks[i];
    if (!tr.landmarks) continue;
    const L = tr.landmarks;
    const s = clamp(tr.strength);
    ctx.strokeStyle = "rgba(255,255,255,1)";
    ctx.lineCap = "round";
    ctx.lineWidth = 1.7;
    ctx.globalAlpha = 0.32 * s;
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(L[a].x, L[a].y);
      ctx.lineTo(L[b].x, L[b].y);
    }
    ctx.stroke();
    ctx.globalAlpha = 0.3 * s;
    ctx.fillStyle = "#fff";
    for (let k = 0; k < 21; k++) {
      ctx.beginPath();
      ctx.arc(L[k].x, L[k].y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 0.55 * s;
    ctx.fillStyle = look.accent;
    for (const tip of [4, 8, 12, 16, 20]) {
      ctx.beginPath();
      ctx.arc(L[tip].x, L[tip].y, 3.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- 检测
// MediaPipe 在 VIDEO 模式下要求时间戳严格递增，同一毫秒内连调两次会直接报
// INVALID_ARGUMENT，所以统一用它发号。
let stampMs = 0;
const nextStamp = () => {
  const t = performance.now();
  stampMs = t > stampMs ? t : stampMs + 1;
  return stampMs;
};

function handsFromVideo() {
  if (!landmarker || video.readyState < 2) return null;
  const t0 = performance.now();
  let res;
  try {
    res = landmarker.detectForVideo(video, nextStamp());
  } catch (err) {
    detectBackend += "!";
    return null;
  }
  detectMs = lerp(detectMs, performance.now() - t0, 0.25);
  const list = res && res.landmarks ? res.landmarks : [];
  return list.map((hand) => hand.map(toScreen));
}

let lastDetect = 0;
let lastVideoTime = -1;
let detDt = 1 / 24;

function detectIfDue(now) {
  if (!tracking || cfg.demo || cfg.pose !== null) return false;
  if (!landmarker || video.readyState < 2) return false;
  if (now - lastDetect < 1000 / QUALITY[cfg.quality].detectHz) return false;
  if (video.currentTime === lastVideoTime) return false;
  lastVideoTime = video.currentTime;
  detDt = clamp((now - lastDetect) / 1000, 0.001, 0.25);
  lastDetect = now;
  const hands = handsFromVideo();
  if (hands) updateTracks(detDt, hands);
  return true;
}

// ---------------------------------------------------------------- 主循环
let acc = 0;
let nAcc = 0;
let downgrades = 0;

function frame(now) {
  raf = requestAnimationFrame(frame);
  if (!lastTs) lastTs = now;
  let dt = (now - lastTs) / 1000;
  lastTs = now;
  if (dt > 0.05) dt = 0.05;
  if (dt <= 0) dt = 1 / 60;

  acc += dt;
  nAcc++;
  fps = lerp(fps, 1 / dt, 0.08);

  if (!frozen) {
    detectIfDue(now);
    if (cfg.demo || cfg.pose !== null) {
      time += dt;
      updateTracks(dt, demoSource());
    } else {
      time += dt;
    }
    buildAttractors(dt);
    field.update(dt, { t: time, w: W, h: H, attractors: ATT, epoch: assignEpoch });
    drawFx(dt);
    // 自动降级：连续三秒跟不上就减粒子，保证手机上不卡
    if (nAcc >= 90 && acc / nAcc > 0.026 && downgrades < 3) {
      downgrades++;
      autoScale *= 0.72;
      field.setCount(clampCount(), W, H);
    }
    if (nAcc >= 90) {
      acc = 0;
      nAcc = 0;
    }
    updateHud();
  } else {
    drawFx(1 / 60);
  }
}

const poseHand = () => [
  makeHand({
    x: W * 0.5,
    y: H * 0.52,
    size: Math.min(W, H) * 0.145,
    rot: -0.06,
    curl: 1 - cfg.pose,
    splay: 0.5 * cfg.pose,
  }),
];
const demoSource = () => (cfg.pose !== null ? poseHand() : demoHands(time, W, H));

// ---------------------------------------------------------------- HUD
const elStatus = $("#status");
const elHint = $("#hint");
const elMeters = [...document.querySelectorAll("#meters .meter > i")];
let hudTick = 0;

function updateHud() {
  if (hudTick++ % 6) return;
  let hands = 0;
  let txt = `${fps.toFixed(0)} fps · ${field.ps.length} 粒`;
  if (cfg.demo || cfg.pose !== null) txt += ` · 演示`;
  else if (!tracking) txt = `等待摄像头 · ${field.ps.length} 粒`;
  else if (!landmarker) txt += ` · ${modelState}`;
  else txt += ` · ${detectMs.toFixed(0)}ms ${detectBackend}`;
  for (let i = 0; i < 2; i++) {
    const tr = tracks[i];
    if (tr.landmarks) hands++;
    elMeters[i].style.width = `${Math.round(clamp(tr.openness) * 100)}%`;
    elMeters[i].style.opacity = tr.landmarks ? "1" : "0.25";
  }
  elStatus.querySelector("div").innerHTML =
    `<b>${MODES[cfg.mode].label}</b> · ${hands ? `${hands} 只手` : "未检测到手"}<br />${txt}`;
  $("#diag").textContent = diagText();
}

function diagText() {
  const lines = [
    `画面 ${W}×${H} CSS / DPR ${dpr.toFixed(2)}`,
    camInfo ? `摄像头 ${camInfo}` : "摄像头 未启动",
    `识别 ${landmarker ? `${detectMs.toFixed(0)} ms · ${detectBackend}` : modelState}`,
    `粒子 ${field.ps.length} · 灵敏度 ${cfg.gain.toFixed(2)}`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------- 启动
async function warmWasm(onProgress) {
  try {
    const res = await fetch(`${WASM_DIR}/vision_wasm_internal.wasm`);
    if (!res.ok || !res.body) return;
    const total = parseInt(res.headers.get("content-length") || "0", 10) || 9400000;
    const reader = res.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      onProgress(Math.min(1, got / total));
    }
  } catch {
    /* 取不到也没关系，MediaPipe 会自己再请求一次 */
  }
}

async function loadModel(skipWarm = false) {
  modelState = "加载识别库…";
  const { FilesetResolver, HandLandmarker } = await import("./vendor/vision_bundle.js");
  if (!skipWarm) {
    await warmWasm((p) => {
      modelState = `下载模型 ${Math.round(p * 100)}%`;
      setProgress(p * 0.9);
    });
  }
  modelState = "初始化识别…";
  const fileset = await FilesetResolver.forVisionTasks(WASM_DIR);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    landmarker = await HandLandmarker.createFromOptions(fileset, opts("GPU"));
    detectBackend = "GPU";
  } catch (err) {
    console.warn("GPU 后端不可用，回退 CPU：", err);
    landmarker = await HandLandmarker.createFromOptions(fileset, opts("CPU"));
    detectBackend = "CPU";
  }
  modelState = detectBackend;
  // 预热一次：真机首帧推理通常要一两百毫秒，先跑掉，避免刚进画面时卡一下
  try {
    const warm = document.createElement("canvas");
    warm.width = 256;
    warm.height = 256;
    warm.getContext("2d").fillRect(0, 0, 256, 256);
    landmarker.detectForVideo(warm, nextStamp());
  } catch {
    /* 预热失败无所谓 */
  }
  setProgress(1);
  precache();
}

/** 让 Service Worker 把大文件存到本地（没有 SW 就什么都不做） */
function precache() {
  const ctl = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!ctl) return;
  try {
    ctl.postMessage({ type: "precache", urls: PRECACHE });
  } catch {
    /* 忽略 */
  }
}

function setProgress(p) {
  const el = $("#prog");
  el.classList.add("on");
  el.querySelector("i").style.width = `${Math.round(clamp(p) * 100)}%`;
}

function fail(msg) {
  $("#err").textContent = msg;
  $("#prog").classList.remove("on");
}

async function startCamera() {
  $("#btnStart").disabled = true;
  $("#err").textContent = "";
  const q = QUALITY[cfg.quality];
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    fail(
      "这个页面拿不到摄像头权限。\n\n手机浏览器只允许在 HTTPS 页面（或 localhost）里访问摄像头。\n" +
        "请用 https 打开，或先用「演示模式」看效果。"
    );
    $("#btnStart").disabled = false;
    return;
  }
  try {
    setProgress(0.02);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: cfg.facing,
        width: { ideal: q.camW },
        height: { ideal: Math.round(q.camW * 0.75) },
        frameRate: { ideal: 30 },
      },
    });
    video.srcObject = stream;
    // iOS 上如果 play() 因为"不是用户手势"失败，会在下一次点按时重试（见下面的 pointerdown）
    playPending = true;
    await video
      .play()
      .then(() => {
        playPending = false;
      })
      .catch(() => {});
    await new Promise((res) => {
      if (video.videoWidth) return res();
      video.onloadedmetadata = res;
      setTimeout(res, 1500);
    });
    const st = stream.getVideoTracks()[0];
    const s = st.getSettings ? st.getSettings() : {};
    camInfo = `${s.width || video.videoWidth}×${s.height || video.videoHeight}${s.facingMode ? " · " + s.facingMode : ""}`;
    updateView();
    resize();
    tracking = true;
    $("#gate").classList.add("hide");
    setProgress(0);
    setTimeout(() => $("#prog").classList.remove("on"), 400);
    if (cfg.ff <= 0) {
      if (!raf) {
        lastTs = 0;
        raf = requestAnimationFrame(frame);
      }
    }
  } catch (err) {
    const name = err && err.name;
    let msg = `摄像头启动失败：${name || err}\n\n`;
    if (name === "NotAllowedError") msg += "权限被拒绝了。请在浏览器地址栏的设置里允许摄像头，然后刷新。";
    else if (name === "NotFoundError" || name === "OverconstrainedError")
      msg += "没找到可用的摄像头，试试在设置里切换前置 / 后置。";
    else msg += "如果是在手机上用 http:// 打开，请改用 https:// 或 localhost。";
    fail(msg);
    $("#btnStart").disabled = false;
    return;
  }
  try {
    await loadModel();
  } catch (err) {
    modelState = "模型加载失败";
    console.error(err);
    fail(`识别模型加载失败：${err && err.message}\n请确认 vendor/ 目录完整（用本地服务器打开，不要双击 html 文件）。`);
  }
}

function enterDemo() {
  tracking = false;
  $("#gate").classList.add("hide");
  $("#hint").innerHTML = cfg.pose !== null ? "固定手势演示" : "演示模式<br />合成的手在开合";
  resize();
  if (!raf && cfg.ff <= 0) {
    lastTs = 0;
    raf = requestAnimationFrame(frame);
  }
}

/** 快进物理再定格：截图 / 录屏用，保证画面可复现 */
function fastForward(seconds) {
  const step = 1 / 60;
  const N = Math.round(seconds / step);
  frozen = true;
  try {
    for (let i = 0; i < N; i++) {
      time += step;
      updateTracks(step, demoSource());
      buildAttractors(step);
    field.update(step, { t: time, w: W, h: H, attractors: ATT, epoch: assignEpoch });
      if (i % 2 === 0) drawFx(step * 2);
    }
    drawFx(step);
    updateHud();
  } catch (err) {
    reportError(err, "快进");
  }
}

/** 出错时把信息显示在页面上：手机上不方便开控制台，这行字往往就是唯一的线索 */
function reportError(err, where) {
  const msg = `${where}出错: ${(err && err.message) || err}`;
  const el = $("#err");
  if (el) el.textContent = el.textContent ? `${el.textContent}\n${msg}` : msg;
  $("#gate").classList.remove("hide");
  document.title = "ERR " + msg;
  console.error(err);
}

/** ?probe=1 把关键数值写到页面上（截图就能读数，手机上调参很有用） */
function showProbe() {
  const r = (v) => (typeof v === "number" ? Math.round(v) : v);
  const lines = [
    `W=${W} H=${H} dpr=${dpr.toFixed(2)} inner=${innerWidth}x${innerHeight}`,
    `t=${time.toFixed(2)} particles=${field.ps.length} mode=${cfg.mode}`,
    ...tracks.map(
      (t, i) =>
        `tr${i} palm=(${t.palm.x.toFixed(0)},${t.palm.y.toFixed(0)}) scale=${t.scale.toFixed(0)} open=${t.openness.toFixed(2)} str=${t.strength.toFixed(2)} seen=${t.sinceSeen.toFixed(2)}`
    ),
    ...ATT.map(
      (a, i) =>
        `att${i} str=${a.strength.toFixed(2)} open=${a.openness.toFixed(2)} r=${a.radius.toFixed(0)} n=${a.anchors.length} @(${a.x.toFixed(0)},${a.y.toFixed(0)})`
    ),
    `assigned=[${[0, 1, 2, -1].map((k) => `${k}:${field.ps.filter((p) => p.att === k).length}`).join(" ")}]`,
    `ownerHomeX=[${[0, 1, 2, -1]
      .map((k) => {
        const g = field.ps.filter((p) => p.att === k);
        if (!g.length) return `${k}:-`;
        const mx = g.reduce((s, p) => s + p.homeX, 0) / g.length;
        const right = g.filter((p) => p.homeX > W * 0.5).length;
        return `${k}:avg${mx.toFixed(0)} 右半${right}/${g.length}`;
      })
      .join(" | ")}]`,
    "field=" +
      Object.entries(field.stats())
        .map(([k, v]) => `${k}=${r(v)}`)
        .join(" "),
  ];
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return `${sel}:?`;
    const b = el.getBoundingClientRect();
    return `${sel}=${b.left.toFixed(0)},${b.top.toFixed(0)} ${b.width.toFixed(0)}x${b.height.toFixed(0)}`;
  };
  lines.push(
    `doc=${document.documentElement.scrollWidth}x${document.documentElement.scrollHeight} vv=${innerWidth}x${innerHeight}`
  );
  lines.push(rect("#hud"));
  lines.push(rect("#status"));
  lines.push(rect("#hint"));
  lines.push(rect("#dock") + " " + rect("#chips"));
  $("#selftest").textContent = lines.join("\n");
  // Service Worker / 离线缓存状态（异步补上）
  if ("caches" in self) {
    (async () => {
      try {
        const keys = await caches.keys();
        const parts = [];
        for (const k of keys) {
          const reqs = await (await caches.open(k)).keys();
          const names = reqs.map((r) => r.url.split("/").pop() || "/");
          parts.push(`${k}:${reqs.length}[${names.join(" ")}]`);
        }
        const txt = `sw=${navigator.serviceWorker.controller ? "controlled" : "uncontrolled"} caches=[${parts.join(
          " "
        )}]`;
        $("#selftest").textContent += `\n${txt}`;
        fetch(`/__selftest?r=${encodeURIComponent(txt)}`).catch(() => {});
      } catch {
        /* 忽略 */
      }
    })();
  }
}

// ---------------------------------------------------------------- 设置面板
function applyLook() {
  document.documentElement.style.setProperty("--accent", look.accent);
  video.style.filter = look.filter;
  $("#wash").style.background = look.wash;
  $("#wash").style.opacity = String(cfg.dim / 0.62);
}

function setMode(key) {
  cfg.mode = key;
  store.set("mode", key);
  mode = MODES[key];
  look = LOOK[key];
  buildSprites();
  field.setMode(mode);
  field.setCount(clampCount(), W, H);
  applyLook();
  [...$("#chips").children].forEach((b) => b.classList.toggle("on", b.dataset.v === key));
}

function buildChips() {
  const wrap = $("#chips");
  wrap.innerHTML = "";
  for (const key of Object.keys(MODES)) {
    const b = document.createElement("button");
    b.className = "chip";
    b.dataset.v = key;
    b.textContent = MODES[key].label;
    b.onclick = () => setMode(key);
    wrap.appendChild(b);
  }
}

function bindRange(id, key, fmt = (v) => v.toFixed(2)) {
  const el = $(`#${id}`);
  const out = $(`#${id}V`);
  el.value = String(cfg[key]);
  out.textContent = fmt(cfg[key]);
  el.oninput = () => {
    cfg[key] = parseFloat(el.value);
    out.textContent = fmt(cfg[key]);
    store.set(key, cfg[key]);
    if (key === "dim") applyLook();
    if (key === "density") field.setCount(clampCount(), W, H);
  };
}

function bindSeg(id, key, cb) {
  const wrap = $(`#${id}`);
  const sync = () => [...wrap.children].forEach((b) => b.classList.toggle("on", b.dataset.v === cfg[key]));
  [...wrap.children].forEach((b) => {
    b.onclick = () => {
      cfg[key] = b.dataset.v;
      store.set(key, cfg[key]);
      sync();
      cb && cb(cfg[key]);
    };
  });
  sync();
}

function bindSwitch(id, key, cb) {
  const el = $(`#${id}`);
  const sync = () => el.classList.toggle("on", !!cfg[key]);
  el.onclick = () => {
    cfg[key] = !cfg[key];
    store.set(key, cfg[key] ? "1" : "0");
    sync();
    cb && cb(cfg[key]);
  };
  sync();
}

let idleTimer = 0;
function poke() {
  clearTimeout(idleTimer);
  $("#hud").classList.remove("idle");
  $("#dock").classList.remove("idle");
  idleTimer = setTimeout(() => {
    if ($("#panel").classList.contains("open")) return;
    $("#hud").classList.add("idle");
    $("#dock").classList.add("idle");
  }, 7000);
}

// ---------------------------------------------------------------- selftest
async function selftest() {
  const out = $("#selftest");
  const log = [];
  const t0 = performance.now();
  try {
    await loadModel(true);
    log.push(`model=ok backend=${detectBackend} loadMs=${Math.round(performance.now() - t0)}`);
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 240;
    const g = c.getContext("2d");
    g.fillStyle = "#222";
    g.fillRect(0, 0, 320, 240);
    const r = landmarker.detectForVideo(c, nextStamp());
    log.push(
      `infer=ok hands=${r.landmarks ? r.landmarks.length : "?"} totalMs=${(performance.now() - t0).toFixed(0)}`
    );
    log.push("RESULT=OK");
  } catch (err) {
    log.push(`RESULT=FAIL ${err && err.message}`);
  }
  out.textContent = log.join("\n");
  document.title = log[log.length - 1];
  // 回传给本地服务器（没有控制台时，服务器日志就是结果）
  fetch(`/__selftest?r=${encodeURIComponent(log.join(" | "))}`).catch(() => {});
  if (P.get("probe") === "1") showProbe();
}

// ---------------------------------------------------------------- 引导
async function boot() {
  if (P.get("bare") === "1") document.body.classList.add("bare");
  // ?hide=panel,vignette 临时隐藏某些层，排查渲染问题用
  for (const id of (P.get("hide") || "").split(",").filter(Boolean)) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  }
  // https 下注册 Service Worker：把 17MB 的 wasm/模型缓存到本地，
  // 第二次打开基本秒开，而且之后可以离线使用（GitHub Pages 给的缓存期太短）。
  // http://localhost 不注册，改代码时能立刻看到效果；?sw=1 可以手动打开来测试。
  if ("serviceWorker" in navigator && (location.protocol === "https:" || P.get("sw") === "1")) {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
  }
  buildChips();
  setMode(cfg.mode);
  bindRange("gain", "gain");
  bindRange("density", "density");
  bindRange("dim", "dim");
  bindSeg("quality", "quality", () => {
    resize();
    lastTs = 0;
  });
  bindSeg("facing", "facing", () => {
    // 后置摄像头是"别人的视角"，默认不镜像更符合直觉
    cfg.mirror = cfg.facing !== "environment";
    store.set("mirror", cfg.mirror ? "1" : "0");
    video.classList.toggle("back", !cfg.mirror);
    $("#mirror").classList.toggle("on", cfg.mirror);
    updateView();
    if (tracking) location.reload();
  });
  bindSwitch("skel", "skeleton");
  bindSwitch("mirror", "mirror", (v) => {
    video.classList.toggle("back", !v);
    updateView();
  });
  video.classList.toggle("back", !cfg.mirror);
  $("#btnPanel").onclick = () => {
    $("#panel").classList.toggle("open");
    poke();
  };
  $("#btnStart").onclick = startCamera;
  $("#btnDemo").onclick = () => {
    cfg.demo = true;
    cfg.pose = null;
    cfg.skeleton = true;
    enterDemo();
  };
  document.addEventListener(
    "pointerdown",
    () => {
      poke();
      if (playPending && video.paused) {
        video
          .play()
          .then(() => {
            playPending = false;
          })
          .catch(() => {});
      }
    },
    { passive: true }
  );
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else if (!raf && !frozen) {
      // iOS 回到前台时视频可能被暂停，顺手恢复
      if (tracking && video.paused) video.play().catch(() => {});
      lastTs = 0;
      raf = requestAnimationFrame(frame);
    }
  });
  addEventListener("resize", resize);
  addEventListener("orientationchange", () => setTimeout(resize, 260));
  poke();

  resize();
  buildSprites();
  field.setMode(mode);
  applyLook();

  if (P.get("selftest") === "1") return selftest();
  if (cfg.pose !== null || cfg.demo) {
    enterDemo();
    if (cfg.ff > 0) {
      fastForward(cfg.ff);
      if (P.get("probe") === "1") showProbe();
    }
  }
}

addEventListener("error", (e) => reportError(e.message || e.error, `${(e.filename || "").split("/").pop()}:${e.lineno}`));
addEventListener("unhandledrejection", (e) => reportError((e.reason && e.reason.message) || e.reason, "异步"));

boot().catch((err) => reportError(err, "启动"));
