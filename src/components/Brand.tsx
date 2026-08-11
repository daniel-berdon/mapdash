import { useState } from 'react'

// Tamaño real del archivo. Va en el <img> para que el navegador reserve el
// hueco antes de descargarlo y el texto de debajo no salte (CLS).
const W = 490
const H = 288

export default function Brand({ big, name = true }: { big?: boolean; name?: boolean }) {
  // El logo lo pone el cliente en public/. Si no está, queda solo el nombre:
  // mejor eso que un icono de imagen rota.
  const [ok, setOk] = useState(true)

  return (
    <div className={`brand${big ? ' brand-big' : ''}`}>
      {ok && (
        <img
          src="/logo.webp"
          alt="MapDash"
          width={W}
          height={H}
          // Es lo más grande que se ve en las pantallas de carga: que no espere
          // su turno detrás del resto de peticiones.
          fetchPriority="high"
          decoding="async"
          onError={() => setOk(false)}
        />
      )}
      {name && <b>MapDash</b>}
    </div>
  )
}
