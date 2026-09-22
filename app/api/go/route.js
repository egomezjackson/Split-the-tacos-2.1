import { createClient } from "@supabase/supabase-js";

// Both server jobs behind one endpoint, so the project has exactly one
// file named route.js. Two of them in different folders is what broke
// the browser upload the first time round.

export const maxDuration = 60;

// SERVER ONLY. The secret key ignores every rule in schema.sql, which is
// why creating a bill happens here and not in the browser.
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false } }
);

const PROMPT =
  "Read this receipt. Return ONLY a JSON object — no markdown fences, no commentary:\n" +
  '{"merchant":string,"items":[{"n":string,"p":number}],"subtotal":number,"tax":number,' +
  '"fee":number,"written_total":number|null,"written_tip":number|null}\n' +
  "Rules:\n" +
  "- items, subtotal, tax and fee come from machine-printed text ONLY.\n" +
  "- If a line has quantity 2 or more, emit that many separate entries so each can be claimed individually.\n" +
  '- "p" is the price of ONE unit.\n' +
  '- "subtotal" is the printed subtotal before tax. 0 if not printed.\n' +
  '- "fee" is any printed credit card surcharge or service charge. 0 if none.\n' +
  '- "written_total" is the final total handwritten at the bottom; "written_tip" the\n' +
  "  handwritten tip. These two are the ONLY handwriting you read.\n" +
  "- Return null for either one unless every digit is unmistakable. Null if a digit is\n" +
  "  inferred or ambiguous (a 1 that could be a 7, a 3 that could be an 8), if it is\n" +
  "  crossed out, overwritten, faint, partly out of frame, or if a decimal point is\n" +
  "  unclear. Null if the field is blank or you cannot find it.\n" +
  "- NEVER calculate either number from the others, and never guess. A null costs\n" +
  "  nothing; a wrong digit changes what every person at the table pays.\n" +
  "- Numbers, not strings. No currency symbols.";

const cents = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) : 0);

// What the handwriting is allowed to claim. The card total is ground truth for
// every share, so a misread here is silent and expensive — these checks throw
// away anything that can't be corroborated by the printed lines.
function readTotal(d) {
  const printed =
    (d.items || []).reduce((a, it) => a + cents(it.p), 0) + cents(d.tax) + cents(d.fee);
  if (printed <= 0) return null;

  const total = d.written_total == null ? null : cents(d.written_total);
  const tip = d.written_tip == null ? null : cents(d.written_tip);
  const sane = (t) => t >= printed && t - printed <= Math.round(printed * 0.5);

  // Both read: they have to agree, or one of them is wrong and we don't know which.
  if (total != null && tip != null) {
    if (Math.abs(printed + tip - total) > 2) return null;
    return sane(total) ? total : null;
  }
  if (total != null) return sane(total) ? total : null;
  // Only the tip is legible, so the total is arithmetic rather than reading.
  if (tip != null && tip >= 0 && tip <= Math.round(printed * 0.5)) return printed + tip;
  return null;
}

export async function POST(req) {
  const body = await req.json();

  /* ---------------- read a receipt ---------------- */
  if (body.action === "scan") {
    try {
      const [meta, b64] = body.image.split(",");
      const mediaType = meta.match(/data:(.*?);/)[1];

      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 2000,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
              { type: "text", text: PROMPT },
            ],
          }],
        }),
      });

      const data = await r.json();
      if (!data.content) return Response.json({ error: "vision failed" }, { status: 502 });
      const text = data.content.map((b) => (b.type === "text" ? b.text : "")).join("")
        .replace(/```json|```/g, "").trim();
      const d = JSON.parse(text);
      // Offered as a starting point for the payer to check, never as a fact.
      // Blank when it isn't certain: they type it themselves, as before.
      const total = readTotal(d);
      delete d.written_total;
      delete d.written_tip;
      return Response.json({ ...d, total: total == null ? null : total / 100 });
    } catch {
      return Response.json({ error: "could not read that image" }, { status: 500 });
    }
  }

  /* ---------------- create a bill ---------------- */
  if (body.action === "create") {
    try {
      const row = {
        id: body.code,
        merchant: body.merchant || "",
        payer_name: body.payer_name || "",
        total_cents: body.total_cents || 0,
        tax_cents: body.tax_cents || 0,
        tip_cents: body.tip_cents || 0,
        fee_cents: body.fee_cents || 0,
        // Whose phone gets the "received" boxes. A role marker, not a lock:
        // same trust model as claiming items.
        collector_device: body.collector_device || null,
      };
      // The name on the payer's accounts, for apps that ask for one.
      row.pay_name = String(body.pay_name || "").trim().slice(0, 80);
      // Three label/value pairs, stored as typed. Empty strings for unused slots.
      const pay = Array.isArray(body.pay) ? body.pay : [];
      for (let n = 1; n <= 3; n++) {
        row[`pay${n}_label`] = String(pay[n - 1]?.label || "").trim().slice(0, 40);
        row[`pay${n}_value`] = String(pay[n - 1]?.value || "").trim().slice(0, 300);
      }

      const { error } = await admin.from("bills").insert(row);
      if (error) throw error;

      if (body.items?.length) {
        await admin.from("items").insert(
          body.items.map((it, i) => ({
            bill_id: body.code, name: it.name, price_cents: it.price_cents, position: i,
          }))
        );
      }
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}
