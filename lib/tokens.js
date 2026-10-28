import crypto from "node:crypto";

// Customer links are /booking.html#<id>.<token>. The token is an HMAC of the booking id,
// so nothing secret has to be stored per booking and the link can be re-sent in later emails.
export function getLinkSecret(db, env = process.env) {
  if (env.LINK_SECRET && env.LINK_SECRET.length >= 24) return env.LINK_SECRET;
  db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = db.prepare("SELECT value FROM settings WHERE key='link_secret'").get();
  if (row) return row.value;
  const value = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('link_secret', ?)").run(value);
  return db.prepare("SELECT value FROM settings WHERE key='link_secret'").get().value;
}

export function bookingToken(secret, bookingId) {
  return crypto.createHmac("sha256", secret).update(`booking:${bookingId}`).digest("base64url").slice(0, 32);
}

export function tokenMatches(secret, bookingId, supplied) {
  if (typeof supplied !== "string") return false;
  const expected = Buffer.from(bookingToken(secret, bookingId));
  const given = Buffer.from(supplied);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
