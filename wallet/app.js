// MNC Wallet (TESTNET) — स्क्रीन का लॉजिक
//
// काम: वॉलेट बनाना (PIN के साथ), पता और स्थिति दिखाना, इनवाइट कोड से रजिस्टर करना,
// और सक्रिय वॉलेट के लिए नया इनवाइट बनाना (PIN से हस्ताक्षर करके)।
// कुंजी और PIN का काम vault.js में है। सर्वर को सिर्फ़ पता, public key, इनवाइट कोड
// और हस्ताक्षर जाते हैं; private key और PIN कभी नहीं।

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
    registerBox: $("box-register"), code: $("invite-code"), register: $("btn-register"), registerMsg: $("register-msg"),
    inviteBox: $("box-invite"), pin: $("pin"), invite: $("btn-invite"), inviteMsg: $("invite-msg"),
    inviteResult: $("invite-result"), inviteCode: $("invite-new-code"), copyInvite: $("btn-copy-invite"),
    remove: $("btn-remove"),
  };

  const STATUS_TEXT = {
    active: ["सक्रिय", "ok", "यह वॉलेट सक्रिय है। आप माइनिंग कर सकते हैं और दूसरों को इनवाइट दे सकते हैं।"],
    revoked: ["रद्द", "bad", "यह वॉलेट रद्द कर दिया गया है। इससे माइनिंग नहीं हो सकती।"],
    not_found: ["सक्रिय नहीं", "bad", "यह वॉलेट अभी रजिस्टर नहीं है। नीचे इनवाइट कोड डालकर रजिस्टर करें।"],
    unknown: ["पता नहीं", "", "स्थिति नहीं मिल सकी। इंटरनेट जाँचकर “दोबारा जाँचें” दबाएँ।"],
    loading: ["जाँच हो रही है…", "", ""],
  };

  let wallet = Vault.readPublic(localStorage); // { address, publicKey, publicKeyHex } या null
  let status = "loading";
  let busy = false;

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

  const post = (name, data) => call(name, { method: "POST", body: JSON.stringify(data) });

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
    el.recheck.disabled = status === "loading";

    el.registerBox.hidden = status !== "not_found";
    el.inviteBox.hidden = status !== "active";
    el.register.disabled = busy;
    renderLock();
  }

  // गलत PIN की रुकावट: बटन बंद और उलटी गिनती
  function renderLock() {
    if (!wallet) return;
    const lock = Vault.lockState(localStorage);
    el.invite.disabled = busy || lock.locked;
    el.pin.disabled = lock.locked;
    if (lock.locked) {
      say(el.inviteMsg, "5 बार गलत PIN डाला गया। " + Math.ceil(lock.waitMs / 1000) + " सेकंड बाद कोशिश करें।", "bad");
    } else if (el.inviteMsg.dataset.lock === "1") {
      say(el.inviteMsg, "", "");
    }
    el.inviteMsg.dataset.lock = lock.locked ? "1" : "";
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
  }

  async function copyText(text, node, done) {
    try {
      await navigator.clipboard.writeText(text);
      say(node, done, "ok");
    } catch (_) {
      say(node, "कॉपी नहीं हो सका; टेक्स्ट को दबाकर रखें और खुद कॉपी करें।", "bad");
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
    refreshStatus();
  });

  // ---------- रजिस्टर ----------
  el.register.addEventListener("click", async () => {
    if (busy || !wallet) return;
    const code = el.code.value.trim().toUpperCase();
    if (!code) return say(el.registerMsg, "इनवाइट कोड लिखें।", "bad");

    busy = true;
    render();
    say(el.registerMsg, "रजिस्टर हो रहा है…", "");
    try {
      const r = await post("register", { address: wallet.address, public_key: wallet.publicKey, invite_code: code });
      if (r.ok) {
        el.code.value = "";
        say(el.registerMsg, "", "");
        busy = false;
        return refreshStatus();
      }
      say(el.registerMsg, "रजिस्टर नहीं हुआ: " + (r.reason || "सर्वर ने कारण नहीं बताया।"), "bad");
    } catch (_) {
      say(el.registerMsg, "सर्वर से संपर्क नहीं हो सका। इंटरनेट जाँचकर दोबारा कोशिश करें।", "bad");
    }
    busy = false;
    render();
  });

  // ---------- इनवाइट बनाना ----------
  el.invite.addEventListener("click", async () => {
    if (busy || !wallet || status !== "active") return;
    const pin = el.pin.value;
    el.inviteResult.hidden = true;

    busy = true;
    render();
    say(el.inviteMsg, "इनवाइट बन रहा है…", "");
    try {
      // हस्ताक्षर इसी डिवाइस पर बनता है; सर्वर को सिर्फ़ संदेश और हस्ताक्षर जाते हैं
      const message = Vault.inviteMessage(wallet.address, Date.now());
      const signature = await Vault.sign(localStorage, pin, message);
      el.pin.value = "";
      const r = await post("create-invite", { address: wallet.address, message, signature });
      if (r.ok) {
        el.inviteCode.textContent = r.code;
        el.inviteResult.hidden = false;
        say(el.inviteMsg, "नया इनवाइट कोड बन गया। इस महीने " + r.left_this_month + " और बना सकते हैं।", "ok");
      } else {
        say(el.inviteMsg, "इनवाइट नहीं बना: " + (r.reason || "सर्वर ने कारण नहीं बताया।"), "bad");
        if (r.code === "wallet_inactive" || r.code === "not_registered") refreshStatus();
      }
    } catch (err) {
      if (err && typeof err.code === "string") {
        el.pin.value = "";
        say(el.inviteMsg, err.message, "bad");
      } else {
        say(el.inviteMsg, "सर्वर से संपर्क नहीं हो सका। इंटरनेट जाँचकर दोबारा कोशिश करें।", "bad");
      }
    }
    busy = false;
    render();
  });

  // ---------- बाक़ी बटन ----------
  el.copyAddress.addEventListener("click", () => wallet && copyText(wallet.address, $("copy-msg"), "पता कॉपी हो गया।"));
  el.copyKey.addEventListener("click", () => wallet && copyText(wallet.publicKey, $("copy-msg"), "Public key कॉपी हो गई।"));
  el.copyInvite.addEventListener("click", () => copyText(el.inviteCode.textContent, el.inviteMsg, "इनवाइट कोड कॉपी हो गया।"));
  el.recheck.addEventListener("click", refreshStatus);

  el.remove.addEventListener("click", () => {
    if (!wallet) return;
    if (!confirm("यह वॉलेट इस फ़ोन से हमेशा के लिए हट जाएगा।\n\nबैकअप नहीं है, इसलिए यह वापस नहीं आ सकता, और इसका इनवाइट कोड भी दोबारा काम नहीं करेगा।\n\nक्या सच में हटाएँ?")) return;
    Vault.removeWallet(localStorage);
    wallet = null;
    status = "loading";
    el.inviteResult.hidden = true;
    render();
  });

  setInterval(renderLock, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && wallet && status !== "active") refreshStatus();
  });

  render();
  refreshStatus();
})();
