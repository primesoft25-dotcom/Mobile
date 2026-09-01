import crypto from 'node:crypto'

export function createEsewaPayload({ orderNumber, amount, successUrl, failureUrl }) {
  const secret = process.env.ESEWA_SECRET_KEY || (process.env.PAYMENT_MODE === 'demo' ? '8gBm/:&EnhH.1/q' : '')
  if (!secret) throw new Error('ESEWA_SECRET_KEY is not configured')
  const totalAmount = Number(amount).toFixed(2)
  const message = `total_amount=${totalAmount},transaction_uuid=${orderNumber},product_code=${process.env.ESEWA_PRODUCT_CODE || 'EPAYTEST'}`
  return { amount: totalAmount, tax_amount: '0', total_amount: totalAmount, transaction_uuid: orderNumber, product_code: process.env.ESEWA_PRODUCT_CODE || 'EPAYTEST', product_service_charge: '0', product_delivery_charge: '0', success_url: successUrl, failure_url: failureUrl, signed_field_names: 'total_amount,transaction_uuid,product_code', signature: crypto.createHmac('sha256', secret).update(message).digest('base64'), endpoint: process.env.ESEWA_ENDPOINT || 'https://rc-epay.esewa.com.np/api/epay/main/v2/form', sandbox: !process.env.ESEWA_SECRET_KEY }
}
export async function createKhaltiIntent({ amount, orderNumber, returnUrl }) {
  const secret = process.env.KHALTI_SECRET_KEY || (process.env.PAYMENT_MODE === 'demo' ? '05bf95cc57244045b8df5fad06748dab' : '')
  if (!secret) throw new Error('KHALTI_SECRET_KEY is not configured')
  const response = await fetch(process.env.KHALTI_ENDPOINT || 'https://a.khalti.com/api/v2/epayment/initiate/', { method: 'POST', headers: { Authorization: `Key ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ return_url: returnUrl, website_url: process.env.FRONTEND_ORIGIN, amount: Math.round(Number(amount) * 100), purchase_order_id: orderNumber, purchase_order_name: `Aurora Mobility ${orderNumber}` }) })
  if (!response.ok) throw new Error(`Khalti initiation failed (${response.status})`)
  return response.json()
}
export function safeSignature(value) { return crypto.createHmac('sha256', process.env.ESEWA_SECRET_KEY || process.env.KHALTI_SECRET_KEY || 'unconfigured').update(value).digest('hex') }
