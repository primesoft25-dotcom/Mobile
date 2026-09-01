const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000'

export async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error || `Request failed (${response.status})`)
  }
  return response.status === 204 ? null : response.json()
}

export const api = {
  catalog: (search = '') => apiRequest(`/api/catalog${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  login: (email, password) => apiRequest('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  register: (payload) => apiRequest('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) }),
  verifyEmail: (email, code) => apiRequest('/api/auth/verify-email', { method: 'POST', body: JSON.stringify({ email, code }) }),
  resendEmailCode: (email) => apiRequest('/api/auth/verify-email/resend', { method: 'POST', body: JSON.stringify({ email }) }),
  requestPasswordReset: (email) => apiRequest('/api/auth/password-reset/request', { method: 'POST', body: JSON.stringify({ email }) }),
  me: () => apiRequest('/api/auth/me'),
  logout: () => apiRequest('/api/auth/logout', { method: 'POST' }),
  ledger: () => apiRequest('/api/commissions/ledger'),
  createManifest: (invoiceId) => apiRequest('/api/manifests', { method: 'POST', body: JSON.stringify({ invoiceId }) }),
  feedUrl: `${API_BASE}/api/feeds/inventory.csv`,
  paymentIntent: (provider, payload) => apiRequest(`/api/payments/${provider}/intents`, { method: 'POST', body: JSON.stringify(payload) }),
  verifyPayment: (provider, payload) => apiRequest(`/api/payments/${provider}/verify`, { method: 'POST', body: JSON.stringify(payload) }),
  createOrder: (payload) => apiRequest('/api/orders', { method: 'POST', body: JSON.stringify(payload) }),
  adminProducts: () => apiRequest('/api/admin/products'),
  createAdminProduct: (payload) => apiRequest('/api/admin/products', { method: 'POST', body: JSON.stringify(payload) }),
  adminUsers: () => apiRequest('/api/admin/users'),
  updateAdminUser: (id, payload) => apiRequest(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
}

export function subscribeToInventory(onUpdate, onError) {
  const events = new EventSource(`${API_BASE}/api/inventory/events`, { withCredentials: true })
  events.addEventListener('inventory.updated', (event) => onUpdate(JSON.parse(event.data)))
  events.onerror = onError
  return () => events.close()
}

export async function downloadInventoryFeed() {
  const response = await fetch(api.feedUrl, { credentials: 'include' })
  if (!response.ok) throw new Error('Sign in as a reseller before downloading the live feed')
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'aurora-inventory.csv'
  link.click()
  URL.revokeObjectURL(url)
}
