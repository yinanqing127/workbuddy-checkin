'use strict';

// 极简 Service Worker：缓存应用壳以支持"添加到主屏幕"后离线打开。
// 策略：**网络优先**（保证一升级就能拿到新页面），断网时回退到缓存。
// 早期版本用的是"缓存优先"，会导致更新后首次打开仍是旧页面。
const CACHE = 'wb-checkin-v3';
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // 代理接口走网络，不缓存
  let sameOrigin = false;
  try {
    sameOrigin = new URL(req.url).origin === self.location.origin;
  } catch (_) {
    sameOrigin = false;
  }
  if (!sameOrigin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
