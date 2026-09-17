// Lo único que toca los archivos de Excel: el reporte, la exportación masiva y
// la importación pasan por aquí.
//
// Las dos librerías se cargan con import() dinámico a propósito. Entre las dos
// son ~120 kB que solo hacen falta cuando el organizador exporta o importa, y
// el panel se abre en un celular, muchas veces con datos móviles.

import type { Cell, Row } from 'write-excel-file/browser'

export type { Cell, Row }

/** Fila de encabezado: en negrita, que es lo que la vuelve encabezado. */
export function head(labels: string[]): Row {
  return labels.map((value) => ({ value, type: String, fontWeight: 'bold' as const }))
}

export interface SheetSpec {
  name: string
  rows: Row[]
  /** Ancho de cada columna, en caracteres. */
  widths?: number[]
  /** Listas de valores permitidos, también para celdas todavía vacías. */
  dropdowns?: { range: string; values: string[] }[]
}

/** Arma el libro y lo descarga. La primera fila queda congelada. */
export async function writeXlsx(sheets: SheetSpec[], fileName: string): Promise<void> {
  const writeXlsxFile = (await import('write-excel-file/browser')).default
  const { dropdownFeature } = await import('./xlsxDropdowns')
  await writeXlsxFile(
    sheets.map((s) => ({
      sheet: s.name,
      data: s.rows,
      columns: s.widths?.map((width) => ({ width })),
      stickyRowsCount: 1,
    })),
    { fontFamily: 'Calibri', fontSize: 11, features: [dropdownFeature(sheets)] },
  ).toFile(fileName)
}

/** Valor de una celda leída. Las fechas no se usan al importar. */
export type CellValue = string | number | boolean | null

/**
 * Celdas crudas de la primera hoja, encabezado incluido. Se lee esa y no la que
 * el archivo tenga activa: la plantilla trae una segunda hoja de ayuda y sería
 * la que se importaría si el usuario la dejó abierta al guardar.
 */
export async function readXlsx(file: File): Promise<CellValue[][]> {
  const { readSheet } = await import('read-excel-file/browser')
  return asCells(await readSheet(file, 1))
}

/**
 * Lo leído, en el tipo que usan los importadores. El lector tipa las celdas de
 * fecha como `typeof Date` —el constructor, no una fecha—, que no es lo que
 * entrega en tiempo de ejecución. El cast vive aquí y no en cada llamada.
 */
export const asCells = (rows: unknown[][]): CellValue[][] => rows as CellValue[][]

/** Nombre de archivo con fecha: se van a acumular varios en Descargas. */
export function stampName(prefix: string, now: number): string {
  const d = new Date(now)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${prefix}-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}.xlsx`
}
