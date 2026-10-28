import Database from "better-sqlite3";

const COLUMNS = {
  order_attempt: "INTEGER NOT NULL DEFAULT 0",
  decline_reason: "TEXT",
  paid_at: "TEXT",
  updated_at: "TEXT",
  processing_since: "TEXT"
};

export function openDb(file) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      pickup TEXT NOT NULL,
      delivery TEXT NOT NULL,
      move_date TEXT NOT NULL,
      miles INTEGER NOT NULL,
      weight_lb INTEGER NOT NULL,
      load_size TEXT NOT NULL,
      notes TEXT,
      estimate_cents INTEGER NOT NULL,
      final_price_cents INTEGER,
      deposit_cents INTEGER,
      status TEXT NOT NULL,
      paypal_order_id TEXT,
      paypal_capture_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id TEXT NOT NULL,
      type TEXT NOT NULL,
      detail TEXT,
      at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS events_booking ON events(booking_id);
  `);
  // Migrate databases created by v0.2.
  const have = new Set(db.prepare("PRAGMA table_info(bookings)").all().map(c => c.name));
  for (const [name, type] of Object.entries(COLUMNS)) {
    if (!have.has(name)) db.exec(`ALTER TABLE bookings ADD COLUMN ${name} ${type}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS bookings_status ON bookings(status)");
  return db;
}

export function logEvent(db, bookingId, type, detail = "") {
  db.prepare("INSERT INTO events (booking_id, type, detail) VALUES (?,?,?)")
    .run(bookingId, type, String(detail).slice(0, 500));
}
