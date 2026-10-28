import crypto from "node:crypto";

export class PayPalError extends Error {
  constructor(message, { status = 0, name = "", issue = "", network = false } = {}) {
    super(message);
    this.status = status; this.paypalName = name; this.issue = issue; this.network = network;
  }
}

export function createPayPalClient(env = process.env) {
  const base = () => (env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");
  let cached = null; // { token, expiresAt }

  async function token() {
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
    const id = env.PAYPAL_CLIENT_ID, secret = env.PAYPAL_CLIENT_SECRET;
    if (!id || !secret) throw new PayPalError("PayPal credentials are not configured.");
    let response;
    try {
      response = await fetch(`${base()}/v1/oauth2/token`, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(15_000)
      });
    } catch { throw new PayPalError("Could not reach PayPal.", { network: true }); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) throw new PayPalError("Could not authenticate with PayPal.", { status: response.status });
    cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in || 300) * 1000 };
    return cached.token;
  }

  async function call(method, endpoint, payload, requestId) {
    const headers = { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    let response;
    try {
      response = await fetch(`${base()}${endpoint}`, {
        method, headers, body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000)
      });
    } catch { throw new PayPalError("Could not reach PayPal.", { network: true }); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const issue = body.details?.[0]?.issue || "";
      console.error("PayPal API error:", method, endpoint.split("?")[0].replace(/\/[A-Z0-9]{10,}/g, "/:id"), response.status, body.name || "", issue);
      throw new PayPalError("PayPal could not complete the request.", { status: response.status, name: body.name || "", issue });
    }
    return body;
  }

  return {
    createOrder: (payload, requestId) => call("POST", "/v2/checkout/orders", payload, requestId),
    getOrder: (orderId) => call("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`),
    captureOrder: (orderId, requestId) => call("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, requestId),
    async verifyWebhook(headers, event) {
      const webhookId = env.PAYPAL_WEBHOOK_ID;
      if (!webhookId) throw new PayPalError("PAYPAL_WEBHOOK_ID is not configured.");
      const result = await call("POST", "/v1/notifications/verify-webhook-signature", {
        auth_algo: headers["paypal-auth-algo"], cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"], transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"], webhook_id: webhookId, webhook_event: event
      }, crypto.randomUUID());
      return result.verification_status === "SUCCESS";
    }
  };
}
