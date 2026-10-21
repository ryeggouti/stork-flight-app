/* =====================================================================
   RULES: identical to stork_env.py, so a human plays exactly what the AI learned
   ===================================================================== */
const W = 400, H = 600, GROUND = 60, STORK_X = 100, GRAVITY = 0.5, FLAP = -8, MAX_FALL = 10;
const TOWER_W = 64, SPACING = 210, STORK_R = 13, STEP_MS = 1000 / 30;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const TOUCH = matchMedia("(pointer: coarse)").matches;        // phones and tablets
let difficulty = 0, state = "ready", s, distance = 0, prevDistance = 0, shake = 0, flash = 0;
let deathTime = 0, newBest = false, alpha = 0, frameScale = 1;
let trans = null;

/* ---------------------------------------------------------------------
   SOUND: every effect is synthesised with the Web Audio API (no audio files)
   --------------------------------------------------------------------- */
let audio = null;
let muted = false;
try { muted = localStorage.getItem("stork-muted") === "1"; } catch (e) {}
function ensureAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  if (!audio) audio = new AC();
  if (audio.state === "suspended") audio.resume();
}
function tone(freq, start, dur, type = "sine", vol = 0.2, endFreq = null) {
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, start);
  if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, start + dur);
  g.gain.setValueAtTime(vol, start);
  g.gain.exponentialRampToValueAtTime(0.001, start + dur);
  o.connect(g).connect(audio.destination);
  o.start(start); o.stop(start + dur + 0.02);
}
function noise(start, dur, from, to, vol = 0.25, type = "bandpass") {
  const len = Math.floor(audio.sampleRate * dur);
  const buf = audio.createBuffer(1, len, audio.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = audio.createBufferSource(), f = audio.createBiquadFilter(), g = audio.createGain();
  src.buffer = buf; f.type = type; f.Q.value = 1.2;
  f.frequency.setValueAtTime(from, start); f.frequency.exponentialRampToValueAtTime(to, start + dur);
  g.gain.setValueAtTime(vol, start); g.gain.exponentialRampToValueAtTime(0.001, start + dur);
  src.connect(f).connect(g).connect(audio.destination);
  src.start(start); src.stop(start + dur);
}
function sfx(name) {
  if (muted || !audio) return;
  const t = audio.currentTime;
  if (name === "flap") noise(t, 0.13, 1400, 380, 0.22);
  if (name === "point") { tone(988, t, 0.08, "triangle", 0.18); tone(1319, t + 0.07, 0.14, "triangle", 0.18); }
  if (name === "hit") { tone(160, t, 0.22, "sine", 0.45, 45); noise(t, 0.12, 900, 200, 0.35, "lowpass"); }
  if (name === "fall") tone(620, t, 0.45, "triangle", 0.12, 140);
  if (name === "best") [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.09, 0.16, "triangle", 0.16));
  if (name === "medal") { tone(784, t, 0.1, "sine", 0.15); tone(1175, t + 0.1, 0.25, "sine", 0.15); }
  if (name === "click") tone(1200, t, 0.03, "square", 0.05);
  if (name === "unlock") [784, 988, 1175, 1568].forEach((f, i) => tone(f, t + i * 0.07, 0.18, "triangle", 0.13));
  if (name === "ghostout") { tone(520, t, 0.12, "sine", 0.08, 260); }
  if (name === "record") { tone(1047, t, 0.1, "triangle", 0.14); tone(1568, t + 0.08, 0.22, "triangle", 0.14); tone(2093, t + 0.16, 0.18, "sine", 0.06); }
  if (name === "tick") tone(1500, t, 0.025, "triangle", 0.05);
  if (name === "swoosh") noise(t, 0.3, 300, 2400, 0.12);
  if (name === "start") { tone(659, t, 0.08, "triangle", 0.12); tone(988, t + 0.06, 0.12, "triangle", 0.12); }
}
function toggleMute() {
  muted = !muted;
  try { localStorage.setItem("stork-muted", muted ? "1" : "0"); } catch (e) {}
  ensureAudio(); sfx("click"); syncSoundBtn();
}
function syncSoundBtn() {
  for (const id of ["soundBtn", "appSound"]) {
  const b = document.getElementById(id);
  b.setAttribute("aria-pressed", String(!muted)); b.setAttribute("aria-label", muted ? "Sound off" : "Sound on");
  b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>${muted ? '<path d="M17 9l5 6M22 9l-5 6"/>' : '<path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>'}</svg>`;
  }
}

const MEDALS = [
  { min: 40, name: "EMERALD", color: "#2fae7a" },
  { min: 30, name: "GOLD", color: "#e2b444" },
  { min: 20, name: "SILVER", color: "#c9ced6" },
  { min: 10, name: "BRONZE", color: "#c27a45" },
];
const medalFor = score => MEDALS.find(m => score >= m.min) || null;

/* ---------------------------------------------------------------------
   THE AI: the PPO networks trained in stork_flight.ipynb, one per level.
   Each is 5 inputs -> 64 -> 64 -> 2 (glide, flap), tanh, stored as float32.
   --------------------------------------------------------------------- */
// 4 opponents per level: real snapshots from training (see section 8 of stork_flight.ipynb)
const OPPONENTS = ["Beginner", "Intermediate", "Experienced", "Seasoned"];
const OPP_SCORES = { "0": [13.8, 20.6, 36.9, 41.0], "0.5": [11.1, 28.3, 40.1, 49.0], "1": [16.4, 35.6, 44.8, 47.9] };   // avg minarets on 20 test courses
// NET_B64 (the trained networks) is defined in networks.js, loaded before this file
const NETS = {};
for (const lvl in NET_B64) {
  NETS[lvl] = {};
  for (const name in NET_B64[lvl]) {
    const bin = atob(NET_B64[lvl][name]), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    NETS[lvl][name] = new Float32Array(bytes.buffer);
  }
}
let opponent = "Experienced";
try { opponent = OPPONENTS.includes(localStorage.getItem("stork-opponent")) ? localStorage.getItem("stork-opponent") : "Experienced"; } catch (e) {}
const SHAPES = [[64, 5], [64, 64], [2, 64]];            // [outputs, inputs] per layer
function aiLogits(obs) {
  const w = NETS[String(difficulty)][opponent];
  let x = obs, o = 0;
  SHAPES.forEach(([out, inp], li) => {
    const y = new Float64Array(out), bias = o + out * inp;
    for (let j = 0; j < out; j++) {
      let sum = w[bias + j];
      for (let k = 0; k < inp; k++) sum += w[o + j * inp + k] * x[k];
      y[j] = li < SHAPES.length - 1 ? Math.tanh(sum) : sum;
    }
    o = bias + out; x = y;
  });
  return x;
}
// exactly the 5 numbers stork_env.py gives the AI
function obsFor(b, towers = s.towers) {
  const t = towers.find(t => t.x + TOWER_W > STORK_X - STORK_R);
  return [(b.y - H / 2) / (H / 2), b.vy / MAX_FALL, (t.x - STORK_X) / W, (t.gapY - b.y) / (H / 2), t.gap / H];
}
function aiDecide(b, towers) {
  const obs = obsFor(b, towers), l = aiLogits(obs);
  b.obs = obs; b.pFlap = 1 / (1 + Math.exp(l[0] - l[1]));
  return l[1] > l[0];
}
// Haptics: in the Android app, the phone's haptic engine (Capacitor Haptics plugin);
// in browsers that allow it, a plain vibration. (Safari on iPhone allows neither.)
const HAPTICS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
const BUZZ = { crash: [50, 40, 60], record: 40, unlock: 30 };
function vibrate(kind) { try { if (navigator.vibrate) navigator.vibrate(BUZZ[kind]); } catch (e) {} }
function buzz(kind) {
  if (!HAPTICS) return vibrate(kind);
  try {
    const p = kind === "crash" ? HAPTICS.impact({ style: "HEAVY" }) : HAPTICS.notification({ type: "SUCCESS" });
    if (kind === "crash") setTimeout(() => { try { HAPTICS.impact({ style: "MEDIUM" }); } catch (e) {} }, 110);
    if (p && p.catch) p.catch(() => vibrate(kind));
  } catch (e) { vibrate(kind); }
}
const APP = document.documentElement.classList.contains("app");   // running as the Android app
let countEnd = 0;                                        // online countdown: when the run starts
let mode = "solo";                                     // "solo", "race" or "watch"
// how much practice each opponent had (training steps), from section 8 of the notebook
const OPP_STEPS = { "0": [220000, 240000, 600000, 1000000], "0.5": [240000, 300000, 400000, 1000000], "1": [400000, 700000, 800000, 900000] };
try { mode = localStorage.getItem("stork-mode") || "solo"; } catch (e) {}
if (!["solo", "race", "online"].includes(mode)) mode = "solo";   // "Watch the AI" isn't in this version
const gapSize = () => 180 - 50 * difficulty;
const speed = () => 3 + 1 * difficulty;

const bestKey = () => "stork-best-" + difficulty;
function loadBest() { try { return +localStorage.getItem(bestKey()) || 0; } catch (e) { return 0; } }
function saveBest(v) { try { localStorage.setItem(bestKey(), v); } catch (e) {} }
let best = loadBest();

/* ---------------------------------------------------------------------
   SKINS: unlocked by medals (your best score on any level). Looks only:
   the hitbox and physics never change, so it's still the AI's game.
   --------------------------------------------------------------------- */
const SKINS = {
  classic: { name: "Classic", need: 0,  body: "#fbfaf4", tip: "#1b1b1b", pattern: null },
  bronze:  { name: "Bronze",  need: 10, body: "#f6eadb", tip: "#a8622f", pattern: "#c27a45" },
  silver:  { name: "Silver",  need: 20, body: "#eef1f5", tip: "#8a94a5", pattern: "#aeb8c6" },
  gold:    { name: "Gold",    need: 30, body: "#fff6dc", tip: "#c4952a", pattern: "#e2b444", glow: "rgba(255,207,63,0.6)" },
  emerald: { name: "Emerald", need: 40, body: "#f2fbf6", tip: "#1d8558", pattern: "#2fae7a", glow: "rgba(47,174,122,0.75)", nightOnly: true },
};
function bestAll() {          // your best score on any level
  let m = 0;
  for (const d of ["0", "0.5", "1"]) { try { m = Math.max(m, +localStorage.getItem("stork-best-" + d) || 0); } catch (e) {} }
  return Math.max(m, best);
}
const unlocked = id => bestAll() >= SKINS[id].need;
// each stork's name is shown in its medal's colour (Classic stays cream)
const skinColor = id => (MEDALS.find(m => m.min === SKINS[id].need) || { color: "#f3f1ea" }).color;
const SHINE = { bronze: "#ffd2a8", silver: "#ffffff", gold: "#fff4b8", emerald: "#b4ffdc" };
const SHINE_PREVIEWS = true;          // experiment: the shine also sweeps across unlocked stork pictures (set false to turn off)
// where the band of light is, from -0.3 to 1.3, sweeping once every `period` ms with a pause between sweeps
const shinePos = (now, period = 2600, offset = 0) => { const k = ((now + offset) % period) / (period * 0.55); return k > 1 ? 9 : k * 1.6 - 0.3; };
let skin = "classic";
try { const v = localStorage.getItem("stork-skin"); if (SKINS[v]) skin = v; } catch (e) {}
if (!unlocked(skin)) skin = "classic";

function rand(seed) { let x = Math.sin(seed * 9301 + 49297) * 233280; return x - Math.floor(x); }

let towerCount = 0;
// where the gaps go: random, except online, where both phones use the same seed so they fly the same course
let courseRandom = Math.random;
function seeded(seed) {   // mulberry32: a small, fast random generator that gives the same numbers for the same seed
  return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function newTower(x, prev) {
  const gap = gapSize();
  let lo = 90 + gap / 2, hi = H - GROUND - 70 - gap / 2;
  if (prev != null) { lo = Math.max(lo, prev - 160); hi = Math.min(hi, prev + 160); }
  const id = towerCount++;
  return {
    x, prevX: x, gapY: lo + courseRandom() * (hi - lo), gap, passed: false, id,
    style: Math.floor(rand(id) * 3),
    nest: rand(id + 7) < 0.35,
  };
}
function reset() {
  s = { y: H / 2, prevY: H / 2, vy: 0, score: 0, flapTime: -1000, towers: [], angle: 0, popT: -1e9,
        startBest: best, recordAt: -1e9, ghost: null, reward: 0, trail: [], startAt: 0,
        unlockBase: bestAll(), toast: null, k: 0, rivalOutAt: 0, deadDist: null };   // k: steps flown this run   // unlockBase: your best on any level before this run   // startBest: the record to beat in this run
  for (let i = 0; i < 3; i++) s.towers.push(newTower(W + 40 + i * SPACING, i ? s.towers[i - 1].gapY : null));
  particles = [];
  newBest = false;
}
function crashedAt(y, towers = s.towers) {
  if (y + STORK_R >= H - GROUND || y - STORK_R <= 0) return true;
  return towers.some(t => t.x - STORK_R < STORK_X && STORK_X < t.x + TOWER_W + STORK_R &&
    (y - STORK_R < t.gapY - t.gap / 2 || y + STORK_R > t.gapY + t.gap / 2));
}
const crashed = () => crashedAt(s.y);
// the AI's stork in a race: same world, same rules, its own height and speed
function launch() {
  s.ghost = mode === "race" ? { y: s.y, prevY: s.y, vy: s.vy, angle: 0, flapTime: -1000, alive: true, score: 0, deadAt: 0, reward: 0, trail: [] }
          : mode === "online" && NET.connected ? { y: s.y, prevY: s.y, vy: 0, angle: 0, flapTime: -1000, alive: true, score: 0, deadAt: 0, online: true, label: "Rival", skin: NET.rivalSkin }
          : null;
  s.startAt = performance.now(); s.reward = 0; s.trail = [];
}
function step(flap) {
  const g = s.ghost, online = g && g.online;
  const alive = state === "play";                                         // online, after you crash you watch your rival ("spectate")
  if (mode === "watch") { flap = aiDecide(s); if (flap) sfx("flap"); }   // the AI flies your stork
  const gFlap = !online && g && g.alive && aiDecide(g);                   // decide before anything moves, like the env
  let rS = 0.1, rG = 0.1;                                                  // reward this step, as in stork_env.py
  s.prevY = s.y; prevDistance = distance;
  for (const t of s.towers) t.prevX = t.x;
  if (alive) {
    if (flap) { s.vy = FLAP; s.flapTime = performance.now(); }
    s.vy = Math.min(s.vy + GRAVITY, MAX_FALL);
    s.y += s.vy;
  } else { s.vy = Math.min(s.vy + GRAVITY * 1.4, MAX_FALL * 1.4); s.y = Math.min(s.y + s.vy, H - GROUND - 10); }   // your stork falls
  s.k++;
  if (online) netGhost(g, s.k);                                           // the rival: where they were at this same moment
  else if (g) {
    g.prevY = g.y;
    if (gFlap) { g.vy = FLAP; g.flapTime = performance.now(); }
    g.vy = Math.min(g.vy + GRAVITY * (g.alive ? 1 : 1.4), MAX_FALL * (g.alive ? 1 : 1.4));
    g.y = g.alive ? g.y + g.vy : Math.min(g.y + g.vy, H - GROUND - 10);
  }
  distance += speed();
  for (const t of s.towers) {
    t.x -= speed();
    if (alive && !t.passed && t.x + TOWER_W < STORK_X - STORK_R) {
      t.passed = true; s.score++; s.popT = performance.now(); sfx("point");
      // a stork that was still locked before this run unlocks the moment you reach its score
      const fresh = mode !== "watch" && Object.keys(SKINS).find(id => SKINS[id].need === s.score && SKINS[id].need > s.unlockBase);
      if (fresh) {
        s.toast = { skin: fresh, at: performance.now() };
        setTimeout(() => sfx("unlock"), 160);
        buzz("unlock");
      }
      rS += 1; if (g && g.alive) rG += 1;
      if (mode !== "watch" && s.startBest > 0 && s.score === s.startBest + 1) {   // just beat the old best, still flying
        s.recordAt = performance.now();
        setTimeout(() => sfx("record"), 90);
        buzz("record");
      }
      if (!fresh && MEDALS.some(m => m.min === s.score)) setTimeout(() => sfx("medal"), 120);
    }
  }
  if (s.towers[0].x + TOWER_W < 0) {
    s.towers.shift();
    const last = s.towers[s.towers.length - 1];
    s.towers.push(newTower(last.x + SPACING, last.gapY));
  }
  if (!online && g && g.alive && crashedAt(g.y)) { g.alive = false; g.score = s.score; g.deadAt = performance.now(); sfx("ghostout"); rG = -1; g.reward += rG; }
  else if (g && g.alive) g.reward += rG;
  if (!alive) return;
  const hit = crashed();
  s.reward += hit ? -1 : rS;
  if (mode === "online") netSend(hit ? { t: "dead", k: s.k, score: s.score } : { t: "s", k: s.k, y: Math.round(s.y * 10) / 10, f: flap ? 1 : 0 });
  if (hit) die();
}
function die() {
  state = "over";
  deathTime = performance.now();
  shake = REDUCED ? 0 : 10;
  flash = REDUCED ? 0 : 1;
  sfx("hit");
  
  buzz("crash");

  setTimeout(() => sfx("fall"), 180);
  
  for (let i = 0; i < 14; i++) particles.push({
    type: "feather",
    x: STORK_X, y: s.y, vx: (Math.random() - 0.4) * 6, vy: (Math.random() - 0.8) * 6,
    r: Math.random() * 6, spin: (Math.random() - 0.5) * 0.4, life: 1,
  });
  
  setTimeout(() => sfx("swoosh"), 480);
  const before = bestAll();
  if (mode !== "watch" && s.score > best) { best = s.score; saveBest(best); newBest = true; }   // the AI's runs don't count as yours
  const fresh = Object.keys(SKINS).filter(id => SKINS[id].need > before && unlocked(id));
  s.newSkin = fresh.length ? fresh[fresh.length - 1] : null;
  if (s.ghost && s.ghost.online && s.ghost.alive) { state = "spectate"; s.deadDist = distance; return; }   // online: keep watching until your rival crashes too
  showGameOver();
}
// online: the round ends when both storks are down
function endOnlineRound() { state = "over"; deathTime = performance.now(); showGameOver(); }

/* ---------- the game-over card (HTML) ---------- */
const $ = id => document.getElementById(id);
let overTimer = null;
function hideGameOver() {
  clearInterval(overTimer); overTimer = null;
  $("over").classList.remove("show"); $("over").hidden = true;
  $("game").focus({ preventScroll: true });
}
function showGameOver() {
  const score = s.score, run = deathTime;
  const won = medalFor(score);
  const next = [...MEDALS].reverse().find(m => m.min > score);
  const from = next ? (MEDALS.find(m => m.min < next.min)?.min || 0) : 0;
  $("oLevel").textContent = LEVEL();
  $("oScore").textContent = "0";
  $("oBest").textContent = String(best);
  $("oNew").hidden = true;
  $("oUnlock").hidden = true;
  $("oPassed").textContent = `${score} minaret${score === 1 ? "" : "s"} passed`;
  const medal = $("oMedal");
  medal.className = "medal"; medal.style.removeProperty("--m");
  $("oStatus").textContent = "No medal yet";
  const track = $("oTrack"), fill = $("oFill");
  track.style.setProperty("--n", (next || won).color);
  track.setAttribute("aria-label", next ? `Progress to ${next.name.toLowerCase()}` : "All medals earned");
  track.setAttribute("aria-valuemax", next ? next.min : score);
  fill.style.width = "0%";
  $("oSub").textContent = next ? `${next.min - score} more for ${next.name.toLowerCase()}` : "Top medal!";
  const setBar = n => {
    const f = next ? Math.max(0, Math.min(1, (n - from) / (next.min - from))) : 1;
    fill.style.width = (f * 100) + "%"; track.setAttribute("aria-valuenow", n);
  };
  const net = g0 => g0 && g0.online ? netResult() : null, r = net(s.ghost);
  document.querySelector(".over .title").textContent = r ? r.title : mode === "watch" ? "The AI crashed!" : "Ouch!";
  $("oRetry").querySelector("span").textContent = r ? "Rematch" : "Fly again";
  $("oRetry").disabled = !!(r && r.left);
  $("oBestLbl").textContent = mode === "watch" ? "your best" : "best";
  const race = $("oRace"), g = s.ghost;
  race.hidden = !g;
  race.classList.remove("lost");
  if (r) {
    $("oYou").textContent = score; $("oVs").hidden = false;
    $("oAiLabel").textContent = "Rival"; $("oAi").textContent = r.rivalScore;
    $("oVerdict").textContent = r.left ? "Your rival left" : `Series ${r.me}–${r.rival}`;
    race.classList.toggle("lost", r.result === "lose");
  }
  else if (g) {
    // the result is only what you saw: if the AI was still flying when you crashed, it outlasted you
    const aiAlive = g.alive, won = !aiAlive && score > g.score, tie = !aiAlive && score === g.score;
    $("oYou").textContent = score;
    $("oVs").hidden = aiAlive;                      // only show the AI's score if you saw it crash
    $("oAiLabel").textContent = opponent;
    $("oAi").textContent = g.score;
    $("oVerdict").textContent = aiAlive ? `${opponent} outlasted you` : won ? `You beat ${opponent}!` : tie ? "A tie!" : `${opponent} wins`;
    race.classList.toggle("lost", !won && !tie);
  }
  $("over").hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $("over").classList.add("show");
    $("oRetry").focus({ preventScroll: true });
  }));
  const finish = () => {
    $("oScore").textContent = String(score); setBar(score);
    if (won) {
      medal.style.setProperty("--m", won.color);
      medal.classList.add("won", "pop");
      $("oStatus").textContent = `${won.name[0] + won.name.slice(1).toLowerCase()} medal!`;
    }
    if (newBest) { $("oNew").hidden = false; sfx("best"); confetti(); }
    if (s.newSkin) {
      $("oUnlockName").textContent = SKINS[s.newSkin].name + " stork";
      const t = $("oUnlockTry"); t.dataset.skin = s.newSkin; t.textContent = "Use it"; t.disabled = false;
      $("oUnlock").hidden = false;
    }
    else if (won) sfx("medal");
  };
  setTimeout(() => {
    if (state !== "over" || deathTime !== run) return;
    if (REDUCED || score === 0) { finish(); return; }
    let n = 0;
    overTimer = setInterval(() => {
      if (state !== "over" || deathTime !== run) { clearInterval(overTimer); return; }
      n++; $("oScore").textContent = String(n); setBar(n); sfx("tick");
      if (n >= score) { clearInterval(overTimer); finish(); }
    }, Math.max(30, Math.min(120, 900 / score)));
  }, 950);
}

/* =====================================================================
   DRAWING
   ===================================================================== */
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
// On tall phone screens the game area (400 x 600) doesn't fill the screen, so the canvas
// reaches past it: more sky above, more ground below. The game itself is unchanged.
let OFF_T = 0, OFF_B = 0;
function fitCanvas() {
  const stage = canvas.parentElement.getBoundingClientRect(), wrap = canvas.parentElement.parentElement.getBoundingClientRect();
  const shown = stage.height || H, unit = shown / H;
  OFF_T = Math.max(0, Math.round((stage.top - wrap.top) / unit)); OFF_B = Math.max(0, Math.round((wrap.bottom - stage.bottom) / unit));
  canvas.style.top = -(OFF_T * unit) + "px"; canvas.style.height = ((H + OFF_T + OFF_B) * unit) + "px";
  const k = Math.min(3, Math.max(1, unit) * (devicePixelRatio || 1));
  canvas.width = Math.round(W * k); canvas.height = Math.round((H + OFF_T + OFF_B) * k);
  document.getElementById("over").style.fontSize = (shown / H * 16) + "px";
  // in the app, the start-screen buttons are 25% bigger so they're easy to hit with a thumb
  const btn = shown / H * 16 * (document.documentElement.classList.contains("app") ? 1.25 : 1);
  for (const id of ["modes", "skinBtn", "appTools", "appLevels"]) document.getElementById(id).style.fontSize = btn + "px";
  for (const id of ["opps", "lobbyRow"]) document.getElementById(id).style.fontSize = Math.min(btn, shown / H * 16 * 1.1) + "px";   // four opponents: only a little bigger, so the row still fits
  ctx.setTransform(k, 0, 0, k, 0, OFF_T * k);
}
fitCanvas();
addEventListener("resize", fitCanvas);

const lerp = (a, b, k) => a + (b - a) * k;
const ix = t => lerp(t.prevX, t.x, alpha);
const iy = () => lerp(s.prevY, s.y, alpha);
const rd = () => lerp(prevDistance, distance, alpha);
const mix = (c1, c2, k) => `rgb(${c1.map((v, i) => Math.round(lerp(v, c2[i], k))).join(",")})`;
const SKY = [
  { top: [236, 150, 92], bottom: [250, 210, 150] },
  { top: [120, 80, 120], bottom: [236, 140, 100] },
  { top: [14, 20, 44], bottom: [52, 48, 92] },
];
function skyAt(k) {
  const i = Math.min(1, Math.floor(k * 2)), f = k * 2 - i;
  return { top: mix(SKY[i].top, SKY[i + 1].top, f), bottom: mix(SKY[i].bottom, SKY[i + 1].bottom, f) };
}
const STARS = Array.from({ length: 70 }, (_, i) => ({ x: rand(i) * W, y: rand(i + 99) * 330, r: rand(i + 3) * 1.3 + 0.3 }));

function drawSky(night) {
  const sky = skyAt(night);
  const g = ctx.createLinearGradient(0, 0, 0, H - GROUND);
  g.addColorStop(0, sky.top); g.addColorStop(1, sky.bottom);
  ctx.fillStyle = g; ctx.fillRect(0, -OFF_T, W, H - GROUND + OFF_T);
  if (night > 0.45) {
    ctx.fillStyle = `rgba(255,255,240,${(night - 0.45) * 1.6})`;
    for (const st of STARS) { ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, 7); ctx.fill(); }
  }
  const sunY = lerp(330, 520, Math.min(1, night * 1.6));
  const glow = ctx.createRadialGradient(290, sunY, 10, 290, sunY, 120);
  glow.addColorStop(0, `rgba(255,220,150,${0.7 * (1 - night)})`); glow.addColorStop(1, "rgba(255,220,150,0)");
  ctx.fillStyle = glow; ctx.fillRect(0, -OFF_T, W, H + OFF_T);
  ctx.fillStyle = `rgba(255,236,190,${1 - night})`; ctx.beginPath(); ctx.arc(290, sunY, 34, 0, 7); ctx.fill();
  if (night > 0.6) {
    const a = (night - 0.6) * 2.5;
    ctx.fillStyle = `rgba(250,240,210,${a})`; ctx.beginPath(); ctx.arc(320, 90, 20, 0, 7); ctx.fill();
    ctx.fillStyle = skyAt(night).top; ctx.beginPath(); ctx.arc(330, 84, 18, 0, 7); ctx.fill();
  }
}

function layer(factor, period, draw) {
  const off = (rd() * factor) % period;
  for (let x = -off; x < W + period; x += period) draw(x);
}
function drawBackdrop(night) {
  const shade = (c) => mix(c, [20, 22, 40], night * 0.75);
  ctx.fillStyle = shade([168, 112, 104]);
  layer(0.1, 400, x => {
    ctx.beginPath(); ctx.moveTo(x, 470);
    [[40, 410], [90, 440], [150, 380], [200, 420], [260, 395], [320, 445], [370, 405], [400, 470]].forEach(([dx, y]) => ctx.lineTo(x + dx, y));
    ctx.lineTo(x + 400, 540); ctx.lineTo(x, 540); ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${0.5 * (1 - night)})`;
    ctx.beginPath(); ctx.moveTo(x + 135, 392); ctx.lineTo(x + 150, 380); ctx.lineTo(x + 165, 394); ctx.fill();
    ctx.fillStyle = shade([168, 112, 104]);
  });
  layer(0.35, 240, x => {
    ctx.fillStyle = shade([196, 124, 82]);
    ctx.fillRect(x, 500, 240, 40);
    for (let c = 0; c < 240; c += 16) ctx.fillRect(x + c, 492, 9, 8);
    ctx.fillStyle = shade([120, 70, 48]);
    ctx.beginPath(); ctx.moveTo(x + 60, 540); ctx.lineTo(x + 60, 516); ctx.arc(x + 70, 516, 10, Math.PI, 0); ctx.lineTo(x + 80, 540); ctx.fill();
    ctx.strokeStyle = shade([92, 64, 40]); ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(x + 170, 540); ctx.quadraticCurveTo(x + 176, 490, x + 168, 452); ctx.stroke();
    ctx.fillStyle = shade([46, 110, 70]);
    for (let a = 0; a < 6; a++) {
      const ang = -Math.PI + a * (Math.PI / 5);
      ctx.beginPath(); ctx.ellipse(x + 168 + Math.cos(ang) * 16, 452 + Math.sin(ang) * 7, 18, 4, ang, 0, 7); ctx.fill();
    }
  });
}

const STYLES = [
  { body: [214, 170, 112], dark: [176, 132, 82] },
  { body: [236, 230, 214], dark: [196, 186, 166] },
  { body: [186, 96, 70], dark: [146, 70, 50] },
];
function zellige(x, y, w, h, light) {
  ctx.fillStyle = mix([31, 122, 92], [10, 40, 40], light); ctx.fillRect(x, y, w, h);
  ctx.fillStyle = mix([240, 232, 210], [70, 70, 90], light);
  for (let i = 0; i < w; i += 8) {
    ctx.beginPath(); ctx.moveTo(x + i + 4, y + 1); ctx.lineTo(x + i + 7, y + h / 2); ctx.lineTo(x + i + 4, y + h - 1); ctx.lineTo(x + i + 1, y + h / 2); ctx.fill();
  }
}
function drawMinaret(t, night) {
  const gap = t.gap, x0 = ix(t), edge = t.gapY + gap / 2;
  const st = STYLES[t.style];
  const body = (c) => mix(c, [24, 26, 46], night * 0.7);
  let top = edge;
  if (t.nest) {
    ctx.fillStyle = body([120, 84, 52]);
    ctx.beginPath(); ctx.ellipse(x0 + 32, edge + 6, 18, 6, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = body([90, 60, 36]); ctx.lineWidth = 1.5;
    for (let i = -14; i <= 14; i += 5) { ctx.beginPath(); ctx.moveTo(x0 + 32 + i, edge + 2); ctx.lineTo(x0 + 32 + i + 6, edge + 10); ctx.stroke(); }
    top = edge + 8;
  }
  ctx.fillStyle = body([210, 170, 70]);
  ctx.beginPath(); ctx.arc(x0 + 32, top + 4, 4, 0, 7); ctx.fill();
  ctx.fillStyle = body([31, 122, 92]);
  ctx.beginPath(); ctx.moveTo(x0 + 18, top + 22); ctx.lineTo(x0 + 32, top + 8); ctx.lineTo(x0 + 46, top + 22); ctx.fill();
  ctx.fillStyle = body(st.dark); ctx.fillRect(x0 + 18, top + 22, 28, 22);
  ctx.fillStyle = body([60, 40, 30]);
  ctx.beginPath(); ctx.moveTo(x0 + 28, top + 44); ctx.lineTo(x0 + 28, top + 32); ctx.arc(x0 + 32, top + 32, 4, Math.PI, 0); ctx.lineTo(x0 + 36, top + 44); ctx.fill();
  const shaft = top + 52;
  ctx.fillStyle = body(st.body);
  for (let cx = x0; cx < x0 + TOWER_W; cx += 16) ctx.fillRect(cx, shaft - 8, 10, 8);
  ctx.fillRect(x0, shaft, TOWER_W, H - GROUND - shaft);
  ctx.fillStyle = body(st.dark); ctx.fillRect(x0 + TOWER_W - 10, shaft, 10, H - GROUND - shaft);
  zellige(x0, shaft + 10, TOWER_W, 12, night * 0.7);
  for (let wy = shaft + 46; wy < H - GROUND - 30; wy += 70) {
    ctx.fillStyle = body([70, 46, 34]);
    ctx.beginPath(); ctx.moveTo(x0 + 24, wy + 26); ctx.lineTo(x0 + 24, wy + 8); ctx.arc(x0 + 32, wy + 8, 9, Math.PI * 0.9, Math.PI * 0.1); ctx.lineTo(x0 + 40, wy + 26); ctx.fill();
    if (night > 0.55) { ctx.fillStyle = `rgba(255,200,110,${(night - 0.55) * 1.8})`; ctx.fillRect(x0 + 26, wy + 10, 12, 15); }
  }
}
function drawCloud(t, night) {
  const gap = t.gap, x0 = ix(t), bottom = t.gapY - gap / 2;
  const c = mix([84, 90, 116], [36, 38, 60], night);
  ctx.fillStyle = c; ctx.fillRect(x0 - 6, -OFF_T, TOWER_W + 12, bottom - 16 + OFF_T);
  for (let j = 0; j < 4; j++) {
    const cx = x0 - 6 + j * (TOWER_W + 12) / 3;
    ctx.beginPath(); ctx.arc(cx, bottom - 16, 16, 0, 7); ctx.fill();
  }
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(x0 - 6, -OFF_T, 10, bottom - 20 + OFF_T);
}
function drawStork(b = s) {
  const ghost = b !== s, down = ghost ? !b.alive : state === "over" || state === "spectate";
  // online, after you crash your stork stays where it fell and scrolls away with the ground while you watch your rival
  const x = !ghost && s.deadDist != null ? STORK_X - (rd() - s.deadDist) : STORK_X, y = lerp(b.prevY, b.y, alpha);
  if (x < -40) return;
  const target = down ? b.angle + 0.15 * frameScale : Math.max(-0.45, Math.min(0.8, b.vy / 12));
  b.angle = down ? Math.min(target, 1.6) : lerp(b.angle, target, 1 - Math.pow(0.75, frameScale));
  ctx.save();
  if (ghost) {                     // the AI: see-through, with a small tag
    const fade = b.alive ? 1 : Math.max(0, 1 - (performance.now() - b.deadAt) / 900);
    if (fade <= 0) { ctx.restore(); return; }
    ctx.globalAlpha *= (state === "spectate" ? 0.85 : 0.5) * fade;   // multiply, so an outer fade still works; clearer while you watch
    ctx.font = `600 11px ${SANS}`; ctx.textAlign = "center"; ctx.fillStyle = "#e9f4ff";
    ctx.fillText(b.label || opponent, x, y - 22);
  }
  ctx.translate(x, y); ctx.rotate(b.angle);
  const flapElapsed = performance.now() - b.flapTime;          // smooth wing flap, timed in real time
  const k = Math.min(1, flapElapsed / (8 * STEP_MS));
  const wingAngle = down ? 0.6 : lerp(-1.1, 0.25, k) + (state === "ready" ? Math.sin(performance.now() / 160) * 0.5 : 0);
  paintStork(ctx, ghost ? SKINS[b.skin] || SKINS.classic : SKINS[skin], wingAngle, Math.min(1, rd() / 9000));   // the AI always looks classic; a rival shows their stork
  ctx.restore();
}
// Draws a stork at (0, 0) on any canvas: used in the game and for the skin previews
function paintStork(c, sk, wingAngle, night = 0) {
  c.save();
  const glow = sk.glow && (!sk.nightOnly || night > 0.4);
  if (glow) { c.shadowColor = sk.glow; c.shadowBlur = sk.nightOnly ? 6 + 10 * night : 10; }
  c.strokeStyle = "rgb(226,96,40)"; c.lineWidth = 2.5; c.lineCap = "round";
  c.beginPath(); c.moveTo(-6, 6); c.lineTo(-24, 12); c.moveTo(-4, 8); c.lineTo(-22, 16); c.stroke();
  c.fillStyle = sk.body;
  c.beginPath(); c.ellipse(-1, 0, 16, 9, 0, 0, 7); c.fill();
  c.beginPath(); c.moveTo(8, -4); c.quadraticCurveTo(14, -8, 17, -12); c.lineTo(21, -9); c.quadraticCurveTo(16, -3, 12, 3); c.fill();
  c.beginPath(); c.arc(19, -11, 5, 0, 7); c.fill();
  c.shadowBlur = 0;
  c.fillStyle = "rgb(226,96,40)";
  c.beginPath(); c.moveTo(23, -13); c.lineTo(38, -9); c.lineTo(23, -8); c.fill();
  c.fillStyle = "#151515"; c.beginPath(); c.arc(20, -12, 1.4, 0, 7); c.fill();
  c.save(); c.translate(-2, -3); c.rotate(wingAngle);
  c.fillStyle = sk.body;
  c.beginPath(); c.ellipse(-10, 0, 14, 6, 0, 0, 7); c.fill();
  if (sk.pattern) {                       // a row of small zellige diamonds along the wing
    c.fillStyle = sk.pattern;
    for (const dx of [-3, -9, -15]) { c.beginPath(); c.moveTo(dx, -3); c.lineTo(dx + 2.6, 0); c.lineTo(dx, 3); c.lineTo(dx - 2.6, 0); c.fill(); }
  }
  c.fillStyle = sk.tip;
  c.beginPath(); c.moveTo(-14, -4); c.lineTo(-34, -1); c.lineTo(-30, 3); c.lineTo(-14, 5); c.fill();
  c.restore();
  c.restore();
}

let particles = [];
// Confetti for a new best: falls from the top of the screen, around the results card
function confetti() {
  if (REDUCED) return;
  const colors = ["#ffaa36", "#2fae7a", "#e2b444", "#c9ced6", "#c27a45", "#f3f1ea", "#d08c3e"];
  for (let i = 0; i < 60; i++) particles.push({
    type: "confetti",
    x: Math.random() * W, y: -10 - Math.random() * 120,
    vx: (Math.random() - 0.5) * 3, vy: 1 + Math.random() * 3,
    w: 6 + Math.random() * 8, h: 4 + Math.random() * 6,
    r: Math.random() * Math.PI * 2, spin: (Math.random() - 0.5) * 0.3,
    life: 2.2, color: colors[Math.floor(Math.random() * colors.length)],
  });
}
function drawParticles(kind) {
  for (const p of particles) {
    if (p.type !== kind) continue;
    p.x += p.vx * frameScale;
    p.y += p.vy * frameScale;
    p.vy = p.type === "confetti" ? Math.min(p.vy + 0.05 * frameScale, 3.5) : p.vy + 0.2 * frameScale;   // confetti flutters down slowly
    if (p.type === "confetti") p.x += Math.sin(p.r * 2) * 0.6 * frameScale;
    p.r += p.spin * frameScale;
    p.life -= (p.type === "confetti" ? 0.01 : 0.015) * frameScale;
    if (p.life <= 0) continue;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.r);
    ctx.globalAlpha = Math.min(1, p.life);
    if (p.type === "confetti") {
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    } else {
      ctx.fillStyle = "#fbfaf4";
      ctx.beginPath(); ctx.ellipse(0, 0, 6, 2, 0, 0, 7); ctx.fill();
    }
    ctx.restore();
  }
  particles = particles.filter(p => p.life > 0);
}

const DISPLAY = '"Lilita One", "Arial Rounded MT Bold", "Trebuchet MS", sans-serif';
const SANS = '"Fredoka", "Trebuchet MS", system-ui, sans-serif';
function text(str, x, y, size, color, align = "center", fontType = "DISPLAY", maxW = W - 40, outline = true) {
  const big = fontType === "DISPLAY";
  ctx.font = big ? `${size}px ${DISPLAY}` : `600 ${size}px ${SANS}`;
  ctx.textAlign = align; ctx.lineJoin = "round";
  if (big && size >= 18 && outline) {
    const o = Math.max(2.5, size * 0.09);
    ctx.fillStyle = "#3a2210"; ctx.fillText(str, x, y + o * 0.9, maxW);
    ctx.strokeStyle = "#3a2210"; ctx.lineWidth = o * 2; ctx.strokeText(str, x, y, maxW);
  } else if (big) {
    ctx.fillStyle = "rgba(255,255,255,0.2)"; ctx.fillText(str, x, y + 2, maxW);
  }
  ctx.fillStyle = color; ctx.fillText(str, x, y, maxW);
}
function pill(label, x, y, active) {
  ctx.font = `700 13px ${SANS}`;
  const w = ctx.measureText(label).width + 26;
  ctx.fillStyle = active ? "#d08c3e" : "rgba(255,255,255,0.12)";
  ctx.beginPath(); ctx.roundRect(x - w / 2, y - 14, w, 26, 13); ctx.fill();
  ctx.fillStyle = active ? "#08080a" : "#f3f1ea"; ctx.textAlign = "center"; ctx.fillText(label, x, y + 4);
}
const LEVEL = () => (difficulty === 0 ? "Easy" : difficulty === 0.5 ? "Medium" : "Hard");

function star(x, y, r, fill, rot = 0) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.fillStyle = fill;
  for (const a of [0, Math.PI / 4]) { ctx.save(); ctx.rotate(a); ctx.fillRect(-r * 0.71, -r * 0.71, r * 1.42, r * 1.42); ctx.restore(); }
  ctx.restore();
}
function drawMedal(m, x, y, appear) {
  if (!m) {
    ctx.fillStyle = "rgba(255,255,255,0.05)"; ctx.beginPath(); ctx.arc(x, y, 44, 0, 7); ctx.fill();
    star(x, y, 30, "#6b645a");
    star(x, y, 19, "#2b2825");
    star(x, y, 12, "#6b645a");
    text("no medal yet", x, y + 56, 14, "#b8b0a2", "center", "SANS");
    return;
  }
  const k = REDUCED ? 1 : Math.min(1, appear);
  const sc = k < 1 ? 0.3 + 0.7 * (1 - Math.pow(1 - k, 3)) + Math.sin(k * Math.PI) * 0.25 : 1;
  ctx.save(); ctx.translate(x, y); ctx.scale(sc, sc); ctx.globalAlpha = k;
  const glow = ctx.createRadialGradient(0, 0, 8, 0, 0, 52);
  glow.addColorStop(0, m.color + "66"); glow.addColorStop(1, m.color + "00");
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(0, 0, 52, 0, 7); ctx.fill();
  star(0, 0, 32, m.color, performance.now() / 4000);
  star(0, 0, 21, "rgba(17,17,20,0.85)");
  star(0, 0, 13, m.color);
  const sh = (performance.now() / 1600) % 1;
  if (!REDUCED && sh < 0.25) { ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.beginPath(); ctx.arc(-20 + sh * 160, -10, 4, 0, 7); ctx.fill(); }
  ctx.restore();
  text(m.name.toLowerCase(), x, y + 58, 14, m.color, "center", "SANS");
}

// LAB VIEW ----------------------------------------------------------------
let capA = mode === "solo" ? 0 : 1, capLabel = "Choose your opponent";
// "Stork unlocked!" card: slides in at the top right, stays 2.5 s, slides out
// fill for a rarity word: its medal colour with a band of light sweeping through the letters
function shineFill(c, id, x, width, now) {
  if (REDUCED) return skinColor(id);
  const p = shinePos(now, 1500, 400), cx = x + p * width;
  const g = c.createLinearGradient(cx - 18, 0, cx + 18, 0);
  g.addColorStop(0, skinColor(id)); g.addColorStop(0.5, SHINE[id]); g.addColorStop(1, skinColor(id));
  return g;
}
function drawUnlockToast(now) {
  const e = now - s.toast.at, IN = 320, STAY = 2800, OUT = 380;
  if (e > STAY + OUT) { s.toast = null; return; }
  const ease = k => 1 - Math.pow(1 - k, 3);
  const k = e < IN ? ease(e / IN) : e > STAY ? 1 - ease((e - STAY) / OUT) : 1;   // 0 = hidden, 1 = fully in
  const w = 150, h = 38, y = 6;   // above the score
  const x = REDUCED ? W - w - 12 : lerp(W + 8, W - w - 12, k);
  ctx.save();
  ctx.globalAlpha = REDUCED ? k : Math.min(1, k * 1.4);
  ctx.shadowColor = "rgba(0,0,0,0.45)"; ctx.shadowBlur = 14; ctx.shadowOffsetY = 4;
  ctx.fillStyle = "rgba(24,22,26,0.94)"; ctx.beginPath(); ctx.roundRect(x, y, w, h, 10); ctx.fill();
  ctx.shadowColor = "transparent";
  if (!REDUCED) {                       // a gold sheen glides across the card while it's on screen
    const p = shinePos(now, 1500), bx = x + p * w;
    ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, w, h, 10); ctx.clip();
    const g = ctx.createLinearGradient(bx - 40, y, bx + 40, y + h);
    g.addColorStop(0, "rgba(255,207,63,0)"); g.addColorStop(0.5, "rgba(255,207,63,0.22)"); g.addColorStop(1, "rgba(255,207,63,0)");
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
  ctx.strokeStyle = `rgba(255,207,63,${REDUCED ? 0.45 : 0.45 + 0.3 * Math.sin(now / 180) ** 2})`; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 10); ctx.stroke();
  // the new stork, on a small medal-coloured disc
  const sk = SKINS[s.toast.skin], m = MEDALS.find(m => m.min === sk.need);
  ctx.fillStyle = (m ? m.color : "#ffcf3f") + "33"; ctx.beginPath(); ctx.arc(x + 20, y + h / 2, 14, 0, 7); ctx.fill();
  ctx.save(); ctx.translate(x + 19, y + h / 2 + 2); ctx.scale(0.4, 0.4); paintStork(ctx, sk, -0.5, sk.nightOnly ? 1 : 0); ctx.restore();
  ctx.textAlign = "left";
  ctx.font = `13px ${DISPLAY}`; ctx.fillStyle = "#ffcf3f"; ctx.fillText("Stork unlocked!", x + 40, y + 17);
  // only the rarity word is in its medal colour, outlined; "stork" stays in the normal colour
  ctx.font = `13px ${DISPLAY}`; ctx.lineJoin = "round";
  ctx.strokeStyle = "#140e08"; ctx.lineWidth = 3; ctx.strokeText(sk.name, x + 40, y + 32);
  const nw = ctx.measureText(sk.name).width;
  ctx.fillStyle = shineFill(ctx, s.toast.skin, x + 40, nw, now);
  ctx.fillText(sk.name, x + 40, y + 32);
  ctx.fillStyle = "#f3f1ea"; ctx.fillText(" stork", x + 40 + nw, y + 32);   // same font and size as the rarity word, plain white, no outline or shine
  ctx.restore();
}

function drawUI(now) {
  if (state === "play" || state === "spectate") {
    const k = (now - s.popT) / 220;
    const sc = REDUCED || k >= 1 ? 1 : 1 + 0.35 * Math.pow(1 - k, 2);
    const record = mode !== "watch" && s.startBest > 0 && s.score > s.startBest;        // golden for as long as this run is the best
    ctx.save(); ctx.translate(W / 2, 70); ctx.scale(sc, sc);
    ctx.shadowColor = record ? "rgba(255,196,60,0.55)" : "rgba(0,0,0,0.35)"; ctx.shadowBlur = record ? 18 : 12;
    text(String(s.score), 0, 22, 64, record ? "#ffcf3f" : "#fff");
    ctx.restore();
    if (mode === "watch") {           // short instruction that fades out after 3 seconds
      const a = Math.max(0, Math.min(1, 1 - (now - s.startAt - 3000) / 600));
      if (a > 0) { ctx.save(); ctx.globalAlpha = a; text("The AI is flying · tap or Esc to stop", W / 2, 118, 13, "#e8e2d6", "center", "SANS"); ctx.restore(); }
    }
    if (state === "spectate") text("Your rival is still flying…", W / 2, 118, 14, "#e8e2d6", "center", "SANS");
    else if (s.rivalOutAt) {           // online: your rival crashed while you're still flying
      const a = Math.max(0, Math.min(1, 1 - (now - s.rivalOutAt - 2500) / 500));
      if (a > 0) { ctx.save(); ctx.globalAlpha = a; text("Your rival crashed · you win!", W / 2, 118, 14, "#ffcf3f", "center", "SANS"); ctx.restore(); }
    }
    if (s.toast) drawUnlockToast(now);
    // "HIGH SCORE REACHED": small, under the score, gone after 3.5 s
    const e = now - s.recordAt;
    if (e >= 0 && e < 3500) {
      let a = Math.min(1, e / 200) * Math.min(1, (3500 - e) / 500);       // fade in, then out
      const near = Math.max(0, Math.min(1, 1 - (iy() - 110) / 260));       // 1 = the stork is right under the banner
      a *= 1 - 0.35 * near;                                                // and it turns see-through so it never blocks the view
      const amp = REDUCED ? 0 : 0.5 + 2.5 * near;                         // vibrates harder the higher the stork flies
      const jx = (Math.random() - 0.5) * amp * 2, jy = (Math.random() - 0.5) * amp * 2;
      ctx.save(); ctx.globalAlpha = a; ctx.translate(jx, jy);
      ctx.font = `14px ${DISPLAY}`;
      ctx.textAlign = "center";
      ctx.lineJoin = "round"; ctx.strokeStyle = "#3a2210"; ctx.lineWidth = 3.5;              // dark outline, like the score
      ctx.strokeText("HIGH SCORE REACHED", W / 2, 116);
      ctx.fillStyle = "#ffcf3f"; ctx.fillText("HIGH SCORE REACHED", W / 2, 116);
      ctx.restore();
    }
    return;
  }
  ctx.fillStyle = state === "over" ? "rgba(8,8,10,0.78)" : "rgba(8,8,10,0.5)"; ctx.fillRect(0, -OFF_T, W, H + OFF_T + OFF_B);
  if (state === "count") {           // online: 3, 2, 1, then both phones start
    const left = Math.max(0, countEnd - now), n = Math.ceil(left / 1000), f = (left % 1000) / 1000;
    text("You vs Rival", W / 2, 150, 22, "#e8e2d6");
    text(`${LEVEL()} · same course · last one flying wins`, W / 2, 178, 13, "#cfc9bd", "center", "SANS");
    ctx.save(); ctx.translate(W / 2, 330); const sc = REDUCED ? 1 : 1 + 0.4 * f; ctx.scale(sc, sc); ctx.globalAlpha = REDUCED ? 1 : 1 - 0.6 * (1 - f);
    text(String(Math.max(1, n)), 0, 30, 110, "#fff"); ctx.restore();
    return;
  }
  if (state === "ready") {
    ctx.save(); ctx.translate(W / 2, 214); ctx.rotate(-3 * Math.PI / 180);   // tilted, like the page headings
    text("Stork", 0, -36, 80, "#fff");
    text("Flight", 0, 36, 80, "#f0a24a");
    ctx.restore();
    const r = (now / 900) % 1;
    for (const off of [0, 0.5]) {
      const q = (r + off) % 1;
      ctx.strokeStyle = `rgba(255,255,255,${REDUCED ? 0.5 : 0.7 * (1 - q)})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(170, H / 2 + 8, 10 + q * 22, 0, 7); ctx.stroke();
    }
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(170, H / 2 + 8, 7, 0, 7); ctx.fill();
    text("tap!", 210, H / 2 + 16, 24, "#fff", "left");
    capA += ((mode === "solo" ? 0 : 1) - capA) * (REDUCED ? 1 : Math.min(1, frameMs / 110));   // cross-fade
    if (mode !== "solo") capLabel = mode === "race" ? "Choose your opponent" : mode === "online" ? "Race a friend on another phone" : "Choose which AI to watch";
    ctx.save();
    ctx.globalAlpha = 1 - capA; text("Fly between the minarets and the storm clouds.", W / 2, 380, 15, "#e8e2d6", "center", "SANS");
    ctx.globalAlpha = capA; text(capLabel, W / 2, 350, 14, "#e8e2d6", "center", "SANS");
    ctx.restore();
    if (!APP) pill(LEVEL(), W / 2, 420, true);   // in the app, real Easy / Medium / Hard buttons sit here
    const pulse = 0.6 + 0.4 * Math.sin(now / 300);
    ctx.save(); ctx.globalAlpha = REDUCED ? 1 : pulse;
    const verb = mode === "watch" ? "watch" : mode === "race" ? "race" : "fly";
    text(mode === "online" ? (NET.connected ? (NET.host ? "Tap to start the match" : "Waiting for the host to start") : "Tap to open the lobby")
         : TOUCH ? `Tap to ${verb}` : `Tap or press space to ${verb}`, W / 2, 472, 22, "#fff");   // no "space" on phones
    ctx.restore();
    if (best) {
      text(`Best ${best}`, W / 2, 504, 15, "#cfc9bd", "center", "SANS");
      const m = medalFor(best);
      if (m) star(W / 2 + ctx.measureText(`Best ${best}`).width / 2 + 12, 499, 6, m.color);
    }
    return;
  }
}

function draw(now) {
  const night = Math.min(1, rd() / 9000);
  ctx.save();
  if (shake > 0) {
    ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    shake *= Math.pow(0.85, frameScale); if (shake < 0.5) shake = 0;
  }
  drawSky(night);
  drawBackdrop(night);
  
  if (trans) {
    const t = Math.min(1, (now - trans.start) / trans.duration);
    const ease = 1 - Math.pow(1 - t, 3);
    ctx.save();
    ctx.globalAlpha = 1 - ease;
    const shift = ease * 500;
    for (const ot of trans.fromTowers) {
      const ox = ot.x - shift;
      drawCloud({ x: ox, prevX: ox, gapY: ot.gapY, gap: ot.gap }, night);
      drawMinaret({ x: ox, prevX: ox, gapY: ot.gapY, gap: ot.gap, style: ot.style, nest: ot.nest }, night);
    }
    ctx.restore();
  }
  
  for (const t of s.towers) { drawCloud(t, night); drawMinaret(t, night); }
  
  ctx.fillStyle = mix([178, 120, 70], [40, 34, 44], night * 0.7); ctx.fillRect(0, H - GROUND, W, GROUND + OFF_B);
  ctx.fillStyle = mix([206, 150, 96], [56, 48, 60], night * 0.7); ctx.fillRect(0, H - GROUND, W, 6);
  ctx.fillStyle = "rgba(0,0,0,0.08)";
  layer(1, 40, x => ctx.fillRect(x, H - GROUND + 18, 20, 4));
  if (s.ghost && (state === "play" || state === "spectate")) drawStork(s.ghost);   // the AI (or your online rival) flies behind you
  else if (s.ghost && state === "over" && s.ghost.alive) {   // you crashed: the AI fades away where it was
    const k = 1 - (performance.now() - deathTime) / 400;
    if (k > 0) { ctx.save(); ctx.globalAlpha = k; drawStork(s.ghost); ctx.restore(); }
  }
  if (state !== "ready") drawStork();
  drawParticles("feather");
  ctx.restore();
  drawUI(now);
  drawParticles("confetti");             // above the dimming, so it stays bright
  if (state === "ready" || state === "count") drawStork();
  if (flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${flash * 0.7})`; ctx.fillRect(0, -OFF_T, W, H + OFF_T + OFF_B);
    flash = Math.max(0, flash - 0.08 * frameScale);
  }
}

/* =====================================================================
   INPUT AND GAME LOOP
   ===================================================================== */
let pending = false, last = 0, acc = 0;
function startFlight() {
  // online: the course comes from the seed both phones share; otherwise it's random
  courseRandom = mode === "online" && NET.seed != null ? seeded(NET.seed) : Math.random; towerCount = 0;
  hideGameOver(); reset(); distance = prevDistance = 0;
  s.y = s.prevY = H / 2;
  state = "play"; pending = mode !== "watch"; launch(); sfx("start"); sfx("flap");
}
function input() {
  if (trans || state === "count" || state === "spectate") return;
  ensureAudio();
  if (mode === "online" && state === "ready") { netTapReady(); return; }   // online runs start together, from the lobby
  if (state === "play") {
    if (mode === "watch") { toMenu(); return; }          // tapping while the AI flies stops the demo
    pending = true; sfx("flap"); return;
  }
  if (state === "ready") { state = "play"; s.prevY = s.y; s.vy = 0; pending = mode !== "watch"; launch(); if (pending) sfx("flap"); return; }
}
function retry() { if (mode === "online") netRematch(); else startFlight(); }
function toMenu() {
  if (mode === "online" && (state === "play" || state === "count")) netSend({ t: "dead", k: s.k, score: s.score });   // leaving a run online counts as a crash
  courseRandom = Math.random; hideGameOver(); reset(); distance = prevDistance = 0; state = "ready"; sfx("click"); }

function changeDifficulty(newDifficulty) {
  if (trans) return;
  if (newDifficulty === difficulty) return;
  
  if (panelOpen) {
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("open"));
    document.querySelectorAll("[data-page]").forEach(t => {
      if (t.dataset.page === "game") t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
    });
    panelOpen = null;
  }
  
  const fromDist = rd();
  const fromY = iy();
  const fromTowers = s.towers.map(t => ({
    x: ix(t), gapY: t.gapY, gap: t.gap, style: t.style, nest: t.nest,
  }));
  
  difficulty = newDifficulty;
  best = loadBest();
  document.querySelectorAll("[data-d]").forEach(o =>
    o.setAttribute("aria-pressed", String(+o.dataset.d === difficulty))
  );
  
  hideGameOver();
  reset();
  distance = prevDistance = fromDist;
  s.y = s.prevY = fromY;
  
  trans = { start: performance.now(), duration: REDUCED ? 1 : 700, fromDist, fromY, fromTowers };
  state = "ready";
  ensureAudio();
  sfx("swoosh");
}

const canReact = () => performance.now() - deathTime > 900;
addEventListener("keydown", e => {
  if (e.target.tagName === 'BUTTON' && (e.code === 'Space' || e.code === 'Enter')) return;
  if (e.code === "KeyM") { toggleMute(); return; }
  if (panelOpen) { if (e.code === "Escape") showPage(null); return; }
  if (e.code === "Space" || e.code === "ArrowUp" || e.code === "Enter") {
    e.preventDefault(); if (e.repeat) return;
    ensureAudio();
    if (state === "over") { if (canReact()) retry(); }
    else input();
  }
  if (e.code === "Escape" && state === "over" && canReact()) toMenu();
  if (e.code === "Escape" && state === "play" && mode === "watch") toMenu();
});
canvas.addEventListener("pointerdown", e => {
  e.preventDefault(); ensureAudio();
  if (state !== "over") input();
});
let panelOpen = null;
function setSkin(id) {
  if (!unlocked(id)) return;
  skin = id;
  try { localStorage.setItem("stork-skin", id); } catch (e) {}
  renderSkins(); drawSkinIcon(); sfx("click");
}
// the start-screen button shows your current stork
function drawSkinIcon() {
  const c = $("skinIcon").getContext("2d");
  c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, 96, 96);
  c.translate(46, 53); c.scale(1.2, 1.2);   // the whole stork, wing tip to beak, fits in the circle
  paintStork(c, SKINS[skin], -0.5, skin === "emerald" ? 1 : 0);
}
let shiny = [];                        // redraw functions of the previews that shimmer
function shineLoop(now) {
  if (panelOpen !== "skins") return;   // only runs while the skin page is open
  for (const draw of shiny) draw(now);
  requestAnimationFrame(shineLoop);
}
function renderSkins() {
  const grid = $("skinGrid"); grid.innerHTML = ""; shiny = [];
  for (const id in SKINS) {
    const sk = SKINS[id], open = unlocked(id);
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "skin-card"; btn.disabled = !open;
    btn.setAttribute("aria-pressed", String(id === skin));
    btn.innerHTML = `<canvas width="240" height="128" aria-hidden="true"></canvas><b class="${id === "classic" ? "" : open ? "rare shine" : "rare locked"}" style="--c:${skinColor(id)};--l:${SHINE[id] || "#fff"};animation-delay:${Object.keys(SKINS).indexOf(id) * -0.45}s" data-text="${sk.name}">${sk.name}</b><small>${
      id === "classic" ? "Always yours" : open ? (id === skin ? "Flying now" : "Unlocked") : `Locked · ${sk.need} minarets for ${sk.name.toLowerCase()}`}</small>`;
    const c = btn.querySelector("canvas").getContext("2d");
    const draw = now => {
      c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, 240, 128);
      c.scale(2, 2); c.translate(62, 36); c.scale(1.5, 1.5); paintStork(c, sk, -0.5, id === "emerald" ? 1 : 0);
      if (now == null) return;
      // the sweep only lights the stork itself (source-atop), never the empty background
      const p = shinePos(now, 2600, Object.keys(SKINS).indexOf(id) * 450);
      if (p > 2) return;
      c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = "source-atop";
      const bx = p * 240, g = c.createLinearGradient(bx - 40, 0, bx + 40, 128);
      g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.5, SHINE[id] + "aa"); g.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = g; c.fillRect(0, 0, 240, 128); c.globalCompositeOperation = "source-over";
    };
    draw();
    if (open && id !== "classic" && SHINE_PREVIEWS && !REDUCED) shiny.push(draw);
    btn.addEventListener("click", () => setSkin(id));
    grid.appendChild(btn);
  }
}
$("skinBtn").addEventListener("click", () => { showPage("skins"); $("skinBtn").blur(); });
drawSkinIcon();
$("oUnlockTry").addEventListener("click", e => {
  setSkin(e.currentTarget.dataset.skin);
  e.currentTarget.textContent = "Equipped"; e.currentTarget.disabled = true;
});
function showPage(id) {
  if (id === "skins") { renderSkins(); }
  document.querySelectorAll(".panel").forEach(p => p.classList.toggle("open", p.id === id));
  document.querySelectorAll("[data-page]").forEach(t => t.toggleAttribute("aria-current", t.dataset.page === (id && id !== "skins" ? id : "game")));
  document.querySelectorAll("[data-page][aria-current]").forEach(t => t.setAttribute("aria-current", "page"));
  panelOpen = id || null;
  if (id === "skins" && shiny.length) requestAnimationFrame(shineLoop);
  ensureAudio(); sfx("click");
  if (!id) canvas.focus?.();
}
document.querySelectorAll("[data-page]").forEach(t => t.addEventListener("click", () => { showPage(t.dataset.page === "game" ? null : t.dataset.page); t.blur(); }));
$("oRetry").addEventListener("click", () => { if (canReact()) retry(); });
$("oHome").addEventListener("click", () => { if (canReact()) toMenu(); });
document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => showPage(null)));
for (const id of ["soundBtn", "appSound"]) document.getElementById(id).addEventListener("click", e => { toggleMute(); e.currentTarget.blur(); });
// Android back button (app only): close a page, leave the run, or exit from the start screen
const APP_PLUGIN = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
if (APP_PLUGIN) APP_PLUGIN.addListener("backButton", () => {
  if (panelOpen) showPage(null);
  else if (state !== "ready") toMenu();
  else APP_PLUGIN.exitApp();
});
syncSoundBtn();
document.querySelectorAll("[data-d]").forEach(b => b.addEventListener("click", () => {
  changeDifficulty(+b.dataset.d);
  b.blur();
}));

function setMode(m) {
  if (m !== "online" && mode === "online") netLeave();
  mode = m;
  try { localStorage.setItem("stork-mode", m); } catch (e) {}
  document.querySelectorAll("[data-mode]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
  if (state === "ready") reset();
  ensureAudio(); sfx("click");
}
document.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => { setMode(b.dataset.mode); b.blur(); }));
document.querySelectorAll("[data-mode]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
const modesEl = $("modes"), oppsEl = $("opps");
function setOpponent(o) {
  opponent = o;
  try { localStorage.setItem("stork-opponent", o); } catch (e) {}
  document.querySelectorAll("[data-opp]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.opp === o)));
  ensureAudio(); sfx("click");
}
document.querySelectorAll("[data-opp]").forEach(b => {
  b.setAttribute("aria-pressed", String(b.dataset.opp === opponent));
  b.addEventListener("click", () => { setOpponent(b.dataset.opp); b.blur(); });
});

let frameMs = 16.7;
function loop(now) {
  frameMs = Math.min(now - last, 100);
  acc += panelOpen ? 0 : frameMs; last = now;
  while (acc >= STEP_MS) {
    if (state === "play" || state === "spectate") { step(pending); pending = false; }
    else if (state === "ready" || state === "count") {
      if (state === "count" && now >= countEnd) { startFlight(); continue; }
      if (trans) {
        const t = Math.min(1, (now - trans.start) / trans.duration);
        const ease = 1 - Math.pow(1 - t, 3);
        prevDistance = distance;
        distance = lerp(trans.fromDist, 0, ease);
        s.prevY = s.y;
        s.y = lerp(trans.fromY, H / 2 + 8 + Math.sin(now / 400) * 10, ease);
        if (t >= 1) trans = null;
      } else {
        prevDistance = distance; s.prevY = s.y;
        distance += 1.2; s.y = H / 2 + 8 + Math.sin(now / 400) * 10;
      }
    } else {
      prevDistance = distance; s.prevY = s.y;
      for (const t of s.towers) t.prevX = t.x;
      s.vy = Math.min(s.vy + GRAVITY * 1.4, MAX_FALL * 1.4);
      s.y = Math.min(s.y + s.vy, H - GROUND - 10);
    }
    acc -= STEP_MS;
  }
  alpha = acc / STEP_MS;
  frameScale = Math.min(3, frameMs / (1000 / 60));
  draw(now);
  // both rows stay put while the course changes; they only fade when the screen really changes
  const showModes = state === "ready" && !panelOpen;
  if (modesEl.classList.contains("gone") === showModes) modesEl.classList.toggle("gone", !showModes);
  const showOpps = showModes && (mode === "race" || mode === "watch");
  const lobby = $("lobbyRow"), showLobby = showModes && mode === "online";
  if (lobby.classList.contains("gone") === showLobby) lobby.classList.toggle("gone", !showLobby);
  if (oppsEl.classList.contains("gone") === showOpps) oppsEl.classList.toggle("gone", !showOpps);
  for (const id of ["skinBtn", "appTools", "appLevels"]) {
    const el = $(id);
    if (el.classList.contains("gone") === showModes) el.classList.toggle("gone", !showModes);
  }
  requestAnimationFrame(loop);
}
reset();
(document.fonts ? document.fonts.ready : Promise.resolve()).then(() => requestAnimationFrame(t => { last = t; loop(t); }));

// Installable app: save the game's files for offline play (not when opened as a local file)
// (not inside the Android app, where the files are already on the phone)
if ("serviceWorker" in navigator && location.protocol !== "file:" && !window.Capacitor) {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
