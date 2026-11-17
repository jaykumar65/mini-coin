// MNC टेस्टनेट एक्सप्लोरर — सिर्फ़ पढ़ता है
//
// स्रोत (Supabase, publishable key से, सिर्फ़ GET / पढ़ने वाले RPC):
//   blocks          पुराने proof-of-work ब्लॉक (reward पूरे MNC में)
//   mining_rounds   3 मिनट के राउंड (reward_units, इकाई में)
//   transactions    नई ट्रांजैक्शन टेबल (site/schema_transactions.sql): pending / confirmed
//   transfers       पुराने लेन-देन (MNC Pay); इन्हें "कन्फ़र्म" माना जाता है, ब्लॉक नंबर नहीं होता
//   mnc_balance_units(addr)  किसी पते का बैलेंस (इकाई में)
//
// सारी गणना पूर्णांक इकाई में BigInt से होती है; MNC में बदलना (÷ unit_per_mnc) सिर्फ़ दिखाते समय।
// Supabase एक बार में 1000 पंक्तियाँ देता है, इसलिए हर टेबल limit + offset से पन्ने-दर-पन्ने पढ़ी जाती है।
// इस पेज पर लिखने वाला कोई फ़ॉर्म या कॉल नहीं है।

"use strict";

(function () {
  const CFG = window.MNC_CONFIG || {};
  const Units = window.MNCUnits;
  const API = String(CFG.supabaseUrl || "").replace(/\/+$/, "");
  const HEADERS = { apikey: CFG.supabaseKey, Authorization: "Bearer " + CFG.supabaseKey, Accept: "application/json" };
  const PAGE = 1000;       // Supabase की एक बार की सीमा
  const SHOW = 25;         // सूची में एक बार में कितनी पंक्तियाँ
  const ADDRESS_RE = /^MNC[0-9a-f]{40}$/;
  const HASH_RE = /^[0-9a-f]{64}$/;

  const $ = (id) => document.getElementById(id);

  let chain = null;
  let unit = 1000000n;
  let data = null;         // { blocks, rounds, txs, treasury: { balance, fees } }
  let shownBlocks = SHOW;
  let shownTxs = SHOW;

  // ---------- रकम ----------
  const big = (v) => {
    if (v === null || v === undefined || v === "") return 0n;
    return BigInt(String(v).split(".")[0]); // bigint कॉलम पूर्णांक ही होते हैं
  };

  // पूरे MNC (जैसे blocks.reward, "50") -> इकाई
  function mncToUnits(v) {
    const u = Units.toUnits(String(v), chain);
    return u === null ? 0n : u;
  }

  // इकाई -> "1,23,456.000000" (हमेशा decimals जितने अंक)
  function fmt(units) {
    const u = big(units);
    const neg = u < 0n;
    const abs = neg ? -u : u;
    const whole = new Intl.NumberFormat("en-IN").format(abs / unit);
    const frac = (abs % unit).toString().padStart(chain.decimals, "0");
    return (neg ? "−" : "") + whole + "." + frac;
  }

  const short = (s, a, b) => (s && s.length > a + b + 1 ? s.slice(0, a) + "…" + s.slice(-b) : s || "—");
  const when = (v) => {
    if (v === null || v === undefined || v === "") return "—";
    const n = Number(v);
    const d = Number.isFinite(n) ? new Date(n) : new Date(v);
    return isNaN(d) ? "—" : d.toLocaleString("hi-IN");
  };

  // ---------- पढ़ना ----------
  // पूरी टेबल पन्ने-दर-पन्ने; टेबल न हो (404) तो null
  async function readAll(table, select, order) {
    const rows = [];
    for (let offset = 0; ; offset += PAGE) {
      const res = await fetch(
        API + "/rest/v1/" + table + "?select=" + select + "&order=" + order + "&limit=" + PAGE + "&offset=" + offset,
        { headers: HEADERS, cache: "no-store" }
      );
      if (res.status === 404) return null;
      if (!res.ok) {
        const err = new Error(table);
        err.status = res.status;
        throw err;
      }
      const page = await res.json();
      if (!Array.isArray(page)) throw new Error(table + " format");
      rows.push(...page);
      if (page.length < PAGE) return rows;
    }
  }

  async function balanceUnits(address) {
    const res = await fetch(API + "/rest/v1/rpc/mnc_balance_units", {
      method: "POST", // पढ़ने वाला function; कुछ लिखता नहीं
      headers: Object.assign({ "Content-Type": "application/json" }, HEADERS),
      body: JSON.stringify({ addr: address }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error("balance " + res.status);
    return big(await res.json());
  }

  async function load() {
    const [blocks, rounds, txs, transfers] = await Promise.all([
      readAll("blocks", "idx,prev_hash,hash,nonce,difficulty,ts,data,miner,reward,created_at", "idx.desc"),
      readAll("mining_rounds", "round_no,started_at,participants,reward_units,share_units", "round_no.desc"),
      readAll("transactions", "tx_hash,from_addr,to_addr,amount_units,fee_units,nonce,signature,status,block_idx,created_at", "created_at.desc"),
      readAll("transfers", "id,from_addr,to_addr,amount,amount_units,fee_units,fee_to,seq,created_at", "id.desc"),
    ]);

    // एक सूची: नई transactions + पुराने transfers (कन्फ़र्म, बिना ब्लॉक)
    const list = (txs || []).map((t) => ({
      kind: "tx",
      id: t.tx_hash,
      from: t.from_addr,
      to: t.to_addr,
      amount: big(t.amount_units),
      fee: big(t.fee_units),
      feeToTreasury: true, // नई टेबल में फ़ीस हमेशा ट्रेज़री की
      nonce: t.nonce,
      signature: t.signature,
      status: t.status === "confirmed" ? "confirmed" : "pending",
      block: t.block_idx,
      time: t.created_at,
    })).concat((transfers || []).map((t) => ({
      kind: "transfer",
      id: "transfer-" + t.id,
      from: t.from_addr,
      to: t.to_addr,
      amount: t.amount_units !== null && t.amount_units !== undefined ? big(t.amount_units) : mncToUnits(t.amount),
      fee: big(t.fee_units),
      feeTo: t.fee_to || "",
      nonce: t.seq,
      status: "confirmed",
      block: null,
      time: t.created_at,
    })));
    list.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));

    const treasury = ADDRESS_RE.test(chain.treasury || "") ? chain.treasury : "";
    const fees = list.filter((t) => t.status === "confirmed" && t.fee > 0n &&
      (t.kind === "tx" ? true : treasury && t.feeTo === treasury));
    let treasuryBalance = null;
    if (treasury) {
      try { treasuryBalance = await balanceUnits(treasury); } catch (_) { treasuryBalance = null; }
    }

    data = {
      blocks: blocks || [],
      rounds: rounds || [],
      list,
      txTableMissing: txs === null,
      treasury: { address: treasury, balance: treasuryBalance, fees },
    };
  }

  // ---------- दिखाना ----------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function td(text, cls, title) {
    const c = el("td", cls, text);
    if (title) c.title = title;
    return c;
  }

  function pill(status) {
    return el("span", "pill " + status, status === "confirmed" ? "कन्फ़र्म" : "पेंडिंग");
  }

  function renderSummary() {
    const issuedBlocks = data.blocks.reduce((s, b) => s + mncToUnits(b.reward), 0n);
    const issuedRounds = data.rounds.reduce((s, r) => s + big(r.reward_units), 0n);
    const fees = data.treasury.fees.reduce((s, t) => s + t.fee, 0n);
    const pending = data.list.filter((t) => t.status === "pending").length;

    $("s-blocks").textContent = new Intl.NumberFormat("en-IN").format(data.blocks.length);
    $("s-rounds").textContent = "+ " + new Intl.NumberFormat("en-IN").format(data.rounds.length) + " राउंड";
    $("s-issued").textContent = fmt(issuedBlocks + issuedRounds);
    $("s-issued-note").textContent = "अधिकतम " + new Intl.NumberFormat("en-IN").format(chain.max_supply_mnc) + " MNC";
    $("s-fees").textContent = fmt(fees);
    $("s-pending").textContent = String(pending);
  }

  function renderTreasury() {
    const t = data.treasury;
    $("t-address").textContent = t.address || "अभी तय नहीं (config/chain.json में treasury खाली है)";
    $("t-balance").textContent = !t.address ? "—" : t.balance === null ? "नहीं मिला" : fmt(t.balance) + " MNC";
    const body = $("t-fees");
    body.replaceChildren(...t.fees.map((x) => {
      const tr = el("tr");
      tr.tabIndex = 0;
      tr.append(td(short(x.id, 10, 6), "mono", x.id), td(short(x.from, 9, 6), "mono", x.from), td(fmt(x.fee), "num"), td(when(x.time)));
      tr.addEventListener("click", () => showTx(x));
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter") showTx(x); });
      return tr;
    }));
    $("t-empty").hidden = t.fees.length > 0;
  }

  function blockRow(b) {
    const tr = el("tr");
    tr.tabIndex = 0;
    tr.append(
      td("#" + b.idx, "num"),
      td(short(b.miner, 9, 6), "mono", b.miner),
      td(fmt(mncToUnits(b.reward)), "num"),
      td(when(b.created_at || b.ts)),
      td(short(b.hash, 10, 6), "mono", b.hash),
      td(new Intl.NumberFormat("en-IN").format(Number(b.nonce)), "num"),
      td(String(b.difficulty), "num")
    );
    tr.addEventListener("click", () => showBlock(b));
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter") showBlock(b); });
    return tr;
  }

  function txRow(t) {
    const tr = el("tr", t.status);
    tr.tabIndex = 0;
    const st = el("td");
    st.append(pill(t.status));
    tr.append(
      td(t.kind === "transfer" ? "लेन-देन " + t.id.slice(9) : short(t.id, 10, 6), "mono", t.id),
      td(short(t.from, 9, 6) + " → " + short(t.to, 9, 6), "mono", t.from + " → " + t.to),
      td(fmt(t.amount), "num"),
      td(fmt(t.fee), "num"),
      st,
      td(t.block === null || t.block === undefined ? "—" : "#" + t.block, "num")
    );
    tr.addEventListener("click", () => showTx(t));
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter") showTx(t); });
    return tr;
  }

  function renderLists() {
    $("b-body").replaceChildren(...data.blocks.slice(0, shownBlocks).map(blockRow));
    $("b-empty").hidden = data.blocks.length > 0;
    $("b-more").hidden = data.blocks.length <= shownBlocks;

    $("x-body").replaceChildren(...data.list.slice(0, shownTxs).map(txRow));
    $("x-empty").hidden = data.list.length > 0;
    $("x-empty").textContent = data.txTableMissing
      ? "अभी कोई ट्रांजैक्शन नहीं। (transactions टेबल अभी बनी नहीं है।)"
      : "अभी कोई ट्रांजैक्शन नहीं।";
    $("x-more").hidden = data.list.length <= shownTxs;
  }

  // ---------- विवरण ----------
  function showDetail(title, rows, extra) {
    $("d-title").textContent = title;
    const dl = $("d-list");
    dl.replaceChildren();
    for (const [k, v, mono] of rows) {
      dl.append(el("dt", "", k));
      dl.append(el("dd", mono ? "mono" : "", v === null || v === undefined || v === "" ? "—" : String(v)));
    }
    const box = $("d-extra");
    box.replaceChildren();
    if (extra) box.append(extra);
    $("detail").hidden = false;
    $("detail").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function showBlock(b) {
    showDetail("ब्लॉक #" + b.idx, [
      ["नंबर (idx)", b.idx],
      ["माइनर", b.miner, true],
      ["इनाम", fmt(mncToUnits(b.reward)) + " MNC"],
      ["समय", when(b.created_at || b.ts)],
      ["hash", b.hash, true],
      ["पिछला hash (prev_hash)", b.prev_hash, true],
      ["nonce", b.nonce],
      ["difficulty", b.difficulty],
      ["data", b.data, true],
    ], txTable(data.list.filter((t) => String(t.block) === String(b.idx)), "इस ब्लॉक की ट्रांजैक्शन"));
  }

  function showTx(t) {
    showDetail(t.kind === "transfer" ? "लेन-देन " + t.id.slice(9) : "ट्रांजैक्शन", [
      [t.kind === "transfer" ? "लेन-देन नंबर" : "tx_hash", t.kind === "transfer" ? t.id.slice(9) : t.id, true],
      ["स्थिति", t.status === "confirmed" ? "कन्फ़र्म" : "पेंडिंग"],
      ["किससे", t.from, true],
      ["किसे", t.to, true],
      ["रकम", fmt(t.amount) + " MNC"],
      ["फ़ीस", fmt(t.fee) + " MNC"],
      ["nonce / क्रमांक", t.nonce],
      ["ब्लॉक", t.block === null || t.block === undefined ? "—" : "#" + t.block],
      ["समय", when(t.time)],
      ["हस्ताक्षर", t.signature ? short(t.signature, 16, 8) : "—", true],
    ]);
  }

  function txTable(rows, caption) {
    if (!rows.length) return null;
    const wrap = el("div", "scroll");
    const table = el("table");
    const cap = el("caption", "", caption);
    const head = el("thead");
    const hr = el("tr");
    for (const h of ["tx", "किससे → किसे", "रकम", "फ़ीस", "स्थिति", "ब्लॉक"]) hr.append(el("th", "", h));
    head.append(hr);
    const body = el("tbody");
    body.append(...rows.map(txRow));
    table.append(cap, head, body);
    wrap.append(table);
    return wrap;
  }

  async function showAddress(address) {
    const mined = data.blocks.filter((b) => b.miner === address);
    const txs = data.list.filter((t) => t.from === address || t.to === address);
    let balance = "…";
    showDetail("पता", [
      ["पता", address, true],
      ["बैलेंस", balance],
      ["माइन किए ब्लॉक", mined.length],
      ["ट्रांजैक्शन", txs.length],
    ], txTable(txs, "इस पते की ट्रांजैक्शन"));
    try {
      balance = fmt(await balanceUnits(address)) + " MNC";
    } catch (_) {
      balance = "नहीं मिला";
    }
    const dd = $("d-list").querySelectorAll("dd")[1];
    if (dd) dd.textContent = balance;
  }

  // ---------- खोज ----------
  function search(q) {
    const text = String(q || "").trim();
    const msg = $("q-msg");
    msg.textContent = "";
    $("detail").hidden = true; // पिछला नतीजा हटाएँ; न मिले तो सिर्फ़ संदेश दिखे
    if (!text || !data) return;

    if (/^#?\d+$/.test(text)) {
      const n = text.replace("#", "");
      const b = data.blocks.find((x) => String(x.idx) === n);
      if (b) return showBlock(b);
      msg.textContent = "ब्लॉक #" + n + " नहीं मिला।";
      return;
    }
    if (ADDRESS_RE.test(text)) return showAddress(text);
    const lower = text.toLowerCase();
    // tx_hash (64 अक्षर), या पुराने लेन-देन का नंबर "transfer-12"
    const t = HASH_RE.test(lower)
      ? data.list.find((x) => x.id === lower)
      : data.list.find((x) => x.id === "transfer-" + lower.replace(/^transfer-/, ""));
    if (t) return showTx(t);
    const b = data.blocks.find((x) => x.hash === lower);
    if (b) return showBlock(b);
    msg.textContent = "कुछ नहीं मिला। पता (MNC… 43 अक्षर), tx_hash (64 अक्षर) या ब्लॉक नंबर लिखें।";
  }

  // ---------- शुरुआत ----------
  async function refresh() {
    $("loading").hidden = false;
    $("error").hidden = true;
    $("reload").disabled = true;
    try {
      if (!chain) {
        chain = await Units.load("../config/chain.json");
        unit = BigInt(chain.unit_per_mnc);
      }
      await load();
      renderSummary();
      renderTreasury();
      renderLists();
      $("content").hidden = false;
    } catch (err) {
      $("content").hidden = true;
      $("error").textContent = err && err.status
        ? "Supabase से डेटा नहीं आया (" + err.message + ", त्रुटि " + err.status + ")। थोड़ी देर बाद “फिर से लोड करें” दबाएँ।"
        : "डेटा नहीं आ सका। इंटरनेट जाँचकर “फिर से लोड करें” दबाएँ।";
      $("error").hidden = false;
    }
    $("loading").hidden = true;
    $("reload").disabled = false;
  }

  $("reload").addEventListener("click", refresh);
  $("b-more").addEventListener("click", () => { shownBlocks += SHOW; renderLists(); });
  $("x-more").addEventListener("click", () => { shownTxs += SHOW; renderLists(); });
  $("d-close").addEventListener("click", () => { $("detail").hidden = true; });
  $("search").addEventListener("submit", (e) => {
    e.preventDefault(); // कुछ भेजा नहीं जाता; खोज इसी पेज में होती है
    search($("q").value);
  });

  refresh();
})();
