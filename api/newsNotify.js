// Trending news notifications. For each category, checks the current top story;
// if it changed since last run, pushes to users who follow that category (and
// haven't muted it). Self-rate-limited so it can't spam or burn the GNews quota.
import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const GNEWS_KEY = process.env.GNEWS_API_KEY;
const ONESIGNAL_APP_ID = "7baf2d90-402a-4626-a8cf-105eb47233c1";
const ONESIGNAL_REST_KEY = process.env.ONESIGNAL_REST_KEY;
const RATE_LIMIT_MS = 30 * 60 * 1000; // don't run more than every 30 min

const CAT = {
  breaking:      { type: "top", category: "general", label: "Breaking News", emoji: "📰" },
  world:         { type: "top", category: "world", label: "World News", emoji: "🌍" },
  business:      { type: "top", category: "business", label: "Business", emoji: "💼" },
  technology:    { type: "top", category: "technology", label: "Technology", emoji: "💻" },
  entertainment: { type: "top", category: "entertainment", label: "Entertainment", emoji: "🎬" },
  science:       { type: "top", category: "science", label: "Science", emoji: "🔬" },
  health:        { type: "top", category: "health", label: "Health", emoji: "🩺" },
  football:      { type: "search", q: "football OR soccer OR premier league", label: "Football", emoji: "⚽" },
  music:         { type: "search", q: "music OR album OR artist", label: "Music", emoji: "🎵" },
  gaming:        { type: "search", q: "gaming OR video game", label: "Gaming", emoji: "🎮" },
  movies:        { type: "search", q: "movie OR film", label: "Movies", emoji: "🍿" },
  ai:            { type: "search", q: "artificial intelligence OR AI", label: "AI", emoji: "🤖" },
  zambia:        { type: "top", country: "zm", label: "Zambia News", emoji: "🇿🇲" },
};

function buildUrl({ type, category, country, q }) {
  const base = type === "search" ? "https://gnews.io/api/v4/search" : "https://gnews.io/api/v4/top-headlines";
  const p = new URLSearchParams({ lang: "en", max: "1", apikey: GNEWS_KEY });
  if (type === "search") p.set("q", q);
  else { if (category) p.set("category", category); if (country) p.set("country", country); }
  return `${base}?${p.toString()}`;
}

async function pushTo(ids, title, message, data) {
  for (let i = 0; i < ids.length; i += 1900) {
    await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Basic ${ONESIGNAL_REST_KEY}` },
      body: JSON.stringify({ app_id: ONESIGNAL_APP_ID, include_subscription_ids: ids.slice(i, i + 1900), headings: { en: title }, contents: { en: message }, data }),
    }).catch(() => {});
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!GNEWS_KEY) return res.status(200).json({ error: "News not configured" });
    const db = admin.firestore();
    const now = Date.now();

    // Rate-limit floor (protects the GNews quota from repeated triggers).
    const metaRef = db.collection("newsNotifyState").doc("_meta");
    const meta = await metaRef.get();
    if (meta.exists && now - (meta.data().lastRun || 0) < RATE_LIMIT_MS) {
      return res.status(200).json({ skipped: "rate-limited" });
    }
    await metaRef.set({ lastRun: now });

    const cats = Object.keys(CAT);
    const tops = await Promise.all(cats.map(async (cat) => {
      try { const r = await fetch(buildUrl(CAT[cat])); const d = await r.json(); return { cat, a: (d.articles || [])[0] }; }
      catch (e) { return { cat, a: null }; }
    }));

    let notified = 0;
    for (const { cat, a } of tops) {
      if (!a || !a.url) continue;
      const stateRef = db.collection("newsNotifyState").doc(cat);
      const state = await stateRef.get();
      if (state.exists && state.data().lastUrl === a.url) continue; // already sent this story
      await stateRef.set({ lastUrl: a.url, at: now });

      const usersSnap = await db.collection("users").where("followedCategories", "array-contains", cat).get();
      const ids = [];
      usersSnap.docs.forEach(d => {
        const u = d.data();
        if (u.oneSignalId && !(u.mutedNewsCategories || []).includes(cat)) ids.push(u.oneSignalId);
      });
      if (ids.length) {
        const m = CAT[cat];
        await pushTo(ids, `${m.emoji} ${m.label}`, a.title, { type: "news", category: cat });
        notified++;
      }
    }
    return res.status(200).json({ ok: true, categoriesNotified: notified });
  } catch (e) {
    console.error("newsNotify error:", e);
    return res.status(500).json({ error: "notify failed" });
  }
}
