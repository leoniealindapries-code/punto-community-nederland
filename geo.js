// Zoeken van woonwijken (PDOK, overheid) en meetplekken (OpenStreetMap).

const PDOK = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free";

// Zoekt alleen wijken, buurten en woonplaatsen. Adressen en straten zijn
// bewust uitgesloten, zodat niemand een exacte locatie kan opgeven.
export async function searchAreas(q) {
  const url = `${PDOK}?q=${encodeURIComponent(q)}&rows=10` +
    `&fq=${encodeURIComponent("type:(wijk OR buurt OR woonplaats)")}` +
    `&fl=${encodeURIComponent("id,weergavenaam,type,centroide_ll")}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("Zoeken mislukt");
  const j = await r.json();
  return (j.response?.docs || []).map((d) => {
    const m = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(d.centroide_ll || "");
    if (!m) return null;
    return {
      id: d.id,
      name: d.weergavenaam,
      type: d.type,
      // afronden op ~100 m: het middelpunt van de wijk, geen huis
      lat: Math.round(parseFloat(m[2]) * 1000) / 1000,
      lng: Math.round(parseFloat(m[1]) * 1000) / 1000,
    };
  }).filter((x) => x && (x.type === "wijk" || x.type === "buurt" || x.type === "woonplaats"));
}

export function distanceKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Middelpunt van alle deelnemers (gemiddelde; voor Nederland nauwkeurig genoeg)
export function midpoint(points) {
  if (!points.length) return null;
  const s = points.reduce((acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }), { lat: 0, lng: 0 });
  return { lat: s.lat / points.length, lng: s.lng / points.length };
}

export const TYPE_LABEL = { mcd: "McDonald's", parking: "Parkeerplaats", industrie: "Industrieterrein" };

// Live zoeken in OpenStreetMap naar McDonald's, grote parkeerplaatsen en industrieterreinen
export async function searchLiveSpots(center, radiusKm = 12) {
  const r = Math.round(radiusKm * 1000);
  const { lat, lng } = center;
  const q = `[out:json][timeout:25];
(
  nwr["brand"="McDonald's"](around:${r},${lat},${lng});
  nwr["name"~"McDonald",i]["amenity"="fast_food"](around:${r},${lat},${lng});
  nwr["amenity"="parking"]["access"!="private"]["parking"!~"underground|multi-storey"]["capacity"~"^[0-9]{2,}$"](around:${r},${lat},${lng});
  nwr["amenity"="parking"]["park_ride"](around:${r},${lat},${lng});
  nwr["amenity"="parking"]["name"~"carpool",i](around:${r},${lat},${lng});
  way["landuse"="industrial"]["name"](around:${r},${lat},${lng});
);
out center tags 80;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: "data=" + encodeURIComponent(q),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) throw new Error("Live zoeken mislukt");
  const j = await res.json();
  const seen = new Set();
  const out = [];
  for (const el of j.elements || []) {
    const t = el.tags || {};
    const plat = el.lat ?? el.center?.lat, plng = el.lon ?? el.center?.lon;
    if (plat == null) continue;
    let type, name;
    if (/mcdonald/i.test(t.brand || t.name || "")) { type = "mcd"; name = `McDonald's ${t["addr:city"] || t.name?.replace(/mcdonald'?s/i, "").trim() || ""}`.trim(); }
    else if (t.amenity === "parking") { type = "parking"; name = t.name || (t.park_ride ? "P+R-terrein" : `Parkeerplaats (${t.capacity || "?"} plekken)`); }
    else if (t.landuse === "industrial") { type = "industrie"; name = t.name; }
    else continue;
    const key = type + Math.round(plat * 200) + "," + Math.round(plng * 200);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: "osm" + el.type[0] + el.id, name, type, lat: plat, lng: plng, live: true });
  }
  return out;
}

// Rangschik plekken: dichtst bij het midden van alle deelnemers eerst
export function rankSpots(spots, center) {
  return spots
    .map((s) => ({ ...s, toCenter: distanceKm(s, center) }))
    .sort((a, b) => a.toCenter - b.toCenter);
}
