// MNC टेस्टनेट माइनर — service worker
// काम: ऐप की अपनी फ़ाइलें cache करना, ताकि पेज ऑफ़लाइन भी खुले।
// यह किसी बाहरी सर्वर से कुछ नहीं माँगता; सिर्फ़ इसी फ़ोल्डर की फ़ाइलें।
//
// कोई भी फ़ाइल बदलने पर CACHE_VERSION बढ़ाएँ (v1 -> v2)। तभी फ़ोन पर
// नया संस्करण पहुँचेगा और पुराना cache हटेगा।

"use strict";

const CACHE_VERSION = "v3";
const CACHE_PREFIX = "mnc-miner-";
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

const ASSETS = [
  "./",
  "index.html",
  "miner.js",
  "worker.js",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // cache: "reload" — ब्राउज़र के HTTP cache की पुरानी कॉपी न उठे
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: "reload" }))))
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
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      try {
        return await fetch(request);
      } catch (err) {
        // ऑफ़लाइन में कोई भी पेज-नेविगेशन index.html पर ले जाए
        if (request.mode === "navigate") {
          const shell = await cache.match("index.html");
          if (shell) return shell;
        }
        throw err;
      }
    })
  );
});
