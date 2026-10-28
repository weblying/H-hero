import { logEvent } from "./db.js";

export const centsToDollars = (c) => (c / 100).toFixed(2);
const toCents = (v) => Math.round(Number.parseFloat(v) * 100);
const REUSABLE_ORDER = new Set(["CREATED", "APPROVED", "PAYER_ACTION_REQUIRED", "SAVED"]);
const get = (db, id) => db.prepare("SELECT * FROM bookings WHERE id=?").get(id);
const now = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

// Check a PayPal order against what we expect to be paid for this booking.
export function verifyOrder(order, row) {
  const unit = order?.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  if (!order || !unit || !capture) return { ok: false, pending: false, reason: "No capture found on order." };
  if (order.id !== row.paypal_order_id) return { ok: false, reason: "Order id does not match booking." };
  const ref = unit.custom_id || unit.reference_id;
  if (ref !== row.id) return { ok: false, reason: "Booking reference mismatch." };
  if (capture.amount?.currency_code !== "USD") return { ok: false, reason: "Currency mismatch." };
  if (toCents(capture.amount?.value) !== row.deposit_cents) return { ok: false, reason: "Amount mismatch." };
  if (capture.status === "PENDING") return { ok: false, pending: true, capture, reason: "Capture is pending at PayPal." };
  if (order.status !== "COMPLETED" || capture.status !== "COMPLETED") return { ok: false, reason: `Unexpected status ${order.status}/${capture.status}.` };
  return { ok: true, capture };
}

export async function createDepositOrder(ctx, id) {
  const { db, paypal } = ctx;
  let row = get(db, id);
  if (!row || row.status !== "AWAITING_DEPOSIT" || !row.deposit_cents) return { error: "not_payable" };

  if (row.paypal_order_id) {
    let existing = null;
    try { existing = await paypal.getOrder(row.paypal_order_id); }
    catch (e) { if (e.network || e.status !== 404) throw e; }
    if (existing && REUSABLE_ORDER.has(existing.status)) {
      return { orderID: row.paypal_order_id, depositUsd: centsToDollars(row.deposit_cents) };
    }
    if (existing?.status === "COMPLETED") {
      await reconcile(ctx, id);
      return { error: "already_paid" };
    }
    // Expired, voided or missing: retire it and start a fresh order for this booking.
    db.prepare("UPDATE bookings SET order_attempt=order_attempt+1, paypal_order_id=NULL WHERE id=? AND paypal_order_id=?").run(id, row.paypal_order_id);
    logEvent(db, id, "order_replaced", existing?.status || "not found");
    row = get(db, id);
  }

  const order = await paypal.createOrder({
    intent: "CAPTURE",
    purchase_units: [{
      reference_id: row.id,
      custom_id: row.id,
      description: `HaulHero moving deposit (booking ${row.id.slice(0, 8)})`,
      amount: { currency_code: "USD", value: centsToDollars(row.deposit_cents) }
    }],
    application_context: { brand_name: "HaulHero", user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" }
  }, `hh-order-${row.id}-${row.order_attempt}`);

  const saved = db.prepare("UPDATE bookings SET paypal_order_id=? WHERE id=? AND paypal_order_id IS NULL").run(order.id, id);
  if (saved.changes === 0) row = get(db, id); // a concurrent request won; same idempotent order id
  else logEvent(db, id, "order_created", order.id);
  return { orderID: saved.changes === 0 ? row.paypal_order_id : order.id, depositUsd: centsToDollars(row.deposit_cents) };
}

async function markPaid(ctx, row, capture) {
  const { db, notify } = ctx;
  const r = db.prepare(`UPDATE bookings SET status='DEPOSIT_PAID', paypal_capture_id=?, paid_at=${now}, updated_at=${now}
    WHERE id=? AND status IN ('PAYMENT_PROCESSING','AWAITING_DEPOSIT','PAYMENT_REVIEW')`).run(capture.id, row.id);
  if (r.changes) {
    logEvent(db, row.id, "deposit_paid", capture.id);
    notify?.paid(row, centsToDollars(row.deposit_cents)).catch(() => {});
  }
}

// Turn a PayPal order (after capture or on reconcile) into our booking state.
async function finalize(ctx, id, order) {
  const { db, notify } = ctx;
  const row = get(db, id);
  const v = verifyOrder(order, row);
  if (v.ok) { await markPaid(ctx, row, v.capture); return "paid"; }
  if (v.pending) { logEvent(db, id, "capture_pending", v.capture?.id); return "processing"; }
  // Money may have moved but it does not match what we expected: a human must look.
  const cap = order?.purchase_units?.[0]?.payments?.captures?.[0];
  db.prepare(`UPDATE bookings SET status='PAYMENT_REVIEW', paypal_capture_id=COALESCE(?,paypal_capture_id), updated_at=${now} WHERE id=? AND status!='DEPOSIT_PAID'`).run(cap?.id || null, id);
  logEvent(db, id, "payment_review", v.reason);
  console.error("Payment needs review for booking", id, v.reason);
  notify?.needsReview(row, v.reason).catch(() => {});
  return "review";
}

export async function captureDeposit(ctx, id, orderID) {
  const { db, paypal } = ctx;
  const claim = db.prepare(`UPDATE bookings SET status='PAYMENT_PROCESSING', processing_since=${now}, updated_at=${now}
    WHERE id=? AND status='AWAITING_DEPOSIT' AND paypal_order_id=?`).run(id, orderID);
  if (claim.changes === 0) {
    const row = get(db, id);
    if (row?.status === "DEPOSIT_PAID") return { state: "paid" };
    if (row?.status === "PAYMENT_PROCESSING" && row.paypal_order_id === orderID) return { state: "processing" };
    return { state: "invalid" };
  }
  let order;
  try {
    order = await paypal.captureOrder(orderID, `hh-capture-${orderID}`);
  } catch (e) {
    // Unknown outcome (timeout) or a decline. Ask PayPal what really happened.
    try {
      const current = await paypal.getOrder(orderID);
      if (current.status === "COMPLETED") return { state: await finalize(ctx, id, current) };
      db.prepare(`UPDATE bookings SET status='AWAITING_DEPOSIT', updated_at=${now} WHERE id=? AND status='PAYMENT_PROCESSING'`).run(id);
      logEvent(db, id, "capture_failed", e.issue || e.paypalName || e.message);
      return { state: "declined" };
    } catch {
      logEvent(db, id, "capture_unknown", e.message);
      return { state: "processing" }; // left in PAYMENT_PROCESSING; sweeper/webhook will settle it
    }
  }
  return { state: await finalize(ctx, id, order) };
}

// Settle a booking whose payment outcome we are unsure about.
export async function reconcile(ctx, id) {
  const { db, paypal } = ctx;
  const row = get(db, id);
  if (!row || !row.paypal_order_id || !["AWAITING_DEPOSIT", "PAYMENT_PROCESSING"].includes(row.status)) return row?.status;
  const order = await paypal.getOrder(row.paypal_order_id);
  if (order.status === "COMPLETED") return finalize(ctx, id, order);
  if (row.status === "PAYMENT_PROCESSING") {
    db.prepare(`UPDATE bookings SET status='AWAITING_DEPOSIT', updated_at=${now} WHERE id=? AND status='PAYMENT_PROCESSING'`).run(id);
    logEvent(db, id, "processing_reverted", order.status);
  }
  return "awaiting";
}

export async function sweepStuck(ctx, olderThanMinutes = 2) {
  const rows = ctx.db.prepare(`SELECT id FROM bookings WHERE status='PAYMENT_PROCESSING'
    AND processing_since <= strftime('%Y-%m-%dT%H:%M:%SZ','now', ?)`).all(`-${olderThanMinutes} minutes`);
  for (const { id } of rows) {
    try { await reconcile(ctx, id); } catch (e) { console.error("Reconcile failed for", id, e.message); }
  }
  return rows.length;
}
