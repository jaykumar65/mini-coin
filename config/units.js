// MNC टेस्टनेट — रकम का हिसाब (ब्राउज़र के सभी ऐप के लिए)
//
// संख्याएँ config/chain.json से आती हैं; यहाँ कोई संख्या सीधे नहीं लिखी।
// रकम हमेशा पूर्णांक इकाई (units) में रखी जाती है, BigInt में; float कभी नहीं।
//   1 MNC = unit_per_mnc units
//
// इस्तेमाल:
//   const chain = await MNCUnits.load("../config/chain.json");
//   MNCUnits.toUnits("12.5", chain)  -> 12500000n  (गलत हो तो null)
//   MNCUnits.format(12500000n, chain) -> "12.5"
//   MNCUnits.feeUnits(chain)          -> treasury भरा हो तो fee_units, वरना 0n
// ब्राउज़र और Node (टेस्ट) दोनों में चलती है: globalThis.MNCUnits

"use strict";

(function (root) {
  const ADDRESS_RE = /^MNC[0-9a-f]{40}$/;

  async function load(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("chain.json " + res.status);
    const c = await res.json();
    if (!Number.isSafeInteger(c.unit_per_mnc) || !Number.isSafeInteger(c.decimals)) throw new Error("chain.json format");
    return c;
  }

  // "12.5" / "12" / "0.000001" -> BigInt इकाई; खाली, ऋणात्मक या ज़्यादा दशमलव अंक हों तो null
  function toUnits(text, chain) {
    const m = /^(\d+)(?:[.,](\d*))?$/.exec(String(text == null ? "" : text).trim());
    if (!m || (m[2] || "").length > chain.decimals) return null;
    return BigInt(m[1]) * BigInt(chain.unit_per_mnc) + BigInt((m[2] || "").padEnd(chain.decimals, "0") || "0");
  }

  // BigInt / पूर्णांक टेक्स्ट -> "12.5" (भारतीय ढंग से कॉमा: 1,23,456.5)
  function format(units, chain) {
    const u = BigInt(units);
    const unit = BigInt(chain.unit_per_mnc);
    const neg = u < 0n;
    const abs = neg ? -u : u;
    const whole = new Intl.NumberFormat("en-IN").format(abs / unit);
    const frac = (abs % unit).toString().padStart(chain.decimals, "0").replace(/0+$/, "");
    return (neg ? "−" : "") + whole + (frac ? "." + frac : "");
  }

  function feeUnits(chain) {
    return ADDRESS_RE.test(chain.treasury || "") ? BigInt(chain.fee_units) : 0n;
  }

  root.MNCUnits = { load, toUnits, format, feeUnits };
})(typeof globalThis !== "undefined" ? globalThis : self);
