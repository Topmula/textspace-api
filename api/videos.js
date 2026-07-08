// api/videos.js — Short-video feed for TextSpace Explore (YouTube Data API v3).
//
//   GET /api/videos?category=comedy
//   GET /api/videos?categories=comedy,funny,trending
//
// Needs Vercel env vars:
//   YOUTUBE_API_KEY           (free key from console.cloud.google.com — enable "YouTube Data API v3")
//   FIREBASE_SERVICE_ACCOUNT  (already set — reused for the Firestore cache)
//
// Clips are cached per-category in Firestore `videoCache/{category}` for 6h so
// we barely touch the YouTube quota (search.list costs 100 units/call; quota is
// 10,000/day). Admin SDK bypasses security rules.

const admin = require("firebase-admin");
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

const YT_KEY = process.env.YOUTUBE_API_KEY;
const CACHE_HOURS = 6;

// Category → YouTube search query. Every Explore video category maps to real,
// audio-driven entertainment content (not stock b-roll).
const QUERIES = {
  comedy: "comedy sketch funny shorts",
  funny: "funny fails clips shorts",
  gaming: "gaming highlights funny moments shorts",
  football: "football highlights skills shorts",
  music: "music video hits shorts",
  movies: "official movie trailer 2026",
  animals: "cute funny animals shorts",
  food: "food recipe cooking shorts",
  travel: "travel adventure shorts",
  satisfying: "oddly satisfying shorts",
  lifehacks: "life hacks tips shorts",
  fashion: "fashion style outfit lookbook shorts",
  ai: "AI technology news shorts",
  technology: "tech review gadgets shorts",
  entertainment: "entertainment celebrity shorts",
};
const CATS = Object.keys(QUERIES);

function parseISODuration(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

async function fetchDetails(ids) {
  if (!ids.length) return {};
  const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics,liveStreamingDetails&id=${ids.join(",")}&key=${YT_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return {};
  const data = await res.json();
  const map = {};
  (data.items || []).forEach((it) => { map[it.id] = it; });
  return map;
}

// Free-text search (Explore search bar) — not cached in Firestore since queries
// are unbounded/high-cardinality; relies on the 5-min HTTP Cache-Control header.
async function searchVideos(q) {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&type=video&videoDuration=short&videoEmbeddable=true&safeSearch=moderate&maxResults=12&order=relevance&key=${YT_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("youtube " + res.status);
  const data = await res.json();
  let items = (data.items || []).filter((it) => it.id && it.id.videoId);
  const details = await fetchDetails(items.map((it) => it.id.videoId));
  items = items.map((it) => ({ ...it, _details: details[it.id.videoId] }));

  return items
    .filter((it) => !it._details || !it._details.liveStreamingDetails)
    .map((it) => {
      const vid = it.id.videoId;
      const sn = it.snippet || {};
      const thumb = sn.thumbnails || {};
      return {
        id: "yt_" + vid,
        type: "video",
        category: "search",
        youtubeId: vid,
        title: sn.title || "",
        poster: (thumb.maxres || thumb.high || thumb.medium || thumb.default || {}).url || "",
        durationSec: it._details ? parseISODuration(it._details.contentDetails && it._details.contentDetails.duration) : 0,
        channelId: sn.channelId || "",
        source: sn.channelTitle || "YouTube",
        url: `https://www.youtube.com/watch?v=${vid}`,
      };
    })
    .filter((v) => v.youtubeId);
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

  let items;
  if (category === "trending") {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&chart=mostPopular&maxResults=15&videoCategoryId=24&regionCode=US&key=${YT_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("youtube " + res.status);
    const data = await res.json();
    items = (data.items || []).map((it) => ({ id: { videoId: it.id }, snippet: it.snippet, _details: it }));
  } else {
    const q = QUERIES[category] || category;
    const durationParam = category === "movies" ? "medium" : "short";
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&type=video&videoDuration=${durationParam}&videoEmbeddable=true&safeSearch=moderate&maxResults=12&order=relevance&key=${YT_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("youtube " + res.status);
    const data = await res.json();
    items = (data.items || []).filter((it) => it.id && it.id.videoId);
    const details = await fetchDetails(items.map((it) => it.id.videoId));
    items = items.map((it) => ({ ...it, _details: details[it.id.videoId] }));
  }

  const videos = items
    .filter((it) => !it._details || !it._details.liveStreamingDetails) // no live streams
    .map((it) => {
      const vid = it.id.videoId;
      const sn = it.snippet || {};
      const thumb = sn.thumbnails || {};
      return {
        id: "yt_" + vid,
        type: "video",
        category,
        youtubeId: vid,
        title: sn.title || "",
        poster: (thumb.maxres || thumb.high || thumb.medium || thumb.default || {}).url || "",
        durationSec: it._details ? parseISODuration(it._details.contentDetails && it._details.contentDetails.duration) : 0,
        channelId: sn.channelId || "",
        source: sn.channelTitle || "YouTube",
        url: `https://www.youtube.com/watch?v=${vid}`,
      };
    })
    .filter((v) => v.youtubeId);

  try { await ref.set({ videos, ts: now }); } catch (e) {}
  return videos;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=300");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!YT_KEY) return res.status(200).json({ videos: [], error: "no_key" });

  try {
    if (req.query.q && req.query.q.trim()) {
      const videos = await searchVideos(req.query.q.trim()).catch(() => []);
      return res.status(200).json({ videos });
    }

    let cats;
    if (req.query.categories) {
      cats = String(req.query.categories).split(",").map((s) => s.trim()).filter((c) => CATS.includes(c) || c === "trending");
    } else if (req.query.category && (CATS.includes(req.query.category) || req.query.category === "trending")) {
      cats = [req.query.category];
    } else {
      cats = ["comedy", "funny", "trending"];
    }
    if (!cats.length) cats = ["trending"];

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
