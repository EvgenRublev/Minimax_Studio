'use client'

/**
 * LearnRecipes — подвкладка «Сценарии» в «Обучении» (правка 485).
 *
 * Готовые сценарии работы со студией простым языком для новичков:
 * как комбинировать генерацию, рефайн и тайловый апскейл в зависимости
 * от железа и задачи. Без интерактива — просто карточки-инструкции.
 */
import {
  ZapIcon,
  LayersIcon,
  SearchIcon,
  CheckCircle2Icon,
} from 'lucide-react'
import type { ReactNode } from 'react'

interface Recipe {
  icon: ReactNode
  title: string
  subtitle: string
  when: string
  steps: string[]
  note?: string
}

const RECIPES: Recipe[] = [
  {
    icon: <ZapIcon className="w-4.5 h-4.5 text-white" />,
    title: 'Сценарий 1. «Всё и сразу»',
    subtitle: 'Один запуск — готовое видео в большом разрешении',
    when: 'Если видеокарта мощная (много видеопамяти) и вы уверены в промпте. Самый быстрый путь, но если промпт неудачный — время потрачено зря.',
    steps: [
      'Откройте вкладку «Генерация».',
      'Напишите промпт (или попросите ассистента справа).',
      'Выберите большое разрешение (например, 1080p) и нужную длину.',
      'Запустите и дождитесь результата — он появится в «Галерее».',
    ],
    note: 'Не угадали с результатом? Ничего страшного — попробуйте сценарий 3: сначала драфты, потом улучшение лучшего. Хотите подкрутить баланс «качество ↔ время»? В «Дополнительные параметры» → Pass 1 есть «Шаги сэмплера» и «Всего шагов (pass 1)», а под ними — живая сводка, сколько шагов уходит на черновик.',
  },
  {
    icon: <LayersIcon className="w-4.5 h-4.5 text-white" />,
    title: 'Сценарий 2. «По ступенькам вверх»',
    subtitle: 'Маленькое разрешение → Refine частями → Tile Upscale',
    when: 'Если железо среднее, а разрешение хочется большое. Каждый шаг добавляет чёткости понемногу, не перегружая видеокарту.',
    steps: [
      'Сгенерируйте длинное видео в небольшом разрешении (например, 480p или 720p) — так быстрее и легче для видеокарты.',
      'В «Галерее» нажмите на видео кнопку «Refine», выберите режим «Частями» и разрешение побольше (например, 1080p). Видео обработается кусками и склеится само.',
      'Нужно ещё больше? Нажмите «Tile Upscale» на результате рефайна — он аккуратно поднимет картинку до 1440p или 4K.',
    ],
    note: 'Refine улучшает детали и «рисует» недостающую чёткость. Tile Upscale бережно увеличивает готовое видео кусочками-тайлами.',
  },
  {
    icon: <SearchIcon className="w-4.5 h-4.5 text-white" />,
    title: 'Сценарий 3. «Сначала драфты»',
    subtitle: 'Много быстрых черновиков → выбрать лучший → улучшить',
    when: 'Если вы ищете идею и не хотите тратить часы на неудачные варианты. Драфт — это быстрый черновик пониженного качества.',
    steps: [
      'На вкладке «Генерация» включите пайплайн «Драфт» (быстрый режим).',
      'Сделайте несколько генераций с разными промптами или сидами — каждая займёт заметно меньше времени, чем полная.',
      'В «Галерее» посмотрите варианты и выберите лучший.',
      'Лучший драфт отправьте в «Refine» — он станет полноценным качественным видео.',
      'При желании добавьте «Tile Upscale» для ещё большего разрешения.',
    ],
    note: 'Это самый экономный сценарий по времени: быстрые пробы вместо долгих генераций «вслепую».',
  },
]

export function LearnRecipes() {
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground leading-relaxed">
        Три проверенных способа работы со студией. Выберите под своё железо и задачу —
        а можно и миксовать: любой ролик из «Галереи» в любой момент можно отправить
        в Refine, Tile Upscale, FPS или Продление в любом порядке.
      </p>

      {RECIPES.map((r) => (
        <div
          key={r.title}
          className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4 space-y-3"
        >
          <div className="flex items-center gap-3">
            <span className="w-8 h-8 rounded-lg gradient-creative flex items-center justify-center shrink-0 shadow-md shadow-emerald-500/20">
              {r.icon}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground leading-snug">{r.title}</p>
              <p className="text-xs text-cyan-300/90 leading-snug">{r.subtitle}</p>
            </div>
          </div>

          <p className="text-xs text-muted-foreground leading-relaxed">
            <span className="font-medium text-foreground/90">Когда использовать: </span>
            {r.when}
          </p>

          <ol className="space-y-1.5">
            {r.steps.map((s, i) => (
              <li key={i} className="flex gap-2.5 text-xs text-foreground/85 leading-relaxed">
                <span className="w-4.5 h-4.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 text-[10px] font-bold flex items-center justify-center shrink-0 mt-px">
                  {i + 1}
                </span>
                <span>{s}</span>
              </li>
            ))}
          </ol>

          {r.note && (
            <p className="text-[11px] text-muted-foreground/80 leading-relaxed border-t border-border/50 pt-2.5">
              {r.note}
            </p>
          )}
        </div>
      ))}

      <div className="flex gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3">
        <CheckCircle2Icon className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
        <p className="text-xs text-emerald-200/80 leading-relaxed">
          <span className="font-medium text-emerald-300">Главное правило: </span>
          ничего сломать нельзя. Каждый результат сохраняется в «Галерею», исходники
          не затираются — экспериментируйте спокойно и комбинируйте шаги как удобно.
        </p>
      </div>
    </div>
  )
}
