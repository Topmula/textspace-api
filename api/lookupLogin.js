// Pre-auth login/recovery lookup. Given a username, email, or phone, returns the
// account's login email (and whether it's a real, resettable email) — nothing
// else. This lets the app find the login email WITHOUT the users collection
// being world-readable, so PII (emails/phones) stays private.
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
    const { identifier } = req.body || {};
    const val = String(identifier || "").trim();
    if (!val) return res.status(200).json({ found: false });
    const lower = val.toLowerCase();
    const db = admin.firestore();

    const tryQ = async (field, value) => {
      const s = await db.collection("users").where(field, "==", value).limit(1).get();
      return s.empty ? null : s.docs[0].data();
    };

    const u =
      (await tryQ("usernameLower", lower)) ||
      (await tryQ("username", lower)) ||
      (await tryQ("email", val)) ||
      (await tryQ("email", lower)) ||
      (await tryQ("phoneNumber", val)) ||
      (await tryQ("whatsappNumber", val)) ||
      (await tryQ("recoveryPhone", val));

    if (!u) return res.status(200).json({ found: false });

    const authEmail = u.authEmail || u.email || null;
    const hasRealEmail = !!(u.email && /\S+@\S+\.\S+/.test(u.email));
    return res.status(200).json({ found: true, authEmail, hasRealEmail });
  } catch (e) {
    console.error("lookupLogin error:", e);
    return res.status(500).json({ error: "Lookup failed" });
  }
}
