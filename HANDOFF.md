# Split the bill — handoff after version 2

Paste this into a new chat along with the zip. It's the context needed to pick up
without rediscovering decisions that are already settled.

---

## What it is

A web app for splitting a restaurant bill. Photograph the receipt, share a QR,
everyone taps what they had. Tax, tip and fees are split **in proportion to what
each person ate**, not evenly — that proportional split is the entire reason the
app exists, because an even split of the extras quietly overcharges whoever had
the salad and undercharges whoever had three cocktails.

Version 1 is deployed and working. Version 2 (paying the payer back) is written
and described below; the README has the upgrade order. Don't break either.

## Stack

Next.js 15 (App Router, JavaScript, no TypeScript) on Vercel. Supabase for
Postgres and realtime. Claude via the Anthropic API for reading receipts. Plain
CSS, no Tailwind. Six files total.

```
package.json
schema.sql            (pasted into Supabase, never runs from the repo)
README.md
app/layout.js         page shell + the entire stylesheet, inlined
app/lib.js            supabase client, browser identity, all the money math
app/page.js           every screen: creating, tapping, paying back, receipts
app/api/go/route.js   reads receipts, creates bills
```

## Hard constraint: the owner edits through a browser

Work computer, no software installable. All editing happens in GitHub's web
editor, one file at a time, pencil icon and paste. **This is why the project is
six big files instead of twenty small ones**, and why no two files share a name.

Two failures already happened and shouldn't repeat:

- Dragging folders into GitHub's uploader flattens the structure silently and
  overwrites files that share a name. Files inside folders must be made with
  **Add file → Create new file** and the full path typed in, slashes included.
- GitHub leaves you inside the folder you just created, so paths compound into
  `app/app/app/`. Click the repo name in the breadcrumb before each new file.

Keep new work concentrated in existing files rather than adding new ones. Every
new file is a manual copy-paste for the owner.

## Decisions already made, and why

**The card total is ground truth.** `computeShares` in `lib.js` treats the amount
charged to the card as truth, since that's what left the account. Everything
above the item lines rides along proportionally. So the shares reconcile to the
real charge even when the scan misreads a line.

**Largest-remainder rounding.** Shares sum back to the charge *exactly*, never
approximately. Tested against a 1¢ item split three ways. The odd penny on a
shared item rotates by item index so it isn't always the same person.

**Handwriting is never scanned.** A receipt is two documents: printed lines,
subtotal, tax and fees scan cleanly; the tip and final total are written in pen,
which is exactly where OCR invents digits. The prompt explicitly refuses to read
handwriting. The payer types **one** number — the total they wrote — and the tip
is derived by subtraction, so it can't disagree with itself.

**No accounts for guests.** A random `device_id` in localStorage identifies
people. Forcing a Google login on five people at a restaurant table is where the
app would die.

**The bill code in the URL is the only guard.** Codes are random. Anyone with the
link can read the bill and claim items — that's intended, you hand it out by QR.
Nothing sensitive lives on a bill.

**Money is always integer cents.** Never floats. `toCents` handles both `1,234.56`
and `1.234,56`, because `parseFloat("201,18")` silently returns 201.

**Confirm-and-lock.** Each person taps "that's everything I had", which freezes
their own rows immediately. When everyone has confirmed and nothing is unclaimed,
the bill locks. Anyone can reopen. Enforced in the browser only, not the database.

## Bugs already found and fixed — don't reintroduce

Both were the same mistake: rendering that assumed something existed before it
did.

1. Joining set `me` before the diners list refreshed, so for one render there was
   a "you" not in the table, and computing their total crashed. Fixed by adding
   the new diner to local state in the same tick, plus a guard.
2. The QR drew from an effect that fired while its canvas wasn't mounted, then
   never fired again — the code only appeared after a manual refresh. Fixed with
   a ref callback that runs when the canvas actually mounts.

If something else misbehaves, suspect a third instance of this pattern first.

## Version 2 — what was built

No accounts. No payment APIs. No automated reading of payment screenshots. No
proof images. The owner considered and rejected all four as overbuilt — don't
reintroduce them.

**Payment methods on the create screen.** Up to three label/value pairs, plain
text, no validation, no per-app logic. `asLink` in `lib.js` decides link vs copy
button: only `http(s)://`, `www.`, or a bare domain *with a path*
(`paypal.me/marco`). So `marco.rossi`, emails and phone numbers get a copy button,
and `javascript:` can never become an href. Remembered in localStorage
(`split.pay`) so the payer types them once.

**Payment screen per person once the bill locks.** Same route, extra views at the
bottom of `page.js`: `PayUp` (owes), `Paid` (receipt), `Collecting` (payer's
ledger), `Collected` (payer's receipt). What you owe, a copy-amount button, the
payer's methods, a "sent" tick, and your itemized lines.

**Sent / received.** Two booleans on `diners`. Either side can tick sent. Only the
collector's phone renders received. Ticking received *displays* sent as ticked
but doesn't write it, so unticking a mistaken received restores the truth.

**Completion is the collector's call.** A diner's page becomes their receipt when
received is ticked; the collector's becomes the whole-bill receipt when everyone
is. "Ticked someone by mistake?" takes the collector back to the ledger.

**Collector identity: the loose version, as decided.** `bills.collector_device`
holds the creator's `device_id`, compared against localStorage in the browser.
A role marker, not a security boundary. Don't upgrade to a server-checked
secret unless the owner asks.

**Receipt download is `window.print()`** with a print stylesheet in `layout.js`
(`.noprint` hides the chrome). The page title is set for the dialog so the saved
PDF gets a sensible name. No PDF library.

### Decisions made while building

- **`schema.sql` is now re-runnable and never drops anything.** V1's version
  began with `drop table … cascade`, one careless paste from wiping every bill.
  It's now `create … if not exists`, `add column if not exists`, and DO blocks
  that check before adding publications and policies. Tested on Postgres 16:
  V1 schema + data, then the new file twice — data kept, nothing duplicated.
- **"Settled" is derived, not stored.** `received`, or the collector's own row,
  or a row that owes $0. The collector can't end up waiting on himself, and no
  write is needed to make that true.
- **Bills without `collector_device` keep the V1 locked screen.** Every bill made
  before the upgrade would otherwise get a payment page nobody can finish.
- **Itemized lines come from `computeShares` itself.** It records each person's
  cents per item as it hands out pennies, so receipts add up exactly. The math
  is untouched: checked identical to V1 on 399 random bills.
- **Pages reload when the phone wakes** (`visibilitychange`). People check back
  hours later to see if they've been marked received, long after realtime dropped.
- **Reopen on payment screens asks first**, since it sends everyone back to picking.

## Known limits

- Anyone with the link can claim any item, including someone else's. Among
  friends that's a feature.
- Realtime reloads everything on any change. Fine for a table of eight.
- Bills are never deleted.
- The interface is English regardless of the receipt's language.
- `page.js` is ~1,100 lines holding every screen. Worse to maintain, deliberately
  chosen for the browser-only constraint above.
- If the payer clears their browser or changes phones, nobody can tick received
  on that bill.
- Reopening after people have paid keeps their ticks, even if amounts change.

## Environment variables

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY   (sb_publishable_...)
SUPABASE_SECRET_KEY                    (sb_secret_..., server only, never NEXT_PUBLIC_)
ANTHROPIC_API_KEY
```

Supabase projects created after November 2025 have no `anon` or `service_role`
keys — publishable and secret replace them, in that order.
