const $ = (s) => document.querySelector(s);
let token = ""; try { token = sessionStorage.getItem("hh_admin") || ""; } catch {}
let bookings = [], depositPercent = 20;

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === "class") n.className = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n[k] = v; }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
}
const usd = (v) => `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const LABEL = { PENDING_REVIEW: "Pending review", AWAITING_DEPOSIT: "Awaiting deposit", PAYMENT_PROCESSING: "Payment processing", PAYMENT_REVIEW: "PAYMENT REVIEW", DEPOSIT_PAID: "Deposit paid", DECLINED: "Declined" };
const ACTIVE = new Set(["PENDING_REVIEW", "PAYMENT_PROCESSING", "PAYMENT_REVIEW"]);

async function api(path, opts = {}) {
  const r = await fetch(`/api/admin${path}`, { ...opts, headers: { "x-admin-token": token, "Content-Type": "application/json" } });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { signOut(); throw new Error("Wrong token."); }
  if (!r.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function signOut() {
  token = ""; try { sessionStorage.removeItem("hh_admin"); } catch {}
  $("#panel").hidden = true; $("#login").hidden = false;
}

async function load() {
  const data = await api("/bookings");
  bookings = data.bookings; depositPercent = data.depositPercent;
  $("#login").hidden = true; $("#panel").hidden = false; $("#who").textContent = `${bookings.length} bookings`;
  draw();
}

function draw() {
  const f = $("#filter").value;
  const rows = bookings.filter((b) => f === "ALL" || (f === "ACTIVE" ? ACTIVE.has(b.status) : b.status === f));
  $("#list").replaceChildren(...(rows.length ? rows.map(card) : [el("p", { class: "muted" }, "Nothing here.")]));
}

function card(b) {
  const msg = el("div", { class: "msg", role: "status" });
  const run = async (fn) => { try { msg.className = "msg"; msg.textContent = "Working…"; await fn(); await load(); } catch (e) { msg.className = "msg error"; msg.textContent = e.message; } };
  const box = el("article", { class: `booking ${b.status === "PAYMENT_REVIEW" ? "alert" : ""}` },
    el("div", { class: "row" }, el("h3", {}, `${b.pickup} → ${b.delivery}`), el("span", { class: `chip ${b.status}` }, LABEL[b.status] || b.status)),
    el("p", { class: "meta" }, `${b.customerName} · `, el("a", { href: `mailto:${b.email}` }, b.email), b.phone ? ` · ${b.phone}` : ""),
    el("p", { class: "meta" }, `Move ${b.moveDate} · ${b.miles.toLocaleString()} mi · ${b.weightLb.toLocaleString()} lb · ${b.loadSize} · estimate ${usd(b.estimateUsd)}`),
    b.finalPriceUsd ? el("p", { class: "meta" }, `Final ${usd(b.finalPriceUsd)} · deposit ${usd(b.depositUsd)}${b.paidAt ? ` · paid ${b.paidAt.slice(0, 10)}` : ""}`) : null,
    b.notes ? el("p", { class: "notes" }, b.notes) : null,
    b.declineReason ? el("p", { class: "meta" }, `Declined: ${b.declineReason}`) : null);

  if (b.status === "PENDING_REVIEW") {
    const price = el("input", { type: "number", min: "10", step: "0.01", value: b.estimateUsd, "aria-label": "Final price in USD" });
    const reason = el("input", { type: "text", maxLength: 300, placeholder: "Reason (optional, shown to customer)" });
    box.append(el("div", { class: "actions" },
      el("label", {}, "Final price (USD)", price),
      el("button", { type: "button", onclick: () => {
        const p = Number(price.value);
        if (!(p >= 10)) { msg.className = "msg error"; msg.textContent = "Enter a valid price."; return; }
        if (confirm(`Approve at ${usd(p)}? The customer will be asked to pay a ${depositPercent}% deposit (${usd(p * depositPercent / 100)}).`))
          run(() => api(`/bookings/${b.id}/approve`, { method: "POST", body: JSON.stringify({ finalPriceUsd: p }) }));
      } }, "Approve & request deposit"),
      el("label", {}, "Decline", reason),
      el("button", { type: "button", class: "danger", onclick: () => { if (confirm("Decline this request?")) run(() => api(`/bookings/${b.id}/decline`, { method: "POST", body: JSON.stringify({ reason: reason.value }) })); } }, "Decline")));
  }
  if (["PAYMENT_PROCESSING", "PAYMENT_REVIEW", "AWAITING_DEPOSIT"].includes(b.status)) {
    box.append(el("div", { class: "actions" }, el("button", { type: "button", class: "secondary", onclick: () => run(() => api(`/bookings/${b.id}/reconcile`, { method: "POST", body: "{}" })) }, "Re-check payment with PayPal")));
  }
  if (b.status === "PAYMENT_REVIEW") box.append(el("p", { class: "notes" }, `Money may have moved. Open PayPal and look at ${b.paypalCaptureId || b.paypalOrderId || "this booking"} before doing anything else.`));

  const hist = el("div", { class: "history" });
  const links = el("div", { class: "actions" },
    el("button", { type: "button", class: "secondary", onclick: async () => {
      if (hist.childElementCount) return hist.replaceChildren();
      try { const { events } = await api(`/bookings/${b.id}/events`); hist.replaceChildren(...events.map((e) => el("div", {}, `${e.at.replace("T", " ").slice(0, 19)}  ${e.type}  ${e.detail || ""}`))); } catch (e) { msg.textContent = e.message; }
    } }, "History"),
    el("button", { type: "button", class: "secondary", onclick: async () => {
      const url = location.origin + b.customerPath;
      try { await navigator.clipboard.writeText(url); msg.className = "msg success"; msg.textContent = "Customer link copied."; } catch { prompt("Customer link", url); }
    } }, "Copy customer link"));
  box.append(links, hist, msg);
  return box;
}

$("#login").addEventListener("submit", async (e) => {
  e.preventDefault();
  token = $("#token").value.trim();
  try { await load(); try { sessionStorage.setItem("hh_admin", token); } catch {} $("#token").value = ""; $("#login-msg").textContent = ""; }
  catch (err) { $("#login-msg").className = "error"; $("#login-msg").textContent = err.message; }
});
$("#filter").addEventListener("change", draw);
$("#refresh").addEventListener("click", () => load().catch((e) => alert(e.message)));
$("#logout").addEventListener("click", signOut);
if (token) load().catch(() => signOut());
