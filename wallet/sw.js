// MNC Wallet (TESTNET) — service worker
// काम: वॉलेट ऐप की अपनी फ़ाइलें cache करना, ताकि पेज ऑफ़लाइन भी खुले।
// यह सिर्फ़ इसी फ़ोल्डर (wallet/) की फ़ाइलें सँभालता है; माइनर का अपना service worker है।
//
// कोई भी फ़ाइल बदलने पर CACHE_VERSION बढ़ाएँ (v1 -> v2)। तभी फ़ोन पर
// नया संस्करण पहुँचेगा और पुराना cache हटेगा।

"use strict";

const CACHE_VERSION = "v2";
const CACHE_PREFIX = "mnc-wallet-";
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

const ASSETS = [
  "./",
  "vault.js",
  "app.js",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

// redirect से आया जवाब हो तो उसकी साफ़ कॉपी (ब्राउज़र redirect वाला cached पेज नहीं खोलता)
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
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return clean(cached);
      try {
        return await clean(await fetch(request));
      } catch (err) {
        if (request.mode === "navigate") {
          const shell = await cache.match("./");
          if (shell) return clean(shell);
        }
        throw err;
      }
    })
  );
});
