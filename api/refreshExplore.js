// api/refreshExplore.js — Warms the Firestore Explore caches (newsCache +
// videoCache) for every category on a schedule, so the TextSpace app can read
// the whole Explore feed straight from Firestore and never needs to reach THIS
// backend from a user's (possibly network-restricted) device.
//
// Point a cron-job.org job at this every 30–60 min. Self-throttles per category
// so it stays well under GNews (100 req/day) and YouTube (10k units/day):
//   • news categories refresh at most every 4h  → 13 × 6/day ≈ 78 GNews calls
//   • video categories refresh at most every 6h → 15 × 4/day ≈ 60 YT searches
//
// Env: GNEWS_API_KEY, YOUTUBE_API_KEY, FIREBASE_SERVICE_ACCOUNT (all already set).

import admin from "firebase-admin";
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = admin.firestore();

const GNEWS_KEY = process.env.GNEWS_API_KEY;
const YT_KEY = process.env.YOUTUBE_API_KEY;
const ONESIGNAL_APP_ID = "7baf2d90-402a-4626-a8cf-105eb47233c1";
const ONESIGNAL_REST_KEY = process.env.ONESIGNAL_REST_KEY;
const NEWS_TTL = 4 * 60 * 60 * 1000;
const VIDEO_TTL = 6 * 60 * 60 * 1000;
const CREATOR_TTL = 3 * 60 * 60 * 1000; // refresh a followed creator's uploads every 3h

async function pushTo(ids, title, message, data) {
  if (!ONESIGNAL_REST_KEY) return;
  for (let i = 0; i < ids.length; i += 1900) {
    await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Basic ${ONESIGNAL_REST_KEY}` },
      body: JSON.stringify({ app_id: ONESIGNAL_APP_ID, include_subscription_ids: ids.slice(i, i + 1900), headings: { en: title }, contents: { en: message }, data }),
    }).catch(() => {});
  }
}

// ── News (must match api/explore.js exactly so cached shape is identical) ──
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

function buildNewsUrl({ type, category, country, q }) {
  const base = type === "search" ? "https://gnews.io/api/v4/search" : "https://gnews.io/api/v4/top-headlines";
  const params = new URLSearchParams({ lang: "en", max: "10", apikey: GNEWS_KEY });
  if (type === "search") params.set("q", q);
  else { if (category) params.set("category", category); if (country) params.set("country", country); }
  return `${base}?${params.toString()}`;
}

function normalizeNews(articles, category) {
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

// ── Videos (must match api/videos.js so cached shape is identical) ──
const VQ = {
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

function normalizeVideos(items, category) {
  return (items || [])
    .filter(it => it.id && (it.id.videoId || typeof it.id === "string"))
    .map(it => {
      const vid = it.id.videoId || it.id;
      const sn = it.snippet || {};
      const thumb = sn.thumbnails || {};
      return {
        id: "yt_" + vid,
        type: "video",
        category,
        youtubeId: vid,
        title: sn.title || "",
        poster: (thumb.maxres || thumb.high || thumb.medium || thumb.default || {}).url || "",
        channelId: sn.channelId || "",
        source: sn.channelTitle || "YouTube",
        url: `https://www.youtube.com/watch?v=${vid}`,
      };
    })
    .filter(v => v.youtubeId);
}

async function refreshNews(now) {
  let count = 0;
  for (const cat of Object.keys(CAT)) {
    const ref = db.collection("newsCache").doc(cat);
    const snap = await ref.get();
    if (snap.exists && now - (snap.data().fetchedAt || 0) < NEWS_TTL) continue;
    try {
      const r = await fetch(buildNewsUrl(CAT[cat]));
      const d = await r.json();
      const articles = normalizeNews(d.articles, cat);
      if (articles.length) { await ref.set({ articles, fetchedAt: now }); count++; }
    } catch (e) {}
  }
  return count;
}

async function refreshVideos(now) {
  let count = 0;
  const cats = [...Object.keys(VQ), "trending"];
  for (const cat of cats) {
    const ref = db.collection("videoCache").doc(cat);
    const snap = await ref.get();
    if (snap.exists && now - (snap.data().ts || 0) < VIDEO_TTL) continue;
    try {
      let items;
      if (cat === "trending") {
        const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&maxResults=15&videoCategoryId=24&regionCode=US&key=${YT_KEY}`;
        const r = await fetch(url); const d = await r.json();
        items = (d.items || []).map(it => ({ id: it.id, snippet: it.snippet }));
      } else {
        const dur = cat === "movies" ? "medium" : "short";
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(VQ[cat])}&type=video&videoDuration=${dur}&videoEmbeddable=true&safeSearch=moderate&maxResults=12&order=relevance&key=${YT_KEY}`;
        const r = await fetch(url); const d = await r.json();
        items = d.items || [];
      }
      const videos = normalizeVideos(items, cat);
      if (videos.length) { await ref.set({ videos, ts: now }); count++; }
    } catch (e) {}
  }
  return count;
}

// Caches each followed creator's latest uploads into creatorCache/{channelId}
// and notifies their followers when a genuinely new video appears. Uses the
// channel's uploads playlist (2 quota units/creator) instead of search (100).
async function refreshCreators(now) {
  // Gather the union of followed creators across all users (small user base →
  // a full scan is fine; revisit with an index collection if it grows large).
  let usersSnap;
  try { usersSnap = await db.collection("users").get(); } catch (e) { return { count: 0, notified: 0 }; }
  const followers = {}; // channelId -> [{ oneSignalId, muted }]
  const titles = {};
  usersSnap.docs.forEach(d => {
    const u = d.data();
    (u.followedCreators || []).forEach(c => {
      const cid = typeof c === "string" ? c : c && c.channelId;
      if (!cid) return;
      if (typeof c === "object" && c.channelTitle && !titles[cid]) titles[cid] = c.channelTitle;
      (followers[cid] = followers[cid] || []).push({ oneSignalId: u.oneSignalId, muted: (u.mutedCreators || []).includes(cid) });
    });
  });

  let count = 0, notified = 0;
  for (const cid of Object.keys(followers)) {
    const ref = db.collection("creatorCache").doc(cid);
    const snap = await ref.get();
    const prev = snap.exists ? snap.data() : null;
    if (prev && now - (prev.ts || 0) < CREATOR_TTL) continue;
    try {
      const chRes = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&id=${cid}&key=${YT_KEY}`);
      const ch = ((await chRes.json()).items || [])[0];
      const uploads = ch && ch.contentDetails && ch.contentDetails.relatedPlaylists && ch.contentDetails.relatedPlaylists.uploads;
      if (!uploads) continue;
      const channelTitle = (ch.snippet && ch.snippet.title) || titles[cid] || "Creator";
      const plRes = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploads}&maxResults=10&key=${YT_KEY}`);
      const videos = ((await plRes.json()).items || []).map(it => {
        const sn = it.snippet || {};
        const vid = sn.resourceId && sn.resourceId.videoId;
        const thumb = sn.thumbnails || {};
        if (!vid) return null;
        return { id: "yt_" + vid, type: "video", category: "creator", youtubeId: vid, title: sn.title || "", poster: (thumb.maxres || thumb.high || thumb.medium || thumb.default || {}).url || "", channelId: cid, source: channelTitle, url: `https://www.youtube.com/watch?v=${vid}` };
      }).filter(Boolean);
      if (!videos.length) continue;
      const latest = videos[0].youtubeId;
      await ref.set({ videos, channelTitle, ts: now, lastVideoId: latest });
      count++;
      // Notify only on a genuinely new upload (never on the first cache).
      if (prev && prev.lastVideoId && prev.lastVideoId !== latest) {
        const ids = followers[cid].filter(f => f.oneSignalId && !f.muted).map(f => f.oneSignalId);
        if (ids.length) { await pushTo(ids, `🎬 ${channelTitle}`, "posted a new video", { type: "creator", channelId: cid }); notified++; }
      }
    } catch (e) {}
  }
  return { count, notified };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    const now = Date.now();
    const news = GNEWS_KEY ? await refreshNews(now) : 0;
    const videos = YT_KEY ? await refreshVideos(now) : 0;
    const creators = YT_KEY ? await refreshCreators(now) : { count: 0, notified: 0 };
    return res.status(200).json({ ok: true, newsRefreshed: news, videosRefreshed: videos, creatorsRefreshed: creators.count, creatorNotifs: creators.notified });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
