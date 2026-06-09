export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { phone, operator, amount, reference, email } = req.body;
    const response = await fetch("https://sandbox.lenco.co/access/v2/collections/mobile-money", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer 993bed87f9d592566a6cce2cefd79363d1b7e95af3e1e6642b294ce5fc8c59f6",
      },
      body: JSON.stringify({
        amount,
        currency: "ZMW",
        reference,
        mobileMoneyDetails: { phone, operator, country: "ZM" },
        customer: { email },
      }),
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Payment initiation failed." });
  }
}
