// MiniCoin होम — वॉलेट का छोटा स्टेटस और service worker
// (ऐप इंस्टॉल अपने-अपने पेज से होते हैं: /miner/?install=1, /pay/?install=1)
//
// पता माइनर वॉलेट (wallet/vault.js) के localStorage से पढ़ा जाता है; private key या PIN नहीं।
// स्थिति wallet-status Edge Function से आती है (active / revoked / not_found)। सिर्फ़ पढ़ना है।

"use strict";

(function () {
  const CFG = window.MNC_CONFIG || {};
  const API = String(CFG.supabaseUrl || "").replace(/\/+$/, "");
  const HEADERS = { apikey: CFG.supabaseKey, Authorization: "Bearer " + CFG.supabaseKey };
  const ADDRESS_RE = /^MNC[0-9a-f]{40}$/;

  const $ = (id) => document.getElementById(id);

  // माइनर वॉलेट का सार्वजनिक पता (wallet/vault.js जैसी ही जाँच: पता सही हो और तिजोरी मौजूद हो)
  function walletAddress() {
    try {
      const pub = JSON.parse(localStorage.getItem("mnc_wallet_pub") || "null");
      if (!pub || !ADDRESS_RE.test(pub.address)) return "";
      if (!localStorage.getItem("mnc_wallet_vault")) return "";
      return pub.address;
    } catch (_) {
      return "";
    }
  }

  const STATUS = {
    active: { text: "सक्रिय", cls: "ok" },
    revoked: { text: "रद्द किया गया", cls: "bad" },
    not_found: { text: "अभी सक्रिय नहीं; वॉलेट खोलें", cls: "warn" },
    unknown: { text: "स्थिति नहीं मिली (इंटरनेट?)", cls: "warn" },
    loading: { text: "जाँच हो रही है…", cls: "" },
  };

  function show(address, status) {
    $("ws-address").textContent = address ? address.slice(0, 9) + "…" + address.slice(-6) : "इस फ़ोन पर माइनर वॉलेट नहीं है";
    $("ws-address").title = address || "";
    const s = address ? STATUS[status] || STATUS.unknown : { text: "“वॉलेट” दबाकर बनाएँ", cls: "" };
    const badge = $("ws-status");
    badge.textContent = s.text;
    badge.className = "badge" + (s.cls ? " " + s.cls : "");
  }

  async function refresh() {
    const address = walletAddress();
    if (!address) return show("", "");
    show(address, "loading");
    let status = "unknown";
    try {
      const res = await fetch(API + "/functions/v1/wallet-status?address=" + encodeURIComponent(address), {
        headers: HEADERS,
        cache: "no-store",
      });
      const body = await res.json();
      if (body && body.ok && STATUS[body.status]) status = body.status;
    } catch (_) { /* "unknown" */ }
    if (walletAddress() === address) show(address, status);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  refresh();

  // ---------- PWA ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => { /* जैसे file:// पर: होम फिर भी चले */ });
    });
  }

})();
