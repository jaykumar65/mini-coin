// MNC Wallet (TESTNET) — कुंजी और PIN वाला हिस्सा (कोई UI नहीं, कोई नेटवर्क नहीं)
//
// वॉलेट = एक ECDSA P-256 कुंजी-जोड़ी, जो इसी डिवाइस पर बनती है।
//   - Private key (PKCS8) सिर्फ़ एन्क्रिप्ट होकर localStorage में जाती है:
//       AES-GCM, और AES की कुंजी 6 अंकों के PIN से PBKDF2 (SHA-256, random salt) से बनती है।
//     सादे रूप में वह कभी सेव नहीं होती और किसी API कॉल में नहीं जाती।
//   - Public key और पता सादे रूप में रहते हैं (ये सार्वजनिक हैं)।
//
// localStorage:
//   mnc_wallet_pub       { v, address, public_key }     <- माइनर सिर्फ़ यही पढ़ता है
//   mnc_wallet_vault     { v, iterations, salt, iv, data }   (एन्क्रिप्टेड private key)
//   mnc_wallet_pin_lock  { fails, until }               गलत PIN की गिनती
//
// पता और हस्ताक्षर का तरीक़ा वही है जो सर्वर पर supabase/functions/_shared/auth.ts में है।
// यह फ़ाइल ब्राउज़र और Node (टेस्ट) दोनों में चलती है: globalThis.MNCVault

"use strict";

(function (root) {
  const subtle = root.crypto.subtle;
  const enc = new TextEncoder();

  const EC = { name: "ECDSA", namedCurve: "P-256" };
  const SIGN = { name: "ECDSA", hash: "SHA-256" };
  const PUB_KEY = "mnc_wallet_pub";
  const VAULT_KEY = "mnc_wallet_vault";
  const LOCK_KEY = "mnc_wallet_pin_lock";

  const PBKDF2_ITERATIONS = 300000; // कम से कम 200000
  const MAX_FAILS = 5;              // इतनी बार गलत PIN पर रुकावट
  const LOCK_MS = 60 * 1000;        // रुकावट: 1 मिनट
  const PIN_RE = /^\d{6}$/;
  const ADDRESS_RE = /^MNC[0-9a-f]{40}$/;

  // ---------- बाइट, hex, base64 ----------
  function toHex(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
    return s;
  }

  function bytesToBase64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function base64ToBytes(text) {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function fail(code, message, extra) {
    return Object.assign(new Error(message), { code }, extra || {});
  }

  // ---------- पता ----------
  // पता = "MNC" + SHA-256(public key raw, 65 बाइट) के hex के पहले 40 अक्षर
  async function deriveAddress(publicKeyRaw) {
    return "MNC" + toHex(new Uint8Array(await subtle.digest("SHA-256", publicKeyRaw))).slice(0, 40);
  }

  // ---------- सेव की हुई चीज़ें ----------
  function readJson(storage, key) {
    try {
      return JSON.parse(storage.getItem(key) || "null");
    } catch (_) {
      return null;
    }
  }

  // { address, publicKey (base64), publicKeyHex } या null
  function readPublic(storage) {
    const p = readJson(storage, PUB_KEY);
    if (!p || !ADDRESS_RE.test(p.address) || typeof p.public_key !== "string") return null;
    if (!readJson(storage, VAULT_KEY)) return null;
    return { address: p.address, publicKey: p.public_key, publicKeyHex: toHex(base64ToBytes(p.public_key)) };
  }

  // ---------- PIN ----------
  async function pinKey(pin, salt, iterations) {
    const material = await subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveKey"]);
    return subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  // { locked, waitMs, left }  left = रुकावट से पहले बची कोशिशें
  function lockState(storage, now) {
    const t = now === undefined ? Date.now() : now;
    const lock = readJson(storage, LOCK_KEY) || {};
    const until = Number(lock.until) || 0;
    const fails = Number(lock.fails) || 0;
    if (until > t) return { locked: true, waitMs: until - t, left: 0 };
    return { locked: false, waitMs: 0, left: MAX_FAILS - Math.min(fails, MAX_FAILS - 1) };
  }

  function noteWrongPin(storage, now) {
    const lock = readJson(storage, LOCK_KEY) || {};
    const fails = (Number(lock.until) > now ? 0 : Number(lock.fails) || 0) + 1;
    if (fails >= MAX_FAILS) {
      storage.setItem(LOCK_KEY, JSON.stringify({ fails: 0, until: now + LOCK_MS }));
      return 0;
    }
    storage.setItem(LOCK_KEY, JSON.stringify({ fails, until: 0 }));
    return MAX_FAILS - fails;
  }

  // PIN से private key खोलना (सिर्फ़ हस्ताक्षर के लिए; कुंजी बाहर नहीं निकाली जा सकती)
  async function unlock(storage, pin, now) {
    const t = now === undefined ? Date.now() : now;
    const vault = readJson(storage, VAULT_KEY);
    if (!vault) throw fail("no_wallet", "इस डिवाइस पर कोई वॉलेट नहीं है।");

    const state = lockState(storage, t);
    if (state.locked) {
      throw fail("locked", "5 बार गलत PIN डाला गया। " + Math.ceil(state.waitMs / 1000) + " सेकंड बाद कोशिश करें।", { waitMs: state.waitMs });
    }
    if (!PIN_RE.test(pin)) throw fail("bad_pin_format", "PIN ठीक 6 अंकों का होना चाहिए।");

    let pkcs8;
    try {
      const key = await pinKey(pin, base64ToBytes(vault.salt), vault.iterations);
      pkcs8 = await subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(vault.iv) }, key, base64ToBytes(vault.data));
    } catch (_) {
      const left = noteWrongPin(storage, t);
      if (left === 0) throw fail("locked", "5 बार गलत PIN डाला गया। 1 मिनट बाद कोशिश करें।", { waitMs: LOCK_MS });
      throw fail("bad_pin", "PIN गलत है। " + (left === 1 ? "1 कोशिश बची है।" : left + " कोशिशें बची हैं।"), { left });
    }
    storage.removeItem(LOCK_KEY);
    try {
      return await subtle.importKey("pkcs8", pkcs8, EC, false, ["sign"]);
    } finally {
      new Uint8Array(pkcs8).fill(0);
    }
  }

  // ---------- वॉलेट बनाना ----------
  async function createWallet(storage, pin) {
    if (readPublic(storage)) throw fail("exists", "इस डिवाइस पर वॉलेट पहले से है।");
    if (!PIN_RE.test(pin)) throw fail("bad_pin_format", "PIN ठीक 6 अंकों का होना चाहिए।");

    const pair = await subtle.generateKey(EC, true, ["sign", "verify"]);
    const publicKeyRaw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
    const pkcs8 = await subtle.exportKey("pkcs8", pair.privateKey);

    const salt = root.crypto.getRandomValues(new Uint8Array(16));
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const key = await pinKey(pin, salt, PBKDF2_ITERATIONS);
    const data = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, pkcs8));
    new Uint8Array(pkcs8).fill(0);

    const address = await deriveAddress(publicKeyRaw);
    storage.setItem(VAULT_KEY, JSON.stringify({
      v: 1, iterations: PBKDF2_ITERATIONS,
      salt: bytesToBase64(salt), iv: bytesToBase64(iv), data: bytesToBase64(data),
    }));
    storage.setItem(PUB_KEY, JSON.stringify({ v: 1, address, public_key: bytesToBase64(publicKeyRaw) }));
    storage.removeItem(LOCK_KEY);

    // जाँच: सेव हुई चीज़ इसी PIN से खुलती है और उसका हस्ताक्षर इस public key से सही निकलता है
    const probe = enc.encode("mnc-wallet-check");
    const signature = await subtle.sign(SIGN, await unlock(storage, pin), probe);
    if (!(await subtle.verify(SIGN, pair.publicKey, signature, probe))) {
      removeWallet(storage);
      throw fail("check_failed", "वॉलेट की जाँच नाकाम रही।");
    }
    return readPublic(storage);
  }

  function removeWallet(storage) {
    storage.removeItem(PUB_KEY);
    storage.removeItem(VAULT_KEY);
    storage.removeItem(LOCK_KEY);
  }

  // ---------- हस्ताक्षर ----------
  // हस्ताक्षर: raw r || s (64 बाइट), base64 में। PIN गलत हो तो code वाला Error।
  async function sign(storage, pin, message, now) {
    const key = await unlock(storage, pin, now);
    return bytesToBase64(new Uint8Array(await subtle.sign(SIGN, key, enc.encode(message))));
  }

  // माइनिंग सत्र के लिए संदेश। सर्वर (supabase/functions/mining-session) यही रूप जाँचता है।
  function mineMessage(address, ts) {
    return "MNC-MINE-V1|" + address + "|" + ts;
  }

  // ---------- MNC भेजना ----------
  // संदेश सर्वर (supabase/functions/transfer) जैसा ही। रकम और फ़ीस पूर्णांक इकाई (units) में।
  function transferMessage(from, to, amountUnits, feeUnits, seq) {
    return "MNC-TRANSFER-V2|" + from + "|" + to + "|" + amountUnits + "|" + feeUnits + "|" + seq;
  }

  function toB64url(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // transfer function के लिए: { pub_x, pub_y, sig (hex) }। PIN गलत हो तो code वाला Error।
  async function signTransfer(storage, pin, to, amountUnits, feeUnits, seq, now) {
    const pub = readPublic(storage);
    if (!pub) throw fail("no_wallet", "इस डिवाइस पर कोई वॉलेट नहीं है।");
    const raw = base64ToBytes(pub.publicKey); // 04 || x || y
    const key = await unlock(storage, pin, now);
    const message = enc.encode(transferMessage(pub.address, to, String(amountUnits), String(feeUnits), seq));
    return {
      pub_x: toB64url(raw.slice(1, 33)),
      pub_y: toB64url(raw.slice(33, 65)),
      sig: toHex(new Uint8Array(await subtle.sign(SIGN, key, message))),
    };
  }

  root.MNCVault = {
    PUB_KEY, MAX_FAILS, LOCK_MS, PBKDF2_ITERATIONS,
    readPublic, createWallet, removeWallet, lockState, sign,
    mineMessage, transferMessage, signTransfer,
    deriveAddress, toHex, bytesToBase64, base64ToBytes,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
