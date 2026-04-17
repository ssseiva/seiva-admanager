// sheet.js — Planilha admin unificada (todos os clientes)
import { requireAuth, logout } from './auth.js'
import { getBookings, updateBooking, deleteBooking, getClients, getBlockedDates, getBookByISBN } from './api.js'
import { FERIADOS_BR, BOOKING_STATUS, METABOOKS_COVER_URL, formatDate, toISODate } from './config.js'

// ── Auth: apenas admin / redator ─────────────────────────────────────────────
const session = requireAuth('/index.html')
if (!session) throw new Error()
if (session.role !== 'admin' && session.role !== 'redator') {
  window.location.href = 'client.html'; throw new Error()
}

// ── Colunas ───────────────────────────────────────────────────────────────────
const COLS = [
  { key: '_client_name',    label: 'Cliente',            w: 150, type: 'text',    readonly: true },
  { key: 'date',            label: 'Data',               w: 108, type: 'date' },
  { key: 'newsletter',      label: 'Newsletter',         w:  96, type: 'sel',     opts: [['aurora','Aurora'],['indice','Índice']] },
  { key: 'format',          label: 'Formato',            w: 120, type: 'sel',     opts: [['destaque','Destaque'],['corpo','Corpo do Email']] },
  { key: 'status',          label: 'Status',             w: 130, type: 'status' },
  { key: 'isbn',            label: 'ISBN',               w: 120, type: 'text' },
  { key: 'campaign_name',   label: 'Nome da Campanha',   w: 220, type: 'text' },
  { key: 'authorship',      label: 'Autoria',            w: 158, type: 'text' },
  { key: 'suggested_text',  label: 'Texto',              w: 160, type: 'longtext' },
  { key: 'extra_info',      label: 'Cupom',              w: 160, type: 'longtext' },
  { key: 'promotional_period', label: 'Período Promo',   w: 138, type: 'text' },
  { key: 'cover_link',      label: 'Imagem',             w: 190, type: 'link' },
  { key: 'redirect_link',   label: 'Link Redirect',      w: 190, type: 'link' },
]
const DATE_CI     = COLS.findIndex(c => c.type === 'date')
const EDITABLE_CI = COLS.map((c,i) => c.type !== 'status' && !c.readonly ? i : -1).filter(i => i >= 0)

// Todos os status disponíveis para o admin
const STATUS_OPTS = [
  ['rascunho',  'Rascunho'],
  ['pendente',  'Submetido pelo cliente'],
  ['aprovado',  'Aprovado pela Seiva'],
  ['veiculado', 'Veiculado'],
  ['rejeitado', 'Rejeitado'],
]

// ── Estado ────────────────────────────────────────────────────────────────────
let rows      = []
let clients   = {}   // id → company_name
let blocked   = []
let dirty     = new Set()
let active    = null
let activeGen = 0
let activeKey = null
let dpRi      = null
let dpDate    = new Date()
let tpRi      = null
let tpCi      = null
let resizing  = null
let undoStack = []   // pilha de undo: { rowId, key, oldVal }

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ind     = document.getElementById('save-ind')
const $save    = document.getElementById('btn-save')
const $table   = document.getElementById('sheet-table')
const $thead   = document.getElementById('sheet-thead')
const $tbody   = document.getElementById('sheet-tbody')
const $loading = document.getElementById('sheet-loading')
const $dp      = document.getElementById('datepicker')
const $dpTtl   = document.getElementById('dp-title')
const $dpGrid  = document.getElementById('dp-grid')
const $tp      = document.getElementById('text-popup')
const $tpLabel = document.getElementById('tp-label')
const $tpArea  = document.getElementById('tp-area')
const $toast   = document.getElementById('toast')

document.getElementById('btn-logout').addEventListener('click', logout)
$save.addEventListener('click', saveAll)

// ── Dark mode toggle ────────────────────────────────────────────────────────
const $theme = document.getElementById('btn-theme')
if (localStorage.getItem('theme') === 'dark') document.documentElement.classList.add('dark')
$theme.textContent = document.documentElement.classList.contains('dark') ? '\u2600' : '\u263E'
$theme.addEventListener('click', () => {
  document.documentElement.classList.toggle('dark')
  const isDark = document.documentElement.classList.contains('dark')
  localStorage.setItem('theme', isDark ? 'dark' : 'light')
  $theme.textContent = isDark ? '\u2600' : '\u263E'
})

document.getElementById('dp-prev').addEventListener('mousedown', e => e.stopPropagation())
document.getElementById('dp-next').addEventListener('mousedown', e => e.stopPropagation())
document.getElementById('dp-prev').addEventListener('click', () => { dpDate.setMonth(dpDate.getMonth()-1); renderDp() })
document.getElementById('dp-next').addEventListener('click', () => { dpDate.setMonth(dpDate.getMonth()+1); renderDp() })

document.addEventListener('mousedown', e => {
  if (dpRi !== null && !$dp.contains(e.target)) hideDp()
  if (tpRi !== null && !$tp.contains(e.target)) hideTextPopup()
}, true)

document.addEventListener('mousemove', e => {
  if (!resizing) return
  const dx   = e.clientX - resizing.startX
  const newW = Math.max(40, resizing.startW + dx)
  COLS[resizing.ci].w = newW
  const th = $thead.querySelectorAll('th')[resizing.ci + 1]
  if (th) th.style.width = newW + 'px'
  updateTableWidth()
})
document.addEventListener('mouseup', () => {
  if (!resizing) return
  resizing.el.classList.remove('active')
  resizing = null
})

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (dpRi !== null) { e.preventDefault(); hideDp() }
    if (tpRi !== null) { e.preventDefault(); hideTextPopup() }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    if (active || dpRi !== null || tpRi !== null) return
    e.preventDefault()
    applyUndo()
  }
})

// ── Undo ────────────────────────────────────────────────────────────────────
function pushUndo(ri, key, oldVal) {
  undoStack.push({ rowId: rowKey(rows[ri]), key, oldVal })
  if (undoStack.length > 100) undoStack.shift()
}

function applyUndo() {
  if (!undoStack.length) { toast('Nada para desfazer'); return }
  const entry = undoStack.pop()
  const ri = rows.findIndex(r => rowKey(r) === entry.rowId)
  if (ri < 0) { toast('Linha não encontrada','err'); return }

  rows[ri][entry.key] = entry.oldVal
  markDirty(ri)

  const ci = COLS.findIndex(c => c.key === entry.key)
  if (ci >= 0) {
    const td = getTd(ri, ci); if (td) {
      td.innerHTML = ''; td.appendChild(buildDisp(COLS[ci], entry.oldVal))
    }
  }
  toast('Desfeito!')
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const [bookings, clientList, blk] = await Promise.all([
      getBookings({}),
      getClients(),
      getBlockedDates(),
    ])
    clients = Object.fromEntries((clientList||[]).map(c => [c.id, c.company_name]))
    blocked = blk || []
    rows = (bookings||[]).map(b => ({
      ...b,
      _client_name: clients[b.client_id] || `Cliente ${b.client_id}`,
    }))
    buildThead()
    sortAndRebuild()
    $loading.style.display = 'none'
    $table.style.display   = ''

    // Restaurar rascunho local (alterações não salvas)
    restoreAutosaveIfAny()
  } catch(e) {
    $loading.textContent = 'Erro ao carregar. Recarregue a página.'
    console.error(e)
  }
}

// ── Cabeçalho ─────────────────────────────────────────────────────────────────
function buildThead() {
  $thead.innerHTML = ''
  const tr = document.createElement('tr')
  mkTh(tr, '', 'col-rn')
  COLS.forEach((c, ci) => {
    const th = mkTh(tr, c.label)
    th.style.width = c.w + 'px'
    const rz = document.createElement('div')
    rz.className = 'col-resizer'
    rz.addEventListener('mousedown', e => {
      e.preventDefault(); e.stopPropagation()
      resizing = { ci, startX: e.clientX, startW: c.w, el: rz }
      rz.classList.add('active')
    })
    th.appendChild(rz)
  })
  mkTh(tr, '', 'col-act')
  $thead.appendChild(tr)
  updateTableWidth()
}

function updateTableWidth() {
  const total = 36 + 32 + COLS.reduce((s, c) => s + c.w, 0)
  $table.style.width = Math.max(total, $table.parentElement?.clientWidth ?? 0) + 'px'
}

function mkTh(tr, txt, cls) {
  const th = document.createElement('th')
  th.textContent = txt; if (cls) th.className = cls
  tr.appendChild(th); return th
}

// ── Linhas ────────────────────────────────────────────────────────────────────
// Alterna cor a cada 3 linhas (3 spots por semana)
function buildTbody() {
  $tbody.innerHTML = ''
  rows.forEach((row, ri) => {
    const altWeek = Math.floor(ri / 3) % 2 === 1
    $tbody.appendChild(buildTr(row, ri, altWeek))
  })
}

function buildTr(row, ri, altWeek) {
  const tr = document.createElement('tr')
  tr.className  = 'sheet-row'
  tr.dataset.ri = ri
  if (altWeek) tr.classList.add('week-alt')
  if (dirty.has(rowKey(row))) tr.classList.add('row-dirty')
  if (activeKey === rowKey(row)) tr.classList.add('row-active')

  const tdN = document.createElement('td')
  tdN.className = 'col-rn'; tdN.textContent = ri+1
  tr.appendChild(tdN)

  COLS.forEach((col, ci) => tr.appendChild(buildTd(row, ri, col, ci)))

  const tdA = document.createElement('td'); tdA.className = 'col-act'
  const btn = document.createElement('button')
  btn.className = 'btn-del'; btn.textContent = '✕'; btn.title = 'Excluir'
  btn.addEventListener('mousedown', e => { e.preventDefault(); deleteRow(ri) })
  tdA.appendChild(btn); tr.appendChild(tdA)
  return tr
}

function buildTd(row, ri, col, ci) {
  const td = document.createElement('td')
  td.dataset.ri = ri; td.dataset.ci = ci

  if (col.type === 'status') {
    td.appendChild(buildDisp(col, row[col.key]))
    td.classList.add('status-editable')
    td.addEventListener('mousedown', e => {
      if (e.target.closest('.cell-ed')) return
      e.preventDefault()
      activateCell(ri, ci)
    })
  } else if (col.readonly) {
    const disp = buildDisp(col, row[col.key])
    disp.classList.add('cell-readonly')
    td.appendChild(disp)
  } else {
    td.appendChild(buildDisp(col, row[col.key]))
    td.addEventListener('mousedown', e => {
      if (e.target.closest('.cell-ed, .cell-link')) return
      e.preventDefault()
      activateCell(ri, ci)
    })
  }
  return td
}

function dispVal(col, val) {
  if (!val) return ''
  if (col.type === 'sel')  return (col.opts.find(([v]) => v === val)||[])[1] || val
  if (col.type === 'date') return formatDate(val)
  return val
}

function buildDisp(col, val) {
  const disp = document.createElement('div')
  disp.className = 'cell-disp'
  if (col.type === 'status') {
    const cfg = BOOKING_STATUS[val] || BOOKING_STATUS.rascunho
    const sp = document.createElement('span'); sp.className = 's-badge'
    sp.textContent = cfg.label
    sp.style.cssText = `background:${cfg.bg};color:${cfg.color}`
    disp.appendChild(sp)
  } else if (col.type === 'link' && val) {
    const a = document.createElement('a')
    a.href = /^https?:\/\//i.test(val) ? val : 'https://' + val
    a.target = '_blank'; a.rel = 'noopener noreferrer'
    a.className = 'cell-link'; a.textContent = val
    disp.appendChild(a)
  } else {
    disp.textContent = dispVal(col, val)
  }
  return disp
}

function rowKey(row) { return String(row.id) }

// ── Sort ──────────────────────────────────────────────────────────────────────
function sortAndRebuild() {
  rows.sort((a, b) => {
    if (!a.date && !b.date) return 0
    if (!a.date) return 1; if (!b.date) return -1
    const dc = a.date.localeCompare(b.date)
    if (dc !== 0) return dc
    return (a._client_name||'').localeCompare(b._client_name||'')
  })
  buildTbody()
}

// ── Datepicker ────────────────────────────────────────────────────────────────
const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
               'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro']

function openDp(ri) {
  dpRi = ri; activeKey = rowKey(rows[ri])
  const ds = rows[ri]?.date
  if (ds) { const [y,m] = ds.split('-'); dpDate = new Date(+y,+m-1,1) }
  else    { dpDate = new Date(); dpDate.setDate(1) }
  renderDp()
  const td = getTd(ri, DATE_CI)
  if (td) {
    const rect = td.getBoundingClientRect()
    let top = rect.bottom + 2, left = rect.left
    if (left + 230 > window.innerWidth - 4) left = window.innerWidth - 234
    if (top  + 260 > window.innerHeight)    top  = rect.top - 262
    $dp.style.top = top+'px'; $dp.style.left = left+'px'
    td.classList.add('dp-open')
  }
  document.querySelectorAll('.sheet-row').forEach(tr => tr.classList.remove('row-active'))
  getTr(ri)?.classList.add('row-active')
  $dp.style.display = 'block'
}

function hideDp() {
  if (dpRi === null) return
  $dp.style.display = 'none'
  $tbody.querySelectorAll('td.dp-open').forEach(td => td.classList.remove('dp-open'))
  dpRi = null
}

let tpOldVal = ''
function openTextPopup(ri, ci, anchorEl) {
  tpRi = ri; tpCi = ci; activeKey = rowKey(rows[ri])
  const col = COLS[ci]
  tpOldVal = rows[ri][col.key] || ''
  $tpLabel.textContent = col.label
  $tpArea.value = rows[ri][col.key] || ''
  const rect = anchorEl.getBoundingClientRect()
  const popW = 380, popH = 180
  let top = rect.bottom + 4, left = rect.left
  if (left + popW > window.innerWidth - 4) left = window.innerWidth - popW - 4
  if (top  + popH > window.innerHeight)    top  = rect.top - popH - 4
  $tp.style.top = top+'px'; $tp.style.left = left+'px'
  $tp.style.display = 'block'
  anchorEl.classList.add('dp-open')
  document.querySelectorAll('.sheet-row').forEach(tr => tr.classList.remove('row-active'))
  getTr(ri)?.classList.add('row-active')
  $tpArea.focus()
  const len = $tpArea.value.length; $tpArea.setSelectionRange(len, len)
  $tpArea.oninput = () => {
    if (tpRi === null) return
    rows[tpRi][COLS[tpCi].key] = $tpArea.value
    markDirty(tpRi)
    const disp = getTd(tpRi, tpCi)?.querySelector('.cell-disp')
    if (disp) disp.textContent = $tpArea.value
  }
}

function hideTextPopup() {
  if (tpRi === null) return
  const col = COLS[tpCi]
  const newVal = rows[tpRi]?.[col.key] || ''
  if (newVal !== tpOldVal) pushUndo(tpRi, col.key, tpOldVal)
  $tp.style.display = 'none'
  $tbody.querySelectorAll('td.dp-open').forEach(td => td.classList.remove('dp-open'))
  tpRi = null; tpCi = null; $tpArea.oninput = null
}

function renderDp() {
  const y = dpDate.getFullYear(), m = dpDate.getMonth()
  $dpTtl.textContent = `${MESES[m]} ${y}`
  $dpGrid.innerHTML = ''
  ;['Seg','Ter','Qua','Qui','Sex','Sáb','Dom'].forEach(d => {
    const h = document.createElement('div'); h.className = 'dp-wd'; h.textContent = d
    $dpGrid.appendChild(h)
  })
  const fdow = new Date(y,m,1).getDay()
  const offset = fdow === 0 ? 6 : fdow - 1
  for (let i = 0; i < offset; i++) $dpGrid.appendChild(document.createElement('div'))

  const today = toISODate(new Date())
  const selDs = dpRi !== null ? rows[dpRi]?.date : null
  const curRow = dpRi !== null ? rows[dpRi] : null
  // Datas tomadas por bookings confirmados do mesmo slot (excluindo a linha atual)
  const takenDates = new Set(
    rows.filter(r =>
      r.id     !== curRow?.id &&
      r.newsletter === curRow?.newsletter &&
      r.format     === curRow?.format &&
      ['pendente','aprovado','veiculado'].includes(r.status)
    ).map(r => r.date)
  )
  const days = new Date(y, m+1, 0).getDate()
  for (let d = 1; d <= days; d++) {
    const ds  = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    const dow = new Date(ds+'T12:00:00').getDay()
    const isBlk = dow===0 || dow===6 || FERIADOS_BR.includes(ds) || blocked.some(b=>b.date===ds) || takenDates.has(ds)
    const el = document.createElement('div')
    el.textContent = d
    el.className = 'dp-d ' + (isBlk ? 'dp-blocked' : 'dp-free')
    if (ds === today) el.classList.add('dp-today')
    if (ds === selDs) el.classList.add('dp-sel')
    if (!isBlk) el.addEventListener('click', () => pickDate(ds))
    $dpGrid.appendChild(el)
  }
}

function pickDate(ds) {
  if (dpRi === null) return
  const ri = dpRi
  pushUndo(ri, 'date', rows[ri].date || '')
  rows[ri].date = ds; markDirty(ri); hideDp(); sortAndRebuild()
  const newRi = rows.findIndex(r => rowKey(r) === activeKey)
  if (newRi >= 0) {
    const nextCi = EDITABLE_CI[EDITABLE_CI.indexOf(DATE_CI) + 1] ?? EDITABLE_CI[0]
    activateCell(newRi, nextCi)
  }
}

// ── Ativação de célula ────────────────────────────────────────────────────────
function activateCell(ri, ci) {
  const col = COLS[ci]
  if (!col || col.readonly) return

  if (col.type === 'date') {
    if (active) closeCell(active.ri, active.ci)
    if (dpRi === ri) return
    hideDp(); openDp(ri); return
  }
  if (col.type === 'longtext') {
    if (active) closeCell(active.ri, active.ci)
    hideDp()
    if (tpRi === ri && tpCi === ci) return
    hideTextPopup()
    const td = getTd(ri, ci); if (!td) return
    openTextPopup(ri, ci, td); return
  }

  if (active) {
    if (active.ri === ri && active.ci === ci) return
    closeCell(active.ri, active.ci)
  }
  hideDp()

  const oldVal = rows[ri][col.key] || ''
  active = { ri, ci, oldVal }; activeKey = rowKey(rows[ri])
  const gen = ++activeGen
  document.querySelectorAll('.sheet-row').forEach(tr => tr.classList.remove('row-active'))
  getTr(ri)?.classList.add('row-active')

  const td = getTd(ri, ci); if (!td) return
  td.innerHTML = ''

  let ed
  if (col.type === 'sel' || col.type === 'status') {
    ed = document.createElement('select'); ed.className = 'cell-ed'
    const opts = col.type === 'status' ? STATUS_OPTS : col.opts
    opts.forEach(([v,l]) => {
      const o = document.createElement('option'); o.value=v; o.textContent=l
      if (rows[ri][col.key] === v) o.selected = true
      ed.appendChild(o)
    })
    ed.addEventListener('change', () => { rows[ri][col.key] = ed.value; markDirty(ri) })
  } else {
    ed = document.createElement('input'); ed.type = 'text'; ed.className = 'cell-ed'
    ed.value = rows[ri][col.key] || ''
    ed.addEventListener('input', () => { rows[ri][col.key] = ed.value; markDirty(ri) })
  }

  ed.addEventListener('keydown', e => handleKey(e, ri, ci))
  ed.addEventListener('blur', () => setTimeout(() => {
    if (active?.ri === ri && active?.ci === ci && activeGen === gen) closeCell(ri, ci)
  }, 120))

  td.appendChild(ed); ed.focus()
}

function closeCell(ri, ci) {
  if (!active || active.ri !== ri || active.ci !== ci) return
  const oldVal = active.oldVal
  active = null

  const col = COLS[ci]
  const newVal = rows[ri]?.[col.key] || ''
  if (newVal !== oldVal) pushUndo(ri, col.key, oldVal)

  const td = getTd(ri, ci); if (!td) return
  td.innerHTML = ''
  td.appendChild(buildDisp(col, rows[ri]?.[col.key]))

  // ISBN auto-fill: ao fechar o campo ISBN, busca dados do livro
  if (col.key === 'isbn') isbnAutoFill(ri)
}

// ── ISBN auto-fill ───────────────────────────────────────────────────────────
async function isbnAutoFill(ri) {
  const row = rows[ri]; if (!row) return
  const isbn = (row.isbn || '').replace(/[^0-9Xx]/g, '')
  if (isbn.length !== 10 && isbn.length !== 13) return

  row.isbn = isbn
  const isbnTd = getTd(ri, COLS.findIndex(c => c.key === 'isbn'))
  if (isbnTd) { isbnTd.innerHTML = ''; isbnTd.appendChild(buildDisp(COLS.find(c=>c.key==='isbn'), isbn)) }

  // Detecta se ISBN mudou — se sim, sobrescreve todos os campos
  const isbnChanged = row._lastIsbn && row._lastIsbn !== isbn
  row._lastIsbn = isbn

  try {
    const book = await getBookByISBN(isbn)
    const isEmpty = v => !v || v === '-'
    const fill = (key, val) => {
      if (val && (isbnChanged || isEmpty(row[key]))) {
        row[key] = val
        markDirty(ri)
        const ci = COLS.findIndex(c => c.key === key)
        const td = getTd(ri, ci); if (!td) return
        td.innerHTML = ''; td.appendChild(buildDisp(COLS[ci], val))
      }
    }
    if (book) {
      fill('campaign_name', book.titulo)
      fill('authorship', book.autor)
      fill('suggested_text', book.sinopse)
    }
    const coverUrl = METABOOKS_COVER_URL(isbn)
    row.cover_link = coverUrl
    markDirty(ri)
    const coverCi = COLS.findIndex(c => c.key === 'cover_link')
    const coverTd = getTd(ri, coverCi)
    if (coverTd) { coverTd.innerHTML = ''; coverTd.appendChild(buildDisp(COLS[coverCi], coverUrl)) }
  } catch (e) {
    console.warn('ISBN lookup failed:', e)
  }
}

function handleKey(e, ri, ci) {
  const col = COLS[ci]
  if (e.key === 'Escape') {
    e.preventDefault(); active = null; activeKey = null
    const td = getTd(ri, ci); if (!td) return
    td.innerHTML = ''; td.appendChild(buildDisp(col, rows[ri]?.[col.key])); return
  }
  if (e.key === 'Tab') {
    e.preventDefault()
    const nextCi = e.shiftKey ? prevEC(ci) : nextEC(ci)
    closeCell(ri, ci)
    if (nextCi !== null) activateCell(ri, nextCi)
    else {
      const nextRi = e.shiftKey ? ri-1 : ri+1
      if (nextRi >= 0 && nextRi < rows.length)
        activateCell(nextRi, e.shiftKey ? EDITABLE_CI[EDITABLE_CI.length-1] : EDITABLE_CI[0])
    }
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault(); closeCell(ri, ci)
    const nextRi = e.shiftKey ? ri-1 : ri+1
    if (nextRi >= 0 && nextRi < rows.length) activateCell(nextRi, ci); return
  }
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && col.type !== 'text') {
    e.preventDefault(); closeCell(ri, ci)
    const nri = e.key === 'ArrowUp' ? ri-1 : ri+1
    if (nri >= 0 && nri < rows.length) activateCell(nri, ci)
  }
}

function nextEC(ci) { const i=EDITABLE_CI.indexOf(ci); return i<EDITABLE_CI.length-1?EDITABLE_CI[i+1]:null }
function prevEC(ci) { const i=EDITABLE_CI.indexOf(ci); return i>0?EDITABLE_CI[i-1]:null }
function getTd(ri,ci){ return $tbody.querySelector(`tr[data-ri="${ri}"] td[data-ci="${ci}"]`) }
function getTr(ri)   { return $tbody.querySelector(`tr[data-ri="${ri}"]`) }

// ── Autosave local (localStorage) ────────────────────────────────────────────
const AUTOSAVE_KEY = `seiva_autosave_admin_${session.userId || session.clientId || 'unknown'}`
let autosaveTimer = null
function scheduleAutosave() {
  clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => {
    const dirtyRows = [...dirty].map(k => rows.find(r => rowKey(r) === k)).filter(Boolean)
    if (dirtyRows.length) {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ ts: Date.now(), rows: dirtyRows }))
    } else {
      localStorage.removeItem(AUTOSAVE_KEY)
    }
  }, 500)
}

function restoreAutosaveIfAny() {
  const raw = localStorage.getItem(AUTOSAVE_KEY)
  if (!raw) return
  try {
    const backup = JSON.parse(raw)
    if (!backup?.rows?.length) return
    const when = new Date(backup.ts).toLocaleString('pt-BR')
    if (!confirm(`Há alterações não salvas de ${when}. Deseja restaurar?`)) {
      localStorage.removeItem(AUTOSAVE_KEY); return
    }
    for (const saved of backup.rows) {
      const key = String(saved.id)
      const idx = rows.findIndex(r => rowKey(r) === key)
      if (idx >= 0) {
        rows[idx] = { ...rows[idx], ...saved }
        dirty.add(rowKey(rows[idx]))
      }
    }
    sortAndRebuild()
    updateSaveBtn()
    toast('Rascunho restaurado!','ok')
  } catch(e) { console.warn('Falha ao restaurar autosave:', e) }
}

// ── Dirty / Save ──────────────────────────────────────────────────────────────
function markDirty(ri) {
  dirty.add(rowKey(rows[ri]))
  getTr(ri)?.classList.add('row-dirty')
  updateSaveBtn()
  scheduleAutosave()
}

function updateSaveBtn() {
  const n = dirty.size
  $save.disabled    = n === 0
  $save.textContent = n ? `Salvar (${n})` : 'Salvar'
  $ind.textContent  = n ? `${n} não salva${n===1?'':'s'}` : ''
}

async function saveAll() {
  if (!dirty.size) return
  if (active) closeCell(active.ri, active.ci)
  hideDp(); hideTextPopup()
  $save.disabled = true; $save.textContent = 'Salvando…'
  const errs = []
  for (const key of [...dirty]) {
    const ri = rows.findIndex(r => rowKey(r) === key)
    if (ri < 0) continue
    const row = rows[ri]
    const payload = {
      date: row.date, newsletter: row.newsletter, format: row.format,
      status: row.status,
      campaign_name: row.campaign_name||'', authorship: row.authorship||'',
      isbn: row.isbn||'', suggested_text: row.suggested_text||'',
      extra_info: row.extra_info||'', promotional_period: row.promotional_period||'',
      cover_link: row.cover_link||'', redirect_link: row.redirect_link||'',
    }
    try {
      await updateBooking(row.id, payload)
      getTr(ri)?.classList.remove('row-dirty')
    } catch(e) { errs.push(`${row.date||'?'}: ${e.message}`) }
  }
  dirty.clear()
  if (!errs.length) localStorage.removeItem(AUTOSAVE_KEY)
  updateSaveBtn()
  errs.length ? toast('Erros: '+errs.join(' | '),'err') : toast('Salvo!','ok')
}

async function deleteRow(ri) {
  if (!confirm('Excluir esta linha?')) return
  const row = rows[ri]
  try { await deleteBooking(row.id) }
  catch(e) { toast('Erro ao excluir: '+e.message,'err'); return }
  if (active?.ri === ri) active = null
  if (dpRi === ri) hideDp()
  if (tpRi === ri) hideTextPopup()
  if (activeKey === rowKey(row)) activeKey = null
  rows.splice(ri, 1)
  dirty.delete(rowKey(row))
  buildTbody(); updateSaveBtn()
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let _tt
function toast(msg, type='info') {
  $toast.textContent = msg; $toast.className = `toast ${type} show`
  clearTimeout(_tt); _tt = setTimeout(() => $toast.classList.remove('show'), 3000)
}

init()
