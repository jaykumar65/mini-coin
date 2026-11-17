// MNC टेस्टनेट माइनर (/miner/) — service worker
// काम: सिर्फ़ ऑफ़लाइन cache, ताकि माइनर का पेज बिना इंटरनेट भी खुले।
// यह बैकग्राउंड में माइनिंग नहीं करता; माइनिंग (संकेत भेजना) पेज और उसके Web Worker में होती है।
//
// Scope: /miner/ । होम (/), वॉलेट (/wallet/), Pay (/pay/) के अपने service worker हैं।
// कोई भी फ़ाइल बदलने पर CACHE_VERSION बढ़ाएँ, तभी फ़ोन पर नया संस्करण पहुँचेगा।
//
// Cloudflare "x.html" को "x" पर redirect करता है; ब्राउज़र redirect वाला cached पेज नहीं खोलता
// (ERR_FAILED), इसलिए हर जवाब redirect की छाप हटाकर ही रखा और लौटाया जाता है।

"use strict";

const CACHE_VERSION = "v2";
const CACHE_PREFIX = "mnc-miner-app-";
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
// पुराना माइनर जड़ (/) पर था और उसका cache "mnc-miner-v1" ... "mnc-miner-v12" नाम से था
const LEGACY_CACHE_RE = /^mnc-miner-v\d+$/;

// "./" = /miner/ ; बाक़ी साझा फ़ाइलें ऊपर के फ़ोल्डर में हैं
const ASSETS = [
  "./",
  "miner.js",
  "ping-worker.js",
  "manifest.json",
  "../config/units.js",
  "../config/chain.json",
  "../wallet/vault.js",
  "../icons/icon-192.png",
  "../icons/icon-512.png",
];

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
            .filter((key) => (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) || LEGACY_CACHE_RE.test(key))
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// chain.json हमेशा ताज़ा चाहिए (इनाम/राउंड की संख्या बदल सकती है): पहले नेटवर्क, न मिले तो cache
const NETWORK_FIRST = [/\/config\/chain\.json$/];

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      if (NETWORK_FIRST.some((re) => re.test(url.pathname))) {
        try {
          const fresh = await clean(await fetch(request));
          if (fresh.ok) cache.put(request, fresh.clone());
          return fresh;
        } catch (err) {
          const old = await cache.match(request, { ignoreSearch: true });
          if (old) return clean(old);
          throw err;
        }
      }
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
