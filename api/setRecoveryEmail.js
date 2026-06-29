// Lets a logged-in user set their own recovery email as their account's login
// email, so Firebase password reset can actually reach it. Authenticated by the
// caller's Firebase ID token (a user can only change their OWN email).
import admin from "firebase-admin";

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
    if (!idToken) return res.status(401).json({ success: false, error: "Not signed in" });

    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    const { email } = req.body || {};
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(200).json({ success: false, error: "Please enter a valid email address." });
    }

    await admin.auth().updateUser(uid, { email });
    return res.json({ success: true });
  } catch (e) {
    let msg = "Couldn't save that email. Please try again.";
    if (e.code === "auth/email-already-exists") msg = "That email is already used by another account.";
    else if (e.code === "auth/invalid-email") msg = "That email address isn't valid.";
    console.error("setRecoveryEmail error:", e);
    return res.status(200).json({ success: false, error: msg });
  }
}
