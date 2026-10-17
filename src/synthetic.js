/**
 * synthetic.js — 程序化生成的 21 点手部关键点。
 *
 * 两个用途：
 *   1) 演示模式：没有摄像头也能看到完整效果（也方便远程调试 / 录屏演示）。
 *   2) 自检：用同一套模型验证 gesture.js 的开合映射是否单调、量程是否合理。
 *
 * 局部坐标（"掌长单位"，1.0 = wrist -> middle_MCP 的距离）：
 *   手腕在原点，手指朝 -y，+x 为小指侧。curl: 0=完全张开, 1=紧握拳。
 */

const FINGERS = {
  index: { mcp: [-0.4, -0.98], seg: [0.38, 0.255, 0.21], fan: -0.05, fist: [-0.3, -0.62], sx: -1 },
  middle: { mcp: [-0.14, -1.0], seg: [0.43, 0.285, 0.235], fan: 0.0, fist: [-0.1, -0.66], sx: -0.3 },
  ring: { mcp: [0.12, -0.96], seg: [0.4, 0.265, 0.215], fan: 0.06, fist: [0.1, -0.62], sx: 0.5 },
  pinky: { mcp: [0.38, -0.9], seg: [0.31, 0.2, 0.17], fan: 0.15, fist: [0.3, -0.52], sx: 1 },
};

const THUMB = {
  cmc: [-0.28, -0.2],
  open: { mcp: [-0.46, -0.44], ip: [-0.62, -0.6], tip: [-0.74, -0.72] },
  fist: { mcp: [-0.4, -0.38], ip: [-0.4, -0.48], tip: [-0.34, -0.56] },
};

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const rot = (v, a) => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];

/** 在局部单位下生成 21 个归一化点（顺序 = MediaPipe 索引） */
export function handPoints({ curl = 0, splay = 0 }) {
  const c = Math.min(1, Math.max(0, curl));
  const bow = 0.035 * Math.sin(Math.PI * c); // 半蜷曲时掌指关节微微外凸，看起来更像手
  const out = [];

  // --- 拇指 (0=wrist 1=cmc 2=mcp 3=ip 4=tip)
  out.push([0, 0], THUMB.cmc.slice());
  for (const k of ["mcp", "ip", "tip"]) out.push(mix(THUMB.open[k], THUMB.fist[k], c));
  // 拇指略微外展，让"张开"时拇指张得更开一点
  for (let i = 2; i < 5; i++) out[i][0] -= 0.06 * (1 - c) * splay;

  // --- 四指
  for (const name of ["index", "middle", "ring", "pinky"]) {
    const f = FINGERS[name];
    const u = rot([0, -1], f.fan * (1 + splay * 0.6));
    const [l1, l2, l3] = f.seg;
    const mcp = f.mcp.slice();
    const p1 = [mcp[0] + u[0] * l1, mcp[1] + u[1] * l1];
    const p2 = [p1[0] + u[0] * l2, p1[1] + u[1] * l2];
    const p3 = [p2[0] + u[0] * l3, p2[1] + u[1] * l3];
    // 握拳时三节指骨投影缩短，指尖收到掌心附近
    const q1 = [mcp[0] + 0.06 * f.sx, mcp[1] + 0.05];
    const q2 = [mcp[0] + 0.1 * f.sx, mcp[1] + 0.15];
    const q3 = f.fist;
    const a1 = mix(p1, q1, c);
    a1[0] += bow * f.sx;
    out.push(mcp, a1, mix(p2, q2, c), mix(p3, q3, c));
  }
  return out;
}

/**
 * 生成一只手的世界坐标（像素）。
 * @param {object} o
 * @param {number} o.x,o.y 手腕位置
 * @param {number} o.size 腕 -> 中掌指关节 的像素长度
 * @param {number} o.rot 整只手在画面内的旋转（弧度）
 * @param {number} o.curl 0 张开 1 握拳
 * @param {number} [o.splay] 额外的手指张角
 * @param {boolean} [o.left] 是否左手（水平镜像）
 */
export function makeHand({ x, y, size, rot = 0, curl = 0, splay = 0, left = false }) {
  const pts = handPoints({ curl, splay });
  const ca = Math.cos(rot);
  const sa = Math.sin(rot);
  return pts.map(([px, py]) => {
    const mx = left ? -px : px;
    return { x: x + (mx * ca - py * sa) * size, y: y + (mx * sa + py * ca) * size, z: 0 };
  });
}

/**
 * 演示模式脚本：手在画面里缓慢移动 + 周期性张合。
 * @param {number} t 秒
 * @param {number} w,h 画面尺寸
 * @returns {Array<Array<{x:number,y:number}>>} 每只手 21 个点
 */
export function demoHands(t, w, h) {
  const breathe = 0.5 - 0.5 * Math.cos((t / 3.6) * Math.PI * 2); // 0 握拳 -> 1 张开
  const open = Math.pow(breathe, 0.72); // 让"张开"停留久一点、握拳更干脆
  const curl = 1 - open;
  const size = Math.min(w, h) * 0.14;
  const cy = h * 0.52 + Math.sin(t * 0.67 + 1.1) * h * 0.05;
  // 张开时两只手往两边拉开，握拳时收拢到中间：这样"拉成一座桥"看得最清楚
  const sep = (0.1 + 0.24 * open) * w;
  const hands = [
    makeHand({
      x: w * 0.5 - sep * 0.5,
      y: cy,
      size,
      rot: 0.16 * Math.sin(t * 0.53) - 0.06,
      curl,
      splay: 0.5 * open,
    }),
  ];
  // 8 秒后加入第二只手（淡入由 HandTrack 的权重斜坡负责）
  if (t > 8) {
    hands.push(
      makeHand({
        x: w * 0.5 + sep * 0.5,
        y: cy + h * 0.03,
        size: size * 0.96,
        rot: -0.14 * Math.sin(t * 0.53) + 0.06,
        curl,
        splay: 0.5 * open,
        left: true,
      })
    );
  }
  return hands;
}
