// sheet.js — Planilha admin unificada (todos os clientes)
import { requireAuth, logout } from './auth.js'
import { getBookings, createBooking, updateBooking, deleteBooking, getClients, getBlockedDates, getBookByISBN } from './api.js'
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
  { key: 'campaign',        label: 'Infos Extras',       w: 160, type: 'longtext' },
  { key: 'extra_info',      label: 'Cupom',              w: 160, type: 'longtext' },
  { key: 'promotional_period', label: 'Período Promo',   w: 138, type: 'text' },
  { key: 'cover_link',      label: 'Imagem',             w: 190, type: 'link' },
  { key: 'redirect_link',   label: 'Link Redirect',      w: 190, type: 'link' },
  { key: 'published_link',  label: 'Edição Publicada',   w: 190, type: 'link', readonly: true },
]
const DATE_CI     = COLS.findIndex(c => c.type === 'date')
const EDITABLE_CI = COLS.map((c,i) => c.type !== 'status' && !c.readonly ? i : -1).filter(i => i >= 0)

// Em spots já veiculados, só o conteúdo é editável. Estes campos definem o
// "slot" (data/newsletter/formato) e o status — ficam travados pra não quebrar
// o casamento da edição usado no relatório de veiculação.
const LOCKED_WHEN_VEICULADO = new Set(['date', 'newsletter', 'format', 'status'])

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
let copiedRow = null  // campos copiados de uma linha

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
    e.preventDefault()
    if (active) closeCell(active.ri, active.ci)
    if (dpRi !== null) hideDp()
    if (tpRi !== null) hideTextPopup()
    applyUndo()
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'v' && !e.shiftKey) {
    if (!copiedRow) return
    if (!activeKey) { toast('Clique em uma linha antes de colar','err'); return }
    const ri = rows.findIndex(r => rowKey(r) === activeKey)
    if (ri < 0) return
    e.preventDefault()
    if (active) closeCell(active.ri, active.ci)
    if (tpRi !== null) hideTextPopup()
    pasteRow(ri)
  }
})

// ── Undo ────────────────────────────────────────────────────────────────────
// Tipos: 'field', 'insert', 'delete'
function pushUndo(ri, key, oldVal) {
  undoStack.push({ type: 'field', rowId: rowKey(rows[ri]), key, oldVal })
  if (undoStack.length > 100) undoStack.shift()
}
function pushUndoInsert(ri) {
  undoStack.push({ type: 'insert', rowId: rowKey(rows[ri]) })
  if (undoStack.length > 100) undoStack.shift()
}
function pushUndoDelete(row, position) {
  undoStack.push({ type: 'delete', row: { ...row }, position })
  if (undoStack.length > 100) undoStack.shift()
}

function applyUndo() {
  if (!undoStack.length) { toast('Nada para desfazer'); return }
  const entry = undoStack.pop()

  if (entry.type === 'insert') {
    const ri = rows.findIndex(r => rowKey(r) === entry.rowId)
    if (ri < 0) { toast('Linha não encontrada','err'); return }
    rows.splice(ri, 1)
    dirty.delete(entry.rowId)
    updateSaveBtn()
    buildTbody()
    toast('Inserção desfeita')
    return
  }

  if (entry.type === 'delete') {
    const row = entry.row
    if (row.id) {
      const { id, ...payload } = row
      createBooking(payload).then(saved => {
        const idx = rows.findIndex(r => rowKey(r) === rowKey(row))
        if (idx >= 0) { rows[idx] = saved; buildTbody() }
      }).catch(err => {
        console.warn('Falha ao restaurar via API:', err)
        toast('Restaurada localmente, salve para persistir','err')
      })
      const tempRow = { ...row, _tid: `restored-${Date.now()}` }
      delete tempRow.id
      rows.splice(entry.position, 0, tempRow)
      dirty.add(rowKey(tempRow))
    } else {
      rows.splice(entry.position, 0, row)
      dirty.add(rowKey(row))
    }
    updateSaveBtn()
    buildTbody()
    toast('Linha restaurada')
    return
  }

  // type === 'field'
  const ri = rows.findIndex(r => rowKey(r) === entry.rowId)
  if (ri < 0) { toast('Linha não encontrada','err'); return }

  rows[ri][entry.key] = entry.oldVal
  markDirty(ri)

  const ci = COLS.findIndex(c => c.key === entry.key)
  if (ci >= 0) {
    const td = getTd(ri, ci); if (td) {
      td.innerHTML = ''; td.appendChild(buildDisp(COLS[ci], visibleVal(rows[ri], COLS[ci])))
    }
  }
  if (entry.key === 'isbn' || entry.key === 'campaign_name') {
    const dateCi = COLS.findIndex(c => c.type === 'date')
    if (dateCi >= 0) {
      const dateTd = getTd(ri, dateCi)
      if (dateTd) {
        dateTd.innerHTML = ''
        dateTd.appendChild(buildDisp(COLS[dateCi], visibleVal(rows[ri], COLS[dateCi])))
      }
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
    rows = (bookings||[]).map((b, i) => ({
      ...b,
      _client_name: clients[b.client_id] || `Cliente ${b.client_id}`,
      _origIdx: i,
    }))
    _origIdxCounter = rows.length
    populateClientFilter(clientList || [])
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
    const th = mkTh(tr, '')
    th.style.width = c.w + 'px'
    if (c.type === 'date') {
      th.classList.add('th-sortable')
      const arrow = sortDir === 'asc' ? ' ▲' : sortDir === 'desc' ? ' ▼' : ''
      th.textContent = c.label + arrow
      th.addEventListener('click', e => {
        if (e.target.classList.contains('col-resizer')) return
        cycleSortDir()
      })
    } else {
      th.textContent = c.label
    }
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
// Filtro de cliente (string vazia = todas as empresas)
let clientFilter = ''

function populateClientFilter(clientList) {
  const sel = document.getElementById('filter-client')
  if (!sel) return
  // Ordena alfabeticamente por nome
  const sorted = [...clientList].sort((a,b) => (a.company_name||'').localeCompare(b.company_name||''))
  for (const c of sorted) {
    const opt = document.createElement('option')
    opt.value = String(c.id)
    opt.textContent = c.company_name
    sel.appendChild(opt)
  }
  sel.addEventListener('change', () => {
    clientFilter = sel.value
    buildTbody()
  })
}

function buildTbody() {
  $tbody.innerHTML = ''
  let visIdx = 0
  rows.forEach((row, ri) => {
    if (clientFilter && String(row.client_id) !== clientFilter) return
    const altWeek = Math.floor(visIdx / 3) % 2 === 1
    $tbody.appendChild(buildTr(row, ri, altWeek))
    visIdx++
  })
}

function buildTr(row, ri, altWeek) {
  const tr = document.createElement('tr')
  tr.className  = 'sheet-row'
  tr.dataset.ri = ri
  if (altWeek) tr.classList.add('week-alt')
  if (dirty.has(rowKey(row))) tr.classList.add('row-dirty')
  if (activeKey === rowKey(row)) tr.classList.add('row-active')
  if (row.status === 'veiculado') tr.classList.add('row-veiculado')

  const tdN = document.createElement('td')
  tdN.className = 'col-rn'; tdN.textContent = ri+1
  tr.appendChild(tdN)

  COLS.forEach((col, ci) => tr.appendChild(buildTd(row, ri, col, ci)))

  const tdA = document.createElement('td'); tdA.className = 'col-act'
  const btnCopy = document.createElement('button')
  btnCopy.className = 'btn-copy'; btnCopy.textContent = '⎘'; btnCopy.title = 'Copiar linha (Ctrl+V para colar)'
  btnCopy.addEventListener('mousedown', e => { e.preventDefault(); copyRow(ri) })
  tdA.appendChild(btnCopy)
  const btn = document.createElement('button')
  btn.className = 'btn-del'; btn.textContent = '✕'; btn.title = 'Limpar informações'
  btn.addEventListener('mousedown', e => { e.preventDefault(); clearRow(ri) })
  tdA.appendChild(btn); tr.appendChild(tdA)

  // Menu de contexto (botão direito) — bloqueado em linhas veiculadas
  tr.addEventListener('contextmenu', e => {
    e.preventDefault()
    if (rows[ri]?.status === 'veiculado') return
    showContextMenu(e.pageX, e.pageY, ri)
  })

  return tr
}

// ── Menu de contexto (botão direito) ──────────────────────────────────────────
let ctxMenuEl = null
function hideContextMenu() {
  if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null }
}
function showContextMenu(x, y, ri) {
  hideContextMenu()
  const menu = document.createElement('div')
  menu.className = 'ctx-menu'
  menu.style.left = `${x}px`
  menu.style.top  = `${y}px`
  const items = [
    { label: 'Inserir linha acima', action: () => insertRowAbove(ri) },
    { label: 'Inserir linha abaixo', action: () => insertRowBelow(ri) },
    { label: '——', sep: true },
    { label: 'Copiar linha', action: () => copyRow(ri) },
    { label: 'Apagar data', action: () => clearDate(ri) },
    { label: 'Limpar informações', action: () => clearRow(ri) },
    { label: '——', sep: true },
    { label: 'Deletar linha', action: () => deleteRow(ri), danger: true },
  ]
  for (const it of items) {
    if (it.sep) {
      const sep = document.createElement('div')
      sep.className = 'ctx-sep'
      menu.appendChild(sep)
      continue
    }
    const div = document.createElement('div')
    div.className = 'ctx-item' + (it.danger ? ' ctx-danger' : '')
    div.textContent = it.label
    div.addEventListener('click', () => { hideContextMenu(); it.action() })
    menu.appendChild(div)
  }
  document.body.appendChild(menu)
  ctxMenuEl = menu
  const rect = menu.getBoundingClientRect()
  if (rect.right > window.innerWidth) menu.style.left = `${x - rect.width}px`
  if (rect.bottom > window.innerHeight) menu.style.top = `${y - rect.height}px`
}
document.addEventListener('click', () => hideContextMenu())
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideContextMenu() })
window.addEventListener('scroll', () => hideContextMenu(), true)

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
    const disp = buildDisp(col, visibleVal(row, col))
    disp.classList.add('cell-readonly')
    td.appendChild(disp)
  } else {
    td.appendChild(buildDisp(col, visibleVal(row, col)))
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

// Set de rowKeys onde o usuário escolheu uma data manualmente nesta sessão.
const userPickedDates = new Set()
const clearedDates   = new Set()

// Lógica de exibição da data
function visibleVal(row, col) {
  if (col.type !== 'date') return row[col.key]
  const rk = rowKey(row)
  if (clearedDates.has(rk)) return ''
  if (userPickedDates.has(rk)) return row[col.key]
  if ((row.status || 'rascunho') !== 'rascunho') return row[col.key]
  if ((row.campaign_name || '').trim() || (row.isbn || '').trim()) return row[col.key]
  return ''
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
// Sort manual no admin: estado controlado por clique no header "Data"
let sortDir = null
let _origIdxCounter = 0

function sortAndRebuild() {
  buildTbody()
}

function applySort() {
  if (sortDir === null) {
    rows.sort((a, b) => (a._origIdx ?? 0) - (b._origIdx ?? 0))
  } else {
    rows.sort((a, b) => {
      const da = a.date || ''
      const db = b.date || ''
      if (!da && !db) return (a._origIdx ?? 0) - (b._origIdx ?? 0)
      if (!da) return 1
      if (!db) return -1
      const cmp = da.localeCompare(db)
      return sortDir === 'asc' ? cmp : -cmp
    })
  }
}

function cycleSortDir() {
  sortDir = sortDir === null ? 'asc' : sortDir === 'asc' ? 'desc' : null
  applySort()
  buildThead()
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
  const selDs = (dpRi !== null && !clearedDates.has(rowKey(rows[dpRi] || {}))) ? rows[dpRi]?.date : null
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
  rows[ri].date = ds
  const rk = rowKey(rows[ri])
  userPickedDates.add(rk)
  clearedDates.delete(rk)
  markDirty(ri); hideDp(); sortAndRebuild()
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
  // Veiculado: só conteúdo é editável (data/newsletter/formato/status travados)
  if (rows[ri]?.status === 'veiculado' && LOCKED_WHEN_VEICULADO.has(col.key)) return

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
  td.appendChild(buildDisp(col, visibleVal(rows[ri], col)))

  // Se mudou ISBN ou campanha, atualiza tb a c\u00e9lula de data
  if (col.key === 'isbn' || col.key === 'campaign_name') {
    const dateCi = COLS.findIndex(c => c.type === 'date')
    if (dateCi >= 0) {
      const dateTd = getTd(ri, dateCi)
      if (dateTd) {
        dateTd.innerHTML = ''
        dateTd.appendChild(buildDisp(COLS[dateCi], visibleVal(rows[ri], COLS[dateCi])))
      }
    }
  }

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

  try {
    const book = await getBookByISBN(isbn)
    // Sempre sobrescreve quando há ISBN válido (registra no undo)
    const fill = (key, val) => {
      if (!val) return
      const oldVal = row[key] || ''
      if (oldVal !== val) {
        pushUndo(ri, key, oldVal)
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
    fill('cover_link', METABOOKS_COVER_URL(isbn))
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
      campaign: row.campaign||'',
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

// Campos de conteúdo que podem ser copiados/limpos
const CONTENT_FIELDS = ['campaign_name','authorship','isbn','suggested_text','campaign','extra_info','promotional_period','cover_link','redirect_link']

function copyRow(ri) {
  const row = rows[ri]; if (!row) return
  copiedRow = {}
  for (const f of CONTENT_FIELDS) copiedRow[f] = row[f] || ''
  toast('Linha copiada (Ctrl+V para colar em outra)','ok')
}

function pasteRow(ri) {
  if (!copiedRow) return
  const row = rows[ri]; if (!row) return
  for (const f of CONTENT_FIELDS) {
    const oldVal = row[f] || ''
    const newVal = copiedRow[f] || ''
    if (oldVal !== newVal) {
      pushUndo(ri, f, oldVal)
      row[f] = newVal
    }
  }
  markDirty(ri)
  buildTbody()
  toast('Linha colada (Ctrl+Z para desfazer)','ok')
}

// Insere uma linha vazia em posição específica (acima ou abaixo da ri).
// Copia client_id e _client_name da linha de origem (admin geralmente
// quer adicionar outro spot pro mesmo cliente).
function insertRowAt(targetIndex, sourceRi) {
  if (active) closeCell(active.ri, active.ci)
  hideDp(); hideTextPopup()
  const src = rows[sourceRi] || {}
  const row = {
    _tid: `new-${Date.now()}`,
    client_id: src.client_id,
    _client_name: src._client_name || '',
    _origIdx: _origIdxCounter++,
    date:'', newsletter:'aurora', format:'destaque', status:'rascunho',
    campaign_name:'', authorship:'', isbn:'', suggested_text:'',
    campaign:'', extra_info:'', promotional_period:'', cover_link:'', redirect_link:'',
  }
  rows.splice(targetIndex, 0, row)
  dirty.add(rowKey(row))
  pushUndoInsert(targetIndex)
  updateSaveBtn()
  buildTbody()
  getTr(targetIndex)?.scrollIntoView({ block: 'nearest' })
  activateCell(targetIndex, DATE_CI)
}
function insertRowAbove(ri) { insertRowAt(ri, ri) }
function insertRowBelow(ri) { insertRowAt(ri + 1, ri) }

// Apaga a data da linha (esconde visualmente).
function clearDate(ri) {
  const row = rows[ri]; if (!row) return
  const rk = rowKey(row)
  clearedDates.add(rk)
  userPickedDates.delete(rk)
  const dateCi = COLS.findIndex(c => c.type === 'date')
  if (dateCi >= 0) {
    const td = getTd(ri, dateCi)
    if (td) {
      td.innerHTML = ''
      td.appendChild(buildDisp(COLS[dateCi], visibleVal(row, COLS[dateCi])))
    }
  }
  toast('Data apagada (clique para escolher outra)')
}

// Deleta a linha inteira (do banco se tiver id, e do array local).
// Pode ser desfeito com Ctrl+Z.
async function deleteRow(ri) {
  const row = rows[ri]; if (!row) return
  if (!confirm('Deletar a linha inteira? (Ctrl+Z restaura)')) return
  if (active?.ri === ri) { closeCell(active.ri, active.ci); active = null }
  if (dpRi === ri) hideDp()
  if (tpRi === ri) hideTextPopup()

  pushUndoDelete(row, ri)
  if (row.id) {
    try { await deleteBooking(row.id) }
    catch (e) { console.warn('Falha ao deletar no servidor:', e); toast('Erro ao deletar no servidor','err') }
  }
  rows.splice(ri, 1)
  dirty.delete(rowKey(row))
  userPickedDates.delete(rowKey(row))
  updateSaveBtn()
  buildTbody()
  toast('Linha deletada (Ctrl+Z restaura)')
}

// Limpa apenas os campos de conteúdo da linha (preserva data, newsletter,
// formato e status). Não apaga a linha do servidor.
function clearRow(ri) {
  const row = rows[ri]; if (!row) return
  if (!confirm('Limpar as informações desta linha?')) return
  if (active?.ri === ri) { closeCell(active.ri, active.ci); active = null }
  if (dpRi === ri) hideDp()
  if (tpRi === ri) hideTextPopup()

  const fields = ['campaign_name','authorship','isbn','suggested_text','campaign','extra_info','promotional_period','cover_link','redirect_link']
  for (const f of fields) {
    if (row[f]) pushUndo(ri, f, row[f])
    row[f] = ''
  }
  delete row._lastIsbn
  markDirty(ri)
  buildTbody()
  toast('Informações limpas (Ctrl+Z para desfazer)','ok')
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let _tt
function toast(msg, type='info') {
  $toast.textContent = msg; $toast.className = `toast ${type} show`
  clearTimeout(_tt); _tt = setTimeout(() => $toast.classList.remove('show'), 3000)
}

init()
