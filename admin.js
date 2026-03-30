// admin.js — Painel administrativo (clientes, cotas, bookings, datas bloqueadas)
import { requireAuth, logout } from './auth.js'
import {
  getClients, createClient, updateClient,
  getQuotas, createQuota, updateQuota, deleteQuota,
  getBookings, updateBooking, deleteBooking,
  getBlockedDates, createBlockedDate, deleteBlockedDate,
} from './api.js'
import { NEWSLETTERS, FORMATS, BOOKING_STATUS, formatDate } from './config.js'

// ─── Auth: apenas admin e redator ────────────────────────────────────────────
const session = requireAuth('/index.html')
if (!session || (session.role !== 'admin' && session.role !== 'redator')) {
  alert('Acesso restrito a admin e redatores.')
  window.location.href = 'app.html'
  throw new Error('Unauthorized')
}

const isAdmin = session.role === 'admin'

document.getElementById('user-avatar').textContent =
  (session.userName || '?').substring(0, 2).toUpperCase()
document.getElementById('user-name').textContent = session.userName || 'Admin'
document.getElementById('user-role').textContent = isAdmin ? 'Admin' : 'Redator'
document.getElementById('btn-logout').addEventListener('click', logout)

// Hide edit-destructive actions for redatores
if (!isAdmin) {
  document.getElementById('btn-new-client').style.display = 'none'
}

// ─── State ────────────────────────────────────────────────────────────────────
let allClients = []
let allBookings = []
let allQuotas = []
let allBlockedDates = []
let selectedClientId = null
let editingClientId = null
let editingQuotaId = null
let editingBookingId = null

function showLoading(v) {
  document.getElementById('loading').style.display = v ? 'flex' : 'none'
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'))
    tab.classList.add('active')
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active')
  })
})

// ─── Init ─────────────────────────────────────────────────────────────────────
;(async () => {
  showLoading(true)
  try {
    const [clients, bookings, quotas, blocked] = await Promise.all([
      getClients(),
      getBookings(),
      getQuotas(),
      getBlockedDates(),
    ])
    allClients = clients || []
    allBookings = bookings || []
    allQuotas = quotas || []
    allBlockedDates = blocked || []

    renderClients()
    renderBookings()
    renderBlockedDates()
    populateClientFilter()
  } catch (e) {
    console.error(e)
    alert('Erro ao carregar dados: ' + e.message)
  }
  showLoading(false)
})()

// ─── Helpers ──────────────────────────────────────────────────────────────────
function openModal(id) { document.getElementById(id).classList.add('open') }
function closeModal(id) { document.getElementById(id).classList.remove('open') }
function showError(id, msg) {
  const el = document.getElementById(id)
  el.textContent = msg
  el.style.display = 'flex'
}
function clearError(id) { document.getElementById(id).style.display = 'none' }

document.querySelectorAll('.modal-overlay').forEach(el => {
  el.addEventListener('click', e => {
    if (e.target === el) closeModal(el.id)
  })
})

function clientName(clientId) {
  return allClients.find(c => c.id === clientId)?.company_name || `#${clientId}`
}

function usedSlots(clientId) {
  return allBookings.filter(b => b.client_id === clientId && b.status !== 'rejeitado').length
}

// ─── CLIENTS ──────────────────────────────────────────────────────────────────
function renderClients() {
  const tbody = document.getElementById('clients-tbody')
  if (!allClients.length) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="empty-state-icon">👥</div><div class="empty-state-title">Nenhum cliente</div><div class="empty-state-desc">Clique em "+ Novo Cliente" para começar.</div></div></td></tr>'
    return
  }

  tbody.innerHTML = allClients.map(c => {
    const quotaCount = allQuotas.filter(q => q.client_id === c.id).length
    const used = usedSlots(c.id)
    return `
      <tr>
        <td><strong>${c.company_name}</strong></td>
        <td><code style="font-size:.8rem;background:var(--bg);padding:2px 6px;border-radius:3px;border:1px solid var(--border)">${c.username || c.access_code}</code></td>
        <td class="text-muted">${c.contact_email || '—'}</td>
        <td><span class="badge ${c.active ? 'badge-aprovado' : 'badge-rejeitado'}">${c.active ? 'Ativo' : 'Inativo'}</span></td>
        <td class="text-muted">${quotaCount} cota${quotaCount !== 1 ? 's' : ''} · ${used} uso${used !== 1 ? 's' : ''}</td>
        <td>
          <div class="td-actions">
            <button class="btn btn-secondary btn-sm" onclick="viewClientQuotas(${c.id})">Cotas</button>
            ${isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="editClient(${c.id})">Editar</button>` : ''}
          </div>
        </td>
      </tr>`
  }).join('')
}

window.viewClientQuotas = function(clientId) {
  selectedClientId = clientId
  const client = allClients.find(c => c.id === clientId)
  document.getElementById('client-quotas-section').style.display = 'block'
  document.getElementById('client-quotas-title').textContent = `Cotas — ${client?.company_name}`
  renderQuotas(clientId)
  document.getElementById('client-quotas-section').scrollIntoView({ behavior: 'smooth' })
}

window.editClient = function(clientId) {
  if (!isAdmin) return
  const client = allClients.find(c => c.id === clientId)
  if (!client) return
  editingClientId = clientId
  document.getElementById('client-modal-title').textContent = 'Editar Cliente'
  document.getElementById('c-company').value = client.company_name || ''
  document.getElementById('c-username').value = client.username || ''
  document.getElementById('c-password').value = client.password || ''
  document.getElementById('c-email').value = client.contact_email || ''
  document.getElementById('c-notes').value = client.notes || ''
  document.getElementById('c-active').checked = client.active !== false
  clearError('client-error')
  openModal('client-modal')
}

// New client button
document.getElementById('btn-new-client').addEventListener('click', () => {
  if (!isAdmin) return
  editingClientId = null
  document.getElementById('client-modal-title').textContent = 'Novo Cliente'
  document.getElementById('c-company').value = ''
  document.getElementById('c-username').value = ''
  document.getElementById('c-password').value = ''
  document.getElementById('c-email').value = ''
  document.getElementById('c-notes').value = ''
  document.getElementById('c-active').checked = true
  clearError('client-error')
  openModal('client-modal')
})

// Close client modal
document.getElementById('client-modal-close').addEventListener('click', () => closeModal('client-modal'))
document.getElementById('btn-client-cancel').addEventListener('click', () => closeModal('client-modal'))

// Save client
document.getElementById('btn-client-save').addEventListener('click', async () => {
  if (!isAdmin) return
  const company = document.getElementById('c-company').value.trim()
  const username = document.getElementById('c-username').value.trim()
  const password = document.getElementById('c-password').value.trim()
  const email = document.getElementById('c-email').value.trim()
  const notes = document.getElementById('c-notes').value.trim()
  const active = document.getElementById('c-active').checked
  clearError('client-error')

  if (!company) return showError('client-error', 'Informe o nome da empresa.')
  if (!username) return showError('client-error', 'Informe o username.')
  if (!password) return showError('client-error', 'Informe a senha.')

  // Check uniqueness
  const duplicate = allClients.find(c => c.username === username && c.id !== editingClientId)
  if (duplicate) return showError('client-error', 'Este username já está em uso por outro cliente.')

  const btn = document.getElementById('btn-client-save')
  btn.disabled = true
  btn.textContent = 'Salvando...'
  try {
    const data = { company_name: company, username, password, contact_email: email || null, notes: notes || null, active }
    if (editingClientId) {
      await updateClient(editingClientId, data)
      const idx = allClients.findIndex(c => c.id === editingClientId)
      if (idx > -1) allClients[idx] = { ...allClients[idx], ...data }
    } else {
      const created = await createClient(data)
      if (created) allClients.push(created)
    }
    renderClients()
    populateClientFilter()
    closeModal('client-modal')
  } catch (e) {
    showError('client-error', e.message || 'Erro ao salvar cliente.')
  } finally {
    btn.disabled = false
    btn.textContent = 'Salvar'
  }
})

// ─── QUOTAS ───────────────────────────────────────────────────────────────────
function renderQuotas(clientId) {
  const tbody = document.getElementById('quotas-tbody')
  const quotas = allQuotas.filter(q => q.client_id === clientId)

  if (!quotas.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-muted" style="text-align:center;padding:1.5rem">Nenhuma cota. Clique em "+ Nova Cota".</td></tr>'
    return
  }

  const nlLabels = { aurora: 'Aurora', indice: 'Índice', ambas: 'Ambas' }
  const fmtLabels = { destaque: 'Destaque', corpo: 'Corpo', ambos: 'Ambos' }
  const periodLabels = { semanal: '/semana', mensal: '/mês', livre: 'livre' }

  tbody.innerHTML = quotas.map(q => {
    const used = allBookings.filter(b =>
      b.client_id === clientId &&
      b.status !== 'rejeitado' &&
      (q.newsletter === b.newsletter || q.newsletter === 'ambas') &&
      (q.format === b.format || q.format === 'ambos')
    ).length
    const remaining = Math.max(0, q.total_slots - used)
    const pct = q.total_slots > 0 ? Math.min(100, Math.round(used / q.total_slots * 100)) : 0
    const expired = q.expires_at && new Date(q.expires_at) < new Date()
    const freqLabel = q.period && q.period !== 'livre' && q.slots_per_period
      ? `<span class="text-muted" style="font-size:.8rem">${q.slots_per_period}${periodLabels[q.period] || ''}</span>`
      : q.period === 'livre' ? '<span class="text-muted" style="font-size:.8rem">livre</span>' : '—'
    return `
      <tr>
        <td><span class="badge badge-${q.newsletter === 'indice' ? 'indice' : 'aurora'}">${nlLabels[q.newsletter] || q.newsletter}</span></td>
        <td>${fmtLabels[q.format] || q.format}</td>
        <td>${freqLabel}</td>
        <td>${q.total_slots}</td>
        <td>
          <div style="display:flex;align-items:center;gap:.5rem">
            <div class="quota-bar" style="width:60px"><div class="quota-bar-fill" style="width:${pct}%"></div></div>
            <span>${used}</span>
          </div>
        </td>
        <td><strong>${remaining}</strong></td>
        <td>${q.expires_at ? `<span class="${expired ? 'badge badge-rejeitado' : ''}">${formatDate(q.expires_at)}</span>` : '—'}</td>
        <td>
          <div class="td-actions">
            ${isAdmin ? `
              <button class="btn btn-ghost btn-sm" onclick="editQuota(${q.id})">Editar</button>
              <button class="btn btn-ghost btn-sm" onclick="removeQuota(${q.id})" style="color:var(--red)">✕</button>
            ` : ''}
          </div>
        </td>
      </tr>`
  }).join('')
}

window.editQuota = function(quotaId) {
  if (!isAdmin) return
  const quota = allQuotas.find(q => q.id === quotaId)
  if (!quota) return
  editingQuotaId = quotaId
  document.getElementById('quota-modal-title').textContent = 'Editar Cota'
  document.getElementById('q-newsletter').value = quota.newsletter || ''
  document.getElementById('q-format').value = quota.format || ''
  document.getElementById('q-period').value = quota.period || ''
  document.getElementById('q-per-period').value = quota.slots_per_period || ''
  togglePerPeriod(quota.period)
  document.getElementById('q-total').value = quota.total_slots || ''
  document.getElementById('q-expires').value = quota.expires_at || ''
  document.getElementById('q-notes').value = quota.notes || ''
  clearError('quota-error')
  openModal('quota-modal')
}

window.removeQuota = async function(quotaId) {
  if (!isAdmin) return
  if (!confirm('Remover esta cota?')) return
  try {
    showLoading(true)
    await deleteQuota(quotaId)
    allQuotas = allQuotas.filter(q => q.id !== quotaId)
    renderQuotas(selectedClientId)
    renderClients()
  } catch (e) {
    alert('Erro: ' + e.message)
  } finally {
    showLoading(false)
  }
}

function togglePerPeriod(period) {
  const group = document.getElementById('q-per-period-group')
  const hint = document.getElementById('q-per-period-hint')
  if (period && period !== 'livre') {
    group.style.display = 'block'
    hint.textContent = period === 'semanal' ? 'Ex: 1 = um insert por semana' : 'Ex: 3 = três inserts por mês'
  } else {
    group.style.display = 'none'
  }
}

document.getElementById('q-period').addEventListener('change', e => togglePerPeriod(e.target.value))

document.getElementById('btn-new-quota').addEventListener('click', () => {
  if (!isAdmin || !selectedClientId) return
  editingQuotaId = null
  document.getElementById('quota-modal-title').textContent = 'Nova Cota'
  document.getElementById('q-newsletter').value = ''
  document.getElementById('q-format').value = ''
  document.getElementById('q-period').value = ''
  document.getElementById('q-per-period').value = ''
  togglePerPeriod('')
  document.getElementById('q-total').value = ''
  document.getElementById('q-expires').value = ''
  document.getElementById('q-notes').value = ''
  clearError('quota-error')
  openModal('quota-modal')
})

document.getElementById('quota-modal-close').addEventListener('click', () => closeModal('quota-modal'))
document.getElementById('btn-quota-cancel').addEventListener('click', () => closeModal('quota-modal'))

document.getElementById('btn-quota-save').addEventListener('click', async () => {
  if (!isAdmin) return
  const newsletter = document.getElementById('q-newsletter').value
  const format = document.getElementById('q-format').value
  const period = document.getElementById('q-period').value
  const perPeriod = period && period !== 'livre' ? parseInt(document.getElementById('q-per-period').value) : null
  const total = parseInt(document.getElementById('q-total').value)
  const expires = document.getElementById('q-expires').value || null
  const notes = document.getElementById('q-notes').value.trim() || null
  clearError('quota-error')

  if (!newsletter) return showError('quota-error', 'Selecione a newsletter.')
  if (!format) return showError('quota-error', 'Selecione o formato.')
  if (!period) return showError('quota-error', 'Selecione a frequência.')
  if (period !== 'livre' && (!perPeriod || perPeriod < 1)) return showError('quota-error', 'Informe os slots por período.')
  if (!total || total < 1) return showError('quota-error', 'Informe o total de slots (mínimo 1).')

  const btn = document.getElementById('btn-quota-save')
  btn.disabled = true
  btn.textContent = 'Salvando...'
  try {
    const data = { client_id: selectedClientId, newsletter, format, period, slots_per_period: perPeriod, total_slots: total, expires_at: expires, notes }
    if (editingQuotaId) {
      await updateQuota(editingQuotaId, data)
      const idx = allQuotas.findIndex(q => q.id === editingQuotaId)
      if (idx > -1) allQuotas[idx] = { ...allQuotas[idx], ...data }
    } else {
      const created = await createQuota(data)
      if (created) allQuotas.push(created)
    }
    renderQuotas(selectedClientId)
    renderClients()
    closeModal('quota-modal')
  } catch (e) {
    showError('quota-error', e.message || 'Erro ao salvar cota.')
  } finally {
    btn.disabled = false
    btn.textContent = 'Salvar'
  }
})

// ─── BOOKINGS ─────────────────────────────────────────────────────────────────
function populateClientFilter() {
  const sel = document.getElementById('filter-client')
  const current = sel.value
  sel.innerHTML = '<option value="">Todos os clientes</option>'
  allClients.forEach(c => {
    sel.innerHTML += `<option value="${c.id}"${c.id == current ? ' selected' : ''}>${c.company_name}</option>`
  })
}

function renderBookings() {
  const status = document.getElementById('filter-status').value
  const nl = document.getElementById('filter-nl').value
  const clientId = document.getElementById('filter-client').value

  let filtered = allBookings
  if (status) filtered = filtered.filter(b => b.status === status)
  if (nl) filtered = filtered.filter(b => b.newsletter === nl)
  if (clientId) filtered = filtered.filter(b => String(b.client_id) === clientId)

  // Sort by date desc
  filtered = [...filtered].sort((a, b) => b.date.localeCompare(a.date))

  const tbody = document.getElementById('bookings-tbody')
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-title">Nenhum anúncio</div></div></td></tr>'
    return
  }

  tbody.innerHTML = filtered.map(b => {
    const nl = NEWSLETTERS[b.newsletter] || {}
    const fmt = FORMATS[b.format] || {}
    const st = BOOKING_STATUS[b.status] || {}
    return `
      <tr>
        <td><strong>${formatDate(b.date)}</strong></td>
        <td><span class="badge badge-${b.newsletter}">${nl.label || b.newsletter}</span></td>
        <td><span class="badge" style="background:var(--gray-light);color:var(--text-muted)">${fmt.label || b.format}</span></td>
        <td title="${b.suggested_text || ''}">${b.campaign_name || '—'}</td>
        <td class="text-muted">${clientName(b.client_id)}</td>
        <td>
          <select class="form-control" style="width:auto;font-size:.78rem;padding:.2rem .5rem"
            onchange="changeBookingStatus(${b.id}, this.value)">
            ${Object.entries(BOOKING_STATUS).map(([k, v]) =>
              `<option value="${k}"${k === b.status ? ' selected' : ''}>${v.label}</option>`
            ).join('')}
          </select>
        </td>
        <td>
          ${isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="editBookingAdmin(${b.id})">Editar</button>` : ''}
        </td>
      </tr>`
  }).join('')
}

window.changeBookingStatus = async function(bookingId, newStatus) {
  try {
    await updateBooking(bookingId, { status: newStatus })
    const idx = allBookings.findIndex(b => b.id === bookingId)
    if (idx > -1) allBookings[idx].status = newStatus
  } catch (e) {
    alert('Erro ao alterar status: ' + e.message)
  }
}

window.editBookingAdmin = function(bookingId) {
  if (!isAdmin) return
  const b = allBookings.find(x => x.id === bookingId)
  if (!b) return
  editingBookingId = bookingId
  document.getElementById('be-title').textContent = `Editar — ${b.campaign_name || 'Anúncio'}`
  document.getElementById('be-status').value = b.status || 'pendente'
  document.getElementById('be-date').value = b.date || ''
  document.getElementById('be-newsletter').value = b.newsletter || ''
  document.getElementById('be-format').value = b.format || ''
  document.getElementById('be-admin-notes').value = b.admin_notes || ''
  clearError('be-error')
  openModal('booking-edit-modal')
}

document.getElementById('be-modal-close').addEventListener('click', () => closeModal('booking-edit-modal'))
document.getElementById('btn-be-cancel').addEventListener('click', () => closeModal('booking-edit-modal'))

document.getElementById('btn-be-save').addEventListener('click', async () => {
  if (!isAdmin || !editingBookingId) return
  const data = {
    status: document.getElementById('be-status').value,
    date: document.getElementById('be-date').value,
    newsletter: document.getElementById('be-newsletter').value,
    format: document.getElementById('be-format').value,
    admin_notes: document.getElementById('be-admin-notes').value.trim() || null,
  }
  const btn = document.getElementById('btn-be-save')
  btn.disabled = true; btn.textContent = 'Salvando...'
  try {
    await updateBooking(editingBookingId, data)
    const idx = allBookings.findIndex(b => b.id === editingBookingId)
    if (idx > -1) allBookings[idx] = { ...allBookings[idx], ...data }
    renderBookings()
    closeModal('booking-edit-modal')
  } catch (e) {
    showError('be-error', e.message || 'Erro ao salvar.')
  } finally {
    btn.disabled = false; btn.textContent = 'Salvar'
  }
})

document.getElementById('btn-be-delete').addEventListener('click', async () => {
  if (!isAdmin || !editingBookingId) return
  if (!confirm('Excluir este anúncio definitivamente?')) return
  try {
    showLoading(true)
    await deleteBooking(editingBookingId)
    allBookings = allBookings.filter(b => b.id !== editingBookingId)
    renderBookings()
    closeModal('booking-edit-modal')
  } catch (e) {
    alert('Erro: ' + e.message)
  } finally {
    showLoading(false)
  }
})

// Filters
document.getElementById('filter-status').addEventListener('change', renderBookings)
document.getElementById('filter-nl').addEventListener('change', renderBookings)
document.getElementById('filter-client').addEventListener('change', renderBookings)

// ─── BLOCKED DATES ────────────────────────────────────────────────────────────
function renderBlockedDates() {
  const tbody = document.getElementById('blocked-dates-tbody')
  if (!allBlockedDates.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-muted" style="text-align:center;padding:1.5rem">Nenhuma data bloqueada manualmente.</td></tr>'
    return
  }
  const sorted = [...allBlockedDates].sort((a, b) => a.date.localeCompare(b.date))
  tbody.innerHTML = sorted.map(d => `
    <tr>
      <td><strong>${formatDate(d.date)}</strong></td>
      <td class="text-muted">${d.reason || '—'}</td>
      <td>${d.is_holiday ? '<span class="badge badge-pendente">Feriado</span>' : '<span class="badge badge-rascunho">Bloqueio manual</span>'}</td>
      <td>${isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="removeBlockedDate(${d.id})" style="color:var(--red)">Remover</button>` : ''}</td>
    </tr>`).join('')
}

window.removeBlockedDate = async function(id) {
  if (!isAdmin) return
  if (!confirm('Remover este bloqueio?')) return
  try {
    showLoading(true)
    await deleteBlockedDate(id)
    allBlockedDates = allBlockedDates.filter(d => d.id !== id)
    renderBlockedDates()
  } catch (e) {
    alert('Erro: ' + e.message)
  } finally {
    showLoading(false)
  }
}

document.getElementById('btn-new-blocked').addEventListener('click', () => {
  if (!isAdmin) return
  document.getElementById('bd-date').value = ''
  document.getElementById('bd-reason').value = ''
  document.getElementById('bd-is-holiday').checked = false
  clearError('blocked-error')
  openModal('blocked-modal')
})

document.getElementById('blocked-modal-close').addEventListener('click', () => closeModal('blocked-modal'))
document.getElementById('btn-blocked-cancel').addEventListener('click', () => closeModal('blocked-modal'))

document.getElementById('btn-blocked-save').addEventListener('click', async () => {
  if (!isAdmin) return
  const date = document.getElementById('bd-date').value
  const reason = document.getElementById('bd-reason').value.trim()
  const isHoliday = document.getElementById('bd-is-holiday').checked
  clearError('blocked-error')

  if (!date) return showError('blocked-error', 'Selecione uma data.')
  if (allBlockedDates.some(d => d.date === date)) return showError('blocked-error', 'Esta data já está bloqueada.')

  const btn = document.getElementById('btn-blocked-save')
  btn.disabled = true; btn.textContent = 'Bloqueando...'
  try {
    const created = await createBlockedDate({ date, reason: reason || null, is_holiday: isHoliday })
    if (created) allBlockedDates.push(created)
    renderBlockedDates()
    closeModal('blocked-modal')
  } catch (e) {
    showError('blocked-error', e.message || 'Erro ao bloquear data.')
  } finally {
    btn.disabled = false; btn.textContent = 'Bloquear'
  }
})
