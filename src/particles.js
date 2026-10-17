/**
 * particles.js — 粒子场。
 *
 * 核心思路：每个粒子挂在一个"吸引子"（一只手，或双手之间的桥）上，吸引子上有
 * 21 个锚点（对应 21 个关键点）。粒子的目标点 = 锚点 + 极坐标偏移，
 * 偏移半径由手掌张开程度驱动 —— 于是手一张开，粒子云就"炸开"，一握拳就收拢。
 *
 * 纯逻辑、不碰 canvas，方便在 Node 里跑数值测试。
 */

const TAU = Math.PI * 2;
const rnd = (a = 1) => Math.random() * a;

/**
 * 各模式的物理与观感参数。
 *  spring/zeta  弹簧刚度(1/s^2) 与阻尼比
 *  rIn/rOut     握拳/张开时粒子云半径（× 手掌尺寸）
 *  kick         张开瞬间向外冲量的强度
 *  closeSwirl   握拳时的切向旋涡强度
 *  orbit        常态切向速度（星系靠它自转）
 *  spiral       螺旋臂（星系专用）
 *  fadeTau      拖尾残留时长（秒），越小越干脆
 */
export const MODES = {
  sand: {
    label: "沙尘",
    sprite: "grain",
    blend: "source-over",
    fadeTau: 0.16,
    spring: 210,
    zeta: 0.62,
    rIn: 0.1,
    rOut: 3.6,
    anchorMix: 0.45,
    kick: 1.15,
    closeSwirl: 0.5,
    orbit: 0.05,
    spinRate: 0.25,
    gravity: 520,
    wind: 0.55,
    drag: 2.1,
    sizeMin: 0.7,
    sizeMax: 2.3,
    sizePow: 1.7,
    alpha: [0.35, 0.95],
    twinkle: 0.25,
    idleSpring: 9,
    idleTurb: 90,
    colors: ["#f6dda0", "#e8bd76", "#cf9d5e", "#a97c4e", "#8c6a45", "#fff1cf"],
  },
  galaxy: {
    label: "星系",
    sprite: "glow",
    blend: "lighter",
    packAlpha: true,
    fadeTau: 0.3,
    spring: 95,
    zeta: 0.24,
    rIn: 0.22,
    rOut: 3.3,
    anchorMix: 0.6,
    kick: 0.85,
    closeSwirl: 1.2,
    orbit: 1.5,
    spinRate: 0.85,
    spiral: { arms: 3, twist: 2.6, jitter: 0.5 },
    gravity: 0,
    wind: 0.25,
    drag: 0.4,
    sizeMin: 0.5,
    sizeMax: 2.6,
    sizePow: 2.1,
    alpha: [0.18, 0.72],
    twinkle: 1.3,
    idleSpring: 7,
    idleTurb: 55,
    colors: ["#ffffff", "#cfe6ff", "#9fd0ff", "#c9a7ff", "#ff9ad5", "#7fe8ff", "#ffe9b0"],
  },
  water: {
    label: "水滴",
    sprite: "droplet",
    blend: "source-over",
    fadeTau: 0.22,
    spring: 265,
    zeta: 0.78,
    rIn: 0.34,
    rOut: 2.0,
    anchorMix: 0.42,
    kick: 0.95,
    closeSwirl: 0.35,
    orbit: 0.12,
    spinRate: 0.3,
    gravity: 760,
    wind: 0.7,
    drag: 2.6,
    sizeMin: 1.3,
    sizeMax: 3.8,
    sizePow: 1.4,
    alpha: [0.6, 1],
    twinkle: 0.45,
    idleSpring: 8,
    idleTurb: 70,
    colors: ["#dff6ff", "#a6e5ff", "#6cc8f5", "#3aa0e0", "#2b7fc4"],
  },
  firefly: {
    label: "萤火",
    sprite: "glow",
    blend: "lighter",
    packAlpha: true,
    fadeTau: 0.45,
    spring: 58,
    zeta: 0.38,
    rIn: 0.45,
    rOut: 4.4,
    anchorMix: 0.62,
    kick: 0.5,
    closeSwirl: 0.8,
    orbit: 0.6,
    spinRate: 0.5,
    gravity: 0,
    wind: 0.2,
    drag: 1.0,
    sizeMin: 0.9,
    sizeMax: 3.0,
    sizePow: 2.4,
    alpha: [0.16, 0.78],
    twinkle: 1.1,
    idleSpring: 6,
    idleTurb: 60,
    colors: ["#dcffa8", "#a6f57e", "#ffe9a3", "#8ef0c4", "#f9ffd6"],
  },
};

export class ParticleField {
  constructor(count = 2000) {
    this.ps = [];
    this.w = 0;
    this.h = 0;
    this.laidOut = false; // 是否已经在真实画布尺寸上播撒过
    this.epoch = -1; // 吸引子集合的版本号，变化时整体重新分配归属
    this.mode = MODES.sand;
    this.setCount(count, 1, 1);
  }

  setMode(mode) {
    this.mode = mode;
    for (const p of this.ps) this.dress(p);
  }

  /** 抽一份"外观"：尺寸、色调、透明度、闪烁相位 */
  dress(p) {
    const m = this.mode;
    p.size = m.sizeMin + (m.sizeMax - m.sizeMin) * Math.pow(rnd(), m.sizePow);
    p.tone = rnd();
    p.ci = rnd();
    p.alpha = m.alpha[0] + (m.alpha[1] - m.alpha[0]) * Math.pow(rnd(), 0.8);
    p.phase = rnd(TAU);
    p.twS = 0.6 + rnd(1.6);
    p.spinSign = Math.random() < 0.18 ? -1 : 1;
    // 螺旋臂编号（星系模式用；其他模式恒为 0）
    p.arm = m.spiral ? rnd(m.spiral.arms) | 0 : 0;
  }

  /** 抽一个粒子（含它在场上的"老家"，没手时在那儿轻轻漂） */
  spawn(p, w = this.w, h = this.h) {
    p.x = rnd(w);
    p.y = rnd(h);
    p.vx = 0;
    p.vy = 0;
    p.att = -1;
    p.anchor = (rnd(21) | 0) % 21;
    p.offA = rnd(TAU);
    // 半径偏内密外疏：粒子云才有"核 + 晕"的层次，而不是一片均匀噪点
    p.offR = 0.3 + 0.92 * Math.pow(rnd(), 1.45);
    p.homeX = rnd(w);
    p.homeY = rnd(h);
    p.jitR = 4 + rnd(22);
    p.jitW = 0.4 + rnd(1.5);
    this.dress(p);
    return p;
  }

  setCount(n, w = this.w, h = this.h) {
    n = Math.max(0, n | 0);
    this.w = w;
    this.h = h;
    while (this.ps.length > n) this.ps.pop();
    while (this.ps.length < n) this.ps.push(this.spawn({}, w, h));
    return this;
  }

  resize(w, h) {
    // 首次拿到真实尺寸时重新播撒：构造函数里只能按 1x1 的占位尺寸播，
    // 不重播的话这些粒子会一直堆在左上角（然后被最近的那只手全抓走）
    if (!this.laidOut || this.w < 2 || this.h < 2) {
      this.w = w;
      this.h = h;
      for (const p of this.ps) this.spawn(p, w, h);
      this.laidOut = true;
      return;
    }
    const sx = this.w > 0 ? w / this.w : 1;
    const sy = this.h > 0 ? h / this.h : 1;
    for (const p of this.ps) {
      p.x *= sx;
      p.y *= sy;
      p.homeX *= sx;
      p.homeY *= sy;
    }
    this.w = w;
    this.h = h;
  }

  /**
   * 推进一帧。
   * @param {number} dt 秒
   * @param {{t:number,w:number,h:number,attractors:Array}} env
   *   attractor: {x,y,scale,openness,openVel,spin,strength,radius,anchors:[{x,y}]}
   */
  update(dt, env) {
    dt = Math.min(Math.max(dt, 0), 0.05);
    // 手出现/消失/桥出现时，整体重分一次：按"老家位置"做一次干净的重新归属，
    // 不经过滞回。否则先来的那只手会把边界附近的粒子永久占住。
    if (env.epoch !== undefined && env.epoch !== this.epoch) {
      this.epoch = env.epoch;
      for (const p of this.ps) p.att = -1;
    }
    const m = this.mode;
    const A = env.attractors || [];
    const w = env.w;
    const h = env.h;
    const pad = Math.min(w, h) * 0.06;
    const nA = A.length;
    const damp = 2 * m.zeta * Math.sqrt(m.spring);
    const idleDamp = 2 * 0.85 * Math.sqrt(m.idleSpring);
    const maxV = 4200;

    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];

      // ---- 选吸引子（带滞回，避免在两个吸引子之间反复横跳）
      // 归属看「老家位置」而不是当前位置：老家在画面上是均匀分布的，
      // 于是每只手（以及中间的桥）能按画面区域公平地分到粒子。
      // 若按当前位置判断，先出现的那只手会把粒子全抓走，第二只手出现时会是空的。
      let best = -1;
      let bd = Infinity;
      for (let k = 0; k < nA; k++) {
        const a = A[k];
        if (a.strength <= 0.02) continue;
        const d = Math.hypot(p.homeX - a.x, p.homeY - a.y);
        if (d < a.radius && d < bd) {
          bd = d;
          best = k;
        }
      }
      if (p.att !== best) {
        if (best >= 0 && (p.att < 0 || p.att >= nA || A[p.att].strength <= 0.02)) {
          p.att = best;
          p.anchor = rnd(A[best].anchors.length) | 0;
        } else if (best >= 0) {
          const c = A[p.att];
          const dc = Math.hypot(p.homeX - c.x, p.homeY - c.y);
          if (bd < dc * 0.8) {
            p.att = best;
            p.anchor = rnd(A[best].anchors.length) | 0;
          }
        } else if (p.att < nA) {
          // 当前吸引子已失效 -> 释放回自由漂浮
          p.att = A[p.att] && A[p.att].strength <= 0.02 ? -1 : p.att;
        }
      }

      const a = p.att >= 0 && p.att < nA ? A[p.att] : null;

      if (a) {
        // ---- 被手势驱动
        const anchors = a.anchors;
        // 锚点缓慢巡游，让粒子云像活的一样在手上流动
        if (Math.random() < dt / 1.15) {
          if (Math.random() < 0.12) p.anchor = rnd(anchors.length) | 0;
          else p.anchor = Math.min(anchors.length - 1, Math.max(0, p.anchor + ((rnd(7) | 0) - 3)));
        }
        const an = anchors[Math.min(p.anchor, anchors.length - 1)] || { x: a.x, y: a.y };
        const ax = an.x + (a.x - an.x) * m.anchorMix;
        const ay = an.y + (a.y - an.y) * m.anchorMix;

        const rBase = (m.rIn + (m.rOut - m.rIn) * a.openness) * a.scale;
        const jit = p.jitR * Math.sin(env.t * p.jitW + p.phase) * (0.35 + a.openness * 0.65);
        const r = Math.max(2, rBase * p.offR + jit);
        let ang = p.offA + a.spin * p.spinSign;
        if (m.spiral) {
          ang += (p.arm * TAU) / m.spiral.arms + p.offR * m.spiral.twist * (0.35 + a.openness * 0.65);
        }
        const tx = ax + Math.cos(ang) * r;
        const ty = ay + Math.sin(ang) * r;

        const dx = tx - p.x;
        const dy = ty - p.y;
        // 弹簧 + 阻尼（阻尼比固定 => 不会越弹越乱）
        p.vx += (dx * m.spring - p.vx * damp) * dt;
        p.vy += (dy * m.spring - p.vy * damp) * dt;

        const ol = Math.hypot(p.x - ax, p.y - ay) + 1e-3;
        // 张开瞬间的向外冲量：先炸开，再被弹簧拉回到外壳上
        const kick = a.openVel > 0 ? a.openVel * m.kick * a.scale * 6 : 0;
        const swirl = m.orbit * a.scale * 2 + m.closeSwirl * Math.max(0, -a.openVel) * a.scale * 3;
        p.vx += ((p.x - ax) / ol) * kick * dt + (-(p.y - ay) / ol) * swirl * p.spinSign * dt;
        p.vy += ((p.y - ay) / ol) * kick * dt + ((p.x - ax) / ol) * swirl * p.spinSign * dt;

        // 手掌挥动带起的风（跟着手的方向走）
        p.vx += a.velX * m.wind * dt * 6;
        p.vy += a.velY * m.wind * dt * 6;
      } else {
        // ---- 没有手：自由漂浮，慢慢归位到自己的老家
        const hx = p.homeX + Math.sin(env.t * 0.11 + p.phase) * 46;
        const hy = p.homeY + Math.cos(env.t * 0.09 + p.phase * 1.7) * 34;
        p.vx += ((hx - p.x) * m.idleSpring - p.vx * idleDamp + Math.sin(env.t * p.jitW + p.phase) * m.idleTurb) * dt;
        p.vy += ((hy - p.y) * m.idleSpring - p.vy * idleDamp + Math.cos(env.t * p.jitW * 0.83 + p.phase) * m.idleTurb) * dt;
      }

      // ---- 全局力
      p.vy += m.gravity * dt;
      const dg = Math.exp(-m.drag * dt);
      p.vx *= dg;
      p.vy *= dg;

      const sp = Math.hypot(p.vx, p.vy);
      if (sp > maxV) {
        p.vx = (p.vx / sp) * maxV;
        p.vy = (p.vy / sp) * maxV;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // ---- 软墙：飘出画面就慢慢被推回来（比硬反弹自然）
      if (p.x < pad) p.vx += (pad - p.x) * 26 * dt;
      else if (p.x > w - pad) p.vx += (w - pad - p.x) * 26 * dt;
      if (p.y < pad) p.vy += (pad - p.y) * 26 * dt;
      else if (p.y > h - pad) p.vy += (h - pad - p.y) * 26 * dt;
    }
  }

  /** 测试用：粒子云的统计量 */
  stats() {
    const n = this.ps.length;
    if (!n) return { n: 0 };
    let sx = 0;
    let sy = 0;
    let sv = 0;
    let bad = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let hMinX = Infinity;
    let hMaxX = -Infinity;
    let hSum = 0;
    const hist = new Array(10).fill(0);
    for (const p of this.ps) {
      if (!Number.isFinite(p.x + p.y + p.vx + p.vy)) bad++;
      sx += p.x;
      sy += p.y;
      hSum += p.homeX;
      hist[Math.min(9, Math.max(0, ((p.homeX / (this.w || 1)) * 10) | 0))]++;
      if (p.homeX < hMinX) hMinX = p.homeX;
      if (p.homeX > hMaxX) hMaxX = p.homeX;
      sv += Math.hypot(p.vx, p.vy);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return {
      n,
      bad,
      cx: sx / n,
      cy: sy / n,
      speed: sv / n,
      minX,
      maxX,
      minY,
      maxY,
      homeX: [Math.round(hMinX), Math.round(hSum / n), Math.round(hMaxX)].join("/"),
      homeHist: hist.join(","),
    };
  }
}
