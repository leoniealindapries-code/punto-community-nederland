// Pushmeldingen in de browser: aanzetten, uitzetten en sleutels maken.

export function b64uToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
export function bytesToB64u(b) {
  let s = "";
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isStandalone = () => window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

let swReg = null;
export async function registerSW() {
  if (!("serviceWorker" in navigator)) return null;
  try { swReg = await navigator.serviceWorker.register("sw.js"); } catch (e) { console.warn("Service worker:", e); }
  return swReg;
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = swReg || (await navigator.serviceWorker.getRegistration());
  return reg ? reg.pushManager.getSubscription() : null;
}

// Moet DIRECT vanuit een klik worden aangeroepen (iPhone eist dat)
export async function enablePush(publicKey) {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    const e = new Error("Meldingen zijn niet toegestaan. Zet ze aan in de instellingen van je telefoon of browser.");
    e.code = "confirm"; throw e;
  }
  const reg = swReg || (await navigator.serviceWorker.ready);
  let sub = await reg.pushManager.getSubscription();
  // Hoort een bestaande aanmelding bij een oude sleutel? Dan opnieuw aanmelden.
  if (sub && sub.options?.applicationServerKey && bytesToB64u(sub.options.applicationServerKey) !== publicKey) {
    await sub.unsubscribe(); sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
  const j = sub.toJSON();
  return { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth };
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  return endpoint;
}

// Sleutelpaar voor de beheerder (VAPID). Wordt één keer gemaakt bij het activeren.
export async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = await crypto.subtle.exportKey("raw", kp.publicKey);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { publicKey: bytesToB64u(pub), privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } };
}
