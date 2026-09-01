import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import pg from 'pg'
import crypto from 'node:crypto'
import { generateSecret, generateURI, verify } from 'otplib'
import { v2 as cloudinary } from 'cloudinary'
import { invoicePdf } from './services/invoices.js'
import { sendOrderNotification } from './services/notifications.js'
import { createEsewaPayload, createKhaltiIntent } from './services/payments.js'

const { Pool } = pg
const app = express()
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const port = Number(process.env.PORT || 4000)
const isProduction = process.env.NODE_ENV === 'production'
const inventoryClients = new Set()
const allowedOrigins = new Set((process.env.FRONTEND_ORIGIN || '').split(',').map((origin) => origin.trim()).filter(Boolean).concat(['http://localhost:5173', 'http://127.0.0.1:5173']))
if (process.env.CLOUDINARY_CLOUD_NAME) cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true })

app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)), credentials: true }))
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())

const signToken = (user) => jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '8h' })
const verifyCaptcha = async (token, ip) => {
  if (!process.env.TURNSTILE_SECRET_KEY) return process.env.NODE_ENV !== 'production'
  if (!token) return false
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: process.env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }) })
  return response.ok && (await response.json()).success === true
}
const requireAuth = (roles = []) => async (req, res, next) => {
  try {
    const token = req.cookies.aurora_session
    if (!token) return res.status(401).json({ error: 'Authentication required' })
    const claims = jwt.verify(token, process.env.JWT_SECRET)
    const { rows } = await pool.query('SELECT id, email, display_name, role FROM users WHERE id = $1', [claims.sub])
    if (!rows[0] || (roles.length && !roles.includes(rows[0].role))) return res.status(403).json({ error: 'Insufficient permissions' })
    req.user = rows[0]
    next()
  } catch { res.status(401).json({ error: 'Invalid or expired session' }) }
}

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, service: 'aurora-api', database: 'connected' }) }
  catch { res.status(503).json({ ok: false, service: 'aurora-api', database: 'unavailable' }) }
})

app.post('/api/auth/register', async (req, res) => {
  const { email, password, displayName, role = 'retail', captchaToken } = req.body
  if (!email || !password || !displayName || password.length < 12) return res.status(400).json({ error: 'Email, display name, and a 12-character password are required' })
  if (!['retail', 'reseller'].includes(role)) return res.status(400).json({ error: 'Invalid self-service role' })
  if (!(await verifyCaptcha(captchaToken, req.ip))) return res.status(400).json({ error: 'CAPTCHA verification failed' })
  try {
    const passwordHash = await bcrypt.hash(password, 12)
    const { rows } = await pool.query('INSERT INTO users(email, password_hash, display_name, role, email_verified_at) VALUES($1,$2,$3,$4,$5) RETURNING id,email,display_name,role', [email, passwordHash, displayName, role, role === 'reseller' ? new Date() : null])
    const code = String(crypto.randomInt(100000, 1000000))
    await pool.query("INSERT INTO email_verification_codes(user_id, code_hash, expires_at) VALUES($1,$2,now() + interval '10 minutes')", [rows[0].id, crypto.createHash('sha256').update(code).digest('hex')])
    await sendOrderNotification({ to: email, orderNumber: 'EMAIL-VERIFY', type: 'email verification', message: `Your Aurora Mobility verification code is ${code}. It expires in 10 minutes.` })
    res.status(201).json({ user: rows[0], requiresEmailVerification: role === 'retail', ...(process.env.NODE_ENV !== 'production' ? { developmentOtp: code } : {}) })
  } catch (error) { res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'Email already registered' : 'Registration failed' }) }
})

app.post('/api/auth/login', async (req, res) => {
  const { email, password, otp } = req.body
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email || ''])
  if (!rows[0] || !(await bcrypt.compare(password || '', rows[0].password_hash))) return res.status(401).json({ error: 'Invalid email or password' })
  if (rows[0].role === 'retail' && !rows[0].email_verified_at) return res.status(401).json({ error: 'Email verification required', code: 'EMAIL_VERIFICATION_REQUIRED' })
  if (rows[0].totp_enabled) { const result = otp ? await verify({ token: otp, secret: rows[0].totp_secret_encrypted }) : { valid: false }; if (!result.valid) return res.status(401).json({ error: 'Two-factor verification required', code: 'TWO_FACTOR_REQUIRED' }) }
  res.cookie('aurora_session', signToken(rows[0]), { httpOnly: true, secure: isProduction, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 })
  res.json({ user: { id: rows[0].id, email: rows[0].email, displayName: rows[0].display_name, role: rows[0].role } })
})
app.post('/api/auth/logout', (_req, res) => { res.clearCookie('aurora_session'); res.status(204).end() })
app.get('/api/auth/me', requireAuth(), (req, res) => res.json({ user: { id: req.user.id, email: req.user.email, displayName: req.user.display_name, role: req.user.role } }))
app.post('/api/auth/verify-email', async (req, res) => { const { email, code } = req.body; if (!email || !/^\d{6}$/.test(code || '')) return res.status(400).json({ error: 'Enter the six-digit verification code' }); const client = await pool.connect(); try { await client.query('BEGIN'); const { rows: users } = await client.query('SELECT id FROM users WHERE email=$1', [email]); const hash = crypto.createHash('sha256').update(code).digest('hex'); const { rows } = users[0] ? await client.query("SELECT id FROM email_verification_codes WHERE user_id=$1 AND code_hash=$2 AND verified_at IS NULL AND expires_at > now() AND attempts < 5 ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [users[0].id, hash]) : { rows: [] }; if (!rows[0]) { if (users[0]) await client.query("UPDATE email_verification_codes SET attempts=attempts+1 WHERE user_id=$1 AND verified_at IS NULL", [users[0].id]); await client.query('ROLLBACK'); return res.status(400).json({ error: 'Invalid or expired verification code' }) }; await client.query('UPDATE users SET email_verified_at=now() WHERE id=$1', [users[0].id]); await client.query('UPDATE email_verification_codes SET verified_at=now() WHERE id=$1', [rows[0].id]); await client.query('COMMIT'); res.json({ verified: true }) } catch { await client.query('ROLLBACK'); res.status(500).json({ error: 'Email verification failed' }) } finally { client.release() } })
app.post('/api/auth/verify-email/resend', async (req, res) => { const { email } = req.body; const { rows } = await pool.query('SELECT id FROM users WHERE email=$1 AND email_verified_at IS NULL', [email || '']); if (rows[0]) { const code = String(crypto.randomInt(100000, 1000000)); await pool.query("INSERT INTO email_verification_codes(user_id,code_hash,expires_at) VALUES($1,$2,now()+interval '10 minutes')", [rows[0].id, crypto.createHash('sha256').update(code).digest('hex')]); await sendOrderNotification({ to: email, orderNumber: 'EMAIL-VERIFY', type: 'email verification', message: `Your new Aurora Mobility verification code is ${code}. It expires in 10 minutes.` }); } res.json({ message: 'If verification is pending, a new code has been sent.' }) })

app.post('/api/auth/password-reset/request', async (req, res) => {
  const { email, captchaToken } = req.body
  if (!(await verifyCaptcha(captchaToken, req.ip))) return res.status(400).json({ error: 'CAPTCHA verification failed' })
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email || ''])
  if (rows[0]) {
    const rawToken = crypto.randomBytes(32).toString('hex')
    await pool.query("INSERT INTO password_reset_tokens(user_id, token_hash, expires_at) VALUES($1,$2,now() + interval '30 minutes')", [rows[0].id, crypto.createHash('sha256').update(rawToken).digest('hex')])
    console.info(`[password-reset:sandbox] token for ${email}: ${rawToken}`)
    await sendOrderNotification({ to: email, orderNumber: 'PASSWORD-RESET', type: 'password reset' })
  }
  res.json({ message: 'If an account exists, recovery instructions have been sent.' })
})
app.post('/api/auth/password-reset/complete', async (req, res) => {
  const { token, password } = req.body
  if (!token || !password || password.length < 12) return res.status(400).json({ error: 'A valid token and 12-character password are required' })
  const client = await pool.connect()
  try { await client.query('BEGIN'); const hash = crypto.createHash('sha256').update(token).digest('hex'); const { rows } = await client.query("SELECT id, user_id FROM password_reset_tokens WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now() FOR UPDATE", [hash]); if (!rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Invalid or expired reset token' }) }; await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(password, 12), rows[0].user_id]); await client.query('UPDATE password_reset_tokens SET used_at=now() WHERE id=$1', [rows[0].id]); await client.query('COMMIT'); res.json({ message: 'Password reset complete' }) } catch { await client.query('ROLLBACK'); res.status(500).json({ error: 'Password reset failed' }) } finally { client.release() }
})
app.post('/api/auth/2fa/setup', requireAuth(['reseller', 'admin']), async (req, res) => { const secret = generateSecret(); await pool.query('UPDATE users SET totp_secret_encrypted=$1 WHERE id=$2', [secret, req.user.id]); res.json({ secret, otpauth: generateURI({ secret, issuer: 'Aurora Mobility', label: req.user.email }) }) })
app.post('/api/auth/2fa/enable', requireAuth(['reseller', 'admin']), async (req, res) => { const { otp } = req.body; const { rows } = await pool.query('SELECT totp_secret_encrypted FROM users WHERE id=$1', [req.user.id]); const result = rows[0]?.totp_secret_encrypted ? await verify({ token: otp || '', secret: rows[0].totp_secret_encrypted }) : { valid: false }; if (!result.valid) return res.status(400).json({ error: 'Invalid authenticator code' }); await pool.query('UPDATE users SET totp_enabled=true WHERE id=$1', [req.user.id]); res.json({ enabled: true }) })

app.get('/api/inventory/events', requireAuth(), (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.flushHeaders()
  res.write(`event: ready\ndata: ${JSON.stringify({ connectedAt: new Date().toISOString() })}\n\n`)
  inventoryClients.add(res)
  req.on('close', () => inventoryClients.delete(res))
})

app.post('/api/payments/:provider/intents', requireAuth(), async (req, res) => {
  const provider = req.params.provider.toLowerCase()
  if (!['esewa', 'khalti'].includes(provider)) return res.status(400).json({ error: 'Unsupported payment provider' })
  const { orderId, amountCents, returnUrl } = req.body
  if (!orderId || !Number.isInteger(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'orderId and positive amountCents are required' })
  try {
    const payload = provider === 'esewa' ? createEsewaPayload({ orderNumber: orderId, amount: amountCents / 100, successUrl: returnUrl, failureUrl: returnUrl }) : await createKhaltiIntent({ amount: amountCents, orderNumber: orderId, returnUrl })
    res.status(201).json({ provider, payload })
  } catch (error) { res.status(503).json({ error: error.message, code: 'PAYMENT_PROVIDER_UNAVAILABLE' }) }
})

app.post('/api/payments/:provider/verify', requireAuth(), async (req, res) => {
  const provider = req.params.provider.toLowerCase()
  if (!['esewa', 'khalti'].includes(provider)) return res.status(400).json({ error: 'Unsupported payment provider' })
  if (!process.env[provider === 'esewa' ? 'ESEWA_SECRET_KEY' : 'KHALTI_SECRET_KEY']) return res.status(503).json({ error: 'Payment provider is not configured' })
  // Validate provider response here, then mark the order paid in one transaction.
  res.status(202).json({ status: 'verification_queued', provider, reference: req.body.reference || null })
})

app.post('/api/orders', requireAuth(), async (req, res) => {
  const { items, shippingAddress, paymentProvider = 'cod' } = req.body
  if (!Array.isArray(items) || !items.length || !shippingAddress) return res.status(400).json({ error: 'items and shippingAddress are required' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const orderNumber = `AUR-${Date.now().toString(36).toUpperCase()}`
    let subtotal = 0
    const locked = []
    for (const item of items) {
      if (!item.productId || !Number.isInteger(item.quantity) || item.quantity < 1) throw new Error('Invalid cart item')
      const { rows } = await client.query("SELECT id, product_id FROM inventory_units WHERE product_id = $1 AND status = 'available' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2", [item.productId, item.quantity])
      if (rows.length !== item.quantity) { const error = new Error('One or more products went out of stock'); error.status = 409; throw error }
      const { rows: price } = await client.query('SELECT retail_price_cents FROM products WHERE id = $1 AND active = true', [item.productId])
      if (!price[0]) throw new Error('Product no longer available')
      subtotal += Number(price[0].retail_price_cents) * item.quantity
      locked.push({ ...item, unitPrice: price[0].retail_price_cents, units: rows })
    }
    const tax = Math.floor(subtotal * 0.13)
    const { rows: orders } = await client.query('INSERT INTO orders(order_number,buyer_id,status,currency,subtotal_cents,payment_provider) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,order_number,status,subtotal_cents', [orderNumber, req.user.id, paymentProvider === 'cod' ? 'processing' : 'pending', 'USD', subtotal + tax, paymentProvider])
    const order = orders[0]
    for (const item of locked) {
      await client.query('INSERT INTO order_items(order_id,product_id,quantity,unit_price_cents) VALUES($1,$2,$3,$4)', [order.id, item.productId, item.quantity, item.unitPrice])
      await client.query("UPDATE inventory_units SET status = 'reserved' WHERE id = ANY($1::uuid[])", [item.units.map((unit) => unit.id)])
    }
    const { rows: invoices } = await client.query('INSERT INTO invoices(order_id,invoice_number,subtotal_cents,tax_cents,total_cents) VALUES($1,$2,$3,$4,$5) RETURNING *', [order.id, `INV-${orderNumber}`, subtotal, tax, subtotal + tax])
    await client.query('INSERT INTO audit_log(actor_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5)', [req.user.id, 'order.created', 'order', order.id, JSON.stringify({ shippingAddress, paymentProvider })])
    await client.query('COMMIT')
    for (const subscriber of inventoryClients) subscriber.write(`event: inventory.updated\ndata: ${JSON.stringify({ productIds: locked.map((item) => item.productId), status: 'reserved' })}\n\n`)
    await sendOrderNotification({ to: req.user.email, orderNumber, total: `$${((subtotal + tax) / 100).toFixed(2)}` })
    res.status(201).json({ order, invoice: invoices[0] })
  } catch (error) { await client.query('ROLLBACK'); res.status(error.status || 500).json({ error: error.message || 'Order creation failed' }) } finally { client.release() }
})

app.get('/api/invoices/:invoiceId.pdf', requireAuth(), async (req, res) => {
  const { rows } = await pool.query('SELECT i.*, o.buyer_id FROM invoices i JOIN orders o ON o.id = i.order_id WHERE i.id = $1 AND o.buyer_id = $2', [req.params.invoiceId, req.user.id])
  if (!rows[0]) return res.status(404).json({ error: 'Invoice not found' })
  const { rows: items } = await pool.query('SELECT oi.quantity, oi.unit_price_cents, p.model FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1', [rows[0].order_id])
  const pdf = await invoicePdf(rows[0], items, req.user)
  res.type('application/pdf').set('Content-Disposition', `attachment; filename="${rows[0].invoice_number}.pdf"`).send(pdf)
})

app.get('/api/catalog', async (req, res) => {
  const values = []
  const search = req.query.search ? `%${req.query.search}%` : null
  if (search) values.push(search)
  const where = search ? 'WHERE active = true AND (model ILIKE $1 OR brand ILIKE $1 OR sku ILIKE $1)' : 'WHERE active = true'
  const { rows } = await pool.query(`SELECT p.*, COUNT(i.id) FILTER (WHERE i.status = 'available')::int AS available_stock FROM products p LEFT JOIN inventory_units i ON i.product_id = p.id ${where} GROUP BY p.id ORDER BY p.brand, p.model`, values)
  res.json({ products: rows })
})

app.get('/api/admin/products', requireAuth(['admin']), async (_req, res) => { const { rows } = await pool.query('SELECT p.*, COUNT(i.id) FILTER (WHERE i.status = \'available\')::int AS available_stock FROM products p LEFT JOIN inventory_units i ON i.product_id=p.id GROUP BY p.id ORDER BY p.created_at DESC'); res.json({ products: rows }) })
app.post('/api/admin/products', requireAuth(['admin']), async (req, res) => { const { sku, brand, model, storageGb, ramGb, color, retailPriceCents, wholesalePriceCents, imageUrl = null } = req.body; if (!sku || !brand || !model || !Number.isInteger(retailPriceCents) || !Number.isInteger(wholesalePriceCents)) return res.status(400).json({ error: 'sku, brand, model, and integer prices are required' }); try { const { rows } = await pool.query('INSERT INTO products(sku,brand,model,storage_gb,ram_gb,color,retail_price_cents,wholesale_price_cents,image_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [sku, brand, model, storageGb || 0, ramGb || null, color || null, retailPriceCents, wholesalePriceCents, imageUrl]); res.status(201).json({ product: rows[0] }) } catch (error) { res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'SKU already exists' : 'Product creation failed' }) } })
app.patch('/api/admin/products/:id', requireAuth(['admin']), async (req, res) => { const fields = { retailPriceCents: 'retail_price_cents', wholesalePriceCents: 'wholesale_price_cents', imageUrl: 'image_url', active: 'active' }; const entries = Object.entries(req.body).filter(([key, value]) => fields[key] && value !== undefined); if (!entries.length) return res.status(400).json({ error: 'No editable fields supplied' }); const values = entries.map(([, value]) => value); values.push(req.params.id); const set = entries.map(([key], index) => `${fields[key]}=$${index + 1}`).join(','); const { rows } = await pool.query(`UPDATE products SET ${set} WHERE id=$${values.length} RETURNING *`, values); if (!rows[0]) return res.status(404).json({ error: 'Product not found' }); res.json({ product: rows[0] }) })
app.delete('/api/admin/products/:id', requireAuth(['admin']), async (req, res) => { const { rows } = await pool.query('UPDATE products SET active=false WHERE id=$1 RETURNING id', [req.params.id]); if (!rows[0]) return res.status(404).json({ error: 'Product not found' }); res.status(204).end() })
app.get('/api/admin/users', requireAuth(['admin']), async (_req, res) => { const { rows } = await pool.query('SELECT id,email,display_name,role,tax_id,credit_limit_cents,commission_tier,verified_at,created_at FROM users ORDER BY created_at DESC'); res.json({ users: rows }) })
app.patch('/api/admin/users/:id', requireAuth(['admin']), async (req, res) => { const { role, creditLimitCents, commissionTier, verified } = req.body; const { rows } = await pool.query('UPDATE users SET role=COALESCE($1,role),credit_limit_cents=COALESCE($2,credit_limit_cents),commission_tier=COALESCE($3,commission_tier),verified_at=CASE WHEN $4::boolean THEN COALESCE(verified_at,now()) ELSE verified_at END WHERE id=$5 RETURNING id,email,display_name,role,credit_limit_cents,commission_tier,verified_at', [role, creditLimitCents, commissionTier, verified, req.params.id]); if (!rows[0]) return res.status(404).json({ error: 'User not found' }); res.json({ user: rows[0] }) })
app.post('/api/admin/assets/signature', requireAuth(['admin', 'reseller']), async (_req, res) => { if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) return res.status(503).json({ error: 'Cloudinary storage is not configured' }); const timestamp = Math.floor(Date.now() / 1000); const signature = cloudinary.utils.api_sign_request({ timestamp, folder: 'aurora-mobility' }, process.env.CLOUDINARY_API_SECRET); res.json({ cloudName: process.env.CLOUDINARY_CLOUD_NAME, apiKey: process.env.CLOUDINARY_API_KEY, timestamp, folder: 'aurora-mobility', signature }) })

app.post('/api/inventory/:productId/reserve', requireAuth(), async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query("UPDATE inventory_units SET status = 'reserved' WHERE id = (SELECT id FROM inventory_units WHERE product_id = $1 AND status = 'available' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id, product_id, warehouse_code", [req.params.productId])
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'No available inventory' }) }
    await client.query('COMMIT')
    const event = `event: inventory.updated\ndata: ${JSON.stringify({ productId: rows[0].product_id, status: 'reserved' })}\n\n`
    for (const subscriber of inventoryClients) subscriber.write(event)
    res.status(201).json({ reservation: rows[0] })
  } catch { await client.query('ROLLBACK'); res.status(500).json({ error: 'Inventory reservation failed' }) } finally { client.release() }
})

app.get('/api/feeds/inventory.csv', requireAuth(['reseller', 'admin']), async (_req, res) => {
  const { rows } = await pool.query("SELECT p.sku, p.brand, p.model, p.storage_gb, p.ram_gb, p.color, p.wholesale_price_cents, p.retail_price_cents, COUNT(i.id) FILTER (WHERE i.status = 'available')::int AS stock FROM products p LEFT JOIN inventory_units i ON i.product_id = p.id WHERE p.active = true GROUP BY p.id ORDER BY p.sku")
  const csv = ['sku,brand,model,storage_gb,ram_gb,color,wholesale_price_cents,retail_price_cents,stock', ...rows.map((r) => Object.values(r).map((v) => JSON.stringify(v ?? '')).join(','))].join('\n')
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="aurora-inventory.csv"').send(csv)
})

app.get('/api/commissions/ledger', requireAuth(['reseller', 'admin']), async (req, res) => {
  const beneficiary = req.user.role === 'admin' && req.query.userId ? req.query.userId : req.user.id
  const { rows } = await pool.query('SELECT c.*, o.order_number FROM commissions c JOIN orders o ON o.id = c.order_id WHERE c.beneficiary_id = $1 ORDER BY c.created_at DESC', [beneficiary])
  res.json({ commissions: rows })
})

app.post('/api/orders/:orderId/commissions', requireAuth(['admin']), async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: order } = await client.query('SELECT id, subtotal_cents, reseller_id FROM orders WHERE id = $1 FOR UPDATE', [req.params.orderId])
    if (!order[0] || !order[0].reseller_id) return res.status(404).json({ error: 'Eligible reseller order not found' })
    const { rows: rule } = await client.query('SELECT id, rate_bps FROM commission_rules WHERE tier = (SELECT commission_tier FROM users WHERE id = $1) AND active = true', [order[0].reseller_id])
    if (!rule[0]) return res.status(422).json({ error: 'No active commission rule for beneficiary' })
    const amount = Math.floor(Number(order[0].subtotal_cents) * rule[0].rate_bps / 10000)
    const { rows: created } = await client.query('INSERT INTO commissions(order_id, beneficiary_id, rule_id, gross_sale_cents, rate_bps, amount_cents) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [order[0].id, order[0].reseller_id, rule[0].id, order[0].subtotal_cents, rule[0].rate_bps, amount])
    await client.query('COMMIT'); res.status(201).json({ commission: created[0] })
  } catch { await client.query('ROLLBACK'); res.status(500).json({ error: 'Commission calculation failed' }) } finally { client.release() }
})

app.post('/api/manifests', requireAuth(['admin']), async (req, res) => {
  const { invoiceId } = req.body
  if (!invoiceId) return res.status(400).json({ error: 'invoiceId is required' })
  // Queue a background PDF/XLSX job in production; never expose raw IMEIs to the browser by default.
  res.status(202).json({ status: 'queued', invoiceId, artifact: `/api/manifests/${invoiceId}/download`, integrity: 'SHA-256 per device row' })
})

app.listen(port, () => console.log(`Aurora API listening on http://localhost:${port}`))
