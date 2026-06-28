// Admin-only password reset. Verifies the caller's Firebase ID token server-side
// and only allows the TextSpace admin to reset another user's password.
// No secret is stored in the app — security comes from the admin's logged-in token.
import admin from "firebase-admin";

const ADMIN_UID = "s2df5OVQZ9eNP1WoU45I6tC8Fz42";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: "Missing auth token" });

    const decoded = await admin.auth().verifyIdToken(idToken);
    if (decoded.uid !== ADMIN_UID) return res.status(403).json({ error: "Not authorized" });

    const { uid, newPassword } = req.body || {};
    if (!uid || !newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ error: "uid and newPassword (min 6 chars) required" });
    }

    await admin.auth().updateUser(uid, { password: String(newPassword) });
    return res.json({ success: true });
  } catch (e) {
    console.error("adminResetPassword error:", e);
    return res.status(500).json({ error: "Reset failed: " + (e.message || "unknown error") });
  }
}
