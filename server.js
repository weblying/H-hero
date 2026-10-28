import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, logEvent } from "./lib/db.js";
import { getLinkSecret, bookingToken, tokenMatches } from "./lib/tokens.js";
import { createPayPalClient } from "./lib/paypal.js";
import { createNotifier } from "./lib/notify.js";
import { centsToDollars, createDepositOrder, captureDeposit, reconcile, sweepStuck } from "./lib/payments.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const db = openDb(process.env.DB_PATH || path.join(__dirname, "haulhero.sqlite"));
const linkSecret = getLinkSecret(db);
const paypal = createPayPalClient();
const notify = createNotifier();
const ctx = { db, paypal, notify };

const BASE_FEE = Number(process.env.BASE_FEE_USD || 125);
const RATE_MILE = Number(process.env.RATE_PER_MILE_USD || 2.15);
const RATE_POUND = Number(process.env.RATE_PER_POUND_USD || 0.035);
const DEPOSIT_PERCENT = Math.min(50, Math.max(1, Number(process.env.DEPOSIT_PERCENT || 20)));
const multipliers = { small: 0.85, standard: 1, large: 1.2 };

// Behind a proxy/load balancer (Render, Fly, Railway, nginx...) set TRUST_PROXY=1 so rate limits use real client IPs.
if (process.env.TRUST_PROXY) app.set("trust proxy", /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
app.disable("x-powered-by");

const paypalHosts = ["https://www.paypal.com", "https://*.paypal.com", "https://*.paypalobjects.com"];
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "script-src": ["'self'", ...paypalHosts],
      "frame-src": ["'self'", ...paypalHosts],
      "connect-src": ["'self'", ...paypalHosts],
      "img-src": ["'self'", "data:", ...paypalHosts],
      "form-action": ["'self'"]
    }
  }
}));
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

const limiter = (windowMs, limit, extra = {}) => rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests. Please try again later." }, ...extra });
app.use("/api/", limiter(15 * 60 * 1000, 200));
const createLimiter = limiter(60 * 60 * 1000, 10);
const customerLimiter = limiter(15 * 60 * 1000, 60);
// Only wrong-token attempts (401) count toward the lockout, not ordinary staff errors.
const adminFailLimiter = limiter(15 * 60 * 1000, 10, { skipSuccessfulRequests: true, requestWasSuccessful: (_req, res) => res.statusCode !== 401 });

// ---------- helpers ----------
const dollarsToCents = (n) => Math.round(n * 100);
const validText = (v, max = 160) => typeof v === "string" && v.trim().length > 0 && v.trim().length <= max;
const laToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const isRealDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;
const getBooking = (id) => db.prepare("SELECT * FROM bookings WHERE id=?").get(id);

function customerView(row) {
  return {
    id: row.id, customerName: row.customer_name, pickup: row.pickup, delivery: row.delivery, moveDate: row.move_date,
    miles: row.miles, weightLb: row.weight_lb, loadSize: row.load_size,
    estimateUsd: centsToDollars(row.estimate_cents),
    finalPriceUsd: row.final_price_cents == null ? null : centsToDollars(row.final_price_cents),
    depositUsd: row.deposit_cents == null ? null : centsToDollars(row.deposit_cents),
    balanceUsd: row.final_price_cents == null || row.deposit_cents == null ? null : centsToDollars(row.final_price_cents - row.deposit_cents),
    status: row.status, declineReason: row.decline_reason || null, createdAt: row.created_at, paidAt: row.paid_at || null
  };
}
function adminView(row) {
  return { ...customerView(row), email: row.email, phone: row.phone, notes: row.notes, paypalOrderId: row.paypal_order_id, paypalCaptureId: row.paypal_capture_id,
    customerPath: `/booking.html#${row.id}.${bookingToken(linkSecret, row.id)}` };
}

function adminOnly(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || expected.length < 24) return res.status(503).json({ error: "Admin access is not configured securely." });
  const supplied = req.get("x-admin-token") || "";
  const a = crypto.createHash("sha256").update(supplied).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Unauthorized." });
  next();
}

// Loads the booking named in the URL and checks the private link token sent by the customer's browser.
function customerBooking(req, res, next) {
  const row = getBooking(req.params.id);
  const token = req.get("x-booking-token");
  if (!row || !tokenMatches(linkSecret, row.id, token)) return res.status(404).json({ error: "Booking not found." });
  req.booking = row;
  next();
}

// ---------- public ----------
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "HaulHero API" }));

app.get("/api/config", (_req, res) => res.json({
  paypalClientId: process.env.PAYPAL_CLIENT_ID || null,
  paypalEnv: process.env.PAYPAL_ENV === "live" ? "live" : "sandbox",
  depositPercent: DEPOSIT_PERCENT,
  pricing: { baseFee: BASE_FEE, perMile: RATE_MILE, perPound: RATE_POUND, multipliers },
  contact: { email: process.env.CONTACT_EMAIL || null, phone: process.env.CONTACT_PHONE || null, legalLine: process.env.LEGAL_LINE || null }
}));

app.post("/api/bookings", createLimiter, (req, res) => {
  const b = req.body || {};
  if (b.website) return res.status(201).json({ booking: { id: "ignored", estimateUsd: "0.00", status: "PENDING_REVIEW" }, message: "Request received." }); // honeypot
  if (!validText(b.customerName, 120) || !validText(b.email, 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email.trim()) ||
      !validText(b.pickup, 160) || !validText(b.delivery, 160) || typeof b.moveDate !== "string" || !isRealDate(b.moveDate)) {
    return res.status(400).json({ error: "Please provide a valid name, email, pickup, delivery and moving date." });
  }
  const miles = Number(b.miles), weight = Number(b.weightLb);
  if (!Number.isInteger(miles) || miles < 1 || miles > 10000 || !Number.isInteger(weight) || weight < 1 || weight > 80000) {
    return res.status(400).json({ error: "Distance must be 1–10,000 miles and weight 1–80,000 lb." });
  }
  const today = laToday();
  if (b.moveDate < today) return res.status(400).json({ error: "Moving date cannot be in the past." });
  if (b.moveDate > addDays(today, 730)) return res.status(400).json({ error: "Moving date is too far in the future." });
  const loadSize = Object.hasOwn(multipliers, b.loadSize) ? b.loadSize : "standard";
  const estimate = dollarsToCents((BASE_FEE + miles * RATE_MILE + weight * RATE_POUND) * multipliers[loadSize]);
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO bookings
    (id, customer_name, email, phone, pickup, delivery, move_date, miles, weight_lb, load_size, notes, estimate_cents, status, updated_at)
    VALUES (@id,@customer_name,@email,@phone,@pickup,@delivery,@move_date,@miles,@weight_lb,@load_size,@notes,@estimate_cents,'PENDING_REVIEW',strftime('%Y-%m-%dT%H:%M:%SZ','now'))`).run({
    id, customer_name: b.customerName.trim(), email: b.email.trim().toLowerCase(),
    phone: typeof b.phone === "string" ? b.phone.trim().slice(0, 40) : "",
    pickup: b.pickup.trim(), delivery: b.delivery.trim(), move_date: b.moveDate,
    miles, weight_lb: weight, load_size: loadSize,
    notes: typeof b.notes === "string" ? b.notes.trim().slice(0, 1500) : "",
    estimate_cents: estimate
  });
  logEvent(db, id, "created", "");
  const token = bookingToken(linkSecret, id);
  notify.requestReceived(getBooking(id), token).catch(() => {});
  res.status(201).json({
    booking: { id, estimateUsd: centsToDollars(estimate), status: "PENDING_REVIEW" },
    statusPath: `/booking.html#${id}.${token}`,
    message: "Request received. This is an estimate, not a confirmed booking. The company will review availability and confirm the final price."
  });
});

app.get("/api/bookings/:id", customerLimiter, customerBooking, (req, res) => res.json({ booking: customerView(req.booking) }));

app.post("/api/bookings/:id/paypal-order", customerLimiter, customerBooking, async (req, res) => {
  try {
    const result = await createDepositOrder(ctx, req.booking.id);
    if (result.error === "already_paid") return res.status(409).json({ error: "This deposit has already been paid." });
    if (result.error) return res.status(409).json({ error: "This booking is not approved for deposit payment." });
    res.json(result);
  } catch (err) {
    console.error("paypal-order:", err.message);
    res.status(502).json({ error: "Unable to start PayPal checkout. Please try again in a moment." });
  }
});

app.post("/api/bookings/:id/paypal-capture", customerLimiter, customerBooking, async (req, res) => {
  try {
    const orderID = req.body?.orderID;
    if (typeof orderID !== "string" || orderID !== req.booking.paypal_order_id) {
      return res.status(400).json({ error: "PayPal order does not match this booking." });
    }
    const { state } = await captureDeposit(ctx, req.booking.id, orderID);
    const booking = customerView(getBooking(req.booking.id));
    const messages = {
      paid: "Deposit received. We'll contact you with the next steps.",
      processing: "Your payment is being confirmed. Please do not pay again; this page will update shortly.",
      declined: "PayPal could not complete the payment. You have not been charged. Please try again or use another payment method.",
      review: "Your payment went through but needs a quick manual check by our team. Do not pay again. We'll email you.",
      invalid: "This booking can't accept a payment right now."
    };
    const code = { paid: 200, processing: 202, declined: 402, review: 200, invalid: 409 }[state] || 200;
    res.status(code).json({ state, booking, message: messages[state] });
  } catch (err) {
    console.error("paypal-capture:", err.message);
    res.status(502).json({ error: "We couldn't confirm your payment. Do not pay again; if you were charged, contact us and quote your booking reference." });
  }
});

// PayPal webhook: safety net that settles payments if the customer's browser closed mid-checkout.
app.post("/api/paypal/webhook", async (req, res) => {
  try {
    if (!process.env.PAYPAL_WEBHOOK_ID) return res.status(503).end();
    const ok = await paypal.verifyWebhook(req.headers, req.body);
    if (!ok) return res.status(400).end();
    const ev = req.body;
    if (ev.event_type === "PAYMENT.CAPTURE.COMPLETED") {
      const orderId = ev.resource?.supplementary_data?.related_ids?.order_id;
      const row = (orderId && db.prepare("SELECT id FROM bookings WHERE paypal_order_id=?").get(orderId)) ||
                  (ev.resource?.custom_id && getBooking(ev.resource.custom_id));
      if (row) await reconcile(ctx, row.id);
    }
    res.status(200).end();
  } catch (err) {
    console.error("webhook:", err.message);
    res.status(500).end();
  }
});

// ---------- staff ----------
app.use("/api/admin", adminFailLimiter, adminOnly);

app.get("/api/admin/bookings", (_req, res) => {
  const rows = db.prepare("SELECT * FROM bookings ORDER BY created_at DESC LIMIT 300").all();
  res.json({ bookings: rows.map(adminView), depositPercent: DEPOSIT_PERCENT });
});

app.get("/api/admin/bookings/:id/events", (req, res) => {
  res.json({ events: db.prepare("SELECT type, detail, at FROM events WHERE booking_id=? ORDER BY id").all(req.params.id) });
});

app.post("/api/admin/bookings/:id/approve", (req, res) => {
  const finalPrice = Number(req.body?.finalPriceUsd);
  if (!Number.isFinite(finalPrice) || finalPrice < 10 || finalPrice > 1000000) return res.status(400).json({ error: "Provide a valid final price (USD)." });
  const finalCents = dollarsToCents(finalPrice);
  const depositCents = Math.max(100, Math.round(finalCents * DEPOSIT_PERCENT / 100));
  const r = db.prepare(`UPDATE bookings SET final_price_cents=?, deposit_cents=?, status='AWAITING_DEPOSIT', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE id=? AND status='PENDING_REVIEW'`).run(finalCents, depositCents, req.params.id);
  if (!r.changes) return res.status(getBooking(req.params.id) ? 409 : 404).json({ error: "Only pending requests can be approved." });
  logEvent(db, req.params.id, "approved", `final=${centsToDollars(finalCents)} deposit=${centsToDollars(depositCents)}`);
  const row = getBooking(req.params.id);
  notify.approved(row, bookingToken(linkSecret, row.id), centsToDollars(finalCents), centsToDollars(depositCents)).catch(() => {});
  res.json({ booking: adminView(row), depositPercent: DEPOSIT_PERCENT });
});

app.post("/api/admin/bookings/:id/decline", (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 300) : "";
  const r = db.prepare(`UPDATE bookings SET status='DECLINED', decline_reason=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE id=? AND status='PENDING_REVIEW'`).run(reason, req.params.id);
  if (!r.changes) return res.status(getBooking(req.params.id) ? 409 : 404).json({ error: "Only pending requests can be declined." });
  logEvent(db, req.params.id, "declined", reason);
  notify.declined(getBooking(req.params.id), reason).catch(() => {});
  res.json({ booking: adminView(getBooking(req.params.id)) });
});

// Re-check a payment with PayPal (use for PAYMENT_PROCESSING / PAYMENT_REVIEW bookings).
app.post("/api/admin/bookings/:id/reconcile", async (req, res) => {
  try {
    const row = getBooking(req.params.id);
    if (!row) return res.status(404).json({ error: "Booking not found." });
    await reconcile(ctx, row.id);
    res.json({ booking: adminView(getBooking(row.id)) });
  } catch (err) {
    console.error("reconcile:", err.message);
    res.status(502).json({ error: "Could not reach PayPal." });
  }
});

app.use((err, _req, res, _next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid request body." });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Request too large." });
  console.error("Unhandled request error:", err.message);
  res.status(500).json({ error: "Unexpected server error." });
});

setInterval(() => sweepStuck(ctx).catch((e) => console.error("sweep:", e.message)), 60_000).unref();
app.listen(port, () => console.log(`HaulHero running on http://localhost:${port} (PayPal ${process.env.PAYPAL_ENV === "live" ? "LIVE" : "sandbox"})`));
