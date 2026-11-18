// Echte backend: Supabase (inloggen + database + live updates).
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
let currentUid = null;
const uid = () => currentUid;
let chanNr = 0;

// Fout van Supabase doorgeven als gewone fout met code
function check({ data, error }) {
  if (error) { const e = new Error(error.message); e.code = error.code || error.status || ""; throw e; }
  return data;
}

// Live meekijken: bij elke wijziging in de tabel de lijst opnieuw ophalen
function live(table, fetcher, cb) {
  let alive = true, timer = null;
  const run = async () => {
    try { const d = await fetcher(); if (alive) cb(d); } catch (e) { console.error(table, e); }
  };
  const debounced = () => { clearTimeout(timer); timer = setTimeout(run, 150); };
  // Bewust zonder filter: dan komen ook verwijderingen altijd door (kleine groep, dus prima)
  const opts = { event: "*", schema: "public", table };
  const ch = sb.channel(`${table}-${++chanNr}`).on("postgres_changes", opts, debounced).subscribe();
  run();
  return () => { alive = false; clearTimeout(timer); sb.removeChannel(ch); };
}

export const backend = {
  demo: false,

  // ---------- Inloggen ----------
  onAuth(cb) {
    let last = undefined;
    // Via een "wachtwoord vergeten"-link binnengekomen? Dan eerst een nieuw wachtwoord laten kiezen
    let recovering = /type=recovery/.test(location.hash);
    const handle = (event, session) => {
      if (event === "PASSWORD_RECOVERY" || (recovering && session)) { recovering = true; this._onRecovery?.(); return; }
      const id = session?.user?.id || null;
      if (id === last) return;           // alleen reageren als de gebruiker echt wisselt
      last = id; currentUid = id;
      if (id) sb.realtime.setAuth(session.access_token);
      cb(id ? { uid: id, email: session.user.email } : null);
    };
    const { data } = sb.auth.onAuthStateChange((event, session) => setTimeout(() => handle(event, session), 0));
    return () => data.subscription.unsubscribe();
  },
  onRecovery(fn) { this._onRecovery = fn; },
  async signUp(email, pw) {
    const data = check(await sb.auth.signUp({ email, password: pw, options: { emailRedirectTo: location.origin + location.pathname } }));
    if (!data.session) { const e = new Error("Check je e-mail en klik op de bevestigingslink. Log daarna in."); e.code = "confirm"; throw e; }
  },
  signIn: async (email, pw) => { check(await sb.auth.signInWithPassword({ email, password: pw })); },
  signOut: async () => { await sb.auth.signOut(); },
  resetPassword: async (email) => { check(await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname })); },
  setNewPassword: async (pw) => { check(await sb.auth.updateUser({ password: pw })); },

  // ---------- Lidmaatschap ----------
  watchMe(cb) {
    const fetcher = async () => {
      const m = check(await sb.from("members").select("*").eq("user_id", uid()).maybeSingle());
      const a = check(await sb.from("admins").select("user_id").eq("user_id", uid()).maybeSingle());
      return { member: m ? { uid: m.user_id, ...m } : null, isAdmin: !!a };
    };
    return live("members", fetcher, cb);
  },
  async joinGroup(name, code) { check(await sb.rpc("join_group", { p_name: name.trim(), p_code: (code || "").trim() })); },
  async updateProfile({ name, photo }) {
    check(await sb.from("members").update({ name, photo: photo || "" }).eq("user_id", uid()));
  },
  watchMembers(cb) {
    return live("members", async () => check(await sb.from("members").select("user_id,name,status,photo"))
      .map((m) => ({ uid: m.user_id, ...m })), cb);
  },
  async approveMember(id) { check(await sb.rpc("approve_member", { p_user: id })); },
  async removeMember(id) { check(await sb.from("members").delete().eq("user_id", id)); },
  async getInviteCode() { return check(await sb.from("app_config").select("invite_code").eq("id", 1).maybeSingle())?.invite_code || ""; },
  async setInviteCode(code) { check(await sb.from("app_config").update({ invite_code: code.trim() }).eq("id", 1)); },

  // ---------- Woonwijk ----------
  async getMyPrivate() {
    const r = check(await sb.from("private_areas").select("*").eq("user_id", uid()).maybeSingle());
    return r ? { area: { id: r.area_id, name: r.area_name, lat: r.lat, lng: r.lng }, visible: r.visible } : null;
  },
  async saveMyArea({ area, visible }) {
    check(await sb.from("private_areas").upsert({
      user_id: uid(), area_id: area.id || null, area_name: area.name, lat: area.lat, lng: area.lng,
      visible, updated_at: new Date().toISOString(),
    }));
  },
  watchLocations(cb) {
    return live("locations", async () => check(await sb.from("locations").select("*"))
      .map((l) => ({ uid: l.user_id, areaName: l.area_name, lat: l.lat, lng: l.lng })), cb);
  },

  // ---------- Meets ----------
  watchMeets(cb) {
    return live("meets", async () => check(await sb.from("meets").select("*").order("when_at"))
      .map((m) => ({ ...m, when: m.when_at, createdBy: m.created_by, createdByName: m.created_by_name })), cb);
  },
  async createMeet(m) {
    check(await sb.from("meets").insert({ title: m.title, when_at: m.when, note: m.note || "", created_by_name: m.createdByName }));
  },
  async deleteMeet(id) { check(await sb.from("meets").delete().eq("id", id)); },
  async setMeetSpot(id, spot) { check(await sb.from("meets").update({ spot }).eq("id", id)); },
  watchAttendees(meetId, cb) {
    return live("attendees", async () => check(await sb.from("attendees").select("user_id,going").eq("meet_id", meetId))
      .map((a) => ({ uid: a.user_id, going: a.going })), cb);
  },
  // Midden + tellingen, berekend in de database (onzichtbare wijken verlaten de server niet)
  async meetOverview(meetId) {
    const r = check(await sb.rpc("meet_overview", { p_meet: meetId }))?.[0] || {};
    return {
      center: r.center_lat != null ? { lat: r.center_lat, lng: r.center_lng } : null,
      nPoints: r.n_points || 0, nHidden: r.n_hidden || 0, nNoArea: r.n_no_area || 0,
    };
  },
  async setAttendance(meetId, going) {
    check(await sb.from("attendees").upsert({ meet_id: meetId, user_id: uid(), going, updated_at: new Date().toISOString() }));
  },

  // ---------- Meetplekken ----------
  watchSpots(cb) { return live("spots", async () => check(await sb.from("spots").select("*")), cb); },
  async addSpot(s) { check(await sb.from("spots").insert({ name: s.name, type: s.type, lat: s.lat, lng: s.lng, approx: !!s.approx, status: "approved" })); },
  // Lid stelt een plek voor; telt pas mee na goedkeuring door de beheerder
  async suggestSpot(s, byName) {
    check(await sb.from("spots").insert({ name: s.name, type: s.type, lat: s.lat, lng: s.lng, status: "pending", suggested_by_name: byName }));
  },
  async approveSpot(id) { check(await sb.from("spots").update({ status: "approved" }).eq("id", id)); },
  async updateSpot(id, s) { check(await sb.from("spots").update(s).eq("id", id)); },
  async deleteSpot(id) { check(await sb.from("spots").delete().eq("id", id)); },
  async addSpotsBulk(list) {
    check(await sb.from("spots").insert(list.map((s) => ({ name: s.name, type: s.type, lat: s.lat, lng: s.lng, approx: true, status: "approved" }))));
  },

  // ---------- Chat ----------
  watchMessages(channel, cb) {
    return live("messages", async () => {
      const rows = check(await sb.from("messages").select("*").eq("channel", channel).order("ts", { ascending: false }).limit(150));
      return rows.reverse().map((m) => ({ id: m.id, uid: m.user_id, name: m.name, text: m.text, ts: m.ts }));
    }, cb);
  },
  async sendMessage(channel, text, name) { check(await sb.from("messages").insert({ channel, text: text.slice(0, 500), name })); },
  async deleteMessage(id) { check(await sb.from("messages").delete().eq("id", id)); },
};
