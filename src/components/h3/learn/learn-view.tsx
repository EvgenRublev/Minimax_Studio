'use client'

/**
 * LearnView — Обучение.
 *
 * Contains three sub-tabs:
 *   • «Основы»    — step-by-step interactive tutorial (mockups + callouts).
 *   • «Промпты»   — PromptGuide: detailed MiniMax H3 prompt-writing guide,
 *                   built-in LLM assistant, structured format, history,
 *                   and hover previews.
 *   • «Сценарии»  — LearnRecipes (правка 485): готовые сценарии работы
 *                   (прямая генерация / ступеньки / драфты) простым языком.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  GraduationCapIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  RotateCcwIcon,
  LightbulbIcon,
  WandSparklesIcon,
  RouteIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { LEARN_STEPS } from './learn-steps'
import { PromptGuide } from './prompt-guide'
import { LearnRecipes } from './learn-recipes' // (правка 485)

type SubTab = 'basics' | 'prompts' | 'recipes'

const SUB_TABS: Array<{ id: SubTab; label: string; icon: ReactNode }> = [
  { id: 'basics', label: 'Основы', icon: <GraduationCapIcon className="w-3.5 h-3.5" /> },
  { id: 'prompts', label: 'Промпты', icon: <WandSparklesIcon className="w-3.5 h-3.5" /> },
  // (правка 485) Готовые сценарии работы
  { id: 'recipes', label: 'Сценарии', icon: <RouteIcon className="w-3.5 h-3.5" /> },
]

export function LearnView() {
  const [subTab, setSubTab] = useState<SubTab>('basics')

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[var(--surface-1)]">
      {/* Header */}
      <div className="px-6 pt-5 pb-3 shrink-0 aurora-bg">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-foreground flex items-center gap-2.5">
              <span className="w-9 h-9 rounded-xl gradient-creative flex items-center justify-center shrink-0 shadow-lg shadow-emerald-500/20">
                <GraduationCapIcon className="w-4.5 h-4.5 text-white" />
              </span>
              Обучение
            </h1>
            <p className="text-xs text-muted-foreground mt-1.5">
              Как пользоваться студией и писать промпты для MiniMax H3
            </p>
          </div>
        </div>

        {/* Sub-tabs */}
        <div className="mt-3.5 flex items-center gap-1.5">
          {SUB_TABS.map((t) => {
            const active = subTab === t.id
            return (
              <button
                key={t.id}
                onClick={() => setSubTab(t.id)}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-150',
                  active
                    ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 shadow-sm shadow-cyan-500/20'
                    : 'text-muted-foreground border border-transparent hover:text-foreground hover:bg-[var(--surface-2)]/60',
                )}
              >
                {t.icon}
                {t.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Content — switches between the three sub-tabs */}
      <div className="flex-1 min-h-0 flex flex-col">
        <AnimatePresence mode="wait">
          {subTab === 'basics' ? (
            <motion.div
              key="basics"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="flex-1 min-h-0 flex flex-col"
            >
              <TutorialContent />
            </motion.div>
          ) : subTab === 'prompts' ? (
            <motion.div
              key="prompts"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="select-text flex-1 min-h-0 overflow-y-auto px-6 pt-2 pb-6"
            >
              <PromptGuide />
            </motion.div>
          ) : (
            <motion.div
              key="recipes"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="select-text flex-1 min-h-0 overflow-y-auto px-6 pt-2 pb-6"
            >
              {/* (правка 485) Готовые сценарии работы */}
              <LearnRecipes />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

/**
 * TutorialContent — the original step-by-step beginner walkthrough.
 * Owns its step state, keyboard navigation, progress bar and footer nav.
 */
function TutorialContent() {
  const [step, setStep] = useState(0)
  const total = LEARN_STEPS.length
  const current = LEARN_STEPS[step]

  const next = useCallback(() => setStep((s) => Math.min(s + 1, total - 1)), [total])
  const prev = useCallback(() => setStep((s) => Math.max(s - 1, 0)), [])
  const restart = useCallback(() => setStep(0), [])

  // Keyboard navigation: ← →
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') next()
      else if (e.key === 'ArrowLeft') prev()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [next, prev])

  return (
    <>
      {/* Step meta + progress bar */}
      <div className="px-6 pt-1 pb-3 shrink-0">
        <div className="flex items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground font-mono">
            Шаг {step + 1} / {total}
          </p>
          <p className="text-[10px] text-muted-foreground/60">← → — листать</p>
        </div>
        {/* Progress bar */}
        <div className="mt-2 h-1.5 rounded-full bg-[var(--surface-2)] overflow-hidden">
          <motion.div
            className="h-full bg-gradient-to-r from-emerald-500 to-cyan-500 rounded-full"
            animate={{ width: `${((step + 1) / total) * 100}%` }}
            transition={{ duration: 0.3 }}
          />
        </div>
      </div>

      {/* Content */}
      <div className="select-text flex-1 overflow-y-auto px-6 pb-6 min-h-0">
        <AnimatePresence mode="wait">
          <motion.div
            key={current.id}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ duration: 0.2 }}
            className="pt-2 flex flex-col gap-4 min-h-full"
          >
            <h2 className="text-base font-semibold text-foreground shrink-0">{current.title}</h2>

            {/* Stage + callouts — stretch to fill available height */}
            <div className="grid lg:grid-cols-[1.5fr_1fr] gap-4 items-stretch flex-1 min-h-[280px]">
              {/* Mockup stage (scaled up to use the space) */}
              <div className="rounded-xl border border-border bg-[var(--surface-0)]/60 p-6 flex items-center justify-center overflow-auto">
                <div className="w-full flex items-center justify-center [zoom:1.15] lg:[zoom:1.3]">
                  {current.mock}
                </div>
              </div>

              {/* Callouts */}
              <div className="space-y-2.5 content-start">
                {current.callouts.map((c) => (
                  <div
                    key={c.n}
                    className="flex gap-3 rounded-xl border border-border bg-[var(--surface-2)]/50 p-3"
                  >
                    <span className="w-5 h-5 rounded-full bg-cyan-500 text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5 shadow-md shadow-cyan-500/40">
                      {c.n}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground leading-snug">{c.title}</p>
                      <p className="text-xs text-muted-foreground leading-relaxed mt-1">{c.text}</p>
                    </div>
                  </div>
                ))}

                {current.tip && (
                  <div className="flex gap-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3">
                    <LightbulbIcon className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-200/80 leading-relaxed">
                      <span className="font-medium text-amber-300">Совет: </span>
                      {current.tip}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Bottom info strip — fills the remaining space with useful bits */}
            <div className="grid sm:grid-cols-3 gap-3 shrink-0">
              {/* What's next */}
              <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-3">
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                  {step < total - 1 ? 'Дальше' : 'Финиш'}
                </p>
                {step < total - 1 ? (
                  <p className="text-xs text-foreground/90 leading-relaxed">
                    <span className="font-medium text-cyan-400">Шаг {step + 2}. </span>
                    {LEARN_STEPS[step + 1].title.replace(/^Шаг \d+ — /, '')} — {LEARN_STEPS[step + 1].short}
                  </p>
                ) : (
                  <p className="text-xs text-foreground/90 leading-relaxed">
                    Тур пройден! Переключайтесь на вкладку{' '}
                    <span className="font-medium text-cyan-400">«Генерация»</span> и сделайте
                    первое видео по чек-листу.
                  </p>
                )}
              </div>

              {/* Hotkeys */}
              <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-3">
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                  Горячие клавиши
                </p>
                <div className="space-y-1 text-xs text-foreground/80">
                  <p><kbd className="px-1.5 py-0.5 rounded border border-border bg-[var(--surface-2)] font-mono text-[10px]">Ctrl+Enter</kbd> — запуск генерации</p>
                  <p><kbd className="px-1.5 py-0.5 rounded border border-border bg-[var(--surface-2)] font-mono text-[10px]">Ctrl+V</kbd> — вставить изображение как референс (в чате ассистента — как вложение)</p>
                  <p><kbd className="px-1.5 py-0.5 rounded border border-border bg-[var(--surface-2)] font-mono text-[10px]">Space · M · Esc</kbd> — плеер</p>
                  <p><kbd className="px-1.5 py-0.5 rounded border border-border bg-[var(--surface-2)] font-mono text-[10px]">Esc · Enter</kbd> — в галерее: снять выделение / сравнить пару</p>
                  <p><kbd className="px-1.5 py-0.5 rounded border border-border bg-[var(--surface-2)] font-mono text-[10px]">← →</kbd> — листать шаги обучения</p>
                </div>
              </div>

              {/* Mini glossary */}
              <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-3">
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                  Словарик
                </p>
                <div className="space-y-1 text-xs text-foreground/80 leading-snug">
                  <p><span className="text-foreground font-medium">Референс</span> — картинка/видео/аудио-образец.</p>
                  <p><span className="text-foreground font-medium">Промпт</span> — текстовое описание сцены.</p>
                  <p><span className="text-foreground font-medium">Pass 1 / Pass 2</span> — черновой и финальный проходы генерации.</p>
                  <p><span className="text-foreground font-medium">Точка сплита</span> — сколько шагов забирает черновик из общего расписания.</p>
                </div>
              </div>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Footer navigation */}
      <div className="shrink-0 border-t border-border px-6 py-3 bg-[var(--surface-0)]/90 backdrop-blur-sm flex items-center justify-between gap-4">
        <Button variant="outline" size="sm" onClick={prev} disabled={step === 0} className="gap-1.5">
          <ChevronLeftIcon className="w-4 h-4" />
          Назад
        </Button>

        {/* Step dots */}
        <div className="flex items-center gap-1.5 flex-wrap justify-center">
          {LEARN_STEPS.map((s, i) => (
            <button
              key={s.id}
              onClick={() => setStep(i)}
              title={s.title}
              className={cn(
                'h-1.5 rounded-full transition-all',
                i === step ? 'w-6 bg-gradient-to-r from-emerald-500 to-cyan-500' : 'w-1.5 bg-[var(--surface-3)] hover:bg-muted-foreground/40',
              )}
            />
          ))}
        </div>

        {step < total - 1 ? (
          <Button
            size="sm"
            onClick={next}
            className="gap-1.5 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white border-0 font-semibold"
          >
            Далее
            <ChevronRightIcon className="w-4 h-4" />
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={restart} className="gap-1.5">
            <RotateCcwIcon className="w-4 h-4" />
            Пройти ещё раз
          </Button>
        )}
      </div>
    </>
  )
}
