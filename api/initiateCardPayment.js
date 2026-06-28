import { importSPKI, CompactEncrypt } from "jose";

// Card payment. Card details arrive over HTTPS, get JWE-encrypted with Lenco's
// public key, and are charged via /collections/card. Card data is never stored.
// Requires a Vercel env var: LENCO_PUBLIC_KEY (your card encryption key from Lenco).
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { card, customer, amount, currency, reference, email, redirectUrl } = req.body;
    if (!card?.number || !card?.expiryMonth || !card?.expiryYear || !card?.cvv) {
      return res.status(400).json({ error: "Missing card details" });
    }

    const payload = {
      email,
      reference,
      amount: Number(amount),
      currency: currency || "ZMW",
      bearer: "merchant",
      redirectUrl,
      customer: {
        firstName: customer?.firstName || "TextSpace",
        lastName: customer?.lastName || "User",
      },
      billing: {
        streetAddress: "N/A",
        city: "Lusaka",
        state: "Lusaka",
        postalCode: "10101",
        country: "ZM",
      },
      card: {
        pan: String(card.number).replace(/\s/g, ""),
        expiryMonth: card.expiryMonth,
        expiryYear: card.expiryYear,
        cvv: card.cvv,
      },
    };

    // Encrypt the card payload with Lenco's public key (JWE)
    const pubKey = await importSPKI(process.env.LENCO_PUBLIC_KEY, "RSA-OAEP-256");
    const encryptedPayload = await new CompactEncrypt(
      new TextEncoder().encode(JSON.stringify(payload))
    )
      .setProtectedHeader({ alg: "RSA-OAEP-256", enc: "A256GCM" })
      .encrypt(pubKey);

    const response = await fetch("https://api.lenco.co/access/v2/collections/card", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer 22d74db1cc1957c484797085f15c893d0ca856a17fc1c8af576dba99d5193925",
      },
      body: JSON.stringify({ ...payload, encryptedPayload }),
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    console.error("initiateCardPayment error:", e);
    res.status(500).json({ error: "Card payment failed to initiate." });
  }
}
