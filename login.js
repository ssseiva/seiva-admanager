// login.js
import { loginUnified, getSession } from './auth.js'

// Se já está logado, redireciona
const session = getSession()
if (session) window.location.href = 'app.html'

function setLoading(btn, loading) {
  btn.disabled = loading
  btn.textContent = loading ? 'Aguarde...' : 'Entrar'
}

function showError(el, msg) {
  el.textContent = msg
  el.style.display = 'flex'
}

function hideError(el) {
  el.style.display = 'none'
}

document.getElementById('form-login').addEventListener('submit', async e => {
  e.preventDefault()
  const username = document.getElementById('login-username').value.trim()
  const password = document.getElementById('login-password').value
  const btn = document.getElementById('btn-login')
  const errEl = document.getElementById('error-login')
  hideError(errEl)
  setLoading(btn, true)
  try {
    await loginUnified(username, password)
    window.location.href = 'app.html'
  } catch (err) {
    showError(errEl, err.message || 'Usuário ou senha inválidos.')
    setLoading(btn, false)
  }
})
