import type { Session } from '@supabase/supabase-js'
import { lazy, Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { configOk, supabase } from './lib/supabase'

// Una página por chunk. MapLibre son ~230 kB gzip y solo lo usan /admin y el
// chofer: quien abre el enlace de su equipo ya no se descarga además el panel
// de admin entero, ni al revés.
const Admin = lazy(() => import('./pages/Admin'))
const Driver = lazy(() => import('./pages/Driver'))
const Home = lazy(() => import('./pages/Home'))
const Login = lazy(() => import('./pages/Login'))

export default function App() {
  // undefined = todavía no sabemos si hay sesión; null = no hay.
  const [session, setSession] = useState<Session | null | undefined>(undefined)

  useEffect(() => {
    if (!configOk) return
    void supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  if (!configOk) {
    return (
      <div className="splash">
        <h1>Falta configurar</h1>
        <p className="muted">
          Copia <code>.env.example</code> a <code>.env</code> y llena{' '}
          <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_ANON_KEY</code>.
        </p>
      </div>
    )
  }

  return (
    <BrowserRouter>
      <Suspense fallback={<div className="splash" />}>
        <Routes>
          <Route path="/" element={<Home />} />
          {/* Link individual del chofer. Sin login y sin ver a los demás. */}
          <Route path="/d/:token" element={<Driver />} />
          {/* Link general: el chofer elige su equipo de una lista. */}
          <Route path="/seleccion" element={<Driver />} />
          <Route path="/d" element={<Navigate to="/seleccion" replace />} />
          <Route
            path="/admin"
            element={
              session === undefined ? <div className="splash" /> : session ? <Admin /> : <Login />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
