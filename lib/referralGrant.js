// Shared by verifyPayment.js, checkPayment.js, and submitOTP.js — the three
// places a payment can be confirmed successful (card, mobile-money polling,
// mobile-money OTP). Grants the plan and credits a referrer, server-side only,
// idempotently per payment reference. Not a Vercel route (lives outside /api).
import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const REFERRAL_REWARD = 5; // ZMW per qualified (paid) referral
const PLAN_DAYS = 30;

export async function grantAndCredit({ reference, uid, plan }) {
  if (!reference || !uid || (plan !== "premium" && plan !== "membership")) return;
  const db = admin.firestore();

  // Idempotency: never process the same payment reference twice — a payment
  // can be confirmed via more than one polling path racing each other.
  const paymentRef = db.collection("payments").doc(reference);
  const already = await paymentRef.get();
  if (already.exists) return;

  const now = Date.now();
  const until = now + PLAN_DAYS * 24 * 60 * 60 * 1000;
  const userRef = db.collection("users").doc(uid);

  await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) return;
    const user = userSnap.data();

    const paymentSnap = await tx.get(paymentRef);
    if (paymentSnap.exists) return; // re-check inside the transaction

    const grant = { isVerified: true, verifiedUntil: until, plan };
    if (plan === "membership") { grant.isMember = true; grant.memberUntil = until; }
    tx.set(userRef, grant, { merge: true });

    tx.set(paymentRef, { uid, plan, reference, amount: plan === "membership" ? 20 : 7, createdAt: now });

    // Referral credit — exactly once per referred user, ever, and only if
    // their referrer is a currently-active Member (only Members earn from
    // referrals). Self-referral is blocked at signup (referredBy can never
    // equal the referred user's own uid).
    if (user.referredBy && !user.referralCreditGranted && user.referredBy !== uid) {
      const referrerRef = db.collection("users").doc(user.referredBy);
      const referrerSnap = await tx.get(referrerRef);
      if (referrerSnap.exists && referrerSnap.data().isMember) {
        tx.set(referrerRef, { earningsTotal: admin.firestore.FieldValue.increment(REFERRAL_REWARD) }, { merge: true });
        tx.set(userRef, { referralCreditGranted: true }, { merge: true });
      }
    }
  });
}
