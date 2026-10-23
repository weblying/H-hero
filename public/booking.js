const view = document.querySelector("#view");
const [bookingId, token] = (() => {
  const h = location.hash.slice(1); const i = h.lastIndexOf(".");
  return i > 0 ? [h.slice(0, i), h.slice(i + 1)] : [null, null];
})();

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === "class") n.className = v; else n[k] = v; }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
}
const usd = (v) => `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const api = async (path, opts = {}) => {
  const r = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}${path}`, {
    ...opts, headers: { "x-booking-token": token, "Content-Type": "application/json" }
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
};

let current = null, poll = null, paypalMounted = false;

function summary(b) {
  const rows = [["Route", `${b.pickup} → ${b.delivery}`], ["Moving date", b.moveDate], ["Distance / weight", `${b.miles.toLocaleString()} mi · ${b.weightLb.toLocaleString()} lb`], ["Reference", b.id]];
  return el("dl", { class: "facts" }, rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
}
const banner = (cls, title, text) => el("div", { class: `banner ${cls}` }, el("b", {}, title), el("p", {}, text));

function render(b) {
  const same = current && current.status === b.status && current.finalPriceUsd === b.finalPriceUsd;
  current = b;
  if (same && b.status === "AWAITING_DEPOSIT") return; // don't rebuild the PayPal buttons
  clearInterval(poll); paypalMounted = false;
  view.replaceChildren(el("h1", { class: "page-title" }, `Hi ${b.customerName.split(" ")[0]}, here's your move`), summary(b));
  switch (b.status) {
    case "PENDING_REVIEW":
      view.append(banner("info", "Under review", `Planning estimate: ${usd(b.estimateUsd)}. Our team is checking availability and will confirm your final price. You'll get an email when it's ready, and this page will update on its own.`));
      poll = setInterval(refresh, 20000); break;
    case "AWAITING_DEPOSIT": {
      view.append(
        banner("ok", "Approved", "Your move is approved. Pay the deposit to lock in your date."),
        el("dl", { class: "facts price" },
          el("dt", {}, "Final price"), el("dd", {}, usd(b.finalPriceUsd)),
          el("dt", {}, "Deposit due now"), el("dd", { class: "big" }, usd(b.depositUsd)),
          el("dt", {}, "Balance after deposit"), el("dd", {}, usd(b.balanceUsd))),
        el("div", { id: "paypal-area" }, el("p", { class: "muted" }, "Loading secure checkout…")),
        el("p", { class: "fine left" }, "Payments are processed by PayPal. You can pay with PayPal or a card. We never see your card details."));
      mountPayPal(); break;
    }
    case "PAYMENT_PROCESSING":
      view.append(banner("info", "Confirming your payment", "This usually takes a few seconds. Please don't pay again."));
      poll = setInterval(refresh, 5000); break;
    case "PAYMENT_REVIEW":
      view.append(banner("warn", "Payment received — quick check needed", "Your payment went through, but our team needs to verify it manually. Don't pay again; we'll email you shortly."));
      break;
    case "DEPOSIT_PAID":
      view.append(banner("ok", "Deposit received", `Thank you! Your ${usd(b.depositUsd)} deposit is paid and your move is booked. We'll contact you with the next steps. Remaining balance: ${usd(b.balanceUsd)}.`));
      break;
    case "DECLINED":
      view.append(banner("warn", "We can't take this move", `${b.declineReason ? b.declineReason + " " : ""}You have not been charged.`));
      break;
    default:
      view.append(banner("info", "Status", b.status));
  }
}

async function refresh() {
  const { ok, data } = await api("");
  if (ok) render(data.booking);
}

function loadSdk(clientId) {
  return new Promise((resolve, reject) => {
    if (window.paypal) return resolve();
    const s = el("script", { src: `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture&components=buttons`, async: true });
    s.onload = resolve; s.onerror = () => reject(new Error("Could not load PayPal."));
    document.head.append(s);
  });
}

async function mountPayPal() {
  if (paypalMounted) return; paypalMounted = true;
  const area = document.querySelector("#paypal-area");
  const note = (t, cls = "muted") => area.replaceChildren(el("p", { class: cls }, t));
  try {
    const cfg = await (await fetch("/api/config")).json();
    if (!cfg.paypalClientId) return note("Online payment isn't switched on yet. Our team will contact you to arrange your deposit.");
    await loadSdk(cfg.paypalClientId);
    area.replaceChildren();
    window.paypal.Buttons({
      style: { layout: "vertical", shape: "rect", label: "pay" },
      createOrder: async () => {
        const { ok, data } = await api("/paypal-order", { method: "POST", body: "{}" });
        if (!ok) throw new Error(data.error || "Could not start checkout.");
        return data.orderID;
      },
      onApprove: async (d) => {
        note("Confirming your payment… please don't close this page.");
        const { data } = await api("/paypal-capture", { method: "POST", body: JSON.stringify({ orderID: d.orderID }) });
        if (data.booking) { current = null; render(data.booking); }
        if (data.message) view.prepend(el("div", { class: `banner ${data.state === "paid" ? "ok" : "warn"}` }, data.message));
        if (data.state === "declined") { current = null; refresh(); }
      },
      onCancel: () => view.prepend(el("div", { class: "banner info" }, "Checkout cancelled. You have not been charged.")),
      onError: (e) => { console.error(e); view.prepend(el("div", { class: "banner warn" }, e.message || "Something went wrong with PayPal. You have not been charged. Please try again.")); }
    }).render("#paypal-area");
  } catch (e) {
    paypalMounted = false;
    note(e.message || "Could not load checkout. Please refresh.", "error");
  }
}

(async () => {
  if (!bookingId || !token) return view.replaceChildren(banner("warn", "Link not valid", "Please use the full link from your confirmation email or the page you saw after submitting your request."));
  const { ok, data } = await api("");
  if (!ok) return view.replaceChildren(banner("warn", "Booking not found", "This link is incorrect or incomplete. Please use the exact link we gave you."));
  render(data.booking);
})();
