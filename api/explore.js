// Explore news feed. Fetches from GNews, cached in Firestore per category so we
// stay well under GNews's free daily request limit. Also handles search.
import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const GNEWS_KEY = process.env.GNEWS_API_KEY;
const CACHE_MS = 2 * 60 * 60 * 1000; // re-fetch a category at most every 2 hours

// Map app categories -> GNews query.
const CAT = {
  breaking:      { type: "top", category: "general" },
  world:         { type: "top", category: "world" },
  business:      { type: "top", category: "business" },
  technology:    { type: "top", category: "technology" },
  entertainment: { type: "top", category: "entertainment" },
  science:       { type: "top", category: "science" },
  health:        { type: "top", category: "health" },
  football:      { type: "search", q: "football OR soccer OR premier league" },
  music:         { type: "search", q: "music OR album OR artist OR song" },
  gaming:        { type: "search", q: "gaming OR video game OR playstation OR xbox" },
  movies:        { type: "search", q: "movie OR film OR box office" },
  ai:            { type: "search", q: "artificial intelligence OR AI OR machine learning" },
  zambia:        { type: "top", country: "zm" },
};

function buildUrl({ type, category, country, q }) {
  const base = type === "search" ? "https://gnews.io/api/v4/search" : "https://gnews.io/api/v4/top-headlines";
  const params = new URLSearchParams({ lang: "en", max: "10", apikey: GNEWS_KEY });
  if (type === "search") params.set("q", q);
  else { if (category) params.set("category", category); if (country) params.set("country", country); }
  return `${base}?${params.toString()}`;
}

function normalize(articles, category) {
  return (articles || []).map(a => ({
    id: Buffer.from(a.url || a.title || Math.random().toString()).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 40),
    title: a.title || "",
    description: a.description || "",
    image: a.image || null,
    url: a.url || "",
    source: a.source?.name || "News",
    publishedAt: a.publishedAt || null,
    category,
  }));
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (!GNEWS_KEY) return res.status(200).json({ articles: [], error: "News not configured yet." });
    const db = admin.firestore();
    const q = (req.query.q || "").trim();

    // Search mode — not cached (varied queries), capped by GNews limit.
    if (q) {
      const r = await fetch(buildUrl({ type: "search", q }));
      const data = await r.json();
      return res.status(200).json({ articles: normalize(data.articles, "search") });
    }

    const category = (req.query.category || "breaking").toLowerCase();
    const conf = CAT[category] || CAT.breaking;
    const cacheRef = db.collection("newsCache").doc(category);
    const snap = await cacheRef.get();
    const now = Date.now();

    if (snap.exists && now - (snap.data().fetchedAt || 0) < CACHE_MS) {
      return res.status(200).json({ articles: snap.data().articles || [], cached: true });
    }

    const r = await fetch(buildUrl(conf));
    const data = await r.json();
    const articles = normalize(data.articles, category);
    // Only overwrite cache if we actually got articles (don't wipe on API errors).
    if (articles.length) {
      await cacheRef.set({ articles, fetchedAt: now });
      return res.status(200).json({ articles });
    }
    // Fall back to stale cache if the fetch failed/empty.
    return res.status(200).json({ articles: snap.exists ? (snap.data().articles || []) : [], stale: true });
  } catch (e) {
    console.error("explore error:", e);
    return res.status(200).json({ articles: [], error: "Failed to load news." });
  }
}
