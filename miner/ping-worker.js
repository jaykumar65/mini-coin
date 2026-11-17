// MNC टेस्टनेट माइनर — Web Worker
//
// काम: माइनिंग चालू हो तब
//   1. हर `everyMs` पर डेटाबेस के mnc_ping function को "मैं हूँ" संकेत भेजना, और नतीजा पेज को देना;
//   2. हर `heartbeatMs` (30 सेकंड) पर पेज को "heartbeat" बताना, ताकि पेज localStorage में लॉग रखे।
//
// यह Worker में इसलिए है कि पेज छिपने (दूसरा ऐप, दूसरा टैब) पर ब्राउज़र पेज के टाइमर बहुत धीमे
// कर देता है, जबकि Worker के टाइमर ज़्यादा देर चलते रहते हैं। फिर भी यह पक्का नहीं है:
// स्क्रीन बंद होने या ज़्यादा देर पीछे रहने पर फ़ोन का ब्राउज़र पूरे पेज को Worker समेत रोक सकता है।
//
// Worker localStorage नहीं पढ़ सकता; लॉग पेज (miner.js) लिखता है।
// इसमें सिर्फ़ publishable key और माइनिंग सत्र का token आता है; PIN या private key कभी नहीं।

"use strict";

let pingTimer = null;
let beatTimer = null;
let job = null;          // { api, headers, address, token, everyMs, heartbeatMs }
let busy = false;
let paused = false;     // ऐप पीछे है या यूज़र 2 मिनट से नहीं खेला: संकेत नहीं जाते
let startedAt = 0;
let pingsSinceBeat = 0;
let okSinceBeat = 0;

async function ping() {
  if (!job || busy || paused) return;
  busy = true;
  try {
    const res = await fetch(job.api + "/rest/v1/rpc/mnc_ping", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, job.headers),
      body: JSON.stringify({ p_address: job.address, p_token: job.token }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error("http " + res.status);
    const data = await res.json();
    pingsSinceBeat++; // जवाब आने पर गिनें, ताकि "सफल/कुल" एक ही 30 सेकंड के हों
    if (data && data.ok) okSinceBeat++;
    postMessage({ type: "ping", ok: true, data });
  } catch (err) {
    pingsSinceBeat++;
    postMessage({ type: "ping", ok: false, error: String((err && err.message) || err) });
  }
  busy = false;
}

function beat() {
  postMessage({
    type: "heartbeat",
    t: Date.now(),
    up_s: Math.round((Date.now() - startedAt) / 1000),
    pings: pingsSinceBeat,
    ok_pings: okSinceBeat,
    paused,
  });
  pingsSinceBeat = 0;
  okSinceBeat = 0;
}

function stop() {
  clearInterval(pingTimer);
  clearInterval(beatTimer);
  pingTimer = beatTimer = null;
  job = null;
}

onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === "start") {
    stop();
    job = msg;
    paused = !!msg.paused;
    startedAt = Number(msg.startedAt) || Date.now();
    pingsSinceBeat = okSinceBeat = 0;
    ping();
    pingTimer = setInterval(ping, Math.max(2000, Number(msg.everyMs) || 10000));
    beatTimer = setInterval(beat, Math.max(5000, Number(msg.heartbeatMs) || 30000));
  } else if (msg.type === "stop") {
    stop();
  } else if (msg.type === "pause") {
    paused = true;
  } else if (msg.type === "resume") {
    const was = paused;
    paused = false;
    if (was) ping();
  } else if (msg.type === "ping-now") {
    ping();
  }
};
