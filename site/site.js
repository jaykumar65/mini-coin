// MNC टेस्टनेट रिकॉर्ड साइट
// Supabase की `blocks` और `transfers` टेबल को सिर्फ़ पढ़ती है (GET)। लिखने का कोई कोड नहीं।

"use strict";

(function () {
  const CFG = window.MNC_SITE_CONFIG || {};
  const PAGE = 1000; // Supabase एक बार में अधिकतम इतनी पंक्तियाँ देता है

  const $ = (id) => document.getElementById(id);
  const el = {
    reload: $("btn-reload"),
    loading: $("loading"),
    error: $("error"),
    content: $("content"),
    count: $("stat-count"),
    supply: $("stat-supply"),
    chain: $("chain-status"),
    chainDetail: $("chain-detail"),
    balances: $("balances"),
    balancesEmpty: $("balances-empty"),
    blocks: $("blocks"),
    blocksEmpty: $("blocks-empty"),
    transfers: $("transfers"),
    transfersEmpty: $("transfers-empty"),
  };

  const fmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 8 });

  // ---------- Supabase से पढ़ना ----------
  async function fetchBlocks() {
    const base = String(CFG.supabaseUrl || "").replace(/\/+$/, "");
    if (!base || !CFG.supabaseKey) throw new Error("config");

    const headers = {
      apikey: CFG.supabaseKey,
      Authorization: "Bearer " + CFG.supabaseKey,
      Accept: "application/json",
    };
    const table = encodeURIComponent(CFG.table || "blocks");
    const rows = [];

    for (let offset = 0; ; offset += PAGE) {
      const url =
        base + "/rest/v1/" + table + "?select=*&order=idx.asc" +
        "&limit=" + PAGE + "&offset=" + offset;
      const res = await fetch(url, { headers, cache: "no-store" });
      if (!res.ok) {
        const err = new Error("http");
        err.status = res.status;
        throw err;
      }
      const page = await res.json();
      if (!Array.isArray(page)) throw new Error("format");
      rows.push(...page);
      if (page.length < PAGE) break;
    }
    return rows;
  }

  // लेन-देन (transfers)। टेबल अभी न बनी हो (404) तो खाली सूची।
  async function fetchTransfers() {
    const base = String(CFG.supabaseUrl || "").replace(/\/+$/, "");
    const headers = { apikey: CFG.supabaseKey, Authorization: "Bearer " + CFG.supabaseKey, Accept: "application/json" };
    const rows = [];
    for (let offset = 0; ; offset += PAGE) {
      const res = await fetch(
        base + "/rest/v1/transfers?select=id,from_addr,to_addr,amount,created_at&order=id.asc" +
        "&limit=" + PAGE + "&offset=" + offset,
        { headers, cache: "no-store" }
      );
      if (res.status === 404) return [];
      if (!res.ok) {
        const err = new Error("http");
        err.status = res.status;
        throw err;
      }
      const page = await res.json();
      if (!Array.isArray(page)) throw new Error("format");
      rows.push(...page);
      if (page.length < PAGE) break;
    }
    return rows;
  }

  function errorMessage(err) {
    const tail = " थोड़ी देर बाद “फिर से लोड करें” दबाएँ।";
    if (err && err.message === "config") {
      return "Supabase की जानकारी config.js में नहीं मिली, इसलिए रिकॉर्ड नहीं दिखाए जा सकते।";
    }
    if (err && err.message === "http") {
      if (err.status === 404) {
        return "Supabase से डेटा नहीं आया: `blocks` टेबल नहीं मिली (त्रुटि 404)। टेबल बनी है या नहीं, जाँचें।";
      }
      if (err.status === 401 || err.status === 403) {
        return "Supabase से डेटा नहीं आया: पढ़ने की अनुमति नहीं मिली (त्रुटि " + err.status + ")। Key और टेबल की read policy जाँचें।";
      }
      return "Supabase से डेटा नहीं आया (त्रुटि " + err.status + ")।" + tail;
    }
    if (err && err.message === "format") {
      return "Supabase से आया डेटा समझ में नहीं आया।" + tail;
    }
    return "Supabase से डेटा नहीं आ सका। इंटरनेट कनेक्शन जाँचें।" + tail;
  }

  // ---------- चेन की जाँच ----------
  // हर ब्लॉक के लिए: (1) prev_hash पिछले ब्लॉक के hash से मिले,
  // (2) hash की शुरुआत में difficulty जितने ज़ीरो हों।
  function normalize(row) {
    const difficulty = Number.isFinite(Number(row.difficulty)) && row.difficulty !== null
      ? Number(row.difficulty)
      : Number(CFG.defaultDifficulty || 0);
    const reward = row.reward !== undefined && row.reward !== null
      ? Number(row.reward)
      : Number(CFG.rewardPerBlock || 0);
    return {
      idx: Number(row.idx),
      prevHash: String(row.prev_hash == null ? "" : row.prev_hash),
      hash: String(row.hash == null ? "" : row.hash),
      nonce: row.nonce,
      difficulty,
      ts: row.ts != null ? row.ts : row.timestamp != null ? row.timestamp : row.created_at,
      miner: String(row.miner == null ? "" : row.miner),
      reward: Number.isFinite(reward) ? reward : 0,
    };
  }

  function validate(blocks) {
    let firstBad = -1;
    blocks.forEach((b, i) => {
      const problems = [];
      if (!b.hash.startsWith("0".repeat(Math.max(0, b.difficulty)))) {
        problems.push("hash की शुरुआत में " + b.difficulty + " ज़ीरो नहीं हैं");
      }
      if (i > 0) {
        const prev = blocks[i - 1];
        if (b.prevHash !== prev.hash) problems.push("prev_hash पिछले ब्लॉक के hash से नहीं मिलता");
        if (b.idx !== prev.idx + 1) problems.push("ब्लॉक नंबर क्रम में नहीं है");
      }
      b.problems = problems;
      if (problems.length && firstBad === -1) firstBad = i;
    });
    // पहली गड़बड़ी के बाद की पूरी चेन भरोसे लायक नहीं
    blocks.forEach((b, i) => { b.trusted = firstBad === -1 || i < firstBad; });
    return firstBad;
  }

  // बैलेंस = मिले इनाम + आए हुए कॉइन - भेजे हुए कॉइन
  function balancesOf(blocks, transfers) {
    const totals = new Map();
    for (const b of blocks) {
      if (!b.trusted) continue;
      const who = b.miner || "(अज्ञात)";
      const cur = totals.get(who) || { amount: 0, blocks: 0 };
      cur.amount += b.reward;
      cur.blocks += 1;
      totals.set(who, cur);
    }
    const entry = (who) => {
      if (!totals.has(who)) totals.set(who, { amount: 0, blocks: 0 });
      return totals.get(who);
    };
    for (const t of transfers) {
      const amount = Number(t.amount) || 0;
      entry(String(t.from_addr)).amount -= amount;
      entry(String(t.to_addr)).amount += amount;
    }
    return [...totals.entries()].sort((a, b) => b[1].amount - a[1].amount);
  }

  // ---------- दिखाना ----------
  function cell(text, className) {
    const td = document.createElement("td");
    td.textContent = text;
    if (className) td.className = className;
    return td;
  }

  function formatTime(ts) {
    if (ts == null || ts === "") return "—";
    const n = Number(ts);
    const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(ts);
    return isNaN(d) ? "—" : d.toLocaleString("hi-IN");
  }

  function shortHash(h) {
    return h.length > 20 ? h.slice(0, 12) + "…" + h.slice(-6) : h || "—";
  }

  function render(blocks, transfers) {
    const firstBad = validate(blocks);
    const balances = balancesOf(blocks, transfers);
    const supply = balances.reduce((a, [, v]) => a + v.amount, 0);

    el.count.textContent = fmt.format(blocks.length);
    el.supply.textContent = fmt.format(supply) + " MNC";

    el.chain.className = "chain " + (blocks.length === 0 ? "" : firstBad === -1 ? "ok" : "bad");
    if (blocks.length === 0) {
      el.chain.textContent = "चेन खाली है";
      el.chainDetail.textContent = "अभी तक कोई ब्लॉक दर्ज नहीं हुआ।";
    } else if (firstBad === -1) {
      el.chain.textContent = "✓ चेन सही है";
      el.chainDetail.textContent = "सभी " + fmt.format(blocks.length) + " ब्लॉक में prev_hash और difficulty के ज़ीरो मिल गए।";
    } else {
      const b = blocks[firstBad];
      el.chain.textContent = "✗ चेन में गड़बड़ी है";
      el.chainDetail.textContent =
        "ब्लॉक #" + b.idx + ": " + b.problems.join("; ") +
        "। इस ब्लॉक और इसके बाद के ब्लॉक बैलेंस में नहीं गिने गए।";
    }

    el.balances.replaceChildren(
      ...balances.map(([who, v]) => {
        const tr = document.createElement("tr");
        tr.append(cell(who, "addr"), cell(fmt.format(v.blocks), "num"), cell(fmt.format(v.amount), "num"));
        return tr;
      })
    );
    el.balancesEmpty.hidden = balances.length > 0;

    el.blocks.replaceChildren(
      ...blocks.slice().reverse().map((b) => {
        const tr = document.createElement("tr");
        if (!b.trusted) tr.className = "bad";
        const hash = cell(shortHash(b.hash), "mono");
        hash.title = b.hash;
        const prev = cell(shortHash(b.prevHash), "mono");
        prev.title = b.prevHash;
        const state = cell(
          b.problems.length ? "✗ " + b.problems.join("; ") : b.trusted ? "✓ सही" : "— पहले की गड़बड़ी के बाद",
          b.problems.length ? "state bad" : b.trusted ? "state ok" : "state"
        );
        tr.append(
          cell("#" + b.idx, "num"),
          hash,
          prev,
          cell(b.nonce == null ? "—" : fmt.format(Number(b.nonce)), "num"),
          cell(String(b.difficulty), "num"),
          cell(b.miner || "—", "addr"),
          cell(formatTime(b.ts)),
          state
        );
        return tr;
      })
    );
    el.blocksEmpty.hidden = blocks.length > 0;

    // लेन-देन: नए से पुराने
    el.transfers.replaceChildren(
      ...transfers.slice().reverse().map((t) => {
        const tr = document.createElement("tr");
        const from = cell(shortHash(String(t.from_addr)), "mono");
        from.title = t.from_addr;
        const to = cell(shortHash(String(t.to_addr)), "mono");
        to.title = t.to_addr;
        tr.append(cell("#" + t.id, "num"), from, to, cell(fmt.format(Number(t.amount)), "num"), cell(formatTime(t.created_at)));
        return tr;
      })
    );
    el.transfersEmpty.hidden = transfers.length > 0;
  }

  async function load() {
    el.reload.disabled = true;
    el.loading.hidden = false;
    el.error.hidden = true;
    try {
      const got = await Promise.all([fetchBlocks(), fetchTransfers()]);
      render(got[0].map(normalize), got[1]);
      el.content.hidden = false;
    } catch (err) {
      el.content.hidden = true;
      el.error.textContent = errorMessage(err);
      el.error.hidden = false;
    } finally {
      el.loading.hidden = true;
      el.reload.disabled = false;
    }
  }

  el.reload.addEventListener("click", load);
  load();
})();
