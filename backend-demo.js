// Demomodus: alles draait in je browser met nepdata. Niets wordt gedeeld.
import { START_SPOTS } from "./spots-start.js";

const KEY = "pcn-demo-v3";
const ME = "me";
let idc = 1000;
const nid = () => "d" + (idc++);

function seed() {
  const people = [
    ["Sanne", "Wijk Kanaleneiland, Utrecht", 52.0700, 5.0950, true],
    ["Mehmet", "Wijk Feijenoord, Rotterdam", 51.9010, 4.5000, true],
    ["Jesse", "Wijk Strijp, Eindhoven", 51.4470, 5.4500, true],
    ["Lotte", "Wijk Zuid, Amersfoort", 52.1450, 5.3850, true],
    ["Kevin", "Wijk Holtenbroek, Zwolle", 52.5250, 6.0900, false],
    ["Daan", "Wijk Schalkwijk, Haarlem", 52.3600, 4.6600, true],
    ["Fleur", "Wijk Brabantpark, Breda", 51.5850, 4.7950, true],
    ["Rik", "Wijk Malburgen, Arnhem", 51.9700, 5.9200, false],
  ];
  const members = [{ uid: ME, name: "Jij (demo)", status: "approved" }];
  const locations = [];
  const priv = {};
  people.forEach(([name, areaName, lat, lng, visible], i) => {
    const u = "u" + i;
    members.push({ uid: u, name, status: "approved" });
    priv[u] = { area: { name: areaName, lat, lng }, visible };
    if (visible) locations.push({ uid: u, name, areaName, lat, lng });
  });
  members.push({ uid: "p1", name: "Nieuwe aanvraag (Tom)", status: "pending", inviteCode: "PUNTO2026" });
  const when = new Date(Date.now() + 9 * 864e5); when.setHours(20, 0, 0, 0);
  const meetId = "m1";
  const attendees = {};
  [["u0", true], ["u1", true], ["u2", true], ["u3", false], ["u4", true], ["u6", true]].forEach(([u, going]) => {
    attendees[u] = { uid: u, going };
  });
  return {
    inviteCode: "PUNTO2026",
    members, locations, priv,
    meets: [{ id: meetId, title: "Winter meet", when: toLocalInput(when), note: "Neem je beste rally-verhalen mee!", createdBy: "u0", createdByName: "Sanne", spot: null }],
    attendees: { [meetId]: attendees },
    spots: [
      ...START_SPOTS.map((s) => ({ id: nid(), ...s, approx: true, status: "approved" })),
      { id: nid(), name: "McDonald's Gouda", type: "mcd", lat: 52.0130, lng: 4.6890, status: "pending", suggested_by_name: "Daan", added_by: "u5" },
    ],
    messages: [
      { id: nid(), channel: "algemeen", uid: "u1", name: "Mehmet", text: "Welkom allemaal in de Punto app! 🚗", ts: Date.now() - 3600e3 },
      { id: nid(), channel: "algemeen", uid: "u0", name: "Sanne", text: "Wie gaat er mee naar de winter meet?", ts: Date.now() - 1800e3 },
      { id: nid(), channel: meetId, uid: "u2", name: "Jesse", text: "Ik neem wat lekkers mee voor bij de koffie.", ts: Date.now() - 900e3 },
    ],
  };
}

function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

let S;
try { S = JSON.parse(localStorage.getItem(KEY)) || seed(); } catch { S = seed(); }
const subs = new Set();
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} subs.forEach((f) => f()); }
function watch(fn) { const f = () => fn(); subs.add(f); setTimeout(f, 0); return () => subs.delete(f); }
const clone = (x) => JSON.parse(JSON.stringify(x));
const myName = () => S.members.find((m) => m.uid === ME)?.name || "Jij";

export const backend = {
  demo: true,
  resetDemo() { try { localStorage.removeItem(KEY); } catch {} S = seed(); save(); },

  onAuth(cb) { setTimeout(() => cb({ uid: ME, email: "demo@voorbeeld.nl" }), 0); return () => {}; },
  signUp: async () => {}, signIn: async () => {}, signOut: async () => { location.reload(); },
  resetPassword: async () => {},

  watchMe(cb) { return watch(() => cb({ member: clone(S.members.find((m) => m.uid === ME)), isAdmin: true })); },
  joinGroup: async () => {},
  async updateProfile({ name, photo }) {
    const m = S.members.find((x) => x.uid === ME); m.name = name; m.photo = photo || "";
    const l = S.locations.find((x) => x.uid === ME); if (l) l.name = name;
    save();
  },
  watchMembers(cb) { return watch(() => cb(clone(S.members))); },
  async approveMember(id) { const m = S.members.find((x) => x.uid === id); if (m) m.status = "approved"; save(); },
  async removeMember(id) { S.members = S.members.filter((m) => m.uid !== id); S.locations = S.locations.filter((l) => l.uid !== id); save(); },
  async getInviteCode() { return S.inviteCode; },
  async setInviteCode(c) { S.inviteCode = c; save(); },

  async getMyPrivate() { return clone(S.priv[ME] || null); },
  async saveMyArea({ area, visible }) {
    S.priv[ME] = { area, visible };
    S.locations = S.locations.filter((l) => l.uid !== ME);
    if (visible) S.locations.push({ uid: ME, areaName: area.name, lat: area.lat, lng: area.lng });
    save();
  },
  watchLocations(cb) { return watch(() => cb(clone(S.locations))); },

  watchMeets(cb) { return watch(() => cb(clone([...S.meets].sort((a, b) => a.when.localeCompare(b.when))))); },
  async createMeet(m) { S.meets.push({ id: nid(), ...m, createdBy: ME, spot: null }); save(); },
  async deleteMeet(id) { S.meets = S.meets.filter((m) => m.id !== id); delete S.attendees[id]; save(); },
  async setMeetSpot(id, spot) { const m = S.meets.find((x) => x.id === id); if (m) m.spot = spot; save(); },
  watchAttendees(meetId, cb) { return watch(() => cb(clone(Object.values(S.attendees[meetId] || {})))); },
  // Zelfde berekening als in de database: midden afgerond op ±5 km
  async meetOverview(meetId) {
    const going = Object.values(S.attendees[meetId] || {}).filter((a) => a.going);
    const pts = going.map((a) => S.priv[a.uid]).filter((p) => p?.area);
    const nHidden = pts.filter((p) => !p.visible).length;
    if (!pts.length) return { center: null, nPoints: 0, nHidden: 0, nNoArea: going.length };
    const lat = pts.reduce((t, p) => t + p.area.lat, 0) / pts.length;
    const lng = pts.reduce((t, p) => t + p.area.lng, 0) / pts.length;
    return {
      center: { lat: Math.round(lat / 0.05) * 0.05, lng: Math.round(lng / 0.075) * 0.075 },
      nPoints: pts.length, nHidden, nNoArea: going.length - pts.length,
    };
  },
  async setAttendance(meetId, going) {
    S.attendees[meetId] ||= {};
    S.attendees[meetId][ME] = { uid: ME, going };
    save();
  },

  watchSpots(cb) { return watch(() => cb(clone(S.spots))); },
  async addSpot(s) { S.spots.push({ id: nid(), ...s, status: "approved", added_by: ME }); save(); },
  async suggestSpot(s, byName) { S.spots.push({ id: nid(), name: s.name, type: s.type, lat: s.lat, lng: s.lng, status: "pending", suggested_by_name: byName, added_by: ME }); save(); },
  async approveSpot(id) { const x = S.spots.find((y) => y.id === id); if (x) x.status = "approved"; save(); },
  async updateSpot(id, s) { const x = S.spots.find((y) => y.id === id); if (x) Object.assign(x, s); save(); },
  async deleteSpot(id) { S.spots = S.spots.filter((s) => s.id !== id); save(); },
  async addSpotsBulk(list) { list.forEach((s) => S.spots.push({ id: nid(), ...s, approx: true })); save(); },

  // Pushmeldingen werken niet in de demo
  async pushPublicKey() { return null; },
  async pushStatus() { return false; },
  async setupPush() { throw new Error("Niet beschikbaar in de demo"); },
  async savePushSubscription() {}, async removePushSubscription() {},
  async sendTestPush() { throw new Error("Niet beschikbaar in de demo"); },

  watchMessages(channel, cb) { return watch(() => cb(clone(S.messages.filter((m) => m.channel === channel).slice(-150)))); },
  async sendMessage(channel, text, name) { S.messages.push({ id: nid(), channel, text: text.slice(0, 500), uid: ME, name, ts: Date.now() }); save(); },
  async deleteMessage(id) { S.messages = S.messages.filter((m) => m.id !== id); save(); },
};
