// api/videos.js — Short-video feed for TextSpace Explore (Pexels Videos API).
//
//   GET /api/videos?category=football
//   GET /api/videos?categories=football,ai,music
//
// Needs Vercel env vars:
//   PEXELS_API_KEY            (free key from https://www.pexels.com/api/)
//   FIREBASE_SERVICE_ACCOUNT  (already set — reused for the Firestore cache)
//
// Clips are cached per-category in Firestore `videoCache/{category}` for 12h so
// we barely touch the Pexels quota. Admin SDK bypasses security rules.

const admin = require("firebase-admin");
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

const PEXELS_KEY = process.env.PEXELS_API_KEY;
const CACHE_HOURS = 12;

// Category → Pexels search query. Every Explore category maps to something so
// the feed is never empty.
const QUERIES = {
  football: "soccer football stadium",
  technology: "technology gadgets computer",
  ai: "artificial intelligence robot futuristic",
  music: "music concert dj studio",
  gaming: "video game gaming esports",
  movies: "cinema film movie theatre",
  business: "business office finance city",
  entertainment: "party celebration stage lights",
  science: "science laboratory space research",
  breaking: "city skyline news",
  health: "fitness health wellness",
  world: "travel world landmarks",
  zambia: "africa landscape savanna",
};
const CATS = Object.keys(QUERIES);

// Pick a lightweight-but-sharp .mp4 (~720p) so it loads fast and looks premium.
function normalize(v, category) {
  const files = (v.video_files || []).filter((f) => f.file_type === "video/mp4" && f.link);
  files.sort((a, b) => (a.height || 0) - (b.height || 0));
  const pick = files.find((f) => f.height >= 640 && f.height <= 800) || files[files.length - 1];
  if (!pick) return null;
  return {
    id: "vid_" + v.id,
    type: "video",
    category,
    videoUrl: pick.link,
    poster: (v.video_pictures && v.video_pictures[0] && v.video_pictures[0].picture) || v.image || "",
    width: pick.width || v.width || 0,
    height: pick.height || v.height || 0,
    duration: v.duration || 0,
    source: (v.user && v.user.name) || "Pexels",
    url: v.url || "https://www.pexels.com",
  };
}

async function fetchCategory(category) {
  const now = Date.now();
  const ref = db.collection("videoCache").doc(category);
  try {
    const snap = await ref.get();
    if (snap.exists) {
      const d = snap.data();
      if (d.ts && now - d.ts < CACHE_HOURS * 3600 * 1000 && Array.isArray(d.videos) && d.videos.length) {
        return d.videos;
      }
    }
  } catch (e) {}

  const q = QUERIES[category] || category;
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&per_page=10&size=medium`;
  const res = await fetch(url, { headers: { Authorization: PEXELS_KEY } });
  if (!res.ok) throw new Error("pexels " + res.status);
  const data = await res.json();
  const videos = (data.videos || []).map((v) => normalize(v, category)).filter(Boolean);
  try { await ref.set({ videos, ts: now }); } catch (e) {}
  return videos;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=300");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!PEXELS_KEY) return res.status(200).json({ videos: [], error: "no_key" });

  try {
    let cats;
    if (req.query.categories) {
      cats = String(req.query.categories).split(",").map((s) => s.trim()).filter((c) => CATS.includes(c));
    } else if (req.query.category && CATS.includes(req.query.category)) {
      cats = [req.query.category];
    } else {
      cats = ["football", "technology", "ai", "music"];
    }
    if (!cats.length) cats = ["technology"];

    const results = await Promise.all(cats.map((c) => fetchCategory(c).catch(() => [])));
    let videos = [];
    results.forEach((r) => videos.push(...r));

    // De-dupe, shuffle, cap so the feed stays light.
    const seen = new Set();
    videos = videos.filter((v) => (v && !seen.has(v.id) && seen.add(v.id)));
    for (let i = videos.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [videos[i], videos[j]] = [videos[j], videos[i]];
    }
    videos = videos.slice(0, 20);

    res.status(200).json({ videos });
  } catch (e) {
    res.status(200).json({ videos: [], error: String((e && e.message) || e) });
  }
};
