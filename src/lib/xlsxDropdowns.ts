import type { Feature } from 'write-excel-file/browser'
import {
  getOpeningTagMarkup,
  getOrderOfSiblings,
  insertElementMarkupAccordingToOrderOfSiblings,
  sanitizeTextContent,
} from 'write-excel-file/utility'
import type { SheetSpec } from './xlsx'

/** Validación nativa de Excel; no genera filas vacías para extender la lista. */
export function dropdownFeature(sheets: SheetSpec[]) {
  return {
    files: {
      transform: {
        'xl/worksheets/sheet{id}.xml': {
          transform(xml, _options, { sheetIndex }) {
            const lists = sheets[sheetIndex]?.dropdowns
            if (!lists?.length) return xml
            const rules = lists.map(({ range, values }) => {
              const formula = `"${values.join(',')}"`
              if (!values.length || formula.length > 255 || values.some((v) => /[,"]/.test(v))) {
                throw new Error('La lista del desplegable no es válida para Excel.')
              }
              return getOpeningTagMarkup('dataValidation', {
                type: 'list', sqref: range, allowBlank: 1, showDropDown: 0,
                showErrorMessage: 1, errorStyle: 'stop',
                errorTitle: 'Elige una opción de la lista',
                error: 'Consulta la hoja Iconos para ver qué representa cada opción.',
                showInputMessage: 1, promptTitle: 'Icono de la parada',
                prompt: 'Elige un icono. pin = genérico. Consulta la hoja Iconos para ver las descripciones.',
              }) + `<formula1>${sanitizeTextContent(formula)}</formula1></dataValidation>`
            }).join('')
            return insertElementMarkupAccordingToOrderOfSiblings(
              xml,
              `<dataValidations count="${lists.length}">${rules}</dataValidations>`,
              getOrderOfSiblings('xl/worksheets/sheet{id}.xml', 'worksheet')!,
              'worksheet',
            )
          },
        },
      },
    },
  } satisfies Feature<unknown>
}
