// MNC टेस्टनेट माइनर — मुख्य UI लॉजिक
// माइनिंग सिर्फ़ यूज़र के "माइनिंग शुरू करें" दबाने पर शुरू होती है।
//
// नियम: एक माइनर को 10 मिनट में एक ही ब्लॉक (50 MNC) मिलता है। इसलिए माइनर
// एक ब्लॉक ढूँढते ही उसे अपने आप सर्वर को भेजता है, 10 मिनट रुकता है और फिर
// अपने आप अगला ब्लॉक ढूँढता है, जब तक यूज़र "रोकें" न दबाए।
//
// नेटवर्क कॉल सिर्फ़ Supabase पर हैं:
//   1. शुरू करते समय चेन का आख़िरी ब्लॉक और इस माइनर का पिछला इनाम पढ़ना (GET blocks)
//   2. मिला हुआ ब्लॉक submit-block function को भेजना (POST)
// मिले ब्लॉक localStorage में भी रहते हैं। hash की गणना worker.js में होती है।

"use strict";

(function () {
  const CONFIG = Object.assign(
    {
      difficulty: 5, minDifficulty: 5, maxDifficulty: 7,
      supabaseUrl: "", supabaseKey: "", reward: 50, cooldownMinutes: 10,
    },
    window.MNC_CONFIG || {}
  );

  const STORAGE_KEY = "mnc_testnet_blocks";
  const GENESIS_PREV = "0".repeat(64);
  const RATE_WINDOW_MS = 2000;
  const COOLDOWN_MS = CONFIG.cooldownMinutes * 60 * 1000;
  const RETRY_MS = 30 * 1000;   // नेटवर्क की गड़बड़ी पर इतनी देर बाद दोबारा कोशिश
  const MAX_FAIL_STREAK = 10;   // लगातार इतनी नाकामी पर माइनर रुक जाता है
  const API = String(CONFIG.supabaseUrl || "").replace(/\/+$/, "");
  const API_HEADERS = { apikey: CONFIG.supabaseKey, Authorization: "Bearer " + CONFIG.supabaseKey };

  // सर्वर के ये जवाब ब्लॉक की ग़लती नहीं हैं; ब्लॉक "भेजा नहीं गया" ही रहता है
  const NOT_BLOCK_FAULT = ["server_error", "server_config", "too_early", "bad_miner", "cooldown", "method", "bad_json", "too_large"];
  // इन कारणों पर नई चेन के ऊपर दोबारा माइन करना ठीक है
  const LOST_RACE = ["stale", "bad_prev_hash"];

  const $ = (id) => document.getElementById(id);
  const el = {
    start: $("btn-start"),
    stop: $("btn-stop"),
    clear: $("btn-clear"),
    send: $("btn-send"),
    sendResult: $("send-result"),
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

  // इनाम किस पते पर दर्ज हो: वॉलेट का पता (wallet.html पर बना, localStorage में); वॉलेट न हो तो ""
  function minerAddress() {
    try {
      const w = JSON.parse(localStorage.getItem("mnc_wallet") || "null");
      return w && /^MNC[0-9a-f]{40}$/.test(w.address) ? w.address : "";
    } catch (_) {
      return "";
    }
  }

  let worker = null;
  let starting = false;
  let sending = false;
  let active = false;   // यूज़र ने माइनर चालू किया है और रोका नहीं
  let nextAt = 0;       // अगला चक्र कब शुरू होगा (ms); 0 = कोई इंतज़ार नहीं
  let waitNote = "";
  let failStreak = 0;
  let wakeLock = null;
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
  async function readBlocks(query) {
    if (!API || !CONFIG.supabaseKey) throw new Error("config");
    const res = await fetch(API + "/rest/v1/blocks?" + query, { headers: API_HEADERS, cache: "no-store" });
    if (!res.ok) throw new Error("http " + res.status);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error("format");
    return rows;
  }

  // चेन का आख़िरी ब्लॉक; चेन खाली हो तो null
  async function fetchTip() {
    const rows = await readBlocks("select=*&order=idx.desc&limit=1");
    return rows.length ? { index: Number(rows[0].idx), hash: String(rows[0].hash) } : null;
  }

  // इस माइनर को पिछला इनाम कब मिला (ms); कभी नहीं मिला तो null
  async function fetchLastRewardTime(miner) {
    const rows = await readBlocks(
      "select=created_at&miner=eq." + encodeURIComponent(miner) + "&order=idx.desc&limit=1"
    );
    const t = rows.length ? Date.parse(rows[0].created_at) : NaN;
    return Number.isFinite(t) ? t : null;
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
        miner: b.data, // ब्लॉक उसी पते का है जिसके लिए वह माइन हुआ था
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
      if (b.data !== minerAddress()) {
        // पुराने संस्करण का, या किसी दूसरे वॉलेट के लिए बना ब्लॉक
        markRejected(b, "यह ब्लॉक इस वॉलेट के पते के लिए नहीं बना था।");
      } else if (tip && b.index === tip.index && b.hash === tip.hash) {
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
    return { chain, tip: tip || { index: -1, hash: GENESIS_PREV } };
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

  const clock = (t) => new Date(t).toLocaleTimeString("hi-IN", { hour: "2-digit", minute: "2-digit" });

  function waitText(ms) {
    const s = Math.ceil(ms / 1000);
    return Math.floor(s / 60) + " मिनट " + (s % 60) + " सेकंड";
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

  // स्थिति की पंक्ति और बटन; सब कुछ ऊपर के स्थिति-चरों से निकलता है
  function renderState() {
    el.start.disabled = active;
    el.stop.disabled = !active;
    el.difficulty.disabled = active;

    let text = "रुका हुआ";
    if (worker) text = "माइनिंग चल रही है…";
    else if (starting) text = "सर्वर से आख़िरी ब्लॉक लिया जा रहा है…";
    else if (sending) text = "ब्लॉक सर्वर को भेजा जा रहा है…";
    else if (active && nextAt) {
      const s = Math.max(0, Math.ceil((nextAt - Date.now()) / 1000));
      text = waitNote + " " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") +
        " में माइनिंग अपने आप शुरू होगी।";
    }
    el.status.textContent = text;
    el.status.classList.toggle("on", active);
    renderSend();
  }

  // ---------- स्क्रीन चालू रखना ----------
  // फ़ोन की स्क्रीन बंद होते ही ब्राउज़र माइनिंग और टाइमर रोक देता है, इसलिए
  // माइनर चालू रहने तक स्क्रीन को जगाए रखते हैं (जहाँ ब्राउज़र यह सुविधा देता है)।
  async function holdScreen() {
    try {
      if (!("wakeLock" in navigator) || wakeLock) return;
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } catch (_) { /* सुविधा न मिले तो भी माइनर चलता रहे */ }
  }

  function releaseScreen() {
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  // ---------- माइनिंग का चक्र ----------
  // "माइनिंग शुरू करें" एक बार दबाने पर माइनर तब तक चालू रहता है जब तक "रोकें" न दबे:
  //   ब्लॉक ढूँढो -> भेजो -> 10 मिनट इंतज़ार -> फिर ढूँढो ...
  function start() {
    if (active) return;
    showError("");

    if (!window.Worker || !window.crypto || !window.crypto.subtle) {
      showError(
        "यह ब्राउज़र Web Worker या crypto.subtle नहीं दे रहा। पेज को http://localhost या https पर खोलें (file:// से नहीं)।"
      );
      return;
    }
    if (!minerAddress()) {
      showError("पहले ऊपर “वॉलेट” खोलकर वॉलेट बनाएँ या वापस लाएँ; इनाम उसी के पते पर दर्ज होगा।");
      return;
    }

    el.difficulty.value = clampDifficulty(el.difficulty.value);
    active = true;
    failStreak = 0;
    showSendResult("", "");
    holdScreen();
    cycle();
  }

  function stopWorker() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    samples = [];
    renderRate();
  }

  function stop() {
    active = false;
    nextAt = 0;
    stopWorker();
    releaseScreen();
    renderState();
  }

  // ms बाद अगला चक्र; note स्थिति की पंक्ति में दिखता है
  function schedule(ms, note) {
    nextAt = Date.now() + Math.max(1000, ms);
    waitNote = note;
    renderState();
  }

  // लगातार बहुत बार नाकामी हो तो सर्वर पर बेकार बोझ न डालें
  function failed(message) {
    failStreak++;
    if (failStreak >= MAX_FAIL_STREAK) {
      stop();
      showError(message + " लगातार " + MAX_FAIL_STREAK + " बार नाकामी के बाद माइनर रोक दिया गया।");
      return true;
    }
    return false;
  }

  // एक चक्र: सर्वर की स्थिति देखो, फिर या तो इंतज़ार, या भेजना, या माइनिंग
  async function cycle() {
    if (!active || worker || starting || sending) return;
    nextAt = 0;
    showError("");
    const miner = minerAddress();

    starting = true;
    renderState();
    let state, lastReward;
    try {
      const got = await Promise.all([fetchTip(), fetchLastRewardTime(miner)]);
      state = reconcile(got[0]);
      lastReward = got[1];
    } catch (_) {
      starting = false;
      if (!active) return renderState();
      showError("सर्वर से चेन की जानकारी नहीं मिली। इंटरनेट जाँचें; माइनर अपने आप दोबारा कोशिश करेगा।");
      schedule(RETRY_MS, "दोबारा कोशिश:");
      return;
    }
    starting = false;
    saveBlocks();
    renderBlocks();
    if (!active) return renderState();

    // 10 मिनट का अंतराल अभी बाक़ी है: इंतज़ार
    const wait = lastReward === null ? 0 : lastReward + COOLDOWN_MS - Date.now();
    if (wait > 0) {
      schedule(wait, "पिछला इनाम " + clock(lastReward) + " पर मिला था।");
      return;
    }

    // पहले से कोई भेजने लायक ब्लॉक पड़ा हो तो नया माइन करने की जगह वही भेजें
    if (state.chain.length) {
      sendPending();
      return;
    }

    try {
      worker = new Worker("worker.js");
    } catch (_) {
      stop();
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
      difficulty: clampDifficulty(el.difficulty.value),
      index: state.tip.index + 1,
      prevHash: state.tip.hash,
      // data में वॉलेट का पता जाता है, इसलिए पता ब्लॉक के hash में बँध जाता है:
      // कोई और इस ब्लॉक को अपने पते से नहीं भेज सकता (सर्वर data === miner जाँचता है)।
      data: miner,
    });

    samples = [];
    renderState();
  }

  function onWorkerMessage(e) {
    const msg = e.data;
    if (msg.type === "progress") {
      totalTries += msg.tries;
      samples.push({ t: performance.now(), tries: msg.tries, ms: msg.ms });
      renderStats();
      renderRate();
    } else if (msg.type === "block") {
      // 10 मिनट में एक ही ब्लॉक मिल सकता है: खोज रोकें और इसे तुरंत भेजें
      stopWorker();
      msg.block.status = "pending";
      blocks.push(msg.block);
      saveBlocks();
      renderStats();
      renderBlocks();
      sendPending();
    } else if (msg.type === "error") {
      stop();
      showError("माइनिंग रुकी: " + msg.message);
    }
  }

  // ---------- भेजना ----------
  // सबसे पुराना भेजने लायक ब्लॉक भेजता है (10 मिनट में एक ही स्वीकार होता है)।
  // माइनर चालू (active) हो तो नतीजे के हिसाब से अगला चक्र अपने आप तय होता है।
  async function sendPending() {
    if (sending) return;
    const miner = minerAddress();
    if (!miner) {
      showSendResult("पहले ऊपर “वॉलेट” खोलकर वॉलेट बनाएँ या वापस लाएँ।", "bad");
      return;
    }

    sending = true;
    renderState();

    let outcome = "error";   // "accepted" | "cooldown" | "lost" | "rejected" | "error"
    let message = "";
    let retryMs = RETRY_MS;

    try {
      const chain = reconcile(await fetchTip()).chain;
      if (!chain.length) {
        outcome = "lost";
        message = "चेन आगे बढ़ चुकी है; भेजने लायक ब्लॉक नहीं बचा।";
      } else {
        const b = chain[0];
        const result = await submitBlock(b, miner);
        if (result.ok) {
          outcome = "accepted";
          b.status = "accepted";
          delete b.reason;
          message = "सफल: ब्लॉक #" + b.index + " स्वीकार हुआ, " + CONFIG.reward + " MNC मिले।";
          renderWalletBar();
          // इसके ऊपर बने बाक़ी ब्लॉक अंतराल की वजह से नहीं जा सकते
          for (const later of chain.slice(1)) markRejected(later, "10 मिनट में एक ही ब्लॉक स्वीकार होता है।");
        } else if (result.code === "cooldown") {
          outcome = "cooldown";
          message = result.reason || "अभी 10 मिनट पूरे नहीं हुए।";
          if (Number(result.retry_after_s) > 0) retryMs = Number(result.retry_after_s) * 1000;
        } else if (NOT_BLOCK_FAULT.includes(result.code)) {
          message = result.reason || "सर्वर ने ब्लॉक नहीं लिया।";
        } else {
          const reason = result.reason || "सर्वर ने कारण नहीं बताया।";
          markRejected(b, reason);
          for (const later of chain.slice(1)) markRejected(later, "इससे पहले वाला ब्लॉक ठुकरा दिया गया।");
          outcome = LOST_RACE.includes(result.code) ? "lost" : "rejected";
          message = LOST_RACE.includes(result.code)
            ? "किसी और का ब्लॉक पहले पहुँच गया।"
            : "ब्लॉक ठुकराया गया: " + reason;
        }
      }
    } catch (_) {
      message = "सर्वर से संपर्क नहीं हो सका।";
    }

    sending = false;
    saveBlocks();
    renderBlocks();

    if (!active) {
      // माइनर बंद है: सिर्फ़ नतीजा दिखाएँ
      const hint = outcome === "error" ? " इंटरनेट जाँचकर “भेजें” दबाएँ।"
        : outcome === "lost" || outcome === "rejected" ? " दोबारा “माइनिंग शुरू करें” दबाएँ।" : "";
      showSendResult(message + hint, outcome === "accepted" ? "ok" : "bad");
      renderState();
      return;
    }

    if (outcome === "accepted") {
      failStreak = 0;
      showSendResult(message + " अगली माइनिंग " + clock(Date.now() + COOLDOWN_MS) + " पर अपने आप शुरू होगी।", "ok");
      schedule(COOLDOWN_MS, "इनाम मिल गया।");
    } else if (outcome === "cooldown") {
      showSendResult(message, "bad");
      schedule(retryMs, "अंतराल बाक़ी है।");
    } else if (outcome === "lost") {
      if (failed(message)) return;
      showSendResult(message + " नई चेन पर दोबारा माइनिंग हो रही है।", "bad");
      renderState();
      cycle();
    } else if (outcome === "rejected") {
      if (failed(message)) return;
      showSendResult(message + " दोबारा माइनिंग हो रही है।", "bad");
      renderState();
      cycle();
    } else {
      showSendResult(message + " माइनर अपने आप दोबारा कोशिश करेगा।", "bad");
      schedule(RETRY_MS, "दोबारा कोशिश:");
    }
  }

  // ---------- वॉलेट की पट्टी ----------
  // छोटा पता और बैलेंस; पूरा वॉलेट wallet.html पर खुलता है
  async function renderWalletBar() {
    const title = $("wallet-bar-title"), sub = $("wallet-bar-sub");
    const address = minerAddress();
    if (!address) {
      title.textContent = "वॉलेट बनाएँ";
      sub.textContent = "माइनिंग का इनाम वॉलेट के पते पर दर्ज होता है";
      return;
    }
    sub.textContent = address.slice(0, 8) + "…" + address.slice(-5);
    try {
      const res = await fetch(API + "/rest/v1/rpc/mnc_balance", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, API_HEADERS),
        body: JSON.stringify({ addr: address }),
        cache: "no-store",
      });
      if (!res.ok) throw new Error("http " + res.status);
      title.textContent = fmt.format(Number(await res.json()) || 0) + " MNC";
    } catch (_) {
      title.textContent = "वॉलेट"; // बैलेंस न मिले तो भी पट्टी काम की रहे
    }
  }

  // हर सेकंड: इंतज़ार की उलटी गिनती, और समय पूरा होते ही अगला चक्र।
  // समय घड़ी से गिना जाता है, ताकि ब्राउज़र टाइमर धीमा कर दे तब भी देर न हो।
  function tick() {
    if (!active || !nextAt || worker || starting || sending) return;
    if (Date.now() >= nextAt) cycle();
    else renderState();
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

  setInterval(tick, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && active) {
      holdScreen(); // स्क्रीन-लॉक ऐप के पीछे जाने पर छूट जाता है
      tick();
    }
  });

  renderState();
  renderStats();
  renderBlocks();
  renderWalletBar();
})();
