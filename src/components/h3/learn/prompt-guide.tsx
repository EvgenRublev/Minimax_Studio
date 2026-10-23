'use client'

/**
 * PromptGuide — sub-tab of the Learn section.
 * Based on the official MiniMax H3 prompt guide (v2).
 *
 * Sections:
 *   1. Technical specs & limits
 *   2. Mode selection (T2VA/I2VA/FL2VA/L2VA/Ref2VA)
 *   2b. Что пишет ассистент в студии (формат по вкладкам)
 *   3. Prompt formula (3 blocks)
 *   4. Final structure (alignment + 3 fields)
 *   5. Writing the 3 core fields
 *   6. Camera movement (types, amplitude, speed)
 *   7. Speaking characters & dialogue
 *   8. On-screen text
 *   9. Soundscape & music
 *   10. Full examples (4 modes)
 *   11. Common mistakes (table)
 *   12. Ref2VA deep dive (6 sections, labels, rules)
 *   13. Checklist
 *   14. Built-in LLM assistant (Bonsai 2 27B по умолчанию / Gemma 4 12B / Qwen3.5 9B)
 *   15. History / favorites / examples
 *   16. Hover previews
 */
import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  BookOpenIcon,
  CopyIcon,
  CheckIcon,
  SparklesIcon,
  BotIcon,
  HistoryIcon,
  MousePointerClickIcon,
  CameraIcon,
  AlertTriangleIcon,
  ListOrderedIcon,
  TagIcon,
  MonitorPlayIcon,
  MessageSquareQuoteIcon,
  TypeIcon,
  MusicIcon,
  ClipboardCheckIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

/* ──────────────────── copy helper ──────────────────── */

async function copyText(text: string, okMsg: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(okMsg)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    toast.success(okMsg)
  }
}

function CopyButton({ text, label = 'Скопировать' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 text-xs"
      onClick={async () => {
        await copyText(text, 'Скопировано в буфер обмена')
        setDone(true)
        setTimeout(() => setDone(false), 2000)
      }}
    >
      {done ? <CheckIcon className="w-3.5 h-3.5 text-emerald-400" /> : <CopyIcon className="w-3.5 h-3.5" />}
      {label}
    </Button>
  )
}

/* ──────────────────── building blocks ──────────────────── */

function Section({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-start gap-3">
        <span className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/25 flex items-center justify-center shrink-0 text-cyan-400">
          {icon}
        </span>
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {children}
    </section>
  )
}

/** Renders a prompt string with highlighted tags — the SAME palette the
 *  editor, chat and hover previews use:
 *    <Picture N> purple · <Video N> cyan · <Audio N> emerald
 *    <Subject N> rose · <Scene N>/<Location N> sky · <d>…</d> amber.
 */
function PromptSample({ text, note }: { text: string; note?: string }) {
  const parts = text.split(/(<(?:Picture|Video|Audio|Subject) \d+>|<Scene \d+>|<Location \d+>|<d>[\s\S]*?<\/d>)/g)
  return (
    <div className="rounded-xl border border-border bg-[var(--surface-0)]/70 overflow-hidden">
      <div className="p-3.5 text-sm text-foreground/90 leading-relaxed">
        {parts.map((p, i) => {
          if (/^<(?:Picture|Video|Audio|Subject) \d+>$/.test(p)) {
            const isVideo = p.startsWith('<Video')
            const isAudio = p.startsWith('<Audio')
            const isSubject = p.startsWith('<Subject')
            const cls = isVideo
              ? 'bg-cyan-500/15 text-cyan-300'
              : isAudio
                ? 'bg-emerald-500/15 text-emerald-300'
                : isSubject
                  ? 'bg-pink-500/15 text-pink-300'
                  : 'bg-purple-500/15 text-purple-300'
            return (
              <span key={i} className={cn('px-1.5 py-0.5 rounded font-mono text-xs font-medium', cls)}>
                {p}
              </span>
            )
          }
          if (/^<(?:Scene|Location) \d+>$/.test(p)) {
            return (
              <span key={i} className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 font-mono text-xs font-medium">
                {p}
              </span>
            )
          }
          if (/^<d>[\s\S]*<\/d>$/.test(p)) {
            return (
              <span key={i} className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 font-mono text-xs">
                {p}
              </span>
            )
          }
          return <span key={i}>{p}</span>
        })}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border bg-[var(--surface-2)]/40 px-3.5 py-2">
        <p className="text-xs text-muted-foreground min-w-0">{note}</p>
        <CopyButton text={text} label="" />
      </div>
    </div>
  )
}

/* ──────────────────── examples ──────────────────── */

/** Ready-made example prompts — ENGLISH texts (the model follows English
 *  noticeably better); titles/notes stay Russian. Shared with the Generate
 *  tab "Примеры" menu. */
export const EXAMPLES: Array<{ title: string; note: string; text: string }> = [
  {
    title: 'T2VA (только текст)',
    note: 'Чистое текстовое описание — модель создаёт всё с нуля.',
    text: 'integrated_multimodal_description: [Shot 1] Live-action, cinematic, a medium-wide shot frames a baker opening the shutters of a small street bakery before sunrise. The camera pushes in with small amplitude at slow speed as the middle-aged baker with a calm, slightly raspy voice (S1) places a fresh loaf on the wooden counter and says: <d>[English] First batch of the morning.</d> [Shot 2] At 00:05.000, the camera cuts to a close-up of steam rising from the sliced bread while the baker\'s final words carry over from the previous shot.\n\noverall_soundscape: Wooden shutters scrape open over a quiet street as trays clink softly inside the bakery. The doorbell rings once, followed by light footsteps and the crisp sound of bread being sliced.\n\nnon_diegetic_music: A soft acoustic-guitar pattern at a moderate tempo, joined by sparse upright-bass notes and a gentle fade at the end.',
  },
  {
    title: 'I2VA (начальный кадр)',
    note: 'Одно изображение — отправная точка, сцена развивается вперёд.',
    text: 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\nintegrated_multimodal_description: [Shot 1] Live-action, cinematic, the young woman shown in <Picture 1> remains beside the rain-covered train window, preserving her appearance, clothing, seat position, and the carriage layout. The camera trucks right with small amplitude at slow speed as she lifts her gaze from the book in her lap to the window, rain streaking the glass, her reflection visible in the dark pane. She says softly: <d>[English] We\'re almost there.</d>\n\noverall_soundscape: The train wheels produce a steady metallic rhythm beneath a low ventilation hum. Rain ticks against the window while paper rustles softly in her hands.\n\nnon_diegetic_music: Sustained cello notes at a slow tempo with widely spaced piano tones, gradually decreasing in volume.',
  },
  {
    title: 'FL2VA (первый + последний кадр)',
    note: 'Два изображения — начало и конец, описываем путь между ними.',
    text: 'How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the 8.00-second mark of the target video.\n\nintegrated_multimodal_description: [Shot 1] Live-action, cinematic, a rain-soaked cyclist begins in the position and framing established by Picture 1, holding a closed black umbrella beside a silver bicycle. The camera pulls out with small amplitude at slow speed as she releases the bicycle handle, raises the umbrella, and opens it with a sharp snap. Water droplets fly in a radial burst as the canopy expands. By the final frame, she stands upright, fully covered, the bicycle parked at her side, matching Picture 2.\n\noverall_soundscape: Rain falls steadily on the pavement, followed by the metallic click of the umbrella runner and the soft snap of the canopy opening. Water drips from the bicycle frame as distant traffic passes.\n\nnon_diegetic_music: N/A',
  },
  {
    title: 'Ref2VA (референсы + голос)',
    note: 'Мультимодальный ввод: персонаж, локация, голос.',
    text: 'subject_definitions:\n<Subject 1> is the coffee-shop environment in <Picture 1>, featuring an exposed brick wall, an orange tufted sofa with patterned pillows, a neon sign, and a wooden coffee table.\n<Subject 2> is the fluffy white Samoyed in <Picture 2>, with thick white fur, pointed ears, and a curved tail.\n<Subject 3> is the young blonde woman in <Video 1>, with long blonde hair and a light-pink button-down shirt.\n<Audio 1> is the voice-timbre reference for <Subject 3> (S1), containing a spoken English vocal layer.\n\nsummary:\n[reference generation + audio reference] The target video shows <Subject 3> eating a cookie in <Subject 1>. <Subject 2> lunges toward the cookie. The exchange uses <Audio 1> as the voice-timbre reference for <Subject 3>.\n\nretention_analysis:\n<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - the exposed brick wall, orange sofa, and wooden table are retained.\n<Subject 3> (appears in [Shot 1], [Shot 2]): fully_preserved - her long blonde hair and light-pink shirt are retained.\n<Audio 1>: reference - its vocal timbre guides the dialogue delivery of <Subject 3> without copying the original signal.\n\ndetailed_description:\n[Shot 1] A medium shot establishes <Subject 1>, the coffee shop. <Subject 3> (S1), the young woman with long blonde hair, sits on the sofa holding a cookie. <Subject 2> lunges toward her hand. <Subject 3> (S1) jerks her hand back and, using the clear youthful voice timbre referenced from <Audio 1>, exclaims with light annoyance: <d>[English] Hey! Watch your dog!</d>\n\noverall_soundscape:\nSoft indoor coffee-shop room tone continues throughout the scene.\n\nnon_diegetic_music:\nN/A',
  },
]

const DONT_LIST = [
  '«Сначала покажи улицу, потом режь на крупный план» — монтаж и склейки модель не делает: это один непрерывный дубль.',
  'Перечислять теги референсов в конце промпта отдельно — тег должен стоять там, где референс участвует в сцене.',
  'Длинные монологи в <d>…</d> — озвучка рассчитана на короткие реплики (до ~10 слов), длинные искажаются.',
  '«Сделай красиво как в фильме…» — называй конкретные вещи: свет, ракурс, движение камеры, звук.',
  'Противоречить референсам (другая одежда/причёнка/место) — модель ориентируется на картинку/видео.',
  'Без референсов просить «знакомого персонажа» — опиши внешность словами, модель не знает кого-либо без описания.',
  'Слишком много действий за 30 секунд — одно непрерывное движение, не сценарий из 5 сцен.',
  'Смешивать роли first/last-frame с ролями референсных медиа — API требует, чтобы семейства ролей не пересеклись.',
  'Давать аудио как единственный медиа-референс для Ref2VA — обязательно приложите изображение или видео.',
]

/** Camera/light vocabulary — ENGLISH phrases inserted verbatim into the
 *  prompt (the model follows English noticeably better). Shared with the
 *  fullscreen prompt editor panel. */
export const CAMERA_WORDS = [
  'slow push-in on the face', 'smooth pan left to right', 'static shot, close-up',
  'camera pulls back', 'camera follows the character', 'subtle handheld shake',
  'low-angle shot', 'backlight / silhouette', 'warm side lighting', 'neon lighting',
  'soft morning light', 'atmospheric haze', 'shallow depth of field, blurred background',
  'Zoom In with small amplitude at slow speed',
  'Pan Left with large amplitude at fast speed',
  'Truck Right with small amplitude at moderate speed',
  'Tilt Up with large amplitude at slow speed',
  'Arc Shot around the subject',
  'Tracking Shot following the character',
  'Shake Slightly for a handheld feel',
  'POV — point of view',
  'Roll Clockwise for a disorienting effect',
]

/* ──────────────────── component ──────────────────── */

export function PromptGuide() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="space-y-8 pb-4"
    >
      {/* ── 1. Technical specs ── */}
      <Section
        icon={<MonitorPlayIcon className="w-4 h-4" />}
        title="Технические характеристики"
        subtitle="Лимиты и требования MiniMax H3"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4 space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-3">
              <p className="text-xs font-semibold text-foreground mb-2">Выход</p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                <li>• Разрешение: <span className="text-foreground/80 font-mono">480p / 720p / 1080p</span></li>
                <li>• Длительность: <span className="text-foreground/80 font-mono">~2.5–30 сек</span> (выравнивание 17n+5 кадров)</li>
                <li>• Соотношение сторон: 16:9, 9:16, 1:1, 4:3, 3:4, 21:9 + свободное разрешение</li>
              </ul>
            </div>
            <div className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-3">
              <p className="text-xs font-semibold text-foreground mb-2">Вход (референсы)</p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                <li>• Изображения: до <span className="text-foreground/80 font-mono">9</span></li>
                <li>• Видео: до <span className="text-foreground/80 font-mono">3</span></li>
                <li>• Аудио: до <span className="text-foreground/80 font-mono">3</span></li>
                <li>• Смешанный ввод: максимум <span className="text-foreground/80 font-mono">15 файлов</span> суммарно</li>
                <li>• Сумма длительности видео+аудио: ≤ <span className="text-foreground/80 font-mono">15 сек</span></li>
              </ul>
            </div>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            💡 Все генерации выполняются <span className="text-foreground/80">локально на вашем компьютере</span> через ComfyUI — интернет не нужен.
          </p>
        </div>
      </Section>

      {/* ── 2. Mode selection ── */}
      <Section
        icon={<MonitorPlayIcon className="w-4 h-4" />}
        title="Выбор режима генерации"
        subtitle="Определите, какие входные данные у вас есть — не выбирайте режим «на звук»"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-[var(--surface-1)]/60">
                <th className="text-left px-3 py-2 font-semibold text-foreground">Режим</th>
                <th className="text-left px-3 py-2 font-semibold text-foreground">Вход</th>
                <th className="text-left px-3 py-2 font-semibold text-foreground">Задача промпта</th>
                <th className="text-left px-3 py-2 font-semibold text-foreground">Подходит для</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['T2VA', 'Только текст', 'Построить полный аудиовизуальный таймлайн с нуля', 'Новая идея из текста'],
                ['I2VA', 'Одно начальное изображение', 'Тело промпта + инструкция по первому кадру + развитие вперёд', 'Анимация готовой композиции'],
                ['FL2VA', 'Первое и последнее изображение', 'Выровнять оба изображения и описать путь между ними', 'Контроль начала и конца перехода'],
                ['L2VA', 'Одно конечное изображение', 'Построить правдоподобную предыдущую последовательность, завершающуюся на заданном кадре', 'Ревел или трансформация «с конца»'],
                ['Ref2VA', 'Референсы (изображения/видео/аудио)', 'Назначить каждому активу роль через формат полного референса', 'Управление идентичностью, стилем, движением, камерой или звуком по нескольким источникам'],
              ].map(([mode, input, task, use]) => (
                <tr key={mode} className="border-b border-border/50 last:border-0">
                  <td className="px-3 py-2 font-mono text-foreground">{mode}</td>
                  <td className="px-3 py-2 text-muted-foreground">{input}</td>
                  <td className="px-3 py-2 text-muted-foreground">{task}</td>
                  <td className="px-3 py-2 text-muted-foreground">{use}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── 2b. Студия: какой формат пишет ассистент ── */}
      <Section
        icon={<ListOrderedIcon className="w-4 h-4" />}
        title="Что именно пишет ассистент в студии"
        subtitle="Формат выбирается автоматически по текущему режиму вкладки"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4 space-y-3">
          <div className="rounded-lg border border-border bg-[var(--surface-1)]/60 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-[var(--surface-2)]/60">
                  <th className="text-left px-3 py-2 font-semibold text-foreground">Вкладка студии</th>
                  <th className="text-left px-3 py-2 font-semibold text-foreground">Режим H3</th>
                  <th className="text-left px-3 py-2 font-semibold text-foreground">Формат промпта</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['«Текст»', 'T2VA', '3 поля: integrated_multimodal_description · overall_soundscape · non_diegetic_music'],
                  ['«Кадры»', 'FL2VA / I2VA', 'те же 3 поля'],
                  ['«Референсы»', 'Ref2VA', '6 полей: subject_definitions · summary · retention_analysis · detailed_description · overall_soundscape · non_diegetic_music'],
                  ['«Продление»', 'extend', 'те же 3 поля, но описывается только НОВОЕ действие'],
                  ['«ControlNet»', 'Ref2VA', '6 полей + отдельные правила для контрольного видео'],
                ].map(([tab, mode, fmt]) => (
                  <tr key={tab} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-2 font-medium text-foreground">{tab}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{mode}</td>
                    <td className="px-3 py-2 text-muted-foreground">{fmt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-1 text-xs text-muted-foreground leading-relaxed">
            <li>• Вручную ничего выбирать не надо: ассистент смотрит на режим вкладки и сам берёт нужную структуру.</li>
            <li>• Метки <span className="font-mono text-[10px]">&lt;Picture N&gt;</span> / <span className="font-mono text-[10px]">&lt;Video N&gt;</span> / <span className="font-mono text-[10px]">&lt;Subject N&gt;</span> в «Тексте» и «Кадрах» <span className="text-foreground/80">запрещены</span> — в «Тексте» допустима только <span className="font-mono text-[10px]">&lt;Audio N&gt;</span>, и то если аудио-реф реально приложен.</li>
            <li>• Режима «только последний кадр» (L2VA) в студии нет — доступны «Текст», «Кадры» и «Референсы», плюс отдельные вкладки «Продление» и «ControlNet».</li>
            <li>• Готовый промпт приходит в markdown-блоке кода — так его можно сразу скопировать в поле.</li>
          </ul>
        </div>
      </Section>

      {/* ── 3. Formula ── */}
      <Section
        icon={<SparklesIcon className="w-4 h-4" />}
        title="Формула промпта"
        subtitle="Три блока в строгом порядке (официальный мануал MiniMax)"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4">
          <div className="flex flex-wrap items-center gap-2">
            {[
              ['Заметки по референсам', 'что делает каждый файл (только для I2VA/FL2VA/L2VA/Ref2VA)'],
              ['Основная идея', 'субъект, место, событие, стиль'],
              ['Описания сцены по кадрам', 'движение во времени, с таймкодами'],
            ].map(([k, v], i) => (
              <div key={k} className="flex items-center gap-2">
                <div className="rounded-lg border border-cyan-500/25 bg-cyan-500/10 px-2.5 py-1.5">
                  <p className="text-xs font-semibold text-cyan-300">{k}</p>
                  <p className="text-[10px] text-muted-foreground">{v}</p>
                </div>
                {i < 2 && <span className="text-muted-foreground/50 text-xs">→</span>}
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
            Первый блок пропускается, если файлов не загружено (T2VA).
          </p>
        </div>
      </Section>

      {/* ── 4. Final structure ── */}
      <Section
        icon={<ListOrderedIcon className="w-4 h-4" />}
        title="Структура финального промпта"
        subtitle="Две части: инструкция выравнивания + три основных поля"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4 space-y-3">
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Часть 1 — Инструкция (первая строка)</p>
            <ul className="space-y-1 text-xs text-muted-foreground leading-relaxed">
              <li>• <span className="text-foreground/80 font-mono">T2VA</span>: нет инструкции, начинается сразу с трёх полей.</li>
              <li>• <span className="text-foreground/80 font-mono">I2VA</span>: <span className="font-mono text-[10px]">For the target video, at 0.00 seconds into the target video, &lt;Picture 1&gt; (from [Shot 1]) is fully referenced.</span></li>
              <li>• <span className="text-foreground/80 font-mono">FL2VA</span>: <span className="font-mono text-[10px]">How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark...</span></li>
            </ul>
            <p className="text-[11px] text-muted-foreground/80 leading-relaxed mt-2 border-l-2 border-cyan-500/40 pl-2">
              В студии эту строку писать <span className="text-foreground/80">не нужно</span>: кадры и их привязка ко времени
              подставляются самой программой, а ассистент всегда начинает промпт с первого поля
              (<span className="font-mono text-[10px]">integrated_multimodal_description</span> или
              <span className="font-mono text-[10px]">subject_definitions</span>). Строка выше — справка по
              официальному API MiniMax, если вы пишете промпт для другой обвязки.
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Часть 2 — Три основных поля</p>
            <div className="space-y-1.5">
              {[
                ['integrated_multimodal_description', 'Основное тело промпта: визуал, действия, кадры, говорящие, диалоги, пение, синхронизированный звук вдоль таймлайна.'],
                ['overall_soundscape', 'Сводка об атмосферном звуке, физических звуках действий и невербальных человеческих звуках за всё видео.'],
                ['non_diegetic_music', 'Фоновая музыка, которую слышат только зрители (персонажи её не слышат).'],
              ].map(([field, desc]) => (
                <div key={field} className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-2.5">
                  <p className="font-mono text-xs text-foreground/90">{field}</p>
                  <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      {/* ── 5. Writing the 3 fields ── */}
      <Section
        icon={<BookOpenIcon className="w-4 h-4" />}
        title="Как писать три основных поля"
        subtitle="Детали по каждому полю"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4 space-y-3">
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">5.1 integrated_multimodal_description</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Развивайте описание вдоль таймлайна. Каждый элемент должен соответствовать чему-то видимому или слышимому: стиль, начальная композиция, облик и положение субъекта, сцена и ключевые реквизиты, действия и реакции, смена кадров, язык речи, синхронизированный звуковой эффект.
            </p>
            <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
              В начале <span className="font-mono text-[10px]">[Shot 1]</span> укажите общий стиль и начальную композицию. Распространённые стили: <span className="text-foreground/80">Cinematic, live-action, 2D-animated, 3D CG, claymation, watercolor, vintage film</span>.
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">5.2 Кадровая структура и срезы</p>
            <ul className="space-y-1 text-xs text-muted-foreground leading-relaxed">
              <li>• <span className="text-foreground/80">Первому кадру не ставьте таймкод.</span></li>
              <li>• Для последующих кадров используйте нумерацию <span className="font-mono text-[10px]">[Shot 2]</span>, <span className="font-mono text-[10px]">[Shot 3]</span> и т. д., начиная каждый с <span className="text-foreground/80">строго возрастающего</span> времени среза в пределах длительности видео.</li>
              <li>• Для обычных срезов используйте: <span className="font-mono text-[10px]">the camera cuts to</span>, <span className="font-mono text-[10px]">the shot cuts to</span>, <span className="font-mono text-[10px]">the shot transitions to</span>, <span className="font-mono text-[10px]">the shot changes to</span>, <span className="font-mono text-[10px]">the shot switches to</span>.</li>
              <li>• Перекрёстное растворение (cross-dissolve), fade и wipe допускаются только при явном запросе пользователя.</li>
              <li>• Срез должен вносить новую информацию о субъекте, пространстве, состоянии, точке зрения или времени.</li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">5.3 Ключевые кадры (I2VA / FL2VA / L2VA)</p>
            <ul className="space-y-1 text-xs text-muted-foreground leading-relaxed">
              <li>• <span className="text-foreground/80 font-mono">I2VA</span>: опишите первое изображение как отправную точку <span className="font-mono text-[10px]">[Shot 1]</span>, затем расскажите, как сцена развивается вперёд. Паттерн: <em>открывающееся изображение → первое движение → продолжение действия → финальная реакция</em>.</li>
              <li>• <span className="text-foreground/80 font-mono">FL2VA</span>: не описывайте оба статичных изображения дважды — опишите <span className="text-foreground/80">движение</span>, которое их связывает. Паттерн: <em>начальное состояние → промежуточные физические изменения → приближение к конечной композиции → конечное состояние</em>.</li>
              <li>• <span className="text-foreground/80 font-mono">L2VA</span>: стройте правдоподобную предыдущую последовательность, сходящуюся к заданному конечному кадру. <span className="text-foreground/80">В студии такого режима нет</span> — последний кадр задаётся только вместе с первым («Кадры»).</li>
            </ul>
          </div>
        </div>
      </Section>

      {/* ── 6. Camera movement ── */}
      <Section
        icon={<CameraIcon className="w-4 h-4" />}
        title="Движение камеры"
        subtitle="Три измерения: тип, амплитуда, скорость"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4 space-y-3">
          <div className="grid sm:grid-cols-3 gap-2">
            {[
              ['Тип движения', 'как движется камера'],
              ['Амплитуда', 'small / large amplitude'],
              ['Скорость', 'slow / moderate / fast speed'],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-2.5">
                <p className="text-xs font-semibold text-foreground">{k}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{v}</p>
              </div>
            ))}
          </div>
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-[var(--surface-1)]/60">
                  <th className="text-left px-3 py-2 font-semibold text-foreground">Тип</th>
                  <th className="text-left px-3 py-2 font-semibold text-foreground">Выражение</th>
                  <th className="text-left px-3 py-2 font-semibold text-foreground">Описание</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['Zoom In / Out', 'Zoom In, Zoom Out', 'Меняется фокусное расстояние, камера неподвижна'],
                  ['Pan Left / Right', 'Pan Left, Pan Right', 'Камера на месте, объектив поворачивается горизонтально'],
                  ['Truck Left / Right', 'Truck Left, Truck Right', 'Камера перемещается горизонтально'],
                  ['Tilt Up / Down', 'Tilt Up, Tilt Down', 'Камера на месте, объектив поворачивается вертикально'],
                  ['Pedestal Up / Down', 'Pedestal Up, Pedestal Down', 'Вся камера поднимается/опускается'],
                  ['Arc Shot', 'Arc Shot', 'Камера движется дугой вокруг субъекта'],
                  ['Tracking Shot', 'Tracking Shot', 'Камера следует за движущимся субъектом'],
                  ['Static Shot', 'Static Shot', 'Позиция камеры и объектив неподвижны'],
                  ['Shake', 'Shake Slightly / Shake Strongly', 'Слабое/сильное дрожание камеры'],
                  ['POV', 'POV', 'Точка зрения субъекта'],
                  ['Roll', 'Roll Clockwise / Counterclockwise', 'Камера кренится вокруг оси объектива'],
                ].map(([type, expr, desc]) => (
                  <tr key={type} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-2 font-medium text-foreground">{type}</td>
                    <td className="px-3 py-2 font-mono text-[10px] text-foreground/80">{expr}</td>
                    <td className="px-3 py-2 text-muted-foreground">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            💡 Движение камеры описывается как естественное английское действие внутри кадра:
          </p>
          <div className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-3">
            <p className="text-xs font-mono text-foreground/90 leading-relaxed">
              The camera pushes in with small amplitude at slow speed toward the folded letter in her hands.<br/>
              The camera pans right with large amplitude at fast speed, revealing the open doorway.<br/>
              The camera holds a static shot as the runner exits the frame.
            </p>
          </div>
        </div>
      </Section>

      {/* ── 7. Speaking characters ── */}
      <Section
        icon={<MessageSquareQuoteIcon className="w-4 h-4" />}
        title="Говорящие персонажи, диалоги и пение"
        subtitle="ID, voiceover, разрыв диалога"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4 space-y-3">
          <ul className="space-y-1.5 text-xs text-muted-foreground leading-relaxed">
            <li>• Говорящие, поющие или издающие голос субъекты получают стабильные идентификаторы <span className="font-mono text-[10px]">(S1)</span>, <span className="font-mono text-[10px]">(S2)</span> и т. д. Когда несколько уже нумерованных говорящих говорят/поют вместе — используйте составной ID <span className="font-mono text-[10px]">(S1,S2)</span>.</li>
            <li>• Идентификатор сохраняется на протяжении кадров; персонажи, которые никогда не произносят слов, получают <span className="text-foreground/80">никакой</span> ID.</li>
            <li>• При первом появлении говорящего укажите достаточно информации для стабильной идентичности: тип персонажа, возраст, пол, находится ли он в кадре, высота тона, тембр, скорость речи или акцент.</li>
          </ul>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Формат строки диалога</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Идентифицирующая фраза, ID, действие и подача ставятся <span className="text-foreground/80">вне</span> <span className="font-mono text-[10px]">&lt;d&gt;</span>. Внутри <span className="font-mono text-[10px]">&lt;d&gt;</span> — только тег языка и фактический произносимый контент. Сохраняйте каждое слово и знак препинания дословно; не переводите и не переписывайте их.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-3">
            <p className="text-xs font-mono text-foreground/90 leading-relaxed">
              The young woman with a quiet, breathy voice (S1) says: &lt;d&gt;[English] I get off at the next station.&lt;/d&gt;<br/>
              The two children (S1,S2) shout together, &lt;d&gt;[English] Wait for us!&lt;/d&gt;
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Оффаscreen-озвучка (voiceover)</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Используйте точную фразу <span className="font-mono text-[10px]">says in an off-screen voiceover</span>. Сразу после каждого блока <span className="font-mono text-[10px]">&lt;d&gt;</span> укажите, что губы соответствующего персонажа на экране остаются закрытыми:
            </p>
          </div>
          <div className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-3">
            <p className="text-xs font-mono text-foreground/90 leading-relaxed">
              The man (S1) says in an off-screen voiceover: &lt;d&gt;[English] I still remember that road.&lt;/d&gt; while his lips remain completely closed.
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Разрыв диалога по кадру</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Если одна реплика или куплет пересекает срез, используйте <span className="font-mono text-[10px]">&lt;scenetrans&gt;</span> в соединяющих точках обеих частей и явно укажите, что звук продолжается через срез. Для обрыва речи к концу видео используйте <span className="font-mono text-[10px]">&lt;cutoff&gt;</span>.
            </p>
          </div>
        </div>
      </Section>

      {/* ── 8. On-screen text ── */}
      <Section
        icon={<TypeIcon className="w-4 h-4" />}
        title="Текст на экране"
        subtitle="Баннеры, вывески, подписи, субтитры"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            Любой баннер, вывеска, подпись, субтитр или неоновый текст, реально видимый на экране, пишите в <span className="text-foreground/80">английских двойных кавычках</span>, сохраняя оригинальный текст и знаки препинания дословно, без перевода:
          </p>
          <div className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-3 mt-2">
            <p className="text-xs font-mono text-foreground/90 leading-relaxed">
              A red neon sign reading "营业中" glows above the doorway.
            </p>
          </div>
        </div>
      </Section>

      {/* ── 9. Soundscape & music ── */}
      <Section
        icon={<MusicIcon className="w-4 h-4" />}
        title="Звуковой ландшафт и музыка"
        subtitle="overall_soundscape и non_diegetic_music"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4 space-y-3">
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">overall_soundscape</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Используйте <span className="text-foreground/80">1–4 предложения</span> в одном непрерывном абзаце для сводки атмосферного звука, физических звуков действий и невербальных человеческих звуков за всё видео (ветер, дождь, транспорт, шаги, движение ткани, удары, дыхание, смех, хрипота).
            </p>
            <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
              ⚠️ Диалоги, пение и диетическая музыка уже относятся к <span className="font-mono text-[10px]">integrated_multimodal_description</span> и <span className="text-foreground/80">не должны повторяться</span> здесь.
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">non_diegetic_music</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Используйте <span className="text-foreground/80">1–3 предложения</span> для описания фоновой музыки, которую персонажи не слышат, а только зритель. Акцентируйте инструментовку, темп, ритм и изменения динамики; <span className="text-foreground/80">не используйте абстрактные слова настроения</span> и не объясняйте эмоциональную функцию саундтрека.
            </p>
            <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
              ⚠️ Пение, инструменты, радио, телевизор или музыка с телефона, слышимые персонажами — это диетические события и должны находиться в <span className="font-mono text-[10px]">integrated_multimodal_description</span>.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-3">
            <p className="text-xs font-mono text-foreground/90 leading-relaxed">
              overall_soundscape: Steady rain taps against the café windows while low room ambience continues underneath. The entrance bell rings once, followed by wet footsteps and the soft scrape of a chair.<br/><br/>
              non_diegetic_music: Sparse piano notes at a slow tempo, joined by sustained low strings that gradually increase in volume before fading out.
            </p>
          </div>
        </div>
      </Section>

      {/* ── 10. Examples ── */}
      <Section
        icon={<BookOpenIcon className="w-4 h-4" />}
        title="Полные примеры промптов"
        subtitle="Четыре режима — можно копировать и адаптировать"
      >
        <div className="space-y-3">
          {EXAMPLES.map((ex) => (
            <div key={ex.title} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-foreground">{ex.title}</span>
                <span className="text-[10px] text-muted-foreground">— {ex.note}</span>
              </div>
              <PromptSample text={ex.text} note="Нажмите на иконку справа, чтобы скопировать" />
            </div>
          ))}
        </div>
      </Section>

      {/* ── 11. Common mistakes ── */}
      <Section
        icon={<AlertTriangleIcon className="w-4 h-4" />}
        title="Частые ошибки"
        subtitle="Что снижает качество генерации и как исправить"
      >
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-[var(--surface-1)]/60">
                <th className="text-left px-3 py-2 font-semibold text-foreground">Проблема</th>
                <th className="text-left px-3 py-2 font-semibold text-foreground">Причина</th>
                <th className="text-left px-3 py-2 font-semibold text-foreground">Исправление</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['Говорит не тот человек', 'ID изменены или говорящий никогда не был установлен', 'Назначьте стабильные (S1) и (S2) при первом появлении каждого голоса, затем повторно используйте их'],
                ['Реплика повторяется в звуковом ландшафте', 'Произнесённые слова скопированы в несколько полей', 'Храните полную реплику только внутри integrated_multimodal_description'],
                ['Неверное изображение открывается/закрывается видео', 'Изображение было добавлено как референс вместо точного первого кадра', 'Используйте Start Frame и начните промпт с официальной инструкции выравнивания первого кадра'],
                ['Детальная шпаргалка теряется или сливается', 'Промпт конкурирует с визуальным планом, либо длительность слишком короткая', 'Назначьте шпаргалке одну чёткую роль, сократите промпт и выберите длительность, подходящую для последовательности'],
                ['Модель игнорирует референс', 'Роль не явная', 'Назовите точный субъект, атрибут, диапазон кадров и intended relationship'],
                ['Два источника конфликтуют за один атрибут', 'Не выбран контрольный актив', 'Выберите актив, управляющий атрибутом, исключите версию другого'],
              ].map(([problem, cause, fix]) => (
                <tr key={problem} className="border-b border-border/50 last:border-0">
                  <td className="px-3 py-2 text-foreground">{problem}</td>
                  <td className="px-3 py-2 text-muted-foreground">{cause}</td>
                  <td className="px-3 py-2 text-muted-foreground">{fix}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── 12. Ref2VA deep dive ── */}
      <Section
        icon={<TagIcon className="w-4 h-4" />}
        title="Режим референсов (Ref2VA)"
        subtitle="Шестисекционная структура, метки, правила"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4 space-y-3">
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Шестисекционная структура</p>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {[
                ['subject_definitions', 'Кто/что есть: <Subject N>, привязка к <Picture N>, <Video N>, <Audio N>'],
                ['summary', 'Кратко: задача, целевое видео, связи между референсами'],
                ['retention_analysis', 'Что сохраняется (fully_preserved) / передаётся (reference) / меняется'],
                ['detailed_description', 'Основное тело: кадры [Shot 1], [Shot 2]… по порядку'],
                ['overall_soundscape', 'Атмосферные и физические звуки'],
                ['non_diegetic_music', 'Фоновая музыка для зрителя (или N/A)'],
              ].map(([k, v], i) => (
                <div key={k} className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-2.5">
                  <div className="flex items-center gap-1.5">
                    <span className="w-4 h-4 rounded-full bg-cyan-500/15 text-cyan-300 text-[10px] font-bold flex items-center justify-center">{i + 1}</span>
                    <span className="font-mono text-[10px] text-foreground/90">{k}</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">{v}</p>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Метки референсов</p>
            <div className="grid sm:grid-cols-2 gap-2">
              {[
                ['<Subject N>', 'Видимое содержимое, абстрагированное из референсных активов; можно переиспользовать или изменить в целевом видео'],
                ['<Picture N>', 'Референсное изображение, которое само служит первым/последним кадром, ключевым кадром или якорем композиции'],
                ['<Video N>', 'Референсное видео как источник монтажа, продолжения или всей временной структуры'],
                ['<Audio N>', 'Аудиосигнал, который копируется или референсируется'],
              ].map(([tag, desc]) => (
                <div key={tag} className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-2.5">
                  <p className="font-mono text-xs text-foreground/90">{tag}</p>
                  <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">{desc}</p>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Правила нумерации и независимые треки</p>
            <ul className="space-y-1 text-xs text-muted-foreground leading-relaxed">
              <li>• <span className="font-mono text-[10px]">&lt;Video N&gt;</span> и <span className="font-mono text-[10px]">&lt;Audio N&gt;</span> нумеруются <span className="text-foreground/80">независимо</span> — индексы не кодируют пару между ними.</li>
              <li>• Если изображение используется только для определения персонажа/стиля, не создавайте отдельную строку <span className="font-mono text-[10px]">&lt;Picture N&gt;</span> — укажите источник внутри соответствующего <span className="font-mono text-[10px]">&lt;Subject N&gt;</span>.</li>
              <li>• Если актив <span className="font-mono text-[10px]">&lt;Picture N&gt;</span>/<span className="font-mono text-[10px]">&lt;Video N&gt;</span> лишь идентифицирует другой референс и не анализируется отдельно, сослайтесь на него внутри определения этого актива.</li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Отношения сохранения (relationship markers)</p>
            <div className="grid sm:grid-cols-2 gap-2">
              <div className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-2.5">
                <p className="text-[10px] font-semibold text-foreground mb-1">Для видимого содержимого</p>
                <ul className="space-y-0.5 text-[10px] text-muted-foreground">
                  <li>• <span className="font-mono text-[10px]">fully_preserved</span> — геометрия, цвета, детали полностью сохранены</li>
                  <li>• <span className="font-mono text-[10px]">weak_reference</span> — сохраняется лишь общее сходство по категории/атмосфере</li>
                </ul>
              </div>
              <div className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-2.5">
                <p className="text-[10px] font-semibold text-foreground mb-1">Для аудио</p>
                <ul className="space-y-0.5 text-[10px] text-muted-foreground">
                  <li>• <span className="font-mono text-[10px]">fully_copy</span> — исходный звук переиспользуется 1:1 как финальный трек</li>
                  <li>• <span className="font-mono text-[10px]">reference</span> — не копируется дословно; передаётся тембр, ритм, стиль музыки, содержание диалога</li>
                  <li>• <span className="font-mono text-[10px]">weak_reference</span> — сохраняется лишь широкое сходство по категории/атмосфере</li>
                </ul>
              </div>
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Говорящие персонажи и ID</p>
            <ul className="space-y-1 text-xs text-muted-foreground leading-relaxed">
              <li>• Переиспользуйте глобальный ID говорящего <span className="font-mono text-[10px]">(Sx)</span> на каждом реальном вокальном событии.</li>
              <li>• <span className="font-mono text-[10px]">&lt;Audio N&gt;</span>, привязанный к целевому говорящему, тоже переиспользует тот же <span className="font-mono text-[10px]">(Sx)</span>, но <span className="text-foreground/80">никогда</span> не присваивает новый ID самостоятельно.</li>
              <li>• Не пишите <span className="font-mono text-[10px]">(Sx)</span> в <span className="font-mono text-[10px]">retention_analysis</span>.</li>
              <li>• Голоса, физически произведённые конкретным человеком/персонажем — используют <span className="font-mono text-[10px]">(Sx)</span>. Музыка или диалог из прямого переиспользования саундтрека — ссылаются на <span className="font-mono text-[10px]">&lt;Audio N&gt;</span>.</li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Важные предупреждения</p>
            <ul className="space-y-1 text-xs text-muted-foreground leading-relaxed">
              <li>• <span className="text-foreground/80">Не смешивайте</span> роли first/last-frame с ролями референсных медиа. API требует, чтобы семейства ролей не пересеклись в одном запросе.</li>
              <li>• Референсное аудио <span className="text-foreground/80">не может быть единственным</span> медиа-референсом для H3-Base-Ref2VA — обязательно приложите изображение или видео.</li>
              <li>• Если только тембр передаётся — не копируйте исходный диалог дословно в цельное видео.</li>
            </ul>
          </div>
        </div>
      </Section>

      {/* ── 13. Checklist ── */}
      <Section
        icon={<ClipboardCheckIcon className="w-4 h-4" />}
        title="Чеклист перед генерацией"
        subtitle="Проверьте все пункты перед отправкой"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4">
          <ul className="space-y-1.5">
            {[
              'Выбран правильный режим под имеющиеся входные данные: «Текст», «Кадры» или «Референсы».',
              'Промпт начинается с нужного поля: integrated_multimodal_description (обычный режим) или subject_definitions (референсы).',
              'Кадры идут по порядку: [Shot 1], [Shot 2]… — первый без таймкода.',
              'Описание одного и того же субъекта остаётся стабильным во всех кадрах.',
              'Каждый говорящий сохраняет один ID (Sx).',
              'Каждая реплика сохранена с точным языком и формулировкой внутри <d>.',
              'Видимый текст находится в английских двойных кавычках.',
              'Физические звуки описаны в overall_soundscape, музыка для зрителей — в non_diegetic_music, либо там указано N/A.',
              'Запрашиваемые действия помещаются в выбранную длительность клипа.',
              'Каждый прикреплённый референс упомянут в промпте своей меткой (<Picture N> / <Video N> / <Audio N>).',
              'В retention_analysis отмечено, что сохраняется (fully_preserved), а что меняется.',
              'Проверка приёмки называет самое важное: идентичность, текст на экране, переход, тайминг, звук или финальный кадр.',
            ].map((item, i) => (
              <li key={i} className="flex gap-2 text-xs text-muted-foreground leading-relaxed">
                <span className="text-cyan-400 shrink-0 mt-0.5">☐</span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {/* ── 14. LLM assistant ── */}
      <Section
        icon={<BotIcon className="w-4 h-4" />}
        title="LLM-ассистент в студии"
        subtitle="Встроенный локальный помощник (Bonsai 2 27B по умолчанию / Gemma 4 12B / Qwen3.5 9B) — видит референсы, а видео-кадры — по флажку в Настройки → LLM"
      >
        <div className="rounded-xl border border-violet-500/25 bg-violet-500/5 p-4 space-y-3">
          <div className="flex items-start gap-3">
            <span className="w-8 h-8 rounded-lg bg-violet-500/15 border border-violet-500/30 flex items-center justify-center shrink-0">
              <BotIcon className="w-4 h-4 text-violet-300" />
            </span>
            <div className="space-y-1">
              <p className="text-xs text-foreground leading-relaxed">
                <span className="text-violet-300 font-medium">«Ассистент»</span> — правая панель на вкладках «Генерация» и «Продление» (ширину можно тянуть за край, кнопка в шапке сворачивает в узкий рейл). Это локальная LLM (по умолчанию Bonsai 2 27B, тернарная, vision; альтернативы: Gemma 4 12B, Qwen3.5 9B), которая работает прямо на вашей видеокарте. Она уже знает полный гайд по MiniMax H3, <span className="text-violet-300 font-medium">видит прикреплённые картинки И видео-кадры</span>, поэтому может описать, что на них, и зафиксировать персонажей в промпте. Ассистент знает выбранный режим генерации и не добавит теги, которые не поддерживаются (правка 150).
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Отвечает по-русски, готовый промпт выдаёт на английском. Если референсов нет — не использует теги; если есть — привязывает только существующие <span className="font-mono text-[10px]">&lt;Picture N&gt;</span>, <span className="font-mono text-[10px]">&lt;Video N&gt;</span>, <span className="font-mono text-[10px]">&lt;Audio N&gt;</span>.
              </p>
            </div>
          </div>
          <div className="grid sm:grid-cols-3 gap-2.5">
            {[
              ['Открой панель «Ассистент»', 'Справа на вкладке «Генерация» или «Продление». Напиши идею словами (по-русски). Прикреплённые референсы уже видны модели.'],
              ['Или «Исправить промпт»', 'Кнопка ✦ справа от поля промпта (и в шапке полноэкранного редактора): спросит, что именно изменить, и отправит черновик с вашим заданием в LLM — панель чата развернётся сама.'],
              ['Вставь готовый промпт', 'Ответ ассистента копируешь в поле генерации — теги и персонажи уже привязаны к твоим рефам.'],
            ].map(([t, d]) => (
              <div key={t} className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-3">
                <p className="text-xs font-semibold text-violet-400">{t}</p>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* ── 15. History / favorites / examples ── */}
      <Section
        icon={<HistoryIcon className="w-4 h-4" />}
        title="История, избранное и примеры"
        subtitle="Ваши промпты не теряются — они сохраняются и доступны в один клик"
      >
        <div className="grid sm:grid-cols-3 gap-2.5">
          {[
            ['📜 История', 'Каждый отправленный промпт сохраняется (до 30). Клик — подставить обратно. Доступно в редакторе (вкладка «История») и в меню «История» на вкладке генерации.'],
            ['⭐ Избранное', 'Закрепите удачные промпты звёздочкой — они всегда сверху и не удаляются при переполнении истории (до 20).'],
            ['📚 Примеры', 'Готовые английские промпты для разных сценариев (T2VA, I2VA, FL2VA, Ref2VA). Доступны в редакторе и в меню «Примеры».'],
          ].map(([t, d]) => (
            <div key={t} className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-3">
              <p className="text-xs font-semibold text-foreground">{t}</p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{d}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── 16. Hover previews ── */}
      <Section
        icon={<MousePointerClickIcon className="w-4 h-4" />}
        title="Превью референсов при наведении"
        subtitle="Наведите курсор на тег — увидите, какой файл за ним стоит"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4 flex items-start gap-3">
          <span className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/25 flex items-center justify-center shrink-0">
            <MousePointerClickIcon className="w-4 h-4 text-cyan-400" />
          </span>
          <div className="space-y-1">
            <p className="text-xs text-foreground leading-relaxed">
              В поле промпта, редакторе и чате с LLM наведение курсора на тег <span className="font-mono text-[10px] px-1 py-0.5 rounded bg-purple-500/15 text-purple-300">&lt;Picture N&gt;</span> или <span className="font-mono text-[10px] px-1 py-0.5 rounded bg-cyan-500/15 text-cyan-300">&lt;Video N&gt;</span> показывает плавающее превью: картинку или постер видео. Это помогает не путать номера референсов в длинных промптах.
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Аудио-референсы (<span className="font-mono text-[10px]">&lt;Audio N&gt;</span>) превью не показывают — для звука нет визуального представления.
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Клик по самому превью референса открывает файл на весь экран — так видно детали, которых не разглядеть в маленьком квадрате (работает одинаково во всех вкладках студии).
            </p>
          </div>
        </div>
      </Section>

      {/* ── 17. Camera vocabulary (quick insert) ── */}
      <Section
        icon={<CameraIcon className="w-4 h-4" />}
        title="Кинематографический словарик (быстрая вставка)"
        subtitle="Фразы, которые модель понимает и любит — вставляйте в промпт"
      >
        <div className="flex flex-wrap gap-2">
          {CAMERA_WORDS.map((w) => (
            <span key={w} className="px-2.5 py-1 rounded-full border border-border bg-[var(--surface-2)]/60 text-xs text-foreground/80">
              {w}
            </span>
          ))}
        </div>
      </Section>

      {/* ── 18. Don'ts (summary) ── */}
      <Section
        icon={<AlertTriangleIcon className="w-4 h-4" />}
        title="Чего НЕ делать (кратко)"
        subtitle="Быстрый список запрещённых действий"
      >
        <ul className="space-y-1.5">
          {DONT_LIST.map((t, i) => (
            <li key={i} className="flex gap-2.5 rounded-lg border border-border bg-[var(--surface-2)]/40 px-3 py-2">
              <span className="text-red-400 text-xs shrink-0 mt-0.5">✕</span>
              <p className="text-xs text-muted-foreground leading-relaxed">{t}</p>
            </li>
          ))}
        </ul>
      </Section>
    </motion.div>
  )
}
