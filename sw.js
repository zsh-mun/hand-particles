/*
 * 手势粒子 · Service Worker
 *
 * 为什么需要它：GitHub Pages 对静态资源的缓存时间很短（约 10 分钟，且不能自定义）。
 * wasm + 模型一共 17 MB，如果每次隔一会儿打开都要重下，手机上会很难受，
 * 流量也白花。这里把资源存进浏览器本地缓存：
 *   - vendor（wasm / 模型）与图标：缓存优先，第二次打开直接命中，永不重下
 *   - 页面本身：网络优先，保证每次都能拿到最新版本
 *   - 其余代码：先给缓存（快），后台拉新版（下次打开就是新版）
 * 顺带带来一个好处：装过一次之后，整个站点可以完全离线打开。
 */

const VER = "v3";
const CORE = `gp-core-${VER}`; // 首页外壳
const RUNTIME = `gp-run-${VER}`; // 其余运行时缓存
const SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        await (await caches.open(CORE)).addAll(SHELL);
      } catch {
        /* 首次装不上也无所谓，后面的运行时缓存会补上 */
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !k.endsWith(VER)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

/*
 * 页面加载完模型后会发消息过来，请求把这些文件预先存好。
 * 为什么要主动要：MediaPipe 内部加载 wasm 的路径不一定都能被 fetch 事件拦到，
 * 与其靠拦截，不如页面明确告诉我们要缓存哪些文件，确定性更强。
 * 这些文件本来就已经下载过一次了，这里的 fetch 基本都命中 HTTP 缓存，代价很小。
 */
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "precache" || !Array.isArray(data.urls)) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(RUNTIME);
      let added = 0;
      for (const u of data.urls) {
        try {
          const url = new URL(u, self.location.href).href;
          if (await cache.match(url, { ignoreSearch: true })) continue;
          const res = await fetch(url, { cache: "force-cache" });
          if (res && res.ok) {
            await cache.put(url, res.clone());
            added++;
          }
        } catch {
          /* 单个文件失败不影响其它 */
        }
      }
      const clients = await self.clients.matchAll();
      for (const c of clients) c.postMessage({ type: "precache-done", added });
    })()
  );
});

const isNavigation = (req, url) =>
  req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html") || url.pathname.endsWith("/");

/** 体积大且永不改动的资源 */
const isHeavyAsset = (url) =>
  url.pathname.includes("/vendor/") || /\/icon-\d+\.png$/.test(url.pathname) || url.pathname.endsWith(".png");

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  // /__ 开头的只是本地开发服务器的接口，不该进缓存
  if (url.pathname.startsWith("/__")) return;

  // 1) 页面：网络优先，断网时回退到缓存
  if (isNavigation(req, url)) {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res && res.ok && !url.search) (await caches.open(CORE)).put("./index.html", res.clone());
          return res;
        } catch {
          return (
            (await caches.match(req)) ||
            (await caches.match("./index.html")) ||
            new Response("离线，且本地没有缓存", { status: 503, headers: { "Content-Type": "text/plain;charset=utf-8" } })
          );
        }
      })()
    );
    return;
  }

  // 2) wasm / 模型 / 图标：缓存优先
  if (isHeavyAsset(url)) {
    event.respondWith(
      (async () => {
        const hit = await caches.match(req, { ignoreSearch: true });
        if (hit) return hit;
        const res = await fetch(req);
        if (res && res.ok) (await caches.open(RUNTIME)).put(req, res.clone());
        return res;
      })()
    );
    return;
  }

  // 3) 其余代码：先给缓存，后台更新
  event.respondWith(
    (async () => {
      const hit = await caches.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then(async (res) => {
          if (res && res.ok) await (await caches.open(RUNTIME)).put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || network;
    })()
  );
});
