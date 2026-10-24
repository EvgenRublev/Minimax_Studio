/**
 * refine-sigmas — расписание Refine (лестница сигм).
 *
 * (правка 723) Вынесено из refine-template.ts в модуль без импортов: вкладке
 * Refine нужно показывать фактические сигмы и ставить пресет «как Pass 2», а
 * тянуть в клиентский бандл весь шаблон воркфлоу (95 КБ) ради одной строки
 * незачем.
 */

/** Стартовая сигма Pass 2 двухпроходной генерации (ManualSigmas). */
export const REFINE_PASS2_SIGMA = 0.9035

/** Шагов в Pass 2 двухпроходной генерации. */
export const REFINE_PASS2_STEPS = 3

/** Лестница сигм Refine = лестница Pass 2 в генерации (SIGMA_VARIANTS). */
const SIGMA_LADDERS: Record<number, string> = {
  3: '0.9035, 0.6316, 0.3158, 0.0000',
  4: '0.9035, 0.8000, 0.6316, 0.3158, 0.0000',
  5: '0.9231, 0.8780, 0.8000, 0.6316, 0.3158, 0.0000',
  6: '0.9412, 0.9100, 0.8780, 0.8000, 0.6316, 0.3158, 0.0000',
  7: '0.9500, 0.9280, 0.9100, 0.8780, 0.8000, 0.6316, 0.3158, 0.0000',
}

/**
 * Лестница с поправкой на стартовую сигму: базовое расписание Pass 2
 * масштабируется коэффициентом sigmaStart / 0.9035.
 *
 * Так «сила» остаётся одним числом и не ломает привычные шаги: при 0.9 лестница
 * почти равна Pass 2, при 0.6 — заметно мягче. Ставить сюда больше 0.9035 нет
 * смысла (это уже Pass 2), а ниже ~0.6 начинается область, где «сила» меняет не
 * глубину перерисовки, а просто ослабляет все шаги.
 */
export function refineSigmaLadder(steps: number, sigmaStart?: number): string {
  const base = SIGMA_LADDERS[Math.round(steps)] ?? SIGMA_LADDERS[3]
  if (!sigmaStart || !(sigmaStart > 0)) return base
  const first = parseFloat(base.split(',')[0])
  const k = Math.min(0.95, Math.max(0.1, sigmaStart)) / first
  return base
    .split(',')
    .map((s, i, arr) => (i === arr.length - 1 ? '0.0000' : (parseFloat(s) * k).toFixed(4)))
    .join(', ')
}
