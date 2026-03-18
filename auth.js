// auth.js — autenticação (anunciante via código, staff via Directus)
import { DIRECTUS_URL, SERVICE_TOKEN } from './config.js'

const SESSION_KEY = 'seiva_admanager_session'

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveSession(data) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(data))
}

export function logout() {
  localStorage.removeItem(SESSION_KEY)
  window.location.href = '/index.html'
}

export function requireAuth(redirectTo = '/index.html') {
  const session = getSession()
  if (!session) {
    window.location.href = redirectTo
    return null
  }
  return session
}

// Login unificado: tenta staff primeiro, depois anunciante
export async function loginUnified(username, password) {
  // Tenta login Directus com username@seiva.com.br
  try {
    const email = username.includes('@') ? username : `${username}@seiva.com.br`
    const res = await fetch(`${DIRECTUS_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (res.ok) {
      const data = await res.json()
      const { access_token, refresh_token } = data.data
      const meRes = await fetch(`${DIRECTUS_URL}/users/me?fields=id,email,first_name,role.name`, {
        headers: { Authorization: `Bearer ${access_token}` },
      })
      const me = await meRes.json()
      const roleName = me.data?.role?.name?.toLowerCase() || 'staff'
      saveSession({
        role: roleName === 'administrator' ? 'admin' : 'redator',
        userId: me.data?.id,
        userName: me.data?.first_name || username,
        accessToken: access_token,
        refreshToken: refresh_token,
      })
      return { role: roleName }
    }
  } catch { /* tenta anunciante */ }

  // Tenta login de anunciante via ad_clients (username + password)
  const res = await fetch(
    `${DIRECTUS_URL}/items/ad_clients?filter[username][_eq]=${encodeURIComponent(username)}&filter[active][_eq]=true&fields=id,company_name,username,password`,
    { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } }
  )
  if (!res.ok) throw new Error('Usuário ou senha inválidos')
  const data = await res.json()
  const client = data.data?.find(c => c.password === password)
  if (!client) throw new Error('Usuário ou senha inválidos')

  saveSession({
    role: 'anunciante',
    clientId: client.id,
    clientName: client.company_name,
    accessToken: SERVICE_TOKEN,
  })
  return { role: 'anunciante' }
}

// Mantidos para compatibilidade
export async function loginAnunciante(code) {
  const trimmed = code.trim().toUpperCase()
  const res = await fetch(
    `${DIRECTUS_URL}/items/ad_clients?filter[access_code][_eq]=${encodeURIComponent(trimmed)}&filter[active][_eq]=true&fields=id,company_name,access_code`,
    { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } }
  )
  if (!res.ok) throw new Error('Erro ao verificar código')
  const data = await res.json()
  if (!data.data?.length) throw new Error('Código inválido ou conta inativa')
  const client = data.data[0]
  saveSession({ role: 'anunciante', clientId: client.id, clientName: client.company_name, accessToken: SERVICE_TOKEN })
  return client
}

export async function loginStaff(email, password) {
  const res = await fetch(`${DIRECTUS_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.errors?.[0]?.message || 'Credenciais inválidas')
  const { access_token, refresh_token } = data.data
  const meRes = await fetch(`${DIRECTUS_URL}/users/me?fields=id,email,first_name,role.name,role.id`, {
    headers: { Authorization: `Bearer ${access_token}` },
  })
  const me = await meRes.json()
  const roleName = me.data?.role?.name?.toLowerCase() || 'staff'
  saveSession({
    role: roleName === 'administrator' ? 'admin' : 'redator',
    userId: me.data?.id,
    userName: me.data?.first_name || email,
    accessToken: access_token,
    refreshToken: refresh_token,
  })
  return { role: roleName, name: me.data?.first_name }
}

// Refresh do token (staff)
export async function refreshToken() {
  const session = getSession()
  if (!session?.refreshToken) return false
  try {
    const res = await fetch(`${DIRECTUS_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    })
    if (!res.ok) return false
    const data = await res.json()
    saveSession({ ...session, accessToken: data.data.access_token, refreshToken: data.data.refresh_token })
    return true
  } catch {
    return false
  }
}
