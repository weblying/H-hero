import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../lib/db.js";
import { createDepositOrder, captureDeposit, reconcile, sweepStuck, verifyOrder } from "../lib/payments.js";
import { bookingToken, tokenMatches } from "../lib/tokens.js";

// A small in-memory stand-in for PayPal.
function fakePayPal() {
  const orders = new Map(); let n = 0;
  const pp = {
    calls: { create: 0, capture: 0 }, failCapture: null, captureAmount: null, getOrderFails: false,
    async createOrder(payload, requestId) {
      pp.calls.create++;
      for (const o of orders.values()) if (o.requestId === requestId) return o; // idempotent
      const unit = payload.purchase_units[0];
      const o = { id: `ORD${++n}XXXXXXXXXX`, requestId, status: "CREATED", purchase_units: [{ ...unit }] };
      orders.set(o.id, o); return o;
    },
    async getOrder(id) {
      if (pp.getOrderFails) { const e = new Error("net"); e.network = true; throw e; }
      const o = orders.get(id); if (!o) { const e = new Error("nf"); e.status = 404; throw e; } return o;
    },
    async captureOrder(id) {
      pp.calls.capture++;
      if (pp.failCapture) { const e = pp.failCapture; throw e; }
      const o = orders.get(id); const u = o.purchase_units[0];
      o.status = "COMPLETED";
      u.payments = { captures: [{ id: `CAP${id}`, status: "COMPLETED", amount: pp.captureAmount || u.amount }] };
      return o;
    },
    orders
  };
  return pp;
}

function setup() {
  const db = openDb(":memory:");
  const paypal = fakePayPal();
  const sent = [];
  const notify = { paid: async () => sent.push("paid"), needsReview: async () => sent.push("review") };
  const id = "11111111-2222-3333-4444-555555555555";
  db.prepare(`INSERT INTO bookings (id,customer_name,email,pickup,delivery,move_date,miles,weight_lb,load_size,estimate_cents,final_price_cents,deposit_cents,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'AWAITING_DEPOSIT')`).run(id, "A", "a@b.co", "LA", "PHX", "2030-01-01", 370, 5000, "standard", 100000, 100700, 20140);
  return { ctx: { db, paypal, notify }, db, paypal, sent, id };
}
const status = (db, id) => db.prepare("SELECT status FROM bookings WHERE id=?").get(id).status;

test("happy path: order then capture marks deposit paid", async () => {
  const { ctx, db, paypal, id, sent } = setup();
  const o = await createDepositOrder(ctx, id);
  assert.equal(o.depositUsd, "201.40");
  const r = await captureDeposit(ctx, id, o.orderID);
  assert.equal(r.state, "paid");
  assert.equal(status(db, id), "DEPOSIT_PAID");
  assert.equal(paypal.calls.capture, 1);
  assert.deepEqual(sent, ["paid"]);
});

test("order creation is reused while valid, and idempotent under a double click", async () => {
  const { ctx, id } = setup();
  const [a, b] = await Promise.all([createDepositOrder(ctx, id), createDepositOrder(ctx, id)]);
  assert.equal(a.orderID, b.orderID);
  const again = await createDepositOrder(ctx, id);
  assert.equal(again.orderID, a.orderID);
});

test("expired/voided order is replaced instead of leaving the booking stuck", async () => {
  const { ctx, id, paypal } = setup();
  const first = await createDepositOrder(ctx, id);
  paypal.orders.get(first.orderID).status = "VOIDED";
  const second = await createDepositOrder(ctx, id);
  assert.notEqual(second.orderID, first.orderID);
});

test("concurrent capture calls only capture once", async () => {
  const { ctx, db, paypal, id } = setup();
  const o = await createDepositOrder(ctx, id);
  const [x, y] = await Promise.all([captureDeposit(ctx, id, o.orderID), captureDeposit(ctx, id, o.orderID)]);
  assert.equal(paypal.calls.capture, 1);
  assert.ok([x.state, y.state].includes("paid"));
  assert.equal(status(db, id), "DEPOSIT_PAID");
});

test("wrong amount from PayPal goes to PAYMENT_REVIEW and alerts staff", async () => {
  const { ctx, db, paypal, id, sent } = setup();
  const o = await createDepositOrder(ctx, id);
  paypal.captureAmount = { currency_code: "USD", value: "1.00" };
  const r = await captureDeposit(ctx, id, o.orderID);
  assert.equal(r.state, "review");
  assert.equal(status(db, id), "PAYMENT_REVIEW");
  assert.deepEqual(sent, ["review"]);
});

test("wrong currency is rejected", async () => {
  const { ctx, db, paypal, id } = setup();
  const o = await createDepositOrder(ctx, id);
  paypal.captureAmount = { currency_code: "EUR", value: "201.40" };
  assert.equal((await captureDeposit(ctx, id, o.orderID)).state, "review");
  assert.equal(status(db, id), "PAYMENT_REVIEW");
});

test("decline lets the customer retry", async () => {
  const { ctx, db, paypal, id } = setup();
  const o = await createDepositOrder(ctx, id);
  const err = new Error("declined"); err.status = 422; err.issue = "INSTRUMENT_DECLINED";
  paypal.failCapture = err;
  assert.equal((await captureDeposit(ctx, id, o.orderID)).state, "declined");
  assert.equal(status(db, id), "AWAITING_DEPOSIT");
  paypal.failCapture = null;
  assert.equal((await captureDeposit(ctx, id, o.orderID)).state, "paid");
});

test("timeout after PayPal actually captured is still recorded as paid", async () => {
  const { ctx, db, paypal, id } = setup();
  const o = await createDepositOrder(ctx, id);
  const realCapture = paypal.captureOrder;
  paypal.captureOrder = async (oid, rid) => { await realCapture(oid, rid); const e = new Error("timeout"); e.network = true; throw e; };
  assert.equal((await captureDeposit(ctx, id, o.orderID)).state, "paid");
  assert.equal(status(db, id), "DEPOSIT_PAID");
});

test("unknown outcome stays PROCESSING and the sweeper settles it later", async () => {
  const { ctx, db, paypal, id } = setup();
  const o = await createDepositOrder(ctx, id);
  const realCapture = paypal.captureOrder;
  paypal.captureOrder = async (oid, rid) => { await realCapture(oid, rid); const e = new Error("timeout"); e.network = true; throw e; };
  paypal.getOrderFails = true;
  assert.equal((await captureDeposit(ctx, id, o.orderID)).state, "processing");
  assert.equal(status(db, id), "PAYMENT_PROCESSING");
  paypal.getOrderFails = false;
  db.prepare("UPDATE bookings SET processing_since='2000-01-01T00:00:00Z' WHERE id=?").run(id);
  await sweepStuck(ctx);
  assert.equal(status(db, id), "DEPOSIT_PAID");
});

test("cannot create an order for a booking that is not approved", async () => {
  const { ctx, db, id } = setup();
  db.prepare("UPDATE bookings SET status='PENDING_REVIEW' WHERE id=?").run(id);
  assert.equal((await createDepositOrder(ctx, id)).error, "not_payable");
});

test("capture with a different order id is refused", async () => {
  const { ctx, id } = setup();
  await createDepositOrder(ctx, id);
  assert.equal((await captureDeposit(ctx, id, "SOMETHINGELSE")).state, "invalid");
});

test("verifyOrder checks booking reference", () => {
  const row = { id: "x", paypal_order_id: "O1", deposit_cents: 500 };
  const order = { id: "O1", status: "COMPLETED", purchase_units: [{ custom_id: "other", payments: { captures: [{ status: "COMPLETED", amount: { currency_code: "USD", value: "5.00" } }] } }] };
  assert.equal(verifyOrder(order, row).ok, false);
  order.purchase_units[0].custom_id = "x";
  assert.equal(verifyOrder(order, row).ok, true);
});

test("customer link tokens are bound to the booking id", () => {
  const t = bookingToken("s".repeat(32), "abc");
  assert.ok(tokenMatches("s".repeat(32), "abc", t));
  assert.ok(!tokenMatches("s".repeat(32), "abd", t));
  assert.ok(!tokenMatches("s".repeat(32), "abc", "nope"));
  assert.ok(!tokenMatches("s".repeat(32), "abc", undefined));
});
