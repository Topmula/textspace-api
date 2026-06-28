// Verify a payment by reference (used after the Lenco widget reports success).
// Server-to-server check with the secret key — never trust the frontend alone.
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { reference } = req.body;
    if (!reference) return res.status(400).json({ error: "Missing reference" });
    const response = await fetch(`https://api.lenco.co/access/v2/collections/status/${reference}`, {
      method: "GET",
      headers: {
        "Authorization": "Bearer 22d74db1cc1957c484797085f15c893d0ca856a17fc1c8af576dba99d5193925",
      },
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Verification failed." });
  }
}
