// Service Worker für die Draft-Board-App
// Seite: immer zuerst aus dem Netz (Updates kommen sofort an), offline aus dem Cache.
// Champion-Bilder, Schriften und Firebase-Skripte: aus dem Cache, damit die App schnell startet.
// Live-Daten (Firestore, Riot-Proxy, Discord) gehen nie durch den Cache.
const VERSION = "db-2";
const SHELL = `${VERSION}-shell`, ASSETS = `${VERSION}-assets`, IMAGES = "db-images";
const SHELL_FILES = ["./", "./index.html", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"];
const MAX_IMAGES = 600;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== ASSETS && k !== IMAGES).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function networkFirst(req){
  const cache = await caches.open(SHELL);
  try {
    // „no-cache“: beim Server nachfragen (ETag → meist schnelle 304-Antwort) statt bis zu 10 Min. alte Kopie aus dem Browser-Cache
    const res = await fetch(req, { cache: "no-cache" });
    if (res.ok) cache.put(req.mode === "navigate" ? "./index.html" : req, res.clone());
    return res;
  } catch(e){
    return (await cache.match(req.mode === "navigate" ? "./index.html" : req)) || (await cache.match("./")) || Response.error();
  }
}
async function cacheFirst(req, name, max){
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque"){
    cache.put(req, res.clone());
    if (max) cache.keys().then(keys => { if (keys.length > max) keys.slice(0, keys.length - max).forEach(k => cache.delete(k)); });
  }
  return res;
}
async function staleWhileRevalidate(req, name){
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  const net = fetch(req).then(res => { if (res.ok || res.type === "opaque") cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || net;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin){
    if (req.mode === "navigate" || url.pathname.endsWith(".html") || url.pathname.endsWith("/")) return e.respondWith(networkFirst(req));
    if (url.pathname.endsWith("sw.js")) return;
    return e.respondWith(staleWhileRevalidate(req, SHELL));
  }
  if (url.hostname === "ddragon.leagueoflegends.com" && /\/img\//.test(url.pathname)) return e.respondWith(cacheFirst(req, IMAGES, MAX_IMAGES));
  if (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/")) return e.respondWith(cacheFirst(req, ASSETS));
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") return e.respondWith(staleWhileRevalidate(req, ASSETS));
  // alles andere (Firestore, Riot-Proxy, Discord, Data-Dragon-Listen) normal übers Netz
});
