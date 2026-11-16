// MNC टेस्टनेट वॉलेट — गणित वाला हिस्सा (कोई UI नहीं, कोई नेटवर्क नहीं)
//
// इसमें है:
//   - 12 शब्दों की कुंजी (128 बिट + 4 बिट जाँच) <-> बीज (seed)
//   - बीज या निजी कुंजी से P-256 कुंजी-जोड़ी और पता
//   - लेन-देन (transfer) पर हस्ताक्षर
//
// ध्यान रहे: ये 12 शब्द MNC के अपने हैं। ये Bitcoin/MetaMask वाले BIP39 शब्द नहीं हैं
// और किसी दूसरे वॉलेट ऐप में काम नहीं करेंगे।
//
// यह फ़ाइल ब्राउज़र और Node (टेस्ट) दोनों में चलती है: globalThis.MNCWalletCore

"use strict";

(function (root) {
  const subtle = root.crypto.subtle;
  const enc = new TextEncoder();

  // ---------- P-256 वक्र ----------
  const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
  const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const A = P - 3n;
  const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
  const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;

  const mod = (a) => ((a % P) + P) % P;

  function inverse(a) {
    // विस्तारित यूक्लिड: a^-1 mod P
    let [r0, r1, s0, s1] = [mod(a), P, 1n, 0n];
    while (r1 !== 0n) {
      const q = r0 / r1;
      [r0, r1] = [r1, r0 - q * r1];
      [s0, s1] = [s1, s0 - q * s1];
    }
    return mod(s0);
  }

  // बिंदु: null = अनंत पर बिंदु, वरना [x, y]
  function add(p, q) {
    if (!p) return q;
    if (!q) return p;
    const [x1, y1] = p, [x2, y2] = q;
    let m;
    if (x1 === x2) {
      if (mod(y1 + y2) === 0n) return null;
      m = mod((3n * x1 * x1 + A) * inverse(2n * y1));
    } else {
      m = mod((y2 - y1) * inverse(x2 - x1));
    }
    const x3 = mod(m * m - x1 - x2);
    return [x3, mod(m * (x1 - x3) - y1)];
  }

  // निजी संख्या d से सार्वजनिक बिंदु d*G
  function publicPoint(d) {
    let result = null, addend = [GX, GY];
    for (let k = d; k > 0n; k >>= 1n) {
      if (k & 1n) result = add(result, addend);
      addend = add(addend, addend);
    }
    return result;
  }

  // ---------- बाइट, hex, base64url ----------
  function toHex(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
    return s;
  }

  function fromHex(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  const bigToBytes = (n) => fromHex(n.toString(16).padStart(64, "0"));
  const bytesToBig = (b) => BigInt("0x" + toHex(b));

  function bytesToB64url(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlToBytes(s) {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function sha256(bytes) {
    return new Uint8Array(await subtle.digest("SHA-256", bytes));
  }

  // ---------- पता ----------
  const ADDRESS_RE = /^MNC[0-9a-f]{40}$/;
  const isAddress = (s) => typeof s === "string" && ADDRESS_RE.test(s);

  // पता = "MNC" + SHA-256(04 || x || y) के पहले 40 hex अक्षर
  async function addressOf(x, y) {
    const bx = b64urlToBytes(x), by = b64urlToBytes(y);
    if (bx.length !== 32 || by.length !== 32) throw new Error("key");
    const raw = new Uint8Array(65);
    raw[0] = 4;
    raw.set(bx, 1);
    raw.set(by, 33);
    return "MNC" + toHex(await sha256(raw)).slice(0, 40);
  }

  // ---------- कुंजी ----------
  // निजी संख्या d (BigInt) से पूरी कुंजी: { d, x, y (base64url), privateHex, address }
  async function keyFromScalar(d) {
    if (d <= 0n || d >= N) throw new Error("key");
    const [px, py] = publicPoint(d);
    const key = {
      d: bytesToB64url(bigToBytes(d)),
      x: bytesToB64url(bigToBytes(px)),
      y: bytesToB64url(bigToBytes(py)),
      privateHex: d.toString(16).padStart(64, "0"),
    };
    key.address = await addressOf(key.x, key.y);
    return key;
  }

  async function keyFromPrivateHex(hex) {
    const clean = String(hex || "").trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error("निजी कुंजी 64 hex अक्षरों की होनी चाहिए।");
    try {
      return await keyFromScalar(BigInt("0x" + clean));
    } catch (_) {
      throw new Error("यह निजी कुंजी मान्य नहीं है।");
    }
  }

  // बीज (16 बाइट) से कुंजी; हर बार वही बीज वही कुंजी देता है
  async function keyFromSeed(seed) {
    const tag = enc.encode("MNC-WALLET-V2");
    const input = new Uint8Array(tag.length + seed.length);
    input.set(tag);
    input.set(seed, tag.length);
    const d = (bytesToBig(await sha256(input)) % (N - 1n)) + 1n;
    const key = await keyFromScalar(d);
    key.seedHex = toHex(seed);
    return key;
  }

  // जाँच: ब्राउज़र का अपना crypto इस कुंजी-जोड़ी को सही मानता है (हस्ताक्षर करके परखना)
  async function selfCheck(key) {
    const EC = { name: "ECDSA", namedCurve: "P-256" };
    const pubJwk = { kty: "EC", crv: "P-256", x: key.x, y: key.y };
    const priv = await subtle.importKey("jwk", Object.assign({ d: key.d }, pubJwk), EC, false, ["sign"]);
    const pub = await subtle.importKey("jwk", pubJwk, EC, false, ["verify"]);
    const probe = enc.encode("mnc-wallet-check");
    const alg = { name: "ECDSA", hash: "SHA-256" };
    return subtle.verify(alg, pub, await subtle.sign(alg, priv, probe), probe);
  }

  // ---------- 12 शब्द ----------
  // हर शब्द 11 बिट का है: व्यंजन(16) स्वर(4) व्यंजन(8) स्वर(4) = 2048 शब्द, जैसे "bako", "mite"
  const C1 = "bdfghjklmnprstvz";
  const C2 = "klmnrstd";
  const V = "aeio";

  function wordOf(n) {
    return C1[n >> 7] + V[(n >> 5) & 3] + C2[(n >> 2) & 7] + V[n & 3];
  }

  function indexOfWord(w) {
    if (w.length !== 4) return -1;
    const a = C1.indexOf(w[0]), b = V.indexOf(w[1]), c = C2.indexOf(w[2]), d = V.indexOf(w[3]);
    return a < 0 || b < 0 || c < 0 || d < 0 ? -1 : (a << 7) | (b << 5) | (c << 2) | d;
  }

  function newSeed() {
    return root.crypto.getRandomValues(new Uint8Array(16));
  }

  // 16 बाइट बीज -> 12 शब्द (128 बिट + SHA-256 के पहले 4 बिट जाँच के लिए)
  async function seedToWords(seed) {
    if (seed.length !== 16) throw new Error("seed");
    const check = (await sha256(seed))[0] >> 4;
    const bits = (bytesToBig(seed) << 4n) | BigInt(check); // 132 बिट
    const words = [];
    for (let i = 11; i >= 0; i--) words.push(wordOf(Number((bits >> BigInt(i * 11)) & 2047n)));
    return words;
  }

  // 12 शब्द -> बीज; शब्द गलत हों या जाँच न मिले तो हिंदी संदेश के साथ Error
  async function wordsToSeed(text) {
    const words = String(text || "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
    if (words.length !== 12) throw new Error("ठीक 12 शब्द चाहिए; आपने " + words.length + " लिखे हैं।");
    let bits = 0n;
    for (let i = 0; i < 12; i++) {
      const n = indexOfWord(words[i]);
      if (n < 0) throw new Error("शब्द " + (i + 1) + " (“" + words[i] + "”) सही नहीं है।");
      bits = (bits << 11n) | BigInt(n);
    }
    const seed = fromHex((bits >> 4n).toString(16).padStart(32, "0"));
    if (Number(bits & 15n) !== (await sha256(seed))[0] >> 4) {
      throw new Error("ये 12 शब्द आपस में मेल नहीं खाते। कोई शब्द गलत है या क्रम बदला हुआ है।");
    }
    return seed;
  }

  // ---------- लेन-देन पर हस्ताक्षर ----------
  // जिस संदेश पर हस्ताक्षर होता है। सर्वर (supabase/functions/transfer) बिल्कुल यही बनाता है।
  function transferMessage(from, to, amount, seq) {
    return "MNC-TRANSFER-V1|" + from + "|" + to + "|" + amount + "|" + seq;
  }

  // हस्ताक्षर: 64 बाइट (r || s), hex में
  async function signTransfer(key, to, amount, seq) {
    const priv = await subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: key.x, y: key.y, d: key.d },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    );
    const message = enc.encode(transferMessage(key.address, to, amount, seq));
    return toHex(new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, message)));
  }

  root.MNCWalletCore = {
    isAddress, addressOf,
    newSeed, seedToWords, wordsToSeed,
    keyFromSeed, keyFromPrivateHex, selfCheck,
    transferMessage, signTransfer,
    toHex, fromHex, b64urlToBytes, bytesToB64url,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
