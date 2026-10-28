// Email via the Resend HTTP API (no extra dependency). If RESEND_API_KEY is not set,
// messages are only logged so the rest of the app keeps working.
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function createNotifier(env = process.env) {
  async function send(to, subject, html) {
    if (!to) return;
    if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
      console.log(`[email not configured] to=${to} subject="${subject}"`);
      return;
    }
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, html }),
        signal: AbortSignal.timeout(15_000)
      });
      if (!r.ok) console.error("Email provider error:", r.status);
    } catch (e) { console.error("Email send failed:", e.message); }
  }
  const base = () => (env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
  const link = (id, token) => `${base()}/booking.html#${id}.${token}`;
  const staff = env.STAFF_EMAIL;

  return {
    send,
    requestReceived(b, token) {
      const url = link(b.id, token);
      return Promise.all([
        send(b.email, "We received your HaulHero request",
          `<p>Hi ${esc(b.customer_name)},</p><p>We received your moving request (${esc(b.pickup)} → ${esc(b.delivery)}). Our team will review it and confirm the final price.</p><p>Track it and pay your deposit once approved: <a href="${url}">${url}</a></p><p>Keep this link private.</p>`),
        send(staff, `New HaulHero request: ${b.pickup} → ${b.delivery}`,
          `<p>${esc(b.customer_name)} (${esc(b.email)}) requested a move on ${esc(b.move_date)}.</p><p>Review it in the admin page: ${base()}/admin.html</p>`)
      ]);
    },
    approved(b, token, finalUsd, depositUsd) {
      const url = link(b.id, token);
      return send(b.email, "Your HaulHero move is approved – pay your deposit",
        `<p>Hi ${esc(b.customer_name)},</p><p>Your move is approved. Final price: <b>$${finalUsd}</b>. Deposit due: <b>$${depositUsd}</b>.</p><p><a href="${url}">Pay your deposit securely with PayPal</a></p>`);
    },
    declined(b, reason) {
      return send(b.email, "About your HaulHero request",
        `<p>Hi ${esc(b.customer_name)},</p><p>Unfortunately we can't take this move.${reason ? ` Reason: ${esc(reason)}` : ""}</p><p>You have not been charged.</p>`);
    },
    paid(b, depositUsd) {
      return Promise.all([
        send(b.email, "HaulHero deposit received", `<p>Hi ${esc(b.customer_name)},</p><p>We received your $${depositUsd} deposit. We'll contact you with next steps.</p>`),
        send(staff, `Deposit paid: ${b.pickup} → ${b.delivery}`, `<p>Booking ${esc(b.id)} deposit of $${depositUsd} was paid.</p>`)
      ]);
    },
    needsReview(b, reason) {
      return send(staff, "ACTION NEEDED: payment needs manual review",
        `<p>Booking ${esc(b.id)}: ${esc(reason)}. Check PayPal before doing anything else.</p>`);
    }
  };
}
