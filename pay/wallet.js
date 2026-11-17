// MNC Pay (TESTNET) — लेन-देन वाला वॉलेट (pay/index.html की स्क्रीन)
//
// माइनिंग का इनाम माइनर वॉलेट (wallet/) में आता है; लोग उसे वहाँ से इस वॉलेट में भेजते हैं,
// और यहाँ से एक-दूसरे को भेजते-पाते हैं। पुराने (12 शब्द वाले) वॉलेट भी यहीं खुलते हैं
// (वही localStorage कुंजी "mnc_wallet"), और उनका पुराना बैलेंस गिना जाता है।
//
// रकम हमेशा पूर्णांक इकाई (BigInt) में रखी जाती है; संख्याएँ ../config/chain.json से
// (../config/units.js)।
//
// वॉलेट = एक कुंजी-जोड़ी (ECDSA P-256), जो इसी ब्राउज़र में बनती और रहती है।
//   - निजी कुंजी और 12 शब्द: सिर्फ़ इस डिवाइस के localStorage में। सर्वर को कभी नहीं जाते।
//   - पता: "MNC" + 40 hex अक्षर। यही सबको दिखता है; इसी पर इनाम और आए हुए कॉइन दर्ज होते हैं।
//
// काम: वॉलेट बनाना, बैलेंस, लेन-देन की सूची, MNC पाना (पता), MNC भेजना (हस्ताक्षर करके
// transfer function को), 12 शब्द / निजी कुंजी दिखाना, और उनसे वॉलेट वापस लाना।
// गणित wallet-core.js में है।
//
// यह टेस्टनेट है: कुंजी localStorage में सादे रूप में रहती है, असली सुरक्षा नहीं है।

"use strict";

(function () {
  const Core = window.MNCWalletCore;
  const Units = window.MNCUnits;
  const CFG = window.MNC_CONFIG || {};
  const STORAGE_KEY = "mnc_wallet";
  const OLD_BACKUP_PREFIX = "MNCWALLET1."; // पहले चरण का बैकअप कोड; अब भी स्वीकार है
  const PAGE = 10;                          // लेन-देन की सूची में एक बार में कितनी पंक्तियाँ
  const API = String(CFG.supabaseUrl || "").replace(/\/+$/, "");
  const HEADERS = { apikey: CFG.supabaseKey, Authorization: "Bearer " + CFG.supabaseKey };

  const $ = (id) => document.getElementById(id);
  const el = {
    none: $("wallet-none"),
    have: $("wallet-have"),
    short: $("wallet-short"),
    address: $("wallet-address"),
    balance: $("wallet-balance"),
    create: $("btn-wallet-create"),
    copy: $("btn-wallet-copy"),
    copyFull: $("btn-wallet-copy-full"),
    refresh: $("btn-wallet-refresh"),
    sendTo: $("send-to"),
    sendAmount: $("send-amount"),
    send: $("btn-wallet-send"),
    sendMsg: $("send-msg"),
    sendFee: $("send-fee"),
    historyBox: $("wallet-history"),
    history: $("history"),
    historyEmpty: $("history-empty"),
    more: $("btn-more"),
    secretsOpen: $("btn-wallet-secrets"),
    secretsBox: $("wallet-secrets"),
    wordsWrap: $("secret-words-wrap"),
    words: $("secret-words"),
    noWords: $("secret-nowords"),
    privateKey: $("secret-private"),
    copyWords: $("btn-copy-words"),
    copyPrivate: $("btn-copy-private"),
    secretsClose: $("btn-wallet-secrets-close"),
    restoreOpen: Array.from(document.querySelectorAll(".js-restore-open")),
    restoreBox: $("wallet-restore"),
    restoreCode: $("wallet-restore-code"),
    restore: $("btn-wallet-restore"),
    restoreCancel: $("btn-wallet-restore-cancel"),
    msg: $("wallet-msg"),
  };

  // ऊपर के तीन गोल बटन और उनके पैनल
  const PANELS = [
    { button: $("act-send"), panel: $("panel-send") },
    { button: $("act-receive"), panel: $("panel-receive") },
    { button: $("act-keys"), panel: $("panel-keys") },
  ];

  let chain = null;         // config/chain.json
  const fmt = (units) => (chain ? Units.format(units, chain) : "…");
  let wallet = load();      // { address, x, y, d, privateHex, seedHex } या null
  let balance = null;       // आख़िरी बार पढ़ा हुआ बैलेंस (BigInt इकाई) या null
  let limit = PAGE;         // लेन-देन की सूची में कितनी पंक्तियाँ दिखानी हैं
  let busy = false;         // भेजना चल रहा है

  // ---------- सेव / लोड ----------
  function load() {
    try {
      const w = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!w || !Core.isAddress(w.address) || !w.x || !w.y || !w.d) return null;
      return {
        address: w.address, x: w.x, y: w.y, d: w.d,
        privateHex: Core.toHex(Core.b64urlToBytes(w.d)),
        seedHex: w.seed || null,
      };
    } catch (_) {
      return null;
    }
  }

  function save(key) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      v: 2, address: key.address, x: key.x, y: key.y, d: key.d, seed: key.seedHex || null,
    }));
    wallet = load();
  }

  // कुंजी सही है, यह ब्राउज़र के अपने crypto से परखकर ही सेव करें
  async function adopt(key) {
    if (!(await Core.selfCheck(key))) throw new Error("कुंजी की जाँच नाकाम रही।");
    save(key);
  }

  async function create() {
    await adopt(await Core.keyFromSeed(Core.newSeed()));
  }

  // 12 शब्द, निजी कुंजी (64 hex), या पुराना बैकअप कोड
  async function restore(input) {
    const text = String(input || "").trim();
    if (!text) throw new Error("12 शब्द या निजी कुंजी लिखें।");
    const compact = text.replace(/\s+/g, "");

    if (compact.startsWith(OLD_BACKUP_PREFIX)) {
      let k;
      try {
        k = JSON.parse(atob(compact.slice(OLD_BACKUP_PREFIX.length)));
      } catch (_) {
        throw new Error("बैकअप कोड अधूरा या बिगड़ा हुआ है।");
      }
      const key = await Core.keyFromPrivateHex(Core.toHex(Core.b64urlToBytes(String(k.d || ""))));
      if (key.x !== k.x || key.y !== k.y) throw new Error("बैकअप कोड की कुंजी सही नहीं है।");
      return adopt(key);
    }
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(compact)) {
      return adopt(await Core.keyFromPrivateHex(compact));
    }
    return adopt(await Core.keyFromSeed(await Core.wordsToSeed(text)));
  }

  // ---------- सर्वर से पढ़ना ----------
  async function getJson(path, init) {
    if (!API || !CFG.supabaseKey) throw new Error("config");
    const res = await fetch(API + path, Object.assign({ headers: HEADERS, cache: "no-store" }, init || {}));
    if (!res.ok) {
      const err = new Error("http " + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function loadChain() {
    if (!chain) chain = await Units.load("../config/chain.json");
    return chain;
  }

  // बैलेंस (इकाई में) = पुराने ब्लॉक के इनाम + राउंड के इनाम + आए हुए - भेजे हुए - फ़ीस
  // (डेटाबेस का mnc_balance_units function)
  async function fetchBalance(address) {
    const value = await getJson("/rest/v1/rpc/mnc_balance_units", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, HEADERS),
      body: JSON.stringify({ addr: address }),
    });
    return BigInt(value === null ? 0 : value);
  }

  // लेन-देन की सूची: माइनिंग के इनाम (पुराने ब्लॉक + राउंड) + आए हुए + भेजे हुए, नए से पुराने
  async function fetchHistory(address, count) {
    const a = encodeURIComponent(address);
    const unit = BigInt(chain.unit_per_mnc);
    const blocks = getJson(
      "/rest/v1/blocks?select=idx,reward,created_at&miner=eq." + a + "&order=idx.desc&limit=" + count
    );
    const rounds = getJson(
      "/rest/v1/round_rewards?select=round_no,units,mining_rounds(started_at,participants)&address=eq." + a +
      "&order=round_no.desc&limit=" + count
    ).catch(() => []);
    const transfers = getJson(
      "/rest/v1/transfers?select=id,from_addr,to_addr,amount,amount_units,fee_units,created_at" +
      "&or=(from_addr.eq." + a + ",to_addr.eq." + a + ")&order=id.desc&limit=" + count
    );

    const [b, r, t] = await Promise.all([blocks, rounds, transfers]);
    // पुराने ब्लॉक का इनाम और पुराने लेन-देन पूरे MNC में दर्ज हैं
    const wholeToUnits = (v) => BigInt(String(v).split(".")[0]) * unit;
    const items = b.map((x) => ({
      kind: "reward", units: wholeToUnits(x.reward), label: "माइनिंग का इनाम · ब्लॉक #" + x.idx, time: x.created_at,
    }))
      .concat(r.map((x) => {
        const info = x.mining_rounds || {};
        return {
          kind: "reward", units: BigInt(x.units),
          label: "राउंड का इनाम" + (info.participants ? " · " + info.participants + " लोगों में बँटा" : ""),
          time: info.started_at || null,
        };
      }))
      .concat(t.map((x) => {
        const out = x.from_addr === address;
        const amount = x.amount_units !== null && x.amount_units !== undefined ? BigInt(x.amount_units) : wholeToUnits(x.amount);
        return {
          kind: out ? "out" : "in",
          units: out ? amount + BigInt(x.fee_units || 0) : amount,
          other: out ? x.to_addr : x.from_addr,
          time: x.created_at,
        };
      }));
    items.sort((p, q) => Date.parse(q.time || 0) - Date.parse(p.time || 0));
    return { items: items.slice(0, count), more: b.length >= count || r.length >= count || t.length >= count };
  }

  // भेजने वाले का अगला क्रमांक
  async function nextSeq(address) {
    const rows = await getJson(
      "/rest/v1/transfers?select=seq&from_addr=eq." + encodeURIComponent(address) + "&order=seq.desc&limit=1"
    );
    return rows.length ? Number(rows[0].seq) + 1 : 0;
  }

  async function refresh() {
    if (!wallet) return;
    const address = wallet.address;
    el.balance.textContent = "…";
    try {
      await loadChain();
      const total = await fetchBalance(address);
      if (!wallet || wallet.address !== address) return;
      balance = total;
      el.balance.textContent = fmt(total);
      showFee();
    } catch (_) {
      balance = null;
      el.balance.textContent = "—";
      say("बैलेंस नहीं मिल सका। इंटरनेट जाँचकर “ताज़ा करें” दबाएँ।", "bad");
    }
    refreshHistory();
  }

  const shortAddr = (a) => a.slice(0, 8) + "…" + a.slice(-5);

  const ICONS = {
    reward: '<path d="M4 20l6-6M14 4l6 6-4 4-6-6z"/>',            // कुदाल जैसा चिह्न
    in: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    out: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  };

  function historyItem(it) {
    const li = document.createElement("li");
    li.className = "tx " + (it.kind === "out" ? "out" : "in");

    const icon = document.createElement("span");
    icon.className = "circle";
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[it.kind] + "</svg>";

    const body = document.createElement("div");
    const amount = document.createElement("b");
    amount.textContent = (it.kind === "out" ? "−" : "+") + fmt(it.units) + " MNC";
    const who = document.createElement("span");
    if (it.kind === "reward") who.textContent = it.label;
    else {
      who.textContent = (it.kind === "out" ? "किसे: " : "किससे: ") + shortAddr(it.other);
      who.title = it.other;
    }
    const when = document.createElement("small");
    when.textContent = it.time ? new Date(it.time).toLocaleString("hi-IN") : "";
    body.append(amount, who, when);

    li.append(icon, body);
    return li;
  }

  async function refreshHistory() {
    if (!wallet) return;
    const address = wallet.address;
    let result = { items: [], more: false };
    try {
      await loadChain();
      result = await fetchHistory(address, limit);
    } catch (_) { /* इंटरनेट न हो: सूची खाली */ }
    if (!wallet || wallet.address !== address) return;
    el.history.replaceChildren(...result.items.map(historyItem));
    el.historyEmpty.hidden = result.items.length > 0;
    el.more.hidden = !result.more;
  }

  // ---------- भेजना ----------
  function sayTx(text, kind) {
    el.sendMsg.textContent = text;
    el.sendMsg.className = "msg" + (kind ? " " + kind : "");
    el.sendMsg.hidden = !text;
  }

  // फ़ीस: treasury भरा हो तभी लगती है (config/chain.json)
  function showFee() {
    const fee = chain ? Units.feeUnits(chain) : 0n;
    el.sendFee.hidden = !fee;
    if (fee) el.sendFee.textContent = "हर लेन-देन पर फ़ीस: " + fmt(fee) + " MNC";
  }

  async function postTransfer(to, units, fee, seq) {
    const sig = await Core.signTransfer(wallet, to, units, fee, seq);
    const res = await fetch(API + "/functions/v1/transfer", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, HEADERS),
      body: JSON.stringify({
        from: wallet.address, to, amount_units: units.toString(), fee_units: fee.toString(), seq,
        pub_x: wallet.x, pub_y: wallet.y, sig,
      }),
    });
    const body = await res.json();
    if (!body || typeof body.ok !== "boolean") throw new Error("format");
    return body;
  }

  async function send() {
    if (busy || !wallet) return;
    const to = el.sendTo.value.trim();
    try {
      await loadChain();
    } catch (_) {
      return sayTx("इंटरनेट जाँचें; सेटिंग नहीं मिल सकी।", "bad");
    }
    const units = Units.toUnits(el.sendAmount.value, chain);
    const fee = Units.feeUnits(chain);

    if (!Core.isAddress(to)) return sayTx("पाने वाले का पता सही नहीं है। वह MNC से शुरू होता है और 43 अक्षरों का होता है।", "bad");
    if (to === wallet.address) return sayTx("अपने ही पते पर नहीं भेज सकते।", "bad");
    if (units === null || units <= 0n) {
      return sayTx("राशि सही लिखें (जैसे 10 या 2.5; दशमलव के बाद अधिकतम " + chain.decimals + " अंक)।", "bad");
    }
    if (balance !== null && units + fee > balance) return sayTx("बैलेंस कम है। आपके पास " + fmt(balance) + " MNC हैं।", "bad");
    const feeText = fee ? "\nफ़ीस: " + fmt(fee) + " MNC" : "";
    if (!confirm(fmt(units) + " MNC इस पते पर भेजें?\n\n" + to + feeText + "\n\nभेजने के बाद यह वापस नहीं हो सकता।")) return;

    busy = true;
    render();
    sayTx("भेजा जा रहा है…", "");
    try {
      let result = await postTransfer(to, units, fee, await nextSeq(wallet.address));
      if (!result.ok && result.code === "bad_seq" && Number.isSafeInteger(result.expected)) {
        // क्रमांक बीच में बदल गया (जैसे दूसरे डिवाइस से भेजा गया): सही क्रमांक से एक बार और
        result = await postTransfer(to, units, fee, result.expected);
      }
      if (result.ok) {
        sayTx("सफल: " + fmt(units) + " MNC भेज दिए गए।", "ok");
        el.sendTo.value = "";
        el.sendAmount.value = "";
      } else {
        sayTx("नहीं भेजा गया: " + (result.reason || "सर्वर ने कारण नहीं बताया।"), "bad");
      }
    } catch (_) {
      sayTx("सर्वर से संपर्क नहीं हो सका। दोबारा भेजने से पहले “ताज़ा करें” दबाकर देख लें कि राशि कट तो नहीं गई।", "bad");
    }
    busy = false;
    render();
    refresh();
  }

  // ---------- UI ----------
  function say(text, kind) {
    el.msg.textContent = text;
    el.msg.className = "msg" + (kind ? " " + kind : "");
    el.msg.hidden = !text;
  }

  function render() {
    el.none.hidden = !!wallet || !el.restoreBox.hidden;
    el.have.hidden = !wallet;
    el.historyBox.hidden = !wallet;
    if (wallet) {
      el.short.textContent = shortAddr(wallet.address);
      el.address.textContent = wallet.address;
    }
    el.send.disabled = busy;
    el.send.textContent = busy ? "भेजा जा रहा है…" : "MNC भेजें";
  }

  function hideSecrets() {
    el.secretsBox.hidden = true;
    el.words.replaceChildren();
    el.privateKey.textContent = "";
  }

  // which: खोलने वाला पैनल, या null = सब बंद
  function openPanel(which) {
    for (const p of PANELS) {
      const open = p === which && p.panel.hidden;
      p.panel.hidden = !open;
      p.button.setAttribute("aria-expanded", String(open));
    }
    hideSecrets();
  }

  function closeRestore() {
    el.restoreBox.hidden = true;
    el.restoreCode.value = "";
    render();
  }

  async function copyText(text, done) {
    try {
      await navigator.clipboard.writeText(text);
      say(done, "ok");
    } catch (_) {
      say("कॉपी नहीं हो सका; टेक्स्ट को दबाकर रखें और खुद कॉपी करें।", "bad");
    }
  }

  async function showSecrets() {
    if (!wallet) return;
    let words = null;
    if (wallet.seedHex) {
      try { words = await Core.seedToWords(Core.fromHex(wallet.seedHex)); } catch (_) { words = null; }
    }
    el.wordsWrap.hidden = !words;
    el.noWords.hidden = !!words;
    if (words) {
      el.words.replaceChildren(...words.map((w) => {
        const li = document.createElement("li");
        li.textContent = w;
        return li;
      }));
      el.copyWords.onclick = () => copyText(words.join(" "), "12 शब्द कॉपी हो गए। इन्हें किसी को न भेजें।");
    }
    el.privateKey.textContent = wallet.privateHex;
    el.secretsBox.hidden = false;
  }

  function walletChanged() {
    balance = null;
    limit = PAGE;
    el.history.replaceChildren();
    sayTx("", "");
    openPanel(null);
    render();
    refresh();
  }

  PANELS.forEach((p) => p.button.addEventListener("click", () => { say("", ""); openPanel(p); }));

  el.create.addEventListener("click", async () => {
    if (wallet) return;
    try {
      await create();
      walletChanged();
      openPanel(PANELS[2]);
      await showSecrets();
      say("नया वॉलेट बन गया। ऊपर दिए 12 शब्द अभी कागज़ पर लिखकर सुरक्षित रख लें; इनके बिना वॉलेट दूसरे फ़ोन पर नहीं आ सकता।", "ok");
    } catch (_) {
      say("वॉलेट नहीं बन सका। यह ब्राउज़र ज़रूरी सुविधा (crypto) नहीं दे रहा।", "bad");
    }
  });

  const copyAddress = () => wallet && copyText(wallet.address, "पता कॉपी हो गया।");
  el.copy.addEventListener("click", copyAddress);
  el.copyFull.addEventListener("click", copyAddress);
  el.refresh.addEventListener("click", () => { say("", ""); refresh(); });
  el.more.addEventListener("click", () => { limit += PAGE; refreshHistory(); });
  el.send.addEventListener("click", send);

  el.secretsOpen.addEventListener("click", () => {
    if (!confirm("12 शब्द और निजी कुंजी स्क्रीन पर दिखेंगे। देख लें कि आसपास कोई और आपकी स्क्रीन नहीं देख रहा।")) return;
    say("", "");
    showSecrets();
  });
  el.copyPrivate.addEventListener("click", () => wallet && copyText(wallet.privateHex, "निजी कुंजी कॉपी हो गई। इसे किसी को न भेजें।"));
  el.secretsClose.addEventListener("click", hideSecrets);

  el.restoreOpen.forEach((b) => b.addEventListener("click", () => {
    openPanel(null);
    say("", "");
    el.restoreBox.hidden = false;
    render();
    el.restoreCode.focus();
  }));
  el.restoreCancel.addEventListener("click", closeRestore);
  el.restore.addEventListener("click", async () => {
    if (wallet && !confirm("मौजूदा वॉलेट इस डिवाइस से हट जाएगा। क्या आपने उसके 12 शब्द या निजी कुंजी लिख ली है?")) return;
    try {
      await restore(el.restoreCode.value);
      closeRestore();
      say("वॉलेट वापस आ गया।", "ok");
      walletChanged();
    } catch (err) {
      say(err && err.message && !/^(key|seed|format)$/.test(err.message) ? err.message : "वॉलेट वापस नहीं आ सका; शब्द या कुंजी जाँचें।", "bad");
    }
  });

  render();
  refresh();
})();
