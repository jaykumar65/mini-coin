// MNC टेस्टनेट माइनर — मुख्य UI लॉजिक
// माइनिंग सिर्फ़ यूज़र के "माइनिंग शुरू करें" दबाने पर शुरू होती है।
// कोई सर्वर/नेटवर्क कॉल नहीं; मिले ब्लॉक सिर्फ़ localStorage में रहते हैं।

"use strict";

(function () {
  const CONFIG = Object.assign(
    { difficulty: 4, minDifficulty: 1, maxDifficulty: 7, blockData: "MNC testnet" },
    window.MNC_CONFIG || {}
  );

  const STORAGE_KEY = "mnc_testnet_blocks";
  const GENESIS_PREV = "0".repeat(64);
  const RATE_WINDOW_MS = 2000;

  const $ = (id) => document.getElementById(id);
  const el = {
    start: $("btn-start"),
    stop: $("btn-stop"),
    clear: $("btn-clear"),
    difficulty: $("difficulty"),
    status: $("status"),
    tries: $("stat-tries"),
    rate: $("stat-rate"),
    blocks: $("stat-blocks"),
    list: $("block-list"),
    empty: $("block-empty"),
    error: $("error"),
  };

  const fmt = new Intl.NumberFormat("en-IN");

  let worker = null;
  let totalTries = 0;
  let samples = [];   // हैश रेट के लिए हाल की प्रगति: {t, tries}
  let blocks = loadBlocks();

  // ---------- localStorage ----------
  function loadBlocks() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  function saveBlocks() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(blocks));
    } catch (_) {
      showError("ब्लॉक सेव नहीं हो सका (localStorage उपलब्ध नहीं या भरा हुआ है)।");
    }
  }

  // ---------- UI ----------
  function showError(msg) {
    el.error.textContent = msg;
    el.error.hidden = !msg;
  }

  function clampDifficulty(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return CONFIG.difficulty;
    return Math.min(CONFIG.maxDifficulty, Math.max(CONFIG.minDifficulty, n));
  }

  function renderStats() {
    el.tries.textContent = fmt.format(totalTries);
    el.blocks.textContent = fmt.format(blocks.length);
  }

  function renderRate() {
    if (!worker || samples.length === 0) {
      el.rate.textContent = "0";
      return;
    }
    const now = performance.now();
    samples = samples.filter((s) => now - s.t <= RATE_WINDOW_MS);
    const tries = samples.reduce((a, s) => a + s.tries, 0);
    const ms = samples.reduce((a, s) => a + s.ms, 0);
    el.rate.textContent = ms > 0 ? fmt.format(Math.round((tries * 1000) / ms)) : "0";
  }

  function blockItem(b) {
    const li = document.createElement("li");
    li.className = "block";

    const head = document.createElement("div");
    head.className = "block-head";
    const title = document.createElement("strong");
    title.textContent = "ब्लॉक #" + b.index;
    const time = document.createElement("span");
    time.textContent = new Date(b.timestamp).toLocaleString("hi-IN");
    head.append(title, time);

    const hash = document.createElement("code");
    hash.className = "hash";
    const zeros = document.createElement("b");
    zeros.textContent = b.hash.slice(0, b.difficulty);
    hash.append(zeros, b.hash.slice(b.difficulty));

    const meta = document.createElement("div");
    meta.className = "block-meta";
    meta.textContent =
      "nonce " + fmt.format(b.nonce) +
      " · difficulty " + b.difficulty +
      " · " + fmt.format(b.tries) + " प्रयास" +
      " · " + (b.ms / 1000).toFixed(1) + " सेकंड";

    li.append(head, hash, meta);
    return li;
  }

  function renderBlocks() {
    el.list.replaceChildren(...blocks.slice().reverse().map(blockItem));
    el.empty.hidden = blocks.length > 0;
    el.clear.hidden = blocks.length === 0;
  }

  function setRunning(running) {
    el.start.disabled = running;
    el.stop.disabled = !running;
    el.difficulty.disabled = running;
    el.status.textContent = running ? "माइनिंग चल रही है…" : "रुका हुआ";
    el.status.classList.toggle("on", running);
  }

  // ---------- माइनिंग ----------
  function start() {
    if (worker) return;
    showError("");

    if (!window.Worker || !window.crypto || !window.crypto.subtle) {
      showError(
        "यह ब्राउज़र Web Worker या crypto.subtle नहीं दे रहा। पेज को http://localhost या https पर खोलें (file:// से नहीं)।"
      );
      return;
    }

    const difficulty = clampDifficulty(el.difficulty.value);
    el.difficulty.value = difficulty;

    const last = blocks[blocks.length - 1];
    try {
      worker = new Worker("worker.js");
    } catch (_) {
      showError("Worker शुरू नहीं हो सका। पेज को लोकल सर्वर (http://localhost) से खोलें।");
      return;
    }
    worker.onmessage = onWorkerMessage;
    worker.onerror = (e) => {
      stop();
      showError("Worker में गड़बड़ी: " + (e.message || "अज्ञात"));
    };
    worker.postMessage({
      type: "start",
      difficulty,
      index: last ? last.index + 1 : 0,
      prevHash: last ? last.hash : GENESIS_PREV,
      data: CONFIG.blockData,
    });

    samples = [];
    setRunning(true);
  }

  function stop() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    samples = [];
    setRunning(false);
    renderRate();
  }

  function onWorkerMessage(e) {
    const msg = e.data;
    if (msg.type === "progress") {
      totalTries += msg.tries;
      samples.push({ t: performance.now(), tries: msg.tries, ms: msg.ms });
      renderStats();
      renderRate();
    } else if (msg.type === "block") {
      blocks.push(msg.block);
      saveBlocks();
      renderStats();
      renderBlocks();
    } else if (msg.type === "error") {
      stop();
      showError("माइनिंग रुकी: " + msg.message);
    }
  }

  // ---------- शुरुआत ----------
  el.difficulty.min = CONFIG.minDifficulty;
  el.difficulty.max = CONFIG.maxDifficulty;
  el.difficulty.value = clampDifficulty(CONFIG.difficulty);
  el.difficulty.addEventListener("change", () => {
    el.difficulty.value = clampDifficulty(el.difficulty.value);
  });

  el.start.addEventListener("click", start);
  el.stop.addEventListener("click", stop);
  el.clear.addEventListener("click", () => {
    if (!confirm("सेव किए गए सभी टेस्ट ब्लॉक मिटा दें?")) return;
    stop();
    blocks = [];
    saveBlocks();
    renderStats();
    renderBlocks();
  });

  setRunning(false);
  renderStats();
  renderBlocks();
})();
