/* =====================================================================
   ONLINE 1v1
   Two devices (phones, computers, anything with a browser) connect directly to each other (WebRTC) with PeerJS. PeerJS's free
   public server is only used to find each other by room code; the game data
   goes straight between the devices. No accounts: each player can pick a short name
   (saved on their own device), and only the rival in their room sees it.

   How a round works:
   - the host sends a random seed and the level, so both devices build the same course
   - each device flies its own stork and sends where it is, 30 times a second
   - the other device draws it as the see-through "Rival" stork
   - when you crash you keep watching until your rival crashes too
   - whoever flew more steps wins; the series score counts up until someone leaves
   ===================================================================== */
const PEERJS_URL = "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js";
const ROOM_PREFIX = "stork-flight-1v1-";
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";   // no I or O, so codes are easy to read out

// names: 2-12 letters (any alphabet, so Arabic works too), numbers, spaces and _ . -
const BLOCKED = ["fuck", "shit", "bitch", "cunt", "dick", "pussy", "nigg", "fag", "whore", "slut", "rape", "porn", "sex"];
function cleanName(v) {
  const n = String(v || "").replace(/[^\p{L}\p{N} _.-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 12);
  const flat = n.toLowerCase().replace(/[^a-z]/g, "");
  return n.length >= 2 && !BLOCKED.some(w => flat.includes(w)) ? n : "";
}
const esc = v => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let myName = "";
try { myName = cleanName(localStorage.getItem("stork-name")); } catch (e) {}
const rivalName = () => NET.rivalName || "Rival";

const NET = {
  peer: null, conn: null, host: false, code: "", connected: false, status: "idle", error: "",
  seed: null, rivalSkin: "classic", rivalName: "",
  pos: new Map(), lastK: 0,             // the rival's height at each step of the run
  rivalDeadK: null, rivalScore: 0, myDeadK: null, myScore: 0, left: false, lastMsg: 0,
  me: 0, rival: 0, counted: false,     // series score
  wantRematch: false, rivalRematch: false,
};

function netSend(m) {
  if (m.t === "dead") { NET.myDeadK = m.k; NET.myScore = m.score; }
  try { if (NET.conn && NET.connected) NET.conn.send(m); } catch (e) {}
}

/* ---------- connecting ---------- */
function loadPeerJS() {
  if (peerClass()) return Promise.resolve();
  return new Promise((ok, fail) => {
    const sc = document.createElement("script");
    sc.src = PEERJS_URL; sc.onload = ok; sc.onerror = () => fail(new Error("no internet"));
    document.head.appendChild(sc);
  });
}
function peerClass() { const P = window.Peer || (window.peerjs && window.peerjs.Peer); return P && (P.default || P); }
const newCode = () => Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join("");

async function netCreate() {
  netLeave(true); NET.host = true; setStatus("creating");
  try { await loadPeerJS(); } catch (e) { return fail("Couldn't reach the internet. Check your connection and try again."); }
  const open = () => {
    NET.code = newCode();
    const P = peerClass(), peer = new P(ROOM_PREFIX + NET.code, { debug: 0 });
    NET.peer = peer;
    peer.on("open", () => setStatus("hosting"));
    peer.on("connection", c => { if (NET.conn) { try { c.close(); } catch (e) {} return; } attach(c); });   // one rival per room
    peer.on("error", e => {
      if (e.type === "unavailable-id") { peer.destroy(); open(); }       // that code is taken: pick another
      else if (!NET.connected) fail(peerError(e));
    });
  };
  open();
}
async function netJoin(code) {
  code = code.toUpperCase().replace(/[^A-Z]/g, "");
  if (code.length !== 4) return fail("Room codes have 4 letters.");
  netLeave(true); NET.host = false; NET.code = code; setStatus("joining");
  try { await loadPeerJS(); } catch (e) { return fail("Couldn't reach the internet. Check your connection and try again."); }
  const P = peerClass(), peer = new P({ debug: 0 });
  NET.peer = peer;
  peer.on("open", () => {
    attach(peer.connect(ROOM_PREFIX + code, { reliable: true, serialization: "json" }));
    setTimeout(() => { if (NET.status === "joining") fail(`No room called ${code}. Check the code with your friend.`); }, 10000);
  });
  peer.on("error", e => { if (!NET.connected) fail(e.type === "peer-unavailable" ? `No room called ${code}. Check the code with your friend.` : peerError(e)); });
}
function peerError(e) {
  return e.type === "network" || e.type === "server-error" || e.type === "socket-error"
    ? "Couldn't reach the matchmaking server. Check your internet and try again."
    : e.type === "browser-incompatible" ? "This browser can't play online." : "Something went wrong. Try again.";
}
function attach(c) {
  NET.conn = c; NET.rivalName = ""; NET.rivalSkin = "classic";   // a new rival: forget the last one (before their hello can arrive)
  c.on("open", () => {
    NET.connected = true; NET.left = false; NET.me = NET.rival = 0; NET.lastMsg = performance.now();
    netSend({ t: "hello", skin, name: myName });
    setStatus("connected"); sfx("unlock"); buzz("unlock");
  });
  c.on("data", onMessage);
  c.on("close", rivalLeft);
  c.on("error", rivalLeft);
}
// leaving: tell the rival, close everything (quiet = no message, used before creating or joining again)
function netLeave(quiet) {
  if (NET.connected) netSend({ t: "bye" });
  const peer = NET.peer;
  NET.peer = NET.conn = null; NET.connected = false; NET.seed = null;
  if (peer) setTimeout(() => { try { peer.destroy(); } catch (e) {} }, 100);
  if (!quiet) setStatus("idle");
}
function rivalLeft() {
  if (!NET.connected) return;
  NET.connected = false; NET.left = true;
  if (NET.rivalDeadK == null && (state === "play" || state === "spectate")) { NET.rivalDeadK = s.k; NET.rivalScore = s.ghost ? s.ghost.score : 0; }
  if (state === "count") toMenu();
  if (state === "over") { $("oRetry").disabled = true; $("oRetry").querySelector("span").textContent = "Rematch"; $("oVerdict").textContent = `${rivalName()} left`; }
  try { NET.peer && NET.peer.destroy(); } catch (e) {}
  NET.peer = NET.conn = null;
  setStatus("idle", `${rivalName()} left the room.`);   // the name stays until someone new joins, so the card can still say who left
}

/* ---------- messages ---------- */
function onMessage(m) {
  if (!m || typeof m !== "object") return;
  NET.lastMsg = performance.now();
  if (m.t === "hello") { NET.rivalSkin = typeof m.skin === "string" && SKINS[m.skin] ? m.skin : "classic"; NET.rivalName = cleanName(m.name); renderLobby(); }
  else if (m.t === "name") { NET.rivalName = cleanName(m.name); renderLobby(); }
  else if (m.t === "start" && !NET.host) beginRound(m.seed >>> 0, m.d);
  else if (m.t === "s") { NET.pos.set(m.k, { y: +m.y, f: m.f }); NET.lastK = Math.max(NET.lastK, m.k); }
  else if (m.t === "dead") { NET.rivalDeadK = m.k; NET.rivalScore = m.score | 0; }
  else if (m.t === "rematch") {
    NET.rivalRematch = true;
    if (NET.host && NET.wantRematch) hostStart();
    else if (state === "over") $("oVerdict").textContent = `${rivalName()} wants a rematch!`;
  }
  else if (m.t === "bye") rivalLeft();
}

/* ---------- rounds ---------- */
function hostStart() {
  if (!NET.host || !NET.connected) return;
  const seed = Math.floor(Math.random() * 4294967296);
  netSend({ t: "start", seed, d: difficulty });
  beginRound(seed, difficulty);
}
function beginRound(seed, d) {
  NET.seed = seed; NET.pos.clear(); NET.lastK = 0;
  NET.rivalDeadK = NET.myDeadK = null; NET.rivalScore = NET.myScore = 0; NET.counted = false;
  NET.wantRematch = NET.rivalRematch = false; NET.lastMsg = performance.now();
  if (d !== difficulty && [0, 0.5, 1].includes(d)) {     // the host picks the level
    difficulty = d; best = loadBest();
    document.querySelectorAll("[data-d]").forEach(o => o.setAttribute("aria-pressed", String(+o.dataset.d === difficulty)));
  }
  showPage(null); hideGameOver(); courseRandom = Math.random; reset(); distance = prevDistance = 0;
  state = "count"; countEnd = performance.now() + 3000; sfx("swoosh");
}
// called every step of the run: put the rival where they were at the same step of theirs
function netGhost(g, k) {
  g.prevY = g.y;
  if (g.alive) {
    const p = NET.pos.get(k) || NET.pos.get(Math.min(k, NET.lastK));   // not here yet: hold the last known height
    if (p) { g.vy = p.y - g.y; g.y = p.y; if (p.f) g.flapTime = performance.now(); }
    NET.pos.delete(k - 90);
    const silent = performance.now() - Math.max(NET.lastMsg, countEnd) > 6000;   // nothing heard for 6 seconds of the run: they're gone
    if ((NET.rivalDeadK != null && k >= NET.rivalDeadK) || silent) {
      if (silent && NET.rivalDeadK == null) { NET.rivalDeadK = k; NET.left = true; }
      g.alive = false; g.score = NET.rivalScore; g.deadAt = performance.now(); sfx("ghostout");
      if (state === "play") { s.rivalOutAt = performance.now(); buzz("record"); }
    }
  } else {   // fall, like the AI does
    g.vy = Math.min(g.vy + GRAVITY * 1.4, MAX_FALL * 1.4); g.y = Math.min(g.y + g.vy, H - GROUND - 10);
  }
  if (state === "spectate" && !g.alive && performance.now() - g.deadAt > 700) endOnlineRound();
}
// the result for the game-over card (counted once per round)
function netResult() {
  const my = NET.myDeadK ?? s.k, theirs = NET.rivalDeadK ?? Infinity;
  const result = NET.left && NET.rivalDeadK != null && my > NET.rivalDeadK ? "win"
    : my > theirs ? "win" : my < theirs ? "lose" : "draw";
  if (!NET.counted) { NET.counted = true; if (result === "win") NET.me++; else if (result === "lose") NET.rival++; }
  return {
    result, left: NET.left, me: NET.me, rival: NET.rival, rivalScore: NET.rivalScore,
    title: result === "win" ? "You win!" : result === "lose" ? `${rivalName()} wins` : "A draw!",
  };
}
function netRematch() {
  if (!NET.connected) return;
  NET.wantRematch = true; netSend({ t: "rematch" });
  if (NET.host && NET.rivalRematch) hostStart();
  else { $("oRetry").querySelector("span").textContent = "Waiting…"; $("oVerdict").textContent = `Waiting for ${rivalName()}…`; }
}
// tapping the start screen in 1v1 mode
function netTapReady() {
  if (NET.connected && NET.host) hostStart();
  else if (!NET.connected) showPage("online");
}

/* ---------- the lobby page ---------- */
function setStatus(st, msg = "") { NET.status = st; NET.error = msg; renderLobby(); }
function fail(msg) { netLeave(true); setStatus("error", msg); }
function renderLobby() {
  const el = $("lobby"), st = NET.status;
  $("lobbyBtn").textContent = NET.connected ? `${rivalName()} is here · ${NET.host ? "Start" : "Lobby"}` : "Open the lobby";
  if (st === "creating" || st === "joining") {
    el.innerHTML = `<p class="lobby-wait">${st === "creating" ? "Making a room…" : `Looking for room ${NET.code}…`}</p><button class="lobby-btn ghost" id="lCancel" type="button">Cancel</button>`;
  } else if (st === "hosting") {
    el.innerHTML = `<p>Your room code:</p><div class="lobby-code" aria-live="polite">${NET.code}</div>
      <p class="lobby-wait">Waiting for your friend to join…</p><button class="lobby-btn ghost" id="lCancel" type="button">Cancel</button>`;
  } else if (st === "connected") {
    el.innerHTML = `<div class="lobby-code small">${NET.code}</div><p class="lobby-ok">${NET.rivalName ? esc(NET.rivalName) + " is here!" : "Your rival is here!"}</p>
      ${NET.host ? `<p>You're the host: pick the level (Easy, Medium or Hard) first, then start.</p><button class="lobby-btn" id="lStart" type="button">Start the match</button>`
                 : `<p class="lobby-wait">Waiting for the host to start the match…</p>`}
      <button class="lobby-btn ghost" id="lLeave" type="button">Leave the room</button>`;
  } else {
    el.innerHTML = `${NET.error ? `<p class="lobby-err">${NET.error}</p>` : ""}
      <button class="lobby-btn" id="lCreate" type="button">Create a room</button>
      <p class="lobby-or">or join your friend's room</p>
      <form class="lobby-join" id="lJoin"><input id="lCode" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="CODE" aria-label="Room code">
      <button class="lobby-btn" type="submit">Join</button></form>`;
  }
  const on = (id, f) => { const b = $(id); if (b) b.addEventListener(b.tagName === "FORM" ? "submit" : "click", e => { e.preventDefault(); ensureAudio(); sfx("click"); f(); }); };
  on("lCreate", netCreate);
  on("lJoin", () => netJoin($("lCode").value));
  on("lCancel", () => netLeave());
  on("lLeave", () => netLeave());
  on("lStart", hostStart);
  const code = $("lCode"); if (code) code.addEventListener("input", () => { code.value = code.value.toUpperCase().replace(/[^A-Z]/g, ""); });
}
// your name: saved on this device, and sent to your rival when it changes
const nameIn = $("myName");
nameIn.value = myName;
nameIn.addEventListener("input", () => { nameIn.value = nameIn.value.replace(/[^\p{L}\p{N} _.-]/gu, "").slice(0, 12); });
nameIn.addEventListener("change", () => {
  const n = cleanName(nameIn.value);
  $("nameNote").textContent = nameIn.value.trim() && !n ? "That name can't be used. Try another one (2–12 letters or numbers)." : n ? "Saved. Your rival will see this name." : "No name: your rival sees “Rival”.";
  myName = n; nameIn.value = n;
  try { localStorage.setItem("stork-name", n); } catch (e) {}
  if (NET.connected) netSend({ t: "name", name: n });
});
$("lobbyBtn").addEventListener("click", e => { e.currentTarget.blur(); if (NET.connected && NET.host) hostStart(); else showPage("online"); });
renderLobby();
