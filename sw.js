/* Работа без интернета: все файлы версии лежат в кэше телефона одним комплектом.
   После любых изменений сайта подними номер версии в CACHE — телефоны скачают новый комплект целиком. */
const CACHE = "moto-uchet-v3";
const APP_FILES = ["./", "index.html", "app.css", "core.js", "excel.js", "telegram.js", "app.js", "manifest.webmanifest",
  "icon.svg", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (event) => {
  // cache: "reload" — берём файлы с сервера, а не из обычного кэша браузера, чтобы версии не смешались.
  event.waitUntil(caches.open(CACHE)
    .then((cache) => cache.addAll(APP_FILES.map((url) => new Request(url, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  const navigation = request.mode === "navigate";
  event.respondWith(caches.match(navigation ? "./" : request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok && url.pathname.includes("/vendor/")) { // библиотеку Excel кладём в кэш при первом использовании
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
    }
    return response;
  }).catch(() => (navigation ? caches.match("./") : Response.error()))));
});
