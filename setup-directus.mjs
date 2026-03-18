/**
 * setup-directus.mjs
 * Roda UMA VEZ para criar as collections, roles e usuário de serviço
 * no Directus do projeto Seiva Ad Manager.
 *
 * Uso: node setup-directus.mjs
 */

import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'

const DIRECTUS_URL = 'https://directus-production-afdd.up.railway.app'
const ADMIN_TOKEN = 'ynOx8xSSe-PVHMUBIlz0nG9YetXgAxU5'

async function req(method, path, body = null) {
  const res = await fetch(`${DIRECTUS_URL}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { raw: text } }
  if (!res.ok && res.status !== 409) {
    console.error(`  ✗ ${method} ${path} → ${res.status}`, data?.errors?.[0]?.message || text.slice(0, 200))
    return null
  }
  return data
}

async function createCollection(name, fields, meta = {}) {
  console.log(`\nCriando collection: ${name}`)
  const res = await req('POST', '/collections', {
    collection: name,
    meta: { hidden: false, singleton: false, icon: 'receipt_long', ...meta },
    schema: {},
    fields,
  })
  if (res) console.log(`  ✓ collection criada`)
  else console.log(`  ~ já existe ou ignorada`)
}

async function addField(collection, field) {
  const res = await req('POST', `/fields/${collection}`, field)
  if (res?.data) process.stdout.write('.')
}

async function createRole(name, description = '') {
  console.log(`\nCriando role: ${name}`)
  // Check if already exists
  const existing = await req('GET', `/roles?filter[name][_eq]=${encodeURIComponent(name)}&fields=id`)
  if (existing?.data?.[0]?.id) {
    console.log(`  ~ role já existe: ${existing.data[0].id}`)
    return existing.data[0].id
  }
  const res = await req('POST', '/roles', { name, description, icon: 'supervised_user_circle' })
  if (res?.data?.id) {
    console.log(`  ✓ role criada: ${res.data.id}`)
    return res.data.id
  }
  return null
}

// Directus v11: permissions are attached to "policies", which are then linked to roles
async function createPolicyForRole(roleId, roleName) {
  // Check if policy exists
  const existing = await req('GET', `/policies?filter[name][_eq]=${encodeURIComponent(roleName + ' Policy')}&fields=id`)
  if (existing?.data?.[0]?.id) {
    return existing.data[0].id
  }
  const res = await req('POST', '/policies', {
    name: roleName + ' Policy',
    icon: 'lock',
    description: `Auto-created policy for role ${roleName}`,
    ip_access: null,
    enforce_tfa: false,
    admin_access: false,
    app_access: false,
  })
  const policyId = res?.data?.id
  if (policyId) {
    // Directus v11: link policy to role via /access junction
    await req('POST', '/access', { role: roleId, policy: policyId })
    console.log(`  ✓ policy criada e vinculada: ${policyId}`)
  }
  return policyId
}

async function createPermission(policyId, collection, action, fields = '*') {
  if (!policyId) return
  await req('POST', '/permissions', {
    policy: policyId,
    collection,
    action,
    fields,
    permissions: {},
    validation: {},
  })
  process.stdout.write('.')
}

// ─── Collections ─────────────────────────────────────────────────────────────

const AD_CLIENTS_FIELDS = [
  { field: 'id', type: 'integer', schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true, readonly: true } },
  { field: 'status', type: 'string', schema: { default_value: 'published' }, meta: { hidden: true, special: ['cast-to-string'] } },
  { field: 'date_created', type: 'timestamp', schema: {}, meta: { hidden: true, special: ['date-created'], readonly: true } },
  { field: 'company_name', type: 'string', schema: { is_nullable: false }, meta: { required: true, sort: 1, width: 'full', interface: 'input', display: 'raw' } },
  { field: 'access_code', type: 'string', schema: { is_nullable: false }, meta: { required: true, sort: 2, width: 'half', interface: 'input', note: 'Código único de acesso do cliente' } },
  { field: 'contact_email', type: 'string', schema: {}, meta: { sort: 3, width: 'half', interface: 'input' } },
  { field: 'active', type: 'boolean', schema: { default_value: true }, meta: { sort: 4, width: 'half', interface: 'boolean' } },
  { field: 'notes', type: 'text', schema: {}, meta: { sort: 5, width: 'full', interface: 'input-multiline' } },
]

const AD_QUOTAS_FIELDS = [
  { field: 'id', type: 'integer', schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true, readonly: true } },
  { field: 'client_id', type: 'integer', schema: { is_nullable: false, foreign_key_table: 'ad_clients', foreign_key_column: 'id' }, meta: { required: true, sort: 1, width: 'half', interface: 'select-dropdown-m2o', display: 'related-values', display_options: { template: '{{company_name}}' } } },
  { field: 'newsletter', type: 'string', schema: { is_nullable: false }, meta: { required: true, sort: 2, width: 'half', interface: 'select-dropdown', options: { choices: [{ text: 'Aurora', value: 'aurora' }, { text: 'Índice', value: 'indice' }, { text: 'Ambas', value: 'ambas' }] } } },
  { field: 'format', type: 'string', schema: { is_nullable: false }, meta: { required: true, sort: 3, width: 'half', interface: 'select-dropdown', options: { choices: [{ text: 'Destaque', value: 'destaque' }, { text: 'Corpo do Email', value: 'corpo' }, { text: 'Ambos', value: 'ambos' }] } } },
  { field: 'total_slots', type: 'integer', schema: { is_nullable: false }, meta: { required: true, sort: 4, width: 'half', interface: 'input' } },
  { field: 'expires_at', type: 'date', schema: {}, meta: { sort: 5, width: 'half', interface: 'datetime' } },
  { field: 'notes', type: 'text', schema: {}, meta: { sort: 6, width: 'full', interface: 'input-multiline' } },
]

const AD_BOOKINGS_FIELDS = [
  { field: 'id', type: 'integer', schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true, readonly: true } },
  { field: 'date_created', type: 'timestamp', schema: {}, meta: { hidden: true, special: ['date-created'], readonly: true } },
  { field: 'client_id', type: 'integer', schema: { is_nullable: false, foreign_key_table: 'ad_clients', foreign_key_column: 'id' }, meta: { required: true, sort: 1, width: 'half', interface: 'select-dropdown-m2o', display: 'related-values', display_options: { template: '{{company_name}}' } } },
  { field: 'status', type: 'string', schema: { default_value: 'pendente' }, meta: { required: true, sort: 2, width: 'half', interface: 'select-dropdown', options: { choices: [{ text: 'Rascunho', value: 'rascunho' }, { text: 'Pendente', value: 'pendente' }, { text: 'Aprovado', value: 'aprovado' }, { text: 'Rejeitado', value: 'rejeitado' }] } } },
  { field: 'date', type: 'date', schema: { is_nullable: false }, meta: { required: true, sort: 3, width: 'half', interface: 'datetime' } },
  { field: 'newsletter', type: 'string', schema: { is_nullable: false }, meta: { required: true, sort: 4, width: 'half', interface: 'select-dropdown', options: { choices: [{ text: 'Aurora', value: 'aurora' }, { text: 'Índice', value: 'indice' }] } } },
  { field: 'format', type: 'string', schema: { is_nullable: false }, meta: { required: true, sort: 5, width: 'half', interface: 'select-dropdown', options: { choices: [{ text: 'Destaque', value: 'destaque' }, { text: 'Corpo do Email', value: 'corpo' }] } } },
  { field: 'campaign_name', type: 'string', schema: { is_nullable: false }, meta: { required: true, sort: 6, width: 'full', interface: 'input', note: 'Título ou nome da campanha' } },
  { field: 'authorship', type: 'string', schema: {}, meta: { sort: 7, width: 'half', interface: 'input', note: 'Autoria do conteúdo' } },
  { field: 'campaign', type: 'string', schema: {}, meta: { sort: 8, width: 'half', interface: 'input', note: 'Nome da campanha/produto' } },
  { field: 'suggested_text', type: 'text', schema: { is_nullable: false }, meta: { required: true, sort: 9, width: 'full', interface: 'input-multiline', note: 'Texto sugerido (200–500 caracteres)' } },
  { field: 'promotional_period', type: 'string', schema: {}, meta: { sort: 10, width: 'full', interface: 'input', note: 'Período promocional (opcional)' } },
  { field: 'cover_link', type: 'string', schema: {}, meta: { sort: 11, width: 'half', interface: 'input' } },
  { field: 'redirect_link', type: 'string', schema: {}, meta: { sort: 12, width: 'half', interface: 'input' } },
  { field: 'admin_notes', type: 'text', schema: {}, meta: { sort: 13, width: 'full', interface: 'input-multiline', note: 'Notas internas (admin/redator)' } },
]

const AD_BLOCKED_DATES_FIELDS = [
  { field: 'id', type: 'integer', schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true, readonly: true } },
  { field: 'date', type: 'date', schema: { is_nullable: false }, meta: { required: true, sort: 1, width: 'half', interface: 'datetime' } },
  { field: 'reason', type: 'string', schema: {}, meta: { sort: 2, width: 'half', interface: 'input' } },
  { field: 'is_holiday', type: 'boolean', schema: { default_value: false }, meta: { sort: 3, width: 'half', interface: 'boolean', note: 'Feriado nacional automático' } },
]

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════')
  console.log('  Seiva Ad Manager — Setup Directus')
  console.log('═══════════════════════════════════════════════════')

  // 1. Collections
  await createCollection('ad_clients', AD_CLIENTS_FIELDS, { icon: 'business', display_template: '{{company_name}}' })
  await createCollection('ad_quotas', AD_QUOTAS_FIELDS, { icon: 'pie_chart', display_template: '{{client_id}} — {{newsletter}} {{format}}' })
  await createCollection('ad_bookings', AD_BOOKINGS_FIELDS, { icon: 'event', display_template: '{{date}} — {{newsletter}} {{format}} — {{campaign_name}}' })
  await createCollection('ad_blocked_dates', AD_BLOCKED_DATES_FIELDS, { icon: 'event_busy', display_template: '{{date}} — {{reason}}' })

  // 2. Relations
  console.log('\n\nCriando relações FK...')
  const rels = [
    { collection: 'ad_quotas', field: 'client_id', related_collection: 'ad_clients' },
    { collection: 'ad_bookings', field: 'client_id', related_collection: 'ad_clients' },
  ]
  for (const rel of rels) {
    const r = await req('POST', '/relations', { ...rel, meta: { one_field: null, sort_field: null } })
    if (r) process.stdout.write(` ✓ ${rel.collection}.${rel.field}`)
  }

  // 3. Role: Redator
  const redatorRoleId = await createRole('Redator', 'Equipe editorial — leitura total, pode adicionar notas')
  if (redatorRoleId) {
    console.log('  Criando policy para Redator...')
    const redatorPolicyId = await createPolicyForRole(redatorRoleId, 'Redator')
    console.log('  Permissões para Redator...')
    const rCols = ['ad_clients', 'ad_quotas', 'ad_bookings', 'ad_blocked_dates']
    for (const col of rCols) {
      await createPermission(redatorPolicyId, col, 'read')
    }
    await createPermission(redatorPolicyId, 'ad_bookings', 'update', ['admin_notes', 'status'])
    console.log(' ✓')
  }

  // 4. Role + User de serviço para anunciantes
  const serviceRoleId = await createRole('Anunciante Service', 'Role de serviço para acesso via código')
  if (serviceRoleId) {
    console.log('  Criando policy para Anunciante Service...')
    const servicePolicyId = await createPolicyForRole(serviceRoleId, 'Anunciante Service')
    console.log('  Permissões para Anunciante Service...')
    await createPermission(servicePolicyId, 'ad_clients', 'read', ['id', 'company_name', 'active', 'access_code'])
    await createPermission(servicePolicyId, 'ad_bookings', 'read', ['id', 'date', 'newsletter', 'format', 'status', 'campaign_name', 'authorship', 'campaign', 'suggested_text', 'promotional_period', 'cover_link', 'redirect_link', 'client_id'])
    await createPermission(servicePolicyId, 'ad_bookings', 'create', '*')
    await createPermission(servicePolicyId, 'ad_bookings', 'update', ['campaign_name', 'authorship', 'campaign', 'suggested_text', 'promotional_period', 'cover_link', 'redirect_link', 'status'])
    await createPermission(servicePolicyId, 'ad_quotas', 'read', ['id', 'client_id', 'newsletter', 'format', 'total_slots', 'expires_at'])
    await createPermission(servicePolicyId, 'ad_blocked_dates', 'read')
    console.log(' ✓')
  }

  // 5. Criar usuário de serviço com token estático
  console.log('\nCriando usuário de serviço...')
  const serviceToken = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
  const serviceEmail = 'service.admanager@seiva.com.br'

  let existingServiceUser = await req('GET', `/users?filter[email][_eq]=${encodeURIComponent(serviceEmail)}&fields=id`)
  let serviceUserId = existingServiceUser?.data?.[0]?.id

  if (!serviceUserId) {
    const newUser = await req('POST', '/users', {
      email: serviceEmail,
      password: randomUUID(),
      first_name: 'Seiva',
      last_name: 'AdService',
      role: serviceRoleId,
      token: serviceToken,
      status: 'active',
    })
    serviceUserId = newUser?.data?.id
    if (serviceUserId) {
      console.log(`  ✓ Usuário de serviço criado: ${serviceEmail}`)
    } else {
      console.log(`  ✗ Falha ao criar usuário de serviço`)
    }
  } else {
    await req('PATCH', `/users/${serviceUserId}`, { token: serviceToken })
    console.log(`  ✓ Token do usuário de serviço atualizado`)
  }

  // 6. Atualizar config.js com o service token
  console.log('\nAtualizando config.js com o service token...')
  try {
    let configContent = readFileSync('./config.js', 'utf-8')
    configContent = configContent.replace(
      /export const SERVICE_TOKEN = '.*?'/,
      `export const SERVICE_TOKEN = '${serviceToken}'`
    )
    writeFileSync('./config.js', configContent)
    console.log('  ✓ config.js atualizado')
  } catch (e) {
    console.log(`  ✗ Não foi possível atualizar config.js: ${e.message}`)
    console.log(`  → SERVICE_TOKEN = '${serviceToken}'`)
  }

  console.log('\n═══════════════════════════════════════════════════')
  console.log('  Setup concluído!')
  console.log('═══════════════════════════════════════════════════')
  console.log('\nPróximos passos:')
  console.log('  1. Inicie o servidor: npm start (ou node server.js)')
  console.log('  2. Acesse http://localhost:3000')
  console.log('  3. Faça login com sua conta admin do Directus')
  console.log('  4. Crie o primeiro cliente no Painel Admin')
  console.log('\nNota: o SERVICE_TOKEN foi salvo em config.js')
  console.log('Guarde-o em segurança!\n')
}

main().catch(e => {
  console.error('\nErro fatal:', e)
  process.exit(1)
})
