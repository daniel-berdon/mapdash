import { LogIn } from 'lucide-react'
import { useState } from 'react'
import Brand from '../components/Brand'
import { supabase } from '../lib/supabase'

// Supabase Auth solo sabe de correos, pero el organizador no quiere escribir
// uno. Se le pega un dominio interno al usuario: escribe "admin", entra como
// admin@mapdash.local. El usuario se crea a mano con ese mismo correo.
const DOMAIN = '@mapdash.local'

// Un solo admin. Sin registro, sin recuperación, sin roles: nada de eso hace
// falta para un evento de un día, y cada pantalla de más es una que mantener.
export default function Login() {
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    const { error } = await supabase.auth.signInWithPassword({
      email: user.trim().toLowerCase() + DOMAIN,
      password,
    })
    if (error) setErr('Usuario o contraseña incorrectos')
    setBusy(false)
  }

  return (
    <form className="splash" onSubmit={submit}>
      <Brand big />
      <p className="muted">Panel de control</p>
      <input
        type="text"
        placeholder="usuario"
        value={user}
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        onChange={(e) => setUser(e.target.value)}
        required
      />
      <input
        type="password"
        placeholder="contraseña"
        value={password}
        autoComplete="current-password"
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {err && <p className="err">{err}</p>}
      <button className="b-primary b-big" disabled={busy}>
        <LogIn size={18} />
        {busy ? 'Entrando…' : 'Entrar'}
      </button>
    </form>
  )
}
