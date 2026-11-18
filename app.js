import { DEMO } from "./config.js";
import { START_SPOTS } from "./spots-start.js";
import { searchAreas, rankSpots, searchLiveSpots, TYPE_LABEL } from "./geo.js";

const { backend } = DEMO ? await import("./backend-demo.js") : await import("./backend-supabase.js");

// ------------------------------------------------------------------ helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const initials = (n) => (n || "?").replace(/\(.*?\)/g, "").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
const TYPE_ICON = { mcd: "🍔", parking: "🅿️", industrie: "🏭" };
const NL_CENTER = [52.2, 5.3];

function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
async function run(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); }
  catch (e) { console.error(e); toast(niceError(e)); }
}
function niceError(e) {
  const c = e?.code || "";
  if (c.includes("permission-denied")) return "Geen toestemming (klopt de groepscode?)";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "E-mail of wachtwoord klopt niet";
  if (c.includes("email-already-in-use")) return "Dit e-mailadres heeft al een account. Log in.";
  if (c.includes("weak-password")) return "Wachtwoord moet minstens 6 tekens zijn";
  if (c.includes("invalid-email")) return "Ongeldig e-mailadres";
  const m = e?.message || "";
  if (c === "confirm") return m;
  if (c === "23505") return "Deze gebruikersnaam is al bezet";
  if (c === "42501" || /row-level security|permission denied/i.test(m)) return "Geen toestemming voor deze actie";
  if (/Invalid login credentials/i.test(m)) return "E-mail of wachtwoord klopt niet";
  if (/already registered/i.test(m)) return "Dit e-mailadres heeft al een account. Log in.";
  if (/Email not confirmed/i.test(m)) return "Bevestig eerst je e-mailadres via de link in je mail";
  if (/at least 6 characters/i.test(m)) return "Wachtwoord moet minstens 6 tekens zijn";
  if (/rate limit/i.test(m)) return "Te veel pogingen, probeer het over een paar minuten opnieuw";
  if (/Failed to fetch|NetworkError/i.test(m)) return "Geen verbinding met de server";
  return m || "Er ging iets mis";
}
function fmtDate(when) {
  const d = new Date(when);
  if (isNaN(d)) return when;
  return d.toLocaleString("nl-NL", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}
function fmtTime(ts) {
  const d = ts?.toDate ? ts.toDate() : new Date(ts || Date.now());
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString("nl-NL", today ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
const isPast = (m) => new Date(m.when).getTime() < Date.now() - 6 * 3600e3;
const mapsLink = (s) => `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`;
// Opent de route naar een plek in Google Maps (app op telefoon, website op computer)
function openRoute(spot) {
  const a = document.createElement("a");
  a.href = mapsLink(spot); a.target = "_blank"; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
}
const wazeLink = (s) => `https://waze.com/ul?ll=${s.lat},${s.lng}&navigate=yes`;

// ------------------------------------------------------------------ kaart
const TILE_SOURCES = [
  { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
  { url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png", attribution: '&copy; OpenStreetMap &copy; CARTO' },
  { url: "https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/standaard/EPSG:3857/{z}/{x}/{y}.png", attribution: "Kaart &copy; Kadaster" },
];
function makeMap(el, opts = {}) {
  if (!window.L) {
    el.innerHTML = `<div class="empty">De kaart kon niet laden. Controleer je internetverbinding.<br><br><button class="btn small" onclick="location.reload()">Opnieuw proberen</button></div>`;
    return null;
  }
  const map = L.map(el, { zoomControl: true, attributionControl: true }).setView(opts.center || NL_CENTER, opts.zoom || 7);
  // Valt een kaartserver uit, dan schakelt de app automatisch over naar de volgende
  let src = 0, errors = 0, tiles;
  const addTiles = () => {
    tiles?.remove();
    const t = TILE_SOURCES[src];
    tiles = L.tileLayer(t.url, { maxZoom: 18, attribution: t.attribution, subdomains: "abcd" }).addTo(map);
    tiles.on("tileerror", () => {
      if (++errors >= 4 && src < TILE_SOURCES.length - 1) { src++; errors = 0; addTiles(); }
    });
    tiles.on("tileload", () => { errors = 0; });
  };
  addTiles();
  // Kaart altijd goed laten passen als het scherm of de tab verandert
  const fix = () => map.invalidateSize();
  setTimeout(fix, 50); setTimeout(fix, 400);
  if (window.ResizeObserver) { const ro = new ResizeObserver(fix); ro.observe(el); map.on("unload", () => ro.disconnect()); }
  return map;
}
function pin(cls, text, size = 34) {
  return L.divIcon({ className: "", html: `<div class="pin ${cls}">${esc(text)}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}
function fitTo(map, latlngs, maxZoom = 11) {
  if (!map) return;
  if (latlngs.length === 1) map.setView(latlngs[0], 10);
  else if (latlngs.length > 1) map.fitBounds(L.latLngBounds(latlngs).pad(0.2), { maxZoom });
}


// ------------------------------------------------------------------ profielen
const memberOf = (uid) => st.members.find((m) => m.uid === uid);
// Altijd de actuele gebruikersnaam tonen, ook als iemand hem later wijzigt
const nameOf = (uid, fallback) => memberOf(uid)?.name || fallback || "?";
const SAFE_PHOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const photoOf = (uid) => { const p = memberOf(uid)?.photo; return p && SAFE_PHOTO.test(p) ? p : ""; };
function avatarHTML(uid, name, cls = "", photo) {
  const p = photo !== undefined ? (SAFE_PHOTO.test(photo) ? photo : "") : photoOf(uid);
  return p ? `<div class="avatar ${cls}" style="background-image:url('${p}')"></div>`
           : `<div class="avatar ${cls}">${esc(initials(name))}</div>`;
}
function personPin(uid, name) {
  const p = photoOf(uid), me = uid === st.user?.uid;
  const html = p ? `<div class="pin photo ${me ? "me" : ""}" style="background-image:url('${p}')"></div>`
                 : `<div class="pin ${me ? "me" : ""}" style="width:40px;height:40px">${esc(initials(name))}</div>`;
  return L.divIcon({ className: "", html, iconSize: [40, 40], iconAnchor: [20, 20] });
}

// ------------------------------------------------------------------ state
const st = {
  user: null, member: null, isAdmin: false,
  members: [], locations: [], meets: [], spots: [], priv: null,
  tab: "kaart", meetId: null, liveSpots: {}, chatChannel: "algemeen",
};
let globalSubs = [];
let viewCleanup = [];
let currentView = null;

function cleanupView() { viewCleanup.forEach((f) => { try { f(); } catch {} }); viewCleanup = []; currentView = null; }
const view = () => $("#view");

// ------------------------------------------------------------------ opstarten
if (DEMO) $("#demoBadge").hidden = false;

let meUnsub = null;
backend.onAuth((user) => {
  st.user = user;
  meUnsub?.(); globalSubs.forEach((f) => f()); globalSubs = [];
  if (!user) return showAuth();
  view().innerHTML = `<div class="empty">Laden…</div>`;
  meUnsub = backend.watchMe(({ member, isAdmin }) => {
    const wasApproved = st.member?.status === "approved";
    st.member = member; st.isAdmin = isAdmin;
    if (!member) return showJoin();
    if (member.status !== "approved") return showPending();
    if (!wasApproved) startApp();
  });
});

async function startApp() {
  cleanupView();
  $("#tabs").hidden = false;
  $("#tabBeheer").hidden = !st.isAdmin;
  view().innerHTML = `<div class="empty">Laden…</div>`;
  await window.leafletReady;
  st.priv = await backend.getMyPrivate().catch(() => null);
  const refresh = () => currentView?.update?.();
  globalSubs.push(
    backend.watchMembers((m) => { st.members = m; refresh(); }),
    backend.watchLocations((l) => { st.locations = l; refresh(); }),
    backend.watchMeets((m) => { st.meets = m; refresh(); }),
    backend.watchSpots((s) => { st.spots = s; refresh(); }),
  );
  go(st.priv?.area ? "kaart" : "instellingen");
  if (!st.priv?.area) toast("Stel eerst je profiel en woonwijk in 👇", 3500);
}

$$("#tabs button").forEach((b) => b.addEventListener("click", () => { st.meetId = null; go(b.dataset.tab); }));

function go(tab) {
  st.tab = tab;
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  cleanupView();
  window.scrollTo(0, 0);
  const views = { kaart: viewMap, meets: () => (st.meetId ? viewMeet(st.meetId) : viewMeets()), chat: viewChat, instellingen: viewSettings, beheer: viewAdmin };
  currentView = (views[tab] || viewMap)() || null;
}

// ------------------------------------------------------------------ inloggen
backend.onRecovery?.(() => {
  $("#tabs").hidden = true; cleanupView();
  view().innerHTML = `
  <div class="auth">
    <img src="logo.svg" class="big-logo" alt="">
    <h1>Nieuw wachtwoord</h1>
    <form id="pwForm" class="stack card">
      <div><label>Nieuw wachtwoord</label><input type="password" id="newPw" required minlength="6" autocomplete="new-password"></div>
      <button class="btn block">Opslaan</button>
    </form>
  </div>`;
  $("#pwForm").onsubmit = (e) => {
    e.preventDefault();
    run(async () => { await backend.setNewPassword($("#newPw").value); location.hash = ""; location.reload(); }, "Wachtwoord gewijzigd");
  };
});

function showAuth() {
  $("#tabs").hidden = true; cleanupView();
  let mode = "login";
  view().innerHTML = `
  <div class="auth">
    <img src="logo.svg" class="big-logo" alt="">
    <h1>Punto Community Nederland</h1>
    <p class="muted">Besloten app voor leden van de groepsapp.</p>
    <div class="seg"><button data-m="login" class="active">Inloggen</button><button data-m="signup">Account maken</button></div>
    <form id="authForm" class="stack card">
      <div><label>E-mailadres</label><input type="email" id="email" required autocomplete="email"></div>
      <div><label>Wachtwoord</label><input type="password" id="pw" required minlength="6" autocomplete="current-password"></div>
      <button class="btn block" id="authBtn">Inloggen</button>
      <button type="button" class="btn ghost small" id="forgot">Wachtwoord vergeten?</button>
    </form>
  </div>`;
  $$(".seg button").forEach((b) => b.onclick = () => {
    mode = b.dataset.m;
    $$(".seg button").forEach((x) => x.classList.toggle("active", x === b));
    $("#authBtn").textContent = mode === "login" ? "Inloggen" : "Account maken";
  });
  $("#authForm").onsubmit = (e) => {
    e.preventDefault();
    const email = $("#email").value.trim(), pw = $("#pw").value;
    run(() => (mode === "login" ? backend.signIn(email, pw) : backend.signUp(email, pw)));
  };
  $("#forgot").onclick = () => {
    const email = $("#email").value.trim();
    if (!email) return toast("Vul eerst je e-mailadres in");
    run(() => backend.resetPassword(email), "Herstelmail verstuurd");
  };
}

function showJoin() {
  $("#tabs").hidden = true; cleanupView();
  view().innerHTML = `
  <div class="auth">
    <img src="logo.svg" class="big-logo" alt="">
    <h1>Lid worden</h1>
    <p class="muted">Vul de groepscode in die in de WhatsApp-groep is gedeeld. Daarna keurt de beheerder je aanvraag goed.</p>
    <form id="joinForm" class="stack card">
      <div><label>Gebruikersnaam (zodat de groep je herkent)</label><input type="text" id="name" required maxlength="20" pattern="[A-Za-z0-9_\-]{3,20}" title="3–20 tekens: letters, cijfers, _ of -" autocomplete="off"></div>
      <div><label>Groepscode</label><input type="text" id="code" ${st.isAdmin ? "" : "required"} autocomplete="off" placeholder="${st.isAdmin ? "Niet nodig voor beheerder" : ""}"></div>
      <button class="btn block">Aanvraag versturen</button>
      <button type="button" class="btn ghost small" id="logout">Uitloggen</button>
    </form>
  </div>`;
  $("#joinForm").onsubmit = (e) => {
    e.preventDefault();
    run(() => backend.joinGroup($("#name").value, $("#code").value, st.isAdmin));
  };
  $("#logout").onclick = () => backend.signOut();
}

function showPending() {
  $("#tabs").hidden = true; cleanupView();
  view().innerHTML = `
  <div class="auth">
    <img src="logo.svg" class="big-logo" alt="">
    <h1>Bijna binnen!</h1>
    <div class="card"><p>Je aanvraag is verstuurd, <b>${esc(st.member?.name)}</b>. Zodra de beheerder je goedkeurt, opent de app vanzelf.</p></div>
    <button class="btn secondary" id="logout">Uitloggen</button>
  </div>`;
  $("#logout").onclick = () => backend.signOut();
}

// ------------------------------------------------------------------ KAART
function viewMap() {
  view().innerHTML = `
    <h1>Waar wonen we?</h1>
    <div id="noArea"></div>
    <div class="stats">
      <div class="stat"><b id="sVis">0</b><span>op de kaart</span></div>
      <div class="stat"><b id="sHid">0</b><span>onzichtbaar</span></div>
      <div class="stat"><b id="sTot">0</b><span>leden</span></div>
    </div>
    <div id="map" class="map"></div>
    <div class="legend"><span><i style="background:var(--green)"></i>Jij</span><span><i style="background:var(--red)"></i>Leden (op wijkniveau)</span><span>🏁 Meetplek: tik voor route</span></div>
    <p class="small muted">Iedereen staat op het midden van zijn of haar woonwijk, nooit op een adres.</p>`;
  const map = makeMap($("#map"));
  const layer = map ? L.layerGroup().addTo(map) : null;
  let fitted = false;
  function update() {
    const approved = st.members.filter((m) => m.status === "approved");
    $("#sVis").textContent = st.locations.length;
    $("#sTot").textContent = approved.length;
    $("#sHid").textContent = Math.max(0, approved.length - st.locations.length);
    $("#noArea").innerHTML = st.priv?.area ? "" :
      `<div class="card row"><span>📍 Je woonwijk is nog niet ingesteld.</span><span class="spacer"></span><button class="btn small" id="setArea">Instellen</button></div>`;
    $("#setArea")?.addEventListener("click", () => go("instellingen"));
    if (!layer) return;
    layer.clearLayers();
    // Leden in dezelfde wijk iets uit elkaar zetten zodat ze niet overlappen
    const seen = {};
    const pts = [];
    for (const l of st.locations) {
      const k = l.lat + "," + l.lng; const n = (seen[k] = (seen[k] || 0) + 1) - 1;
      const ang = n * 2.4, off = n ? 0.004 * Math.sqrt(n) : 0;
      const ll = [l.lat + off * Math.sin(ang), l.lng + off * Math.cos(ang) * 1.6];
      pts.push(ll);
      const nm = nameOf(l.uid, l.name);
      L.marker(ll, { icon: personPin(l.uid, nm) })
        .bindPopup(`<div class="row">${avatarHTML(l.uid, nm)}<div><b>${esc(nm)}</b><br>${esc(l.areaName)}</div></div>`).addTo(layer);
    }
    // Komende meets met een gekozen plek: tik op 🏁 voor de route
    st.meets.filter((m) => m.spot && !isPast(m)).forEach((m) => {
      L.marker([m.spot.lat, m.spot.lng], { icon: pin("chosen", "🏁", 40), zIndexOffset: 1000, title: m.title })
        .on("click", () => openRoute(m.spot)).addTo(layer);
    });
    if (!fitted && pts.length) { fitTo(map, pts, 9); fitted = true; }
  }
  update();
  viewCleanup.push(() => map?.remove());
  return { update };
}

// ------------------------------------------------------------------ MEETS
function viewMeets() {
  view().innerHTML = `
    <div class="row"><h1>Car meets</h1><span class="spacer"></span><button class="btn small" id="newBtn">+ Nieuwe meet</button></div>
    <form id="newForm" class="card stack" hidden>
      <div><label>Naam van de meet</label><input type="text" id="mTitle" required maxlength="60" placeholder="Bijv. Lente meet"></div>
      <div><label>Datum en tijd</label><input type="datetime-local" id="mWhen" required></div>
      <div><label>Extra info (optioneel)</label><textarea id="mNote" maxlength="500"></textarea></div>
      <p class="small muted">De locatie wordt automatisch voorgesteld op basis van wie er komt.</p>
      <div class="row"><button class="btn">Aanmaken</button><button type="button" class="btn secondary" id="cancelNew">Annuleren</button></div>
    </form>
    <div id="upcoming"></div>
    <h3>Afgelopen</h3>
    <div id="past"></div>`;
  $("#newBtn").onclick = () => { $("#newForm").hidden = false; $("#mTitle").focus(); };
  $("#cancelNew").onclick = () => ($("#newForm").hidden = true);
  $("#newForm").onsubmit = (e) => {
    e.preventDefault();
    run(async () => {
      await backend.createMeet({ title: $("#mTitle").value.trim(), when: $("#mWhen").value, note: $("#mNote").value.trim(), createdByName: st.member.name });
      $("#newForm").reset(); $("#newForm").hidden = true;
    }, "Meet aangemaakt 🏁");
  };
  function card(m) {
    return `<div class="card click" data-id="${esc(m.id)}">
      <div class="row"><b>${esc(m.title)}</b><span class="spacer"></span>${m.spot ? `<span class="chip green">Locatie gekozen</span>` : `<span class="chip yellow">Locatie open</span>`}</div>
      <div class="small muted" style="margin-top:4px">📅 ${esc(fmtDate(m.when))}</div>
      ${m.spot ? `<div class="row small" style="margin-top:6px">${TYPE_ICON[m.spot.type] || "📍"} ${esc(m.spot.name)}<span class="spacer"></span><button class="btn small green" data-route="${esc(m.id)}">🧭 Route</button></div>` : ""}
    </div>`;
  }
  function update() {
    const up = st.meets.filter((m) => !isPast(m));
    const past = st.meets.filter(isPast).reverse();
    $("#upcoming").innerHTML = up.length ? up.map(card).join("") : `<div class="empty">Nog geen meets gepland. Maak er een aan!</div>`;
    $("#past").innerHTML = past.length ? past.map(card).join("") : `<p class="small muted">Nog geen.</p>`;
    $$(".card.click").forEach((c) => c.onclick = () => { st.meetId = c.dataset.id; go("meets"); });
    $$("[data-route]").forEach((b) => b.onclick = (e) => { e.stopPropagation(); const m = st.meets.find((x) => x.id === b.dataset.route); if (m?.spot) openRoute(m.spot); });
  }
  update();
  return { update };
}

function viewMeet(meetId) {
  let attendees = [], overview = null;
  const meet = () => st.meets.find((m) => m.id === meetId);
  if (!meet()) { st.meetId = null; return viewMeets(); }
  view().innerHTML = `
    <button class="back" id="back">← Alle meets</button>
    <div id="head"></div>
    <div class="row" style="margin:12px 0">
      <button class="btn green" id="yes" style="flex:1">✅ Ik kom</button>
      <button class="btn secondary" id="no" style="flex:1">❌ Ik kom niet</button>
    </div>
    <div id="warn"></div>
    <div class="stats">
      <div class="stat"><b id="cGo">0</b><span>komen</span></div>
      <div class="stat"><b id="cNo">0</b><span>komen niet</span></div>
      <div class="stat"><b id="cCalc">0</b><span>in berekening</span></div>
    </div>
    <div id="chosen"></div>
    <div id="map" class="map short"></div>
    <div class="legend">
      <span><i style="background:var(--red)"></i>Deelnemer</span>
      <span><i style="background:#f5b400"></i>Midden</span>
      <span><i style="background:#1d4ed8"></i>Voorstel</span>
      <span><i style="background:var(--green)"></i>Gekozen plek</span>
    </div>
    <h2>Voorgestelde meetplekken</h2>
    <p class="small muted">Op basis van het midden van iedereen die komt. Wie niet komt, telt niet mee. Onzichtbare leden tellen wel mee, maar hun wijk wordt niet getoond.</p>
    <div id="suggest"></div>
    <button class="btn secondary block" id="live">🔎 Zoek live McDonald's, parkeerplaatsen & industrieterreinen</button>
    <h2>Wie komen er?</h2>
    <div class="card" id="who"></div>
    <button class="btn secondary block" id="toChat" style="margin-top:14px">💬 Open de chat van deze meet</button>
    <div id="danger" style="margin-top:20px"></div>`;
  $("#back").onclick = () => { st.meetId = null; go("meets"); };
  const map = makeMap($("#map"));
  const layer = map ? L.layerGroup().addTo(map) : null;
  let fitted = false;
  const canManage = () => st.isAdmin || meet()?.createdBy === st.user.uid;

  $("#yes").onclick = () => run(() => backend.setAttendance(meetId, true, st.member.name), "Top, je staat erbij! 🚗");
  $("#no").onclick = () => run(() => backend.setAttendance(meetId, false, st.member.name), "Jammer! Volgende keer?");
  $("#live").onclick = async () => {
    const c = overview?.center;
    if (!c) return toast("Nog niemand met een wijk heeft zich aangemeld");
    const btn = $("#live"); btn.disabled = true; btn.textContent = "Zoeken…";
    try {
      let found = await searchLiveSpots(c, 10);
      if (found.length < 3) found = await searchLiveSpots(c, 25);
      st.liveSpots[meetId] = found;
      toast(found.length ? `${found.length} plekken gevonden` : "Niets gevonden in de buurt");
      update();
    } catch (e) { toast("Live zoeken lukte niet, probeer het later nog eens"); }
    btn.disabled = false; btn.textContent = "🔎 Zoek opnieuw live in de buurt";
  };

  async function refreshOverview() {
    try { overview = await backend.meetOverview(meetId); } catch (e) { console.error(e); }
    update();
  }
  const locOf = (uid) => st.locations.find((l) => l.uid === uid);

  function update() {
    const m = meet();
    if (!m) { st.meetId = null; go("meets"); return; }
    $("#head").innerHTML = `
      <h1>${esc(m.title)}</h1>
      <div class="muted">📅 ${esc(fmtDate(m.when))}</div>
      <div class="small muted">Georganiseerd door ${esc(m.createdByName || "?")}</div>
      ${m.note ? `<p>${esc(m.note)}</p>` : ""}`;
    const mine = attendees.find((a) => a.uid === st.user.uid);
    $("#yes").classList.toggle("on", mine?.going === true);
    $("#no").classList.toggle("on", mine?.going === false);
    $("#warn").innerHTML = !st.priv?.area
      ? `<div class="card small">⚠️ Je hebt nog geen woonwijk ingesteld, dus je telt niet mee voor de locatie. <a href="#" id="toMe">Stel in</a></div>` : "";
    $("#toMe")?.addEventListener("click", (e) => { e.preventDefault(); go("instellingen"); });

    const going = attendees.filter((a) => a.going), notGoing = attendees.filter((a) => a.going === false);
    $("#cGo").textContent = going.length;
    $("#cNo").textContent = notGoing.length;
    $("#cCalc").textContent = overview ? overview.nPoints : "…";

    // Gekozen plek
    $("#chosen").innerHTML = m.spot ? `
      <div class="card chosen-box" id="chosenCard">
        <div class="small muted">GEKOZEN MEETPLEK</div>
        <div style="font-size:18px;margin:4px 0"><b>${TYPE_ICON[m.spot.type] || "📍"} ${esc(m.spot.name)}</b></div>
        <div class="tap-hint" style="margin:0 0 8px">👆 Tik hier of op 🏁 op de kaart voor de route</div>
        <div class="row wrap">
          <a class="btn small green" href="${mapsLink(m.spot)}" target="_blank" rel="noopener">Route (Google Maps)</a>
          <a class="btn small secondary" href="${wazeLink(m.spot)}" target="_blank" rel="noopener">Waze</a>
          ${canManage() ? `<button class="btn small ghost" id="clearSpot">Andere plek kiezen</button>` : ""}
        </div>
      </div>` : "";
    $("#clearSpot")?.addEventListener("click", (e) => { e.stopPropagation(); run(() => backend.setMeetSpot(meetId, null)); });
    $("#chosenCard")?.addEventListener("click", (e) => { if (!e.target.closest("a,button")) openRoute(m.spot); });

    // Voorstellen
    const center = overview?.center || null;
    let ranked = [];
    if (center) {
      const all = [...st.spots, ...(st.liveSpots[meetId] || [])];
      ranked = rankSpots(all, center).slice(0, 3);
    }
    $("#suggest").innerHTML = !center
      ? `<div class="empty">Zodra er mensen met een woonwijk ‘Ik kom’ hebben gekozen, verschijnt hier een voorstel.</div>`
      : ranked.length === 0
        ? `<div class="empty">Er staan nog geen meetplekken in de lijst. Gebruik de knop hieronder om live te zoeken.</div>`
        : ranked.map((s, i) => `
          <div class="card suggest ${i === 0 ? "best" : ""}">
            <div class="row"><b>${i === 0 ? "⭐ " : ""}${TYPE_ICON[s.type] || "📍"} ${esc(s.name)}</b></div>
            <div class="small muted" style="margin:4px 0">${TYPE_LABEL[s.type] || ""} · ${s.toCenter.toFixed(1)} km van het midden (hemelsbreed)
              ${s.approx ? ` · <span class="chip yellow">locatie bij benadering</span>` : ""}${s.live ? ` · <span class="chip">OpenStreetMap</span>` : ""}</div>
            <div class="row wrap">
              ${canManage() ? `<button class="btn small" data-choose="${i}">Kies deze plek</button>` : ""}
              <button class="btn small secondary" data-show="${i}">Op kaart</button>
              <a class="btn small ghost" href="${mapsLink(s)}" target="_blank" rel="noopener">Bekijk ↗</a>
              ${s.live && st.isAdmin ? `<button class="btn small ghost" data-save="${i}">+ Bewaar in lijst</button>` : ""}
            </div>
          </div>`).join("");
    $$("[data-choose]").forEach((b) => b.onclick = () => {
      const s = ranked[+b.dataset.choose];
      run(() => backend.setMeetSpot(meetId, { name: s.name, type: s.type, lat: s.lat, lng: s.lng }), "Meetplek gekozen ✅");
    });
    $$("[data-show]").forEach((b) => b.onclick = () => { const s = ranked[+b.dataset.show]; map?.setView([s.lat, s.lng], 13); $("#map").scrollIntoView({ behavior: "smooth", block: "center" }); });
    $$("[data-save]").forEach((b) => b.onclick = () => {
      const s = ranked[+b.dataset.save];
      run(() => backend.addSpot({ name: s.name, type: s.type, lat: s.lat, lng: s.lng, approx: false }), "Opgeslagen in de lijst");
    });

    // Wie
    const hiddenGoing = overview?.nHidden || 0;
    const noArea = overview?.nNoArea || 0;
    const areaLabel = (a) => { const l = locOf(a.uid); return l ? esc(l.areaName) : (a.uid === st.user.uid && !st.priv?.area ? "geen wijk ingesteld" : "🙈 wijk niet zichtbaar"); };
    $("#who").innerHTML = `
      ${going.length ? going.map((a) => `<div class="list-item">${avatarHTML(a.uid, nameOf(a.uid, a.name))}<div><b>${esc(nameOf(a.uid, a.name))}</b><div class="small muted">${areaLabel(a)}</div></div><span class="spacer"></span><span class="chip green">komt</span></div>`).join("") : `<p class="muted">Nog niemand aangemeld.</p>`}
      ${notGoing.map((a) => `<div class="list-item">${avatarHTML(a.uid, nameOf(a.uid, a.name))}<b>${esc(nameOf(a.uid, a.name))}</b><span class="spacer"></span><span class="chip red">komt niet</span></div>`).join("")}
      ${hiddenGoing ? `<p class="small muted">${hiddenGoing} onzichtbare deelnemer(s) tellen mee zonder dat hun wijk wordt getoond.</p>` : ""}
      ${noArea ? `<p class="small muted">${noArea} deelnemer(s) hebben nog geen woonwijk ingesteld en tellen nog niet mee.</p>` : ""}`;

    $("#danger").innerHTML = canManage() ? `<button class="btn ghost small" id="delMeet">🗑 Meet verwijderen</button>` : "";
    $("#delMeet")?.addEventListener("click", () => {
      if (!confirm("Weet je zeker dat je deze meet wilt verwijderen?")) return;
      run(async () => { await backend.deleteMeet(meetId); st.meetId = null; go("meets"); }, "Meet verwijderd");
    });

    // Kaart
    if (!layer) return;
    layer.clearLayers();
    const ll = [];
    going.forEach((a) => {
      const l = locOf(a.uid); if (!l) return;      // alleen zichtbare leden op de kaart
      ll.push([l.lat, l.lng]);
      const nm = nameOf(a.uid, a.name);
      L.marker([l.lat, l.lng], { icon: personPin(a.uid, nm) }).bindPopup(`<b>${esc(nm)}</b><br>${esc(l.areaName)}`).addTo(layer);
    });
    if (center) {
      L.marker([center.lat, center.lng], { icon: pin("center", "✦") }).bindPopup("Midden van alle deelnemers").addTo(layer);
      ll.push([center.lat, center.lng]);
    }
    ranked.forEach((s, i) => {
      L.marker([s.lat, s.lng], { icon: pin("spot", TYPE_ICON[s.type] || String(i + 1)) })
        .bindPopup(`<b>${esc(s.name)}</b><br>Voorstel ${i + 1}<br><a href="${mapsLink(s)}" target="_blank" rel="noopener">🧭 Route in Google Maps</a>`).addTo(layer);
    });
    if (m.spot) {
      L.marker([m.spot.lat, m.spot.lng], { icon: pin("chosen", "🏁", 40), zIndexOffset: 1000, title: "Route naar " + m.spot.name })
        .on("click", () => openRoute(m.spot)).addTo(layer);
      ll.push([m.spot.lat, m.spot.lng]);
    }
    if (!fitted && ll.length) { fitTo(map, ll, 11); fitted = true; }
  }

  viewCleanup.push(
    backend.watchAttendees(meetId, (a) => { attendees = a; refreshOverview(); }),
    () => map?.remove(),
  );
  $("#toChat").onclick = () => { st.chatChannel = meetId; st.meetId = null; go("chat"); };
  update();
  return { update };
}

// ------------------------------------------------------------------ CHAT
function mountChat(el, channel, short = false) {
  el.innerHTML = `
    <div class="chat">
      <div class="chat-box ${short ? "short" : ""}"><div class="empty">Laden…</div></div>
      <form class="chat-input"><input type="text" maxlength="500" placeholder="Typ een bericht…" autocomplete="off"><button class="btn">Stuur</button></form>
    </div>`;
  const box = $(".chat-box", el);
  const form = $("form", el), input = $("input", el);
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    run(() => backend.sendMessage(channel, text, st.member.name));
  };
  const unsub = backend.watchMessages(channel, (msgs) => {
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.innerHTML = msgs.length ? msgs.map((m) => {
      const mine = m.uid === st.user.uid;
      const nm = nameOf(m.uid, m.name);
      return `<div class="msg-row ${mine ? "mine" : ""}">${mine ? "" : avatarHTML(m.uid, nm, "sm")}<div class="msg ${mine ? "mine" : ""}">
        <div class="meta"><b>${esc(mine ? "Jij" : nm)}</b><span>${esc(fmtTime(m.ts))}</span>
          ${mine || st.isAdmin ? `<button class="del" data-del="${esc(m.id)}" title="Verwijderen">✕</button>` : ""}</div>
        <div>${esc(m.text)}</div></div></div>`;
    }).join("") : `<div class="empty">Nog geen berichten. Zeg hoi! 👋</div>`;
    $$("[data-del]", box).forEach((b) => b.onclick = () => run(() => backend.deleteMessage(b.dataset.del)));
    if (atBottom || !box.dataset.init) { box.scrollTop = box.scrollHeight; box.dataset.init = "1"; }
  });
  return unsub;
}

function viewChat() {
  const upcoming = () => st.meets.filter((m) => !isPast(m));
  if (st.chatChannel !== "algemeen" && !st.meets.some((m) => m.id === st.chatChannel)) st.chatChannel = "algemeen";
  view().innerHTML = `<h1>Chat</h1><div class="channels" id="channels"></div><div id="chatWrap"></div>`;
  let unsub = null, shown = null;
  function open(ch) {
    if (shown === ch) return;
    shown = ch; st.chatChannel = ch;
    unsub?.();
    unsub = mountChat($("#chatWrap"), ch);
    paintChannels();
  }
  function paintChannels() {
    const list = [{ id: "algemeen", label: "👥 Algemeen" }, ...upcoming().map((m) => ({ id: m.id, label: "🏁 " + m.title }))];
    if (!list.some((c) => c.id === st.chatChannel)) {
      const m = st.meets.find((x) => x.id === st.chatChannel);
      if (m) list.push({ id: m.id, label: "🏁 " + m.title });
    }
    $("#channels").innerHTML = list.map((c) => `<button class="${c.id === st.chatChannel ? "active" : ""}" data-ch="${esc(c.id)}">${esc(c.label)}</button>`).join("");
    $$("#channels button").forEach((b) => b.onclick = () => open(b.dataset.ch));
  }
  open(st.chatChannel);
  viewCleanup.push(() => unsub?.());
  return { update: paintChannels };
}

// ------------------------------------------------------------------ INSTELLINGEN
// Foto verkleinen tot een klein vierkant (±10 KB) zodat hij gratis in de database past
function resizePhoto(file, size = 128) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = c.height = size;
      const ctx = c.getContext("2d");
      const side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => reject(new Error("Dit bestand kan niet als foto worden gelezen"));
    img.src = URL.createObjectURL(file);
  });
}

function viewSettings() {
  let picked = st.priv?.area || null;
  let photo = st.member.photo || "";
  view().innerHTML = `
    <h1>Instellingen</h1>

    <h2>Profiel</h2>
    <div class="card stack">
      <div class="row">
        <div id="pfPreview"></div>
        <div class="stack" style="flex:1">
          <label class="btn secondary small" style="text-align:center;margin:0;color:#fff">📷 Foto kiezen<input type="file" id="pfFile" accept="image/*" hidden></label>
          <button class="btn ghost small" id="pfRemove">Foto verwijderen</button>
        </div>
      </div>
      <div><label>Gebruikersnaam</label><input type="text" id="uname" maxlength="20" autocomplete="off"></div>
      <p class="small muted" style="margin:0">3–20 tekens: letters, cijfers, _ en -. Deze naam zien anderen in de chat, bij meets en op de kaart.</p>
      <button class="btn block" id="saveProfile">Profiel opslaan</button>
    </div>

    <h2>Woonwijk & zichtbaarheid</h2>
    <div class="card stack">
      <p class="small muted" style="margin:0">Zoek je <b>wijk of buurt</b> (bijv. “Kanaleneiland” of “Zuid Amersfoort”). Straten en adressen kun je niet invullen: je komt op het midden van je wijk te staan.</p>
      <div id="current"></div>
      <div><input type="text" id="q" placeholder="Zoek je wijk of buurt…" autocomplete="off"><div id="res"></div></div>
      <label class="switch"><input type="checkbox" id="vis"> <span>Zichtbaar voor de rest op de kaart</span></label>
      <p class="small muted" style="margin:0" id="visHelp"></p>
      <button class="btn block" id="save">Wijk & zichtbaarheid opslaan</button>
    </div>

    <h2>Account</h2>
    <div class="card row wrap">
      <span class="small muted">${esc(st.user.email || "")}</span><span class="spacer"></span>
      <button class="btn secondary small" id="logout">Uitloggen</button>
      ${backend.demo ? `<button class="btn ghost small" id="reset">Demo resetten</button>` : ""}
    </div>`;

  $("#uname").value = st.member.name || "";
  const vis = $("#vis");
  vis.checked = st.priv ? !!st.priv.visible : true;
  function paintPhoto() { $("#pfPreview").innerHTML = avatarHTML(st.user.uid, $("#uname").value || st.member.name, "xl", photo); $("#pfRemove").hidden = !photo; }
  function paint() {
    $("#current").innerHTML = picked ? `<div class="chip green">📍 ${esc(picked.name)}</div>` : `<div class="chip yellow">Nog geen wijk gekozen</div>`;
    $("#visHelp").textContent = vis.checked
      ? "Andere leden zien je profielfoto op de kaart, in het midden van je wijk."
      : "Je bent onzichtbaar op de kaart. Kom je naar een meet, dan telt je wijk wél mee voor de locatie, maar niemand ziet waar je woont.";
  }
  $("#uname").oninput = paintPhoto;
  $("#pfFile").onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try { photo = await resizePhoto(f); paintPhoto(); toast("Foto klaar, klik op ‘Profiel opslaan’"); }
    catch (err) { toast(err.message); }
    e.target.value = "";
  };
  $("#pfRemove").onclick = () => { photo = ""; paintPhoto(); };
  $("#saveProfile").onclick = () => {
    const name = $("#uname").value.trim();
    if (!/^[A-Za-z0-9_\-]{3,20}$/.test(name)) return toast("Gebruik 3–20 tekens: letters, cijfers, _ of -");
    const taken = st.members.some((m) => m.uid !== st.user.uid && (m.name || "").toLowerCase() === name.toLowerCase());
    if (taken) return toast("Deze gebruikersnaam is al bezet");
    run(() => backend.updateProfile({ name, photo }), "Profiel opgeslagen ✅");
  };

  vis.onchange = paint;
  let t;
  $("#q").oninput = (e) => {
    clearTimeout(t);
    const q = e.target.value.trim();
    if (q.length < 3) { $("#res").innerHTML = ""; return; }
    t = setTimeout(async () => {
      $("#res").innerHTML = `<p class="small muted">Zoeken…</p>`;
      try {
        const r = await searchAreas(q);
        $("#res").innerHTML = r.length ? `<div class="results">${r.map((a, i) => `<button data-i="${i}">${esc(a.name)} <span class="chip">${a.type}</span></button>`).join("")}</div>`
          : `<p class="small muted">Niets gevonden. Probeer de naam van je wijk of je woonplaats.</p>`;
        $$("#res button").forEach((b) => b.onclick = () => {
          const a = r[+b.dataset.i];
          picked = { id: a.id, name: a.name, lat: a.lat, lng: a.lng };
          $("#res").innerHTML = ""; $("#q").value = ""; paint();
        });
      } catch { $("#res").innerHTML = `<p class="small muted">Zoeken lukte niet. Controleer je internet.</p>`; }
    }, 350);
  };
  $("#save").onclick = () => {
    if (!picked) return toast("Kies eerst je wijk");
    run(async () => {
      await backend.saveMyArea({ area: picked, visible: vis.checked, name: st.member.name });
      st.priv = { area: picked, visible: vis.checked };
    }, "Opgeslagen ✅");
  };
  $("#logout").onclick = () => backend.signOut();
  $("#reset")?.addEventListener("click", () => { backend.resetDemo(); location.reload(); });
  paintPhoto(); paint();
  return { update: () => {} };
}

// ------------------------------------------------------------------ BEHEER
function viewAdmin() {
  if (!st.isAdmin) return viewMap();
  view().innerHTML = `
    <h1>Beheer</h1>
    <h2>Groepscode</h2>
    <div class="card stack">
      <p class="small muted" style="margin:0">Deel deze code alleen in de WhatsApp-groep. Nieuwe leden hebben hem nodig én jij moet ze daarna nog goedkeuren. Verander de code als hij uitlekt.</p>
      <div class="row"><input type="text" id="code" autocomplete="off"><button class="btn" id="saveCode">Opslaan</button></div>
    </div>
    <h2>Aanvragen</h2>
    <div class="card" id="pending"></div>
    <h2>Leden</h2>
    <div class="card" id="members"></div>
    <h2>Meetplekken</h2>
    <div class="card stack">
      <p class="small muted" style="margin:0">Tik op de kaart om een plek toe te voegen. Bij <span class="chip yellow">bij benadering</span>: klik op “Toon”, sleep de speld naar de juiste plek en klik op “Klopt”.</p>
      <div id="spotMap" class="map short"></div>
      <div class="row wrap">
        <input type="text" id="spName" placeholder="Naam, bijv. McDonald's Gouda" style="flex:2;min-width:180px">
        <select id="spType" style="flex:1;min-width:140px"><option value="mcd">McDonald's</option><option value="parking">Parkeerplaats</option><option value="industrie">Industrieterrein</option></select>
      </div>
      <button class="btn" id="addSpot" disabled>Plek toevoegen (tik eerst op de kaart)</button>
      <button class="btn secondary" id="loadStart">Startlijst laden (${START_SPOTS.length} plekken)</button>
    </div>
    <div class="card" id="spots"></div>`;

  backend.getInviteCode().then((c) => ($("#code").value = c)).catch(() => {});
  $("#saveCode").onclick = () => {
    const c = $("#code").value.trim();
    if (c.length < 4) return toast("Gebruik minstens 4 tekens");
    run(() => backend.setInviteCode(c), "Groepscode opgeslagen");
  };

  const map = makeMap($("#spotMap"));
  const layer = map ? L.layerGroup().addTo(map) : null;
  let newPos = null, newMarker = null, editMarker = null;
  map?.on("click", (e) => {
    newPos = { lat: +e.latlng.lat.toFixed(5), lng: +e.latlng.lng.toFixed(5) };
    if (newMarker) newMarker.setLatLng(e.latlng);
    else newMarker = L.marker(e.latlng, { icon: pin("chosen", "+", 40), draggable: true }).addTo(map)
      .on("dragend", (ev) => { const p = ev.target.getLatLng(); newPos = { lat: +p.lat.toFixed(5), lng: +p.lng.toFixed(5) }; });
    $("#addSpot").disabled = false; $("#addSpot").textContent = "Plek toevoegen";
  });
  $("#addSpot").onclick = () => {
    const name = $("#spName").value.trim();
    if (!newPos) return toast("Tik eerst op de kaart");
    if (!name) return toast("Geef de plek een naam");
    run(async () => {
      await backend.addSpot({ name, type: $("#spType").value, lat: newPos.lat, lng: newPos.lng, approx: false });
      $("#spName").value = ""; newMarker?.remove(); newMarker = null; newPos = null;
      $("#addSpot").disabled = true; $("#addSpot").textContent = "Plek toevoegen (tik eerst op de kaart)";
    }, "Plek toegevoegd");
  };
  $("#loadStart").onclick = () => {
    const have = new Set(st.spots.map((s) => s.name));
    const todo = START_SPOTS.filter((s) => !have.has(s.name));
    if (!todo.length) return toast("Startlijst staat er al in");
    if (!confirm(`${todo.length} plekken toevoegen? De locaties zijn bij benadering, controleer ze daarna.`)) return;
    run(() => backend.addSpotsBulk(todo), "Startlijst geladen");
  };

  function update() {
    const pending = st.members.filter((m) => m.status === "pending");
    $("#pending").innerHTML = pending.length ? pending.map((m) => `
      <div class="list-item">${avatarHTML(m.uid, m.name)}<b>${esc(m.name)}</b><span class="spacer"></span>
        <button class="btn small green" data-ok="${esc(m.uid)}">Toelaten</button>
        <button class="btn small secondary" data-rm="${esc(m.uid)}">Weigeren</button></div>`).join("")
      : `<p class="muted" style="margin:0">Geen openstaande aanvragen.</p>`;
    const approved = st.members.filter((m) => m.status === "approved");
    $("#members").innerHTML = approved.map((m) => `
      <div class="list-item">${avatarHTML(m.uid, m.name)}<b>${esc(m.name)}</b><span class="spacer"></span>
        ${m.uid === st.user.uid ? `<span class="chip">jij</span>` : `<button class="btn small ghost" data-rm="${esc(m.uid)}">Verwijderen</button>`}</div>`).join("");
    $$("[data-ok]").forEach((b) => b.onclick = () => run(() => backend.approveMember(b.dataset.ok), "Lid toegelaten"));
    $$("[data-rm]").forEach((b) => b.onclick = () => {
      if (!confirm("Weet je het zeker? Deze persoon kan dan niet meer in de app.")) return;
      run(() => backend.removeMember(b.dataset.rm), "Verwijderd");
    });

    const spots = [...st.spots].sort((a, b) => (b.approx ? 1 : 0) - (a.approx ? 1 : 0) || a.name.localeCompare(b.name));
    $("#spots").innerHTML = spots.length ? spots.map((s) => `
      <div class="list-item"><span style="font-size:20px">${TYPE_ICON[s.type] || "📍"}</span>
        <div><b>${esc(s.name)}</b>${s.approx ? ` <span class="chip yellow">bij benadering</span>` : ""}</div><span class="spacer"></span>
        <button class="btn small secondary" data-show="${esc(s.id)}">Toon</button>
        ${s.approx ? `<button class="btn small green" data-okspot="${esc(s.id)}">Klopt</button>` : ""}
        <button class="btn small ghost" data-delspot="${esc(s.id)}">🗑</button></div>`).join("")
      : `<p class="muted" style="margin:0">Nog geen meetplekken. Laad de startlijst of tik op de kaart.</p>`;
    $$("[data-show]").forEach((b) => b.onclick = () => {
      const s = st.spots.find((x) => x.id === b.dataset.show);
      if (!s || !map) return;
      editMarker?.remove();
      editMarker = L.marker([s.lat, s.lng], { icon: pin("chosen", TYPE_ICON[s.type] || "📍", 40), draggable: true, zIndexOffset: 1000 })
        .bindPopup(`<b>${esc(s.name)}</b><br>Sleep me naar de juiste plek`).addTo(map).openPopup()
        .on("dragend", (ev) => { const p = ev.target.getLatLng(); run(() => backend.updateSpot(s.id, { lat: +p.lat.toFixed(5), lng: +p.lng.toFixed(5), approx: false }), "Locatie bijgewerkt"); });
      map.setView([s.lat, s.lng], 14);
      $("#spotMap").scrollIntoView({ behavior: "smooth", block: "center" });
    });
    $$("[data-okspot]").forEach((b) => b.onclick = () => run(() => backend.updateSpot(b.dataset.okspot, { approx: false }), "Gemarkeerd als gecontroleerd"));
    $$("[data-delspot]").forEach((b) => b.onclick = () => run(() => backend.deleteSpot(b.dataset.delspot), "Plek verwijderd"));

    if (layer) {
      layer.clearLayers();
      st.spots.forEach((s) => L.marker([s.lat, s.lng], { icon: pin("spot", TYPE_ICON[s.type] || "📍", 28) }).bindPopup(esc(s.name)).addTo(layer));
    }
  }
  update();
  viewCleanup.push(() => map?.remove());
  return { update };
}
