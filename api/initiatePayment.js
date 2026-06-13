export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { phone, operator, amount, reference, email } = req.body;
    const response = await fetch("https://api.lenco.co/access/v2/collections/mobile-money", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer 22d74db1cc1957c484797085f15c893d0ca856a17fc1c8af576dba99d5193925",
      },
      body: JSON.stringify({
        amount,
        currency: "ZMW",
        reference,
        phone,
        operator,
        country: "zm",
        customer: { email },
      }),
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Payment initiation failed." });
  }
}
