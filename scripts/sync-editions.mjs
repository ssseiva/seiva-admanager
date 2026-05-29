// scripts/sync-editions.mjs
// Sincroniza spots da ad_bookings com edições enviadas no GetResponse.
// Roda diariamente via .github/workflows/sync-editions.yml às 9h BRT.
//
// Lógica:
//   1. Busca bookings de hoje no Directus (status != rejeitado, published_link vazio, campaign_name preenchido)
//   2. Busca newsletters enviadas hoje no GetResponse
//   3. Pra cada booking, procura o título (campaign_name) no HTML da edição correspondente (Aurora ou Índice)
//   4. Se achar, escreve o link da edição no published_link

const DIRECTUS_URL = 'https://directus-production-afdd.up.railway.app'
const DIRECTUS_TOKEN = process.env.DIRECTUS_TOKEN
const GETRESPONSE_API_KEY = process.env.GETRESPONSE_API_KEY

if (!DIRECTUS_TOKEN) { console.error('ERRO: DIRECTUS_TOKEN não definido'); process.exit(1) }
if (!GETRESPONSE_API_KEY) { console.error('ERRO: GETRESPONSE_API_KEY não definido'); process.exit(1) }

// ── Helpers ──────────────────────────────────────────────────────────────────

// Data de hoje no fuso BRT (UTC-3)
function todayBRT() {
  const now = new Date()
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000)
  const y = brt.getUTCFullYear()
  const m = String(brt.getUTCMonth() + 1).padStart(2, '0')
  const d = String(brt.getUTCDate()).padStart(2, '0')
  return { iso: `${y}-${m}-${d}`, br: `${d}/${m}/${y}` }
}

// Normaliza string pra match: lowercase + sem acentos + sem espaços extras
function norm(s) {
  if (!s) return ''
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

async function dx(path, opts = {}) {
  const res = await fetch(`${DIRECTUS_URL}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${DIRECTUS_TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  })
  if (!res.ok) throw new Error(`Directus ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

// Throttle simples + retry: o GetResponse derruba conexão (ECONNRESET) em
// rajadas. 150ms entre chamadas + até 2 retries em erros de rede.
let _grLast = 0
async function gr(path) {
  const wait = Math.max(0, 150 - (Date.now() - _grLast))
  if (wait) await new Promise(r => setTimeout(r, wait))
  _grLast = Date.now()
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://api.getresponse.com/v3${path}`, {
        headers: { 'X-Auth-Token': `api-key ${GETRESPONSE_API_KEY}`, 'Content-Type': 'application/json' },
      })
      if (!res.ok) throw new Error(`GetResponse ${path}: ${res.status} ${await res.text()}`)
      return res.json()
    } catch (e) {
      const transient = /ECONNRESET|fetch failed|network|ETIMEDOUT/i.test(e.message)
      if (attempt === 2 || !transient) throw e
      await new Promise(r => setTimeout(r, 1500))
    }
  }
}

// YYYY-MM-DD -> DD/MM/YYYY (formato do campo `name` das newsletters)
function isoToBR(dateIso) {
  const [y, m, d] = dateIso.split('-')
  return `${d}/${m}/${y}`
}

// Normaliza URL p/ comparação: host sem www + path sem barra final,
// ignorando query (?...) e fragmento (#...).
function normUrl(u) {
  if (!u) return ''
  try {
    const x = new URL(u.trim())
    return (x.host.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '')).toLowerCase()
  } catch {
    return u.split('?')[0].split('#')[0].replace(/\/+$/, '').toLowerCase()
  }
}

// Marca dos avisos gerados por este script em admin_notes, pra dar pra atualizar
// idempotentemente sem mexer no que foi escrito por humanos.
const SYNC_TAG = '[sync-veic]'

// ── Verificação de slot dos veiculados ───────────────────────────────────────
// Pra cada veiculado de hoje com redirect_link, confere se o link bate com a
// edição esperada (date+newsletter). Se não bate, procura em ±2 dias e na outra
// newsletter; quando acha, escreve aviso em admin_notes. Idempotente.

async function verifySlots(today, opts = {}) {
  const all = !!opts.all
  console.log(`\n── Verificando slot dos veiculados (${all ? 'TODOS' : 'de hoje'}) ──`)
  const dateClause = all ? [] : [{ date: { _eq: today.iso } }]
  const filter = encodeURIComponent(JSON.stringify({
    _and: [...dateClause, { status: { _eq: 'veiculado' } }],
  }))
  const res = await dx(`/items/ad_bookings?filter=${filter}&fields=id,date,newsletter,campaign_name,redirect_link,admin_notes&limit=-1`)
  const bookings = res.data || []
  if (!bookings.length) { console.log('Nenhum veiculado pra verificar.'); return }
  console.log(`Verificando ${bookings.length} spot(s)...`)

  const edCache = new Map(), ctCache = new Map()
  async function findEd(dateIso, kind) {
    const br = isoToBR(dateIso)
    const key = `${br}|${kind}`
    if (edCache.has(key)) return edCache.get(key)
    const list = await gr(`/newsletters?query[name]=${encodeURIComponent(br)}&perPage=20`)
    const want = kind === 'aurora' ? /aurora/i : /[ií]ndice/i
    const ed = (list || []).find(n => want.test(n.name || '')) || null
    edCache.set(key, ed); return ed
  }
  async function getCT(id) {
    if (ctCache.has(id)) return ctCache.get(id)
    const obj = await gr(`/newsletters/${id}`)
    const ct = obj?.clickTracks || []
    ctCache.set(id, ct); return ct
  }
  async function searchNearby(dateIso, link, expectedKind) {
    if (!link) return null
    const alvo = normUrl(link); if (!alvo) return null
    const otherKind = expectedKind === 'aurora' ? 'indice' : 'aurora'
    const base = new Date(dateIso + 'T12:00:00')
    const addDays = (n) => { const d = new Date(base); d.setDate(base.getDate() + n); return d.toISOString().slice(0, 10) }
    const cands = [
      { dateIso, kind: otherKind },
      { dateIso: addDays(1),  kind: expectedKind }, { dateIso: addDays(1),  kind: otherKind },
      { dateIso: addDays(-1), kind: expectedKind }, { dateIso: addDays(-1), kind: otherKind },
      { dateIso: addDays(2),  kind: expectedKind }, { dateIso: addDays(2),  kind: otherKind },
      { dateIso: addDays(-2), kind: expectedKind }, { dateIso: addDays(-2), kind: otherKind },
    ]
    for (const c of cands) {
      const ed = await findEd(c.dateIso, c.kind)
      if (!ed) continue
      const ct = await getCT(ed.newsletterId || ed.id)
      const matches = ct.filter(t => normUrl(t.url) === alvo)
      if (matches.length) {
        const clicks = matches.reduce((a, t) => a + (Number(t.amount) || 0), 0)
        return { kind: c.kind, dateBR: isoToBR(c.dateIso), clicks }
      }
    }
    return null
  }

  let okN = 0, mismatchN = 0, notFoundN = 0, semLinkN = 0
  for (const b of bookings) {
    let msg = ''
    if (!b.redirect_link) {
      msg = `${SYNC_TAG} Spot sem redirect_link salvo — não dá pra medir cliques no link.`
      semLinkN++
    } else {
      const ed = await findEd(b.date, b.newsletter)
      if (!ed) {
        const label = b.newsletter === 'aurora' ? 'Aurora' : 'Índice'
        msg = `${SYNC_TAG} Edição da ${label} não encontrada no GetResponse para ${isoToBR(b.date)}.`
        notFoundN++
      } else {
        const ct = await getCT(ed.newsletterId || ed.id)
        const alvo = normUrl(b.redirect_link)
        if (ct.some(t => normUrl(t.url) === alvo)) { okN++ /* msg fica vazio: limpa avisos antigos */ }
        else {
          const found = await searchNearby(b.date, b.redirect_link, b.newsletter)
          if (found) {
            const label = found.kind === 'aurora' ? 'Aurora' : 'Índice'
            msg = `${SYNC_TAG} Slot do booking parece errado: link foi achado na ${label} de ${found.dateBR} (${found.clicks} cliques).`
            mismatchN++
          } else {
            msg = `${SYNC_TAG} Link do booking não foi achado nem na edição esperada nem em vizinhas (±2d). Confira se é o mesmo link do email.`
            notFoundN++
          }
        }
      }
    }

    // Idempotente: remove linha [sync-veic] antiga e adiciona a nova se houver.
    const current = b.admin_notes || ''
    const others = current.split('\n').filter(l => !l.trim().startsWith(SYNC_TAG)).join('\n').trim()
    const wanted = msg ? (others ? `${others}\n${msg}` : msg) : others
    if (wanted !== current) {
      try {
        await dx(`/items/ad_bookings/${b.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ admin_notes: wanted || null }),
        })
        console.log(`  ${msg ? '⚠️' : '✓'} #${b.id} ${b.campaign_name || ''} → ${msg || 'link OK, aviso anterior removido'}`)
      } catch (e) {
        console.log(`  ✗ #${b.id}: erro ao atualizar admin_notes: ${e.message}`)
      }
    }
  }
  console.log(`Verificação: ${okN} OK | ${mismatchN} slot errado | ${notFoundN} link/edição não encontrado | ${semLinkN} sem redirect_link`)
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const today = todayBRT()
  console.log(`\n═══ Sync editions — ${today.br} (${today.iso}) ═══\n`)

  // Modo backfill: pula a parte de published_link, verifica TODOS os veiculados.
  if (process.argv.slice(2).includes('--verify-all')) {
    console.log('Modo --verify-all: verificando todos os veiculados (qualquer data).\n')
    await verifySlots(today, { all: true })
    return
  }

  // 1. Bookings de hoje sem published_link
  const filter = encodeURIComponent(JSON.stringify({
    _and: [
      { date: { _eq: today.iso } },
      { status: { _neq: 'rejeitado' } },
      { _or: [{ published_link: { _null: true } }, { published_link: { _eq: '' } }] },
      { campaign_name: { _nnull: true } },
      { campaign_name: { _neq: '' } },
    ],
  }))
  const bookingsRes = await dx(`/items/ad_bookings?filter=${filter}&limit=-1`)
  const bookings = bookingsRes.data || []
  console.log(`Bookings pendentes hoje: ${bookings.length}`)
  if (!bookings.length) {
    console.log('Nada a sincronizar. Indo direto pra verificação de slots…')
    await verifySlots(today)
    return
  }

  // 2. Newsletters de hoje — filtramos por name "DD/MM/YYYY" (a API NÃO aceita
  //    filtro por data de envio: query[sentOnFrom] retorna 400).
  const newsletters = await gr(`/newsletters?query[name]=${encodeURIComponent(today.br)}&perPage=20`)
  console.log(`Newsletters de hoje: ${newsletters.length}`)

  // Loga shape do primeiro objeto pra debug (nome dos campos da URL pública)
  if (newsletters[0]) {
    console.log('\n[debug] estrutura da primeira newsletter:')
    console.log(JSON.stringify(newsletters[0], null, 2).slice(0, 2000))
    console.log('...\n')
  }

  // Mapeia por tipo (aurora/indice)
  const byType = { aurora: null, indice: null }
  for (const nl of newsletters) {
    const n = norm(nl.subject || nl.name || '')
    if (n.includes('aurora')) byType.aurora = nl
    else if (n.includes('indice')) byType.indice = nl
  }
  console.log(`Aurora: ${byType.aurora ? byType.aurora.subject || byType.aurora.name : 'não encontrada'}`)
  console.log(`Índice: ${byType.indice ? byType.indice.subject || byType.indice.name : 'não encontrada'}`)

  // 3. Pra cada newsletter encontrada, busca o conteúdo HTML (sem isso, não tem como matchar)
  const contents = {}
  for (const [type, nl] of Object.entries(byType)) {
    if (!nl) continue
    try {
      const full = await gr(`/newsletters/${nl.newsletterId || nl.id}`)
      contents[type] = {
        html: norm(full.content?.html || full.content?.plain || ''),
        url: full.href || full.previewUrl || full.webView || full.content?.href || null,
        meta: full,
      }
      // Loga o objeto completo da primeira newsletter pra debug
      if (Object.keys(contents).length === 1) {
        console.log(`\n[debug] objeto completo da newsletter ${type}:`)
        console.log(JSON.stringify(full, null, 2).slice(0, 3000))
        console.log('...\n')
      }
    } catch (e) {
      console.log(`Erro ao buscar conteúdo da ${type}: ${e.message}`)
    }
  }

  // 4. Match e update
  let updated = 0, skipped = 0
  for (const b of bookings) {
    const type = b.newsletter // 'aurora' ou 'indice'
    const content = contents[type]
    if (!content) {
      console.log(`  · booking #${b.id} (${b.campaign_name}) — newsletter ${type} não foi enviada hoje, pulando`)
      skipped++
      continue
    }
    const titleNorm = norm(b.campaign_name)
    if (!titleNorm || titleNorm.length < 3) { skipped++; continue }
    if (content.html.includes(titleNorm)) {
      const url = content.url
      if (!url) {
        console.log(`  · booking #${b.id} (${b.campaign_name}) — match no HTML mas sem URL pública na resposta da API`)
        skipped++
        continue
      }
      try {
        await dx(`/items/ad_bookings/${b.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ published_link: url }),
        })
        console.log(`  ✓ booking #${b.id} (${b.campaign_name}) → ${url}`)
        updated++
      } catch (e) {
        console.log(`  ✗ booking #${b.id} (${b.campaign_name}) — erro ao atualizar: ${e.message}`)
        skipped++
      }
    } else {
      console.log(`  · booking #${b.id} (${b.campaign_name}) — não encontrado no HTML da ${type}`)
      skipped++
    }
  }

  console.log(`\n═══ Resumo published_link: ${updated} atualizados, ${skipped} pulados ═══\n`)

  // 5. Verificação de slot: confere link contra a edição esperada e flaga
  //    em admin_notes quando o slot do booking parece estar errado.
  await verifySlots(today)
}

main().catch(e => {
  console.error('Erro fatal:', e)
  process.exit(1)
})
