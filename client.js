// client.js — Interface planilha para anunciantes
import { requireAuth, logout } from './auth.js'
import { getBookings, createBooking, updateBooking, deleteBooking, getBlockedDates } from './api.js'
import { FERIADOS_BR, BOOKING_STATUS, formatDate, toISODate } from './config.js'

// ── Auth ──────────────────────────────────────────────────────────────────────
const session = requireAuth('/index.html')
if (!session) throw new Error()
if (session.role !== 'anunciante') { window.location.href = 'app.html'; throw new Error() }

const clientId   = session.clientId
const clientName = session.clientName || 'Anunciante'

// ── Colunas ───────────────────────────────────────────────────────────────────
const COLS = [
  { key: 'date',               label: 'Data',              w: 108, type: 'date' },
  { key: 'newsletter',         label: 'Newsletter',         w:  96, type: 'sel', opts: [['aurora','Aurora'],['indice','Índice']] },
  { key: 'format',             label: 'Formato',            w: 120, type: 'sel', opts: [['destaque','Destaque'],['corpo','Corpo do Email']] },
  { key: 'status',             label: 'Status',             w: 130, type: 'badge' },
  { key: 'campaign_name',      label: 'Nome da Campanha',   w: 220, type: 'text' },
  { key: 'authorship',         label: 'Autoria',            w: 158, type: 'text' },
  { key: 'isbn',               label: 'ISBN',               w: 120, type: 'text' },
  { key: 'suggested_text',     label: 'Texto Sugerido',     w: 290, type: 'text' },
  { key: 'extra_info',         label: 'Informações Extras', w: 200, type: 'text' },
  { key: 'promotional_period', label: 'Período Promo',      w: 138, type: 'text' },
  { key: 'cover_link',         label: 'Link da Capa',       w: 190, type: 'text' },
  { key: 'redirect_link',      label: 'Link Redirect',      w: 190, type: 'text' },
]
const DATE_CI     = COLS.findIndex(c => c.type === 'date')
const EDITABLE_CI = COLS.map((c,i) => c.type !== 'badge' ? i : -1).filter(i => i >= 0)

// ── Estado ────────────────────────────────────────────────────────────────────
let rows      = []
let blocked   = []
let dirty     = new Set()
let active    = null    // { ri, ci } — célula com editor inline (não-data)
let activeKey = null    // rowKey da linha destacada
let dpRi      = null    // índice da linha com datepicker aberto
let dpDate    = new Date()
let newCnt    = 0

// ── DOM ───────────────────────────────────────────────────────────────────────
const $name    = document.getElementById('client-name')
const $ind     = document.getElementById('save-ind')
const $save    = document.getElementById('btn-save')
const $table   = document.getElementById('sheet-table')
const $thead   = document.getElementById('sheet-thead')
const $tbody   = document.getElementById('sheet-tbody')
const $loading = document.getElementById('sheet-loading')
const $addBar  = document.getElementById('add-row-bar')
const $dp      = document.getElementById('datepicker')
const $dpTtl   = document.getElementById('dp-title')
const $dpGrid  = document.getElementById('dp-grid')
const $toast   = document.getElementById('toast')

$name.textContent = clientName
document.getElementById('btn-logout').addEventListener('click', logout)
$save.addEventListener('click', saveAll)
document.getElementById('btn-add').addEventListener('click', addRow)

// Navegação do datepicker
document.getElementById('dp-prev').addEventListener('mousedown', e => e.stopPropagation())
document.getElementById('dp-next').addEventListener('mousedown', e => e.stopPropagation())
document.getElementById('dp-prev').addEventListener('click', () => { dpDate.setMonth(dpDate.getMonth()-1); renderDp() })
document.getElementById('dp-next').addEventListener('click', () => { dpDate.setMonth(dpDate.getMonth()+1); renderDp() })

// Fecha datepicker ao clicar fora (fase capture, antes do mousedown das células)
document.addEventListener('mousedown', e => {
  if (dpRi === null) return
  if ($dp.contains(e.target)) return       // clique dentro do picker → mantém
  // clique numa célula de data → o handler da célula vai reabrir para a nova linha
  hideDp()
}, true)

// Fecha datepicker com Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && dpRi !== null) { e.preventDefault(); hideDp() }
})

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const [own, blk] = await Promise.all([
      getBookings({ clientId }),
      getBlockedDates(),
    ])
    rows    = (own || []).map(b => ({ ...b }))
    blocked = blk || []

    buildThead()
    sortAndRebuild()

    $loading.style.display = 'none'
    $table.style.display   = ''
    $addBar.style.display  = ''
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
  COLS.forEach(c => { const th = mkTh(tr, c.label); th.style.minWidth = th.style.width = c.w+'px' })
  mkTh(tr, '', 'col-act')
  $thead.appendChild(tr)
}
function mkTh(tr, txt, cls) {
  const th = document.createElement('th')
  th.textContent = txt; if (cls) th.className = cls
  tr.appendChild(th); return th
}

// ── Linhas ────────────────────────────────────────────────────────────────────
function buildTbody() {
  $tbody.innerHTML = ''
  rows.forEach((row, ri) => $tbody.appendChild(buildTr(row, ri)))
}

function buildTr(row, ri) {
  const tr = document.createElement('tr')
  tr.className  = 'sheet-row'
  tr.dataset.ri = ri
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

  if (col.type === 'badge') {
    const cfg = BOOKING_STATUS[row.status] || BOOKING_STATUS.rascunho
    const wrap = document.createElement('div'); wrap.className = 'cell-disp'
    const sp = document.createElement('span'); sp.className = 's-badge'
    sp.textContent = cfg.label; sp.style.cssText = `background:${cfg.bg};color:${cfg.color}`
    wrap.appendChild(sp); td.appendChild(wrap)
  } else {
    const disp = document.createElement('div')
    disp.className   = 'cell-disp'
    disp.textContent = dispVal(col, row[col.key])
    td.appendChild(disp)
    // mousedown abre o editor.
    // Não chamamos preventDefault em nenhum caso para que o browser posicione
    // o cursor normalmente (seleção de texto, drag-to-select, clique para mover cursor).
    // O único efeito colateral (td receber foco visual) não ocorre pois td não é focusável.
    td.addEventListener('mousedown', e => {
      if (e.target.closest('.cell-ed')) return   // editor já aberto: browser cuida de tudo
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

function rowKey(row) { return String(row.id || row._tid) }

// ── Sort ──────────────────────────────────────────────────────────────────────
function sortAndRebuild() {
  rows.sort((a, b) => {
    if (!a.date && !b.date) return 0
    if (!a.date) return 1
    if (!b.date) return -1
    return a.date.localeCompare(b.date)
  })
  buildTbody()
}

// ── Datepicker ────────────────────────────────────────────────────────────────
const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
               'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro']

function openDp(ri) {
  dpRi = ri
  activeKey = rowKey(rows[ri])

  // Navega para o mês da data atual da linha
  const ds = rows[ri]?.date
  if (ds) { const [y,m] = ds.split('-'); dpDate = new Date(+y,+m-1,1) }
  else    { dpDate = new Date(); dpDate.setDate(1) }

  renderDp()

  // Posiciona abaixo da célula de data
  const td = getTd(ri, DATE_CI)
  if (td) {
    const rect = td.getBoundingClientRect()
    let top  = rect.bottom + 2
    let left = rect.left
    const dpW = 230
    if (left + dpW > window.innerWidth - 4) left = window.innerWidth - dpW - 4
    if (top + 260 > window.innerHeight)     top  = rect.top - 262
    $dp.style.top  = top  + 'px'
    $dp.style.left = left + 'px'
    td.classList.add('dp-open')
  }

  // Destaca a linha
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

function renderDp() {
  const y = dpDate.getFullYear(), m = dpDate.getMonth()
  $dpTtl.textContent = `${MESES[m]} ${y}`
  $dpGrid.innerHTML = ''

  ;['Seg','Ter','Qua','Qui','Sex','Sáb','Dom'].forEach(d => {
    const h = document.createElement('div'); h.className = 'dp-wd'; h.textContent = d
    $dpGrid.appendChild(h)
  })

  const fdow   = new Date(y,m,1).getDay()
  const offset = fdow === 0 ? 6 : fdow - 1
  for (let i = 0; i < offset; i++) {
    $dpGrid.appendChild(document.createElement('div'))
  }

  const today = toISODate(new Date())
  const selDs = dpRi !== null ? rows[dpRi]?.date : null
  const days  = new Date(y, m+1, 0).getDate()

  for (let d = 1; d <= days; d++) {
    const ds  = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    const dow = new Date(ds+'T12:00:00').getDay()
    const isBlk = dow===0 || dow===6 || FERIADOS_BR.includes(ds) || blocked.some(b => b.date===ds)
    const el = document.createElement('div')
    el.textContent = d
    el.className   = 'dp-d ' + (isBlk ? 'dp-blocked' : 'dp-free')
    if (ds === today) el.classList.add('dp-today')
    if (ds === selDs) el.classList.add('dp-sel')
    if (!isBlk) el.addEventListener('click', () => pickDate(ds))
    $dpGrid.appendChild(el)
  }
}

function pickDate(ds) {
  if (dpRi === null) return
  const ri = dpRi
  rows[ri].date = ds
  markDirty(ri)
  hideDp()
  sortAndRebuild()
  // Após sort, move foco para a próxima coluna (newsletter) para facilitar preenchimento
  const newRi = rows.findIndex(r => rowKey(r) === activeKey)
  if (newRi >= 0) {
    const nextCi = EDITABLE_CI[EDITABLE_CI.indexOf(DATE_CI) + 1] ?? EDITABLE_CI[0]
    activateCell(newRi, nextCi)
  }
}

// ── Ativação de célula ────────────────────────────────────────────────────────
function activateCell(ri, ci) {
  const col = COLS[ci]
  if (!col || col.type === 'badge') return

  // ── Célula de DATA → abre datepicker ──────────────────────────────────────
  if (col.type === 'date') {
    // Fecha editor inline se houver
    if (active) closeCell(active.ri, active.ci)
    // Se o picker já está aberto para ESTA linha, não faz nada (não fecha)
    if (dpRi === ri) return
    // Abre picker para esta linha (fecha qualquer picker anterior)
    hideDp()
    openDp(ri)
    return
  }

  // ── Outras células → editor inline ───────────────────────────────────────
  // Fecha o editor se for uma célula diferente
  if (active) {
    if (active.ri === ri && active.ci === ci) return   // já ativa: não faz nada
    closeCell(active.ri, active.ci)
  }
  // Fecha datepicker se aberto
  hideDp()

  active    = { ri, ci }
  activeKey = rowKey(rows[ri])

  // Destaca linha
  document.querySelectorAll('.sheet-row').forEach(tr => tr.classList.remove('row-active'))
  getTr(ri)?.classList.add('row-active')

  const td = getTd(ri, ci); if (!td) return
  td.innerHTML = ''

  let ed
  if (col.type === 'sel') {
    ed = document.createElement('select'); ed.className = 'cell-ed'
    col.opts.forEach(([v,l]) => {
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
    if (active?.ri === ri && active?.ci === ci) closeCell(ri, ci)
  }, 120))

  td.appendChild(ed)
  ed.focus()
}

// ── Fecha editor inline ───────────────────────────────────────────────────────
function closeCell(ri, ci) {
  if (!active || active.ri !== ri || active.ci !== ci) return
  active = null

  const td = getTd(ri, ci); if (!td) return
  const col = COLS[ci]
  td.innerHTML = ''
  const disp = document.createElement('div'); disp.className = 'cell-disp'
  disp.textContent = dispVal(col, rows[ri]?.[col.key])
  td.appendChild(disp)
  // Nota: NÃO re-adiciona mousedown — o listener original do buildTd permanece no td
}

// ── Teclado ───────────────────────────────────────────────────────────────────
function handleKey(e, ri, ci) {
  const col = COLS[ci]

  if (e.key === 'Escape') {
    e.preventDefault()
    active = null; activeKey = null
    const td = getTd(ri, ci); if (!td) return
    td.innerHTML = ''
    const disp = document.createElement('div'); disp.className = 'cell-disp'
    disp.textContent = dispVal(col, rows[ri]?.[col.key])
    td.appendChild(disp)
    return
  }

  if (e.key === 'Tab') {
    e.preventDefault()
    const nextCi = e.shiftKey ? prevEC(ci) : nextEC(ci)
    closeCell(ri, ci)
    if (nextCi !== null) {
      activateCell(ri, nextCi)
    } else {
      const nextRi = e.shiftKey ? ri - 1 : ri + 1
      if (nextRi >= 0 && nextRi < rows.length) {
        const wrapCi = e.shiftKey ? EDITABLE_CI[EDITABLE_CI.length-1] : EDITABLE_CI[0]
        activateCell(nextRi, wrapCi)
      }
    }
    return
  }

  if (e.key === 'Enter') {
    e.preventDefault()
    closeCell(ri, ci)
    const nextRi = e.shiftKey ? ri - 1 : ri + 1
    if (nextRi >= 0 && nextRi < rows.length) activateCell(nextRi, ci)
    return
  }

  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && col.type !== 'text') {
    e.preventDefault()
    closeCell(ri, ci)
    const nri = e.key === 'ArrowUp' ? ri-1 : ri+1
    if (nri >= 0 && nri < rows.length) activateCell(nri, ci)
  }
}

function nextEC(ci) { const i = EDITABLE_CI.indexOf(ci); return i < EDITABLE_CI.length-1 ? EDITABLE_CI[i+1] : null }
function prevEC(ci) { const i = EDITABLE_CI.indexOf(ci); return i > 0 ? EDITABLE_CI[i-1] : null }
function getTd(ri,ci) { return $tbody.querySelector(`tr[data-ri="${ri}"] td[data-ci="${ci}"]`) }
function getTr(ri)    { return $tbody.querySelector(`tr[data-ri="${ri}"]`) }

// ── Dirty / Save ──────────────────────────────────────────────────────────────
function markDirty(ri) {
  dirty.add(rowKey(rows[ri]))
  getTr(ri)?.classList.add('row-dirty')
  updateSaveBtn()
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
  hideDp()
  $save.disabled = true; $save.textContent = 'Salvando…'

  const errs = []
  for (const key of [...dirty]) {
    const ri  = rows.findIndex(r => rowKey(r) === key)
    if (ri < 0) continue
    const row = rows[ri]
    const payload = {
      date: row.date, newsletter: row.newsletter, format: row.format,
      campaign_name: row.campaign_name||'', authorship: row.authorship||'',
      isbn: row.isbn||'', suggested_text: row.suggested_text||'-',
      extra_info: row.extra_info||'', promotional_period: row.promotional_period||'',
      cover_link: row.cover_link||'', redirect_link: row.redirect_link||'',
    }
    try {
      if (row.id) {
        await updateBooking(row.id, payload)
      } else {
        const created = await createBooking({ ...payload, client_id: clientId, status: 'rascunho' })
        row.id = created.id; delete row._tid
      }
      getTr(ri)?.classList.remove('row-dirty')
    } catch(e) { errs.push(`${row.date||'?'}: ${e.message}`) }
  }

  dirty.clear()
  updateSaveBtn()
  errs.length ? toast('Erros: '+errs.join(' | '),'err') : toast('Salvo!','ok')
}

// ── Adicionar / Excluir ───────────────────────────────────────────────────────
function addRow() {
  if (active) closeCell(active.ri, active.ci)
  hideDp()
  newCnt++
  const row = {
    _tid: `new-${newCnt}`, client_id: clientId,
    date:'', newsletter:'aurora', format:'destaque', status:'rascunho',
    campaign_name:'', authorship:'', isbn:'', suggested_text:'',
    extra_info:'', promotional_period:'', cover_link:'', redirect_link:'',
  }
  rows.push(row)
  dirty.add(rowKey(row))
  updateSaveBtn()
  const ri = rows.length - 1
  $tbody.appendChild(buildTr(row, ri))
  // Rola até a nova linha e abre o datepicker
  getTr(ri)?.scrollIntoView({ block: 'nearest' })
  activateCell(ri, DATE_CI)
}

async function deleteRow(ri) {
  if (!confirm('Excluir esta linha?')) return
  const row = rows[ri]
  if (row.id) {
    try { await deleteBooking(row.id) }
    catch(e) { toast('Erro ao excluir: '+e.message,'err'); return }
  }
  if (active?.ri === ri) { active = null }
  if (dpRi === ri) hideDp()
  if (activeKey === rowKey(row)) activeKey = null
  rows.splice(ri, 1)
  dirty.delete(rowKey(row))
  buildTbody()
  updateSaveBtn()
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let _tt
function toast(msg, type='info') {
  $toast.textContent = msg; $toast.className = `toast ${type} show`
  clearTimeout(_tt); _tt = setTimeout(() => $toast.classList.remove('show'), 3000)
}

init()
