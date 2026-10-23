'use client'

/**
 * (правка 112) WelcomeDialog — всплывающее окно при первом запуске.
 * (правка 113) Галочка «Больше не показывать»: флаг пишется ТОЛЬКО если
 * галочка стоит; без галочки окно показывается при каждом запуске.
 * Окно сделано крупнее и красивее: градиентная шапка (aurora-bg),
 * карточки шагов, акцент приложения (gradient-creative).
 *
 * Краткая инструкция, как начать работать с программой:
 *   1. Настройки → «Общие» → скачать модели (единоразово);
 *   2. «Генерация» → промпт → «Сгенерировать видео»;
 *   3. Результат попадает в «Галерею», апскейл — в «Upscale».
 * Более детальная информация — на вкладке «Обучение» (кнопка-ссылка).
 */
import { useState } from 'react'
import { motion } from 'framer-motion'
import { SparklesIcon, SettingsIcon, GraduationCapIcon, XIcon, ArrowRightIcon, AlertTriangleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface WelcomeDialogProps {
  /**
   * Закрыть окно. dontShowAgain=true — пометить как «не показывать»
   * (флаг делает родитель); false — закрыть, но при следующем запуске
   * показать снова (правка 113).
   */
  onClose: (dontShowAgain: boolean) => void
  /** Закрыть окно и открыть диалог настроек (скачать модели). */
  onOpenSettings: (dontShowAgain: boolean) => void
  /** Закрыть окно и перейти на вкладку «Обучение». */
  onGoLearn: (dontShowAgain: boolean) => void
}

interface StepDef {
  title: string
  text: string
}

function Step({ n, title, text }: { n: number } & StepDef) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-[var(--surface-2)] px-3.5 py-3">
      <span className="w-7 h-7 rounded-lg gradient-creative text-white text-sm font-bold flex items-center justify-center shrink-0 shadow-md shadow-cyan-500/20">
        {n}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">{text}</p>
      </div>
    </div>
  )
}

export function WelcomeDialog({ onClose, onOpenSettings, onGoLearn }: WelcomeDialogProps) {
  // (правка 113) «Больше не показывать» — по умолчанию снята:
  // без галочки окно будет появляться при каждом запуске.
  const [hideForever, setHideForever] = useState(false)

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={() => onClose(hideForever)}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="w-full max-w-lg max-h-[85vh] rounded-2xl border border-border bg-[var(--surface-3)] shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Градиентная планка-акцент (идентичность H3 Studio) */}
        <div className="h-1.5 gradient-creative shrink-0" />

        {/* Header (правка 113 — крупнее, aurora-bg как в шапках вкладок) */}
        <div className="aurora-bg overflow-hidden flex items-center gap-3.5 px-5 pt-4 pb-3.5 border-b border-border shrink-0">
          <span className="w-12 h-12 rounded-2xl gradient-creative flex items-center justify-center shrink-0 shadow-lg shadow-cyan-500/25">
            <SparklesIcon className="w-6 h-6 text-white" />
          </span>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-foreground leading-tight">
              Добро пожаловать в <span className="gradient-creative-text">MiniMax H3 Studio 7</span>
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              Генерация видео со звуком — прямо на вашей видеокарте
            </p>
          </div>
          <button
            type="button"
            onClick={() => onClose(hideForever)}
            className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-[var(--surface-2)] transition-colors shrink-0"
            title="Закрыть"
          >
            <XIcon className="w-4.5 h-4.5" />
          </button>
        </div>

        {/* Steps (краткая инструкция, правка 113 — карточки) */}
        <div className="px-5 py-4 space-y-2.5 overflow-y-auto">
          <p className="text-xs uppercase tracking-wider text-muted-foreground/70 font-medium">
            Чтобы начать — три шага
          </p>
          <Step
            n={1}
            title="Скачайте модели"
            text="Настройки (шестерёнка внизу сайдбара) → «Общие» → «Скачать все». Это единоразово — после этого интернет больше не нужен."
          />
          <Step
            n={2}
            title="Сгенерируйте первое видео"
            text="Вкладка «Генерация»: выберите режим (Текст / Кадры / Референсы), опишите сцену (или попросите Ассистента), выберите разрешение и длительность — «Сгенерировать видео»."
          />
          <Step
            n={3}
            title="Смотрите результат"
            text="Готовые видео сохраняются в «Галерею», сделать их чётче можно на вкладке «Upscale»."
          />

          {/* (правка 132) Предупреждение про файл подкачки — частая причина ошибок */}
          <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 px-3.5 py-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center shrink-0">
                <AlertTriangleIcon className="w-4 h-4 text-amber-400" />
              </span>
              <p className="text-sm font-semibold text-amber-300">Важно: увеличьте файл подкачки</p>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Для работы программы нужен большой файл подкачки (virtual memory). Если он небольшой — программа может выдавать ошибку «не хватает памяти».
            </p>
            <div className="rounded-lg bg-[var(--surface-2)] px-3 py-2 text-xs text-foreground/80 leading-relaxed space-y-1">
              <p className="font-medium text-foreground">Как увеличить:</p>
              <p>1. Win + R → <code className="font-mono bg-[var(--surface-3)] px-1 rounded">sysdm.cpl</code> → Enter</p>
              <p>2. Вкладка «Дополнительно» → «Быстродействие» → «Параметры» → «Виртуальная память» → «Изменить»</p>
              <p>3. Снять галочку «Автоматически определять»</p>
              <p>4. Выбрать диск, поле «Максимальный размер (МБ)» = 32768 (или больше)</p>
              <p>5. «Установить» → «ОК» → <b>перезагрузить ПК</b></p>
            </div>
          </div>

          {/* Ссылка на подробный тур (правка 113 — ярче) */}
          <div className="rounded-xl border border-cyan-400/25 bg-cyan-500/10 px-3.5 py-2.5 flex items-center gap-3">
            <span className="w-8 h-8 rounded-lg bg-cyan-500/15 flex items-center justify-center shrink-0">
              <GraduationCapIcon className="w-4 h-4 text-cyan-300" />
            </span>
            <p className="text-xs text-cyan-100/90 flex-1 min-w-0 leading-relaxed">
              Подробный пошаговый тур с картинками — на вкладке <span className="font-semibold text-cyan-100">«Обучение»</span>
            </p>
            <button
              type="button"
              onClick={() => onGoLearn(hideForever)}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-cyan-100 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/30 transition-colors"
            >
              Открыть
              <ArrowRightIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Footer (правка 113 — галочка «больше не показывать» + кнопки) */}
        <div className="border-t border-border bg-[var(--surface-2)]/40 px-5 py-3.5 space-y-3 shrink-0">
          <label className="flex items-center gap-2.5 cursor-pointer select-none group">
            <input
              type="checkbox"
              checked={hideForever}
              onChange={(e) => setHideForever(e.target.checked)}
              className="w-4 h-4 rounded accent-cyan-500 cursor-pointer shrink-0"
            />
            <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors">
              Больше не показывать это окно
            </span>
          </label>
          <div className="flex items-center gap-2.5">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => onOpenSettings(hideForever)}
            >
              <SettingsIcon className="w-3.5 h-3.5" />
              Открыть настройки
            </Button>
            <Button size="sm" className="flex-1" onClick={() => onClose(hideForever)}>
              Понятно
            </Button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
