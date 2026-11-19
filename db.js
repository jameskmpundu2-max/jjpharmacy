const { Pool, neonConfig } = require('@neondatabase/serverless');
neonConfig.webSocketConstructor = require('ws');
const bcrypt = require('bcryptjs');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required. Configure a Neon PostgreSQL connection string before starting PharmaTrack.');
let databaseHost;
try { databaseHost = new URL(databaseUrl).hostname; }
catch { throw new Error('DATABASE_URL must be a valid Neon PostgreSQL connection string.'); }
if (!databaseHost.toLowerCase().endsWith('.neon.tech'))
  throw new Error('DATABASE_URL must point to a Neon database host ending in .neon.tech.');

const pool = new Pool({ connectionString: databaseUrl, max: Number(process.env.PG_POOL_MAX || 5) });
pool.on('error', error => console.error('Unexpected idle Neon database connection error:', error.message));

async function initDb() {
  const sql = `
  CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','cashier')),
    active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS suppliers (
    id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, contact_person TEXT,
    phone TEXT, email TEXT, address TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS products (
    id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT '',
    sku TEXT UNIQUE, batch_number TEXT NOT NULL DEFAULT '', expiry_date DATE,
    cost_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(cost_price >= 0),
    selling_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(selling_price >= 0),
    quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
    reorder_level INTEGER NOT NULL DEFAULT 10 CHECK(reorder_level >= 0),
    active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS purchases (
    id BIGSERIAL PRIMARY KEY, supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
    invoice_number TEXT, purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
    total NUMERIC(12,2) NOT NULL DEFAULT 0, notes TEXT,
    created_by BIGINT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS purchase_items (
    id BIGSERIAL PRIMARY KEY, purchase_id BIGINT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL CHECK(quantity > 0),
    unit_cost NUMERIC(12,2) NOT NULL CHECK(unit_cost >= 0), line_total NUMERIC(12,2) NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sales (
    id BIGSERIAL PRIMARY KEY, receipt_number TEXT NOT NULL UNIQUE,
    sale_date TIMESTAMPTZ NOT NULL DEFAULT NOW(), subtotal NUMERIC(12,2) NOT NULL,
    discount NUMERIC(12,2) NOT NULL DEFAULT 0, total NUMERIC(12,2) NOT NULL,
    amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0, change_due NUMERIC(12,2) NOT NULL DEFAULT 0,
    idempotency_key TEXT,
    payment_method TEXT NOT NULL DEFAULT 'Cash', cashier_id BIGINT REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE sales ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0;
  ALTER TABLE sales ADD COLUMN IF NOT EXISTS change_due NUMERIC(12,2) NOT NULL DEFAULT 0;
  ALTER TABLE sales ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_idempotency_key ON sales(idempotency_key);
  CREATE TABLE IF NOT EXISTS sale_items (
    id BIGSERIAL PRIMARY KEY, sale_id BIGINT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(id), product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK(quantity > 0), unit_price NUMERIC(12,2) NOT NULL,
    line_total NUMERIC(12,2) NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stock_movements (
    id BIGSERIAL PRIMARY KEY, product_id BIGINT NOT NULL REFERENCES products(id),
    movement_type TEXT NOT NULL CHECK(movement_type IN ('OPENING','SALE','PURCHASE','ADJUSTMENT')),
    quantity_change INTEGER NOT NULL, balance_after INTEGER NOT NULL,
    reference TEXT, note TEXT, user_id BIGINT REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
  CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date);
  CREATE INDEX IF NOT EXISTS idx_movements_date ON stock_movements(created_at);
  `;
  await pool.query(sql);

  const count = await pool.query('SELECT COUNT(*)::int AS count FROM users');
  if (count.rows[0].count === 0) {
    const email = process.env.ADMIN_EMAIL || 'admin@example.com';
    const password = process.env.ADMIN_PASSWORD || 'ChangeThisPassword123!';
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      'INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,$4)',
      [process.env.ADMIN_NAME || 'System Administrator', email.toLowerCase(), hash, 'admin']
    );
    console.log(`Initial administrator created: ${email}`);
  }
}

module.exports = { pool, initDb };
