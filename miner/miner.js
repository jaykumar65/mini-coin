// MNC टेस्टनेट माइनर — मुख्य UI लॉजिक
//
// माइनिंग का नियम (supabase/sql/003_rounds.sql):
//   - घड़ी 3 मिनट के राउंड में बँटी है, और हर राउंड 30-30 सेकंड के खानों में।
//   - माइनर चालू हो तो वह हर खाने में एक "मैं हूँ" संकेत भेजता है।
//   - जो सक्रिय वॉलेट राउंड के सभी खानों में मौजूद रहा, उसे हिस्सा मिलता है; राउंड का इनाम
//     (50 MNC) सभी हिस्सेदारों में बराबर बँटता है। फ़ोन हो या लैपटॉप, सबका हिस्सा बराबर।
//   - संख्याएँ config/chain.json से आती हैं; समय हमेशा सर्वर का गिना जाता है।
//
// चालू करना: "माइनिंग शुरू करें" पर PIN से हस्ताक्षर करके सर्वर से एक सत्र (token) लिया जाता है
// (mining-session function)। फिर हर संकेत डेटाबेस के mnc_ping function को उसी token के साथ जाता है।
// PIN और private key सिर्फ़ इस फ़ोन पर रहते हैं (wallet/vault.js)।
//
// माइनिंग सिर्फ़ यूज़र के बटन दबाने पर चलती है। संकेत एक Web Worker (ping-worker.js) से जाते हैं,
// ताकि पेज छिपने पर भी जितनी देर ब्राउज़र चलने दे, उतनी देर चलते रहें। ब्राउज़र बैकग्राउंड में
// माइनिंग रोक सकता है; इसका पता localStorage के लॉग (LOG_KEY) से चलता है।

"use strict";

(function () {
  const CONFIG = Object.assign({ supabaseUrl: "", supabaseKey: "" }, window.MNC_CONFIG || {});
  const Vault = window.MNCVault;
  const Units = window.MNCUnits;

  const SESSION_KEY = "mnc_mining_session";
  const API = String(CONFIG.supabaseUrl || "").replace(/\/+$/, "");
  const API_HEADERS = { apikey: CONFIG.supabaseKey, Authorization: "Bearer " + CONFIG.supabaseKey };
  const IDLE_REFRESH_MS = 30 * 1000;   // माइनर बंद हो तब राउंड की जानकारी कितनी बार ताज़ा हो
  const STATE_KEY = "mnc_miner_state"; // { running, visible, started_at, changed_at, hidden_at, visible_at }
  const LOG_KEY = "mnc_miner_log";     // [{ type, t, up_s, vis, ... }]  type: start|stop|hidden|visible|hb
  const LOG_MAX = 600;                 // 30 सेकंड पर 600 = लगभग 5 घंटे
  const HEARTBEAT_MS = 30 * 1000;

  const $ = (id) => document.getElementById(id);
  const el = {
    start: $("btn-start"),
    stop: $("btn-stop"),
    pinBox: $("pin-box"),
    pin: $("mine-pin"),
    status: $("status"),
    error: $("error"),
    gate: $("wallet-gate"),
    roundBar: $("round-bar"),
    roundLeft: $("round-left"),
    slots: $("slots"),
    roundNote: $("round-note"),
    lastPeople: $("stat-people"),
    lastShare: $("stat-share"),
    myTotal: $("stat-total"),
    list: $("reward-list"),
    empty: $("reward-empty"),
    bgState: $("bg-state"),
    bgLast: $("bg-last"),
    bgLog: $("bg-log"),
    bgClear: $("btn-bg-clear"),
  };

  let chain = null;             // config/chain.json
  let walletStatus = "loading"; // "none" | "loading" | "active" | "revoked" | "not_found" | "unknown"
  let active = false;           // यूज़र ने माइनर चालू किया है और रोका नहीं
  let starting = false;
  let info = null;              // सर्वर से आख़िरी जानकारी (mnc_ping / mnc_round_info)
  let serverOffset = 0;         // सर्वर का समय - इस फ़ोन का समय (ms)
  let lastPingAt = 0;
  let lastInfoAt = 0;
  let pinging = false;
  let netError = false;
  let wakeLock = null;
  let lastRoundSeen = null;
  let worker = null;            // ping-worker.js; न बन सके तो पेज ख़ुद संकेत भेजता है
  let startedAt = 0;            // माइनिंग कब चालू हुई (ms)
  let lastBeatAt = 0;           // आख़िरी heartbeat (ms)

  // ---------- वॉलेट ----------
  // सिर्फ़ सार्वजनिक पता पढ़ा जाता है (wallet/ ऐप का localStorage)
  function minerAddress() {
    const pub = Vault.readPublic(localStorage);
    return pub ? pub.address : "";
  }

  const GATE_TEXT = {
    none: "पहले माइनर वॉलेट बनाएँ। ऊपर “वॉलेट” दबाएँ; माइनिंग उसके बाद चालू होगी।",
    loading: "वॉलेट की स्थिति जाँची जा रही है…",
    revoked: "यह वॉलेट रद्द कर दिया गया है, इसलिए इससे माइनिंग नहीं हो सकती।",
    not_found: "यह वॉलेट अभी सक्रिय नहीं है। ऊपर “वॉलेट” खोलें; वह वहाँ अपने आप सक्रिय हो जाएगा।",
    unknown: "वॉलेट की स्थिति नहीं मिल सकी। इंटरनेट जाँचें; पेज पर लौटते ही दोबारा जाँच होगी।",
  };

  async function checkWallet() {
    const address = minerAddress();
    if (!address) {
      walletStatus = "none";
      render();
      return;
    }
    if (walletStatus !== "active") walletStatus = "loading";
    render();
    let next = "unknown";
    try {
      const res = await fetch(API + "/functions/v1/wallet-status?address=" + encodeURIComponent(address), {
        headers: API_HEADERS, cache: "no-store",
      });
      const body = await res.json();
      if (body && body.ok && ["active", "revoked", "not_found"].includes(body.status)) next = body.status;
    } catch (_) { /* इंटरनेट नहीं: "unknown" */ }
    if (minerAddress() !== address) return checkWallet(); // बीच में वॉलेट बदल गया
    walletStatus = next;
    if (next !== "active" && active) stop();
    render();
  }

  // ---------- सत्र (token) ----------
  function readSession() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      // ख़त्म होने से 10 मिनट पहले ही नया सत्र लें
      if (s && s.address === minerAddress() && /^[0-9a-f]{64}$/.test(s.token) && s.expires > Date.now() + 10 * 60 * 1000) return s;
    } catch (_) { /* नीचे */ }
    return null;
  }

  function dropSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (_) { /* कुछ नहीं */ }
  }

  async function newSession(pin) {
    const address = minerAddress();
    const message = Vault.mineMessage(address, Date.now());
    const signature = await Vault.sign(localStorage, pin, message); // PIN गलत हो तो code वाला Error
    const res = await fetch(API + "/functions/v1/mining-session", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, API_HEADERS),
      body: JSON.stringify({ address, message, signature }),
    });
    const body = await res.json();
    if (!body || !body.ok) {
      const err = new Error((body && body.reason) || "सर्वर ने सत्र नहीं दिया।");
      err.server = body && body.code;
      throw err;
    }
    const session = { address, token: body.token, expires: body.expires_at_ms };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session;
  }

  // ---------- डेटाबेस के function ----------
  async function rpc(name, args) {
    const res = await fetch(API + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, API_HEADERS),
      body: JSON.stringify(args),
      cache: "no-store",
    });
    if (!res.ok) throw new Error("http " + res.status);
    return res.json();
  }

  function takeInfo(data) {
    if (!data || !data.ok) return;
    info = data;
    serverOffset = Number(data.server_ms) - Date.now();
    lastInfoAt = Date.now();
    const round = data.last_round ? data.last_round.round_no : null;
    if (round !== lastRoundSeen) {
      if (lastRoundSeen !== null) { renderWalletBar(); loadRewards(); } // नया राउंड बँटा
      lastRoundSeen = round;
    }
  }

  async function refreshInfo() {
    try {
      takeInfo(await rpc("mnc_round_info", { p_address: minerAddress() || null }));
      netError = false;
    } catch (_) {
      netError = true;
    }
    render();
  }

  // संकेत का नतीजा, जब वह Worker से आए
  function handlePing(ok, data) {
    lastPingAt = Date.now();
    if (!active) return;
    if (!ok) {
      netError = true; // अगला संकेत अपने आप जाएगा
      render();
      return;
    }
    netError = false;
    if (data && data.ok) {
      takeInfo(data);
      showError("");
    } else if (data && data.code === "bad_session") {
      dropSession();
      stop();
      showError("माइनिंग का सत्र मान्य नहीं रहा। PIN डालकर दोबारा “माइनिंग शुरू करें” दबाएँ।");
    } else if (data && data.code === "wallet_inactive") {
      stop();
      checkWallet();
    } else {
      showError("सर्वर अभी तैयार नहीं है। थोड़ी देर बाद दोबारा कोशिश करें।");
    }
    render();
  }

  // सत्र अब भी चालू है? नहीं तो माइनिंग रोकें
  function sessionOrStop() {
    const session = readSession();
    if (!session) {
      stop();
      showError("माइनिंग का सत्र ख़त्म हो गया। PIN डालकर दोबारा “माइनिंग शुरू करें” दबाएँ।");
    }
    return session;
  }

  // एक संकेत: "मैं इस खाने में मौजूद हूँ" (Worker न हो तब पेज से)
  async function ping() {
    if (!active) return;
    if (worker) { worker.postMessage({ type: "ping-now" }); return; }
    if (pinging) return;
    const session = sessionOrStop();
    if (!session) return;
    pinging = true;
    lastPingAt = Date.now();
    try {
      const data = await rpc("mnc_ping", { p_address: session.address, p_token: session.token });
      netError = false;
      if (data && data.ok) {
        takeInfo(data);
        showError("");
      } else if (data && data.code === "bad_session") {
        dropSession();
        stop();
        showError("माइनिंग का सत्र मान्य नहीं रहा। PIN डालकर दोबारा “माइनिंग शुरू करें” दबाएँ।");
      } else if (data && data.code === "wallet_inactive") {
        stop();
        checkWallet();
      } else {
        showError("सर्वर अभी तैयार नहीं है। थोड़ी देर बाद दोबारा कोशिश करें।");
      }
    } catch (_) {
      netError = true; // अगला संकेत अपने आप जाएगा
    }
    pinging = false;
    render();
  }

  // ---------- शुरू / रोकें ----------
  async function start() {
    if (active || starting || walletStatus !== "active") return;
    showError("");
    let session = readSession();
    if (!session) {
      const pin = el.pin.value;
      if (!/^\d{6}$/.test(pin)) {
        el.pinBox.hidden = false;
        el.pin.focus();
        showError("माइनिंग शुरू करने के लिए अपने माइनर वॉलेट का 6 अंकों का PIN लिखें।");
        return;
      }
      starting = true;
      render();
      try {
        session = await newSession(pin);
      } catch (err) {
        starting = false;
        el.pin.value = "";
        if (err && err.server === "wallet_inactive") checkWallet();
        showError(err && err.message ? err.message : "सर्वर से संपर्क नहीं हो सका। इंटरनेट जाँचें।");
        render();
        return;
      }
      starting = false;
      el.pin.value = "";
    }
    active = true;
    startedAt = Date.now();
    lastBeatAt = startedAt;
    holdScreen();
    logEvent("start");
    writeState();
    startWorker(session);
    render();
    if (!worker) ping();
  }

  function stop() {
    const wasActive = active;
    active = false;
    if (worker) {
      worker.postMessage({ type: "stop" });
      worker.terminate();
      worker = null;
    }
    releaseScreen();
    if (wasActive) logEvent("stop");
    writeState();
    render();
  }

  // ---------- Web Worker ----------
  // पेज छिपने पर Worker बंद नहीं किया जाता; सिर्फ़ "रोकें" या सत्र ख़त्म होने पर।
  function startWorker(session) {
    if (!window.Worker) return;
    try {
      worker = new Worker("ping-worker.js");
    } catch (_) {
      worker = null; // पेज ख़ुद संकेत भेजेगा
      return;
    }
    worker.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === "ping") handlePing(msg.ok, msg.data);
      else if (msg.type === "heartbeat") onHeartbeat(msg);
    };
    worker.onerror = () => {
      if (worker) worker.terminate();
      worker = null; // पेज ख़ुद संकेत भेजेगा (tick में)
    };
    worker.postMessage({
      type: "start",
      api: API,
      headers: API_HEADERS,
      address: session.address,
      token: session.token,
      everyMs: ((Number(chain && chain.heartbeat_seconds) || 30) * 1000) / 3,
      heartbeatMs: HEARTBEAT_MS,
      startedAt,
    });
  }

  // ---------- स्थिति और heartbeat लॉग (localStorage) ----------
  // सर्वर को अभी कुछ नहीं भेजा जाता; यह लॉग यह देखने के लिए है कि छिपने पर माइनिंग कितनी देर चली।
  function readJson(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || "null");
      return v === null ? fallback : v;
    } catch (_) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* भरा हो तो छोड़ें */ }
  }

  const upSeconds = () => (active && startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0);
  const isVisible = () => document.visibilityState === "visible";

  function logEvent(type, extra) {
    const log = readJson(LOG_KEY, []);
    log.push(Object.assign({ type, t: Date.now(), up_s: upSeconds(), vis: isVisible() ? "visible" : "hidden" }, extra || {}));
    writeJson(LOG_KEY, log.slice(-LOG_MAX));
    renderBackground();
  }

  function writeState(changedVisibility) {
    const s = readJson(STATE_KEY, {});
    const now = Date.now();
    s.running = active;
    s.visible = isVisible();
    s.started_at = active ? startedAt : null;
    s.changed_at = now;
    if (changedVisibility) s[isVisible() ? "visible_at" : "hidden_at"] = now;
    writeJson(STATE_KEY, s);
  }

  // 30 सेकंड का heartbeat: Worker से आता है; Worker न हो तो tick() से
  function onHeartbeat(msg) {
    if (!active) return;
    lastBeatAt = Date.now();
    if (!sessionOrStop()) return;
    logEvent("hb", {
      pings: msg ? msg.pings : null,
      ok_pings: msg ? msg.ok_pings : null,
      net: netError ? "error" : "ok",
      by: msg ? "worker" : "page",
    });
  }

  const clock = (t) => new Date(t).toLocaleTimeString("hi-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dur = (s) => (s >= 60 ? Math.floor(s / 60) + " मिनट " : "") + (s % 60) + " सेकंड";

  // पिछली बार छिपने से लौटने तक: कितने heartbeat दर्ज हुए, यानी माइनिंग कितनी देर चली
  function lastHiddenStretch(log) {
    let hide = -1;
    for (let i = log.length - 1; i >= 0; i--) if (log[i].type === "hidden") { hide = i; break; }
    if (hide < 0) return null;
    const back = log.findIndex((e, i) => i > hide && (e.type === "visible" || e.type === "stop"));
    const end = back >= 0 ? log[back].t : null;
    const beats = log.filter((e, i) => i > hide && (back < 0 || i < back) && e.type === "hb");
    const lastBeat = beats.length ? beats[beats.length - 1].t : log[hide].t;
    return {
      hiddenAt: log[hide].t,
      backAt: end,
      hiddenFor: Math.round(((end || Date.now()) - log[hide].t) / 1000),
      beats: beats.length,
      ranFor: Math.round((lastBeat - log[hide].t) / 1000),
    };
  }

  function renderBackground() {
    if (!el.bgState) return;
    const log = readJson(LOG_KEY, []);
    el.bgState.textContent = active
      ? "चल रही है · " + dur(upSeconds()) + " से · पेज अभी " + (isVisible() ? "दिख रहा है" : "छिपा है")
      : "रुकी हुई";
    el.bgState.className = "bg-state" + (active ? " on" : "");

    const st = lastHiddenStretch(log);
    if (!st) {
      el.bgLast.textContent = "अभी तक माइनिंग के दौरान पेज छिपा नहीं। जाँचने के लिए माइनिंग चालू करके स्क्रीन बंद करें और 2 मिनट बाद लौटें।";
    } else {
      const expected = Math.floor(st.hiddenFor / 30);
      el.bgLast.textContent =
        "पिछली बार पेज " + clock(st.hiddenAt) + " पर छिपा" +
        (st.backAt ? " और " + clock(st.backAt) + " पर लौटा (" + dur(st.hiddenFor) + " बाद)" : " (अभी भी छिपा है)") +
        "। उस दौरान " + st.beats + " heartbeat दर्ज हुए (" + expected + " होने चाहिए थे), यानी छिपने के बाद माइनिंग लगभग " +
        dur(Math.max(0, st.ranFor)) + " चली।";
    }

    const LABEL = { start: "शुरू", stop: "रुकी", hidden: "पेज छिपा", visible: "पेज दिखा", hb: "heartbeat" };
    el.bgLog.replaceChildren(...log.slice(-8).reverse().map((e) => {
      const li = document.createElement("li");
      li.textContent = clock(e.t) + " · " + (LABEL[e.type] || e.type) + " · चालू " + dur(e.up_s || 0) +
        (e.type === "hb" && e.pings != null ? " · संकेत " + (e.ok_pings || 0) + "/" + e.pings : "");
      return li;
    }));
  }

  // ---------- स्क्रीन चालू रखना ----------
  // फ़ोन की स्क्रीन बंद होते ही ब्राउज़र पेज के टाइमर रोक देता है; तब संकेत नहीं जाते और
  // राउंड का हिस्सा छूट जाता है। इसलिए माइनर चालू रहने तक स्क्रीन जगाए रखते हैं।
  async function holdScreen() {
    try {
      if (!("wakeLock" in navigator) || wakeLock) return;
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } catch (_) { /* सुविधा न मिले तो भी माइनर चले */ }
  }

  function releaseScreen() {
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  // ---------- स्क्रीन ----------
  function showError(msg) {
    el.error.textContent = msg;
    el.error.hidden = !msg;
  }

  const mnc = (units) => (chain ? Units.format(units, chain) : "…");
  const mmss = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  };

  function render() {
    el.start.disabled = active || starting || walletStatus !== "active";
    el.stop.disabled = !active;
    el.gate.textContent = GATE_TEXT[walletStatus] || "";
    el.gate.hidden = walletStatus === "active";
    el.pinBox.hidden = active || walletStatus !== "active" || !!readSession();
    el.start.textContent = starting ? "शुरू हो रहा है…" : "माइनिंग शुरू करें";

    let text = "रुका हुआ";
    if (starting) text = "सत्र लिया जा रहा है…";
    else if (active) text = netError ? "इंटरनेट नहीं मिल रहा; संकेत दोबारा भेजा जाएगा…" : "माइनिंग चल रही है: हर 30 सेकंड “मैं हूँ” का संकेत जा रहा है।";
    el.status.textContent = text;
    el.status.classList.toggle("on", active && !netError);

    renderRound();
  }

  function renderRound() {
    if (!info) {
      el.roundLeft.textContent = "—";
      el.roundBar.style.width = "0%";
      el.slots.replaceChildren();
      el.roundNote.textContent = "";
      return;
    }
    const now = Date.now() + serverOffset;
    const spr = Number(info.slots_per_round);
    const hbMs = Number(info.heartbeat_seconds) * 1000;
    const roundMs = Number(info.round_seconds) * 1000;
    const ends = Number(info.round_ends_ms);
    const fresh = now < ends; // जानकारी इसी राउंड की है
    const left = fresh ? ends - now : roundMs - ((now - ends) % roundMs);

    el.roundLeft.textContent = mmss(left);
    el.roundBar.style.width = Math.min(100, ((roundMs - left) / roundMs) * 100).toFixed(1) + "%";

    const mine = fresh ? Number(info.my_slots) : 0;
    el.slots.replaceChildren(...Array.from({ length: spr }, (_, i) => {
      const dot = document.createElement("span");
      dot.className = "slot" + (i < mine ? " on" : "");
      return dot;
    }));

    // अभी कौन सा खाना चल रहा है (0 से), और क्या इस राउंड का हिस्सा अब भी मिल सकता है
    const k = Math.min(spr - 1, Math.floor((roundMs - left) / hbMs));
    const nowDone = fresh && info.my_slot_now;
    const possible = mine + (spr - k) - (nowDone ? 1 : 0);
    let note;
    if (!active) note = "माइनिंग शुरू करें; अगले पूरे राउंड से हिस्सा मिलेगा।";
    else if (possible >= spr) note = "इस राउंड में आप पूरे समय मौजूद हैं। राउंड ख़त्म होने पर हिस्सा मिलेगा।";
    else note = "इस राउंड में आप पूरे समय नहीं रहे (देर से जुड़े या संकेत छूटा)। अगला राउंड " + mmss(left) + " में; उससे हिस्सा मिलेगा।";
    el.roundNote.textContent = note;

    const last = info.last_round;
    el.lastPeople.textContent = last ? String(last.participants) : "—";
    el.lastShare.textContent = last ? mnc(last.share_units) : "—";
    el.myTotal.textContent = mnc(info.my_total_round_units || 0);
  }

  // ---------- इनाम की सूची ----------
  async function loadRewards() {
    const address = minerAddress();
    if (!address) {
      el.list.replaceChildren();
      el.empty.hidden = false;
      return;
    }
    try {
      const res = await fetch(
        API + "/rest/v1/round_rewards?select=round_no,units,mining_rounds(started_at,participants)" +
        "&address=eq." + encodeURIComponent(address) + "&order=round_no.desc&limit=10",
        { headers: API_HEADERS, cache: "no-store" }
      );
      if (!res.ok) throw new Error("http " + res.status);
      const rows = await res.json();
      el.list.replaceChildren(...rows.map((r) => {
        const li = document.createElement("li");
        li.className = "reward";
        const amount = document.createElement("b");
        amount.textContent = "+" + mnc(r.units) + " MNC";
        const meta = document.createElement("span");
        const m = r.mining_rounds || {};
        meta.textContent = (m.started_at
          ? new Date(m.started_at).toLocaleTimeString("hi-IN", { hour: "2-digit", minute: "2-digit" }) + " का राउंड"
          : "राउंड") + (m.participants ? " · " + m.participants + " लोगों में बँटा" : "");
        li.append(amount, meta);
        return li;
      }));
      el.empty.hidden = rows.length > 0;
    } catch (_) { /* इंटरनेट नहीं: पुरानी सूची रहने दें */ }
  }

  // ---------- वॉलेट की पट्टी ----------
  async function renderWalletBar() {
    const title = $("wallet-bar-title"), sub = $("wallet-bar-sub");
    const address = minerAddress();
    if (!address) {
      title.textContent = "वॉलेट बनाएँ";
      sub.textContent = "माइनिंग का इनाम माइनर वॉलेट के पते पर आता है";
      return;
    }
    sub.textContent = address.slice(0, 8) + "…" + address.slice(-5);
    try {
      const units = await rpc("mnc_balance_units", { addr: address });
      title.textContent = mnc(units === null ? 0 : units) + " MNC";
    } catch (_) {
      title.textContent = "माइनर वॉलेट";
    }
  }

  // ---------- घड़ी ----------
  // हर सेकंड: उलटी गिनती; माइनर चालू हो तो हर कुछ सेकंड एक संकेत (एक खाने में 3 बार,
  // ताकि नेटवर्क की छोटी रुकावट से खाना न छूटे; सर्वर एक खाने को एक ही बार गिनता है)।
  function tick() {
    if (chain && active && !worker) {
      const every = (Number(chain.heartbeat_seconds) * 1000) / 3;
      if (Date.now() - lastPingAt >= every) ping();
      if (Date.now() - lastBeatAt >= HEARTBEAT_MS) onHeartbeat(null);
    } else if (!active && Date.now() - lastInfoAt >= IDLE_REFRESH_MS) {
      lastInfoAt = Date.now();
      refreshInfo();
    }
    renderRound();
    if (active) renderBackground();
  }

  // ---------- शुरुआत ----------
  el.start.addEventListener("click", start);
  el.stop.addEventListener("click", stop);
  el.pin.addEventListener("keydown", (e) => { if (e.key === "Enter") start(); });
  if (el.bgClear) el.bgClear.addEventListener("click", () => { writeJson(LOG_KEY, []); renderBackground(); });

  document.addEventListener("visibilitychange", () => {
    if (active) logEvent(isVisible() ? "visible" : "hidden");
    writeState(true);
    if (document.visibilityState !== "visible") return;
    if (active) {
      holdScreen(); // स्क्रीन-लॉक ऐप के पीछे जाने पर छूट जाता है
      ping();
    } else {
      renderWalletBar();
      checkWallet();
      refreshInfo();
    }
  });

  (async function boot() {
    try {
      chain = await Units.load("../config/chain.json");
    } catch (_) {
      showError("सेटिंग (config/chain.json) नहीं मिली। इंटरनेट जाँचकर पेज दोबारा खोलें।");
    }
    writeState();
    render();
    renderBackground();
    renderWalletBar();
    checkWallet();
    refreshInfo();
    loadRewards();
    setInterval(tick, 1000);
  })();
})();
