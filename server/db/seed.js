import 'dotenv/config'
import bcrypt from 'bcryptjs'
import pg from 'pg'

const { Pool } = pg
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const devPassword = process.env.SEED_PASSWORD || 'AuroraDevOnly-2026!'

const run = async () => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const passwordHash = await bcrypt.hash(devPassword, 12)
    const { rows: users } = await client.query(`
      INSERT INTO users (email, password_hash, display_name, role, tax_id, credit_limit_cents, commission_tier, verified_at)
      VALUES ('admin@auroramobility.dev', $1, 'Aurora Operations', 'admin', 'NP-AURORA-001', 0, 0, now()),
             ('partner@auroramobility.dev', $1, 'Alex Kim', 'reseller', 'NP-AURORA-2048', 5000000, 1, now())
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, verified_at = now()
      RETURNING id, email, role`, [passwordHash])
    const products = [
      ['AUR-X-256', 'AURORA', 'PHONE X', 256, 12, 'Obsidian', 69900, 89900],
      ['AUR-XP-512', 'AURORA', 'PHONE X PRO', 512, 16, 'Titanium Gold', 99900, 129900],
      ['SAM-S24U-512', 'Samsung', 'Galaxy S24 Ultra', 512, 12, 'Titanium Black', 109200, 129900],
      ['APL-IP15PM-256', 'Apple', 'iPhone 15 Pro Max', 256, 8, 'Natural Titanium', 104800, 119900],
    ]
    for (const product of products) {
      const { rows } = await client.query(`INSERT INTO products (sku, brand, model, storage_gb, ram_gb, color, wholesale_price_cents, retail_price_cents)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (sku) DO UPDATE SET wholesale_price_cents=EXCLUDED.wholesale_price_cents RETURNING id`, product)
      const count = product[0] === 'AUR-X-256' ? 6 : 3
      for (let i = 0; i < count; i += 1) {
        const serial = `${product[0]}-SN-${String(i + 1).padStart(3, '0')}`
        await client.query(`INSERT INTO inventory_units (product_id, imei, serial_number, warehouse_code) VALUES ($1,$2,$3,'KTM-01') ON CONFLICT (imei) DO NOTHING`, [rows[0].id, `358240000${String(product[0].length)}${String(i + 1).padStart(6, '0')}`, serial])
      }
    }
    await client.query('COMMIT')
    console.log(`Seeded ${users.length} users and ${products.length} products. Dev password: ${devPassword}`)
  } catch (error) { await client.query('ROLLBACK'); console.error(error); process.exitCode = 1 } finally { client.release(); await pool.end() }
}
run()
