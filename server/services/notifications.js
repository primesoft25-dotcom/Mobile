import nodemailer from 'nodemailer'

const transporter = process.env.SMTP_HOST ? nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true', auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined }) : null

export async function sendOrderNotification({ to, orderNumber, total, type = 'confirmation', message }) {
  const text = message || `Your Aurora order ${orderNumber} has been ${type}. Total: ${total}.`
  if (!transporter) { console.info(`[notification:sandbox] ${type} queued for ${to} (${orderNumber}): ${text}`); return { queued: true, sandbox: true } }
  return transporter.sendMail({ from: process.env.SMTP_FROM || 'orders@auroramobility.com', to, subject: `Aurora Mobility · ${type} · ${orderNumber}`, text })
}
