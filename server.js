import express from "express";
import path from "path";

const app = express();
app.get("/", (req, res) => res.sendFile(path.resolve("index.html")));

const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const LABEL = { restaurant: "Restaurant", fast_food: "Fast food", cafe: "Cafe" };
const cache = new Map(); // 60s cache, be kind to the free servers

function dist(a, b, c, d) {
  const t = Math.PI / 180, x = (c - a) * t, y = (d - b) * t;
  const h = Math.sin(x / 2) ** 2 + Math.cos(a * t) * Math.cos(c * t) * Math.sin(y / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

async function overpass(query) {
  let err;
  for (const url of ENDPOINTS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "restaurant-finder-live/1.0" },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(15000)
      });
      if (r.ok) return await r.json();
      err = new Error("Overpass " + r.status);
    } catch (e) { err = e; }
  }
  throw err;
}

app.get("/api/nearby", async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  const radius = Math.min(Math.max(Number(req.query.radius) || 5000, 500), 25000);
  const q = String(req.query.q || "").replace(/[^\p{L}\p{N} ]/gu, "").trim().slice(0, 40);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return res.status(400).json({ error: "Bad coordinates" });

  const key = [lat.toFixed(3), lng.toFixed(3), radius, q.toLowerCase()].join("|");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 60000) return res.json(hit.data);

  const around = `(around:${radius},${lat},${lng})`;
  const base = `nwr["amenity"~"^(restaurant|fast_food|cafe)$"]["name"]`;
  const body = q
    ? `(${base}["name"~"${q}",i]${around};${base}["cuisine"~"${q}",i]${around};)`
    : `${base}${around}`;
  try {
    const j = await overpass(`[out:json][timeout:15];${body};out center 120;`);
    const places = (j.elements || []).map(e => {
      const t = e.tags || {}, la = e.lat ?? e.center?.lat, ln = e.lon ?? e.center?.lon;
      if (la == null || ln == null) return null;
      const cu = (t.cuisine || "").split(";")[0].replace(/_/g, " ");
      return {
        n: t.name,
        c: cu ? cu[0].toUpperCase() + cu.slice(1) : LABEL[t.amenity] || "Restaurant",
        a: t["addr:suburb"] || t["addr:street"] || t["addr:city"] || "",
        lat: la, lng: ln, r: 0, p: 0,
        o: t.opening_hours ? t.opening_hours.slice(0, 40) : "Hours not listed",
        d: dist(lat, lng, la, ln)
      };
    }).filter(Boolean).sort((x, y) => x.d - y.d).slice(0, 30);
    const data = { places };
    cache.set(key, { t: Date.now(), data });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    res.json(data);
  } catch (e) { console.error(e); res.status(502).json({ error: "Map data service is busy" }); }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Running on http://localhost:" + port));
