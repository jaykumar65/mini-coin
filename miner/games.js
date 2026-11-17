// MNC माइनर — दो छोटे गेम: "सिक्का पकड़ो" और "जोड़ी मिलाओ"
//
// गेम का स्कोर सिर्फ़ मज़े के लिए है; इनाम पर इसका कोई असर नहीं (इनाम सबको बराबर)।
// गेम में हर चाल पर window.MNCPlay.touch() बुलाया जाता है; माइनर (miner.js) उसी से जानता है
// कि यूज़र अभी खेल रहा है। पिछले 2 मिनट में चाल न हो तो माइनिंग के संकेत रुक जाते हैं।
// कोई नेटवर्क कॉल नहीं; सबसे अच्छा स्कोर सिर्फ़ इसी फ़ोन के localStorage में।

"use strict";

(function () {
  const $ = (id) => document.getElementById(id);
  const touch = () => { if (window.MNCPlay) window.MNCPlay.touch(); };

  function best(key, value, better) {
    let old = null;
    try { old = JSON.parse(localStorage.getItem(key) || "null"); } catch (_) { old = null; }
    if (value !== undefined && (old === null || better(value, old))) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* कुछ नहीं */ }
      return value;
    }
    return old;
  }

  // ---------- टैब ----------
  const tabs = Array.from(document.querySelectorAll(".game-tab"));
  const panes = { coins: $("game-coins"), pairs: $("game-pairs") };
  function show(name) {
    for (const t of tabs) {
      const on = t.dataset.game === name;
      t.classList.toggle("on", on);
      t.setAttribute("aria-selected", String(on));
    }
    for (const [k, p] of Object.entries(panes)) p.hidden = k !== name;
    if (name !== "coins") Coins.pause();
    try { localStorage.setItem("mnc_game_tab", name); } catch (_) { /* कुछ नहीं */ }
  }
  tabs.forEach((t) => t.addEventListener("click", () => { touch(); show(t.dataset.game); }));

  // ---------- गेम 1: सिक्का पकड़ो ----------
  const Coins = (function () {
    const field = $("coin-field");
    const scoreEl = $("coin-score");
    const livesEl = $("coin-lives");
    const bestEl = $("coin-best");
    const overlay = $("coin-overlay");
    const overlayText = $("coin-overlay-text");
    const startBtn = $("coin-start");
    const LIVES = 5;
    const BEST_KEY = "mnc_game_coin_best";

    let items = [];
    let running = false;
    let score = 0;
    let lives = LIVES;
    let lastFrame = 0;
    let spawnIn = 0;
    let elapsed = 0;

    bestEl.textContent = String(best(BEST_KEY) || 0);

    function hud() {
      scoreEl.textContent = String(score);
      livesEl.textContent = "●".repeat(lives) + "○".repeat(LIVES - lives);
      livesEl.setAttribute("aria-label", lives + " मौक़े बाक़ी");
    }

    function clear() {
      for (const it of items) it.el.remove();
      items = [];
    }

    function spawn() {
      const w = field.clientWidth;
      const stone = Math.random() < Math.min(0.25, 0.08 + elapsed / 240000);
      const el = document.createElement("button");
      el.type = "button";
      el.className = "coin" + (stone ? " stone" : "");
      el.textContent = stone ? "✕" : "M";
      el.setAttribute("aria-label", stone ? "पत्थर, मत छुएँ" : "सिक्का");
      const size = 52;
      const it = {
        el,
        stone,
        x: 8 + Math.random() * Math.max(0, w - size - 16),
        y: -size,
        v: (70 + Math.random() * 50) * (1 + elapsed / 90000), // पिक्सल प्रति सेकंड, धीरे-धीरे तेज़
      };
      el.style.transform = "translate(" + it.x + "px," + it.y + "px)";
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        hit(it);
      });
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") hit(it); });
      field.append(el);
      items.push(it);
    }

    function hit(it) {
      if (!running || it.done) return;
      touch();
      it.done = true;
      if (it.stone) {
        lives = Math.max(0, lives - 1);
        it.el.classList.add("bad");
      } else {
        score += 1;
        it.el.classList.add("got");
      }
      hud();
      setTimeout(() => it.el.remove(), 180);
      items = items.filter((x) => x !== it);
      if (lives === 0) over();
    }

    function frame(t) {
      if (!running) return;
      const dt = Math.min(0.05, (t - (lastFrame || t)) / 1000);
      lastFrame = t;
      elapsed += dt * 1000;
      spawnIn -= dt * 1000;
      if (spawnIn <= 0) {
        spawn();
        spawnIn = Math.max(380, 850 - elapsed / 120);
      }
      const h = field.clientHeight;
      for (const it of items.slice()) {
        it.y += it.v * dt;
        it.el.style.transform = "translate(" + it.x + "px," + it.y + "px)";
        if (it.y > h) {
          it.el.remove();
          items = items.filter((x) => x !== it);
          if (!it.stone) {
            lives = Math.max(0, lives - 1); // सिक्का छूट गया
            hud();
            if (lives === 0) return over();
          }
        }
      }
      requestAnimationFrame(frame);
    }

    function start() {
      touch();
      clear();
      score = 0;
      lives = LIVES;
      elapsed = 0;
      spawnIn = 0;
      lastFrame = 0;
      running = true;
      overlay.hidden = true;
      hud();
      requestAnimationFrame(frame);
    }

    function over() {
      running = false;
      clear();
      const b = best(BEST_KEY, score, (a, o) => a > o);
      bestEl.textContent = String(b || 0);
      overlayText.textContent = "खेल ख़त्म! आपने " + score + " सिक्के पकड़े। सबसे अच्छा: " + (b || 0) + "।";
      startBtn.textContent = "फिर खेलें";
      overlay.hidden = false;
    }

    // बीच में रोकना (टैब बदला या ऐप पीछे गया); "जारी रखें" से वहीं से आगे
    function pause() {
      if (!running) return;
      running = false;
      overlayText.textContent = "रुका हुआ। स्कोर " + score + "।";
      startBtn.textContent = "जारी रखें";
      startBtn.dataset.resume = "1";
      overlay.hidden = false;
    }

    function resume() {
      touch();
      running = true;
      lastFrame = 0;
      overlay.hidden = true;
      requestAnimationFrame(frame);
    }

    startBtn.addEventListener("click", () => {
      if (startBtn.dataset.resume === "1") {
        delete startBtn.dataset.resume;
        resume();
      } else {
        start();
      }
    });
    // ख़ाली जगह पर टैप भी "खेलना" गिना जाए
    field.addEventListener("pointerdown", () => { if (running) touch(); });

    hud();
    return { pause };
  })();

  // ---------- गेम 2: जोड़ी मिलाओ ----------
  (function Pairs() {
    const grid = $("pair-grid");
    const movesEl = $("pair-moves");
    const foundEl = $("pair-found");
    const bestEl = $("pair-best");
    const msg = $("pair-msg");
    const again = $("pair-again");
    const SYMBOLS = ["⛏", "💎", "🪙", "🔑", "⭐", "🌙", "🍀", "🎁"];
    const BEST_KEY = "mnc_game_pairs_best";

    let open = [];
    let moves = 0;
    let found = 0;
    let lock = false;

    function shuffle(a) {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }

    function hud() {
      movesEl.textContent = String(moves);
      foundEl.textContent = found + "/" + SYMBOLS.length;
      const b = best(BEST_KEY);
      bestEl.textContent = b ? b + " चालें" : "—";
    }

    function deal() {
      open = [];
      moves = 0;
      found = 0;
      lock = false;
      msg.textContent = "";
      again.hidden = true;
      grid.replaceChildren(...shuffle(SYMBOLS.concat(SYMBOLS)).map((s, i) => {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "card-tile";
        card.dataset.symbol = s;
        card.setAttribute("aria-label", "पत्ता " + (i + 1));
        const face = document.createElement("span");
        face.textContent = s;
        card.append(face);
        card.addEventListener("click", () => flip(card));
        return card;
      }));
      hud();
    }

    function flip(card) {
      touch();
      if (lock || card.classList.contains("up") || card.classList.contains("done")) return;
      card.classList.add("up");
      card.setAttribute("aria-label", card.dataset.symbol);
      open.push(card);
      if (open.length < 2) return;
      moves += 1;
      const [a, b] = open;
      if (a.dataset.symbol === b.dataset.symbol) {
        a.classList.add("done");
        b.classList.add("done");
        open = [];
        found += 1;
        hud();
        if (found === SYMBOLS.length) {
          const bestMoves = best(BEST_KEY, moves, (x, o) => x < o);
          msg.textContent = "शाबाश! " + moves + " चालों में सारे जोड़े मिले। सबसे अच्छा: " + bestMoves + " चालें।";
          again.hidden = false;
          hud();
        }
      } else {
        lock = true;
        hud();
        setTimeout(() => {
          a.classList.remove("up");
          b.classList.remove("up");
          a.setAttribute("aria-label", "पत्ता");
          b.setAttribute("aria-label", "पत्ता");
          open = [];
          lock = false;
        }, 750);
      }
    }

    again.addEventListener("click", () => { touch(); deal(); });
    deal();
  })();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") Coins.pause();
  });

  let first = "coins";
  try { first = localStorage.getItem("mnc_game_tab") === "pairs" ? "pairs" : "coins"; } catch (_) { /* कुछ नहीं */ }
  show(first);
})();
