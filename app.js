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

// ─── Sheet View ───────────────────────────────────────────────────────────────
let currentView = 'calendar'
let sheetMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1)

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
  if (view === 'list') renderSheet()
})

document.getElementById('sheet-prev').addEventListener('click', () => {
  sheetMonth = new Date(sheetMonth.getFullYear(), sheetMonth.getMonth() - 1, 1)
  renderSheet()
})
document.getElementById('sheet-next').addEventListener('click', () => {
  sheetMonth = new Date(sheetMonth.getFullYear(), sheetMonth.getMonth() + 1, 1)
  renderSheet()
})

function getWorkingDays(year, month) {
  const days = []
  const d = new Date(year, month, 1)
  while (d.getMonth() === month) {
    const iso = toISODate(d)
    if (!isDayBlocked(iso, allBlockedDates)) days.push(iso)
    d.setDate(d.getDate() + 1)
  }
  return days
}

function colorNlSel(sel) {
  const v = sel.value
  sel.style.background = v === 'aurora' ? '#fce7f3' : v === 'indice' ? '#dcfce7' : ''
  sel.style.color = v ? 'var(--text)' : 'var(--text-muted)'
}

function renderSheet(mode = 'calendar') {
  // Toggle topbar elements based on mode
  const isBlank = mode === 'blank'
  document.getElementById('sheet-prev').style.display  = isBlank ? 'none' : ''
  document.getElementById('sheet-next').style.display  = isBlank ? 'none' : ''
  document.getElementById('sheet-month-label').style.display = isBlank ? 'none' : ''
  if (isBlank) {
    document.getElementById('sheet-save-count').textContent = ''
    renderBlankSheet()
    return
  }
  const year = sheetMonth.getFullYear()
  const month = sheetMonth.getMonth()
  const monthStr = `${year}-${String(month + 1).padStart(2, '0')}`
  const label = sheetMonth.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
  document.getElementById('sheet-month-label').textContent = label.charAt(0).toUpperCase() + label.slice(1)

  const workingDays = getWorkingDays(year, month)
  const monthBookings = allBookings.filter(b => b.date?.startsWith(monthStr))
  const myBookings = isAnunciante
    ? monthBookings.filter(b => String(b.client_id) === String(session.clientId))
    : monthBookings

  // Group my bookings by date
  const dayMap = {}
  for (const b of myBookings) {
    if (!dayMap[b.date]) dayMap[b.date] = []
    dayMap[b.date].push(b)
  }

  // Build rows: one per working day (+ extra rows for days with multiple bookings)
  const rows = []
  for (const day of workingDays) {
    const bkgs = dayMap[day] || []
    if (bkgs.length === 0) {
      rows.push({ date: day, booking: null })
    } else {
      for (const b of bkgs) rows.push({ date: day, booking: b })
      // Add blank row if the day still has free slots
      const taken = monthBookings.filter(b => b.date === day && b.status !== 'rejeitado').length
      if (taken < 4) rows.push({ date: day, booking: null })
    }
  }

  const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
  const tbody = document.getElementById('sheet-body')
  tbody.innerHTML = rows.map(({ date, booking }, idx) => {
    const d = new Date(date + 'T12:00:00')
    const dateLabel = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${DAY_NAMES[d.getDay()]}`
    const nl = booking?.newsletter || ''
    const fmt = booking?.format || ''
    const nlBg = nl === 'aurora' ? 'background:#fce7f3' : nl === 'indice' ? 'background:#dcfce7' : ''
    const statusBadge = booking ? `<span class="badge badge-${booking.status} badge-xs">${BOOKING_STATUS[booking.status]?.label || booking.status}</span>` : ''
    return `<tr class="sh-row${booking ? ' sh-has-booking' : ''}" data-date="${date}" data-row="${idx}" data-booking-id="${booking?.id || ''}">
      <td class="sh-date-cell">${dateLabel}${statusBadge ? '<br>' + statusBadge : ''}</td>
      <td><input class="sh-input" data-field="campaign_name" value="${escHtml(booking?.campaign_name || '')}" placeholder="Título da campanha" /></td>
      <td><input class="sh-input" data-field="authorship" value="${escHtml(booking?.authorship || '')}" placeholder="Autoria" /></td>
      <td><select class="sh-select sh-nl-sel" data-field="newsletter" style="${nlBg}">
        <option value="">—</option>
        <option value="aurora" ${nl === 'aurora' ? 'selected' : ''}>Aurora</option>
        <option value="indice" ${nl === 'indice' ? 'selected' : ''}>Índice</option>
      </select></td>
      <td><select class="sh-select" data-field="format">
        <option value="">—</option>
        <option value="destaque" ${fmt === 'destaque' ? 'selected' : ''}>Destaque</option>
        <option value="corpo" ${fmt === 'corpo' ? 'selected' : ''}>Corpo</option>
      </select></td>
      <td><input class="sh-input sh-text-col" data-field="suggested_text" value="${escHtml(booking?.suggested_text || '')}" placeholder="Texto do anúncio (200–500 caracteres)" /></td>
      <td><input class="sh-input sh-link-col" data-field="cover_link" value="${escHtml(booking?.cover_link || '')}" placeholder="https://..." /></td>
      <td><input class="sh-input sh-link-col" data-field="redirect_link" value="${escHtml(booking?.redirect_link || '')}" placeholder="https://..." /></td>
      <td class="sh-status-cell" id="sh-s-${idx}"></td>
    </tr>`
  }).join('')

  tbody.querySelectorAll('.sh-nl-sel').forEach(sel => {
    colorNlSel(sel)
    sel.addEventListener('change', () => colorNlSel(sel))
  })

  updateSheetCounter()
  tbody.addEventListener('input', updateSheetCounter)
}

function renderBlankSheet() {
  const NUM = 12
  const tbody = document.getElementById('sheet-body')
  tbody.innerHTML = Array.from({ length: NUM }, (_, i) => `
    <tr class="sh-row" data-date="" data-row="${i}" data-booking-id="">
      <td class="sh-date-cell"><input type="date" class="sh-input sh-date-picker" data-field="date" /></td>
      <td><input class="sh-input" data-field="campaign_name" placeholder="Título da campanha" /></td>
      <td><input class="sh-input" data-field="authorship" placeholder="Autoria" /></td>
      <td><select class="sh-select sh-nl-sel" data-field="newsletter">
        <option value="">—</option>
        <option value="aurora">Aurora</option>
        <option value="indice">Índice</option>
      </select></td>
      <td><select class="sh-select" data-field="format">
        <option value="">—</option>
        <option value="destaque">Destaque</option>
        <option value="corpo">Corpo</option>
      </select></td>
      <td><input class="sh-input sh-text-col" data-field="suggested_text" placeholder="Texto do anúncio (200–500 caracteres)" /></td>
      <td><input class="sh-input sh-link-col" data-field="cover_link" placeholder="https://..." /></td>
      <td><input class="sh-input sh-link-col" data-field="redirect_link" placeholder="https://..." /></td>
      <td class="sh-status-cell" id="sh-s-${i}"></td>
    </tr>`).join('')

  tbody.querySelectorAll('.sh-nl-sel').forEach(sel => {
    colorNlSel(sel)
    sel.addEventListener('change', () => colorNlSel(sel))
  })
  // Sync date picker value to row's data-date
  tbody.querySelectorAll('.sh-date-picker').forEach(inp => {
    inp.addEventListener('change', () => {
      inp.closest('tr').dataset.date = inp.value
    })
  })
  updateSheetCounter()
  tbody.addEventListener('input', updateSheetCounter)
}

function updateSheetCounter() {
  const rows = document.querySelectorAll('#sheet-body .sh-row')
  const n = [...rows].filter(r => {
    const g = f => r.querySelector(`[data-field="${f}"]`)?.value?.trim()
    return g('campaign_name') && g('newsletter') && g('format') && g('suggested_text')
  }).length
  const el = document.getElementById('sheet-save-count')
  el.textContent = n > 0 ? `${n} linha${n > 1 ? 's' : ''} a salvar` : ''
}

document.getElementById('sheet-save-all').addEventListener('click', async () => {
  const rows = [...document.querySelectorAll('#sheet-body .sh-row')]
  const btn = document.getElementById('sheet-save-all')
  btn.disabled = true
  btn.textContent = 'Salvando...'

  let saved = 0, errors = 0
  // Track bookings added this session to update quota check
  const tempAdded = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const g = f => row.querySelector(`[data-field="${f}"]`)?.value?.trim() || ''
    const datePicker = row.querySelector('[data-field="date"]')
    const date = datePicker ? datePicker.value : row.dataset.date
    const bookingId = row.dataset.bookingId
    const campaign_name = g('campaign_name')
    const authorship = g('authorship')
    const newsletter = g('newsletter')
    const format = g('format')
    const suggested_text = g('suggested_text')
    const cover_link = g('cover_link')
    const redirect_link = g('redirect_link')
    const statusEl = document.getElementById(`sh-s-${i}`)

    // Skip fully empty rows
    if (!date && !campaign_name && !newsletter && !format && !suggested_text) continue

    // Validate
    const errs = []
    if (!date) errs.push('Data obrigatória')
    else if (isDayBlocked(date, allBlockedDates)) errs.push('Data bloqueada ou fim de semana')
    if (!campaign_name) errs.push('Campanha obrigatória')
    if (!authorship) errs.push('Autoria obrigatória')
    if (!newsletter) errs.push('Newsletter obrigatória')
    if (!format) errs.push('Formato obrigatório')
    if (suggested_text.length < 200) errs.push(`Texto curto (${suggested_text.length} chars, mínimo 200)`)
    if (suggested_text.length > 500) errs.push('Texto longo (máximo 500)')
    if (cover_link && !isValidUrl(cover_link)) errs.push('Link da capa inválido')
    if (redirect_link && !isValidUrl(redirect_link)) errs.push('Link de redirecionamento inválido')
    if (!bookingId) {
      const combined = [...allBookings, ...tempAdded]
      if (!isSlotFree(date, newsletter, format, combined)) errs.push('Slot já ocupado neste dia')
      if (isAnunciante) {
        const q = clientHasQuota(session.clientId, newsletter, format, allQuotas, combined)
        if (!q.allowed) errs.push('Cota esgotada')
      }
    }

    if (errs.length) {
      statusEl.innerHTML = `<span class="sh-err" title="${errs.join('; ')}">✕ ${errs[0]}</span>`
      row.classList.add('sh-row-error')
      errors++
      continue
    }

    const data = { date, newsletter, format, campaign_name, authorship, suggested_text,
      cover_link: cover_link || null, redirect_link: redirect_link || null }
    if (!bookingId) {
      data.status = isAnunciante ? 'pendente' : 'rascunho'
      if (isAnunciante) data.client_id = session.clientId
    }

    try {
      if (bookingId) {
        await updateBooking(bookingId, data)
        const idx = allBookings.findIndex(b => String(b.id) === bookingId)
        if (idx >= 0) allBookings[idx] = { ...allBookings[idx], ...data }
      } else {
        const result = await createBooking(data)
        if (result) {
          allBookings.push(result)
          tempAdded.push(result)
          row.dataset.bookingId = result.id
          row.classList.add('sh-has-booking')
        }
      }
      statusEl.innerHTML = `<span class="sh-ok">✓</span>`
      row.classList.remove('sh-row-error')
      saved++
    } catch (e) {
      statusEl.innerHTML = `<span class="sh-err" title="${escHtml(e.message)}">✕ ${escHtml(e.message)}</span>`
      row.classList.add('sh-row-error')
      errors++
    }
  }

  btn.disabled = false
  btn.textContent = 'Salvar todos'
  if (saved > 0) {
    refreshCalendar()
    const el = document.getElementById('sheet-save-count')
    el.textContent = `✓ ${saved} salvo${saved > 1 ? 's' : ''}${errors > 0 ? ` · ${errors} com erro` : ''}`
    el.style.color = errors > 0 ? 'var(--red)' : 'var(--green-dark)'
  }
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
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

function isValidUrl(s) {
  try { return /^https?:\/\/./.test(s) } catch { return false }
}

// ─── View routing ─────────────────────────────────────────────────────────────
function switchView(view) {
  currentView = view
  document.getElementById('dashboard-view').style.display  = view === 'dashboard' ? '' : 'none'
  document.getElementById('calendar-view').style.display   = view === 'calendar'  ? '' : 'none'
  document.getElementById('list-view').style.display       = view === 'list'       ? '' : 'none'
  document.getElementById('nl-filter').style.display       = view === 'calendar'   ? '' : 'none'
  document.getElementById('btn-inicio').style.display      = isAnunciante && view !== 'dashboard' ? 'inline-flex' : 'none'
  document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view))
  if (view === 'list')      renderSheet()
  if (view === 'dashboard') renderDashboard()
  if (view === 'calendar')  calendar?.render()
}

document.getElementById('btn-inicio').addEventListener('click', () => switchView('dashboard'))

// ─── Dashboard ────────────────────────────────────────────────────────────────
function renderDashboard() {
  const myQuotas   = allQuotas.filter(q => String(q.client_id) === String(session.clientId))
  const myBookings = allBookings.filter(b => String(b.client_id) === String(session.clientId) && b.status !== 'rejeitado')
  const totalBought    = myQuotas.reduce((s, q) => s + (q.total_slots || 0), 0)
  const totalUsed      = myBookings.length
  const totalAvailable = Math.max(0, totalBought - totalUsed)

  // Per-combo breakdown
  const COMBOS = [
    { nl: 'aurora', fmt: 'destaque', label: 'Aurora — Destaque' },
    { nl: 'aurora', fmt: 'corpo',    label: 'Aurora — Corpo do Email' },
    { nl: 'indice', fmt: 'destaque', label: 'Índice — Destaque' },
    { nl: 'indice', fmt: 'corpo',    label: 'Índice — Corpo do Email' },
  ]
  const comboCards = COMBOS.map(c => {
    const quota = myQuotas.filter(q =>
      (q.newsletter === c.nl || q.newsletter === 'ambas') &&
      (q.format === c.fmt || q.format === 'ambos')
    )
    if (!quota.length) return null
    const total = quota.reduce((s, q) => s + (q.total_slots || 0), 0)
    const avail = Math.max(0, total - totalUsed)
    return { ...c, total, avail }
  }).filter(Boolean)

  // Upcoming bookings (sorted, from today)
  const today = toISODate(new Date())
  const upcoming = myBookings
    .filter(b => b.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5)

  const name = session.clientName || 'Empresa'

  document.getElementById('dash-content').innerHTML = `
    <div class="dash-inner">
      <div class="dash-welcome">
        <div class="dash-hello">Olá, pessoal da</div>
        <h1 class="dash-company">${escHtml(name)}</h1>
        <p class="dash-sub">Bem-vindos ao painel de anúncios da Seiva.</p>
      </div>

      <div class="dash-section" style="animation-delay:.1s">
        <div class="dash-section-title">Seus spots disponíveis</div>
        ${totalBought === 0
          ? `<p class="dash-empty">Nenhuma cota configurada. Entre em contato com a Seiva.</p>`
          : `<div class="dash-quota-summary">
              <span class="dash-quota-big">${totalAvailable}</span>
              <span class="dash-quota-label">de ${totalBought} spot${totalBought !== 1 ? 's' : ''} restante${totalAvailable !== 1 ? 's' : ''}</span>
            </div>
            ${comboCards.length > 1 ? `<div class="dash-cards">
              ${comboCards.map((c, i) => `
                <div class="dash-card dash-card-${c.nl}" style="animation-delay:${.15 + i*.07}s">
                  <div class="dash-card-label">${c.label}</div>
                  <div class="dash-card-number">${c.avail}</div>
                  <div class="dash-card-sub">de ${c.total}</div>
                </div>`).join('')}
            </div>` : ''}`
        }
      </div>

      ${upcoming.length > 0 ? `
      <div class="dash-section" style="animation-delay:.22s">
        <div class="dash-section-title">Próximos spots agendados</div>
        <div class="dash-upcoming">
          ${upcoming.map(b => {
            const nl  = NEWSLETTERS[b.newsletter]?.label || b.newsletter
            const fmt = FORMATS[b.format]?.label        || b.format
            const st  = BOOKING_STATUS[b.status]        || {}
            return `<div class="dash-upcoming-row">
              <span class="dash-upcoming-date">${formatDate(b.date)}</span>
              <span class="badge badge-${b.newsletter} badge-xs">${nl}</span>
              <span class="dash-upcoming-fmt">${fmt}</span>
              <span class="dash-upcoming-name">${escHtml(b.campaign_name || '—')}</span>
              <span class="badge badge-${b.status} badge-xs">${st.label || b.status}</span>
            </div>`
          }).join('')}
        </div>
      </div>` : ''}

      <div class="dash-section" style="animation-delay:.3s">
        <div class="dash-section-title">O que você quer fazer?</div>
        <div class="dash-action-grid">
          <button class="dash-action-card" id="dash-single">
            <div class="dash-action-icon">＋</div>
            <div class="dash-action-name">Criar um spot</div>
            <div class="dash-action-desc">Escolha o dia no calendário e preencha o formulário</div>
          </button>
          <button class="dash-action-card" id="dash-multi">
            <div class="dash-action-icon">≡</div>
            <div class="dash-action-name">Criar vários spots</div>
            <div class="dash-action-desc">Preencha uma planilha com vários spots de uma vez</div>
          </button>
          <button class="dash-action-card" id="dash-calendar">
            <div class="dash-action-icon">📅</div>
            <div class="dash-action-name">Ver calendário</div>
            <div class="dash-action-desc">Visualize todos os slots disponíveis e ocupados</div>
          </button>
        </div>
      </div>
    </div>
  `

  document.getElementById('dash-single').addEventListener('click', () => switchView('calendar'))
  document.getElementById('dash-multi').addEventListener('click', () => {
    switchView('list')
    renderSheet('blank')
  })
  document.getElementById('dash-calendar').addEventListener('click', () => switchView('calendar'))
}

// ─── Init ─────────────────────────────────────────────────────────────────────
;(async () => {
  await loadData()
  initCalendar()
  if (isAnunciante) {
    document.getElementById('view-toggle').style.display = 'none'
    switchView('dashboard')
  } else {
    document.getElementById('view-toggle').style.display = ''
    switchView('calendar')
  }
})()
