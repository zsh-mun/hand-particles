/**
 * gesture.js — 从 21 个手部关键点推导「张开程度」等指标。
 *
 * 这里全是纯函数：不依赖 DOM、不依赖摄像头，坐标单位可以是归一化值或像素，
 * 因为所有度量都会除以手掌尺寸（wrist -> middle_MCP 的距离）做归一化。
 *
 * 关键点编号（MediaPipe 约定）：
 *   0 wrist | 1-4 拇指 cmc/mcp/ip/tip | 5-8 食指 | 9-12 中指 | 13-16 无名指 | 17-20 小指
 */

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export const PALM_INDICES = [0, 5, 9, 13, 17];
export const FINGER_TIP = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
export const FINGER_MCP = { thumb: 2, index: 5, middle: 9, ring: 13, pinky: 17 };

/**
 * 每个手指 tip->wrist 距离（除以手掌尺寸）的标定区间 [握拳, 完全伸直]。
 * 数值来自真实人手比例：握拳时指尖几乎贴到掌心（≈0.6-0.7 倍掌长），
 * 完全伸直时中指指尖约为 1.95 倍掌长。小指天然更短，所以区间单独给了。
 * 拇指用 tip->wrist，握拳时拇指搭在手指上，数值偏小。
 */
export const RANGE = {
  thumb: [0.55, 1.05],
  index: [0.7, 1.85],
  middle: [0.7, 1.95],
  ring: [0.72, 1.85],
  pinky: [0.6, 1.6],
};

const THUMB_WEIGHT = 0.5; // 拇指只占半个权重（它不靠蜷曲表达开合，稳定性差一些）

export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** 把 [0,1] 的值绕 0.5 做对比度拉伸，再夹紧。gain=1 原样输出。 */
export const remap = (v, gain = 1) => clamp(0.5 + (clamp(v) - 0.5) * gain);

function ratio(tip, pts, scale) {
  return dist(pts[tip], pts[0]) / scale;
}

/**
 * 分析一帧手部关键点。
 * @param {Array<{x:number,y:number}>} pts 长度 21 的关键点
 * @param {{gain?:number}} [opts]
 * @returns {null | object} 无效输入返回 null
 */
export function analyze(pts, opts = {}) {
  if (!pts || pts.length < 21) return null;
  const wrist = pts[0];
  const scale = dist(wrist, pts[FINGER_MCP.middle]);
  if (!(scale > 1e-6)) return null;

  const gain = opts.gain ?? 1;
  const raw = {};
  for (const name of Object.keys(FINGER_TIP)) {
    const [lo, hi] = RANGE[name];
    raw[name] = ratio(FINGER_TIP[name], pts, scale);
    raw[name + "_o"] = clamp((raw[name] - lo) / (hi - lo));
  }

  let sum = 0;
  for (const name of ["index", "middle", "ring", "pinky"]) sum += raw[name + "_o"];
  const openness = clamp((sum + THUMB_WEIGHT * raw.thumb_o) / (4 + THUMB_WEIGHT));

  // 掌心中心：腕 + 四个掌指关节
  let cx = 0;
  let cy = 0;
  for (const i of PALM_INDICES) {
    cx += pts[i].x;
    cy += pts[i].y;
  }
  cx /= PALM_INDICES.length;
  cy /= PALM_INDICES.length;

  // 指尖离掌心的平均距离：也能表征开合，用来做交叉校验 / 备用
  let spread = 0;
  for (const name of Object.keys(FINGER_TIP)) spread += dist(pts[FINGER_TIP[name]], { x: cx, y: cy });
  spread = spread / 5 / scale;

  // 捏合度：拇指尖与食指尖靠近时 -> 1
  const pinch = 1 - clamp(dist(pts[4], pts[8]) / scale / 0.95);

  let extended = 0;
  for (const name of ["index", "middle", "ring", "pinky"]) if (raw[name + "_o"] > 0.5) extended++;
  if (raw.thumb_o > 0.5) extended++;

  return {
    scale,
    palm: { x: cx, y: cy },
    openness: remap(openness, gain),
    opennessRaw: openness,
    pinch: clamp(pinch),
    spread,
    extended,
    fingers: {
      thumb: remap(raw.thumb_o, gain),
      index: remap(raw.index_o, gain),
      middle: remap(raw.middle_o, gain),
      ring: remap(raw.ring_o, gain),
      pinky: remap(raw.pinky_o, gain),
    },
    ratios: raw,
  };
}

const ema = (prev, next, dt, tau) => {
  const a = 1 - Math.exp(-Math.max(dt, 0) / tau);
  return prev + (next - prev) * a;
};

/**
 * 单手的时间序列状态：负责平滑、速度估计、丢失后的惯性滑行。
 * 检测频率（约 20-30Hz）远低于渲染频率（60fps），所以平滑和速度估计是必需的。
 */
export class HandTrack {
  constructor() {
    this.landmarks = null;
    this.analyzed = null;
    this.openness = 0;
    this.openVel = 0;
    this.palm = { x: 0, y: 0 };
    this.vel = { x: 0, y: 0 };
    this.scale = 64;
    this.visible = false;
    this.sinceSeen = 9;
    this.age = 0;
  }

  get strength() {
    // 新出现 / 刚消失时用权重淡入淡出，避免粒子瞬移。
    // 先给 0.14s 的宽限（检测偶尔漏帧不该让粒子散掉），再用 0.34s 衰减到 0。
    if (!this.landmarks) return 0;
    const inRamp = clamp(this.age / 0.12);
    const outRamp = clamp(1 - (this.sinceSeen - 0.14) / 0.34);
    return Math.min(inRamp, outRamp);
  }

  /** 本帧检测到了这只手 */
  feed(pts, dt, opts) {
    const res = analyze(pts, opts);
    if (!res) return false;
    const first = !this.landmarks;
    const tau = first ? 0.001 : 0.05;

    if (first) {
      this.landmarks = pts.map((p) => ({ x: p.x, y: p.y }));
      this.palm = { ...res.palm };
      this.openness = res.openness;
    } else {
      const prevPalm = { ...this.palm };
      for (let i = 0; i < 21; i++) {
        this.landmarks[i].x = ema(this.landmarks[i].x, pts[i].x, dt, tau);
        this.landmarks[i].y = ema(this.landmarks[i].y, pts[i].y, dt, tau);
      }
      this.palm.x = ema(this.palm.x, res.palm.x, dt, 0.09);
      this.palm.y = ema(this.palm.y, res.palm.y, dt, 0.09);
      // 速度用"平滑后位置的真实位移"算，而不是 EMA 的步长，否则会被严重低估
      this.vel.x = ema(this.vel.x, (this.palm.x - prevPalm.x) / Math.max(dt, 1e-3), dt, 0.06);
      this.vel.y = ema(this.vel.y, (this.palm.y - prevPalm.y) / Math.max(dt, 1e-3), dt, 0.06);
      // 张开用更快的时间常数，握拳稍微稳一点，观感上"张开"更果断
      const tauO = res.openness > this.openness ? 0.06 : 0.1;
      const prev = this.openness;
      this.openness = ema(prev, res.openness, dt, tauO);
      if (dt > 0) this.openVel = ema(this.openVel, (this.openness - prev) / dt, dt, 0.05);
    }
    this.analyzed = res;
    this.scale = ema(first ? res.scale : this.scale, res.scale, dt, 0.15);
    this.visible = true;
    this.sinceSeen = 0;
    this.age = first ? 0 : this.age + dt;
    return true;
  }

  /** 本帧没检测到这只手：保留状态，靠 strength 淡出 */
  coast(dt) {
    this.sinceSeen += dt;
    this.age += dt;
    this.openVel = ema(this.openVel, 0, dt, 0.08);
    if (this.sinceSeen > 0.55) {
      this.visible = false;
      this.landmarks = null;
      this.analyzed = null;
      this.vel.x = 0;
      this.vel.y = 0;
    }
  }
}
