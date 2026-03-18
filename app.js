// app.js — Calendário principal + modal de booking
import { requireAuth, logout } from './auth.js'
import {
  getBookings, createBooking, updateBooking, deleteBooking,
  getQuotas, getBlockedDates,
} from './api.js'
import {
  NEWSLETTERS, FORMATS, BOOKING_STATUS,
  isDayBlocked, isSlotFree, getSlotStatus, clientHasQuota, formatDate, toISODate,
} from './config.js'

// ─── Session ──────────────────────────────────────────────────────────────────
const session = requireAuth('/index.html')
if (!session) throw new Error('Not authenticated')

const isAdmin = session.role === 'admin'
const isRedator = session.role === 'redator'
const isAnunciante = session.role === 'anunciante'
const canEdit = isAdmin || isRedator
const canBook = isAdmin || isAnunciante

// ─── UI setup ─────────────────────────────────────────────────────────────────
const initials = (session.clientName || session.userName || '?').substring(0, 2).toUpperCase()
document.getElementById('user-avatar').textContent = initials
document.getElementById('user-name').textContent = session.clientName || session.userName || 'Usuário'
document.getElementById('user-role').textContent =
  isAdmin ? 'Admin' : isRedator ? 'Redator' : session.clientName

if (isAdmin) {
  document.getElementById('btn-admin').style.display = 'inline-flex'
}

document.getElementById('btn-admin').addEventListener('click', () => {
  window.location.href = 'admin.html'
})

document.getElementById('btn-logout').addEventListener('click', logout)

// ─── State ────────────────────────────────────────────────────────────────────
let allBookings = []
let allBlockedDates = []
let allQuotas = []
let calendar = null
let currentFilter = 'all'
let editingBookingId = null
let selectedDate = null

function showLoading(v) {
  document.getElementById('loading').style.display = v ? 'flex' : 'none'
}

// ─── Load data ────────────────────────────────────────────────────────────────
async function loadData() {
  showLoading(true)
  try {
    const [bookings, blocked, quotas] = await Promise.all([
      getBookings(isAnunciante ? { clientId: session.clientId } : {}),
      getBlockedDates(),
      isAnunciante ? getQuotas(session.clientId) : (isAdmin ? getQuotas() : []),
    ])

    // For anunciantes: also load all booking slots (date+newsletter+format+status only)
    // so we can show availability. We already have all bookings since service token reads all.
    // getBookings() with clientId filters only their bookings for display,
    // but we need ALL for availability check.
    let allForAvailability = bookings
    if (isAnunciante) {
      try {
        const allB = await getBookings({}) // service token returns all
        allForAvailability = allB || bookings
      } catch { /* ignore */ }
    }

    allBookings = isAnunciante ? allForAvailability : (bookings || [])
    allBlockedDates = blocked || []
    allQuotas = quotas || []

    // Store own bookings separately for anunciante display
    if (isAnunciante) {
      window._ownBookings = bookings || []
    }
  } catch (e) {
    console.error('Load error:', e)
  }
  showLoading(false)
  return true
}

// ─── Calendar ─────────────────────────────────────────────────────────────────
function buildEventColor(newsletter, format) {
  const nl = NEWSLETTERS[newsletter] || NEWSLETTERS.aurora
  if (format === 'destaque') return nl.color
  // corpo: lighter shade
  return nl.colorLight.replace(')', ', 1)')
}

function buildEvents() {
  const ownSet = isAnunciante ? new Set((window._ownBookings || []).map(b => b.id)) : null

  return allBookings
    .filter(b => {
      if (currentFilter !== 'all' && b.newsletter !== currentFilter) return false
      // Anunciante only sees own events on calendar
      if (isAnunciante && !ownSet?.has(b.id)) return false
      return true
    })
    .map(b => {
      const nl = NEWSLETTERS[b.newsletter] || {}
      const status = BOOKING_STATUS[b.status] || {}
      const isOwn = isAnunciante && ownSet?.has(b.id)
      const textColor = b.format === 'destaque' ? '#fff' : nl.color
      return {
        id: String(b.id),
        title: `${b.newsletter === 'aurora' ? 'A' : 'I'} ${b.format === 'destaque' ? '★' : '◈'} ${b.campaign_name || ''}`,
        start: b.date,
        backgroundColor: buildEventColor(b.newsletter, b.format),
        textColor,
        borderColor: nl.color,
        extendedProps: { booking: b, isOwn },
        editable: isAdmin, // only admin can drag
      }
    })
}

function renderSlotDots(dateStr) {
  const blocked = isDayBlocked(dateStr, allBlockedDates)
  const slots = getSlotStatus(dateStr, allBookings)

  const configs = [
    { key: 'aurora_destaque', cls: 'slot-aurora-d', label: 'A★' },
    { key: 'aurora_corpo', cls: 'slot-aurora-c', label: 'A◈' },
    { key: 'indice_destaque', cls: 'slot-indice-d', label: 'I★' },
    { key: 'indice_corpo', cls: 'slot-indice-c', label: 'I◈' },
  ]

  return configs
    .filter(c => {
      if (currentFilter === 'all') return true
      return c.key.startsWith(currentFilter)
    })
    .map(c => {
      const booking = slots[c.key]
      const state = blocked ? 'blocked' : (booking ? 'booked' : 'free')
      return `<span class="day-slot-dot ${state === 'booked' ? 'filled' : ''}" style="color:${state === 'blocked' ? 'var(--text-light)' : c.cls.includes('aurora') ? 'var(--aurora)' : 'var(--indice)'}"></span>`
    }).join('')
}

function initCalendar() {
  const el = document.getElementById('calendar')
  calendar = new FullCalendar.Calendar(el, {
    plugins: [],
    initialView: 'dayGridMonth',
    locale: 'pt-br',
    firstDay: 0,
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'dayGridMonth,dayGridWeek',
    },
    height: 'calc(100vh - 100px)',
    editable: isAdmin,
    droppable: isAdmin,
    events: buildEvents(),

    // Render slot dots below the day number (append after FullCalendar renders)
    dayCellDidMount: (arg) => {
      const dateStr = toISODate(arg.date)
      const dots = renderSlotDots(dateStr)
      const slotsEl = document.createElement('div')
      slotsEl.className = 'day-slots'
      slotsEl.innerHTML = dots
      arg.el.querySelector('.fc-daygrid-day-frame').appendChild(slotsEl)
    },

    dayCellClassNames: (arg) => {
      const dateStr = toISODate(arg.date)
      return isDayBlocked(dateStr, allBlockedDates) ? ['day-blocked'] : []
    },

    // Click on a day: open booking modal (if available + can book)
    dateClick: (info) => {
      const dateStr = toISODate(info.date)
      if (isDayBlocked(dateStr, allBlockedDates)) return
      showSidebar(dateStr)
      if (canBook) {
        openBookingModal(dateStr, null)
      }
    },

    // Click on an event: show detail / edit
    eventClick: (info) => {
      const booking = info.event.extendedProps.booking
      if (canEdit) {
        openBookingModal(booking.date, booking)
      } else {
        openDetailModal(booking)
      }
    },

    // Admin drag-and-drop
    eventDrop: async (info) => {
      if (!isAdmin) { info.revert(); return }
      const booking = info.event.extendedProps.booking
      const newDate = toISODate(info.event.start)

      if (isDayBlocked(newDate, allBlockedDates)) {
        alert('Não é possível mover para um dia bloqueado ou fim de semana.')
        info.revert()
        return
      }

      if (!isSlotFree(newDate, booking.newsletter, booking.format, allBookings.filter(b => b.id !== booking.id))) {
        alert(`O slot ${NEWSLETTERS[booking.newsletter]?.label} ${FORMATS[booking.format]?.label} já está ocupado em ${formatDate(newDate)}.`)
        info.revert()
        return
      }

      try {
        showLoading(true)
        await updateBooking(booking.id, { date: newDate })
        booking.date = newDate
        const idx = allBookings.findIndex(b => b.id === booking.id)
        if (idx > -1) allBookings[idx].date = newDate
        showLoading(false)
      } catch (e) {
        showLoading(false)
        alert('Erro ao mover anúncio: ' + e.message)
        info.revert()
      }
    },
  })

  calendar.render()
}

function refreshCalendar() {
  if (!calendar) return
  calendar.removeAllEvents()
  calendar.addEventSource(buildEvents())
  calendar.render()
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function showSidebar(dateStr) {
  selectedDate = dateStr
  const blocked = isDayBlocked(dateStr, allBlockedDates)
  const d = new Date(dateStr + 'T12:00:00')
  const weekdays = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
  const months = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

  document.getElementById('sidebar-date').textContent =
    `${weekdays[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]}.`

  const statusText = document.getElementById('sidebar-status-text')
  if (blocked) {
    statusText.textContent = '🚫 Dia bloqueado'
    document.getElementById('sidebar-body').innerHTML = `<div class="alert alert-warn">Este dia está bloqueado para veiculação.</div>`
    return
  }
  statusText.textContent = ''

  const slots = getSlotStatus(dateStr, allBookings)
  const ownSet = isAnunciante ? new Set((window._ownBookings || []).map(b => b.id)) : null

  const nl_format = [
    { key: 'aurora_destaque', nl: 'aurora', fmt: 'destaque', cls: 'slot-aurora-d' },
    { key: 'aurora_corpo', nl: 'aurora', fmt: 'corpo', cls: 'slot-aurora-c' },
    { key: 'indice_destaque', nl: 'indice', fmt: 'destaque', cls: 'slot-indice-d' },
    { key: 'indice_corpo', nl: 'indice', fmt: 'corpo', cls: 'slot-indice-c' },
  ]

  let html = '<div class="slot-grid">'
  for (const s of nl_format) {
    const booking = slots[s.key]
    const nlLabel = NEWSLETTERS[s.nl]?.label || s.nl
    const fmtLabel = FORMATS[s.fmt]?.label || s.fmt
    const fmtIcon = FORMATS[s.fmt]?.icon || ''
    const state = booking ? 'booked' : 'free'

    let label = `${nlLabel} ${fmtIcon}`
    let title = booking
      ? (isAnunciante && !ownSet?.has(booking.id)
          ? `${nlLabel} ${fmtLabel}: Ocupado`
          : `${booking.campaign_name} (${BOOKING_STATUS[booking.status]?.label || booking.status})`)
      : `${nlLabel} ${fmtLabel}: Disponível`

    let clickable = ''
    if (canBook && !booking) {
      clickable = `data-book-nl="${s.nl}" data-book-fmt="${s.fmt}" style="cursor:pointer"`
    } else if (booking && (canEdit || (isAnunciante && ownSet?.has(booking.id)))) {
      clickable = `data-view-id="${booking.id}" style="cursor:pointer"`
    }

    const isOtherClient = isAnunciante && booking && !ownSet?.has(booking.id)
    html += `<div class="slot-item ${state} ${s.cls}" ${clickable} title="${title}">`
    html += `<span>${label}</span>`
    if (booking) {
      if (isOtherClient) {
        html += `<span style="margin-left:auto; font-size:.65rem; color:var(--text-light)">indisponível</span>`
      } else {
        const statusColor = BOOKING_STATUS[booking.status]?.color || '#999'
        html += `<span style="margin-left:auto; font-size:.65rem; background:${BOOKING_STATUS[booking.status]?.bg};color:${statusColor};padding:1px 5px;border-radius:3px">${BOOKING_STATUS[booking.status]?.label || booking.status}</span>`
      }
    } else {
      html += `<span style="margin-left:auto; font-size:.68rem; color:var(--text-light)">livre</span>`
    }
    html += '</div>'
  }
  html += '</div>'

  if (canBook && !blocked) {
    html += `<button class="btn btn-primary btn-block mt" id="btn-new-booking">+ Novo Anúncio</button>`
  }

  document.getElementById('sidebar-body').innerHTML = html

  // Slot click: open pre-filled modal
  document.querySelectorAll('[data-book-nl]').forEach(el => {
    el.addEventListener('click', () => {
      openBookingModal(dateStr, null, el.dataset.bookNl, el.dataset.bookFmt)
    })
  })

  document.querySelectorAll('[data-view-id]').forEach(el => {
    el.addEventListener('click', () => {
      const b = allBookings.find(x => String(x.id) === el.dataset.viewId)
      if (!b) return
      if (canEdit || (isAnunciante && ownSet?.has(b.id))) {
        if (canEdit) openBookingModal(b.date, b)
        else openDetailModal(b)
      }
    })
  })

  document.getElementById('btn-new-booking')?.addEventListener('click', () => {
    openBookingModal(dateStr, null)
  })
}

// ─── Booking Modal ────────────────────────────────────────────────────────────
function openBookingModal(dateStr, booking = null, preNl = null, preFmt = null) {
  editingBookingId = booking?.id || null
  const isEditing = !!editingBookingId

  document.getElementById('modal-title').textContent = isEditing ? 'Editar Anúncio' : 'Novo Anúncio'
  document.getElementById('f-date').value = formatDate(dateStr)
  document.getElementById('f-date').dataset.iso = dateStr
  document.getElementById('f-newsletter').value = booking?.newsletter || preNl || ''
  document.getElementById('f-format').value = booking?.format || preFmt || ''
  document.getElementById('f-campaign-name').value = booking?.campaign_name || ''
  document.getElementById('f-authorship').value = booking?.authorship || ''
  document.getElementById('f-campaign').value = booking?.campaign || ''
  document.getElementById('f-suggested-text').value = booking?.suggested_text || ''
  document.getElementById('f-promotional-period').value = booking?.promotional_period || ''
  document.getElementById('f-cover-link').value = booking?.cover_link || ''
  document.getElementById('f-redirect-link').value = booking?.redirect_link || ''
  updateCharCounter()

  // Admin/redator: show extra fields
  const adminSection = document.getElementById('admin-notes-section')
  if (canEdit) {
    adminSection.style.display = 'block'
    document.getElementById('f-admin-notes').value = booking?.admin_notes || ''
    document.getElementById('f-status').value = booking?.status || 'pendente'
  } else {
    adminSection.style.display = 'none'
  }

  // Delete button
  document.getElementById('btn-delete-booking').style.display =
    isEditing && isAdmin ? 'inline-flex' : 'none'

  // Anunciante read-only for approved bookings
  const isReadOnly = isAnunciante && booking && ['aprovado', 'rejeitado'].includes(booking?.status)
  document.getElementById('btn-modal-save').style.display = isReadOnly ? 'none' : 'inline-flex'

  clearFormErrors()
  updateSlotWarning(
    dateStr,
    document.getElementById('f-newsletter').value,
    document.getElementById('f-format').value,
    editingBookingId
  )
  updateQuotaInfo()

  openModal('booking-modal')

  // Live update slot warning when newsletter/format changes
  document.getElementById('f-newsletter').onchange = () => {
    updateSlotWarning(
      document.getElementById('f-date').dataset.iso,
      document.getElementById('f-newsletter').value,
      document.getElementById('f-format').value,
      editingBookingId
    )
    updateQuotaInfo()
  }
  document.getElementById('f-format').onchange = document.getElementById('f-newsletter').onchange
}

function updateSlotWarning(dateStr, newsletter, format, excludeId = null) {
  const el = document.getElementById('form-slot-warning')
  if (!newsletter || !format || !dateStr) { el.style.display = 'none'; return }
  const others = allBookings.filter(b => String(b.id) !== String(excludeId))
  if (!isSlotFree(dateStr, newsletter, format, others)) {
    el.textContent = `⚠ O slot ${NEWSLETTERS[newsletter]?.label} — ${FORMATS[format]?.label} já está ocupado neste dia.`
    el.style.display = 'flex'
  } else {
    el.style.display = 'none'
  }
}

function updateQuotaInfo() {
  const el = document.getElementById('form-quota-info')
  if (!isAnunciante || !allQuotas.length) { el.style.display = 'none'; return }
  const nl = document.getElementById('f-newsletter').value
  const fmt = document.getElementById('f-format').value
  if (!nl || !fmt) { el.style.display = 'none'; return }
  const q = clientHasQuota(session.clientId, nl, fmt, allQuotas, allBookings)
  el.textContent = `Sua cota: ${q.used}/${q.total} slots utilizados${q.allowed ? '' : ' — COTA ESGOTADA'}`
  el.style.display = 'flex'
  el.className = `alert mt ${q.allowed ? 'alert-info' : 'alert-error'}`
}

function updateCharCounter() {
  const text = document.getElementById('f-suggested-text').value
  const len = text.length
  const el = document.getElementById('char-counter')
  el.textContent = `${len} / 500 caracteres`
  el.className = 'char-counter ' + (len < 200 ? 'warn' : len > 500 ? 'error' : 'ok')
}

document.getElementById('f-suggested-text').addEventListener('input', updateCharCounter)

function clearFormErrors() {
  document.getElementById('form-error').style.display = 'none'
}

// Save booking
document.getElementById('btn-modal-save').addEventListener('click', async () => {
  const dateStr = document.getElementById('f-date').dataset.iso
  const newsletter = document.getElementById('f-newsletter').value
  const format = document.getElementById('f-format').value
  const campaignName = document.getElementById('f-campaign-name').value.trim()
  const authorship = document.getElementById('f-authorship').value.trim()
  const campaign = document.getElementById('f-campaign').value.trim()
  const suggestedText = document.getElementById('f-suggested-text').value.trim()
  const promotionalPeriod = document.getElementById('f-promotional-period').value.trim()
  const coverLink = document.getElementById('f-cover-link').value.trim()
  const redirectLink = document.getElementById('f-redirect-link').value.trim()
  const adminNotes = document.getElementById('f-admin-notes').value.trim()
  const status = document.getElementById('f-status').value || 'pendente'

  const errEl = document.getElementById('form-error')
  clearFormErrors()

  // Validation
  if (!newsletter) return showErr(errEl, 'Selecione a newsletter.')
  if (!format) return showErr(errEl, 'Selecione o formato do anúncio.')
  if (!campaignName) return showErr(errEl, 'Informe o título/nome da campanha.')
  if (!authorship) return showErr(errEl, 'Informe a autoria.')
  if (suggestedText.length < 200) return showErr(errEl, `Texto muito curto (${suggestedText.length} chars). Mínimo 200 caracteres.`)
  if (suggestedText.length > 500) return showErr(errEl, `Texto muito longo (${suggestedText.length} chars). Máximo 500 caracteres.`)
  if (coverLink && !isValidUrl(coverLink)) return showErr(errEl, 'Link da capa inválido (deve começar com http).')
  if (redirectLink && !isValidUrl(redirectLink)) return showErr(errEl, 'Link de redirecionamento inválido (deve começar com http).')

  // Check slot availability
  const others = allBookings.filter(b => String(b.id) !== String(editingBookingId))
  if (!isSlotFree(dateStr, newsletter, format, others)) {
    return showErr(errEl, `Este slot (${NEWSLETTERS[newsletter]?.label} — ${FORMATS[format]?.label}) já está ocupado neste dia.`)
  }

  // Check quota for anunciante
  if (isAnunciante && !editingBookingId) {
    const q = clientHasQuota(session.clientId, newsletter, format, allQuotas, allBookings)
    if (!q.allowed) return showErr(errEl, 'Cota esgotada para este formato/newsletter.')
  }

  const data = {
    date: dateStr,
    newsletter,
    format,
    campaign_name: campaignName,
    authorship,
    campaign,
    suggested_text: suggestedText,
    promotional_period: promotionalPeriod || null,
    cover_link: coverLink || null,
    redirect_link: redirectLink || null,
    status: canEdit ? status : (editingBookingId ? undefined : 'pendente'),
  }

  if (canEdit) data.admin_notes = adminNotes
  if (isAnunciante && !editingBookingId) data.client_id = session.clientId

  const saveBtn = document.getElementById('btn-modal-save')
  saveBtn.disabled = true
  saveBtn.textContent = 'Salvando...'

  try {
    if (editingBookingId) {
      const updated = await updateBooking(editingBookingId, data)
      const idx = allBookings.findIndex(b => b.id === editingBookingId)
      if (idx > -1) allBookings[idx] = { ...allBookings[idx], ...data }
      if (isAnunciante && window._ownBookings) {
        const ownIdx = window._ownBookings.findIndex(b => b.id === editingBookingId)
        if (ownIdx > -1) window._ownBookings[ownIdx] = { ...window._ownBookings[ownIdx], ...data }
      }
    } else {
      const created = await createBooking(data)
      if (created) {
        allBookings.push(created)
        if (isAnunciante) {
          if (!window._ownBookings) window._ownBookings = []
          window._ownBookings.push(created)
        }
      }
    }

    closeModal('booking-modal')
    refreshCalendar()
    if (selectedDate) showSidebar(selectedDate)
  } catch (e) {
    showErr(errEl, e.message || 'Erro ao salvar anúncio.')
  } finally {
    saveBtn.disabled = false
    saveBtn.textContent = 'Salvar Anúncio'
  }
})

function showErr(el, msg) {
  el.textContent = msg
  el.style.display = 'flex'
}

// Delete booking
document.getElementById('btn-delete-booking').addEventListener('click', async () => {
  if (!editingBookingId || !isAdmin) return
  if (!confirm('Excluir este anúncio? Esta ação não pode ser desfeita.')) return
  try {
    showLoading(true)
    await deleteBooking(editingBookingId)
    allBookings = allBookings.filter(b => b.id !== editingBookingId)
    closeModal('booking-modal')
    refreshCalendar()
    if (selectedDate) showSidebar(selectedDate)
  } catch (e) {
    alert('Erro ao excluir: ' + e.message)
  } finally {
    showLoading(false)
  }
})

// ─── Detail Modal ─────────────────────────────────────────────────────────────
function openDetailModal(booking) {
  const nl = NEWSLETTERS[booking.newsletter] || {}
  const fmt = FORMATS[booking.format] || {}
  const status = BOOKING_STATUS[booking.status] || {}

  document.getElementById('detail-modal-title').textContent = booking.campaign_name || 'Anúncio'

  let html = ''
  const fields = [
    ['Data', formatDate(booking.date)],
    ['Newsletter', `<span class="badge badge-${booking.newsletter}">${nl.label || booking.newsletter}</span>`],
    ['Formato', fmt.label || booking.format],
    ['Status', `<span class="badge badge-${booking.status}">${status.label || booking.status}</span>`],
    ['Autoria', booking.authorship],
    ['Campanha', booking.campaign],
    ['Texto sugerido', booking.suggested_text],
    ['Período promocional', booking.promotional_period],
    ['Link da capa', booking.cover_link ? `<a href="${booking.cover_link}" target="_blank">${booking.cover_link}</a>` : null],
    ['Link de redirecionamento', booking.redirect_link ? `<a href="${booking.redirect_link}" target="_blank">${booking.redirect_link}</a>` : null],
  ]

  if (canEdit && booking.admin_notes) {
    fields.push(['Notas admin', booking.admin_notes])
  }

  for (const [label, value] of fields) {
    if (!value) continue
    html += `<div class="booking-detail-item"><div class="booking-detail-label">${label}</div><div class="booking-detail-value">${value}</div></div>`
  }

  document.getElementById('detail-modal-body').innerHTML = html

  const editBtn = document.getElementById('btn-detail-edit')
  if (canEdit) {
    editBtn.style.display = 'inline-flex'
    editBtn.onclick = () => {
      closeModal('detail-modal')
      openBookingModal(booking.date, booking)
    }
  } else {
    editBtn.style.display = 'none'
  }

  openModal('detail-modal')
}

document.getElementById('btn-detail-close').addEventListener('click', () => closeModal('detail-modal'))
document.getElementById('detail-modal-close').addEventListener('click', () => closeModal('detail-modal'))

// ─── Modal helpers ────────────────────────────────────────────────────────────
function openModal(id) {
  document.getElementById(id).classList.add('open')
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open')
}

document.getElementById('modal-close').addEventListener('click', () => closeModal('booking-modal'))
document.getElementById('btn-modal-cancel').addEventListener('click', () => closeModal('booking-modal'))

// Close on overlay click — only if mousedown also started on the overlay (not a drag-release)
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  let mousedownOnOverlay = false
  overlay.addEventListener('mousedown', e => {
    mousedownOnOverlay = e.target === overlay
  })
  overlay.addEventListener('click', e => {
    if (e.target === overlay && mousedownOnOverlay) closeModal(overlay.id)
    mousedownOnOverlay = false
  })
})

// ─── List View ────────────────────────────────────────────────────────────────
let currentView = 'calendar'

document.getElementById('view-toggle').addEventListener('click', e => {
  const btn = e.target.closest('.view-btn')
  if (!btn) return
  const view = btn.dataset.view
  if (view === currentView) return
  currentView = view
  document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view))
  document.getElementById('nl-filter').style.display = view === 'calendar' ? '' : 'none'
  document.getElementById('calendar-view').style.display = view === 'calendar' ? '' : 'none'
  document.getElementById('list-view').style.display = view === 'list' ? '' : 'none'
  if (view === 'list') renderListView()
})

function renderListView() {
  const ownBookings = isAnunciante
    ? (window._ownBookings || [])
    : allBookings

  const sorted = [...ownBookings].sort((a, b) => a.date < b.date ? 1 : -1)
  const tbody = document.getElementById('lv-table-body')

  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text-muted)">Nenhum anúncio cadastrado.</td></tr>`
    return
  }

  tbody.innerHTML = sorted.map(b => {
    const nl = NEWSLETTERS[b.newsletter] || {}
    const fmt = FORMATS[b.format] || {}
    const st = BOOKING_STATUS[b.status] || {}
    const canDel = isAdmin || (isAnunciante && ['rascunho', 'pendente'].includes(b.status))
    return `<tr>
      <td>${formatDate(b.date)}</td>
      <td><span class="badge badge-${b.newsletter}">${nl.label || b.newsletter}</span></td>
      <td>${fmt.label || b.format}</td>
      <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${b.campaign_name || '—'}</td>
      <td><span class="badge badge-${b.status}">${st.label || b.status}</span></td>
      <td class="td-actions">
        <button class="btn btn-ghost btn-sm" data-lv-edit="${b.id}">Editar</button>
        ${canDel ? `<button class="btn btn-ghost btn-sm" style="color:var(--red)" data-lv-del="${b.id}">✕</button>` : ''}
      </td>
    </tr>`
  }).join('')

  // Edit from list view → opens the calendar modal
  tbody.querySelectorAll('[data-lv-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const b = allBookings.find(x => String(x.id) === btn.dataset.lvEdit)
      if (b) openBookingModal(b.date, b)
    })
  })

  tbody.querySelectorAll('[data-lv-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Excluir este anúncio?')) return
      const id = btn.dataset.lvDel
      try {
        showLoading(true)
        await deleteBooking(id)
        allBookings = allBookings.filter(b => String(b.id) !== id)
        if (window._ownBookings) window._ownBookings = window._ownBookings.filter(b => String(b.id) !== id)
        renderListView()
        refreshCalendar()
      } catch (e) { alert('Erro: ' + e.message) }
      finally { showLoading(false) }
    })
  })
}

// List view form logic
document.getElementById('lv-suggested-text').addEventListener('input', () => {
  const len = document.getElementById('lv-suggested-text').value.length
  const el = document.getElementById('lv-char-counter')
  el.textContent = `${len} / 500`
  el.className = 'char-counter ' + (len < 200 ? 'warn' : len > 500 ? 'error' : 'ok')
})

const lvNlSel = document.getElementById('lv-newsletter')
const lvFmtSel = document.getElementById('lv-format')
function lvUpdateWarnings() {
  const dateStr = document.getElementById('lv-date').value
  const nl = lvNlSel.value
  const fmt = lvFmtSel.value
  const warnEl = document.getElementById('lv-slot-warning')
  const quotaEl = document.getElementById('lv-quota-info')

  if (dateStr && nl && fmt) {
    if (!isSlotFree(dateStr, nl, fmt, allBookings)) {
      warnEl.textContent = `⚠ Slot ${NEWSLETTERS[nl]?.label} — ${FORMATS[fmt]?.label} já ocupado neste dia.`
      warnEl.style.display = 'flex'
    } else {
      warnEl.style.display = 'none'
    }
  } else {
    warnEl.style.display = 'none'
  }

  if (isAnunciante && nl && fmt) {
    const q = clientHasQuota(session.clientId, nl, fmt, allQuotas, allBookings)
    quotaEl.textContent = `Sua cota: ${q.used}/${q.total} slots${q.allowed ? '' : ' — COTA ESGOTADA'}`
    quotaEl.style.display = 'flex'
    quotaEl.className = `alert mt ${q.allowed ? 'alert-info' : 'alert-error'}`
  } else {
    quotaEl.style.display = 'none'
  }
}
lvNlSel.addEventListener('change', lvUpdateWarnings)
lvFmtSel.addEventListener('change', lvUpdateWarnings)
document.getElementById('lv-date').addEventListener('change', lvUpdateWarnings)

async function lvSubmit(keepCampaignDetails) {
  const dateStr = document.getElementById('lv-date').value
  const nl = lvNlSel.value
  const fmt = lvFmtSel.value
  const campaignName = document.getElementById('lv-campaign-name').value.trim()
  const authorship = document.getElementById('lv-authorship').value.trim()
  const suggestedText = document.getElementById('lv-suggested-text').value.trim()
  const promotionalPeriod = document.getElementById('lv-promotional-period').value.trim()
  const coverLink = document.getElementById('lv-cover-link').value.trim()
  const redirectLink = document.getElementById('lv-redirect-link').value.trim()
  const errEl = document.getElementById('lv-error')
  errEl.style.display = 'none'

  if (!dateStr) return showErr(errEl, 'Selecione a data.')
  if (!nl) return showErr(errEl, 'Selecione a newsletter.')
  if (!fmt) return showErr(errEl, 'Selecione o formato.')
  if (!campaignName) return showErr(errEl, 'Informe o título da campanha.')
  if (!authorship) return showErr(errEl, 'Informe a autoria.')
  if (suggestedText.length < 200) return showErr(errEl, `Texto muito curto (${suggestedText.length} chars). Mínimo 200.`)
  if (suggestedText.length > 500) return showErr(errEl, `Texto muito longo. Máximo 500 caracteres.`)
  if (coverLink && !isValidUrl(coverLink)) return showErr(errEl, 'Link da capa inválido.')
  if (redirectLink && !isValidUrl(redirectLink)) return showErr(errEl, 'Link de redirecionamento inválido.')
  if (!isSlotFree(dateStr, nl, fmt, allBookings)) return showErr(errEl, 'Este slot já está ocupado neste dia.')
  if (isAnunciante) {
    const q = clientHasQuota(session.clientId, nl, fmt, allQuotas, allBookings)
    if (!q.allowed) return showErr(errEl, 'Cota esgotada para este formato/newsletter.')
  }

  const data = {
    date: dateStr, newsletter: nl, format: fmt,
    campaign_name: campaignName, authorship,
    suggested_text: suggestedText,
    promotional_period: promotionalPeriod || null,
    cover_link: coverLink || null,
    redirect_link: redirectLink || null,
    status: 'pendente',
  }
  if (isAnunciante) data.client_id = session.clientId
  if (canEdit) data.status = 'rascunho'

  const saveBtn = document.getElementById(keepCampaignDetails ? 'lv-btn-save-continue' : 'lv-btn-save')
  saveBtn.disabled = true
  const orig = saveBtn.textContent
  saveBtn.textContent = 'Salvando...'

  try {
    const created = await createBooking(data)
    if (created) {
      allBookings.push(created)
      if (isAnunciante) {
        if (!window._ownBookings) window._ownBookings = []
        window._ownBookings.push(created)
      }
    }
    refreshCalendar()

    // Show success flash
    const successEl = document.getElementById('lv-success')
    successEl.style.display = 'inline-flex'
    setTimeout(() => { successEl.style.display = 'none' }, 2500)

    if (keepCampaignDetails) {
      // Keep campaign details, reset only date/slot fields
      document.getElementById('lv-date').value = ''
      lvNlSel.value = ''
      lvFmtSel.value = ''
      document.getElementById('lv-slot-warning').style.display = 'none'
      document.getElementById('lv-quota-info').style.display = 'none'
    } else {
      document.getElementById('lv-form').reset()
      document.getElementById('lv-char-counter').textContent = '0 / 500'
      document.getElementById('lv-char-counter').className = 'char-counter warn'
      document.getElementById('lv-slot-warning').style.display = 'none'
      document.getElementById('lv-quota-info').style.display = 'none'
    }

    renderListView()
  } catch (e) {
    showErr(errEl, e.message || 'Erro ao salvar.')
  } finally {
    saveBtn.disabled = false
    saveBtn.textContent = orig
  }
}

document.getElementById('lv-btn-save').addEventListener('click', () => lvSubmit(false))
document.getElementById('lv-btn-save-continue').addEventListener('click', () => lvSubmit(true))
document.getElementById('lv-btn-reset').addEventListener('click', () => {
  document.getElementById('lv-form').reset()
  document.getElementById('lv-char-counter').textContent = '0 / 500'
  document.getElementById('lv-slot-warning').style.display = 'none'
  document.getElementById('lv-quota-info').style.display = 'none'
  document.getElementById('lv-error').style.display = 'none'
})

// ─── Newsletter filter ────────────────────────────────────────────────────────
document.getElementById('nl-filter').addEventListener('click', e => {
  const pill = e.target.closest('[data-nl]')
  if (!pill) return
  currentFilter = pill.dataset.nl
  document.querySelectorAll('.nl-pill').forEach(p => p.classList.remove('active'))
  pill.classList.add('active')
  refreshCalendar()
  if (selectedDate) showSidebar(selectedDate)
})

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isValidUrl(s) {
  try { return /^https?:\/\/./.test(s) } catch { return false }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
;(async () => {
  await loadData()
  initCalendar()
})()
