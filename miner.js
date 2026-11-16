// MNC टेस्टनेट माइनर — मुख्य UI लॉजिक
// माइनिंग सिर्फ़ यूज़र के "माइनिंग शुरू करें" दबाने पर शुरू होती है।
// नेटवर्क कॉल सिर्फ़ दो हैं, दोनों Supabase पर:
//   1. शुरू करते समय चेन का आख़िरी ब्लॉक पढ़ना (GET blocks)
//   2. "भेजें" दबाने पर मिले ब्लॉक submit-block function को भेजना (POST)
// मिले ब्लॉक localStorage में भी रहते हैं। hash की गणना worker.js में होती है।

"use strict";

(function () {
  const CONFIG = Object.assign(
    {
      difficulty: 6, minDifficulty: 6, maxDifficulty: 7, blockData: "MNC testnet",
      supabaseUrl: "", supabaseKey: "", reward: 50,
    },
    window.MNC_CONFIG || {}
  );

  const STORAGE_KEY = "mnc_testnet_blocks";
  const NAME_KEY = "mnc_miner_name";
  const GENESIS_PREV = "0".repeat(64);
  const RATE_WINDOW_MS = 2000;
  const API = String(CONFIG.supabaseUrl || "").replace(/\/+$/, "");
  const API_HEADERS = { apikey: CONFIG.supabaseKey, Authorization: "Bearer " + CONFIG.supabaseKey };

  // सर्वर के ये जवाब ब्लॉक की ग़लती नहीं हैं; ब्लॉक "भेजा नहीं गया" ही रहता है
  const NOT_BLOCK_FAULT = ["server_error", "server_config", "too_early", "bad_miner", "method", "bad_json", "too_large"];

  const $ = (id) => document.getElementById(id);
  const el = {
    start: $("btn-start"),
    stop: $("btn-stop"),
    clear: $("btn-clear"),
    send: $("btn-send"),
    sendResult: $("send-result"),
    minerName: $("miner-name"),
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
  let starting = false;
  let sending = false;
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

  // ब्लॉक की स्थिति: "pending" (भेजा नहीं गया), "accepted", "rejected"
  const isPending = (b) => b.status !== "accepted" && b.status !== "rejected";

  function markRejected(b, reason) {
    b.status = "rejected";
    b.reason = reason;
  }

  // ---------- Supabase ----------
  // चेन का आख़िरी ब्लॉक; चेन खाली हो तो null
  async function fetchTip() {
    if (!API || !CONFIG.supabaseKey) throw new Error("config");
    const res = await fetch(API + "/rest/v1/blocks?select=*&order=idx.desc&limit=1", {
      headers: API_HEADERS,
      cache: "no-store",
    });
    if (!res.ok) throw new Error("http " + res.status);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error("format");
    return rows.length ? { index: Number(rows[0].idx), hash: String(rows[0].hash) } : null;
  }

  async function submitBlock(b, miner) {
    const res = await fetch(API + "/functions/v1/submit-block", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, API_HEADERS),
      body: JSON.stringify({
        idx: b.index,
        prev_hash: b.prevHash,
        hash: b.hash,
        nonce: b.nonce,
        difficulty: b.difficulty,
        ts: b.timestamp,
        data: b.data,
        miner: miner,
        reward: CONFIG.reward,
      }),
    });
    const body = await res.json(); // JSON न हो तो यहीं error, यानी सर्वर की गड़बड़ी
    if (!body || typeof body.ok !== "boolean") throw new Error("format");
    return body;
  }

  // सर्वर की चेन के हिसाब से लोकल ब्लॉक छाँटना।
  // लौटाता है: वे "भेजे नहीं गए" ब्लॉक जो आख़िरी ब्लॉक के ऊपर सही क्रम में जुड़ते हैं।
  function reconcile(tip) {
    let base = tip || { index: -1, hash: GENESIS_PREV };
    const chain = [];
    for (const b of blocks) {
      if (!isPending(b)) continue;
      if (tip && b.index === tip.index && b.hash === tip.hash) {
        b.status = "accepted"; // यही ब्लॉक सर्वर पर आख़िरी है
        delete b.reason;
      } else if (b.index === base.index + 1 && b.prevHash === base.hash) {
        chain.push(b);
        base = b;
      } else if (b.index <= base.index) {
        markRejected(b, "चेन इस नंबर से आगे बढ़ चुकी है।");
      } else {
        markRejected(b, "यह चेन के आख़िरी ब्लॉक से नहीं जुड़ता।");
      }
    }
    return { chain, base };
  }

  // ---------- UI ----------
  function showError(msg) {
    el.error.textContent = msg;
    el.error.hidden = !msg;
  }

  function showSendResult(msg, kind) {
    el.sendResult.textContent = msg;
    el.sendResult.className = "send-result" + (kind ? " " + kind : "");
    el.sendResult.hidden = !msg;
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

    const state = document.createElement("div");
    if (b.status === "accepted") {
      state.className = "block-state ok";
      state.textContent = "✓ सर्वर ने स्वीकार किया";
    } else if (b.status === "rejected") {
      state.className = "block-state bad";
      state.textContent = "✗ पुराना या गलत" + (b.reason ? " — " + b.reason : "");
    } else {
      state.className = "block-state";
      state.textContent = "भेजा नहीं गया";
    }

    li.append(head, hash, meta, state);
    return li;
  }

  function renderBlocks() {
    el.list.replaceChildren(...blocks.slice().reverse().map(blockItem));
    el.empty.hidden = blocks.length > 0;
    el.clear.hidden = blocks.length === 0;
    renderSend();
  }

  function renderSend() {
    const pending = blocks.filter(isPending).length;
    el.send.textContent = sending ? "भेजा जा रहा है…" : pending ? "भेजें (" + fmt.format(pending) + ")" : "भेजें";
    el.send.disabled = sending || pending === 0;
  }

  function setRunning(running) {
    el.start.disabled = running || starting;
    el.stop.disabled = !running;
    el.difficulty.disabled = running || starting;
    el.status.textContent = running
      ? "माइनिंग चल रही है…"
      : starting ? "सर्वर से आख़िरी ब्लॉक लिया जा रहा है…" : "रुका हुआ";
    el.status.classList.toggle("on", running);
  }

  // ---------- माइनिंग ----------
  async function start() {
    if (worker || starting) return;
    showError("");

    if (!window.Worker || !window.crypto || !window.crypto.subtle) {
      showError(
        "यह ब्राउज़र Web Worker या crypto.subtle नहीं दे रहा। पेज को http://localhost या https पर खोलें (file:// से नहीं)।"
      );
      return;
    }

    const difficulty = clampDifficulty(el.difficulty.value);
    el.difficulty.value = difficulty;

    // पहले सर्वर से चेन का आख़िरी ब्लॉक; उसी के ऊपर माइनिंग होगी
    starting = true;
    setRunning(false);
    let base;
    try {
      base = reconcile(await fetchTip()).base;
    } catch (_) {
      starting = false;
      setRunning(false);
      showError("सर्वर से चेन का आख़िरी ब्लॉक नहीं मिला, इसलिए माइनिंग शुरू नहीं हुई। इंटरनेट जाँचकर दोबारा कोशिश करें।");
      return;
    }
    starting = false;
    saveBlocks();
    renderBlocks();

    try {
      worker = new Worker("worker.js");
    } catch (_) {
      setRunning(false);
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
      index: base.index + 1,
      prevHash: base.hash,
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
      msg.block.status = "pending";
      blocks.push(msg.block);
      saveBlocks();
      renderStats();
      renderBlocks();
    } else if (msg.type === "error") {
      stop();
      showError("माइनिंग रुकी: " + msg.message);
    }
  }

  // ---------- भेजना ----------
  // भेजे नहीं गए ब्लॉक सबसे पुराने से शुरू करके क्रम में भेजता है।
  async function sendPending() {
    if (sending) return;
    const miner = el.minerName.value.trim();
    if (!miner) {
      showSendResult("पहले ऊपर माइनर का नाम लिखें।", "bad");
      el.minerName.focus();
      return;
    }

    sending = true;
    renderSend();
    showSendResult("", "");

    const rejectedBefore = blocks.filter((b) => b.status === "rejected").length;
    let accepted = 0;
    let rejectedReason = "";
    let problem = "";

    try {
      const chain = reconcile(await fetchTip()).chain;
      for (let i = 0; i < chain.length; i++) {
        const b = chain[i];
        const result = await submitBlock(b, miner);
        if (result.ok) {
          b.status = "accepted";
          delete b.reason;
          accepted++;
        } else if (NOT_BLOCK_FAULT.includes(result.code)) {
          problem = result.reason || "सर्वर ने ब्लॉक नहीं लिया।";
          break;
        } else {
          rejectedReason = result.reason || "सर्वर ने कारण नहीं बताया।";
          markRejected(b, rejectedReason);
          // इसके ऊपर बने बाक़ी ब्लॉक भी अब बेकार हैं
          for (const later of chain.slice(i + 1)) markRejected(later, "इससे पहले वाला ब्लॉक ठुकरा दिया गया।");
          break;
        }
        saveBlocks();
        renderBlocks();
      }
    } catch (_) {
      problem = "सर्वर से संपर्क नहीं हो सका। इंटरनेट जाँचकर दोबारा “भेजें” दबाएँ।";
    }

    sending = false;
    saveBlocks();
    renderBlocks();

    // इस बार कोई ब्लॉक पुराना/गलत निकला हो तो उसके ऊपर माइनिंग जारी रखना बेकार है
    const newlyRejected = blocks.filter((b) => b.status === "rejected").length > rejectedBefore;
    if (newlyRejected && worker) stop();

    const done = accepted ? fmt.format(accepted) + " ब्लॉक स्वीकार हुए। " : "";
    if (!rejectedReason && !problem && newlyRejected && accepted) {
      showSendResult(done + "कुछ ब्लॉक पुराने या गलत निकले। नई चेन पर माइनिंग के लिए दोबारा “माइनिंग शुरू करें” दबाएँ।", "ok");
    } else if (rejectedReason) {
      showSendResult(done + "ब्लॉक ठुकराया गया: " + rejectedReason + " नई चेन पर माइनिंग के लिए दोबारा “माइनिंग शुरू करें” दबाएँ।", "bad");
    } else if (problem) {
      showSendResult(done + problem, "bad");
    } else if (accepted) {
      showSendResult("सफल: " + done.trim(), "ok");
    } else {
      showSendResult("भेजने लायक कोई ब्लॉक नहीं था; बचे हुए ब्लॉक पुराने या गलत निकले।", "bad");
    }
  }

  // ---------- शुरुआत ----------
  el.difficulty.min = CONFIG.minDifficulty;
  el.difficulty.max = CONFIG.maxDifficulty;
  el.difficulty.value = clampDifficulty(CONFIG.difficulty);
  el.difficulty.addEventListener("change", () => {
    el.difficulty.value = clampDifficulty(el.difficulty.value);
  });

  try { el.minerName.value = localStorage.getItem(NAME_KEY) || ""; } catch (_) {}
  el.minerName.addEventListener("change", () => {
    try { localStorage.setItem(NAME_KEY, el.minerName.value.trim()); } catch (_) {}
  });

  el.start.addEventListener("click", start);
  el.stop.addEventListener("click", stop);
  el.send.addEventListener("click", sendPending);
  el.clear.addEventListener("click", () => {
    if (!confirm("सेव किए गए सभी टेस्ट ब्लॉक मिटा दें?")) return;
    stop();
    blocks = [];
    saveBlocks();
    renderStats();
    renderBlocks();
    showSendResult("", "");
  });

  setRunning(false);
  renderStats();
  renderBlocks();
})();
