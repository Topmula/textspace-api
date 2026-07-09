// api/migrateLoginIndex.js — One-time (and repeatable) backfill that publishes a
// public `loginIndex` into Firestore so the app can resolve a username / email /
// phone → its Firebase auth email STRAIGHT FROM FIRESTORE at login time, without
// needing to reach this Vercel backend. Firestore is reachable on every network
// the app already works on (same infra as chat), so this makes sign-in work
// everywhere — the recurring "can't reach vercel.app" networks included.
//
// loginIndex/{key} = { authEmail, hasRealEmail, uid }   (key = lowercased identifier)
//
// Safe to run repeatedly (idempotent). Hit it once after deploy (mobile data or
// cron-job.org), and again whenever you want to refresh.

import admin from "firebase-admin";
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

const AUTH_EMAIL_DOMAIN = "textspace.local";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    const db = admin.firestore();
    const snap = await db.collection("users").get();
    let batch = db.batch();
    let inBatch = 0, indexed = 0;

    const put = (key, data) => {
      const k = String(key || "").toLowerCase().trim();
      if (!k) return;
      batch.set(db.collection("loginIndex").doc(k), data, { merge: true });
      inBatch++; indexed++;
    };

    for (const d of snap.docs) {
      const u = d.data();
      const uname = String(u.usernameLower || u.username || "").toLowerCase().trim();
      const authEmail = u.authEmail || (uname ? `${uname}@${AUTH_EMAIL_DOMAIN}` : "");
      if (!authEmail) continue;
      const hasRealEmail = !authEmail.endsWith(`@${AUTH_EMAIL_DOMAIN}`);
      const data = { authEmail, hasRealEmail, uid: d.id };

      if (uname) put(uname, data);
      if (u.email && String(u.email).includes("@")) put(u.email, data);
      if (u.recoveryPhone) put(String(u.recoveryPhone).replace(/\s/g, ""), data);
      if (u.phoneNumber) put(String(u.phoneNumber).replace(/\s/g, ""), data);

      if (inBatch >= 400) { await batch.commit(); batch = db.batch(); inBatch = 0; }
    }
    if (inBatch) await batch.commit();

    return res.status(200).json({ ok: true, users: snap.size, indexed });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
