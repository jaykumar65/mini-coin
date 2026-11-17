// MiniCoin होम (/) — service worker
//
// काम: सिर्फ़ होम पेज की अपनी फ़ाइलें ऑफ़लाइन cache करना।
// इसका scope "/" है, पर यह /miner/, /wallet/, /pay/, /explorer/, /site/ की फ़ाइलों को छूता नहीं:
// उनके अनुरोध सीधे नेटवर्क (या उनके अपने service worker) को जाते हैं।
//
// पहले इसी पते (/sw.js) पर पुराना माइनर का service worker था, जो "/" पर माइनर का पेज cache से
// दिखाता था। यह नया worker चालू होते ही उसका cache हटाता है और खुले पन्नों को एक बार दोबारा
// खोलता है, ताकि पुराने cache से माइनर की जगह नया होम पेज दिखे।
//
// कोई भी होम फ़ाइल बदलने पर CACHE_VERSION बढ़ाएँ।

"use strict";

const CACHE_VERSION = "v1";
const CACHE_PREFIX = "mnc-home-";
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const LEGACY_CACHE_RE = /^mnc-miner-v\d+$/; // पुराना माइनर जब "/" पर था

// होम की फ़ाइलें, scope के हिसाब से पूरे रास्ते (pathname) में
const ASSETS = ["/", "/manifest.json", "/home.js", "/icons/icon-192.png", "/icons/icon-512.png"];
const OWN = new Set(ASSETS.concat(["/index.html"]));

async function clean(response) {
  if (!response || !response.redirected) return response;
  return new Response(await response.blob(), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          ASSETS.map(async (path) => {
            const response = await fetch(new Request(path, { cache: "reload" }));
            if (!response.ok) throw new Error(path + " " + response.status);
            await cache.put(path, await clean(response));
          })
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const legacy = keys.some((key) => LEGACY_CACHE_RE.test(key));
      await Promise.all(
        keys
          .filter((key) => (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) || LEGACY_CACHE_RE.test(key))
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
      // पुराने माइनर के cache से खुला "/" पेज एक बार दोबारा खोलें, ताकि होम दिखे
      if (legacy) {
        const windows = await self.clients.matchAll({ type: "window" });
        for (const client of windows) {
          const path = new URL(client.url).pathname;
          if (path === "/" || path === "/index.html") client.navigate(client.url).catch(() => {});
        }
      }
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname === "/index.html" ? "/" : url.pathname;
  if (!OWN.has(path)) return; // दूसरे ऐप की फ़ाइलें: इस worker का कोई दख़ल नहीं

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      // होम पेज पहले नेटवर्क से (वॉलेट की स्थिति वगैरह ताज़ा रहें), न मिले तो cache
      try {
        const fresh = await clean(await fetch(request));
        if (fresh.ok) cache.put(path, fresh.clone());
        return fresh;
      } catch (err) {
        const cached = await cache.match(path);
        if (cached) return clean(cached);
        throw err;
      }
    })
  );
});
