import { LayoutDashboard, Users } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import Brand from '../components/Brand'

export default function Home() {
  const navigate = useNavigate()

  return (
    <main className="splash home">
      <Brand big />
      <p className="muted">Seguimiento de rutas en tiempo real.</p>
      <div className="home-actions">
        <button className="b-primary b-big" onClick={() => navigate('/admin')}>
          <LayoutDashboard size={18} /> Panel admin
        </button>
        <button className="b-info b-big" onClick={() => navigate('/seleccion')}>
          <Users size={18} /> Elegir ruta
        </button>
      </div>
    </main>
  )
}
