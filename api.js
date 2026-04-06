// api.js — wrapper para todas as chamadas ao Directus
import { DIRECTUS_URL, SERVICE_TOKEN } from './config.js'
import { getSession, refreshToken, logout } from './auth.js'

async function request(path, options = {}) {
  const session = getSession()
  const token = session?.accessToken
  if (!token) { logout(); return null }

  const res = await fetch(`${DIRECTUS_URL}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined,
  })

  // Token expirado: tenta refresh
  if (res.status === 401 && session?.refreshToken) {
    const refreshed = await refreshToken()
    if (refreshed) return request(path, options)
    logout()
    return null
  }

  const text = await res.text()
  if (!text) return null
  const data = JSON.parse(text)
  if (!res.ok) throw new Error(data.errors?.[0]?.message || `Erro ${res.status}`)
  return data.data
}

// ─── Bookings ─────────────────────────────────────────────────────────────────

export async function getBookings(filters = {}) {
  const params = new URLSearchParams()
  params.set('fields', 'id,date,newsletter,format,status,campaign_name,authorship,campaign,isbn,suggested_text,extra_info,promotional_period,cover_link,redirect_link,client_id')
  params.set('limit', '-1')
  params.set('sort', 'date')

  if (filters.clientId) params.set('filter[client_id][_eq]', filters.clientId)
  if (filters.dateFrom) params.set('filter[date][_gte]', filters.dateFrom)
  if (filters.dateTo) params.set('filter[date][_lte]', filters.dateTo)
  if (filters.status) params.set('filter[status][_eq]', filters.status)
  if (filters.newsletter) params.set('filter[newsletter][_eq]', filters.newsletter)
  if (filters.format) params.set('filter[format][_eq]', filters.format)

  return request(`/items/ad_bookings?${params}`)
}

export async function getBooking(id) {
  return request(`/items/ad_bookings/${id}?fields=id,date,newsletter,format,status,campaign_name,authorship,campaign,isbn,suggested_text,extra_info,promotional_period,cover_link,redirect_link,admin_notes,client_id`)
}

export async function createBooking(data) {
  return request('/items/ad_bookings', { method: 'POST', body: data })
}

export async function updateBooking(id, data) {
  return request(`/items/ad_bookings/${id}`, { method: 'PATCH', body: data })
}

export async function deleteBooking(id) {
  return request(`/items/ad_bookings/${id}`, { method: 'DELETE' })
}

// ─── Clientes ─────────────────────────────────────────────────────────────────

export async function getClients() {
  return request('/items/ad_clients?fields=id,company_name,access_code,username,password,contact_email,active,notes&sort=company_name&limit=-1')
}

export async function getClient(id) {
  return request(`/items/ad_clients/${id}`)
}

export async function createClient(data) {
  return request('/items/ad_clients', { method: 'POST', body: data })
}

export async function updateClient(id, data) {
  return request(`/items/ad_clients/${id}`, { method: 'PATCH', body: data })
}

// ─── Cotas ────────────────────────────────────────────────────────────────────

export async function getQuotas(clientId = null) {
  const filter = clientId ? `&filter[client_id][_eq]=${clientId}` : ''
  return request(`/items/ad_quotas?fields=id,client_id,newsletter,format,period,slots_per_period,total_slots,expires_at,notes&limit=-1${filter}`)
}

export async function createQuota(data) {
  return request('/items/ad_quotas', { method: 'POST', body: data })
}

export async function updateQuota(id, data) {
  return request(`/items/ad_quotas/${id}`, { method: 'PATCH', body: data })
}

export async function deleteQuota(id) {
  return request(`/items/ad_quotas/${id}`, { method: 'DELETE' })
}

// ─── Biblioteca (busca por ISBN) ──────────────────────────────────────────────

export async function getBookByISBN(isbn) {
  const clean = isbn.replace(/[^0-9Xx]/g, '')
  // Usa service token pois anunciantes não têm acesso direto à collection biblioteca
  const res = await fetch(`${DIRECTUS_URL}/items/biblioteca?filter[isbn][_eq]=${clean}&fields=isbn,titulo,autor,editora,sinopse,capa_url&limit=1`, {
    headers: { 'Authorization': `Bearer ${SERVICE_TOKEN}` },
  })
  if (!res.ok) return null
  const data = await res.json()
  return data?.data?.[0] || null
}

// ─── Datas Bloqueadas ─────────────────────────────────────────────────────────

export async function getBlockedDates() {
  return request('/items/ad_blocked_dates?fields=id,date,reason,is_holiday&limit=-1&sort=date')
}

export async function createBlockedDate(data) {
  return request('/items/ad_blocked_dates', { method: 'POST', body: data })
}

export async function updateBlockedDate(id, data) {
  return request(`/items/ad_blocked_dates/${id}`, { method: 'PATCH', body: data })
}

export async function deleteBlockedDate(id) {
  return request(`/items/ad_blocked_dates/${id}`, { method: 'DELETE' })
}
