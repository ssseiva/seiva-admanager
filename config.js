// config.js — configurações globais do Seiva Ad Manager
// SERVICE_TOKEN é atualizado automaticamente pelo setup-directus.mjs

export const DIRECTUS_URL = 'https://directus-production-afdd.up.railway.app'
export const SERVICE_TOKEN = '6ad00cdad8e44bd59e20e9897105b17d846ad6d81c27432faed5ddd8082a682e' // preenchido pelo setup

export const FERIADOS_BR = [
  // 2025
  '2025-01-01', // Confraternização Universal
  '2025-04-18', // Sexta-feira Santa
  '2025-04-21', // Tiradentes
  '2025-05-01', // Dia do Trabalho
  '2025-09-07', // Independência do Brasil
  '2025-10-12', // Nossa Senhora Aparecida
  '2025-11-02', // Finados
  '2025-11-15', // Proclamação da República
  '2025-11-20', // Consciência Negra
  '2025-12-25', // Natal
  // 2026
  '2026-01-01',
  '2026-04-03', // Sexta-feira Santa
  '2026-04-21',
  '2026-05-01',
  '2026-09-07',
  '2026-10-12',
  '2026-11-02',
  '2026-11-15',
  '2026-11-20',
  '2026-12-25',
  // 2027
  '2027-01-01',
  '2027-03-26', // Sexta-feira Santa
  '2027-04-21',
  '2027-05-01',
  '2027-09-07',
  '2027-10-12',
  '2027-11-02',
  '2027-11-15',
  '2027-11-20',
  '2027-12-25',
]

export const NEWSLETTERS = {
  aurora: { label: 'Aurora', color: '#dc2626', colorLight: '#fee2e2' },
  indice: { label: 'Índice', color: '#1e40af', colorLight: '#dbeafe' },
}

export const FORMATS = {
  destaque: { label: 'Destaque', icon: '★' },
  corpo: { label: 'Corpo do Email', icon: '◈' },
}

export const BOOKING_STATUS = {
  rascunho: { label: 'Rascunho', color: '#94a3b8', bg: '#f1f5f9' },
  pendente: { label: 'Pendente', color: '#b45309', bg: '#fef3c7' },
  aprovado: { label: 'Aprovado', color: '#15803d', bg: '#dcfce7' },
  rejeitado: { label: 'Rejeitado', color: '#b91c1c', bg: '#fee2e2' },
}

export function isDayBlocked(dateStr, adminBlockedDates = []) {
  // Fim de semana
  const d = new Date(dateStr + 'T12:00:00')
  if (d.getDay() === 0 || d.getDay() === 6) return true
  // Feriado nacional
  if (FERIADOS_BR.includes(dateStr)) return true
  // Bloqueio manual pelo admin
  if (adminBlockedDates.some(b => b.date === dateStr)) return true
  return false
}

export function isSlotFree(dateStr, newsletter, format, bookings) {
  return !bookings.some(b =>
    b.date === dateStr &&
    b.newsletter === newsletter &&
    b.format === format &&
    b.status !== 'rejeitado'
  )
}

export function getSlotStatus(dateStr, bookings) {
  // Retorna { aurora_destaque, aurora_corpo, indice_destaque, indice_corpo }
  // cada um pode ser: 'free', 'booked', 'own'
  const slots = {}
  for (const nl of ['aurora', 'indice']) {
    for (const fmt of ['destaque', 'corpo']) {
      const key = `${nl}_${fmt}`
      const booked = bookings.find(b =>
        b.date === dateStr && b.newsletter === nl && b.format === fmt && b.status !== 'rejeitado'
      )
      slots[key] = booked || null
    }
  }
  return slots
}

export function clientHasQuota(clientId, newsletter, format, quotas, bookings) {
  const now = new Date()
  const matching = quotas.filter(q =>
    q.client_id === clientId &&
    (q.newsletter === newsletter || q.newsletter === 'ambas') &&
    (q.format === format || q.format === 'ambos') &&
    (!q.expires_at || new Date(q.expires_at) >= now)
  )
  if (!matching.length) return { allowed: false, total: 0, used: 0 }
  const total = matching.reduce((s, q) => s + (q.total_slots || 0), 0)
  const used = bookings.filter(b =>
    b.client_id === clientId && b.status !== 'rejeitado'
  ).length
  return { allowed: used < total, total, used }
}

export function formatDate(dateStr) {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-')
  return `${d}/${m}/${y}`
}

export function toISODate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
