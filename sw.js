// MNC टेस्टनेट माइनर — service worker
// काम: ऐप की अपनी फ़ाइलें cache करना, ताकि पेज ऑफ़लाइन भी खुले।
// यह किसी बाहरी सर्वर से कुछ नहीं माँगता; सिर्फ़ इसी फ़ोल्डर की फ़ाइलें।
//
// कोई भी फ़ाइल बदलने पर CACHE_VERSION बढ़ाएँ (v1 -> v2)। तभी फ़ोन पर
// नया संस्करण पहुँचेगा और पुराना cache हटेगा।
//
// Cloudflare "wallet.html" को "/wallet" पर redirect करता है। ब्राउज़र redirect
// वाले cached जवाब को पेज की तरह नहीं खोलता (ERR_FAILED), इसलिए यहाँ हर
// जवाब को redirect की छाप हटाकर ही cache में रखा और लौटाया जाता है।

"use strict";

const CACHE_VERSION = "v9";
const CACHE_PREFIX = "mnc-miner-";
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

const ASSETS = [
  "./",
  "index.html",
  "miner.js",
  "wallet.html",
  "wallet-core.js",
  "wallet.js",
  "worker.js",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

// redirect से आया जवाब हो तो उसकी साफ़ कॉपी (वही सामग्री, बिना redirect की छाप)
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
          ASSETS.map(async (url) => {
            // cache: "reload" — ब्राउज़र के HTTP cache की पुरानी कॉपी न उठे
            const response = await fetch(new Request(url, { cache: "reload" }));
            if (!response.ok) throw new Error(url + " " + response.status);
            await cache.put(url, await clean(response));
          })
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      let cached = await cache.match(request, { ignoreSearch: true });
      // "/wallet" जैसे बिना .html वाले पते के लिए "wallet.html" की कॉपी
      if (!cached && request.mode === "navigate" && !/\.[a-z0-9]+$/i.test(url.pathname) && !url.pathname.endsWith("/")) {
        cached = await cache.match(url.pathname + ".html");
      }
      if (cached) return clean(cached);
      try {
        return await clean(await fetch(request));
      } catch (err) {
        // ऑफ़लाइन में कोई भी पेज-नेविगेशन index.html पर ले जाए
        if (request.mode === "navigate") {
          const shell = await cache.match("index.html");
          if (shell) return clean(shell);
        }
        throw err;
      }
    })
  );
});
