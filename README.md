# Split the bill

Photograph a receipt, share a QR, everyone taps what they had. Tax and tip get
split in proportion to what each person ordered, so whoever put down their card
doesn't absorb the difference. Nobody needs an account.

Once everyone has confirmed, each person gets a page with what they owe, how to
pay the person who covered it, and what they had. The payer ticks people off as
the money lands, and everyone ends with a receipt they can save as a PDF.

## Six files

| File | What it is |
|---|---|
| `package.json` | drag it in |
| `schema.sql` | drag it in — paste into Supabase, never runs from here |
| `README.md` | drag it in |
| `app/layout.js` | page shell and the whole stylesheet |
| `app/lib.js` | the money math and the database connection |
| `app/page.js` | every screen: making a bill, tapping one, paying back |
| `app/api/go/route.js` | reads receipts, creates bills |

No two files share a name, and there are only two folders to create.

## Getting it live

1. **supabase.com** → New project. Then SQL Editor → New query → paste all of
   `schema.sql` → Run. You want four tables: bills, items, diners, claims.
   The file is safe to run again later; it never deletes anything.
2. **Settings → Data API** for the Project URL, **Settings → API Keys** for the
   publishable key (`sb_publishable_...`) and the secret key (`sb_secret_...`).
   Older projects show `anon` and `service_role` instead — same things.
3. **console.anthropic.com** → add a little credit → create an API key.
4. Put the six files in a GitHub repo (see below).
5. **vercel.com** → Add New → Project → import the repo. Before deploying, add
   four environment variables:

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | your project URL |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_...` |
   | `SUPABASE_SECRET_KEY` | `sb_secret_...` |
   | `ANTHROPIC_API_KEY` | `sk-ant-...` |

6. Deploy.

### Getting the files into GitHub from a browser

Drag `package.json`, `schema.sql` and `README.md` straight in — they're loose
files with no structure to lose.

For the other four, use **Add file → Create new file** and type the path,
including the slashes. Typing a slash makes GitHub create the folder in front of
you. Paste the file's contents underneath, commit, repeat:

- `app/layout.js`
- `app/lib.js`
- `app/page.js`
- `app/api/go/route.js`

Never drag a folder into GitHub's uploader. It flattens the structure silently
and overwrites files that share a name.

## Upgrading from version 1

Every commit in GitHub redeploys, so the order matters. Done in this order, the
live app keeps working after every single step:

1. **Supabase → SQL Editor** → paste all of the new `schema.sql` → Run. It adds
   columns and touches nothing else. Existing bills are untouched.
2. `app/lib.js`
3. `app/api/go/route.js`
4. `app/layout.js`
5. `app/page.js`
6. `README.md`, whenever.

To replace a file: open it in GitHub, pencil icon, select all, paste, commit.

Bills made before the upgrade keep working exactly as before. They don't get
payment pages, because they don't know whose phone is collecting.

## Getting paid back

The person who made the bill adds up to three ways to pay: a label they type
("Venmo") and whatever that app needs (a link, a phone number, a username).
Links open when tapped; anything else gets a copy button. The phone remembers
them for next time.

When the bill locks, each person sees what they owe and can tick **sent**. The
payer's phone — the one that made the bill — shows everyone's row with **sent**
and **received**. Either side can tick sent; only the payer's phone shows
received. It's a shared list for keeping track, not proof of payment.

When the payer ticks someone received, that person's page turns into their
receipt. When everyone is received, the payer gets the whole bill as a receipt.
"Download receipt" opens the browser's print screen, where Save as PDF works on
every phone and computer.

## Why the total is typed

A receipt is two documents. Item lines, subtotal, tax and any card fee are
machine-printed and scan cleanly. The tip and the final total are written in pen,
and that's where character recognition invents digits.

So the scan ignores handwriting entirely and you type one number: the total you
wrote at the bottom. The tip is that total minus everything printed, which means
it can't disagree with itself. If the printed subtotal doesn't match the scanned
lines, the scan missed something and the app says so.

## The one function that matters

`computeShares`, near the bottom of `app/lib.js`. It treats the total charged to
the card as truth, because that's the number that left the account. Everything
above the item lines rides along in proportion to what each person ate, and
largest-remainder rounding makes the shares sum back to the charge exactly.

## Known limits

- Anyone with the link can claim any item, including someone else's. Among
  friends that's a feature.
- Bills are never deleted. The free tier won't fill up for years.
- The payer's phone is recognised by a random id the browser keeps. It's a role
  marker, not a lock, like everything else here. If the payer clears their
  browser or switches phones, nobody can tick received on that bill.
- Reopening a bill after people have paid keeps their ticks. If the amounts
  change, check the ticks still make sense.
- Two big files instead of eight small ones is worse for maintenance. That's the
  trade for being able to deploy from a locked-down browser.
