# HaulHero (v0.4)

Booking requests → staff approval → PayPal deposit, as a small Node.js + SQLite app.

## Run it locally
1. Node.js 20+ (22 recommended). `npm install`
2. `cp .env.example .env` and set `ADMIN_TOKEN` (24+ random characters).
3. Add your **sandbox** PayPal Client ID/Secret (developer.paypal.com → Apps & Credentials).
4. `npm start` → http://localhost:3000 (customers) and http://localhost:3000/admin.html (staff).
5. `npm test` runs the payment-logic tests.

## How it works
1. Customer submits the form → stored as `PENDING_REVIEW`. They get a private link `/booking.html#<id>.<token>` (shown on screen, and emailed if email is configured).
2. Staff open `/admin.html`, sign in with `ADMIN_TOKEN`, and **Approve** (enter the final price) or **Decline**. Approval creates the deposit (default 20%, `DEPOSIT_PERCENT`) and emails the customer.
3. The customer opens their link and pays the deposit with PayPal Buttons. The server creates the order, captures it, and only marks the booking `DEPOSIT_PAID` after checking status, amount, currency and booking reference.
4. Anything odd (amount mismatch, unknown outcome) goes to `PAYMENT_REVIEW` / `PAYMENT_PROCESSING`; staff are alerted and can click **Re-check payment with PayPal**.

Statuses: `PENDING_REVIEW → AWAITING_DEPOSIT → PAYMENT_PROCESSING → DEPOSIT_PAID`, plus `DECLINED` and `PAYMENT_REVIEW`.

## The website
- `public/index.html` + `site.css` + `app.js`: one-page site (estimator, how it works, pricing, FAQ, request form). Rates, deposit % and contact details are read from `/api/config`, so changing `.env` changes the site and the backend together.
- Set `CONTACT_EMAIL`, `CONTACT_PHONE` and `LEGAL_LINE` in `.env` to show your contact details and registration numbers in the footer. Leave them blank to hide them.
- The text on the site (FAQ answers, "how it works") describes what the software does today. If you change policy (for example balance payments or cancellations), update the wording in `index.html` too.

## Going live checklist
- **Hosting:** needs a Node host with a *persistent disk* for SQLite (set `DB_PATH` to it), not a serverless platform. Set `BASE_URL` to your https URL and `TRUST_PROXY=1` behind a proxy.
- **PayPal:** test the whole flow in sandbox first (sandbox buyer account), then switch `PAYPAL_ENV=live` with live credentials. Add a webhook to `BASE_URL/api/paypal/webhook` for `PAYMENT.CAPTURE.COMPLETED` and put its ID in `PAYPAL_WEBHOOK_ID`.
- **Email:** set `RESEND_API_KEY`, `MAIL_FROM` (verified domain) and `STAFF_EMAIL`. Without them, emails are only logged and customers rely on the on-screen link.
- **Backups:** back up the SQLite file (and its `-wal`/`-shm` files) regularly.
- **Business/legal (yours to confirm):** pricing, deposit terms, refund/cancellation policy, privacy policy and terms pages, and all California/FMCSA mover registration, authority and insurance requirements before advertising or taking deposits.

## Known limits (next steps)
- Staff login is one shared token (rate-limited, kept in the browser tab only). Move to individual staff accounts when more than one or two people use it.
- No refund tool yet: issue refunds in PayPal and note them manually.
- Distance is customer-entered; add a routing API later.
- Not yet covered: automated tests for the HTTP routes, and a load/security test.

## Files
`server.js` routes · `lib/payments.js` payment state machine · `lib/paypal.js` PayPal API client · `lib/notify.js` emails · `lib/db.js` schema + migration · `lib/tokens.js` private booking links · `public/` pages (`index`, `booking`, `admin`) · `test/` tests
