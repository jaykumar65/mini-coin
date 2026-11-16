// MNC टेस्टनेट माइनर — Web Worker
// सिर्फ़ proof-of-work की गणना करता है। कोई नेटवर्क कॉल नहीं।
//
// ब्लॉक का हेडर (जिसका SHA-256 निकाला जाता है):
//   index|prevHash|timestamp|data|nonce
// हैश (hex) की शुरुआत में `difficulty` जितने ज़ीरो हों तो ब्लॉक वैध है।
// अगर chain.py का फ़ॉर्मैट अलग है, तो सिर्फ़ headerPrefix() बदलना काफ़ी है।

"use strict";

const BATCH = 256;          // एक साथ कितने हैश निकालें
const REPORT_EVERY_MS = 250; // UI को कितनी देर में प्रगति भेजें

const encoder = new TextEncoder();

function headerPrefix(block) {
  return block.index + "|" + block.prevHash + "|" + block.timestamp + "|" + block.data + "|";
}

function toHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

// हैश के शुरुआती `difficulty` hex अंक ज़ीरो हैं या नहीं
function meetsDifficulty(bytes, difficulty) {
  const fullBytes = difficulty >> 1;
  for (let i = 0; i < fullBytes; i++) if (bytes[i] !== 0) return false;
  if (difficulty & 1) return (bytes[fullBytes] >> 4) === 0;
  return true;
}

async function mine(cfg) {
  const difficulty = cfg.difficulty;
  let index = cfg.index;
  let prevHash = cfg.prevHash;

  let reportedTries = 0;   // पिछली रिपोर्ट के बाद के प्रयास
  let lastReport = performance.now();

  for (;;) {
    const block = { index, prevHash, timestamp: Date.now(), data: cfg.data };
    const prefix = headerPrefix(block);
    const started = performance.now();
    let nonce = 0;
    let blockTries = 0;
    let found = null;

    while (!found) {
      const jobs = new Array(BATCH);
      for (let i = 0; i < BATCH; i++) {
        jobs[i] = crypto.subtle.digest("SHA-256", encoder.encode(prefix + (nonce + i)));
      }
      const results = await Promise.all(jobs);

      let used = BATCH;
      for (let i = 0; i < BATCH; i++) {
        const bytes = new Uint8Array(results[i]);
        if (meetsDifficulty(bytes, difficulty)) {
          found = { nonce: nonce + i, hash: toHex(bytes) };
          used = i + 1;
          break;
        }
      }
      nonce += BATCH;
      blockTries += used;
      reportedTries += used;

      const now = performance.now();
      if (found || now - lastReport >= REPORT_EVERY_MS) {
        postMessage({ type: "progress", tries: reportedTries, ms: now - lastReport });
        reportedTries = 0;
        lastReport = now;
      }
    }

    postMessage({
      type: "block",
      block: {
        index: block.index,
        prevHash: block.prevHash,
        timestamp: block.timestamp,
        data: block.data,
        nonce: found.nonce,
        hash: found.hash,
        difficulty,
        tries: blockTries,
        ms: Math.round(performance.now() - started),
      },
    });

    index += 1;
    prevHash = found.hash;
  }
}

onmessage = (e) => {
  if (e.data && e.data.type === "start") {
    mine(e.data).catch((err) => postMessage({ type: "error", message: String(err && err.message || err) }));
  }
};
