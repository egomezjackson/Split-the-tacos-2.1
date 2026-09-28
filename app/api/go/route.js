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
  '"fee":number,"gratuity":number,"printed_total":number|null,' +
  '"tip_line":"none"|"blank"|"written",' +
  '"written_total":number|null,"written_tip":number|null}\n' +
  "Rules:\n" +
  "- items, subtotal, tax, fee, gratuity and printed_total come from machine-printed\n" +
  "  text ONLY.\n" +
  "- If a line has quantity 2 or more, emit that many separate entries so each can be claimed individually.\n" +
  '- "p" is the price of ONE unit.\n' +
  '- "subtotal" is the printed subtotal before tax. 0 if not printed.\n' +
  '- "fee" is a printed CARD surcharge only — a percentage for paying by card.\n' +
  "  0 if none. A gratuity or service charge is NOT a fee.\n" +
  '- "gratuity" is a printed tip already added to the bill: auto gratuity,\n' +
  "  service charge, large-party gratuity, propina. 0 if none. This is money the\n" +
  "  server receives, so it must never go in fee or tax.\n" +
  '- "printed_total" is the printed TOTAL or AMOUNT line — the final printed\n' +
  "  figure, including any printed gratuity. null if not printed. Ignore any\n" +
  "  suggested-tip table (\"+18% Total ...\"): those are options, not the total.\n" +
  '- "tip_line" describes the tip on paper: "none" if the receipt has no tip line\n' +
  '  at all, "blank" if there is a tip line with nothing written on it, "written"\n' +
  "  if anything at all has been written on it, legible or not.\n" +
  '- "written_total" is the final total handwritten at the bottom; "written_tip"\n' +
  "  the handwritten tip. These two are the ONLY handwriting you read as numbers.\n" +
  "- Return null for either one unless every digit is unmistakable. Null if a digit is\n" +
  "  inferred or ambiguous (a 1 that could be a 7, a 3 that could be an 8), if it is\n" +
  "  crossed out, overwritten, faint, partly out of frame, or if a decimal point is\n" +
  "  unclear. Null if the field is blank or you cannot find it.\n" +
  "- NEVER calculate any of these from the others, and never guess. A null costs\n" +
  "  nothing; a wrong digit changes what every person at the table pays.\n" +
  "- Numbers, not strings. No currency symbols.";

const cents = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) : 0);

// What may be filled into the total box. Every share is worked out from this
// number, so a misread is silent and expensive: anything the printed lines
// can't corroborate is thrown away and the payer types it instead.
function readTotal(d) {
  const lines =
    (d.items || []).reduce((a, it) => a + cents(it.p), 0) +
    cents(d.tax) + cents(d.fee) + cents(d.gratuity);
  if (lines <= 0) return null;

  // Not less than what's printed, and not a tip over half the bill — that's
  // what a misread digit looks like.
  const sane = (t) => t != null && t >= lines - 2 && t - lines <= Math.round(lines * 0.5);

  const printed = d.printed_total == null ? null : cents(d.printed_total);
  const total = d.written_total == null ? null : cents(d.written_total);
  const tip = d.written_tip == null ? null : cents(d.written_tip);
  const base = sane(printed) ? printed : lines;

  // Handwriting wins where it's legible: it was written after the printing.
  if (total != null && tip != null) {
    // Two readings that disagree mean one is wrong, with no way to tell which.
    if (Math.abs(base + tip - total) > 2) return null;
    return sane(total) ? total : null;
  }
  if (total != null) return sane(total) ? total : null;
  if (tip != null && tip >= 0) return sane(base + tip) ? base + tip : null;

  // Nothing handwritten to read. A receipt with no tip line, or an untouched
  // one, is already the final charge.
  if (d.tip_line !== "written" && sane(printed)) return printed;
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
      for (const k of ["printed_total", "tip_line", "written_total", "written_tip"]) delete d[k];
      d.gratuity = Number(d.gratuity) || 0;
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
