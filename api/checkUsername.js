// Pre-auth username availability check for signup. Returns only { available },
// so the app can validate a username without the users collection being
// world-readable.
import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { username } = req.body || {};
    const clean = String(username || "").toLowerCase().trim();
    if (!clean) return res.status(200).json({ available: false });
    const db = admin.firestore();

    let s = await db.collection("users").where("usernameLower", "==", clean).limit(1).get();
    if (s.empty) s = await db.collection("users").where("username", "==", clean).limit(1).get();

    return res.status(200).json({ available: s.empty });
  } catch (e) {
    console.error("checkUsername error:", e);
    return res.status(500).json({ error: "Check failed" });
  }
}
