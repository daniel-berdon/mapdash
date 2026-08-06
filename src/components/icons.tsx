import {
  BedDouble,
  CircleParking,
  Coffee,
  Flag,
  Fuel,
  Landmark,
  MapPin,
  PartyPopper,
  Bus,
  Target,
  Utensils,
  type LucideIcon,
} from 'lucide-react'

// Los mismos iconos, pero como SVG en crudo. Los marcadores de MapLibre son
// HTMLElement, no componentes de React: usar renderToStaticMarkup metía
// react-dom/server entero en el bundle (~60 kB gzip) solo para pintar once
// iconos estáticos, y esto lo descarga el chofer con datos móviles.
import bedDouble from 'lucide-static/icons/bed-double.svg?raw'
import bus from 'lucide-static/icons/bus.svg?raw'
import circleParking from 'lucide-static/icons/circle-parking.svg?raw'
import coffee from 'lucide-static/icons/coffee.svg?raw'
import flag from 'lucide-static/icons/flag.svg?raw'
import fuel from 'lucide-static/icons/fuel.svg?raw'
import landmark from 'lucide-static/icons/landmark.svg?raw'
import mapPin from 'lucide-static/icons/map-pin.svg?raw'
import partyPopper from 'lucide-static/icons/party-popper.svg?raw'
import target from 'lucide-static/icons/target.svg?raw'
import utensils from 'lucide-static/icons/utensils.svg?raw'

/**
 * Iconos que el admin puede asignar a una parada.
 * Las claves son las que ya viven en la columna `points.icon`, así que no se
 * renombran: cambiarlas dejaría sin icono a las paradas ya creadas.
 */
export const STOP_ICONS: Record<string, { label: string; Icon: LucideIcon; svg: string }> = {
  pin: { label: 'Genérica', Icon: MapPin, svg: mapPin },
  meta: { label: 'Salida / Meta', Icon: Flag, svg: flag },
  comida: { label: 'Comida', Icon: Utensils, svg: utensils },
  cafe: { label: 'Café', Icon: Coffee, svg: coffee },
  museo: { label: 'Museo', Icon: Landmark, svg: landmark },
  reto: { label: 'Reto', Icon: Target, svg: target },
  gasolina: { label: 'Gasolina', Icon: Fuel, svg: fuel },
  hotel: { label: 'Hotel', Icon: BedDouble, svg: bedDouble },
  fiesta: { label: 'Evento', Icon: PartyPopper, svg: partyPopper },
  parking: { label: 'Estacionamiento', Icon: CircleParking, svg: circleParking },
}

export const VanIcon = Bus
export const VAN_SVG = bus

export function stopIcon(key: string): LucideIcon {
  return STOP_ICONS[key]?.Icon ?? MapPin
}

/** SVG de la parada, para el HTML de los marcadores. El tamaño lo pone el CSS. */
export function stopIconSvg(key: string): string {
  return STOP_ICONS[key]?.svg ?? mapPin
}
