// MNC Wallet (TESTNET) — स्क्रीन का लॉजिक
//
// काम: वॉलेट बनाना (PIN के साथ), उसे सर्वर पर रजिस्टर करके सक्रिय करना (अपने आप,
// कोई निमंत्रण कोड नहीं), और पता व स्थिति दिखाना।
// कुंजी और PIN का काम vault.js में है। सर्वर को सिर्फ़ पता और public key जाते हैं;
// private key और PIN कभी नहीं।

"use strict";

(function () {
  const Vault = window.MNCVault;
  const CFG = window.MNC_CONFIG || {};
  const API = String(CFG.supabaseUrl || "").replace(/\/+$/, "") + "/functions/v1/";
  const HEADERS = { apikey: CFG.supabaseKey, Authorization: "Bearer " + CFG.supabaseKey };

  const $ = (id) => document.getElementById(id);
  const el = {
    none: $("view-none"), have: $("view-have"),
    newPin: $("new-pin"), newPin2: $("new-pin2"), create: $("btn-create"), createMsg: $("create-msg"),
    address: $("address"), copyAddress: $("btn-copy-address"),
    keyB64: $("key-b64"), keyHex: $("key-hex"), copyKey: $("btn-copy-key"),
    status: $("status"), statusNote: $("status-note"), recheck: $("btn-recheck"),
    activate: $("btn-activate"), activateMsg: $("activate-msg"),
    miner: $("link-miner"),
    remove: $("btn-remove"),
  };

  const STATUS_TEXT = {
    active: ["सक्रिय", "ok", "यह वॉलेट सक्रिय है। अब आप माइनिंग कर सकते हैं।"],
    revoked: ["रद्द", "bad", "यह वॉलेट रद्द कर दिया गया है। इससे माइनिंग नहीं हो सकती।"],
    not_found: ["सक्रिय नहीं", "bad", "यह वॉलेट अभी सक्रिय नहीं हुआ। नीचे “वॉलेट सक्रिय करें” दबाएँ।"],
    unknown: ["पता नहीं", "", "स्थिति नहीं मिल सकी। इंटरनेट जाँचकर “दोबारा जाँचें” दबाएँ।"],
    loading: ["जाँच हो रही है…", "", ""],
  };

  let wallet = Vault.readPublic(localStorage); // { address, publicKey, publicKeyHex } या null
  let status = "loading";
  let busy = false;
  let triedActivate = false; // इस बार पेज खुलने पर अपने आप सक्रिय करने की कोशिश हो चुकी

  function say(node, text, kind) {
    node.textContent = text;
    node.className = "msg" + (kind ? " " + kind : "");
    node.hidden = !text;
  }

  async function call(name, init) {
    const res = await fetch(API + name, Object.assign({ cache: "no-store" }, init, {
      headers: Object.assign({}, HEADERS, init && init.body ? { "Content-Type": "application/json" } : {}),
    }));
    const body = await res.json();
    if (!body || typeof body.ok !== "boolean") throw new Error("format");
    return body;
  }

  // ---------- स्क्रीन ----------
  function render() {
    el.none.hidden = !!wallet;
    el.have.hidden = !wallet;
    if (!wallet) return;

    el.address.textContent = wallet.address;
    el.keyB64.textContent = wallet.publicKey;
    el.keyHex.textContent = wallet.publicKeyHex;

    const [label, kind, note] = STATUS_TEXT[status];
    el.status.textContent = label;
    el.status.className = "pill" + (kind ? " " + kind : "");
    el.statusNote.textContent = note;
    el.statusNote.hidden = !note;
    el.recheck.disabled = busy || status === "loading";

    el.activate.hidden = status !== "not_found";
    el.activate.disabled = busy;
    el.miner.classList.toggle("ready", status === "active");
  }

  async function refreshStatus() {
    if (!wallet) return;
    const address = wallet.address;
    status = "loading";
    render();
    let next = "unknown";
    try {
      const r = await call("wallet-status?address=" + encodeURIComponent(address));
      if (r.ok && STATUS_TEXT[r.status]) next = r.status;
    } catch (_) { /* इंटरनेट नहीं या function नहीं मिला */ }
    if (!wallet || wallet.address !== address) return;
    status = next;
    render();
    // वॉलेट बना है पर सर्वर पर दर्ज नहीं हुआ (जैसे बनाते समय इंटरनेट नहीं था): एक बार अपने आप कोशिश
    if (status === "not_found" && !triedActivate) activate();
  }

  // ---------- सक्रिय करना ----------
  // सर्वर को सिर्फ़ पता और public key जाते हैं। कोई कोड या PIN नहीं लगता।
  async function activate() {
    if (busy || !wallet) return;
    triedActivate = true;
    busy = true;
    render();
    say(el.activateMsg, "वॉलेट सक्रिय हो रहा है…", "");
    let ok = false;
    try {
      const r = await call("register", {
        method: "POST",
        body: JSON.stringify({ address: wallet.address, public_key: wallet.publicKey }),
      });
      ok = r.ok || r.code === "already_registered";
      say(el.activateMsg, ok ? "" : "सक्रिय नहीं हुआ: " + (r.reason || "सर्वर ने कारण नहीं बताया।"), ok ? "" : "bad");
    } catch (_) {
      say(el.activateMsg, "सर्वर से संपर्क नहीं हो सका। इंटरनेट जाँचकर “वॉलेट सक्रिय करें” दबाएँ।", "bad");
    }
    busy = false;
    render();
    if (ok) refreshStatus();
  }

  async function copyText(text, done) {
    try {
      await navigator.clipboard.writeText(text);
      say($("copy-msg"), done, "ok");
    } catch (_) {
      say($("copy-msg"), "कॉपी नहीं हो सका; टेक्स्ट को दबाकर रखें और खुद कॉपी करें।", "bad");
    }
  }

  // ---------- वॉलेट बनाना ----------
  el.create.addEventListener("click", async () => {
    if (busy || wallet) return;
    const pin = el.newPin.value, pin2 = el.newPin2.value;
    if (!/^\d{6}$/.test(pin)) return say(el.createMsg, "PIN ठीक 6 अंकों का होना चाहिए।", "bad");
    if (pin !== pin2) return say(el.createMsg, "दोनों बार PIN एक जैसा नहीं है।", "bad");
    if (!window.crypto || !window.crypto.subtle) {
      return say(el.createMsg, "यह ब्राउज़र ज़रूरी सुविधा (crypto) नहीं दे रहा। पेज को https पर खोलें।", "bad");
    }

    busy = true;
    el.create.disabled = true;
    say(el.createMsg, "वॉलेट बन रहा है…", "");
    try {
      wallet = await Vault.createWallet(localStorage, pin);
      el.newPin.value = el.newPin2.value = "";
      say(el.createMsg, "", "");
    } catch (err) {
      say(el.createMsg, err && typeof err.code === "string" ? err.message : "वॉलेट नहीं बन सका। दोबारा कोशिश करें।", "bad");
    }
    busy = false;
    el.create.disabled = false;
    render();
    if (wallet) {
      status = "not_found";
      activate(); // बनते ही सक्रिय
    }
  });

  // ---------- बाक़ी बटन ----------
  el.activate.addEventListener("click", activate);
  el.copyAddress.addEventListener("click", () => wallet && copyText(wallet.address, "पता कॉपी हो गया।"));
  el.copyKey.addEventListener("click", () => wallet && copyText(wallet.publicKey, "Public key कॉपी हो गई।"));
  el.recheck.addEventListener("click", () => { triedActivate = false; refreshStatus(); });

  el.remove.addEventListener("click", () => {
    if (!wallet) return;
    if (!confirm("यह वॉलेट इस फ़ोन से हमेशा के लिए हट जाएगा।\n\nबैकअप नहीं है, इसलिए यह वापस नहीं आ सकता, और इसमें जमा MNC भी नहीं निकल पाएँगे।\n\nक्या सच में हटाएँ?")) return;
    Vault.removeWallet(localStorage);
    wallet = null;
    status = "loading";
    triedActivate = false;
    say(el.activateMsg, "", "");
    render();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && wallet && status !== "active" && !busy) refreshStatus();
  });

  render();
  refreshStatus();
})();
