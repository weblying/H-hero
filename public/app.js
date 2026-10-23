// Rates, deposit % and contact details come from the server (/api/config) so the page never drifts from the backend.
const DEFAULTS = {
  depositPercent: 20,
  pricing: { baseFee: 125, perMile: 2.15, perPound: 0.035, multipliers: { small: 0.85, standard: 1, large: 1.2 } },
  contact: {}
};
let cfg = DEFAULTS;

// Typical weights for planning. Customers can overwrite the number.
const HOMES = {
  studio: { weight: 2000, size: "small" },
  "1br": { weight: 4000, size: "small" },
  "2br": { weight: 6500, size: "standard" },
  "3br": { weight: 9500, size: "large" },
  "4br": { weight: 13000, size: "large" }
};

const $ = (s) => document.querySelector(s);
const usd0 = (n) => `$${Math.round(n).toLocaleString("en-US")}`;
const num = (v) => (v === "" || v == null ? NaN : Number(v));

function estimate(miles, weight, size) {
  const p = cfg.pricing;
  if (!(miles >= 1 && miles <= 10000 && weight >= 1 && weight <= 80000)) return null;
  return (p.baseFee + miles * p.perMile + weight * p.perPound) * (p.multipliers[size] ?? 1);
}

// ---------- estimator ----------
const est = { from: $("#e-from"), to: $("#e-to"), miles: $("#e-miles"), home: $("#e-home"), weight: $("#e-weight") };
const sign = $("#sign");
const form = $("#booking-form");

function drawRoute() {
  sign.classList.remove("is-drawing");
  void sign.offsetWidth; // restart the animation
  sign.classList.add("is-drawing");
}

function renderSign() {
  const miles = num(est.miles.value), weight = num(est.weight.value);
  const size = HOMES[est.home.value].size;
  const total = estimate(miles, weight, size);
  $("#s-from").textContent = est.from.value.trim() || "Pickup";
  $("#s-to").textContent = est.to.value.trim() || "Your destination";
  $("#s-price").hidden = total == null;
  if (total == null) {
    $("#s-note").textContent = "Add where you're going and the distance to see your estimate.";
  } else {
    $("#s-price").textContent = usd0(total);
    $("#s-note").textContent = `For about ${miles.toLocaleString("en-US")} miles and ${weight.toLocaleString("en-US")} lb. Our team confirms your final price.`;
  }
  renderFormEstimate();
}

function setHomeWeight() { est.weight.value = HOMES[est.home.value].weight; }

est.home.addEventListener("change", () => { setHomeWeight(); renderSign(); });
for (const el of [est.from, est.to, est.miles, est.weight]) el.addEventListener("input", () => { renderSign(); if (el === est.to || el === est.miles) clearChips(); });
for (const el of [est.to, est.miles]) el.addEventListener("change", () => { if (est.to.value.trim() && num(est.miles.value) >= 1) drawRoute(); });

function clearChips() { document.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false")); }
document.querySelectorAll(".chip").forEach((chip) => chip.addEventListener("click", () => {
  est.to.value = chip.dataset.to; est.miles.value = chip.dataset.miles;
  clearChips(); chip.setAttribute("aria-pressed", "true");
  renderSign(); drawRoute();
}));

$("#to-request").addEventListener("click", () => {
  if (!est.to.value.trim()) return est.to.focus();
  if (!(num(est.miles.value) >= 1)) return est.miles.focus();
  form.elements.pickup.value = est.from.value.trim();
  form.elements.delivery.value = est.to.value.trim();
  form.elements.miles.value = est.miles.value;
  form.elements.weightLb.value = est.weight.value;
  form.elements.loadSize.value = HOMES[est.home.value].size;
  renderFormEstimate();
  $("#request").scrollIntoView({ behavior: "smooth" });
  setTimeout(() => form.elements.moveDate.focus({ preventScroll: true }), 500);
});

// ---------- request form ----------
const dateInput = $("#moveDate");
const submit = form.querySelector("button[type=submit]");
const result = $("#result");
const setMin = () => { dateInput.min = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
setMin();

function renderFormEstimate() {
  const total = estimate(num(form.elements.miles.value), num(form.elements.weightLb.value), form.elements.loadSize.value);
  const out = $("#f-estimate");
  out.hidden = total == null;
  if (total != null) out.textContent = `Planning estimate: ${usd0(total)}`;
}
for (const name of ["miles", "weightLb", "loadSize"]) form.elements[name].addEventListener("input", renderFormEstimate);

function showBookingLink(path) {
  const link = $("#my-booking");
  if (path) { link.href = path; link.hidden = false; }
}
try { showBookingLink(localStorage.getItem("hh_last_booking")); } catch {}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.checkValidity()) return form.reportValidity();
  result.className = ""; result.textContent = "Sending your request…";
  submit.disabled = true;
  const values = Object.fromEntries(new FormData(form).entries());
  values.miles = Number(values.miles);
  values.weightLb = Number(values.weightLb);
  try {
    const response = await fetch("/api/bookings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "We couldn't send your request. Check the highlighted details and try again.");
    result.className = "success";
    result.replaceChildren(
      Object.assign(document.createElement("b"), { textContent: "Request sent. " }),
      `Your planning estimate is $${Number(data.booking.estimateUsd).toLocaleString("en-US", { minimumFractionDigits: 2 })}. We'll confirm the final price before you pay anything. `);
    if (data.statusPath) {
      result.append(Object.assign(document.createElement("a"), { href: data.statusPath, textContent: "Open your booking page" }),
        " and save the link. It's how you check your request and pay the deposit once approved.");
      try { localStorage.setItem("hh_last_booking", data.statusPath); } catch {}
      showBookingLink(data.statusPath);
    }
    form.reset(); setMin(); renderFormEstimate();
    result.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    result.className = "error";
    result.textContent = error.message || "Network problem. Check your connection and try again.";
  } finally { submit.disabled = false; }
});

// ---------- fill in server-driven content ----------
function applyConfig() {
  const p = cfg.pricing, m = p.multipliers;
  document.querySelectorAll("[data-fill=deposit]").forEach((n) => { n.textContent = cfg.depositPercent; });
  $("#r-base").textContent = usd0(p.baseFee);
  $("#r-mile").textContent = `$${p.perMile.toFixed(2)}`;
  $("#r-pound").textContent = `$${p.perPound.toFixed(3)}`;
  $("#r-small").textContent = `×${m.small}`;
  $("#r-standard").textContent = `×${m.standard}`;
  $("#r-large").textContent = `×${m.large}`;

  const sample = { miles: 370, weight: HOMES["2br"].weight, size: "standard" };
  const total = estimate(sample.miles, sample.weight, sample.size);
  const ex = $("#example");
  ex.hidden = false;
  const d2 = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  ex.textContent = `Example: a 2-bedroom move of about ${sample.weight.toLocaleString("en-US")} lb over ${sample.miles} miles is ${d2(p.baseFee)} + ${d2(sample.miles * p.perMile)} for distance + ${d2(sample.weight * p.perPound)} for weight, which comes to ${d2(total)}.`;

  const { email, phone, legalLine } = cfg.contact || {};
  const bits = [];
  const footContact = $("#foot-contact"), footLegal = $("#foot-legal");
  if (email) bits.push(Object.assign(document.createElement("a"), { href: `mailto:${email}`, textContent: email }));
  if (phone) bits.push(Object.assign(document.createElement("a"), { href: `tel:${phone.replace(/[^\d+]/g, "")}`, textContent: phone }));
  const join = (nodes) => nodes.flatMap((n, i) => (i ? [" or ", n] : [n]));
  footContact.hidden = !bits.length;
  if (bits.length) {
    footContact.replaceChildren(...join(bits));
    $("#faq-contact").replaceChildren("Email or call us: ", ...join(bits.map((b) => b.cloneNode(true))), ". Once you've sent a request, your booking page is the quickest way to see where it stands.");
  }
  footLegal.hidden = !legalLine;
  if (legalLine) footLegal.textContent = legalLine;
  renderSign();
}

setHomeWeight();
renderSign();
applyConfig();
drawRoute(); // plays once on load
fetch("/api/config").then((r) => r.json()).then((c) => { cfg = { ...DEFAULTS, ...c, pricing: { ...DEFAULTS.pricing, ...c.pricing }, contact: c.contact || {} }; applyConfig(); }).catch(() => {});
