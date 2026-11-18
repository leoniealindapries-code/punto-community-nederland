// =====================================================================
//  Punto Community Nederland: meldingen versturen
//  Supabase Edge Function met de naam "notify".
//  Plak dit hele bestand in Supabase → Edge Functions → Deploy a new
//  function → Via Editor, en zet daarna "Verify JWT" UIT (zie LEESMIJ).
//
//  Veilig zonder JWT: de functie verstuurt alleen meldingen die de
//  database zelf al in de wachtrij heeft gezet. Een buitenstaander kan
//  dus geen eigen berichten laten versturen.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

// ---------- Web Push (RFC 8291 versleuteling + RFC 8292 VAPID), alleen WebCrypto ----------
const enc = new TextEncoder();

function b64uToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64u(b) {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

// Versleutelt een bericht voor één telefoon/browser (aes128gcm)
async function encryptPayload(payload, uaPublicB64u, authB64u, opts = {}) {
  const uaPublic = b64uToBytes(uaPublicB64u);
  const authSecret = b64uToBytes(authB64u);
  let as = opts.asKeys;
  if (!as) {
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    as = { privateKey: kp.privateKey, publicRaw: new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)) };
  }
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const prkKey = await hmac(authSecret, ecdh);
  const ikm = (await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, as.publicRaw, new Uint8Array([1])))).slice(0, 32);
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const plain = concat(typeof payload === "string" ? enc.encode(payload) : payload, new Uint8Array([2]));
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));
  const header = new Uint8Array(86);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(as.publicRaw, 21);
  return concat(header, ct);
}

// Ondertekening (VAPID) zodat de pushdienst weet dat de melding van ons komt
async function vapidAuth(endpoint, cfg) {
  const aud = new URL(endpoint).origin;
  const sub = cfg.site_url && /^https:\/\//.test(cfg.site_url) ? cfg.site_url : "mailto:meldingen@punto-community.nl";
  const head = bytesToB64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToB64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub })));
  const { kty, crv, x, y, d } = cfg.vapid_private;
  const key = await crypto.subtle.importKey("jwk", { kty, crv, x, y, d }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + claims)));
  return `vapid t=${head}.${claims}.${bytesToB64u(sig)}, k=${cfg.vapid_public}`;
}

async function sendPush(sub, message, cfg) {
  const body = await encryptPayload(JSON.stringify(message), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "normal",
      Authorization: await vapidAuth(sub.endpoint, cfg),
    },
    body,
  });
  if (res.status >= 300) console.log("push", res.status, await res.text().catch(() => ""));
  return res.status;
}

// ---------- De functie zelf ----------
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

function adminKey() {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    if (keys.default) return keys.default;
  } catch { /* oude projecten */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
}

if (typeof Deno !== "undefined" && Deno.serve) Deno.serve(async (req) => {
  let id = null;
  try { id = (await req.json())?.id ?? null; } catch { /* geen body */ }
  const db = createClient(Deno.env.get("SUPABASE_URL"), adminKey(), { auth: { persistSession: false } });

  // Meldingen "claimen": elke melding wordt maar één keer verstuurd
  let q = db.from("notifications").update({ sent_at: new Date().toISOString() }).is("sent_at", null);
  q = id ? q.eq("id", id) : q.gt("created_at", new Date(Date.now() - 864e5).toISOString());
  const { data: notes, error } = await q.select();
  if (error) return json({ error: error.message }, 500);
  if (!notes?.length) return json({ sent: 0 });

  const { data: cfg } = await db.from("push_config").select("*").eq("id", 1).single();
  if (!cfg?.vapid_public || !cfg?.vapid_private) return json({ error: "Meldingen zijn nog niet geactiveerd" }, 500);

  let sent = 0, removed = 0, failed = 0;
  for (const n of notes) {
    if (!n.user_ids?.length) continue;
    const { data: subs } = await db.from("push_subscriptions").select("*").in("user_id", n.user_ids);
    for (const s of subs || []) {
      try {
        const status = await sendPush(s, { title: n.title, body: n.body, url: n.url, tag: "pcn-" + n.id }, cfg);
        if (status === 404 || status === 410) {
          await db.from("push_subscriptions").delete().eq("endpoint", s.endpoint);   // telefoon bestaat niet meer
          removed++;
        } else if (status < 300) sent++;
        else failed++;
      } catch (e) { console.error(e); failed++; }
    }
  }
  return json({ sent, removed, failed });
});

export { encryptPayload, vapidAuth, b64uToBytes, bytesToB64u };
