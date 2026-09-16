"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import QRCode from "qrcode";
import {
  supabase, deviceId, savedName, saveName, billCode, shrink,
  fmt, toCents, computeShares, PALETTE, initials,
  MAX_PAY, payMethods, payName, asLink, savedPay, savePay, savedPayName, savePayName,
} from "./lib";

/**
 * One page, two screens.
 *
 * No bill code in the URL means you're starting one. A code means you're
 * looking at one. Keeping both here means the whole app is four files,
 * which matters when the only way to get code into GitHub is a browser.
 *
 * Once a bill locks, the same route turns into the paying-back screens:
 * what you owe and how to pay, then a receipt once the payer marks it
 * received. The payer's own phone gets the ledger instead.
 */
export default function Page() {
  return (
    <Suspense fallback={<div className="page" />}>
      <Router />
    </Suspense>
  );
}

function Router() {
  const code = useSearchParams().get("c");
  return code ? <BillView code={code} /> : <NewBill />;
}

function NewBill() {
  const router = useRouter();
  const [name, setName] = useState(savedName());
  const [merchant, setMerchant] = useState("");
  const [items, setItems] = useState([]);
  const [printedSubtotal, setPrintedSubtotal] = useState(0); // cross-check only
  const [tax, setTax] = useState("");
  const [fee, setFee] = useState("");
  const [total, setTotal] = useState(""); // handwritten. typed, never scanned.
  // How people pay you back. Remembered from last time, one blank row if none.
  const [payerName, setPayerName] = useState(savedPayName);
  const [pay, setPay] = useState(() => {
    const p = savedPay().filter((x) => x.label || x.value);
    return p.length ? p : [{ label: "", value: "" }];
  });
  const [reading, setReading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const photo = useRef(null);
  const totalBox = useRef(null);

  const scan = async (file) => {
    setError("");
    setReading(true);
    try {
      const image = await shrink(file);
      const r = await fetch("/api/go", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "scan", image }),
      });
      const d = await r.json();
      if (d.error) throw new Error();
      setMerchant(d.merchant || "");
      setItems((d.items || []).map((it) => ({ name: it.n, price: String(it.p) })));
      setPrintedSubtotal(toCents(d.subtotal));
      setTax(String(d.tax ?? 0));
      setFee(String(d.fee ?? 0));
      // Straight to the one number they have to read off the paper.
      setTimeout(() => totalBox.current?.focus(), 200);
    } catch {
      setError("Couldn't read that one. Try a brighter, straighter photo — or type the lines in.");
      setItems([{ name: "", price: "" }]);
    }
    setReading(false);
  };

  const setItem = (i, patch) =>
    setItems(items.map((it, k) => (k === i ? { ...it, ...patch } : it)));
  const setPayRow = (i, patch) =>
    setPay(pay.map((p, k) => (k === i ? { ...p, ...patch } : p)));

  const itemsSum = items.reduce((a, it) => a + toCents(it.price), 0);
  const printed = itemsSum + toCents(tax) + toCents(fee);
  const totalCents = toCents(total);

  // The tip is whatever they wrote, minus everything the machine printed.
  // One number to type instead of two, and it can't disagree with itself.
  const tipCents = totalCents > 0 ? totalCents - printed : 0;

  // Two percentages, because "I left 18%" means different things depending
  // on whether you counted the tax. Showing both settles it.
  const pctFood = itemsSum > 0 ? (tipCents / itemsSum) * 100 : 0;
  const pctBill = printed > 0 ? (tipCents / printed) * 100 : 0;
  const pct = (n) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);

  const missedLine = printedSubtotal > 0 && Math.abs(printedSubtotal - itemsSum) > 2;
  const totalTooLow = totalCents > 0 && tipCents < 0;
  const tipOdd = totalCents > 0 && tipCents >= 0 && (pctFood > 40 || (pctFood < 5 && tipCents > 0));

  // A payment row needs both halves: which app, and where to send it. Half a
  // row is what made guests see a phone number with no idea which app it's for.
  const payHalf = (p) => !!p.label.trim() !== !!p.value.trim();
  const payIncomplete = pay.some(payHalf);

  const ready = name.trim() && items.length > 0 && totalCents > 0 && !totalTooLow && !payIncomplete;

  const create = async () => {
    setCreating(true);
    saveName(name.trim());
    // A label with nothing after it isn't a way to pay. Drop it.
    const methods = pay
      .map((p) => ({ label: p.label.trim(), value: p.value.trim() }))
      .filter((p) => p.value)
      .slice(0, MAX_PAY);
    savePay(methods);
    savePayName(payerName.trim());
    const code = billCode();
    const r = await fetch("/api/go", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "create",
        code,
        merchant,
        payer_name: name.trim(),
        collector_device: deviceId(),
        pay_name: payerName.trim(),
        pay: methods,
        total_cents: totalCents,
        tax_cents: toCents(tax),
        fee_cents: toCents(fee),
        tip_cents: Math.max(0, tipCents),
        items: items
          .filter((it) => it.name || toCents(it.price))
          .map((it) => ({ name: it.name, price_cents: toCents(it.price) })),
      }),
    });
    const d = await r.json();
    if (d.error) {
      setError("Could not create the bill. Try again.");
      setCreating(false);
      return;
    }
    router.push("/?c=" + code + "&new=1");
  };

  return (
    <div className="page">
      <div className="wrap">
        <h1>Split the tacos</h1>
        <p className="sub">
          Photograph the receipt, share the code, everyone taps what they had. Tax and tip
          get split by what you ordered, not down the middle.
        </p>

        {error && <div className="flag rose">{error}</div>}

        <div className="fld" style={{ marginBottom: 16 }}>
          <label>Your name</label>
          <input value={name} placeholder="Marco" onChange={(e) => setName(e.target.value)} />
        </div>

        {items.length === 0 ? (
          <div className="drop">
            <div className="num" style={{ fontSize: 15 }}>
              {reading ? "Reading the receipt…" : "Photograph the receipt"}
            </div>
            <p>
              Get the item lines and the tax in frame. You&apos;ll type the total yourself —
              handwriting is the one thing a scan can&apos;t be trusted with.
            </p>
            <input
              ref={photo}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: "none" }}
              onChange={(e) => e.target.files[0] && scan(e.target.files[0])}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
              <button className="btn" disabled={reading} onClick={() => photo.current.click()}>
                {reading ? "Reading…" : "Take a photo"}
              </button>
              <button className="btn ghost" onClick={() => setItems([{ name: "", price: "" }])}>
                Type it in
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* ---- the one number they read off the paper ---- */}
            <div className="sechead" style={{ marginBottom: 8 }}>
              <h2>What was the total?</h2>
            </div>
            <p className="lede">
              The whole amount charged to your card — tip, taxes and card fees included.
            </p>

            <div className="totalbox">
              <span className="sign">$</span>
              <input
                ref={totalBox}
                className="bigin"
                value={total}
                inputMode="decimal"
                placeholder="0.00"
                onChange={(e) => setTotal(e.target.value)}
              />
            </div>

            {totalCents > 0 && !totalTooLow && (
              <div className="tipcard">
                <div className="tipamt">
                  <span>Tip</span>
                  <b className="num">{fmt(tipCents)}</b>
                </div>
                <div className="tippcts">
                  <div>
                    <b className="num">{pct(pctFood)}%</b>
                    <span>on the food</span>
                  </div>
                  <div>
                    <b className="num">{pct(pctBill)}%</b>
                    <span>on the whole bill</span>
                  </div>
                </div>
              </div>
            )}
            {totalTooLow && (
              <div className="flag rose" style={{ marginTop: 10 }}>
                That&apos;s {fmt(-tipCents)} less than the printed lines come to. Check for a
                typo, or fix a price below.
              </div>
            )}
            {tipOdd && (
              <div className="flag amber" style={{ marginTop: 10 }}>
                That works out to a {pct(pctFood)}% tip on the food. Might be right — worth a second look at the
                total and the item prices.
              </div>
            )}

            {/* ---- the printed half ---- */}
            <div className="sec">
              <div className="sechead">
                <h2>{merchant || "The printed lines"}</h2>
                <span>Fix anything the scan got wrong</span>
              </div>

              <div className="fld" style={{ marginBottom: 10 }}>
                <input
                  value={merchant}
                  placeholder="Where were you?"
                  onChange={(e) => setMerchant(e.target.value)}
                />
              </div>

              {items.map((it, i) => (
                <div key={i} style={{ display: "flex", gap: 7, marginBottom: 6 }}>
                  <input
                    value={it.name}
                    placeholder="Item"
                    onChange={(e) => setItem(i, { name: e.target.value })}
                  />
                  <input
                    value={it.price}
                    inputMode="decimal"
                    placeholder="0.00"
                    style={{ width: 86, flex: "0 0 86px", textAlign: "right" }}
                    onChange={(e) => setItem(i, { price: e.target.value })}
                  />
                  <button className="x" onClick={() => setItems(items.filter((_, k) => k !== i))}>
                    ×
                  </button>
                </div>
              ))}
              <button
                className="btn ghost sm"
                onClick={() => setItems([...items, { name: "", price: "" }])}
              >
                Add a line
              </button>

              <div className="grid2" style={{ marginTop: 14 }}>
                <div className="fld">
                  <label>Tax</label>
                  <input value={tax} inputMode="decimal" onChange={(e) => setTax(e.target.value)} />
                </div>
                <div className="fld">
                  <label>Card fee</label>
                  <input value={fee} inputMode="decimal" onChange={(e) => setFee(e.target.value)} />
                </div>
              </div>

              {missedLine && (
                <div className="flag amber" style={{ marginTop: 12 }}>
                  The receipt prints a subtotal of {fmt(printedSubtotal)}, but these lines add up
                  to {fmt(itemsSum)}. The scan probably missed an item or misread a price.
                </div>
              )}

              <div className="lline" style={{ marginTop: 10 }}>
                <span>Printed lines come to</span>
                <b className="num">{fmt(printed)}</b>
              </div>
            </div>

            {/* ---- how they pay you back ---- */}
            <div className="sec">
              <div className="sechead">
                <h2>How people pay you back</h2>
                <span>Optional, up to {MAX_PAY}</span>
              </div>

              <div className="fld" style={{ marginBottom: 12 }}>
                <label>Your full name</label>
                <input
                  value={payerName}
                  aria-label="Your full name"
                  onChange={(e) => setPayerName(e.target.value)}
                />
                <div className="hint" style={{ marginTop: 4 }}>
                  Shown with every method below. Some apps, Zelle especially, won&apos;t send
                  without the name on the account.
                </div>
              </div>

              {/* Headings, not placeholders: grey example text in the box read as
                  something already filled in. */}
              <div className="payhead">
                <span style={{ flex: "0 0 112px" }}>App name</span>
                <span>Link, username or phone</span>
              </div>
              {pay.map((p, i) => (
                <div key={i} style={{ marginBottom: 6 }}>
                  <div style={{ display: "flex", gap: 7 }}>
                    <input
                      value={p.label}
                      aria-label="App name"
                      style={{ width: 112, flex: "0 0 112px" }}
                      onChange={(e) => setPayRow(i, { label: e.target.value })}
                    />
                    <input
                      value={p.value}
                      aria-label="Link, username or phone"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(e) => setPayRow(i, { value: e.target.value })}
                    />
                    <button
                      className="x"
                      aria-label="Remove"
                      onClick={() =>
                        setPay(pay.length > 1 ? pay.filter((_, k) => k !== i) : [{ label: "", value: "" }])
                      }
                    >
                      ×
                    </button>
                  </div>
                  {payHalf(p) && (
                    <div className="warn" style={{ marginTop: 4 }}>
                      {p.value.trim()
                        ? "Type which app this is for, so people know where to send it."
                        : "Add the link, username or phone for this app, or remove the row."}
                    </div>
                  )}
                </div>
              ))}
              {pay.length < MAX_PAY && (
                <button
                  className="btn ghost sm"
                  onClick={() => setPay([...pay, { label: "", value: "" }])}
                >
                  Add another
                </button>
              )}
              <div className="hint">
                Type the app&apos;s name, then whatever it needs to find you. Links open when tapped;
                anything else gets a copy button. Everyone sees them once the split is final.
              </div>
            </div>

            <button
              className="btn"
              style={{ width: "100%", marginTop: 20 }}
              disabled={!ready || creating}
              onClick={create}
            >
              {creating
                ? "Creating…"
                : ready
                ? "Looks right — make the code"
                : !name.trim() || totalCents <= 0
                ? "Add your name and the total"
                : totalTooLow
                ? "Fix the total first"
                : "Finish the payment details first"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function BillView({ code }) {
  const [bill, setBill] = useState(null);
  const [items, setItems] = useState([]);
  const [diners, setDiners] = useState([]);
  const [claims, setClaims] = useState([]);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  // Prefilled from last time, but held in state so it's a normal editable box.
  // It used to fall back to the saved name whenever the field was empty, so
  // deleting the last letter put the old name straight back.
  const [joinName, setJoinName] = useState("");
  useEffect(() => { setJoinName(savedName()); }, []);
  const [showShare, setShowShare] = useState(false);
  // The payer can go back to the ledger after it's complete, in case they
  // ticked someone by mistake.
  const [ledgerOpen, setLedgerOpen] = useState(false);

  const load = useCallback(async () => {
    const [b, i, d] = await Promise.all([
      supabase.from("bills").select("*").eq("id", code).maybeSingle(),
      supabase.from("items").select("*").eq("bill_id", code).order("position"),
      supabase.from("diners").select("*").eq("bill_id", code).order("joined_at"),
    ]);
    if (!b.data) { setMissing(true); setLoading(false); return; }
    const ids = (i.data || []).map((x) => x.id);
    const c = ids.length ? await supabase.from("claims").select("*").in("item_id", ids) : { data: [] };
    setBill(b.data);
    setItems(i.data || []);
    setDiners(d.data || []);
    setClaims(c.data || []);
    setMe((d.data || []).find((x) => x.device_id === deviceId()) || null);
    setLoading(false);
  }, [code]);

  useEffect(() => {
    load();
    // Any change, reload everything. At a dinner table that's a handful of
    // rows — simpler and far less buggy than patching state by hand.
    const ch = supabase
      .channel("bill:" + code)
      .on("postgres_changes", { event: "*", schema: "public", table: "items" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "diners" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "claims" }, load)
      .subscribe();
    // A phone that slept through an update catches up when it wakes. People
    // come back hours later to see whether they've been marked received, and
    // a locked phone's realtime connection is long gone by then.
    const wake = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      supabase.removeChannel(ch);
    };
  }, [code, load]);


  const url = typeof window !== "undefined" ? window.location.origin + "/?c=" + code : "";
  // A ref callback runs the instant the canvas mounts. An effect keyed on
  // other state can fire while the canvas doesn't exist yet, draw nothing,
  // and never get a second chance — which is why the code used to show up
  // only after a refresh.
  const drawQr = useCallback(
    (node) => { if (node && url) QRCode.toCanvas(node, url, { width: 200, margin: 1 }); },
    [url]
  );

  const join = async (n) => {
    const clean = (n || "").trim();
    if (!clean) return;
    saveName(clean);
    const { data } = await supabase
      .from("diners")
      .insert({ bill_id: code, device_id: deviceId(), name: clean, color: PALETTE[diners.length % PALETTE.length] })
      .select().single();
    // Put them into local state in the same tick as setMe. Otherwise the next
    // render has a `me` who isn't in `diners` yet, and working out the totals
    // for a person who doesn't exist throws.
    if (data) {
      setDiners((ds) => (ds.some((x) => x.id === data.id) ? ds : [...ds, data]));
      setMe(data);
    }
    load();
  };

  // Whoever made the bill lands here with the code open, ready to show.
  const autoJoined = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!new URLSearchParams(window.location.search).get("new")) return;
    setShowShare(true);
    // They already gave their name on the previous screen. Put them on the
    // bill rather than showing them a join box for a bill they just created.
    if (!loading && !me && !autoJoined.current && savedName()) {
      autoJoined.current = true;
      join(savedName());
    }
  }, [loading, me]);

  const setDone = async (v) => {
    setDiners((ds) => ds.map((d) => (d.id === me.id ? { ...d, done: v } : d)));
    setMe((m) => ({ ...m, done: v }));
    await supabase.from("diners").update({ done: v }).eq("id", me.id);
    load();
  };

  // Ticking sent or received, on anyone's row. Optimistic, then written.
  // `me` is patched alongside `diners` so the two never disagree for a render.
  const patchDiner = async (id, patch) => {
    setDiners((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    setMe((m) => (m && m.id === id ? { ...m, ...patch } : m));
    await supabase.from("diners").update(patch).eq("id", id);
    load();
  };

  const toggle = async (itemId) => {
    // Once you've confirmed, your taps stop registering. That's the point —
    // a stray thumb while the phone is going round the table shouldn't
    // quietly change what someone owes.
    if (!me || me.done) return;
    const mine = claims.some((c) => c.item_id === itemId && c.diner_id === me.id);
    // Optimistic, so tapping feels instant on restaurant wifi.
    setClaims((cs) =>
      mine ? cs.filter((c) => !(c.item_id === itemId && c.diner_id === me.id))
           : [...cs, { item_id: itemId, diner_id: me.id }]
    );
    if (mine) await supabase.from("claims").delete().eq("item_id", itemId).eq("diner_id", me.id);
    else await supabase.from("claims").insert({ item_id: itemId, diner_id: me.id });
  };

  if (loading) return <Shell><p className="sub">Loading…</p></Shell>;
  if (missing)
    return (
      <Shell>
        <h1>No such bill</h1>
        <p className="sub">That link is wrong, or the bill was deleted.</p>
        <a className="btn" href="/">Start a new one</a>
      </Shell>
    );

  const s = computeShares({ items, diners, claims, bill });
  const allClaimed = s.unclaimedCount === 0 && diners.length > 0;
  const confirmedCount = diners.filter((d) => d.done).length;
  // Locked once everyone has said they're finished AND nothing is unclaimed.
  // Someone joining later un-locks it automatically, since they aren't done.
  const locked = allClaimed && diners.length > 0 && confirmedCount === diners.length;

  /* --- not on the bill yet --- */
  if (!me)
    return (
      <Shell>
        <h1>{bill.merchant || "Split the tacos"}</h1>
        <p className="sub">
          {bill.payer_name ? bill.payer_name + " covered this one. " : ""}
          {fmt(s.grand)} total. Put your name in and tap what you had.
        </p>
        <div style={{ display: "flex", gap: 7 }}>
          <input
            value={joinName}
            placeholder="Your name"
            onChange={(e) => setJoinName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && join(joinName)}
          />
          <button className="btn" disabled={!joinName.trim()} onClick={() => join(joinName)}>
            Join
          </button>
        </div>
      </Shell>
    );

  // Belt and braces: a realtime update can also briefly hand us a `me` who
  // isn't in the diner list yet. Wait a beat rather than crashing.
  const mine = s.byId[me.id];
  if (!mine) return <Shell><p className="sub">Loading…</p></Shell>;

  /* --- locked: paying the payer back --- */
  // Only bills made since version 2 know whose phone collects. Older bills
  // keep the version 1 locked screen below, rather than a payment page
  // nobody would be able to finish.
  if (locked && bill.collector_device) {
    const isCollector = (d) => d.device_id === bill.collector_device;
    // Settled means the payer ticked received — or it's the payer's own row,
    // already on their card, or a row with nothing to pay. Worked out here
    // rather than stored, so the payer can never end up waiting on himself.
    const settled = (d) => d.received || isCollector(d) || (s.byId[d.id]?.total ?? 0) <= 0;
    const meRow = diners.find((d) => d.id === me.id) || me;
    const reopen = () => {
      if (window.confirm("Reopen the bill? Everyone goes back to picking items.")) setDone(false);
    };
    const v = { bill, diners, s, me: meRow, settled, isCollector, patchDiner, reopen };

    if (isCollector(meRow)) {
      return diners.every(settled) && !ledgerOpen
        ? <Collected {...v} openLedger={() => setLedgerOpen(true)} />
        : <Collecting {...v} closeLedger={() => setLedgerOpen(false)} />;
    }
    return settled(meRow) ? <Paid {...v} /> : <PayUp {...v} />;
  }

  return (
    <Shell>
      <h1>{bill.merchant || "Split the tacos"}</h1>
      <p className="sub">
        You&apos;re {me.name}. Tap everything you had — everyone else&apos;s screen updates as you go.
      </p>

      {showShare && (
        <div className="share" style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Everyone scan this</div>
          <div className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
            Phone camera, not the app. It opens straight to this bill.
          </div>
          <canvas ref={drawQr} />
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 14 }}>
            <button className="btn ghost sm" onClick={() => navigator.clipboard?.writeText(url)}>
              Copy the link
            </button>
            <button className="btn ghost sm" onClick={() => setShowShare(false)}>Hide</button>
          </div>
        </div>
      )}

      {/* ---- what you owe ---- */}
      <div className={"tot" + (locked ? " done" : "")} style={{ marginBottom: 22 }}>
        <div className="hint" style={{ marginTop: 0 }}>
          {locked ? "Final — everyone confirmed" : "Your share"}
        </div>
        <div className="big num" style={{ margin: "4px 0 6px" }}>{fmt(mine.total)}</div>
        <div className="brk">
          {fmt(mine.sub)} for what you had, plus {fmt(mine.extra)} of the tax, tip and fees
        </div>
      </div>

      {/* ---- items ---- */}
      <div className="sechead">
        <h2>
          {locked
            ? "Locked"
            : me.done
            ? "Waiting on the others"
            : allClaimed
            ? "Everything's claimed"
            : `${s.unclaimedCount} left to claim`}
        </h2>
        {!showShare && <button className="mini" onClick={() => setShowShare(true)}>show the code</button>}
      </div>
      <div className="prog">
        <i style={{ width: `${items.length ? ((items.length - s.unclaimedCount) / items.length) * 100 : 0}%` }} />
      </div>

      {!locked && !me.done && (
        <div className={"tapnote" + (mine.lines.length === 0 ? " loud" : "")}>
          {mine.lines.length === 0
            ? "Tap each thing you had to add it to your total. Tap it again to undo."
            : "Tap anything else you had, or tap again to undo."}
        </div>
      )}

      {items.map((it) => {
        const on = s.claimersOf[it.id] || [];
        const isMine = on.includes(me.id);
        return (
          <button
            key={it.id}
            className={
              "row" + (isMine ? " mine" : "") + (on.length === 0 && !locked ? " open" : "") +
              (me.done ? " frozen" : "")
            }
            onClick={() => toggle(it.id)}
            disabled={me.done}
          >
            <span className="nm">{it.name || "Untitled item"}</span>
            <span className="pr num">{fmt(it.price_cents)}</span>
            <span className="foot">
              {on.map((id) => {
                const d = diners.find((x) => x.id === id);
                return d ? <span key={id} className="chip" style={{ background: d.color }}>{initials(d.name)}</span> : null;
              })}
              {on.length === 0 ? (
                <span className="warn">Nobody yet</span>
              ) : on.length > 1 ? (
                <span className="each">{fmt(Math.round(it.price_cents / on.length))} each, {on.length} ways</span>
              ) : null}
            </span>
          </button>
        );
      })}

      {s.unclaimed !== 0 && (
        <div className="flag amber" style={{ marginTop: 12 }}>
          {fmt(s.unclaimed)} nobody has claimed, including its share of tax and tip.
        </div>
      )}

      <div className="confirmbar">
        {locked ? (
          <>
            <div className="flag marine" style={{ marginBottom: 10 }}>
              Everyone confirmed. Amounts are final.
            </div>
            <button className="btn ghost" style={{ width: "100%" }} onClick={() => setDone(false)}>
              Something&apos;s wrong — reopen it
            </button>
          </>
        ) : me.done ? (
          <>
            <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
              You&apos;re done. {confirmedCount} of {diners.length} confirmed
              {diners.filter((d) => !d.done).length <= 3 && (
                <> · waiting on {diners.filter((d) => !d.done).map((d) => d.name).join(", ")}</>
              )}
            </div>
            <button className="btn ghost" style={{ width: "100%" }} onClick={() => setDone(false)}>
              Change my picks
            </button>
          </>
        ) : (
          <>
            <button className="btn tall" onClick={() => setDone(true)}>
              <span className="lead">
                {mine.total > 0 ? `Submit ${fmt(mine.total)}` : "Submit"}
              </span>
              <span className="under">
                {mine.total > 0 ? "That's everything I had" : "Nothing here was mine"}
              </span>
            </button>
            <div className="hint">
              Locks your picks so a stray tap can&apos;t change them. You can still change your
              mind afterwards.
              {confirmedCount > 0 && ` ${confirmedCount} of ${diners.length} confirmed so far.`}
            </div>
          </>
        )}
      </div>

      {/* ---- everyone ---- */}
      <div className="sec">
        <div className="sechead">
          <h2>Everyone</h2>
          <span>{fmt(s.grand)} total</span>
        </div>
        <div className="ledger">
          {diners.map((d) => (
            <div className="lline" key={d.id} style={{ padding: "6px 0" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--ink)" }}>
                <span className="chip" style={{ background: d.color }}>{initials(d.name)}</span>
                {d.name}
                {d.done && <span className="tick">{"\u2713"}</span>}
              </span>
              <b className="num">{fmt(s.byId[d.id]?.total ?? 0)}</b>
            </div>
          ))}
          {s.unclaimed !== 0 && (
            <div className="lline" style={{ padding: "6px 0" }}>
              <span>Still unclaimed</span>
              <b className="num">{fmt(s.unclaimed)}</b>
            </div>
          )}
          <div className="lline big">
            <span>Charged to the card</span>
            <span className="num">{fmt(s.grand)}</span>
          </div>
        </div>
        <div className="hint">
          Everyone&apos;s share adds up to the charge exactly — no rounding left on{" "}
          {bill.payer_name || "whoever paid"}.
        </div>
      </div>

      <div className="bar">
        <div className="barin">
          <div>
            <div className="lbl">You owe {bill.payer_name || "the payer"}</div>
            <div className="val num">{fmt(mine.total)}</div>
          </div>
          <div className="right">
            <div className="lbl">
              {locked ? "Locked" : `${confirmedCount}/${diners.length} confirmed`}
            </div>
            <div className="val num" style={{ color: locked ? "#7FD6BE" : "#F2C572" }}>
              {locked ? "✓" : s.unclaimedCount > 0 ? fmt(s.unclaimed) : "—"}
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}

const Shell = ({ children }) => (
  <div className="page"><div className="wrap">{children}</div></div>
);

/* ==================== version 2: paying back ==================== */

// Clipboard API where there is one; the old select-and-copy trick where
// there isn't. Resolves true if it worked.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const t = document.createElement("textarea");
    t.value = text;
    t.setAttribute("readonly", "");
    t.style.cssText = "position:fixed;opacity:0;";
    document.body.appendChild(t);
    t.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    t.remove();
    return ok;
  }
}

function CopyButton({ text, label = "Copy", className = "btn ghost sm" }) {
  const [state, setState] = useState("");
  const go = async () => {
    setState((await copyText(text)) ? "Copied" : "Press and hold to copy");
    setTimeout(() => setState(""), 1800);
  };
  return <button className={className} onClick={go}>{state || label}</button>;
}

// The receipt's "Download" is the browser's own print dialog, which can
// save a PDF on every phone and computer. The page title becomes the
// suggested file name, so it's set for the moment the dialog is open.
function printReceipt(title) {
  const before = document.title;
  const restore = () => {
    document.title = before;
    window.removeEventListener("afterprint", restore);
  };
  window.addEventListener("afterprint", restore);
  document.title = title;
  window.print();
}

const billDate = (bill) =>
  bill.created_at
    ? new Date(bill.created_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
    : "";

function Tick({ checked, disabled, onChange, children }) {
  return (
    <label className={"tickbox" + (checked ? " on" : "") + (disabled ? " off" : "")}>
      <input
        type="checkbox"
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}

function PayMethods({ bill, payer }) {
  const methods = payMethods(bill);
  const name = payName(bill);
  if (methods.length === 0)
    return (
      <div className="flag amber">
        {payer} didn&apos;t leave a way to pay. Ask them which app they use.
      </div>
    );
  return (
    <div className="ledger">
      {name && (
        <div className="payway">
          <div className="pwl">Name</div>
          <div className="pwv sel">{name}</div>
          <CopyButton text={name} />
        </div>
      )}
      {methods.map((m, i) => {
        const href = asLink(m.value);
        return (
          <div className="payway" key={i}>
            {m.label && <div className="pwl">{m.label}</div>}
            {href ? (
              <a className="pwv" href={href} target="_blank" rel="noopener noreferrer">{m.value}</a>
            ) : (
              <>
                <div className="pwv sel">{m.value}</div>
                <CopyButton text={m.value} />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// One person's items, their share of the extras, and the total. The line
// cents come from computeShares itself, so they add up to the total exactly.
function Lines({ share }) {
  return (
    <>
      {share.lines.length === 0 && (
        <div className="lline"><span>Nothing claimed</span><b className="num">{fmt(0)}</b></div>
      )}
      {share.lines.map(({ item, cents, ways }) => (
        <div className="lline" key={item.id}>
          <span>
            {item.name || "Untitled item"}
            {ways > 1 && <span className="of"> — {ways}-way share of {fmt(item.price_cents)}</span>}
          </span>
          <b className="num">{fmt(cents)}</b>
        </div>
      ))}
      <div className="lline rule">
        <span>Tax, tip and fees, in proportion to what you had</span>
        <b className="num">{fmt(share.extra)}</b>
      </div>
      <div className="lline big">
        <span>Total</span>
        <span className="num">{fmt(share.total)}</span>
      </div>
    </>
  );
}

/* --- a diner who still owes --- */
function PayUp({ bill, s, me, patchDiner, reopen }) {
  const mine = s.byId[me.id];
  const payer = bill.payer_name || "the payer";
  return (
    <Shell>
      <h1>{bill.merchant || "Split the tacos"}</h1>
      <p className="sub">
        Everyone&apos;s confirmed, so the numbers are final. Here&apos;s what you owe {payer}.
      </p>

      <div className="tot done">
        <div className="totline">
          <div className="hint" style={{ marginTop: 0 }}>You owe {payer}</div>
          <CopyButton text={(mine.total / 100).toFixed(2)} label="copy amount" className="mini" />
        </div>
        <div className="big num" style={{ margin: "4px 0 6px" }}>{fmt(mine.total)}</div>
        <div className="brk">
          {fmt(mine.sub)} for what you had, plus {fmt(mine.extra)} of the tax, tip and fees
        </div>
      </div>

      <div className="sec">
        <div className="sechead"><h2>Pay {payer} with</h2></div>
        <PayMethods bill={bill} payer={payer} />
      </div>

      <div className="sentbox">
        <Tick checked={me.sent} onChange={(v) => patchDiner(me.id, { sent: v })}>
          I&apos;ve sent {fmt(mine.total)}
        </Tick>
        <div className="hint">
          {me.sent
            ? `Now ${payer} just has to see it arrive. This page turns into your receipt when they tick it off.`
            : `Tick this once the money's gone, so ${payer} knows to look for it.`}
        </div>
      </div>

      <div className="sec">
        <div className="sechead">
          <h2>What you had</h2>
          <span>{mine.lines.length} {mine.lines.length === 1 ? "item" : "items"}</span>
        </div>
        <div className="ledger"><Lines share={mine} /></div>
      </div>

      <div className="hint" style={{ marginTop: 22 }}>
        <button className="mini" onClick={reopen}>Something&apos;s wrong with the split? Reopen it</button>
      </div>
    </Shell>
  );
}

/* --- a diner the payer has marked received --- */
function Paid({ bill, s, me }) {
  const mine = s.byId[me.id];
  const payer = bill.payer_name || "the payer";
  return (
    <Shell>
      <div className="noprint">
        <h1>You&apos;re paid up</h1>
        <p className="sub">
          {mine.total > 0
            ? `${payer} marked your ${fmt(mine.total)} as received. Nothing left to do.`
            : "Nothing on this bill was yours, so there's nothing to pay."}
        </p>
      </div>

      <div className="receipt">
        <div className="rhead">
          <div className="rmerch">{bill.merchant || "Split the tacos"}</div>
          <div className="rdate">{billDate(bill)}</div>
        </div>
        <div className="rwho">
          {me.name}&apos;s share of a {fmt(s.grand)} bill paid by {payer}
        </div>
        <Lines share={mine} />
        <div className="rstamp">{mine.total > 0 ? `Received by ${payer}` : "Nothing owed"}</div>
      </div>

      <div className="noprint">
        <button
          className="btn"
          style={{ width: "100%", marginTop: 16 }}
          onClick={() => printReceipt(`Receipt - ${bill.merchant || "bill"} - ${me.name}`)}
        >
          Download receipt
        </button>
        <div className="hint" style={{ textAlign: "center" }}>
          Opens the print screen. Choose Save as PDF.
        </div>
      </div>
    </Shell>
  );
}

/* --- the payer, while money is still coming in --- */
function Collecting({ bill, diners, s, me, settled, isCollector, patchDiner, reopen, closeLedger }) {
  const total = (d) => s.byId[d.id]?.total ?? 0;
  const owing = diners.filter((d) => !isCollector(d) && total(d) > 0);
  const nothing = diners.filter((d) => !isCollector(d) && total(d) <= 0);
  const paidBack = owing.filter((d) => d.received);
  const outstanding = owing.filter((d) => !d.received).reduce((a, d) => a + total(d), 0);
  const allIn = diners.every(settled);
  const own = s.byId[me.id]?.total ?? 0;

  return (
    <Shell>
      <h1>{bill.merchant || "Split the tacos"}</h1>
      <p className="sub">
        Everyone&apos;s confirmed. Tick people off as their money lands — once it&apos;s all in,
        this turns into the receipt.
      </p>

      <div className={"tot" + (allIn ? " done" : "")}>
        <div className="hint" style={{ marginTop: 0 }}>Still to come in</div>
        <div className="big num" style={{ margin: "4px 0 6px" }}>{fmt(outstanding)}</div>
        <div className="brk">
          {paidBack.length} of {owing.length} paid back so far. Your own {fmt(own)} is already on
          your card.
        </div>
      </div>

      <div className="sec">
        <div className="sechead">
          <h2>Who owes you</h2>
          <span>Only your phone can tick received</span>
        </div>

        {owing.map((d) => (
          <div className={"payrow" + (d.received ? " in" : "")} key={d.id}>
            <div className="totline">
              <span className="who">
                <span className="chip" style={{ background: d.color }}>{initials(d.name)}</span>
                {d.name}
              </span>
              <b className="num">{fmt(total(d))}</b>
            </div>
            <div className="acts">
              <Tick
                checked={d.sent || d.received}
                disabled={d.received}
                onChange={(v) => patchDiner(d.id, { sent: v })}
              >
                Sent
              </Tick>
              <Tick
                checked={d.received}
                // Received shows sent as ticked too, but doesn't write it, so
                // unticking a mistaken received puts sent back how it was.
                onChange={(v) => patchDiner(d.id, { received: v })}
              >
                Received
              </Tick>
            </div>
          </div>
        ))}

        {nothing.length > 0 && (
          <div className="hint">
            {nothing.map((d) => d.name).join(", ")} had nothing to pay.
          </div>
        )}
      </div>

      {allIn ? (
        <button className="btn" style={{ width: "100%", marginTop: 22 }} onClick={closeLedger}>
          All in — show the receipt
        </button>
      ) : (
        <div className="hint" style={{ marginTop: 22 }}>
          <button className="mini" onClick={reopen}>Something&apos;s wrong with the split? Reopen it</button>
        </div>
      )}
    </Shell>
  );
}

/* --- the payer, once everyone is received --- */
function Collected({ bill, diners, s, me, isCollector, openLedger }) {
  const total = (d) => s.byId[d.id]?.total ?? 0;
  const payer = bill.payer_name || me.name;
  const back = diners.filter((d) => !isCollector(d) && total(d) > 0);
  const collected = back.reduce((a, d) => a + total(d), 0);

  return (
    <Shell>
      <div className="noprint">
        <h1>Everyone&apos;s paid you back</h1>
        <p className="sub">
          {fmt(collected)} from {back.length} {back.length === 1 ? "person" : "people"}. The whole
          bill is below for your records.
        </p>
      </div>

      <div className="receipt">
        <div className="rhead">
          <div className="rmerch">{bill.merchant || "Split the tacos"}</div>
          <div className="rdate">{billDate(bill)}</div>
        </div>
        <div className="rwho">Paid by {payer}, split by what everyone had</div>

        {diners.map((d) => (
          <div className="lline" key={d.id}>
            <span>
              {d.name}
              <span className="of">
                {isCollector(d) ? " — on the card" : total(d) > 0 ? " — received" : " — nothing to pay"}
              </span>
            </span>
            <b className="num">{fmt(total(d))}</b>
          </div>
        ))}

        <div className="lline rule"><span>Items</span><b className="num">{fmt(s.itemsSum)}</b></div>
        <div className="lline"><span>Tax</span><b className="num">{fmt(bill.tax_cents || 0)}</b></div>
        <div className="lline"><span>Tip</span><b className="num">{fmt(bill.tip_cents || 0)}</b></div>
        {bill.fee_cents > 0 && (
          <div className="lline"><span>Card fee</span><b className="num">{fmt(bill.fee_cents)}</b></div>
        )}
        <div className="lline big">
          <span>Charged to the card</span>
          <span className="num">{fmt(s.grand)}</span>
        </div>
        <div className="rstamp">All {fmt(collected)} received</div>
      </div>

      <div className="noprint">
        <button
          className="btn"
          style={{ width: "100%", marginTop: 16 }}
          onClick={() => printReceipt(`Receipt - ${bill.merchant || "bill"}`)}
        >
          Download receipt
        </button>
        <div className="hint" style={{ textAlign: "center" }}>
          Opens the print screen. Choose Save as PDF.{" "}
          <button className="mini" onClick={openLedger}>Ticked someone by mistake?</button>
        </div>
      </div>
    </Shell>
  );
}
