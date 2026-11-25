'use client'

/**
 * Settings Dialog — tabbed settings:
 *   • Общие        — ComfyUI-статус, модели
 *   • Внешний вид  — тема оформления, звук при завершении (правка 111)
 *   • LLM          — устройство, контекст, макс. длина ответа
 *   • Оптимизация  — VRAM-резерв, Dynamic VRAM
 *   • ComfyUI      — версия, Python, GPU, VRAM-разбивка
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  ServerIcon,
  RefreshCwIcon,
  CheckCircleIcon,
  AlertCircleIcon,
  Loader2Icon,
  CpuIcon,
  MoonIcon,
  SlidersHorizontalIcon,
  BotIcon,
  BoxIcon,
  LinkIcon,
  CopyIcon,
  FolderOpenIcon,
  AlertTriangleIcon,
  Trash2Icon,
  RotateCcwIcon,
  TrashIcon,
  MicIcon,
  PaletteIcon,
  SparklesIcon,
  FileVideoIcon,
  InfoIcon,
  PackageIcon,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { ModelsPanel } from './models-panel'
import { LoraSettingsPanel } from './lora-settings-panel'
import { DiffusionModelSelector } from './diffusion-model-selector'
import { ModelMigrationPanel } from './model-migration-panel'
import { LlmModelSelector } from './llm-model-selector'
import { VoiceSettingsPanel } from './voice-settings-panel'
// (правка 1080) карточка поколения ядра ComfyUI (откат 0.33 <-> актуальное 0.44)
import { CoreChannelCard, useCoreVersion } from './core-channel-card' // (правка 1115)
import { MODELS, MODEL_CATEGORIES, getManualRenameHint } from '@/lib/models-config'
import { useGenStore, DEFAULT_VIDEO_STATE } from '@/lib/gen-store'
import { pushPrefs } from '@/lib/prefs-sync' // (правка 804)
import { flushMirror } from '@/lib/settings-storage' // (правка 813)
import { usePromptHistory } from '@/lib/prompt-history-store'
import { useGenDurations } from '@/lib/gen-duration-store'
import { useAssistantChats } from '@/lib/assistant-chats-store'
import { useGalleryRefresh } from '@/lib/gallery-refresh-store'
// (правка 557) сброс очереди/джоб-сторов при «заводском сбросе»
import { useGenQueue } from '@/lib/gen-queue-store'
import { useTileUpscaleJob } from '@/lib/tile-upscale-job-store'
import { useControlNetJob } from '@/lib/controlnet-job-store'
import { useFpsJob } from '@/lib/fps-job-store'
import { applyUiScale, UI_SCALE_KEY, UI_SCALE_DEFAULT } from '@/lib/ui-scale'
import { SettingSlider } from './setting-slider'
import { LanguageSwitcher } from './language-switcher' // (правка 955)
import { UpdatePanel } from './update-panel' // (правка 790)
// (правка 1067) Единый визуальный язык настроек: карточки групп, строки,
// сегментированный выбор и общий тумблер — как в остальном приложении.
import {
  SettingsCard,
  SettingsRow,
  SettingsField,
  SettingsChoice,
  SettingsToggle,
  SettingsNote,
} from './settings-ui'

/* (правка 791) Метка версии динамическая: берётся с сервера (package.json),
 * а не зашита в код — иначе после самообновления пользователь видел бы
 * старую версию (метка живёт в собранном .next, который тоже подменяется,
 * но при следующем релизе её пришлось бы править руками). */
function AboutVersion() {
  const { t: tt } = useTranslation() // (правка 955)

  const [ver, setVer] = useState<string | null>(null)
  useEffect(() => {
    fetch('/api/update')
      .then((r) => r.json())
      .then((j) => setVer(typeof j?.current === 'string' ? j.current : null))
      .catch(() => { /* сервер недоступен — метка останется прочерком */ })
  }, [])
  return (
    <div className="text-xs text-muted-foreground">{ver ? tt("Версия {{p1}}", { p1: ver }) : tt("Версия …")}</div>
  )
}
import { useTranslation } from 'react-i18next' // (правка 955)
/* ─── Types ─── */

type TabId = 'general' | 'appearance' | 'llm' | 'voice' | 'optimization' | 'video' | 'links' | 'about' | 'reset'

/**
 * (правка 1067) Навигация настроек: те же 9 пунктов, но сгруппированы и
 * вынесены в левую колонку — как основной сайдбар приложения. Раньше это был
 * ряд из девяти равноправных вкладок по 11 px: при сужении окна он уезжал в
 * горизонтальную карусель, а «Сброс» выглядел так же, как «О программе».
 */
const NAV_GROUPS: Array<{
  label: string
  items: Array<{ id: TabId; label: string; icon: React.ReactNode; tone?: 'danger' }>
}> = [
  {
    label: 'Программа',
    items: [
      { id: 'general', label: 'Общие', icon: <BoxIcon className="w-[18px] h-[18px]" /> },
      // (правка 111) Внешний вид: тема оформления и звук — вынесено из «Общих»
      { id: 'appearance', label: 'Внешний вид', icon: <PaletteIcon className="w-[18px] h-[18px]" /> },
    ],
  },
  {
    label: 'ИИ',
    items: [
      { id: 'llm', label: 'LLM', icon: <BotIcon className="w-[18px] h-[18px]" /> },
      // (правка 65) Голосовой ввод (whisper STT, CPU)
      { id: 'voice', label: 'Голос', icon: <MicIcon className="w-[18px] h-[18px]" /> },
    ],
  },
  {
    label: 'Система',
    items: [
      { id: 'optimization', label: 'Оптимизация', icon: <SlidersHorizontalIcon className="w-[18px] h-[18px]" /> },
      // (правка 386) Формат сохранения видео: кодек + качество, на все режимы
      { id: 'video', label: 'Формат', icon: <FileVideoIcon className="w-[18px] h-[18px]" /> },
    ],
  },
  {
    label: 'Дополнительно',
    items: [
      { id: 'links', label: 'Ссылки', icon: <LinkIcon className="w-[18px] h-[18px]" /> },
      // Информация о программе (текст предоставляет пользователь)
      { id: 'about', label: 'О программе', icon: <InfoIcon className="w-[18px] h-[18px]" /> },
      // Опасная зона — отдельным пунктом внизу, с красным акцентом
      { id: 'reset', label: 'Сброс', icon: <AlertTriangleIcon className="w-[18px] h-[18px]" />, tone: 'danger' },
    ],
  },
]

/* (правка 1067) Поле ввода в стиле остальных панелей: h-8, surface-1,
 * cyan-фокус. Вынесено отдельно, чтобы не размножать длинный className. */
const SETTINGS_INPUT_CLASS =
  'h-8 w-full rounded-md border border-border bg-[var(--surface-1)] px-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-cyan-500/60 focus:outline-none focus:ring-1 focus:ring-cyan-500/40'

/* Текст вкладки «О программе» (правка 484 — текст автора).
 * Многострочный: переносы строк в тексте сохраняются при показе. */
const ABOUT_TEXT = `Дорогой друг! Спасибо, что пользуешься данным приложением! Моя главная цель — сделать инструменты для творчества доступными и удобными. Так как проект делается одним человеком на энтузиазме, я был бы признателен, если бы вы оставили свой отзыв, комментарий, пожелание или уведомили об ошибках. Так же, если вы хотите поддержать проект донатом, на моей странице есть ссылки на сбор средств.`

/** (правка 484) Ссылки автора — ТГ-группа, ТГ-канал, YouTube, сбор средств. */
const ABOUT_LINKS: Array<{ label: string; url: string; hint: string }> = [
  { label: 'ТГ-группа', url: 'https://t.me/rublev_cg_dev', hint: 'по заявке, но принимаю всех' },
  { label: 'ТГ-канал', url: 'https://t.me/rublev_cgai', hint: '' },
  { label: 'YouTube', url: 'https://www.youtube.com/@Rublev_CG', hint: '' },
  { label: 'Сбор средств', url: 'https://spasibomir.ru/pay/35238', hint: 'поддержать проект' },
]

/** (правка 484) Техническая информация о составе студии. */
const ABOUT_TECH: Array<{ label: string; value: string }> = [
  { label: 'Модель генерации', value: 'MiniMax H3 (видео + аудио), ComfyUI' },
  { label: 'Пайплайны', value: 'Генерация (2 прохода), Продление, Рефайн, Тайловый апскейл' },
  { label: 'LLM-ассистент', value: 'Локальная модель (llama.cpp), без облака' },
  { label: 'Голосовой ввод', value: 'whisper.cpp (CPU), локально' },
  { label: 'Обработка видео', value: 'ffmpeg (склейка, обрезка, конвертация)' },
]

/* ─── Component ─── */

/**
 * (релиз) Текст ошибки от сервера.
 *
 * API /api/config отдаёт конкретную причину в JSON-поле `error`
 * («Файл модели не найден: …», «В папке нет .gguf-модели: …» и т.п.),
 * но UI показывал безликое «Ошибка сохранения» — пользователь не понимал,
 * что именно исправлять. Теперь причина доходит до пользователя.
 */
async function saveErrorText(res: Response, fallback = 'Ошибка сохранения'): Promise<string> {
  try {
    const d = await res.json()
    if (d && typeof d.error === 'string' && d.error.trim()) return d.error
  } catch {
    /* ответ не JSON — показываем общий текст */
  }
  return fallback
}

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t: tt } = useTranslation() // (правка 955)

  const [tab, setTab] = useState<TabId>('general')
  // (правка 1139) Оптимизация: пресеты сверху, остальное — в двух свёрнутых
  // разделах («Дополнительные настройки» и «Ускорители»).
  const [showAdvancedOptim, setShowAdvancedOptim] = useState(false)
  const [showAccelerators, setShowAccelerators] = useState(false)
  // (правка 1067) При смене раздела прокрутка возвращается наверх: раньше
  // контейнер сохранял scrollTop, и «Оптимизация» могла открыться с середины.
  const scrollRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(false)
  const [connected, setConnected] = useState<boolean | null>(null)
  // (правка 1131) Дефолты reserve/headroom — 1/0 ГБ: headroom складывается с
  // reserve в DynamicVRAM, поэтому каждый гигабайт здесь отнимается у генерации.
  const [reserveVram, setReserveVram] = useState(2)
  const [dynamicVram, setDynamicVram] = useState(true)
  // (правка 490) Доп. запас свободной VRAM (--vram-headroom).
  // (правка 1141) 1 ГБ по умолчанию: без него полная VRAM вешает aimdo.
  const [vramHeadroom, setVramHeadroom] = useState(1)
  // (правка 1029) Принудительный --fast-disk; по умолчанию выкл (auto).
  const [fastDisk, setFastDisk] = useState(false)
  const [llmDevice, setLlmDevice] = useState<'auto' | 'gpu' | 'cpu'>('auto')
  // (правка 257) своя LLM (.gguf + mmproj)
  const [llmCustomModel, setLlmCustomModel] = useState('')
  const [llmCustomMmproj, setLlmCustomMmproj] = useState('')
  // (правка 467) Текущее значение [llm] model из конфига — нужно, чтобы
  // saveLlm не затирал выбор селектора (см. условную отправку llm_model).
  const [llmModelCurrent, setLlmModelCurrent] = useState('')
  // (правка 119) дефолтный контекст — 25K токенов
  const [llmCtxSize, setLlmCtxSize] = useState(25600)
  // (правка 313) значение больше никуда не отправляется (см. saveLlm) —
  // храним только сеттер для сбросов; само число из GET не нужно.
  const [, setLlmMaxOut] = useState(4096)
  // (правка 53) Видение видео ассистентом — по умолчанию ВКЛ: digest
  // видео-рефов строится сжато и кэшируется по содержимому файла.
  const [llmVideoVision, setLlmVideoVision] = useState(true)
  // (правка 109) Квантизация KV-кэша LLM; (правка 119) по умолчанию q4_0
  const [llmKvCache, setLlmKvCache] = useState<'off' | 'q8_0' | 'q5_1' | 'q4_0'>('q4_0')
  // (правка 140) Тонкая настройка сэмплинга УДАЛЕНА из UI: применяются
  // модель-осознанные значения из src/lib/llm-sampling.ts. Ручной escape-hatch
  // остался только через config.ini ([llm] sampling_override=1 + значения).
  // (правка 54) счётчик сбросов: после «Сброса настроек» селекторы моделей
  // перезагружают конфиг (они читают его только при монтировании).
  const [resetTick, setResetTick] = useState(0)
  // (правка 467) Перемонтирование селектора LLM после сохранения своей
  // модели: селектор читает llm_custom_model из конфига при монтировании —
  // без тика своя модель появлялась в списке только после переоткрытия
  // настроек (жалоба пользователя).
  const [llmSelTick, setLlmSelTick] = useState(0)
  const [saving, setSaving] = useState(false)
  const [confirmAction, setConfirmAction] = useState<'reset' | 'clean' | 'delete' | 'factory' | null>(null)
  const [executing, setExecuting] = useState(false)
  const [soundOn, setSoundOn] = useState(true)
  // (правка 1133) Живое превью шагов во всех режимах (config.ini [ui] live_preview).
  const [livePreview, setLivePreview] = useState(true)
  // (правка 386) формат сохранения видео ([video] в config.ini)
  const [videoCodec, setVideoCodec] = useState<'h264' | 'h265' | 'nvenc_h264' | 'nvenc_h265'>('h264')
  const [videoCrf, setVideoCrf] = useState(12)
  const [videoNvencBitrate, setVideoNvencBitrate] = useState(16)

  /* VRAM-оптимизации генерации (Low VRAM / Chunk FF) — живут в том же
     zustand-сторе, что и раньше в «Доп. параметрах»; генерация читает их оттуда. */
  const video = useGenStore((s) => s.video)
  const patchVideo = useGenStore((s) => s.patchVideo)

  /**
   * (правка 1131, 1139) Три пресета памяти — согласованный набор рычагов,
   * вместо ручной сборки. Резерв/headroom живут в config.ini и действуют
   * после перезапуска ComfyUI; остальное — сразу, без перезапуска.
   *
   *   • Слабые (8–12 ГБ): резерв 2 + headroom 1 (3 ГБ не отдаются моделям),
   *     bounded auto, head_chunks авто (16/8), мелкие чанки FFN (мин. 4),
   *     авто-окна включены.
   *   • Средние (16–24 ГБ): резерв 2, те же авто-рычаги, но FFN-чанков
   *     меньше (2): память уже позволяет.
   *   • Мощные (24+ ГБ): резерв 4 (браузер/рабочий стол), без агрессивного
   *     дробления — авто-размеры сами выберут 4 группы голов и 2 чанка.
   */
  const applyMemoryPreset = useCallback(async (kind: 'weak' | 'medium' | 'strong') => {
    const preset = kind === 'weak'
      ? { reserve: 2, headroom: 1, ff: 4 }
      : kind === 'medium'
        ? { reserve: 2, headroom: 1, ff: 2 }
        : { reserve: 4, headroom: 1, ff: 2 }
    patchVideo({
      lowVramAttention: true,
      chunkFeedForward: true,
      lowVramHeadChunks: 0, // авто по VRAM
      boundedTokenChunk: 0, // авто
      chunkFFChunks: preset.ff,
      boundedAttention: 'auto',
      autoContextWindows: true,
    })
    flushMirror()
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reserve_gb: preset.reserve, dynamic_vram: true, vram_headroom: preset.headroom }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setReserveVram(preset.reserve)
      setDynamicVram(true)
      setVramHeadroom(preset.headroom)
      const name = kind === 'weak' ? 'Слабые (8–12 ГБ)'
        : kind === 'medium' ? 'Средние (16–24 ГБ)' : 'Мощные (24+ ГБ)'
      toast.success(tt("Пресет «{{p1}}» включён. Новые генерации — сразу; резерв VRAM — после перезапуска ComfyUI.", { p1: tt(name) }))
    } catch (err) {
      toast.error(tt("Настройки генерации применены, но сохранить резерв VRAM не удалось: {{p1}}", { p1: String(err) }))
    }
  }, [patchVideo, tt])

  /** (правка 1133) Живое превью: сохраняем в config.ini сразу — сервер читает
   *  настройку на каждый запрос, так что она действует со следующей задачи,
   *  без перезапуска ComfyUI. */
  const persistLivePreview = useCallback(async (next: boolean) => {
    setLivePreview(next)
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ live_preview: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success(next
        ? tt("Живое превью включено.")
        : tt("Живое превью выключено: узлы превью не ставятся в граф, прогресс — только полосой."))
    } catch (err) {
      setLivePreview(!next)
      toast.error(tt("Не удалось сохранить настройку превью: {{p1}}", { p1: String(err) }))
    }
  }, [tt])
  // (правка 1115) Какие настройки вообще имеют смысл на текущем ядре.
  // Veda требует ComfyUI >= 0.38: на откатном 0.33 её блок не показываем.
  const { info: coreInfo } = useCoreVersion(5000)
  const vedaSupported = coreInfo?.capabilities?.veda !== false

  const checkConnection = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/comfy/health')
      setConnected(res.ok)
    } catch {
      setConnected(false)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      checkConnection()
      fetch('/api/config')
        .then((r) => r.json())
        .then((d) => {
          // сервер клампит в 1–16 (правка 315): `|| 3`
          // превращал сохранённый 0 в 3 при каждом открытии диалога
          // (правка 1131) fallback — новые дефолты 1/0.
          setReserveVram(typeof d.reserve_gb === 'number' ? d.reserve_gb : 2)
          setDynamicVram(d.dynamic_vram !== false)
          setVramHeadroom(typeof d.vram_headroom === 'number' ? d.vram_headroom : 1) // (правка 1141)
          setFastDisk(d.fast_disk === true) // (правка 1029)
          if (['auto', 'gpu', 'cpu'].includes(d.llm_device)) setLlmDevice(d.llm_device)
          if (typeof d.llm_context_size === 'number') setLlmCtxSize(d.llm_context_size)
          if (typeof d.llm_max_output_tokens === 'number') setLlmMaxOut(d.llm_max_output_tokens)
          if (typeof d.llm_video_vision === 'boolean') setLlmVideoVision(d.llm_video_vision)
          // (правка 109)
          if (['off', 'q8_0', 'q5_1', 'q4_0'].includes(d.llm_kv_cache)) setLlmKvCache(d.llm_kv_cache)
          // (правка 257)
          setLlmCustomModel(d.llm_custom_model || '')
          setLlmCustomMmproj(d.llm_custom_mmproj || '')
          setLlmModelCurrent(d.llm_model || '') // (правка 467)
          if (typeof d.sound_on === 'boolean') setSoundOn(d.sound_on)
          // (правка 1133)
          if (typeof d.live_preview === 'boolean') setLivePreview(d.live_preview)
          // (правка 386)
          if (['h264', 'h265', 'nvenc_h264', 'nvenc_h265'].includes(d.video_codec)) setVideoCodec(d.video_codec)
          if (typeof d.video_crf === 'number') setVideoCrf(d.video_crf)
          if (typeof d.video_nvenc_bitrate === 'number') setVideoNvencBitrate(d.video_nvenc_bitrate)
        })
        .catch(() => {
          setReserveVram(1); setDynamicVram(true); setVramHeadroom(1); setLlmDevice('auto')
          setLlmCtxSize(25600); setLlmMaxOut(4096); setLlmVideoVision(false)
          setLlmKvCache('q4_0')
        })
    }
  }, [open, checkConnection])

  // (правка 1067) Смена раздела — прокрутка наверх.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [tab])

  /** Save LLM settings (applied at next model load). */
  const saveLlm = useCallback(async () => {
    setSaving(true)
    try {
      // (правка 477) Решение о llm_model принимаем по ЖИВОМУ конфигу, а не по
      // состоянию на момент открытия диалога: селектор модели сохраняет выбор
      // сам и сразу, и устаревший llmModelCurrent затирал этот свежий выбор
      // (после «Сохранить» модель «сбрасывалась на стандартную»).
      let liveModel = llmModelCurrent
      try {
        const cfgRes = await fetch('/api/config')
        if (cfgRes.ok) {
          const cfgJson = await cfgRes.json()
          if (typeof cfgJson.llm_model === 'string') liveModel = cfgJson.llm_model.trim()
        }
      } catch { /* не смогли прочитать — решаем по состоянию диалога */ }

      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          llm_device: llmDevice,
          llm_context_size: llmCtxSize,
          // (правка 313) llm_max_output_tokens НЕ отправляем: контрола для
          // него в UI нет (текст честно говорит «рассчитывается автоматически»),
          // а безусловная отправка затирала ручное значение из config.ini.
          // Сервер сам клампит max_output под контекст (правка 313 в app-config).
          llm_video_vision: llmVideoVision,
          // (правка 109) квантизация KV-кэша
          llm_kv_cache: llmKvCache,
          // (правка 257) своя LLM
          llm_custom_model: llmCustomModel,
          llm_custom_mmproj: llmCustomMmproj,
          // (правка 467) Синхронизируем выбор селектора: заданный путь своей
          // модели = пункт «Своя модель» в списке (маркер 'llm_custom');
          // очищенный путь при ранее выбранной своей модели = возврат к
          // дефолту. Без этого llmBackend считал custom активным всегда при
          // непустом пути, а селектор его не показывал — модель «не
          // появлялась в списке».
          // (правка 477) Явный выбор встроенной модели в селекторе (live —
          // имя файла, не 'llm_custom') НЕ трогаем даже при заданном пути:
          // пользователь только что переключился на неё осознанно.
          ...(llmCustomModel.trim()
            ? (liveModel === '' || liveModel === 'llm_custom' ? { llm_model: 'llm_custom' } : {})
            : liveModel === 'llm_custom' ? { llm_model: '' } : {}),
        })
      })
      if (res.ok) {
        setLlmModelCurrent(liveModel) // (правка 477) состояние = живому конфигу
        setLlmSelTick((t) => t + 1) // (правка 467) селектор перечитывает конфиг
        toast.success(tt("Настройки LLM сохранены"), {
          // (правка 54) точнее: устройство/контекст — при следующем запуске
          // модели, видение видео и макс. длина — сразу (per-request).
          description: tt("Устройство/контекст/своя модель — при следующем запуске модели; остальное — сразу."),
        })
      } else {
        toast.error(await saveErrorText(res))
      }
    } catch {
      toast.error(tt("Ошибка сохранения"))
    } finally {
      setSaving(false)
    }
  }, [llmDevice, llmCtxSize, llmVideoVision, llmKvCache, llmCustomModel, llmCustomMmproj, llmModelCurrent])

  /** Save optimization settings (applied at ComfyUI restart). */
  const saveOptimization = useCallback(async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reserve_gb: reserveVram,
          dynamic_vram: dynamicVram,
          vram_headroom: vramHeadroom, // (правка 490)
          fast_disk: fastDisk, // (правка 1029)
        }),
      })
      if (res.ok) {
        toast.success(tt("Оптимизация сохранена"), {
          description: tt("Применится при перезапуске ComfyUI."),
        })
      } else {
        toast.error(await saveErrorText(res))
      }
    } catch {
      toast.error(tt("Ошибка сохранения"))
    } finally {
      setSaving(false)
    }
  }, [reserveVram, dynamicVram, vramHeadroom, fastDisk]) // (правка 490) + vramHeadroom; (1029) + fastDisk

  /** (правка 386) Сохранить формат сохранения видео ([video] config.ini). */
  const saveVideoFormat = useCallback(async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_codec: videoCodec,
          video_crf: videoCrf,
          video_nvenc_bitrate: videoNvencBitrate,
        }),
      })
      if (res.ok) {
        toast.success(tt("Формат сохранения сохранён"), {
          description: tt("Применится ко всем НОВЫМ задачам всех режимов (генерация, рефайн, продление, апскейлы, обрезка)."),
        })
      } else {
        toast.error(await saveErrorText(res))
      }
    } catch {
      toast.error(tt("Ошибка сохранения"))
    } finally {
      setSaving(false)
    }
  }, [videoCodec, videoCrf, videoNvencBitrate])

  /* ── Опасная зона: конфиг для подтверждения ── */
  const CONFIRM: Record<string, { title: string; desc: string; button: string }> = {
    reset: {
      title: tt("Сбросить настройки?"),
      // (правка 54) текст соответствует фактическому поведению: сбрасываются
      // ВСЕ параметры, включая выбор моделей (LLM-квант, базовая модель),
      // видение видео и звук.
      // (правка 826) в список сброшенного добавлен «формат сохранения» —
      // раньше он молча оставался пользовательским.
      desc: 'Все параметры (VRAM, LLM, выбор моделей, генерация, разрешение, шаги, формат сохранения, звук) вернутся к значениям по умолчанию. Действие необратимо.',
      button: 'Сбросить',
    },
    clean: {
      title: tt("Очистить кэш?"),
      desc: 'Будут удалены ВСЕ файлы из папки input ComfyUI (референсы, кадры, загрузки). Действие необратимо.',
      button: 'Очистить',
    },
    delete: {
      title: tt("Удалить весь контент?"),
      desc: 'Будут удалены ВСЕ сгенерированные видео, история чатов с ассистентом, история промптов и текущий промпт. Действие необратимо.',
      button: 'Удалить',
    },
    factory: {
      title: tt("Полный сброс?"),
      // (правка 130 + полный сброс) Полный сброс «как с завода»: настройки +
      // LoRA + кэш + контент + апскейл + вложения/чаты + промпты + логи.
      desc: 'Будут удалены ВСЕ ваши данные: сгенерированные видео (output), кэш и загрузки (input), файлы апскейла и его журналы, вложения чатов, история чатов ассистента, история и избранное промптов, текущий промпт, журнал задач, логи запуска и внутренние логи ComfyUI (включая его базу и сохранённые воркфлоу). Настройки (VRAM, LLM, модели, LoRA, формат видео, звук) вернутся к заводским, локальные данные браузера будут очищены. Программа перезапустится; для полной очистки логов ComfyUI закройте и снова откройте её. Действие необратимо.',
      button: 'Сбросить всё',
    },
  }

  const executeAction = useCallback(async (action: 'reset' | 'clean' | 'delete' | 'factory') => {
    setExecuting(true)
    try {
      if (action === 'factory') {
        /* (правка 130 + полный сброс) Полный сброс «как с завода».
         *
         * Сервер (/api/reset/full) удаляет:
         *   контент ComfyUI (output), кэш (input), temp, вложения чатов,
         *   файлы апскейла и его журналы, чаты, журнал задач, логи,
         *   настройки LoRA, внешние папки моделей и config.ini.
         * Клиент очищает Zustand-сторы, localStorage и sessionStorage,
         * затем перезагружается — в памяти не остаётся ничего.
         */
        // 1) Очередь ComfyUI + inflight — до удаления файлов, чтобы задачи
        //    не писали в уже очищенные папки.
        await fetch('/api/comfy/purge-queue', { method: 'POST' }).catch(() => {})

        // 2) Серверный полный сброс. (правка 926) Сервер требует токен
        //    подтверждения в теле — случайный/вредоносный POST без него отклоняется.
        const res = await fetch('/api/reset/full', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirm: 'RESET' }),
        })
        const data = await res.json().catch(() => null)
        const failed = !res.ok || !data?.ok
        const reason = Array.isArray(data?.errors) && data.errors.length
          ? data.errors.join('; ')
          : (data?.error || `HTTP ${res.status}`)

        // 3) Клиентские сторы (в памяти). Чистим даже при частичной ошибке
        //    сервера: иначе уцелевшие в памяти чаты синхронизировались бы
        //    обратно в уже удалённый data/assistant-chats.json.
        useAssistantChats.getState().clearAll()
        useAssistantChats.getState().setAssistantMode('generate')
        usePromptHistory.getState().clear()
        useGenStore.setState({ video: { ...DEFAULT_VIDEO_STATE } })
        useGenDurations.getState().clear()
        useGenQueue.setState({ items: [] })
        useTileUpscaleJob.getState().reset()
        useControlNetJob.getState().reset()
        useFpsJob.getState().reset()
        useGalleryRefresh.getState().bump()

        // 4) Всё локальное хранилище — целиком (тема, масштаб UI, приветствие,
        //    история промптов, чаты, очереди, прогресс, джобы).
        try { localStorage.clear() } catch { /* приватный режим */ }
        try { sessionStorage.clear() } catch { /* приватный режим */ }
        // (правка 804) Серверное зеркало настроек — удаляем целиком. Без этого
        // следующий старт молча восстановит настройки из data/settings/*.json,
        // и «заводской сброс» отменится сам собой.
        await fetch('/api/settings?all=1', { method: 'DELETE' }).catch(() => {})

        if (failed) {
          toast.error(tt("Полный сброс выполнен частично"), {
            description: tt("Не удалось: {{p1}}. Проверьте, запущена ли программа, и повторите.", { p1: reason }),
          })
          return
        }

        // 5) Перезагрузка: гарантирует, что ни один стор не остался в памяти
        //    со старыми данными.
        toast.success(tt("Полный сброс выполнен. Программа перезапускается..."))
        window.setTimeout(() => window.location.reload(), 1200)
        return
      }

      if (action === 'reset') {
        await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // (правка 1131) заводские значения: reserve 1, headroom 0 — под 8–12 ГБ.
            reserve_gb: 2,
            dynamic_vram: true,
            vram_headroom: 1, // (правка 1141) 1 ГБ — минимальный запас для aimdo
            llm_device: 'auto',
            llm_context_size: 25600,       // (правка 119) дефолт контекста — 25K
            llm_max_output_tokens: 4096,
            // (правка 54) ранее эти параметры сброс НЕ трогал — теперь сбрасываем всё:
            llm_video_vision: true, // видение видео (правка 53) → включено (digest + кэш)
            llm_kv_cache: 'q4_0',    // квантизация KV-кэша (правки 109/119) → q4_0
            // (правка 140) сэмплинг — всегда модель-осознанные значения
            llm_sampling_override: false,
            sound_on: true,          // звук → вкл
            live_preview: true,      // (правка 1133) живое превью → вкл
            llm_model: 'Qwen3.5-9B-Q4_K_M.gguf', // модель ассистента по умолчанию
            diffusion_model: '',     // базовая модель → дефолтная
            // (правка 311) своя LLM и внешние папки моделей — тоже сбрасываются
            // (как в заводском сбросе; раньше «Сброс настроек» их не трогал)
            llm_custom_model: '',
            llm_custom_mmproj: '',
            model_extra_paths: [],
            // (правка 65) голосовой ввод → значения по умолчанию
            stt_enabled: true,
            stt_dir: '',
            stt_model: '',
            stt_language: 'ru',
            stt_threads: 0,
            // (правка 826) формат сохранения (вкладка «Видео») — тоже сбрасывается:
            // подтверждение обещает «все параметры», а раньше video_* молча
            // оставались пользовательскими (сбрасывались только заводским сбросом).
            video_codec: 'h264',
            video_crf: 12,
            video_nvenc_bitrate: 16,
          }),
        })
        useGenStore.setState({ video: { ...DEFAULT_VIDEO_STATE } })
        useGenDurations.getState().clear()
        // (правка 435) Ассистент после сброса — в режиме «Генерация»
        // (дефолт), а не в последнем выбранном режиме «Продление».
        useAssistantChats.getState().setAssistantMode('generate')
        setReserveVram(1) // (правка 803)
        setDynamicVram(true)
        setVramHeadroom(1) // (правка 490, 803)
        setFastDisk(false) // (правка 1029)
        setLlmDevice('auto')
        setLlmCtxSize(25600)
        setLlmMaxOut(4096)
        // (правка 825) POST выше ставит llm_video_vision: true (заводской
        // дефолт), а чекбокс показывал false — после сброса сразу нажать
        // «Сохранить» на вкладке LLM молча выключало настройку.
        setLlmVideoVision(true)
        setLlmKvCache('q4_0')
        setSoundOn(true)
        setVideoCodec('h264')      // (правка 826) состояние диалога = POST reset
        setVideoCrf(12)            // (правка 826)
        setVideoNvencBitrate(16)   // (правка 826)
        setLlmCustomModel('')   // (правка 311)
        setLlmCustomMmproj('')  // (правка 311)
        setResetTick((t) => t + 1) // (правка 54) селекторы моделей перечитают конфиг
        // Выгружаем загруженную LLM: иначе после сброса она продолжала бы
        // отвечать со старой моделью/конфигом (чат-роут уже читает новые) —
        // «глючные» первые ответы. Страховка — сигнатура в ensureLlm.
        void fetch('/api/llm/stop', { method: 'POST' }).catch(() => {})
        toast.success(tt("Настройки сброшены к значениям по умолчанию"))
      } else if (action === 'clean') {
        const res = await fetch('/api/comfy/clean', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: 'input' }),
        })
        const data = await res.json()
        if (data.ok) {
          useGenStore.getState().clearVideoRefs()
          useGenStore.setState((s) => ({
            video: { ...s.video, startFrame: null, endFrame: null },
          }))
          toast.success(tt("Кэш очищен (удалено: {{p1}})", { p1: data.deleted }))
        } else {
          toast.error(data.error || 'Ошибка очистки кэша')
        }
      } else if (action === 'delete') {
        const res = await fetch('/api/comfy/clean', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: 'output' }),
        })
        const data = await res.json()
        if (data.ok) {
          useAssistantChats.getState().clearAll()
          useGenDurations.getState().clear()
          usePromptHistory.getState().clear()
          useGenStore.setState((s) => ({ video: { ...s.video, prompt: '' } }))
          // (правка 134) Галерея: сигнал на перечитывание — видео удалены на
          // бэкенде, галерея сразу опустеет (не дожидаясь переключения вкладок).
          useGalleryRefresh.getState().bump()
          toast.success(tt("Контент удалён (удалено: {{p1}})", { p1: data.deleted }))
        } else {
          toast.error(data.error || 'Ошибка удаления контента')
        }
      }
    } catch (err) {
      console.error('Action failed:', err)
      toast.error(tt("Произошла ошибка при выполнении действия"))
    } finally {
      setExecuting(false)
      setConfirmAction(null)
    }
  }, [])

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Окно фиксированного размера: слева — навигация (как сайдбар
          приложения), справа — единственная прокручиваемая колонка карточек. */}
      <DialogContent className="w-[1020px] max-w-[96vw] sm:max-w-[1020px] h-[880px] max-h-[94vh] flex flex-col overflow-hidden gap-0 p-0">
        <DialogHeader className="shrink-0 gap-1 border-b border-border px-5 py-4">
          <DialogTitle className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-md border border-cyan-500/25 bg-cyan-500/10">
              <ServerIcon className="w-4 h-4 text-cyan-400" />
            </span>
            {tt("Настройки")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {tt("Модели, LLM, память GPU, внешний вид и сервис студии")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {/* Навигация: тот же приём, что у основного сайдбара — surface-1,
              активный пункт surface-3 с цветной полосой слева. */}
          <aside className="flex w-[224px] shrink-0 flex-col border-r border-border bg-[var(--surface-1)]">
            <nav className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2 py-3">
              {NAV_GROUPS.map((group) => (
                <div key={group.label}>
                  <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                    {tt(group.label)}
                  </p>
                  <div className="space-y-0.5">
                    {group.items.map((item) => {
                      const isActive = tab === item.id
                      const isDanger = item.tone === 'danger'
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setTab(item.id)}
                          className={cn(
                            'relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors',
                            isActive
                              ? 'bg-[var(--surface-3)] text-foreground'
                              : 'text-muted-foreground hover:bg-[var(--surface-2)] hover:text-foreground',
                          )}
                        >
                          {isActive && (
                            <span
                              className={cn(
                                'absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full',
                                isDanger ? 'bg-red-400' : 'bg-cyan-400',
                              )}
                            />
                          )}
                          <span
                            className={cn(
                              'shrink-0',
                              isActive && (isDanger ? 'text-red-400' : 'text-cyan-400'),
                            )}
                          >
                            {item.icon}
                          </span>
                          <span className="truncate text-sm font-medium">{tt(item.label)}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </nav>
          </aside>

          {/* Содержимое: единственная прокручиваемая область */}
          <div className="flex min-w-0 flex-1 flex-col bg-background">
            <div ref={scrollRef} data-settings-scroll="" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
              <div className="px-5 py-4">
        {/* ─────────── General ─────────── */}
        {tab === 'general' && (
          <div className="space-y-3">
            {/* 1. Состояние бэкенда и служебные окна */}
            <SettingsCard
              icon={<ServerIcon className="w-4 h-4" />}
              title={tt("Состояние")}
              description={tt("Подключение к ComfyUI и служебные окна студии")}
            >
              <SettingsRow
                label="ComfyUI"
                description={
                  connected === false
                    ? tt("Недоступен на порту 8188 — генерация не запустится, пока не поднимете бэкенд.")
                    : tt("Порт 8188. Статус проверяется при открытии настроек.")
                }
                right={
                  <>
                    {loading ? (
                      <Badge variant="secondary" className="gap-1 text-[10px]">
                        <Loader2Icon className="w-3 h-3 animate-spin" />
                        {' '}{tt("Проверка...")}
                      </Badge>
                    ) : connected ? (
                      <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 gap-1 text-[10px]">
                        <CheckCircleIcon className="w-3 h-3" />
                        {' '}{tt("Подключено")}
                      </Badge>
                    ) : (
                      <Badge variant="destructive" className="gap-1 text-[10px]">
                        <AlertCircleIcon className="w-3 h-3" />
                        {' '}{tt("Недоступно")}
                      </Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={checkConnection}
                      disabled={loading}
                      title={tt("Перепроверить подключение")}
                    >
                      <RefreshCwIcon className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
                    </Button>
                  </>
                }
              />
              <SettingsRow
                label={tt("Окно приветствия")}
                description={tt("Краткая инструкция при запуске. Если поставили галочку «Больше не показывать» — верните его этой кнопкой.")}
                right={
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    onClick={() => {
                      try {
                        localStorage.removeItem('h3_welcome_seen_v1')
                        pushPrefs() // (правка 804) дублируем prefs на сервер
                      } catch { /* ignore */ }
                      window.dispatchEvent(new CustomEvent('h3:show-welcome'))
                      onOpenChange(false)
                    }}
                  >
                    <SparklesIcon className="w-3.5 h-3.5" />
                    {' '}{tt("Показать")}
                  </Button>
                }
              />
            </SettingsCard>

            {/* 2. Модели — самый тяжёлый блок, поэтому отдельной карточкой */}
            <SettingsCard
              icon={<PackageIcon className="w-4 h-4" />}
              title={tt("Модели")}
              description={tt("Файлы генерации и ассистента: скачивание, проверка, удаление")}
            >
              <ModelsPanel />
            </SettingsCard>

            {/* 3. Базовая diffusion-модель (правка 45) */}
            <SettingsCard
              icon={<BoxIcon className="w-4 h-4" />}
              title={tt("Базовая модель")}
              description={tt("Какая diffusion-модель используется для генерации")}
            >
              <DiffusionModelSelector key={`dm-${resetTick}`} />
            </SettingsCard>

            {/* 4. Пользовательские LoRA (правка 44) */}
            <SettingsCard
              icon={<SparklesIcon className="w-4 h-4" />}
              title="LoRA"
              description={tt("Свои LoRA: включение, сила и триггерные слова")}
            >
              <LoraSettingsPanel />
            </SettingsCard>

            {/* 5. Свои папки моделей (правка 257; key — перечитывание после сброса) */}
            <SettingsCard
              icon={<FolderOpenIcon className="w-4 h-4" />}
              title={tt("Свои папки моделей")}
              description={tt("Коллекции вне папки студии — без копирования файлов")}
            >
              <ExtraModelPathsPanel key={`emp-${resetTick}`} />
            </SettingsCard>

            {/* 6. Перенос со старой версии (правка 47) */}
            <SettingsCard
              icon={<FolderOpenIcon className="w-4 h-4" />}
              title={tt("Перенос со старой версии")}
              description={tt("Модели, файлы, контент и данные предыдущей установки")}
            >
              <ModelMigrationPanel />
            </SettingsCard>

          </div>
        )}

        {/* ─────────── Appearance (правка 111) ─────────── */}
        {tab === 'appearance' && (
          <div className="space-y-3">
            <SettingsCard
              icon={<PaletteIcon className="w-4 h-4" />}
              title={tt("Оформление")}
              description={tt("Тема, масштаб интерфейса и язык")}
            >
              <SettingsField
                label={tt("Тема оформления")}
                description={tt("Все темы тёмные — как в основном интерфейсе студии")}
              >
                <ThemeSwitcher />
              </SettingsField>
              <SettingsField
                label={tt("Масштаб интерфейса")}
                description={tt("Масштабирует панели, кнопки, отступы и шрифт. Применяется сразу и запоминается.")}
              >
                <UiScaleSwitcher />
              </SettingsField>
              <SettingsRow
                label={tt("Язык интерфейса")}
                description={tt("Применяется сразу, без перезапуска. Переведены интерфейс, уведомления, сообщения сервера и раздел «Обучение»; ответы Ассистента остаются на русском.")}
                right={<LanguageSwitcher />}
              />
            </SettingsCard>

            <SettingsCard
              icon={<SlidersHorizontalIcon className="w-4 h-4" />}
              title={tt("Поведение")}
              description={tt("Звук завершения и работа с текстом")}
            >
              <SettingsRow
                label={tt("Звук при завершении")}
                description={tt("Короткий сигнал при окончании генерации")}
                right={
                  <SettingsToggle
                    checked={soundOn}
                    label={tt("Звук при завершении")}
                    onChange={(next) => {
                      setSoundOn(next)
                      void fetch('/api/config', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sound_on: next }),
                      }).catch(() => { /* ignore */ })
                    }}
                  />
                }
              />
              <SelectTextSwitcher />
            </SettingsCard>
          </div>
        )}

        {/* ─────────── LLM ─────────── */}
        {tab === 'llm' && (
          <div className="space-y-3">
            <SettingsCard
              icon={<CpuIcon className="w-4 h-4" />}
              title={tt("Устройство и контекст")}
              description={tt("Где и с каким контекстом считается модель чата")}
            >
              <SettingsField label={tt("Устройство")} description={tt("Где считается модель чата")}>
                <SettingsChoice
                  value={llmDevice}
                  onChange={setLlmDevice}
                  options={[
                    { value: 'auto', label: tt("Авто"), title: tt("GPU при свободной VRAM, иначе CPU") },
                    { value: 'gpu', label: 'GPU', title: tt("Быстро (~40+ ток/с), делит VRAM с генерацией") },
                    { value: 'cpu', label: 'CPU', title: tt("Медленнее, но не трогает VRAM") },
                  ]}
                />
              </SettingsField>
              <SettingsField
                label={tt("Контекст LLM")}
                description={tt("Сколько токенов диалога модель держит в памяти")}
                value={`${(llmCtxSize / 1024).toFixed(llmCtxSize % 1024 === 0 ? 0 : 1)}K`}
              >
                <div>
                  <input
                    type="range"
                    // (правка 827) min 8192→4096: сервер и чтение принимают от
                    // 4096 (правка 314) — UI не давал установить нижнюю половину диапазона.
                    min={4096}
                    max={102400}
                    step={1024}
                    value={llmCtxSize}
                    onChange={(e) => setLlmCtxSize(parseInt(e.target.value, 10))}
                    className="h-1.5 w-full cursor-pointer accent-cyan-400"
                  />
                  <div className="mt-1 flex justify-between text-[10px] text-muted-foreground/60">
                    <span>4K</span><span>100K</span>
                  </div>
                </div>
              </SettingsField>
              {/* (правка 109) Квантизация KV-кэша: экономит VRAM/RAM, качество чуть ниже */}
              <SettingsField
                label={tt("Квантизация KV-кэша")}
                description={tt("Сжимает кэш контекста модели чата (меньше памяти при том же контексте). Q8 — почти без потери качества, Q4 — максимум экономии.")}
              >
                <SettingsChoice
                  value={llmKvCache}
                  cols={4}
                  onChange={setLlmKvCache}
                  options={[
                    { value: 'off', label: tt("Выкл"), title: tt("Как раньше: полная точность, больше памяти") },
                    { value: 'q8_0', label: 'Q8', title: tt("Рекомендуется: почти без потери качества") },
                    { value: 'q5_1', label: 'Q5', title: tt("Умеренная экономия памяти") },
                    { value: 'q4_0', label: 'Q4', title: tt("Максимальная экономия памяти") },
                  ]}
                />
              </SettingsField>
            </SettingsCard>

            <SettingsCard
              icon={<SparklesIcon className="w-4 h-4" />}
              title={tt("Возможности")}
              description={tt("Что ассистент умеет видеть и учитывать")}
            >
              {/* (правка 53) Видение видео ассистентом — по умолчанию ВКЛ */}
              <SettingsRow
                label={tt("Видение видео ассистентом")}
                description={tt("Вкл: ассистент получает сжатый digest видео-рефов (кэшируется по содержимому файла). Выкл: знает только о наличии видео и не выдумывает его содержимое.")}
                right={
                  <SettingsToggle
                    checked={llmVideoVision}
                    onChange={setLlmVideoVision}
                    label={tt("Видение видео ассистентом")}
                  />
                }
              />
            </SettingsCard>

            {/* (правка 48) Выбор встроенной модели; key — перечитывание после
                сброса (правка 54) и после сохранения своей модели (правка 467) */}
            <SettingsCard
              icon={<BotIcon className="w-4 h-4" />}
              title={tt("Модель ассистента")}
              description={tt("Встроенные модели с разной квантизацией")}
            >
              <LlmModelSelector key={`llm-${resetTick}-${llmSelTick}`} />
            </SettingsCard>

            {/* (правка 257) Своя модель ассистента: абсолютный путь к .gguf.
                Непустой путь перекрывает выбор модели выше (баннер про
                модели ассистента при этом гаснет). mmproj — опционально. */}
            <SettingsCard
              icon={<FolderOpenIcon className="w-4 h-4" />}
              title={tt("Своя модель (GGUF)")}
              description={tt("Путь перекрывает выбор из списка выше. Пусто = встроенная модель")}
            >
              <div className="max-w-[520px] space-y-2 px-3.5 py-3">
                {/* (правка 308) Сервер принимает и папку, и файл: папка
                    резолвится в первый .gguf внутри неё при сохранении. */}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 w-full justify-start gap-1.5 text-xs font-normal"
                  onClick={async () => {
                    try {
                      // (правка 1131) Выбираем ФАЙЛ, а не папку: при нескольких
                      // .gguf в папке сервер брал первый попавшийся. И сразу
                      // сохраняем — раньше путь жил только в состоянии формы до
                      // нажатия «Сохранить» на вкладке LLM.
                      const res = await fetch('/api/dialog/file', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          title: tt("Выберите файл модели .gguf"),
                          filter: 'Модели (*.gguf)|*.gguf|Все файлы (*.*)|*.*',
                        }),
                      })
                      const data = await res.json()
                      if (!res.ok) {
                        toast.error(data.error || 'Не удалось открыть диалог выбора файла.')
                        return
                      }
                      const picked = (data.path as string) || ''
                      if (!picked) return
                      setLlmCustomModel(picked)
                      const saved = await fetch('/api/config', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ llm_custom_model: picked, llm_model: 'llm_custom' }),
                      })
                      if (saved.ok) {
                        void fetch('/api/llm/stop', { method: 'POST' }).catch(() => {})
                        toast.success(tt("Своя модель сохранена"), {
                          description: tt("Ассистент перезапустится с ней при следующем сообщении."),
                        })
                      } else {
                        toast.error(await saveErrorText(saved))
                      }
                    } catch {
                      toast.error(tt("Не удалось открыть диалог выбора файла."))
                    }
                  }}
                >
                  <FolderOpenIcon className="w-3.5 h-3.5 shrink-0" />
                  {' '}{tt("Выбрать папку на диске…")}
                </Button>
                <input
                  type="text"
                  value={llmCustomModel}
                  onChange={(e) => setLlmCustomModel(e.target.value)}
                  placeholder={tt("…или введите путь вручную: D:\\models")}
                  className={SETTINGS_INPUT_CLASS}
                />
                <span className="block pt-1 text-[11px] text-muted-foreground">{tt("mmproj (зрение, опционально)")}</span>
                {/* (правка 308) Тоже файл или папка: из папки берётся первый
                    файл с 'mmproj' в имени. */}
                <input
                  type="text"
                  value={llmCustomMmproj}
                  onChange={(e) => setLlmCustomMmproj(e.target.value)}
                  placeholder="D:\models\my-model-mmproj-F16.gguf"
                  className={SETTINGS_INPUT_CLASS}
                />
              </div>
            </SettingsCard>

            <SettingsNote className="rounded-lg border border-border/60 bg-[var(--surface-1)] px-3.5 py-2.5">
              {tt("Макс. длина ответа рассчитывается автоматически из контекста. Устройство, контекст и своя модель применяются при следующем запуске модели; остальное — сразу. При генерации видео GPU-режим автоматически уступает память.")}
            </SettingsNote>
          </div>
        )}

        {/* ─────────── Voice input (правка 65) ─────────── */}
        {tab === 'voice' && <VoiceSettingsPanel />}

        {/* ─────────── Optimization ─────────── */}
        {tab === 'optimization' && (
          <div className="space-y-3">
            {/* (правка 1139) Пресеты памяти — первое, что видит пользователь.
                Остальные рычаги спрятаны в двух свёрнутых разделах ниже. */}
            <SettingsCard
              icon={<CpuIcon className="w-4 h-4" />}
              title={tt("Пресеты памяти")}
              description={tt("Готовый набор рычагов под объём видеопамяти. Резерв применяется после перезапуска ComfyUI, остальное — сразу.")}
            >
              <div className="grid gap-2 px-3.5 py-3 sm:grid-cols-3">
                {([
                  ['weak', 'Слабые', '8–12 ГБ', 'Резерв 2 ГБ + headroom 1 ГБ, Bounded Attention = Авто, 16/8 групп голов, FFN 4 чанка, авто-окна'],
                  ['medium', 'Средние', '16–24 ГБ', 'Резерв 2 ГБ + headroom 1 ГБ, авто-размеры attention, FFN 2 чанка'],
                  ['strong', 'Мощные', '24+ ГБ', 'Резерв 4 ГБ + headroom 1 ГБ, без мелкого дробления, FFN 2 чанка'],
                ] as const).map(([kind, name, vram, hint]) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => { void applyMemoryPreset(kind) }}
                    className="rounded-lg border border-border bg-[var(--surface-1)] p-2.5 text-left transition-colors hover:border-cyan-500/40 hover:bg-cyan-500/5"
                  >
                    <p className="text-xs font-medium text-foreground">{tt(name)}</p>
                    <p className="text-[10px] text-cyan-300/90">{vram}</p>
                    <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{tt(hint)}</p>
                  </button>
                ))}
              </div>
            </SettingsCard>

            {/* (правка 1139) Всё, кроме ускорителей, — в свёрнутом разделе. */}
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setShowAdvancedOptim((v) => !v)}
                className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-border hover:border-cyan-500/30 transition-all text-left"
              >
                <span className="text-xs font-medium text-muted-foreground">{tt("Дополнительные настройки")}</span>
                <span className={cn('text-[10px] text-muted-foreground transition-transform', showAdvancedOptim && 'rotate-180')}>▼</span>
              </button>
              {showAdvancedOptim && (
              <div className="space-y-3">
            {/* ── Память GPU: применяется при перезапуске ComfyUI ── */}
            <SettingsCard
              icon={<CpuIcon className="w-4 h-4" />}
              title={tt("Память GPU (ComfyUI)")}
              description={tt("Резерв и динамическое управление VRAM. Применяется при перезапуске ComfyUI.")}
            >
              <SettingsField
                label={tt("Резерв VRAM")}
                description={tt("Сколько памяти менеджер моделей вычитает из доступной — модели выгружаются раньше.")}
                value={`${reserveVram} GB`}
              >
                <div>
                  <input
                    type="range"
                    /* (правка 315) Диапазон унифицирован с сервером: 1–16 ГБ */
                    min={1}
                    max={16}
                    step={0.5}
                    value={reserveVram}
                    onChange={(e) => setReserveVram(parseFloat(e.target.value))}
                    className="h-1.5 w-full cursor-pointer accent-amber-400"
                  />
                  {/* Позиции по реальной шкале 1–16: 8 GB стоит на ~47%, а не
                      в центре (justify-between его прижимал к 50% и врал) */}
                  <div className="relative mt-1 h-3 text-[10px] text-muted-foreground/60">
                    <span className="absolute left-0">1 GB</span>
                    <span className="absolute" style={{ left: '47%' }}>8 GB</span>
                    <span className="absolute right-0">16 GB</span>
                  </div>
                </div>
              </SettingsField>

              {/* (правка 490) Доп. запас свободной VRAM (--vram-headroom) */}
              <SettingsField
                label={tt("Запас свободной VRAM (headroom)")}
                description={tt("Держит эту память свободной сверх резерва. 1 ГБ — минимум: без него Refine «Частями» и тайловый апскейл забивают VRAM до предела, и aimdo зависает. Меньше 1 не ставьте.")}
                value={vramHeadroom > 0 ? `${vramHeadroom} GB` : tt("Выкл")}
              >
                <div>
                  <input
                    type="range"
                    min={0}
                    max={8}
                    step={0.5}
                    value={vramHeadroom}
                    onChange={(e) => setVramHeadroom(parseFloat(e.target.value))}
                    className="h-1.5 w-full cursor-pointer accent-amber-400"
                  />
                  <div className="relative mt-1 h-3 text-[10px] text-muted-foreground/60">
                    <span className="absolute left-0">{tt("Выкл")}</span>
                    <span className="absolute" style={{ left: '22%' }}>2 GB</span>
                    <span className="absolute right-0">8 GB</span>
                  </div>
                </div>
              </SettingsField>

              <SettingsRow
                label={tt("Принудительный fast-disk")}
                description={tt("Дисковый режим ComfyUI для DynamicVRAM. Может помочь на быстром NVMe; на SATA SSD может быть медленнее.")}
                right={
                  <SettingsToggle
                    checked={fastDisk}
                    onChange={setFastDisk}
                    label={tt("Принудительный fast-disk")}
                  />
                }
              />

              <SettingsRow
                label="Dynamic VRAM"
                description={tt("Динамическое управление VRAM ComfyUI")}
                right={
                  <SettingsToggle checked={dynamicVram} onChange={setDynamicVram} label="Dynamic VRAM" />
                }
              />

              <SettingsNote>
                {tt("Применяется при перезапуске ComfyUI — после сохранения перезапустите студию (start.bat).")}
              </SettingsNote>
            </SettingsCard>

            {/* (правка 1080) Поколение ядра ComfyUI: актуальное 0.44+ или
                откатное 0.33.x (comfy-aimdo 0.4.13) для слабых карт. */}
            <CoreChannelCard />

            {/* ── Оптимизация генерации: применяется сразу ── */}
            <SettingsCard
              icon={<SlidersHorizontalIcon className="w-4 h-4" />}
              title={tt("Экономия VRAM при генерации")}
              description={tt("Применяется ко всем новым генерациям сразу — без перезапуска ComfyUI.")}
            >
              {/* Low VRAM Attention */}
              <SettingsRow
                label="Low VRAM Attention"
                description={tt("Attention чанками по головам — экономит видеопамять, математика не меняется")}
                right={
                  <SettingsToggle
                    checked={video.lowVramAttention}
                    onChange={(next) => patchVideo({ lowVramAttention: next })}
                    label="Low VRAM Attention"
                  />
                }
              />

              {/* (правка 1095) число групп голов: больше групп — меньше транзиенты
                  ядра attention при неизменной математике. */}
              {video.lowVramAttention && (
                <div className="bg-[var(--surface-1)] px-3.5 py-3">
                  <div className="max-w-[440px] space-y-3 border-l-2 border-cyan-500/20 pl-3">
                    <SettingSlider
                      label={tt("Low VRAM: групп голов")}
                      labelTitle={tt("На сколько групп делить головы (head_chunks). Математика та же: головы независимы. Больше групп — меньше пик VRAM, но больше запусков ядра. 0 = авто по объёму карты: 16 групп на 8 ГБ, 8 на 12 ГБ, 6 на 16 ГБ, 4 на 24+. Вручную: 8–16 стоит попробовать на картах 8–12 ГБ.")}
                      value={typeof video.lowVramHeadChunks === 'number' ? video.lowVramHeadChunks : 0}
                      onChange={(v) => patchVideo({ lowVramHeadChunks: Math.round(v) })}
                      min={0}
                      max={56}
                      step={1}
                      formatValue={(v) => (v <= 0 ? tt("Авто") : String(Math.round(v)))}
                    />
                  </div>
                </div>
              )}

              {/* Chunk FeedForward + settings */}
              <SettingsRow
                label="Chunk FeedForward"
                description={tt("FeedForward чанками на длинных последовательностях — экономит VRAM. Число чанков автоматически поднимается, если транзиент FFN больше ~1.4 ГБ (математика не меняется)")}
                right={
                  <SettingsToggle
                    checked={video.chunkFeedForward}
                    onChange={(next) => patchVideo({ chunkFeedForward: next })}
                    label="Chunk FeedForward"
                  />
                }
              />

              {video.chunkFeedForward && (
                <div className="bg-[var(--surface-1)] px-3.5 py-3">
                  <div className="max-w-[440px] space-y-3 border-l-2 border-cyan-500/20 pl-3">
                    <SettingSlider
                      label={tt("Chunk FF: число чанков")}
                      value={typeof video.chunkFFChunks === 'number' ? video.chunkFFChunks : 2}
                      onChange={(v) => patchVideo({ chunkFFChunks: Math.round(v) })}
                      min={1}
                      max={8}
                      step={1}
                    />
                    <SettingSlider
                      label={tt("Chunk FF: порог длины")}
                      value={typeof video.chunkFFThreshold === 'number' ? video.chunkFFThreshold : 4096}
                      onChange={(v) => patchVideo({ chunkFFThreshold: Math.round(v) })}
                      min={1024}
                      max={16384}
                      step={512}
                    />
                  </div>
                </div>
              )}

              {/* Bounded Attention (правка 1089) — поблочный attention для слабых карт;
                  авторешение по VRAM + ручной вкл/выкл. В цепочке ставится после
                  Low VRAM Attention; с Veda Sparse Attention несовместим (узел выключается). */}
              <SettingsRow
                label="Bounded Attention"
                description={tt("Attention блоками по токенам — срезает пик VRAM на 1080p и длинных клипах, но замедляет рендер (QKV-проекции считаются дважды, attention-ядро запускается чаще). Авто = включён на картах до 12 ГБ (если последовательность длиннее ~20k токенов), а также на канве от 1.5 Мп на картах до 16 ГБ. На картах от 16 ГБ авто узел не ставит — включай вручную, если нужно. С Veda Sparse Attention несовместим.")}
                right={
                  <SettingsChoice
                    value={video.boundedAttention}
                    onChange={(next) => patchVideo({ boundedAttention: next })}
                    cols={3}
                    options={[
                      { value: 'auto', label: tt("Авто"), title: tt("Включён на картах до 12 ГБ от ~20k токенов, и на канве от 1.5 Мп на картах до 16 ГБ") },
                      { value: 'on', label: tt("Вкл") },
                      { value: 'off', label: tt("Выкл") },
                    ]}
                  />
                }
              />

              {/* (правка 1095) размер куска токенов bounded attention: на больших
                  картах крупнее кусок = меньше прогонов qkv_proj = быстрее. */}
              {video.boundedAttention !== 'off' && (
                <div className="bg-[var(--surface-1)] px-3.5 py-3">
                  <div className="max-w-[440px] space-y-3 border-l-2 border-cyan-500/20 pl-3">
                    <SettingSlider
                      label={tt("Bounded: кусок токенов")}
                      labelTitle={tt("Сколько токенов обрабатывается за один проход Q/K/V и out_proj. 0 = авторазмер по VRAM карты: ~2–3k токена на 8–12 ГБ, 4–5k на 12–16 ГБ, до 12k на 24 ГБ. Крупнее кусок — меньше прогонов проекций и быстрее; меньше кусок — ниже пик. В тайловых режимах авто не применяется, там берётся 4096.")}
                      value={typeof video.boundedTokenChunk === 'number' ? video.boundedTokenChunk : 0}
                      onChange={(v) => patchVideo({ boundedTokenChunk: Math.round(v) })}
                      min={0}
                      max={12288}
                      step={1024}
                    />
                    <p className="text-[10px] leading-tight text-muted-foreground">
                      {tt("0 = авторазмер. Математика attention не меняется при любом размере куска.")}
                    </p>
                  </div>
                </div>
              )}

              {/* (правка 1131) Авто-временные окна: главный способ провести
                  длинный клип на слабой карте — пик зависит от окна, а не длины. */}
              <SettingsRow
                label={tt("Авто-временные окна")}
                description={tt("Если клип не влезает в бюджет VRAM одним проходом, модель считает его окнами по 17n+5 кадров (слияние pyramid + FreeNoise, как в Refine «Частями»). Открывает 10+ секунд и 2K на 8–12 ГБ. Выключите, если нужен строго один проход.")}
                right={
                  <SettingsToggle
                    checked={video.autoContextWindows !== false}
                    onChange={(next) => patchVideo({ autoContextWindows: next })}
                    label={tt("Авто-временные окна")}
                  />
                }
              />

              {/* (правка 1133) Живое превью: общая настройка для всех режимов.
                  Выключено — узлы превью не ставятся в граф совсем. */}
              <SettingsRow
                label={tt("Живое превью шагов")}
                description={tt("Анимированный предпросмотр во время генерации (все режимы: Генерация, Продление, Refine, Tile, Face). Идёт с реальной скоростью: 8 кадров на секунду времени клипа. Выключите, чтобы вообще не тратить VRAM и время на tiny-VAE: прогресс останется полосой и счётчиком шагов. Действует со следующей задачи, без перезапуска ComfyUI.")}
                right={
                  <SettingsToggle
                    checked={livePreview}
                    onChange={(next) => { void persistLivePreview(next) }}
                    label={tt("Живое превью шагов")}
                  />
                }
              />

              {/* 3D-апскейлер латентов (правка 806) */}
              <SettingsRow
                label={tt("3D-апскейлер латентов")}
                description={tt("Обученный 3D-апскейлер между проходами. Если выключить — латент просто растягивается: быстрее и экономит VRAM, но качество хуже")}
                right={
                  <SettingsToggle
                    checked={video.latentUpscaler3D}
                    onChange={(next) => patchVideo({ latentUpscaler3D: next })}
                    label={tt("3D-апскейлер латентов")}
                  />
                }
              />
            </SettingsCard>
              </div>
              )}
            </div>

            {/* (правка 1139) Ускорители — отдельный свёрнутый раздел. */}
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setShowAccelerators((v) => !v)}
                className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-border hover:border-cyan-500/30 transition-all text-left"
              >
                <span className="text-xs font-medium text-muted-foreground">{tt("Ускорители")}</span>
                <span className={cn('text-[10px] text-muted-foreground transition-transform', showAccelerators && 'rotate-180')}>▼</span>
              </button>
              {showAccelerators && (
              <SettingsCard
                icon={<SparklesIcon className="w-4 h-4" />}
                title={tt("Ускорение генерации")}
                description={tt("Sparse attention ускоряет длинные последовательности; на коротких сценах включается сама. Sol-Attn и Veda взаимоисключающие.")}
              >
                {/* (правка 168) Sparse Attention (Sol-Attn) */}
                <SettingsRow
                  label={tt("Разреженное внимание (Sol-Attn)")}
                  description={tt("Ускоряет длинные последовательности (~1.2–2.5×); короткие остаются плотными автоматически. На актуальном ядре работает через узел ядра BlockSparseAttention — строки текста, звука и референсов остаются в точном внимании, а генерируемый звук идёт плотно и не деградирует")}
                  right={
                    <SettingsToggle
                      checked={video.sparseAttention}
                      label={tt("Разреженное внимание (Sol-Attn)")}
                      onChange={(next) => {
                        patchVideo({ sparseAttention: next })
                        flushMirror()
                      }}
                    />
                  }
                />

                {video.sparseAttention && (
                  <div className="bg-[var(--surface-1)] px-3.5 py-3">
                    <div className="max-w-[440px] space-y-3 border-l-2 border-cyan-500/20 pl-3">
                      <SettingSlider
                        label={tt("Порог разреженности (tau)")}
                        labelTitle="Насколько смело пропускать часть вычислений внимания. Больше — быстрее, но картинка может стать грубее. Стандартно 1.3."
                        value={video.sparseTau}
                        onChange={(v) => patchVideo({ sparseTau: v })}
                        min={0}
                        max={4}
                        step={0.1}
                        inputMin={0}
                        inputMax={4}
                      />
                      <SettingSlider
                        label={tt("Включать с начала генерации")}
                        labelTitle="Первые шаги генерации задают композицию — их лучше считать точно. 20% — стандарт: первые пять шагов полные, дальше ускорение."
                        value={Math.round(video.sparseStartPercent * 100)}
                        onChange={(v) => patchVideo({ sparseStartPercent: v / 100 })}
                        min={0}
                        max={90}
                        step={5}
                        formatValue={(v) => `${Math.round(v)}%`}
                      />
                      <SettingSlider
                        label={tt("Работать до конца генерации")}
                        labelTitle="До какого момента применять ускорение. 100% — до последнего шага (быстрее всего). Если финал выглядит мыльным — уменьшите."
                        value={Math.round(video.sparseEndPercent * 100)}
                        onChange={(v) => patchVideo({ sparseEndPercent: v / 100 })}
                        min={10}
                        max={100}
                        step={5}
                        formatValue={(v) => `${Math.round(v)}%`}
                      />
                      <SettingSlider
                        label={tt("Минимальная длина видео (токены)")}
                        labelTitle="Короткие видео Sol-Attn не ускоряет — они всегда считаются точно. Уменьшите значение, чтобы ускорение включалось и на более коротких роликах."
                        value={video.sparseMinTokens}
                        onChange={(v) => patchVideo({ sparseMinTokens: Math.round(v) })}
                        min={1024}
                        max={65536}
                        step={1024}
                        inputMin={1024}
                        inputMax={131072}
                      />
                      <SettingSlider
                        label={tt("Дополнительный контекст (токены)")}
                        labelTitle="Запас токенов сверх основной длины — помогает не терять мелкие детали при ускорении. Стандартно 256."
                        value={video.sparseExtraTokens}
                        onChange={(v) => patchVideo({ sparseExtraTokens: Math.round(v) })}
                        min={0}
                        max={2048}
                        step={128}
                        inputMin={0}
                        inputMax={8192}
                      />
                    </div>
                  </div>
                )}

                {vedaSupported && (<>
                <SettingsRow
                  label="Veda Sparse Attention"
                  description={tt("Для длинных видео (10+ сек) / 8+ шагов; заменяет Sol-Attn")}
                  right={
                    <SettingsToggle
                      checked={video.vedaAttention}
                      onChange={(next) => patchVideo({ vedaAttention: next })}
                      label="Veda Sparse Attention"
                    />
                  }
                />
                {video.vedaAttention && (
                  <div className="bg-[var(--surface-1)] px-3.5 py-3">
                    <div className="max-w-[440px] space-y-3 border-l-2 border-cyan-500/20 pl-3">
                      <SettingSlider
                        label={tt("Спарсити генерации, %")}
                        value={(() => { const n = Number.parseFloat(video.vedaGeneratedSparsity); return Number.isFinite(n) ? n : 90 })()}
                        onChange={(v) => patchVideo({ vedaGeneratedSparsity: `${Math.round(v)}%` })}
                        min={50}
                        max={95}
                        step={5}
                      />
                      <p className="-mt-1.5 text-[11px] leading-snug text-muted-foreground">
                        {tt("Сколько key-тайлов пропускать в генерации. Выше % = быстрее, но грубее картинка.")}
                      </p>
                      <SettingSlider
                        label={tt("Спарсити референсов, %")}
                        value={(() => { const n = Number.parseFloat(video.vedaReferenceSparsity); return Number.isFinite(n) ? n : 90 })()}
                        onChange={(v) => patchVideo({ vedaReferenceSparsity: `${Math.round(v)}%` })}
                        min={0}
                        max={95}
                        step={5}
                      />
                      <p className="-mt-1.5 text-[11px] leading-snug text-muted-foreground">
                        {tt("То же для референсов. 0% = полное внимание к референсам — точнее лицо персонажа, но медленнее.")}
                      </p>
                      <div className="space-y-1">
                        <span className="text-xs text-muted-foreground">{tt("Слои с полным вниманием")}</span>
                        <input
                          type="text"
                          value={video.vedaFullAttentionLayers}
                          onChange={(e) => patchVideo({ vedaFullAttentionLayers: e.target.value })}
                          placeholder="0, 1, 47-49"
                          className={SETTINGS_INPUT_CLASS}
                        />
                        <p className="text-[11px] leading-snug text-muted-foreground">
                          {tt("0-based номера блоков DiT, которые всегда считаются плотно. Пусто = все слои sparse.")}
                        </p>
                      </div>
                      <div className="space-y-1">
                        <span className="text-xs text-muted-foreground">{tt("Шаги с полным вниманием")}</span>
                        <input
                          type="text"
                          value={video.vedaFullAttentionSteps}
                          onChange={(e) => patchVideo({ vedaFullAttentionSteps: e.target.value })}
                          placeholder="0, 1"
                          className={SETTINGS_INPUT_CLASS}
                        />
                        <p className="text-[11px] leading-snug text-muted-foreground">
                          {tt("0-based номера шагов сэмплера с полным вниманием. Пусто = все шаги sparse.")}
                        </p>
                      </div>
                      <label className="flex items-center justify-between gap-3">
                        <span className="text-xs text-muted-foreground">{tt("Подробный лог (verbose)")}</span>
                        <SettingsToggle
                          checked={video.vedaVerbose}
                          onChange={(next) => patchVideo({ vedaVerbose: next })}
                          label={tt("Подробный лог (verbose)")}
                        />
                      </label>
                    </div>
                  </div>
                )}
                </>)}
              </SettingsCard>
              )}
            </div>
          </div>
        )}

        {/* ─────────── Video output format (правка 386) ─────────── */}
        {tab === 'video' && (
          <div className="space-y-3">
            <SettingsCard
              icon={<FileVideoIcon className="w-4 h-4" />}
              title={tt("Кодек видео")}
              description={tt("Формат сохранения — для генерации, рефайна, продления и апскейлов")}
            >
              <div className="grid grid-cols-2 gap-2 px-3.5 py-3">
                {([
                  ['h264', 'H.264 (x264)', 'Максимальная совместимость — играет везде'],
                  ['h265', 'H.265 (x265)', 'Файл на 30–50% меньше, кодирование медленнее'],
                  ['nvenc_h264', 'NVENC H.264 (GPU)', 'Аппаратный энкодер NVIDIA — очень быстро'],
                  ['nvenc_h265', 'NVENC H.265 (GPU)', 'Быстро и компактно (битрейт вместо CRF)'],
                ] as const).map(([id, label, hint]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setVideoCodec(id)}
                    className={cn(
                      'rounded-lg border p-2.5 text-left transition-colors',
                      videoCodec === id
                        ? 'border-cyan-500/50 bg-cyan-500/10'
                        : 'border-border bg-[var(--surface-1)] hover:border-cyan-500/30',
                    )}
                  >
                    <p className={cn(
                      'text-xs font-medium',
                      videoCodec === id ? 'text-cyan-300' : 'text-foreground',
                    )}>{tt(label)}</p>
                    <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{tt(hint)}</p>
                  </button>
                ))}
              </div>
              <SettingsNote>
                {tt("NVENC использует отдельный блок видеокарты; если задачи начнут падать на сохранении — вернитесь на программный кодек.")}
              </SettingsNote>
            </SettingsCard>

            <SettingsCard
              icon={<SlidersHorizontalIcon className="w-4 h-4" />}
              title={videoCodec === 'h264' || videoCodec === 'h265' ? tt("Качество (CRF)") : tt("Качество (битрейт)")}
              description={
                videoCodec === 'h264' || videoCodec === 'h265'
                  ? tt("Меньше CRF — выше качество и больше файл")
                  : tt("Аппаратные энкодеры управляются битрейтом, а не CRF")
              }
            >
              <div className="px-3.5 py-3">
                {videoCodec === 'h264' || videoCodec === 'h265' ? (
                  <>
                    <SettingSlider
                      label={tt("CRF")}
                      value={videoCrf}
                      min={0}
                      max={30}
                      step={1}
                      onChange={(v) => setVideoCrf(Math.round(v))}
                      formatValue={(v) =>
                        v <= 14 ? tt("{{p1}} — максимум", { p1: v }) : v <= 19 ? tt("{{p1}} — высокое", { p1: v }) : v <= 25 ? tt("{{p1}} — стандарт", { p1: v }) : tt("{{p1}} — компакт", { p1: v })
                      }
                    />
                    <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
                      {tt("12 — прежний максимум студии (архивное качество). 17–19 — «высокое», глазом почти неотличимо. 23+ — компактные черновики. H.265 при том же CRF даёт заметно меньший файл, чем H.264.")}
                    </p>
                  </>
                ) : (
                  <>
                    <SettingSlider
                      label={tt("Битрейт NVENC")}
                      value={videoNvencBitrate}
                      min={4}
                      max={40}
                      step={1}
                      unit=" Мбит/с"
                      onChange={(v) => setVideoNvencBitrate(Math.round(v))}
                    />
                    <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
                      {tt("Для 1080p ориентир: 16 Мбит/с ≈ высокому качеству, 24+ — максимум, 8 — компактно.")}
                    </p>
                  </>
                )}
              </div>
            </SettingsCard>

            <SettingsNote className="rounded-lg border border-border/60 bg-[var(--surface-1)] px-3.5 py-2.5">
              {tt("Применяется ко всем НОВЫМ задачам: генерация (драфт/полное), рефайн «Целый» и «Частями», продление, Tile Upscale, FPS, обрезка и склейки. Уже созданные файлы не перекодируются. Настройка действует сразу — перезапуск не нужен.")}
            </SettingsNote>
          </div>
        )}

        {/* ─────────── Manual download links ─────────── */}
        {tab === 'links' && <ManualDownloadPanel />}

        {/* ─────────── О программе ─────────── */}
        {/* ─────────── О программе ─────────── */}
        {tab === 'about' && (
          <div className="space-y-3">
            {/* (правка 790) Обновление — выше остального, чтобы про него не «забыли» */}
            <SettingsCard
              icon={<RefreshCwIcon className="w-4 h-4" />}
              title={tt("Обновления")}
              description={tt("Проверка и установка новой версии студии")}
            >
              <UpdatePanel />
            </SettingsCard>

            <SettingsCard icon={<InfoIcon className="w-4 h-4" />} title={tt("О программе")}>
              <div className="flex items-center gap-3 px-3.5 py-3">
                <img src="/logo.svg" alt="" className="h-10 w-10 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">Minimax H3 Studio</div>
                  <AboutVersion />{/* (правка 791) версия с сервера, не хардкод */}
                </div>
              </div>
              {/* (правка 484) Текст автора — константа ABOUT_TEXT выше. */}
              <p className="whitespace-pre-line px-3.5 py-3 text-[11px] leading-relaxed text-muted-foreground">
                {tt(ABOUT_TEXT)}
              </p>
            </SettingsCard>

            {/* (правка 484) Ссылки автора */}
            <SettingsCard
              icon={<LinkIcon className="w-4 h-4" />}
              title={tt("Ссылки автора")}
              description={tt("Отзывы, обновления и поддержка проекта")}
            >
              {ABOUT_LINKS.map((l) => (
                <div key={l.url} className="flex items-baseline gap-2 px-3.5 py-2.5 text-xs">
                  <span className="w-[92px] shrink-0 text-muted-foreground">{tt(l.label)}</span>
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 flex-1 truncate text-cyan-400 underline decoration-cyan-500/30 underline-offset-2 hover:text-cyan-300"
                  >
                    {l.url}
                  </a>
                  {l.hint && <span className="shrink-0 text-[10px] text-muted-foreground/70">({tt(l.hint)})</span>}
                </div>
              ))}
            </SettingsCard>

            {/* (правка 484) Техническая информация */}
            <SettingsCard
              icon={<BoxIcon className="w-4 h-4" />}
              title={tt("Техническая информация")}
              description={tt("Из чего собрана студия")}
            >
              {ABOUT_TECH.map((t) => (
                <div key={t.label} className="flex items-baseline gap-3 px-3.5 py-2 text-xs">
                  <span className="w-[132px] shrink-0 text-muted-foreground">{tt(t.label)}</span>
                  <span className="min-w-0 flex-1 text-foreground/80">{tt(t.value)}</span>
                </div>
              ))}
            </SettingsCard>
          </div>
        )}

        {/* ─────────── Reset (Опасная зона) ─────────── */}
        {tab === 'reset' && (
          <SettingsCard
            tone="danger"
            icon={<AlertTriangleIcon className="w-4 h-4" />}
            title={tt("Опасная зона")}
            description={tt("Необратимые операции. Действуйте с осторожностью.")}
          >
            <SettingsRow
              label={tt("Сброс настроек")}
              description={tt("Все параметры (VRAM, LLM, выбор моделей, генерация, разрешение, шаги, формат сохранения, звук) вернутся к значениям по умолчанию.")}
              right={
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 border-amber-500/30 text-xs text-amber-400 hover:bg-amber-500/10"
                  onClick={() => setConfirmAction('reset')}
                >
                  <RotateCcwIcon className="w-3.5 h-3.5" />
                  {' '}{tt("Сбросить")}
                </Button>
              }
            />
            <SettingsRow
              label={tt("Очистить кэш")}
              description={tt("Удалит все файлы из папки input ComfyUI (референсы, кадры, временные загрузки).")}
              right={
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 border-amber-500/30 text-xs text-amber-400 hover:bg-amber-500/10"
                  onClick={() => setConfirmAction('clean')}
                >
                  <Trash2Icon className="w-3.5 h-3.5" />
                  {' '}{tt("Очистить")}
                </Button>
              }
            />
            <SettingsRow
              label={tt("Удалить контент")}
              description={tt("Удалит ВСЕ сгенерированные видео (папка output), историю чатов ассистента, историю промптов и ТЕКУЩИЙ промпт в поле генерации.")}
              right={
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 border-red-500/30 text-xs text-red-400 hover:bg-red-500/10"
                  onClick={() => setConfirmAction('delete')}
                >
                  <TrashIcon className="w-3.5 h-3.5" />
                  {' '}{tt("Удалить")}
                </Button>
              }
            />
            {/* (правка 130 + полный сброс) Полный сброс «как с завода» — отдельной
                строкой с красной подложкой, чтобы не нажать случайно. */}
            <div className="bg-red-500/[0.04] px-3.5 py-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-red-300">{tt("Полный сброс (всё)")}</p>
                  <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                    {tt("Удалит ВСЁ ваше: видео, кэш, файлы апскейла, вложения и историю чатов, промпты, журналы и локальные данные. Настройки, LoRA и config.ini вернутся к заводским. Для передачи программы другому человеку — после сброса не останется ничего вашего.")}
                  </p>
                </div>
                <Button
                  size="sm"
                  className="h-7 shrink-0 gap-1.5 bg-red-600 text-xs text-white hover:bg-red-500"
                  onClick={() => setConfirmAction('factory')}
                >
                  <SparklesIcon className="w-3.5 h-3.5" />
                  {' '}{tt("Сбросить всё")}
                </Button>
              </div>
            </div>
            <SettingsNote>{tt("Каждое действие требует подтверждения и необратимо.")}</SettingsNote>
          </SettingsCard>
        )}
              </div>
            </div>

            {/* (правка 1067) Нижняя панель разделов, которые не сохраняются
                автоматически: одна кнопка на всю вкладку вместо кнопки в конце
                длинного скролла (она уезжала за край экрана). */}
            {(tab === 'llm' || tab === 'optimization' || tab === 'video') && (
              <div className="flex shrink-0 items-center gap-3 border-t border-border px-5 py-3">
                <p className="flex-1 text-[11px] leading-snug text-muted-foreground">
                  {tab === 'llm'
                    ? tt("Устройство, контекст и своя модель применяются при следующем запуске модели.")
                    : tab === 'optimization'
                      ? tt("Память GPU применяется после перезапуска ComfyUI; экономия VRAM при генерации — сразу.")
                      : tt("Применяется ко всем новым задачам, без перезапуска.")}
                </p>
                <Button
                  size="sm"
                  className="h-8 min-w-[120px]"
                  disabled={saving}
                  onClick={() => void (tab === 'llm' ? saveLlm() : tab === 'optimization' ? saveOptimization() : saveVideoFormat())}
                >
                  {saving ? tt("Сохранение...") : tt("Сохранить")}
                </Button>
              </div>
            )}
          </div>
        </div>
      </DialogContent>

    </Dialog>

    {/* Confirmation dialog */}
    {confirmAction && CONFIRM[confirmAction] && (
      <Dialog open onOpenChange={(v) => { if (!v) setConfirmAction(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-400">
              <AlertTriangleIcon className="w-5 h-5" />
              {tt(CONFIRM[confirmAction].title)}
            </DialogTitle>
            <DialogDescription>
              {CONFIRM[confirmAction].desc}
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 justify-end mt-4">
            <Button variant="outline" size="sm" onClick={() => setConfirmAction(null)} disabled={executing}>
              {tt("Отмена")}
            </Button>
            <Button
              size="sm"
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => void executeAction(confirmAction)}
              disabled={executing}
            >
              {executing ? tt("Выполняется...") : CONFIRM[confirmAction].button}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    )}
    </>
  )
}

/* ─── (правка 257) Свои папки моделей — коллекции вне папки студии ─── */

/** (правка 922) Стабильный id строки списка. key строки НЕ должен зависеть от
 *  её пути: поле пути редактируется вручную, и key=`путь|категория` заставлял
 *  React пересоздавать <input> на каждом нажатии клавиши — фокус уходил в
 *  контейнер диалога (Radix FocusScope возвращает его обратно), а последующие
 *  нажатия в поле не работали, пока не кликнешь по нему заново. */
let extraEntryUid = 0
const nextExtraEntryUid = () => ++extraEntryUid

function ExtraModelPathsPanel() {
  const { t: tt } = useTranslation() // (правка 955)

  // (правка 262) exists — флаг наличия папки (сервер проверяет через statSync)
  const [entries, setEntries] = useState<Array<{ path: string; category: string; exists?: boolean; uid: number }>>([])
  const [newPath, setNewPath] = useState('')
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [savedOnce, setSavedOnce] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const canRestart = typeof window !== 'undefined' && !!window.h3desktop?.comfy?.restart

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((d) => {
        setEntries(
          (Array.isArray(d.model_extra_paths) ? d.model_extra_paths : []).map(
            (e: { path: string; category: string; exists?: boolean }) => ({ ...e, uid: nextExtraEntryUid() }),
          ),
        )
      })
      .catch(() => setEntries([]))
  }, [])

  /** (правка 1131) Любая правка списка (удаление, смена категории, путь)
   *  сохраняется сама через 0.9 с — чтобы «Сохранить папки» не была
   *  обязательным шагом, который легко пропустить. */
  useEffect(() => {
    if (!dirty) return
    const id = setTimeout(() => { void save() }, 900)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, dirty])

  /** Добавить папку: сервер раскладывает корень со стандартной структурой
   *  ComfyUI по категориям автоматически; плоской папке ставит выбранную
   *  категорию (или угаданную по имени). Путь — из нативного диалога
   *  (pathArg) или из поля ручного ввода. */
  const add = async (pathArg?: string) => {
    const p = (pathArg ?? newPath).trim()
    if (!p) return
    setAdding(true)
    try {
      const res = await fetch('/api/models/extra-paths', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      })
      const d = await res.json()
      if (!res.ok || d.error) {
        toast.error(d.error || 'Папка недоступна')
        return
      }
      const found: Array<{ path: string; category: string }> = d.entries || []
      const seen = new Set(entries.map((e) => `${e.path}|${e.category}`))
      const added = found
        .filter((e) => !seen.has(`${e.path}|${e.category}`))
        .map((e) => ({ ...e, uid: nextExtraEntryUid() }))
      const nextEntries = [...entries, ...added]
      setEntries(nextEntries)
      setNewPath('')
      setDirty(true)
      // (правка 1131) Сохраняем СРАЗУ после добавления: кнопка «Сохранить папки»
      // стояла внизу карточки и терялась (юзер выбирал папку, видел список
      // моделей, перезапускал — и всё пропадало). Теперь добавление = сохранение.
      void save(nextEntries)
      toast.success(
        found.length > 1
          ? tt("Добавлено категорий: {{p1}} (структура ComfyUI)", { p1: found.length })
          : tt("Папка добавлена"),
      )
    } catch {
      toast.error(tt("Не удалось проверить папку"))
    } finally {
      setAdding(false)
    }
  }

  const save = async (override?: Array<{ path: string; category: string }>) => {
    setSaving(true)
    try {
      const list = override ?? entries
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // (правка 262) Отправляем только path+category — exists не хранится
        body: JSON.stringify({
          model_extra_paths: list.map(({ path, category }) => ({ path, category })),
        }),
      })
      const d = await res.json()
      if (!res.ok || d.error) {
        toast.error(typeof d?.error === 'string' && d.error ? d.error : tt("Ошибка сохранения"))
        return
      }
      setDirty(false)
      setSavedOnce(true)
      if (d.restart_required) {
        toast.success(tt("Папки сохранены"), {
          description: tt("Перезапустите start.bat — ComfyUI подхватит внешние папки при старте."),
          duration: 10000,
        })
      } else {
        toast.success(tt("Папки сохранены"))
      }
    } catch {
      toast.error(tt("Ошибка сохранения"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="divide-y divide-border/50">
      {entries.length > 0 && (
        <div className="space-y-1.5 px-3.5 py-2.5">
          {entries.map((e, i) => (
            <div key={e.uid} className="flex items-center gap-1.5">
              {/* (правка 262) Индикатор: папка не существует на диске */}
              {e.exists === false && (
                <span
                  title={tt("Папка не найдена на диске — удалите или исправьте путь")}
                  className="shrink-0 rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400"
                >
                  {tt("нет")}
                </span>
              )}
              <input
                type="text"
                value={e.path}
                onChange={(ev) => {
                  const v = ev.target.value
                  setEntries((prev) => prev.map((x, j) => (j === i ? { ...x, path: v, exists: undefined } : x)))
                  setDirty(true)
                }}
                className={cn(
                  'h-7 min-w-0 flex-1 rounded-md border bg-[var(--surface-1)] px-2 font-mono text-[11px] text-foreground focus:outline-none focus:ring-1',
                  e.exists === false
                    ? 'border-red-500/40 focus:ring-red-500/50'
                    : 'border-border focus:ring-cyan-500/50',
                )}
              />
              <select
                value={e.category}
                onChange={(ev) => {
                  const v = ev.target.value
                  setEntries((prev) => prev.map((x, j) => (j === i ? { ...x, category: v } : x)))
                  setDirty(true)
                }}
                className="h-7 shrink-0 rounded-md border border-border bg-[var(--surface-1)] px-1.5 text-[11px] text-foreground focus:outline-none"
                title={tt("Категория (папка ComfyUI)")}
              >
                {EXTRA_CATEGORY_OPTIONS.map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  setEntries((prev) => prev.filter((_, j) => j !== i))
                  setDirty(true)
                }}
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-400"
                title={tt("Убрать папку")}
              >
                <Trash2Icon className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2 px-3.5 py-3">
        {/* Нативный выбор папки (тот же диалог, что у переноса моделей) */}
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-full max-w-[480px] justify-start gap-1.5 text-xs font-normal"
          disabled={adding}
          onClick={async () => {
            try {
              const res = await fetch('/api/dialog/folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: tt("Выберите папку с моделями") }),
              })
              const data = await res.json()
              if (!res.ok) {
                toast.error(data.error || 'Не удалось открыть диалог выбора папки.')
                return
              }
              if (data.path) void add(data.path as string)
            } catch {
              toast.error(tt("Не удалось открыть диалог выбора папки."))
            }
          }}
        >
          <FolderOpenIcon className="w-3.5 h-3.5 shrink-0" />
          {adding ? tt("Добавление…") : tt("Выбрать папку на диске…")}
        </Button>

        <div className="flex max-w-[520px] gap-1.5">
          <input
            type="text"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void add()
              }
            }}
            placeholder={tt("…или введите путь вручную: D:\\AI\\models")}
            className={cn(SETTINGS_INPUT_CLASS, 'flex-1')}
          />
          <Button variant="outline" size="sm" onClick={() => void add()} disabled={adding || !newPath.trim()} className="h-8 shrink-0 px-3 text-xs">
            {adding ? '…' : tt("Добавить")}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void save()} disabled={saving || !dirty} className="h-8 w-fit text-xs">
            {saving ? tt("Сохранение…") : tt("Сохранить папки")}
          </Button>
          {/* (правка 1131) Сохранение происходит само; кнопка перезапуска нужна,
              потому что ComfyUI читает extra_model_paths.yaml только на старте. */}
          {savedOnce && canRestart && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-fit text-xs"
              disabled={restarting}
              onClick={async () => {
                setRestarting(true)
                try {
                  const r = await window.h3desktop?.comfy?.restart?.()
                  if (r && r.ok === false) toast.error(r.error || tt("ComfyUI не перезапустился"))
                  else toast.success(tt("ComfyUI перезапускается"))
                } catch {
                  toast.error(tt("ComfyUI не перезапустился"))
                } finally {
                  setRestarting(false)
                }
              }}
            >
              {restarting ? tt("Перезапуск…") : tt("Перезапустить ComfyUI")}
            </Button>
          )}
        </div>
        {savedOnce && (
          <p className="text-[11px] leading-snug text-muted-foreground">
            {tt("Папки сохранены. Модели из них появятся после перезапуска ComfyUI.")}
          </p>
        )}
      </div>
    </div>
  )
}

const EXTRA_CATEGORY_OPTIONS: Array<[string, string]> = [
  ['diffusion_models', 'Модели видео'],
  ['loras', 'LoRA'],
  ['vae', 'VAE'],
  ['vae_approx', 'VAE Approx (TAE)'],
  ['veda', 'Veda Sparse Attention'],
  ['text_encoders', 'Энкодеры (CLIP)'],
  ['latent_upscale_models', 'Латентные апскейлеры'],
  ['upscale_models', 'Пиксельные апскейлеры'],
  // (правка 1127) модели ассистента (.gguf) из своей папки
  ['llm', 'Модели ассистента (LLM)'],
]

/* ─── Manual download links (all models: URLs + target paths) ─── */

function ManualDownloadPanel() {
  const { t: tt } = useTranslation() // (правка 955)

  const [comfyCore, setComfyCore] = useState('')
  const [bonsaiDir, setBonsaiDir] = useState('')

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((d) => {
        // (правка 905) папки моделей/ввода-вывода живут в каталоге ядра
        // ComfyUI (comfy_core), а не в корне бэкенда.
        setComfyCore(d.comfy_core || d.comfy_dir || '')
        setBonsaiDir(d.llm_bonsai_dir || '')
      })
      .catch(() => {
        setComfyCore('')
        setBonsaiDir('')
      })
  }, [])

  const comfyModelsRoot = comfyCore ? `${comfyCore}\\models\\` : '<ComfyUI>\\models\\'
  const bonsaiModelsRoot = bonsaiDir ? `${bonsaiDir}\\` : '<Bonsai_2_27B>\\'

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(tt("{{p1}} скопирован", { p1: tt(what) }))
    } catch {
      toast.error(tt("Не удалось скопировать"))
    }
  }

  return (
    <div className="space-y-3">
      <SettingsCard
        icon={<FolderOpenIcon className="w-4 h-4" />}
        title={tt("Папки моделей")}
        description={tt("Куда класть файлы, скачанные вручную")}
      >
        <div className="space-y-2 px-3.5 py-3">
          <div className="flex items-center gap-2 rounded-md border border-border bg-[var(--surface-1)] px-2.5 py-2">
            <FolderOpenIcon className="w-3.5 h-3.5 shrink-0 text-amber-400" />
            <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-foreground/80">
              ComfyUI: {comfyModelsRoot}
            </code>
            <button
              type="button"
              onClick={() => void copy(comfyModelsRoot, 'Путь')}
              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-[var(--surface-3)] hover:text-foreground"
              title={tt("Скопировать путь")}
            >
              <CopyIcon className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-2 rounded-md border border-border bg-[var(--surface-1)] px-2.5 py-2">
            <FolderOpenIcon className="w-3.5 h-3.5 shrink-0 text-violet-400" />
            <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-foreground/80">
              Bonsai: {bonsaiModelsRoot}
            </code>
            <button
              type="button"
              onClick={() => void copy(bonsaiModelsRoot, 'Путь')}
              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-[var(--surface-3)] hover:text-foreground"
              title={tt("Скопировать путь")}
            >
              <CopyIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        icon={<LinkIcon className="w-4 h-4" />}
        title={tt("Ссылки на модели")}
        description={tt("Скачайте файл по ссылке и положите по указанному пути — приложение подхватит его автоматически")}
      >
        {MODEL_CATEGORIES.map(({ key, label }) => {
          const models = MODELS.filter((m) => m.category === key)
          if (!models.length) return null
          return (
            <div key={key}>
              <div className="px-3.5 pb-1 pt-2.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                {tt(label)}
              </div>
              <div className="divide-y divide-border/40">
                {models.map((m) => {
                  const isBonsai = m.target === 'bonsai'
                  // (правка 905) модели кастомных нод (VFI, controlnet_aux) лежат
                  // в своей папке baseDir внутри ядра ComfyUI, а не в models/.
                  const customRoot = m.target === 'custom' && m.baseDir && comfyCore
                    ? `${comfyCore}\\${m.baseDir.replace(/\//g, '\\')}\\`
                    : ''
                  const fullRoot = isBonsai ? bonsaiModelsRoot : (customRoot || comfyModelsRoot)
                  const fullPath = fullRoot + m.relPath
                  // (правка 769) если по ссылке скачается файл с ДРУГИМ именем, чем
                  // ждёт приложение — подсказать юзеру переименовать (автозагрузка
                  // переименовывает сама, ручной способ — нет).
                  const renameHint = getManualRenameHint(m)
                  return (
                    <div key={m.id} className="space-y-1 px-3.5 py-2">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-xs text-foreground/90" title={tt(m.label)}>
                          {tt(m.label)}
                        </span>
                        <Badge variant="secondary" className="shrink-0 text-[10px]">{tt(m.sizeLabel)}</Badge>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <code className="min-w-0 flex-1 truncate font-mono text-[10px] text-cyan-300/80" title={fullPath}>
                          {fullPath}
                        </code>
                        <button
                          type="button"
                          onClick={() => void copy(fullPath, 'Путь')}
                          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-[var(--surface-3)] hover:text-foreground"
                          title={tt("Скопировать полный путь")}
                        >
                          <CopyIcon className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <a
                          href={m.url}
                          target="_blank"
                          rel="noreferrer"
                          className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-cyan-300"
                          title={m.url}
                        >
                          {m.url.replace('?download=true', '')}
                        </a>
                        <button
                          type="button"
                          onClick={() => void copy(m.url, 'URL')}
                          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-[var(--surface-3)] hover:text-foreground"
                          title={tt("Скопировать ссылку")}
                        >
                          <CopyIcon className="w-3 h-3" />
                        </button>
                      </div>
                      {/* (правка 769) имена в URL и в пути различаются — подсказка */}
                      {renameHint && (
                        <div className="flex items-center gap-1.5">
                          <span
                            className="min-w-0 flex-1 text-[10px] leading-snug text-amber-300/90"
                            title={tt("Скачанный по ссылке файл нужно переименовать, иначе приложение его не увидит")}
                          >
                            {tt("⚠ по ссылке скачается «")}{renameHint.downloaded}{tt("» — переименуйте файл в «")}{renameHint.expected}»
                          </span>
                          <button
                            type="button"
                            onClick={() => void copy(renameHint.expected, 'Имя файла')}
                            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-[var(--surface-3)] hover:text-foreground"
                            title={tt("Скопировать нужное имя файла")}
                          >
                            <CopyIcon className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </SettingsCard>

      <SettingsNote className="rounded-lg border border-border/60 bg-[var(--surface-1)] px-3.5 py-2.5">
        {tt("Если скачивание из приложения не работает (например, huggingface.co недоступен) — скачайте файлы вручную по этим ссылкам. Имя файла должно совпасть точно (браузер иногда дописывает «(1)» — переименуйте). Если huggingface.co не открывается — замените в ссылке домен на")}{' '}
        <code className="text-cyan-300/80">hf-mirror.com</code>
        {tt(". После скачивания проверьте размер файла (см. бейдж) — меньший размер означает обрыв загрузки.")}
      </SettingsNote>
    </div>
  )
}

/* ─── Theme Switcher ─── */

/** (правка 111) `first` — первый блок вкладки «Внешний вид»: без верхней границы. */
function ThemeSwitcher() {
  const { t: tt } = useTranslation() // (правка 955)

  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  if (!mounted) return <div className="h-8" />

  return (
    /* (правка 98) Светлая тема удалена — только тёмные.
       (правка 441) + тема «Студия» (dark-calm, Calm Studio). */
    <SettingsChoice<'dark-gray' | 'dark' | 'dark-calm'>
      value={theme === 'dark' || theme === 'dark-calm' ? theme : 'dark-gray'}
      onChange={(v) => {
        setTheme(v)
        pushPrefs() // (правка 804)
      }}
      options={[
        {
          value: 'dark-gray',
          label: <span className="inline-flex items-center gap-1.5"><MoonIcon className="w-3.5 h-3.5" />{tt("Серая")}</span>,
        },
        {
          value: 'dark',
          label: <span className="inline-flex items-center gap-1.5"><MoonIcon className="w-3.5 h-3.5" />{tt("Чёрная")}</span>,
        },
        {
          value: 'dark-calm',
          label: <span className="inline-flex items-center gap-1.5"><SparklesIcon className="w-3.5 h-3.5" />{tt("Студия")}</span>,
        },
      ]}
    />
  )
}

/**
 * (правка 445) Масштаб интерфейса (пользователь ставил 90% в браузере и
 * просил то же из настроек). Значение — в localStorage ('h3-ui-scale'),
 * применяется мгновенно; на старте приложения подхватывается инлайн-скриптом
 * в layout.tsx (без вспышки немасштабированного UI). Механизм — см. 451 ниже.
 */
const UI_SCALE_PRESETS = [80, 90, 100, 110, 125] as const

/**
 * (правка 1003) Масштабируем весь интерфейс нативным Chromium zoom
 * (`webFrame.setZoomFactor`): панели с px-ширинами, кнопки, отступы и текст.
 * Старый вариант через root font-size менял только rem-шрифт, поэтому
 * панели оставались прежнего размера. Браузерный fallback — в ui-scale.ts.
 */

function UiScaleSwitcher() {
  // (правка 579) дефолт масштаба UI — 80%
  const [scale, setScale] = useState(UI_SCALE_DEFAULT)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    try {
      const s = parseInt(localStorage.getItem(UI_SCALE_KEY) || String(UI_SCALE_DEFAULT), 10)
      if (!Number.isNaN(s)) setScale(s)
    } catch { /* приватный режим */ }
  }, [])

  const apply = (pct: number) => {
    setScale(pct)
    try {
      localStorage.setItem(UI_SCALE_KEY, String(pct))
      applyUiScale(pct)
      pushPrefs() // (правка 804) дублируем prefs на сервер
    } catch { /* ignore */ }
  }

  if (!mounted) return <div className="h-8" />

  return (
    <div className="grid grid-cols-5 gap-1.5">
      {UI_SCALE_PRESETS.map((pct) => (
        <button
          key={pct}
          type="button"
          onClick={() => apply(pct)}
          className={cn(
            'h-8 rounded-md border text-xs font-medium tabular-nums transition-colors',
            scale === pct
              ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-300'
              : 'border-border bg-[var(--surface-1)] text-muted-foreground hover:border-cyan-500/30 hover:text-foreground',
          )}
        >
          {pct}%
        </button>
      ))}
    </div>
  )
}

/**
 * (правка 739) «Выделение текста в интерфейсе» (Настройки → Внешний вид).
 * По умолчанию выделение заблокировано (globals.css, правка 564); включённый
 * свитч ставит атрибут data-select-text на <html> — правило в globals.css
 * разрешает выделение глобально. Чисто клиентская настройка окна, поэтому
 * localStorage ('h3-selectable-text'), как масштаб UI; на старте её
 * подхватывает инлайн-скрипт в layout.tsx (без вспышки и рассинхрона).
 */
const SELECT_TEXT_KEY = 'h3-selectable-text'

function applySelectText(on: boolean) {
  const d = document.documentElement
  if (on) d.setAttribute('data-select-text', '1')
  else d.removeAttribute('data-select-text')
}

function SelectTextSwitcher() {
  const { t: tt } = useTranslation() // (правка 955)

  const [on, setOn] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    try {
      setOn(localStorage.getItem(SELECT_TEXT_KEY) === '1')
    } catch { /* приватный режим */ }
  }, [])

  const toggle = () => {
    const next = !on
    setOn(next)
    try {
      localStorage.setItem(SELECT_TEXT_KEY, next ? '1' : '0')
      pushPrefs() // (правка 804) дублируем prefs на сервер
    } catch { /* ignore */ }
    applySelectText(next)
  }

  if (!mounted) return <div className="h-8" />

  return (
    <SettingsRow
      label={tt("Выделение текста в интерфейсе")}
      description={tt("Разрешить выделять и копировать текст в UI (по умолчанию заблокировано)")}
      right={
        <SettingsToggle
          checked={on}
          onChange={toggle}
          label={tt("Выделение текста в интерфейсе")}
        />
      }
    />
  )
}
