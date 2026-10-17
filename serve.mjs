/**
 * serve.mjs — 本地静态服务器（零依赖，只用 node 内置模块）。
 *
 * 为什么不用 `python -m http.server`：
 *   ES module 需要正确的 MIME 类型，.wasm 也需要 application/wasm，
 *   否则浏览器会拒绝加载，或者 WebAssembly.instantiateStreaming 退化。
 *
 * 用法：
 *   node serve.mjs              # http://localhost:8787
 *   node serve.mjs --port=9000
 */

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";

const arg = (name, dflt) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
};

// --root 可以指定站点根目录，用来模拟"站点挂在子路径下"的情况
// （GitHub Pages 就是 https://<用户名>.github.io/<仓库名>/ 这种子路径）
const ROOT = resolve(arg("root", fileURLToPath(new URL(".", import.meta.url))));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".binarypb": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const PORT = Number(arg("port", 8787));
const HOST = arg("host", "0.0.0.0");

const server = createServer((req, res) => {
  let path = "/";
  try {
    path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  // 自检回传通道：页面把结果发回来，方便在没有控制台的环境里看结果
  if (path === "/__selftest") {
    const r = new URL(req.url, "http://localhost").searchParams.get("r") || "";
    console.log(`[selftest] ${r}`);
    res.writeHead(204).end();
    return;
  }
  if (path.endsWith("/")) path += "index.html";
  const full = normalize(join(ROOT, path));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (!existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404 " + path);
    return;
  }
  const st = statSync(full);
  if (process.env.LOG_REQ === "1") console.log(`200 ${path} ${st.size}`);
  const isVendor = full.includes(`${sep}vendor${sep}`);
  res.writeHead(200, {
    "Content-Type": MIME[extname(full).toLowerCase()] || "application/octet-stream",
    "Content-Length": st.size,
    // 大文件（wasm/模型）缓存久一点，页面本身每次都校验
    "Cache-Control": isVendor ? "public, max-age=604800" : "no-cache",
    "Accept-Ranges": "bytes",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(full).pipe(res);
});

const lanAddresses = () => {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
};

server.listen(PORT, HOST, () => {
  console.log(`手势粒子 · 本地服务已启动`);
  console.log(`  电脑打开: http://localhost:${PORT}/`);
  for (const ip of lanAddresses()) {
    console.log(`  同一 WiFi 下手机打开: http://${ip}:${PORT}/   ← 注意：绝大部分手机浏览器禁止 http 页面访问摄像头`);
  }
  console.log(`  手机想真的用摄像头，需要 https，见 README.md 的「怎么在手机上用」`);
});
