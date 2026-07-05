import { grantAndCredit } from "../lib/referralGrant.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { collectionId, reference, uid, plan } = req.body;
    const response = await fetch(`https://api.lenco.co/access/v2/collections/${collectionId}`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${process.env.LENCO_SECRET_KEY}` },
    });
    const data = await response.json();
    const status = data?.data?.status || data?.status;
    if ((status === "successful" || status === "completed") && reference && uid) {
      await grantAndCredit({ reference, uid, plan }).catch((e) => console.error("grantAndCredit:", e));
    }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Status check failed." });
  }
}
