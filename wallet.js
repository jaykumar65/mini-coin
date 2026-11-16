// MNC टेस्टनेट वॉलेट (पहला चरण)
//
// वॉलेट = एक कुंजी-जोड़ी (ECDSA P-256), जो इसी ब्राउज़र में बनती और रहती है।
//   - निजी कुंजी (private key): सिर्फ़ इस डिवाइस के localStorage में। सर्वर को कभी नहीं जाती।
//   - पता (address): "MNC" + SHA-256(सार्वजनिक कुंजी) के पहले 40 hex अक्षर। यही सबको दिखता है
//     और इसी पर इनाम दर्ज होता है।
//
// इस चरण में: वॉलेट बनाना, पता, बैलेंस, बैकअप और वापस लाना।
// कॉइन भेजना (transfer) अभी नहीं है; निजी कुंजी उसी के लिए आगे काम आएगी।
//
// यह टेस्टनेट है: कुंजी ब्राउज़र के localStorage में सादे रूप में रहती है, असली सुरक्षा नहीं है।

"use strict";

(function () {
  const CFG = window.MNC_CONFIG || {};
  const STORAGE_KEY = "mnc_wallet";
  const BACKUP_PREFIX = "MNCWALLET1.";
  const ADDRESS_RE = /^MNC[0-9a-f]{40}$/;
  const EC = { name: "ECDSA", namedCurve: "P-256" };
  const API = String(CFG.supabaseUrl || "").replace(/\/+$/, "");

  const $ = (id) => document.getElementById(id);
  const el = {
    none: $("wallet-none"),
    have: $("wallet-have"),
    address: $("wallet-address"),
    balance: $("wallet-balance"),
    create: $("btn-wallet-create"),
    copy: $("btn-wallet-copy"),
    refresh: $("btn-wallet-refresh"),
    backupOpen: $("btn-wallet-backup"),
    restoreOpen: $("btn-wallet-restore-open"),
    backupBox: $("wallet-backup"),
    backupCode: $("wallet-backup-code"),
    backupCopy: $("btn-wallet-backup-copy"),
    backupClose: $("btn-wallet-backup-close"),
    restoreBox: $("wallet-restore"),
    restoreCode: $("wallet-restore-code"),
    restore: $("btn-wallet-restore"),
    restoreCancel: $("btn-wallet-restore-cancel"),
    msg: $("wallet-msg"),
  };

  const fmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 8 });
  let wallet = load();   // { address, x, y, d } या null
  let locked = false;    // माइनर चलते समय वॉलेट बदला नहीं जा सकता

  // ---------- कुंजी और पता ----------
  function b64urlToBytes(s) {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function toHex(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
    return s;
  }

  // सार्वजनिक कुंजी (x, y) से पता
  async function addressOf(x, y) {
    const bx = b64urlToBytes(x), by = b64urlToBytes(y);
    if (bx.length !== 32 || by.length !== 32) throw new Error("key");
    const raw = new Uint8Array(65);
    raw[0] = 4; // बिना दबाई हुई (uncompressed) कुंजी का चिह्न
    raw.set(bx, 1);
    raw.set(by, 33);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
    return "MNC" + toHex(digest).slice(0, 40);
  }

  // जाँच: निजी कुंजी (d) सच में इसी सार्वजनिक कुंजी (x, y) की है
  async function keysMatch(x, y, d) {
    const jwk = { kty: "EC", crv: "P-256", x, y };
    const priv = await crypto.subtle.importKey("jwk", Object.assign({ d }, jwk), EC, false, ["sign"]);
    const pub = await crypto.subtle.importKey("jwk", jwk, EC, false, ["verify"]);
    const probe = new TextEncoder().encode("mnc-wallet-check");
    const alg = { name: "ECDSA", hash: "SHA-256" };
    const sig = await crypto.subtle.sign(alg, priv, probe);
    return crypto.subtle.verify(alg, pub, sig, probe);
  }

  function load() {
    try {
      const w = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      return w && ADDRESS_RE.test(w.address) && w.x && w.y && w.d ? w : null;
    } catch (_) {
      return null;
    }
  }

  function save(w) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(w));
    wallet = w;
  }

  async function create() {
    const pair = await crypto.subtle.generateKey(EC, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const w = { v: 1, address: await addressOf(jwk.x, jwk.y), x: jwk.x, y: jwk.y, d: jwk.d };
    save(w);
    return w;
  }

  function backupCode() {
    if (!wallet) return "";
    return BACKUP_PREFIX + btoa(JSON.stringify({ x: wallet.x, y: wallet.y, d: wallet.d }));
  }

  async function restore(code) {
    const text = String(code || "").replace(/\s+/g, "");
    if (!text.startsWith(BACKUP_PREFIX)) throw new Error("यह MNC वॉलेट का बैकअप कोड नहीं लगता।");
    let k;
    try {
      k = JSON.parse(atob(text.slice(BACKUP_PREFIX.length)));
    } catch (_) {
      throw new Error("बैकअप कोड अधूरा या बिगड़ा हुआ है। पूरा कोड दोबारा चिपकाएँ।");
    }
    let ok = false, address = "";
    try {
      ok = await keysMatch(k.x, k.y, k.d);
      address = await addressOf(k.x, k.y);
    } catch (_) { ok = false; }
    if (!ok) throw new Error("बैकअप कोड की कुंजी सही नहीं है।");
    const w = { v: 1, address, x: k.x, y: k.y, d: k.d };
    save(w);
    return w;
  }

  // ---------- बैलेंस ----------
  // इस पते को मिले सभी इनामों का जोड़ (blocks टेबल से)
  async function fetchBalance(address) {
    if (!API || !CFG.supabaseKey) throw new Error("config");
    const headers = { apikey: CFG.supabaseKey, Authorization: "Bearer " + CFG.supabaseKey };
    const PAGE = 1000;
    let total = 0;
    for (let offset = 0; ; offset += PAGE) {
      const res = await fetch(
        API + "/rest/v1/blocks?select=reward&miner=eq." + encodeURIComponent(address) +
        "&order=idx.asc&limit=" + PAGE + "&offset=" + offset,
        { headers, cache: "no-store" }
      );
      if (!res.ok) throw new Error("http " + res.status);
      const rows = await res.json();
      for (const r of rows) total += Number(r.reward) || 0;
      if (rows.length < PAGE) break;
    }
    return total;
  }

  async function refreshBalance() {
    if (!wallet) return;
    const address = wallet.address;
    el.balance.textContent = "…";
    try {
      const total = await fetchBalance(address);
      if (wallet && wallet.address === address) el.balance.textContent = fmt.format(total);
    } catch (_) {
      el.balance.textContent = "—";
      say("बैलेंस नहीं मिल सका। इंटरनेट जाँचकर “बैलेंस ताज़ा करें” दबाएँ।", "bad");
    }
  }

  // ---------- UI ----------
  function say(text, kind) {
    el.msg.textContent = text;
    el.msg.className = "wallet-msg" + (kind ? " " + kind : "");
    el.msg.hidden = !text;
  }

  function render() {
    el.none.hidden = !!wallet;
    el.have.hidden = !wallet;
    if (wallet) el.address.textContent = wallet.address;
    el.restoreOpen.textContent = wallet ? "दूसरा वॉलेट लाएँ" : "पुराना वॉलेट वापस लाएँ";
    el.create.disabled = locked;
    el.restoreOpen.disabled = locked;
    el.restore.disabled = locked;
  }

  async function copyText(text, done) {
    try {
      await navigator.clipboard.writeText(text);
      say(done, "ok");
    } catch (_) {
      say("कॉपी नहीं हो सका; टेक्स्ट को दबाकर रखें और खुद कॉपी करें।", "bad");
    }
  }

  function closeBoxes() {
    el.backupBox.hidden = true;
    el.backupCode.value = "";
    el.restoreBox.hidden = true;
    el.restoreCode.value = "";
  }

  function changed() {
    render();
    refreshBalance();
    document.dispatchEvent(new CustomEvent("mnc-wallet-change"));
  }

  el.create.addEventListener("click", async () => {
    if (locked || wallet) return;
    try {
      await create();
      say("नया वॉलेट बन गया। अभी “बैकअप लें” दबाकर कोड सुरक्षित जगह रख लें; उसके बिना यह वॉलेट दूसरे फ़ोन पर नहीं आ सकता।", "ok");
      changed();
    } catch (_) {
      say("वॉलेट नहीं बन सका। यह ब्राउज़र ज़रूरी सुविधा (crypto) नहीं दे रहा।", "bad");
    }
  });

  el.copy.addEventListener("click", () => wallet && copyText(wallet.address, "पता कॉपी हो गया।"));
  el.refresh.addEventListener("click", () => { say("", ""); refreshBalance(); });

  el.backupOpen.addEventListener("click", () => {
    closeBoxes();
    el.backupCode.value = backupCode();
    el.backupBox.hidden = false;
    say("", "");
  });
  el.backupCopy.addEventListener("click", () => copyText(el.backupCode.value, "बैकअप कोड कॉपी हो गया। इसे किसी को न भेजें।"));
  el.backupClose.addEventListener("click", closeBoxes);

  el.restoreOpen.addEventListener("click", () => {
    if (locked) return;
    closeBoxes();
    el.restoreBox.hidden = false;
    say("", "");
    el.restoreCode.focus();
  });
  el.restoreCancel.addEventListener("click", closeBoxes);
  el.restore.addEventListener("click", async () => {
    if (locked) return;
    if (wallet && !confirm("मौजूदा वॉलेट इस डिवाइस से हट जाएगा। क्या आपने उसका बैकअप ले लिया है?")) return;
    try {
      await restore(el.restoreCode.value);
      closeBoxes();
      say("वॉलेट वापस आ गया।", "ok");
      changed();
    } catch (err) {
      say(err && err.message ? err.message : "वॉलेट वापस नहीं आ सका।", "bad");
    }
  });

  // ---------- miner.js के लिए ----------
  window.MNCWallet = {
    address: () => (wallet ? wallet.address : ""),
    refreshBalance,
    // माइनर चलते समय वॉलेट बदलने के बटन बंद
    setLocked(value) {
      locked = !!value;
      if (locked) closeBoxes();
      render();
    },
  };

  render();
  refreshBalance();
})();
