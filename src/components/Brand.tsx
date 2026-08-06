import { useState } from 'react'

// El logo lo pone el cliente en public/. Se prueban los dos formatos y, si no
// hay ninguno, queda solo el nombre: mejor eso que un icono de imagen rota.
const SOURCES = ['/logo.svg', '/logo.png']

export default function Brand({ big, name = true }: { big?: boolean; name?: boolean }) {
  const [i, setI] = useState(0)

  return (
    <div className={`brand${big ? ' brand-big' : ''}`}>
      {i < SOURCES.length && (
        <img src={SOURCES[i]} alt="MapDash" onError={() => setI(i + 1)} />
      )}
      {name && <b>MapDash</b>}
    </div>
  )
}
