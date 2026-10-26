'use client'

/**
 * Settings Dialog — tabbed settings:
 *   • Общие        — ComfyUI-статус, модели
 *   • Внешний вид  — тема оформления, звук при завершении (правка 111)
 *   • LLM          — устройство, контекст, макс. длина ответа
 *   • Оптимизация  — VRAM-резерв, Dynamic VRAM
 *   • ComfyUI      — версия, Python, GPU, VRAM-разбивка
 */
import { useState, useEffect, useCallback } from 'react'
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
  SunIcon,
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
  ZoomInIcon,
  FileVideoIcon,
  InfoIcon,
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
import { MODELS, MODEL_CATEGORIES } from '@/lib/models-config'
import { useGenStore, DEFAULT_VIDEO_STATE } from '@/lib/gen-store'
import { usePromptHistory } from '@/lib/prompt-history-store'
import { useGenDurations } from '@/lib/gen-duration-store'
import { useAssistantChats } from '@/lib/assistant-chats-store'
import { useGalleryRefresh } from '@/lib/gallery-refresh-store'
// (правка 557) сброс очереди/джоб-сторов при «заводском сбросе»
import { useGenQueue } from '@/lib/gen-queue-store'
import { useTileUpscaleJob } from '@/lib/tile-upscale-job-store'
import { useControlNetJob } from '@/lib/controlnet-job-store'
import { useFpsJob } from '@/lib/fps-job-store'
import { SettingSlider } from './setting-slider'
import { Label } from '@/components/ui/label'

/* ─── Types ─── */

type TabId = 'general' | 'appearance' | 'llm' | 'voice' | 'optimization' | 'video' | 'links' | 'about' | 'reset'

const TABS: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
  { id: 'general', label: 'Общие', icon: <BoxIcon className="w-4 h-4" /> },
  // (правка 111) Внешний вид: тема оформления и звук — вынесено из «Общих»
  { id: 'appearance', label: 'Внешний вид', icon: <PaletteIcon className="w-4 h-4" /> },
  { id: 'llm', label: 'LLM', icon: <BotIcon className="w-4 h-4" /> },
  // (правка 65) Голосовой ввод (whisper STT, CPU)
  { id: 'voice', label: 'Голос', icon: <MicIcon className="w-4 h-4" /> },
  { id: 'optimization', label: 'Оптимизация', icon: <SlidersHorizontalIcon className="w-4 h-4" /> },
  // (правка 386) Формат сохранения видео: кодек + качество, на все режимы
  { id: 'video', label: 'Формат', icon: <FileVideoIcon className="w-4 h-4" /> },
  { id: 'links', label: 'Ссылки', icon: <LinkIcon className="w-4 h-4" /> },
  // Информация о программе (текст предоставляет пользователь)
  { id: 'about', label: 'О программе', icon: <InfoIcon className="w-4 h-4" /> },
  { id: 'reset', label: 'Сброс', icon: <AlertTriangleIcon className="w-4 h-4" /> },
]

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
  const [tab, setTab] = useState<TabId>('general')
  const [loading, setLoading] = useState(false)
  const [connected, setConnected] = useState<boolean | null>(null)
  const [reserveVram, setReserveVram] = useState(3)
  const [dynamicVram, setDynamicVram] = useState(true)
  // (правка 490) Доп. запас свободной VRAM (--vram-headroom), 0 = выкл
  const [vramHeadroom, setVramHeadroom] = useState(2)
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
  // (правка 386) формат сохранения видео ([video] в config.ini)
  const [videoCodec, setVideoCodec] = useState<'h264' | 'h265' | 'nvenc_h264' | 'nvenc_h265'>('h264')
  const [videoCrf, setVideoCrf] = useState(12)
  const [videoNvencBitrate, setVideoNvencBitrate] = useState(16)

  /* VRAM-оптимизации генерации (Low VRAM / Chunk FF) — живут в том же
     zustand-сторе, что и раньше в «Доп. параметрах»; генерация читает их оттуда. */
  const video = useGenStore((s) => s.video)
  const patchVideo = useGenStore((s) => s.patchVideo)

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
          setReserveVram(typeof d.reserve_gb === 'number' ? d.reserve_gb : 3)
          setDynamicVram(d.dynamic_vram !== false)
          setVramHeadroom(typeof d.vram_headroom === 'number' ? d.vram_headroom : 2) // (правка 490)
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
          // (правка 386)
          if (['h264', 'h265', 'nvenc_h264', 'nvenc_h265'].includes(d.video_codec)) setVideoCodec(d.video_codec)
          if (typeof d.video_crf === 'number') setVideoCrf(d.video_crf)
          if (typeof d.video_nvenc_bitrate === 'number') setVideoNvencBitrate(d.video_nvenc_bitrate)
        })
        .catch(() => {
          setReserveVram(3); setDynamicVram(true); setVramHeadroom(0); setLlmDevice('auto')
          setLlmCtxSize(25600); setLlmMaxOut(4096); setLlmVideoVision(false)
          setLlmKvCache('q4_0')
        })
    }
  }, [open, checkConnection])

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
        toast.success('Настройки LLM сохранены', {
          // (правка 54) точнее: устройство/контекст — при следующем запуске
          // модели, видение видео и макс. длина — сразу (per-request).
          description: 'Устройство/контекст/своя модель — при следующем запуске модели; остальное — сразу.',
        })
      } else {
        toast.error(await saveErrorText(res))
      }
    } catch {
      toast.error('Ошибка сохранения')
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
        }),
      })
      if (res.ok) {
        toast.success('Оптимизация сохранена', {
          description: 'Применится при перезапуске ComfyUI.',
        })
      } else {
        toast.error(await saveErrorText(res))
      }
    } catch {
      toast.error('Ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }, [reserveVram, dynamicVram, vramHeadroom]) // (правка 490) + vramHeadroom

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
        toast.success('Формат сохранения сохранён', {
          description: 'Применится ко всем НОВЫМ задачам всех режимов (генерация, рефайн, продление, апскейлы, обрезка).',
        })
      } else {
        toast.error(await saveErrorText(res))
      }
    } catch {
      toast.error('Ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }, [videoCodec, videoCrf, videoNvencBitrate])

  /* ── Опасная зона: конфиг для подтверждения ── */
  const CONFIRM: Record<string, { title: string; desc: string; button: string }> = {
    reset: {
      title: 'Сбросить настройки?',
      // (правка 54) текст соответствует фактическому поведению: сбрасываются
      // ВСЕ параметры, включая выбор моделей (LLM-квант, базовая модель),
      // видение видео и звук.
      desc: 'Все параметры (VRAM, LLM, выбор моделей, генерация, разрешение, шаги, звук) вернутся к значениям по умолчанию. Действие необратимо.',
      button: 'Сбросить',
    },
    clean: {
      title: 'Очистить кэш?',
      desc: 'Будут удалены ВСЕ файлы из папки input ComfyUI (референсы, кадры, загрузки). Действие необратимо.',
      button: 'Очистить',
    },
    delete: {
      title: 'Удалить весь контент?',
      desc: 'Будут удалены ВСЕ сгенерированные видео, история чатов с ассистентом, история промптов и текущий промпт. Действие необратимо.',
      button: 'Удалить',
    },
    factory: {
      title: 'Полный сброс?',
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

        // 2) Серверный полный сброс.
        const res = await fetch('/api/reset/full', { method: 'POST' })
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

        if (failed) {
          toast.error('Полный сброс выполнен частично', {
            description: `Не удалось: ${reason}. Проверьте, запущена ли программа, и повторите.`,
          })
          return
        }

        // 5) Перезагрузка: гарантирует, что ни один стор не остался в памяти
        //    со старыми данными.
        toast.success('Полный сброс выполнен. Программа перезапускается...')
        window.setTimeout(() => window.location.reload(), 1200)
        return
      }

      if (action === 'reset') {
        await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reserve_gb: 3,
            dynamic_vram: true,
            vram_headroom: 2, // (правка 490) заводской запас VRAM
            llm_device: 'auto',
            llm_context_size: 25600,       // (правка 119) дефолт контекста — 25K
            llm_max_output_tokens: 4096,
            // (правка 54) ранее эти параметры сброс НЕ трогал — теперь сбрасываем всё:
            llm_video_vision: true, // видение видео (правка 53) → включено (digest + кэш)
            llm_kv_cache: 'q4_0',    // квантизация KV-кэша (правки 109/119) → q4_0
            // (правка 140) сэмплинг — всегда модель-осознанные значения
            llm_sampling_override: false,
            sound_on: true,          // звук → вкл
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
          }),
        })
        useGenStore.setState({ video: { ...DEFAULT_VIDEO_STATE } })
        useGenDurations.getState().clear()
        // (правка 435) Ассистент после сброса — в режиме «Генерация»
        // (дефолт), а не в последнем выбранном режиме «Продление».
        useAssistantChats.getState().setAssistantMode('generate')
        setReserveVram(3)
        setDynamicVram(true)
        setVramHeadroom(0) // (правка 490)
        setLlmDevice('auto')
        setLlmCtxSize(25600)
        setLlmMaxOut(4096)
        setLlmVideoVision(false)
        setLlmKvCache('q4_0')
        setSoundOn(true)
        setLlmCustomModel('')   // (правка 311)
        setLlmCustomMmproj('')  // (правка 311)
        setResetTick((t) => t + 1) // (правка 54) селекторы моделей перечитают конфиг
        // Выгружаем загруженную LLM: иначе после сброса она продолжала бы
        // отвечать со старой моделью/конфигом (чат-роут уже читает новые) —
        // «глючные» первые ответы. Страховка — сигнатура в ensureLlm.
        void fetch('/api/llm/stop', { method: 'POST' }).catch(() => {})
        toast.success('Настройки сброшены к значениям по умолчанию')
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
          toast.success(`Кэш очищен (удалено: ${data.deleted})`)
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
          toast.success(`Контент удалён (удалено: ${data.deleted})`)
        } else {
          toast.error(data.error || 'Ошибка удаления контента')
        }
      }
    } catch (err) {
      console.error('Action failed:', err)
      toast.error('Произошла ошибка при выполнении действия')
    } finally {
      setExecuting(false)
      setConfirmAction(null)
    }
  }, [])

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* FIXED size (never resizes between tabs) + internal scroll area —
          nothing sticks out past the side edges. */}
      <DialogContent className="w-[950px] max-w-[96vw] sm:max-w-[950px] h-[920px] max-h-[96vh] flex flex-col overflow-hidden gap-0 p-0">
        <DialogHeader className="px-6 pt-5 pb-2 shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <ServerIcon className="w-5 h-5" />
            Настройки
          </DialogTitle>
          <DialogDescription>
            Подключение, модели, LLM, память GPU, ComfyUI и ссылки для ручной загрузки
          </DialogDescription>
        </DialogHeader>

        {/* Tab bar */}
        <div className="px-6 shrink-0">
          {/* (правка 566→571) Все девять вкладок — ОДНОЙ строкой, ЗАПОЛНЯЯ её
              целиком: компактные паддинги/шрифт (суммарно ~790px минимальной
              ширины < ~890px доступных) + flex-1 — кнопки делят строку поровну,
              пустого хвоста после «Сброса» нет. Если контент перестанет
              влезать (узкое окно/новая вкладка) — min-width:auto удержит
              читаемость, сработает overflow-x-auto. */}
          <div className="flex items-center gap-0.5 p-1 rounded-lg bg-[var(--surface-2)]/60 border border-border mb-2 overflow-x-auto">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  // (правка 120) whitespace-nowrap: «Внешний вид» — двухсловное имя,
                  // без запрета переноса лезло в две строки (у остальных слов переноса нет)
                  'flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap',
                  tab === t.id
                    ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                    : 'text-muted-foreground border border-transparent hover:text-foreground',
                )}
              >
                <span className="shrink-0 [&_svg]:w-3.5 [&_svg]:h-3.5">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Scrollable tab content — the ONLY scrolling region */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-6 pb-5">
        {/* ─────────── General ─────────── */}
        {tab === 'general' && (
          <div className="space-y-4 py-2">
            {/* Connection status */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">ComfyUI:</span>
              {loading ? (
                <Badge variant="secondary" className="gap-1">
                  <Loader2Icon className="w-3 h-3 animate-spin" />
                  Проверка...
                </Badge>
              ) : connected ? (
                <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 gap-1">
                  <CheckCircleIcon className="w-3 h-3" />
                  Подключено
                </Badge>
              ) : (
                <Badge variant="destructive" className="gap-1">
                  <AlertCircleIcon className="w-3 h-3" />
                  Недоступно
                </Badge>
              )}
            </div>
            {!connected && (
              <p className="text-xs text-muted-foreground">
                Убедитесь, что ComfyUI запущен на порту 8188.
              </p>
            )}

            {/* Model Migration (правка 47) — на самом верху */}
            <ModelMigrationPanel />

            {/* Models */}
            <div className="space-y-2 pt-2 border-t border-border">
              <ModelsPanel />
            </div>

            {/* (правка 257) Свои папки моделей — коллекции вне папки студии
                (перенесено из удалённой вкладки «ComfyUI»);
                (правка 321) key — перечитывание после сброса, как у селекторов
                моделей (читает /api/config только при монтировании) */}
            <ExtraModelPathsPanel key={`emp-${resetTick}`} />

            {/* Diffusion Model (правка 45); key — перечитывание после сброса (правка 54) */}
            <DiffusionModelSelector key={`dm-${resetTick}`} />

            {/* Custom LoRAs (правка 44; правка 95 — турбо-лора в общем списке) */}
            <LoraSettingsPanel />

            {/* (правка 111) Тема и звук вынесены во вкладку «Внешний вид» */}

            {/* (правка 116) Окно приветствия — вернуть, если галочка «Больше не показывать»
             * случайно попала под палец: сбрасываем флаг в localStorage браузера
             * (h3_welcome_seen_v1) и шлём событие h3:show-welcome — Home подхватывает
             * и открывает WelcomeDialog. Настройки при этом закрываем, чтобы окно
             * показывалось поверх приложения (у шаден-диалога outside-click закрыл бы
             * его при клике по чужому оверлею). */}
            <div className="space-y-2 pt-2 border-t border-border">
              <div>
                <span className="text-xs text-muted-foreground">Приветствие при запуске</span>
                <p className="text-[10px] text-muted-foreground/60">
                  Всплывающее окно с краткой инструкцией. Если поставили галочку
                  «Больше не показывать» — верните его этой кнопкой.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => {
                  try {
                    localStorage.removeItem('h3_welcome_seen_v1')
                  } catch { /* ignore */ }
                  window.dispatchEvent(new CustomEvent('h3:show-welcome'))
                  onOpenChange(false)
                }}
              >
                <SparklesIcon className="w-3.5 h-3.5" />
                Показать окно приветствия
              </Button>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={checkConnection}
              disabled={loading}
              className="w-full"
            >
              <RefreshCwIcon className={loading ? 'animate-spin' : ''} />
              Перепроверить
            </Button>


          </div>
        )}

        {/* ─────────── Appearance (правка 111) ─────────── */}
        {tab === 'appearance' && (
          <div className="space-y-4 py-2">
            {/* (правка 111) Тема оформления — вынесено из «Общих» */}
            <ThemeSwitcher first />

            {/* (правка 445) Масштаб интерфейса (как zoom в браузере) */}
            <UiScaleSwitcher />

            {/* (правка 111) Звук при завершении — вынесено из «Общих» */}
            <div className="flex items-center justify-between pt-2 border-t border-border">
              <div>
                <span className="text-xs text-muted-foreground">Звук при завершении</span>
                <p className="text-[10px] text-muted-foreground/60">
                  Короткий сигнал при окончании генерации
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={soundOn}
                onClick={async () => {
                  const newVal = !soundOn
                  setSoundOn(newVal)
                  try {
                    await fetch('/api/config', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ sound_on: newVal }),
                    })
                  } catch { /* ignore */ }
                }}
                className={cn(
                  'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors',
                  soundOn ? 'bg-cyan-600' : 'bg-muted-foreground/30',
                )}
              >
                <span
                  className={cn(
                    'pointer-events-none block h-4 w-4 rounded-full bg-white shadow-lg transition-transform',
                  soundOn ? 'translate-x-4' : 'translate-x-0.5',
                  )}
                />
              </button>
            </div>
          </div>
        )}

        {/* ─────────── LLM ─────────── */}
        {tab === 'llm' && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <BotIcon className="w-4 h-4 text-cyan-400" />
              LLM-ассистент
            </div>
            <p className="text-xs text-muted-foreground/70 -mt-2">
              Устройство и параметры контекста модели чата (Gemma 4 12B / Qwen3.5 9B).
            </p>

            <div className="space-y-1.5 pt-2 border-t border-border">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs text-muted-foreground">Устройство</span>
                  <p className="text-[10px] text-muted-foreground/60">
                    Где считается модель чата
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--surface-2)]/60 border border-border">
                {([
                  ['auto', 'Авто', 'GPU при свободной VRAM, иначе CPU'],
                  ['gpu', 'GPU', 'Быстро (~40+ ток/с), делит VRAM с генерацией'],
                  ['cpu', 'CPU', 'Медленнее, но не трогает VRAM'],
                ] as const).map(([id, label, title]) => (
                  <button
                    key={id}
                    type="button"
                    title={title}
                    onClick={() => setLlmDevice(id)}
                    className={cn(
                      'flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition-colors',
                      llmDevice === id
                        ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                        : 'text-muted-foreground border border-transparent hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5 pt-2 border-t border-border">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Контекст LLM</span>
                <span className="text-xs font-mono text-cyan-300">
                  {(llmCtxSize / 1024).toFixed(llmCtxSize % 1024 === 0 ? 0 : 1)}K токенов
                </span>
              </div>
              <input
                type="range"
                min={8192}
                max={102400}
                step={1024}
                value={llmCtxSize}
                onChange={(e) => setLlmCtxSize(parseInt(e.target.value, 10))}
                className="w-full h-2 cursor-pointer accent-cyan-400"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground/50">
                <span>8K</span><span>100K</span>
              </div>
            </div>

            {/* (правка 109) Квантизация KV-кэша: экономит VRAM/RAM, качество чуть ниже */}
            <div className="space-y-1.5 pt-2 border-t border-border">
              <span className="text-xs text-muted-foreground">Квантизация KV-кэша</span>
              <p className="text-[10px] text-muted-foreground/60">
                Сжимает кэш контекста модели чата (меньше памяти при том же контексте).
                По умолчанию q4_0 — максимум экономии (правка 119); q8_0 — почти без потери качества; off — без сжатия.
              </p>
              <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--surface-2)]/60 border border-border">
                {([
                  ['off', 'Выкл (fp16)', 'Как раньше: полная точность, больше памяти'],
                  ['q8_0', 'Q8', 'Рекомендуется: почти без потери качества'],
                  ['q5_1', 'Q5', 'Умеренная экономия памяти'],
                  ['q4_0', 'Q4', 'Максимальная экономия памяти'],
                ] as const).map(([id, label, title]) => (
                  <button
                    key={id}
                    type="button"
                    title={title}
                    onClick={() => setLlmKvCache(id)}
                    className={cn(
                      'flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition-colors',
                      llmKvCache === id
                        ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                        : 'text-muted-foreground border border-transparent hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* (правка 53) Видение видео ассистентом — по умолчанию ВКЛ */}
            <div className="space-y-1.5 pt-2 border-t border-border">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <span className="text-xs text-muted-foreground">Видение видео ассистентом</span>
                  <p className="text-[10px] text-muted-foreground/60">
                    Вкл: ассистент получает сжатый digest видео-рефов (кэшируется по
                    содержимому файла). Выкл: знает только о наличии видео и не
                    выдумывает его содержимое.
                  </p>
                </div>
                <button
                  type="button"
                  title={llmVideoVision ? 'Выключить видение видео' : 'Включить видение видео'}
                  onClick={() => setLlmVideoVision(!llmVideoVision)}
                  className={cn(
                    'relative w-10 h-5.5 rounded-full transition-colors shrink-0',
                    llmVideoVision ? 'bg-cyan-500/70' : 'bg-[var(--surface-4)]',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform',
                      llmVideoVision && 'translate-x-[18px]',
                    )}
                  />
                </button>
              </div>
            </div>

            {/* LLM Model Selector (правка 48); key — перечитывание после сброса
                (правка 54) и после сохранения своей модели (правка 467) */}
            <LlmModelSelector key={`llm-${resetTick}-${llmSelTick}`} />

            {/* (правка 257) Своя модель ассистента: абсолютный путь к .gguf.
                Непустой путь перекрывает выбор модели выше (баннер про
                модели ассистента при этом гаснет). mmproj — опционально,
                для зрения; без него ассистент работает только текстом. */}
            <div className="space-y-1.5 pt-2 border-t border-border">
              <span className="text-xs text-muted-foreground">Своя модель (GGUF)</span>
              <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                {/* (правка 308) Сервер принимает и папку, и файл: папка
                    резолвится в первый .gguf внутри неё при сохранении. */}
                Папка с .gguf-моделью или путь к самому файлу — ассистент
                запустится с ней (движок студии, без скачивания и копирования).
                Пусто = модель из списка выше. Пример: <span className="font-mono">D:\models</span>
              </p>
              {/* (правка 278) Кнопка «Выбрать папку» — нативный диалог
                  (тот же, что у «Свои папки моделей»); ручной ввод остаётся
                  как фолбэк. */}
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start font-normal"
                onClick={async () => {
                  try {
                    const res = await fetch('/api/dialog/folder', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ title: 'Выберите папку с моделью .gguf' }),
                    })
                    const data = await res.json()
                    if (!res.ok) {
                      toast.error(data.error || 'Не удалось открыть диалог выбора папки.')
                      return
                    }
                    if (data.path) setLlmCustomModel(data.path as string)
                  } catch {
                    toast.error('Не удалось открыть диалог выбора папки.')
                  }
                }}
              >
                <FolderOpenIcon className="w-3.5 h-3.5 mr-1.5 shrink-0" />
                Выбрать папку на диске…
              </Button>
              <input
                type="text"
                value={llmCustomModel}
                onChange={(e) => setLlmCustomModel(e.target.value)}
                placeholder="…или введите путь вручную: D:\models"
                className="w-full rounded-md border border-border bg-[var(--surface-2)] px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              />
              <span className="text-xs text-muted-foreground block pt-1">mmproj (зрение, опционально)</span>
              {/* (правка 308) Тоже файл или папка: из папки берётся первый
                  файл с 'mmproj' в имени. */}
              <input
                type="text"
                value={llmCustomMmproj}
                onChange={(e) => setLlmCustomMmproj(e.target.value)}
                placeholder="D:\models\my-model-mmproj-F16.gguf"
                className="w-full rounded-md border border-border bg-[var(--surface-2)] px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              />
            </div>

            <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
              Макс. длина ответа рассчитывается автоматически из контекста.
              Применяется при следующем запуске модели.
              При генерации видео GPU-режим автоматически уступает память.
            </p>

            <Button
              variant="outline"
              size="sm"
              onClick={() => void saveLlm()}
              disabled={saving}
              className="w-full"
            >
              {saving ? 'Сохранение...' : 'Сохранить'}
            </Button>
          </div>
        )}

        {/* ─────────── Voice input (правка 65) ─────────── */}
        {tab === 'voice' && <VoiceSettingsPanel />}

        {/* ─────────── Optimization ─────────── */}
        {tab === 'optimization' && (
          <div className="space-y-5 py-2">
            {/* ── ComfyUI GPU memory (config.ini, applied at restart) ── */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <CpuIcon className="w-4 h-4 text-amber-400" />
                Память GPU (ComfyUI)
              </div>
              <p className="text-xs text-muted-foreground/70 -mt-1.5">
                Резерв и динамическое управление VRAM ComfyUI. Применяется при перезапуске.
              </p>

              <div className="space-y-1.5 pt-2 border-t border-border">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Резерв VRAM</span>
                  <span className="text-xs font-mono">{reserveVram} GB</span>
                </div>
                <input
                  type="range"
                  /* (правка 315) Диапазон унифицирован с сервером: 1–16 ГБ */
                  min={1}
                  max={16}
                  step={0.5}
                  value={reserveVram}
                  onChange={(e) => setReserveVram(parseFloat(e.target.value))}
                  className="w-full h-2 cursor-pointer accent-amber-400"
                />
                {/* Позиции по реальной шкале 1–16: 8 GB стоит на ~47%, а не
                    в центре (justify-between его прижимал к 50% и врал) */}
                <div className="relative h-3 text-[10px] text-muted-foreground/50">
                  <span className="absolute left-0">1 GB</span>
                  <span className="absolute" style={{ left: '47%' }}>8 GB</span>
                  <span className="absolute right-0">16 GB</span>
                </div>
              </div>

              {/* (правка 490) Доп. запас свободной VRAM (--vram-headroom):
                  его учитывает нативный слой DynamicVRAM (comfy-aimdo) —
                  он следит за реально свободной VRAM по NVML, включая
                  чужие приложения. Основной и гарантированный рычаг —
                  «Резерв VRAM»: его менеджер моделей ComfyUI вычитает из
                  доступной памяти при загрузке весов, поэтому модели
                  выгружаются/офлоадятся раньше. */}
              <div className="space-y-1.5 pt-2 border-t border-border">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Запас свободной VRAM (headroom)</span>
                  <span className="text-xs font-mono">{vramHeadroom > 0 ? `${vramHeadroom} GB` : 'Выкл'}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={8}
                  step={0.5}
                  value={vramHeadroom}
                  onChange={(e) => setVramHeadroom(parseFloat(e.target.value))}
                  className="w-full h-2 cursor-pointer accent-amber-400"
                />
                <div className="relative h-3 text-[10px] text-muted-foreground/50">
                  <span className="absolute left-0">Выкл</span>
                  <span className="absolute" style={{ left: '22%' }}>2 GB</span>
                  <span className="absolute right-0">8 GB</span>
                </div>
                <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                  Дополнительный запас, который учитывает нативный слой
                  DynamicVRAM (comfy-aimdo) при распределении VRAM — с учётом и
                  чужих приложений. Гарантированный рычаг — «Резерв VRAM»:
                  его менеджер моделей ComfyUI вычитает при загрузке весов.
                </p>
              </div>

              <div className="space-y-1.5 pt-2 border-t border-border">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs text-muted-foreground">Dynamic VRAM</span>
                    <p className="text-[10px] text-muted-foreground/60">
                      Динамическое управление VRAM ComfyUI
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDynamicVram(!dynamicVram)}
                    className={cn(
                      'relative w-10 h-5.5 rounded-full transition-colors shrink-0',
                      dynamicVram ? 'bg-emerald-500/70' : 'bg-[var(--surface-4)]',
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform',
                        dynamicVram && 'translate-x-[18px]',
                      )}
                    />
                  </button>
                </div>
              </div>

              <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                Применяется при перезапуске ComfyUI — после сохранения перезапустите студию (start.bat).
              </p>
            </div>

            {/* ── Generation optimizations (per-generation workflow params, applied immediately) ── */}
            <div className="space-y-3 pt-4 border-t border-border">
              <div className="flex items-center gap-2 text-sm font-medium">
                <SlidersHorizontalIcon className="w-4 h-4 text-emerald-400" />
                Оптимизация генерации (VRAM)
              </div>
              <p className="text-xs text-muted-foreground/70 -mt-1.5">
                Режимы экономии памяти для нод генерации. Применяются ко всем новым
                генерациям сразу — без перезапуска ComfyUI.
              </p>

              {/* (правка 168) Sparse Attention (Sol-Attn) */}
              <div className="space-y-1.5 pt-2 border-t border-border">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs text-muted-foreground">Разреженное внимание (Sol-Attn)</span>
                    <p className="text-[10px] text-muted-foreground/60">
                      Ускоряет длинные последовательности (~1.2–2.5×);
                      короткие остаются плотными автоматически
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={video.sparseAttention}
                    onClick={() => patchVideo({ sparseAttention: !video.sparseAttention })}
                    className={cn(
                      'relative w-10 h-5.5 rounded-full transition-colors shrink-0',
                      video.sparseAttention ? 'bg-emerald-500/70' : 'bg-[var(--surface-4)]',
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform',
                        video.sparseAttention && 'translate-x-[18px]',
                      )}
                    />
                  </button>
                </div>

                {/* (правка 466) Настройки ноды Sol-Attn — видны при включённом
                    тоггле (как блок Veda, правка 406). Раньше значения были
                    зашиты в шаблон workflow (tau 1.3, 0.2–1.0, 12288, 256). */}
                {video.sparseAttention && (
                  <div className="space-y-3 pl-3 border-l border-border/60">
                    <SettingSlider
                      label="Порог разреженности (tau)"
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
                      label="Включать с начала генерации"
                      labelTitle="Первые шаги генерации задают композицию — их лучше считать точно. 20% — стандарт: первые пять шагов полные, дальше ускорение."
                      value={Math.round(video.sparseStartPercent * 100)}
                      onChange={(v) => patchVideo({ sparseStartPercent: v / 100 })}
                      min={0}
                      max={90}
                      step={5}
                      formatValue={(v) => `${Math.round(v)}%`}
                    />
                    <SettingSlider
                      label="Работать до конца генерации"
                      labelTitle="До какого момента применять ускорение. 100% — до последнего шага (быстрее всего). Если финал выглядит мыльным — уменьшите."
                      value={Math.round(video.sparseEndPercent * 100)}
                      onChange={(v) => patchVideo({ sparseEndPercent: v / 100 })}
                      min={10}
                      max={100}
                      step={5}
                      formatValue={(v) => `${Math.round(v)}%`}
                    />
                    <SettingSlider
                      label="Минимальная длина видео (токены)"
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
                      label="Дополнительный контекст (токены)"
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
                )}
              </div>

              {/* (правка 301) Veda Sparse Attention */}
              <div className="space-y-1.5 pt-2 border-t border-border">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs text-muted-foreground">Veda Sparse Attention</span>
                    <p className="text-[10px] text-muted-foreground/60">
                      Для длинных видео (10+ сек) / 8+ шагов; заменяет Sol-Attn
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={video.vedaAttention}
                    onClick={() => patchVideo({ vedaAttention: !video.vedaAttention })}
                    className={cn(
                      'relative w-10 h-5.5 rounded-full transition-colors shrink-0',
                      video.vedaAttention ? 'bg-emerald-500/70' : 'bg-[var(--surface-4)]',
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform',
                        video.vedaAttention && 'translate-x-[18px]',
                      )}
                    />
                  </button>
                </div>

                {/* (правка 406) Расширенные настройки Veda — видны при включённом тоггле */}
                {video.vedaAttention && (
                  <div className="space-y-3 pl-3 border-l border-border/60">
                    <SettingSlider
                      label="Спарсити генерации, %"
                      value={(() => { const n = Number.parseFloat(video.vedaGeneratedSparsity); return Number.isFinite(n) ? n : 90 })()}
                      onChange={(v) => patchVideo({ vedaGeneratedSparsity: `${Math.round(v)}%` })}
                      min={50}
                      max={95}
                      step={5}
                    />
                    <p className="text-[10px] text-muted-foreground/60 -mt-1.5 leading-snug">
                      Сколько key-тайлов пропускать в генерации. Выше % = быстрее, но грубее картинка.
                    </p>
                    <SettingSlider
                      label="Спарсити референсов, %"
                      value={(() => { const n = Number.parseFloat(video.vedaReferenceSparsity); return Number.isFinite(n) ? n : 90 })()}
                      onChange={(v) => patchVideo({ vedaReferenceSparsity: `${Math.round(v)}%` })}
                      min={0}
                      max={95}
                      step={5}
                    />
                    <p className="text-[10px] text-muted-foreground/60 -mt-1.5 leading-snug">
                      То же для референсов. 0% = полное внимание к референсам — точнее лицо персонажа, но медленнее.
                    </p>
                    <div className="space-y-1">
                      <span className="text-xs text-muted-foreground">Слои с полным вниманием</span>
                      <input
                        type="text"
                        value={video.vedaFullAttentionLayers}
                        onChange={(e) => patchVideo({ vedaFullAttentionLayers: e.target.value })}
                        placeholder="0, 1, 47-49"
                        className="w-full rounded-md border border-border bg-[var(--surface-2)] px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                      />
                      <p className="text-[10px] text-muted-foreground/60 leading-snug">
                        0-based номера блоков DiT, которые всегда считаются плотно. Пусто = все слои sparse.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <span className="text-xs text-muted-foreground">Шаги с полным вниманием</span>
                      <input
                        type="text"
                        value={video.vedaFullAttentionSteps}
                        onChange={(e) => patchVideo({ vedaFullAttentionSteps: e.target.value })}
                        placeholder="0, 1"
                        className="w-full rounded-md border border-border bg-[var(--surface-2)] px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                      />
                      <p className="text-[10px] text-muted-foreground/60 leading-snug">
                        0-based номера шагов сэмплера с полным вниманием. Пусто = все шаги sparse.
                      </p>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={video.vedaVerbose}
                        onChange={(e) => patchVideo({ vedaVerbose: e.target.checked })}
                        className="w-3.5 h-3.5 accent-emerald-500"
                      />
                      <span className="text-xs text-muted-foreground">Подробный лог (verbose)</span>
                    </label>
                  </div>
                )}
              </div>

              {/* Low VRAM Attention */}
              <div className="space-y-1.5 pt-2 border-t border-border">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs text-muted-foreground">Low VRAM Attention</span>
                    <p className="text-[10px] text-muted-foreground/60">
                      Attention чанками по 4 головы — экономит видеопамять
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={video.lowVramAttention}
                    onClick={() => patchVideo({ lowVramAttention: !video.lowVramAttention })}
                    className={cn(
                      'relative w-10 h-5.5 rounded-full transition-colors shrink-0',
                      video.lowVramAttention ? 'bg-emerald-500/70' : 'bg-[var(--surface-4)]',
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform',
                        video.lowVramAttention && 'translate-x-[18px]',
                      )}
                    />
                  </button>
                </div>
              </div>

              {/* Chunk FeedForward + settings */}
              <div className="space-y-1.5 pt-2 border-t border-border">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs text-muted-foreground">Chunk FeedForward</span>
                    <p className="text-[10px] text-muted-foreground/60">
                      FeedForward чанками на длинных последовательностях — экономит VRAM
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={video.chunkFeedForward}
                    onClick={() => patchVideo({ chunkFeedForward: !video.chunkFeedForward })}
                    className={cn(
                      'relative w-10 h-5.5 rounded-full transition-colors shrink-0',
                      video.chunkFeedForward ? 'bg-emerald-500/70' : 'bg-[var(--surface-4)]',
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform',
                        video.chunkFeedForward && 'translate-x-[18px]',
                      )}
                    />
                  </button>
                </div>

                {video.chunkFeedForward && (
                  <div className="space-y-3 pl-3 border-l border-border/60">
                    <SettingSlider
                      label="Chunk FF: число чанков"
                      value={typeof video.chunkFFChunks === 'number' ? video.chunkFFChunks : 2}
                      onChange={(v) => patchVideo({ chunkFFChunks: Math.round(v) })}
                      min={1}
                      max={8}
                      step={1}
                    />
                    <SettingSlider
                      label="Chunk FF: порог длины"
                      value={typeof video.chunkFFThreshold === 'number' ? video.chunkFFThreshold : 4096}
                      onChange={(v) => patchVideo({ chunkFFThreshold: Math.round(v) })}
                      min={1024}
                      max={16384}
                      step={512}
                    />
                  </div>
                )}
              </div>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => void saveOptimization()}
              disabled={saving}
              className="w-full"
            >
              {saving ? 'Сохранение...' : 'Сохранить'}
            </Button>
          </div>
        )}

        {/* ─────────── Video output format (правка 386) ─────────── */}
        {tab === 'video' && (
          <div className="space-y-6 py-2">
            {/* Кодек */}
            <div className="space-y-2">
              <Label className="text-xs">Кодек видео</Label>
              <div className="grid grid-cols-2 gap-1.5">
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
                        : 'border-border bg-[var(--surface-2)] hover:border-cyan-500/30',
                    )}
                  >
                    <p className={cn(
                      'text-xs font-medium',
                      videoCodec === id ? 'text-cyan-300' : 'text-foreground',
                    )}>{label}</p>
                    <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{hint}</p>
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground">
                NVENC использует отдельный блок видеокарты; если задачи начнут падать на сохранении — вернитесь на программный кодек.
              </p>
            </div>

            {/* Качество */}
            {videoCodec === 'h264' || videoCodec === 'h265' ? (
              <div className="space-y-2">
                <SettingSlider
                  label="Качество (CRF — меньше = лучше)"
                  value={videoCrf}
                  min={0}
                  max={30}
                  step={1}
                  onChange={(v) => setVideoCrf(Math.round(v))}
                  formatValue={(v) =>
                    v <= 14 ? `${v} — максимум` : v <= 19 ? `${v} — высокое` : v <= 25 ? `${v} — стандарт` : `${v} — компакт`
                  }
                />
                <p className="text-[10px] leading-snug text-muted-foreground">
                  12 — прежний максимум студии (архивное качество). 17–19 — «высокое», глазом почти неотличимо.
                  23+ — компактные черновики. H.265 при том же CRF даёт заметно меньший файл, чем H.264.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <SettingSlider
                  label="Битрейт NVENC"
                  value={videoNvencBitrate}
                  min={4}
                  max={40}
                  step={1}
                  unit=" Мбит/с"
                  onChange={(v) => setVideoNvencBitrate(Math.round(v))}
                />
                <p className="text-[10px] leading-snug text-muted-foreground">
                  Аппаратные энкодеры управляются битрейтом, а не CRF. Для 1080p ориентир: 16 Мбит/с ≈ высокому
                  качеству, 24+ — максимум, 8 — компактно.
                </p>
              </div>
            )}

            <p className="text-[10px] leading-snug text-muted-foreground/70">
              Применяется ко всем НОВЫМ задачам: генерация (драфт/полное), рефайн «Целый» и «Частями»,
              продление, Tile Upscale, FPS, обрезка и склейки. Уже созданные файлы не перекодируются.
              Настройка действует сразу — перезапуск не нужен.
            </p>

            <Button
              variant="outline"
              size="sm"
              onClick={() => void saveVideoFormat()}
              disabled={saving}
              className="w-full"
            >
              {saving ? 'Сохранение...' : 'Сохранить'}
            </Button>
          </div>
        )}

        {/* ─────────── Manual download links ─────────── */}
        {tab === 'links' && <ManualDownloadPanel />}

        {/* ─────────── О программе ─────────── */}
        {tab === 'about' && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3">
              <img src="/logo.svg" alt="" className="w-10 h-10" />
              <div>
                <div className="text-sm font-medium">Minimax H3 Studio</div>
                <div className="text-xs text-muted-foreground">Версия 7.0.0</div>
              </div>
            </div>
            {/* (правка 484) Текст автора — константа ABOUT_TEXT выше. */}
            <p className="text-xs text-muted-foreground whitespace-pre-line leading-relaxed">
              {ABOUT_TEXT}
            </p>

            {/* (правка 484) Ссылки автора */}
            <div className="space-y-1.5">
              {ABOUT_LINKS.map((l) => (
                <div key={l.url} className="flex items-baseline gap-2 text-xs">
                  <span className="text-muted-foreground shrink-0">{l.label}:</span>
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-400 hover:text-blue-300 underline underline-offset-2 break-all"
                  >
                    {l.url}
                  </a>
                  {l.hint && <span className="text-muted-foreground/60">({l.hint})</span>}
                </div>
              ))}
            </div>

            {/* (правка 484) Техническая информация */}
            <div className="border-t border-border/50 pt-3 space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">Техническая информация</div>
              {ABOUT_TECH.map((t) => (
                <div key={t.label} className="flex items-baseline gap-2 text-xs">
                  <span className="text-muted-foreground/70 shrink-0">{t.label}:</span>
                  <span className="text-muted-foreground">{t.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ─────────── Reset (Опасная зона) ─────────── */}
        {tab === 'reset' && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2">
              <AlertTriangleIcon className="w-4 h-4 text-red-400" />
              <span className="text-sm font-medium text-red-400">Опасная зона</span>
            </div>
            <p className="text-xs text-muted-foreground/70 -mt-2">
              Необратимые операции. Действуйте с осторожностью.
            </p>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-amber-400 border-amber-500/30 hover:bg-amber-500/10"
                  onClick={() => setConfirmAction('reset')}
                >
                  <RotateCcwIcon className="w-3.5 h-3.5" />
                  Сброс настроек
                </Button>
                <p className="text-xs text-muted-foreground/60 pl-1">
                  Все параметры (VRAM, LLM, выбор моделей, генерация, разрешение, шаги, звук) вернутся к значениям по умолчанию.
                </p>
              </div>

              <div className="space-y-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-amber-400 border-amber-500/30 hover:bg-amber-500/10"
                  onClick={() => setConfirmAction('clean')}
                >
                  <Trash2Icon className="w-3.5 h-3.5" />
                  Очистить кэш
                </Button>
                <p className="text-xs text-muted-foreground/60 pl-1">
                  Удалит все файлы из папки input ComfyUI (референсы, кадры, временные загрузки).
                </p>
              </div>

              <div className="space-y-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-red-400 border-red-500/30 hover:bg-red-500/10"
                  onClick={() => setConfirmAction('delete')}
                >
                  <TrashIcon className="w-3.5 h-3.5" />
                  Удалить контент
                </Button>
                <p className="text-xs text-muted-foreground/60 pl-1">
                  Удалит ВСЕ сгенерированные видео (папка output), историю
                  чатов ассистента, историю промптов и ТЕКУЩИЙ промпт в поле генерации.
                </p>
              </div>

              {/* (правка 130 + полный сброс) Полный сброс «как с завода» */}
              <div className="space-y-1.5 border-t border-border/40 pt-4">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-red-500 border-red-500/50 bg-red-500/5 hover:bg-red-500/15 font-medium"
                  onClick={() => setConfirmAction('factory')}
                >
                  <SparklesIcon className="w-3.5 h-3.5" />
                  Полный сброс (всё)
                </Button>
                <p className="text-xs text-muted-foreground/60 pl-1">
                  Удалит ВСЁ ваше: видео, кэш, файлы апскейла, вложения и историю чатов, промпты, журналы и локальные данные. Настройки, LoRA и config.ini вернутся к заводским. Для передачи программы другому человеку — после сброса не останется ничего вашего.
                </p>
              </div>
            </div>
          </div>
        )}
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
              {CONFIRM[confirmAction].title}
            </DialogTitle>
            <DialogDescription>
              {CONFIRM[confirmAction].desc}
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 justify-end mt-4">
            <Button variant="outline" size="sm" onClick={() => setConfirmAction(null)} disabled={executing}>
              Отмена
            </Button>
            <Button
              size="sm"
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => void executeAction(confirmAction)}
              disabled={executing}
            >
              {executing ? 'Выполняется...' : CONFIRM[confirmAction].button}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    )}
    </>
  )
}

/* ─── (правка 257) Свои папки моделей — коллекции вне папки студии ─── */

function ExtraModelPathsPanel() {
  // (правка 262) exists — флаг наличия папки (сервер проверяет через statSync)
  const [entries, setEntries] = useState<Array<{ path: string; category: string; exists?: boolean }>>([])
  const [newPath, setNewPath] = useState('')
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((d) => {
        setEntries(Array.isArray(d.model_extra_paths) ? d.model_extra_paths : [])
      })
      .catch(() => setEntries([]))
  }, [])

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
      setEntries((prev) => {
        const seen = new Set(prev.map((e) => `${e.path}|${e.category}`))
        return [...prev, ...found.filter((e) => !seen.has(`${e.path}|${e.category}`))]
      })
      setNewPath('')
      setDirty(true)
      toast.success(
        found.length > 1
          ? `Добавлено категорий: ${found.length} (структура ComfyUI)`
          : 'Папка добавлена',
      )
    } catch {
      toast.error('Не удалось проверить папку')
    } finally {
      setAdding(false)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // (правка 262) Отправляем только path+category — exists не хранится
        body: JSON.stringify({
          model_extra_paths: entries.map(({ path, category }) => ({ path, category })),
        }),
      })
      const d = await res.json()
      if (!res.ok || d.error) {
        toast.error(typeof d?.error === 'string' && d.error ? d.error : 'Ошибка сохранения')
        return
      }
      setDirty(false)
      if (d.restart_required) {
        toast.success('Папки сохранены', {
          description: 'Перезапустите start.bat — ComfyUI подхватит внешние папки при старте.',
          duration: 10000,
        })
      } else {
        toast.success('Папки сохранены')
      }
    } catch {
      toast.error('Ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2 pt-2 border-t border-border">
      <div className="flex items-center gap-2 text-xs font-medium">
        <FolderOpenIcon className="w-3.5 h-3.5 text-amber-400" />
        Свои папки моделей
      </div>
      <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
        Папки с моделями ВНЕ папки студии (коллекции с других машин, общие
        хранилища) — без копирования. Папку со стандартной структурой
        (как <span className="font-mono">models</span> у ComfyUI) студия
        разложит по категориям сама. После изменения перезапустите start.bat.
      </p>

      {entries.length > 0 && (
        <div className="space-y-1.5">
          {entries.map((e, i) => (
            <div key={`${e.path}|${e.category}`} className="flex items-center gap-1.5">
              {/* (правка 262) Индикатор: папка не существует на диске */}
              {e.exists === false && (
                <span
                  title="Папка не найдена на диске — удалите или исправьте путь"
                  className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/30"
                >
                  нет
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
                className={`flex-1 min-w-0 rounded-md border bg-[var(--surface-2)] px-2 py-1 text-[10px] font-mono text-foreground focus:outline-none focus:ring-1 ${
                  e.exists === false
                    ? 'border-red-500/40 focus:ring-red-500/50'
                    : 'border-border focus:ring-cyan-500/50'
                }`}
              />
              <select
                value={e.category}
                onChange={(ev) => {
                  const v = ev.target.value
                  setEntries((prev) => prev.map((x, j) => (j === i ? { ...x, category: v } : x)))
                  setDirty(true)
                }}
                className="rounded-md border border-border bg-[var(--surface-2)] px-1.5 py-1 text-[10px] text-foreground focus:outline-none"
                title="Категория (папка ComfyUI)"
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
                className="p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 shrink-0"
                title="Убрать папку"
              >
                <Trash2Icon className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Нативный выбор папки (тот же диалог, что у переноса моделей) */}
      <Button
        variant="outline"
        size="sm"
        className="w-full justify-start font-normal"
        disabled={adding}
        onClick={async () => {
          try {
            const res = await fetch('/api/dialog/folder', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title: 'Выберите папку с моделями' }),
            })
            const data = await res.json()
            if (!res.ok) {
              toast.error(data.error || 'Не удалось открыть диалог выбора папки.')
              return
            }
            if (data.path) void add(data.path as string)
          } catch {
            toast.error('Не удалось открыть диалог выбора папки.')
          }
        }}
      >
        <FolderOpenIcon className="w-3.5 h-3.5 mr-1.5 shrink-0" />
        {adding ? 'Добавление…' : 'Выбрать папку на диске…'}
      </Button>

      <div className="flex gap-1.5">
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
          placeholder="…или введите путь вручную: D:\AI\models"
          className="flex-1 rounded-md border border-border bg-[var(--surface-2)] px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-cyan-500"
        />
        <Button variant="outline" size="sm" onClick={() => void add()} disabled={adding || !newPath.trim()} className="h-8 px-3">
          {adding ? '…' : 'Добавить'}
        </Button>
      </div>

      <Button variant="outline" size="sm" onClick={() => void save()} disabled={saving || !dirty} className="w-full">
        {saving ? 'Сохранение…' : 'Сохранить папки'}
      </Button>
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
]

/* ─── Manual download links (all models: URLs + target paths) ─── */

function ManualDownloadPanel() {
  const [comfyDir, setComfyDir] = useState('')
  const [bonsaiDir, setBonsaiDir] = useState('')

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((d) => {
        setComfyDir(d.comfy_dir || '')
        setBonsaiDir(d.llm_bonsai_dir || '')
      })
      .catch(() => {
        setComfyDir('')
        setBonsaiDir('')
      })
  }, [])

  const comfyModelsRoot = comfyDir ? `${comfyDir}\\ComfyUI\\models\\` : '<ComfyUI-Easy-Install>\\ComfyUI\\models\\'
  const bonsaiModelsRoot = bonsaiDir ? `${bonsaiDir}\\` : '<Bonsai_2_27B>\\'

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${what} скопирован`)
    } catch {
      toast.error('Не удалось скопировать')
    }
  }

  return (
    <div className="space-y-3 py-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <LinkIcon className="w-4 h-4 text-cyan-400" />
        Ручная загрузка моделей
      </div>
      <p className="text-xs text-muted-foreground/70 -mt-1 leading-relaxed">
        Если скачивание из приложения не работает (например, huggingface.co недоступен) —
        скачайте файлы вручную по прямым ссылкам и положите по указанным путям.
        Приложение подхватит их автоматически.
      </p>

      {/* Models root paths */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 p-2 rounded-md bg-[var(--surface-2)] border border-border">
          <FolderOpenIcon className="w-4 h-4 text-amber-400 shrink-0" />
          <code className="flex-1 min-w-0 text-[10px] font-mono text-foreground/80 break-all">
            ComfyUI: {comfyModelsRoot}
          </code>
          <button
            type="button"
            onClick={() => void copy(comfyModelsRoot, 'Путь')}
            className="p-1 rounded hover:bg-[var(--surface-3)] text-muted-foreground hover:text-foreground shrink-0"
            title="Скопировать путь"
          >
            <CopyIcon className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-2 p-2 rounded-md bg-[var(--surface-2)] border border-border">
          <FolderOpenIcon className="w-4 h-4 text-violet-400 shrink-0" />
          <code className="flex-1 min-w-0 text-[10px] font-mono text-foreground/80 break-all">
            Bonsai: {bonsaiModelsRoot}
          </code>
          <button
            type="button"
            onClick={() => void copy(bonsaiModelsRoot, 'Путь')}
            className="p-1 rounded hover:bg-[var(--surface-3)] text-muted-foreground hover:text-foreground shrink-0"
            title="Скопировать путь"
          >
            <CopyIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {MODEL_CATEGORIES.map(({ key, label }) => {
        const models = MODELS.filter((m) => m.category === key)
        if (!models.length) return null
        return (
          <div key={key} className="space-y-1.5 pt-2 border-t border-border">
            <div className="text-xs font-medium text-foreground/80">{label}</div>
            {models.map((m) => {
              const isBonsai = m.target === 'bonsai'
              const fullRoot = isBonsai ? bonsaiModelsRoot : comfyModelsRoot
              const fullPath = fullRoot + m.relPath
              return (
              <div
                key={m.id}
                className="p-2 rounded-md bg-[var(--surface-2)]/60 border border-border space-y-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-foreground/90 truncate" title={m.label}>
                    {m.label}
                  </span>
                  <Badge variant="secondary" className="text-[10px] shrink-0">{m.sizeLabel}</Badge>
                </div>
                <div className="flex items-center gap-1.5">
                  <code className="flex-1 min-w-0 text-[10px] font-mono text-cyan-300/80 truncate" title={fullPath}>
                    {fullPath}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copy(fullPath, 'Путь')}
                    className="p-0.5 rounded hover:bg-[var(--surface-3)] text-muted-foreground hover:text-foreground shrink-0"
                    title="Скопировать полный путь"
                  >
                    <CopyIcon className="w-3 h-3" />
                  </button>
                </div>
                <div className="flex items-center gap-1.5">
                  <a
                    href={m.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex-1 min-w-0 text-[10px] text-muted-foreground hover:text-cyan-300 truncate underline decoration-dotted underline-offset-2"
                    title={m.url}
                  >
                    {m.url.replace('?download=true', '')}
                  </a>
                  <button
                    type="button"
                    onClick={() => void copy(m.url, 'URL')}
                    className="p-0.5 rounded hover:bg-[var(--surface-3)] text-muted-foreground hover:text-foreground shrink-0"
                    title="Скопировать ссылку"
                  >
                    <CopyIcon className="w-3 h-3" />
                  </button>
                </div>
              </div>
              )
            })}
          </div>
        )
      })}

      <p className="text-[10px] text-muted-foreground/60 leading-relaxed pt-1">
        Имя файла должно совпасть точно (браузер иногда дописывает «(1)» — переименуйте).
        Если huggingface.co не открывается — замените в ссылке домен на{' '}
        <code className="text-cyan-300/80">hf-mirror.com</code>. После скачивания
        проверьте размер файла (см. бейдж) — меньший размер означает обрыв загрузки.
      </p>
    </div>
  )
}

/* ─── Theme Switcher ─── */

/** (правка 111) `first` — первый блок вкладки «Внешний вид»: без верхней границы. */
function ThemeSwitcher({ first = false }: { first?: boolean }) {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  if (!mounted) return <div className="h-10" />

  const btnBase = 'flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border text-sm transition-all'
  const btnActive = 'border-cyan-500/50 bg-cyan-500/10 text-foreground'
  const btnIdle = 'border-border text-muted-foreground hover:border-border/80'

  return (
    <div className={cn('space-y-2', !first && 'pt-2 border-t border-border')}>
      <div className="flex items-center gap-2">
        <SunIcon className="w-4 h-4 text-amber-400" />
        <span className="text-sm font-medium">Тема оформления</span>
      </div>
      {/* (правка 98) Светлая тема удалена — только тёмные.
          (правка 441) + тема «Студия» (dark-calm, Calm Studio). */}
      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => setTheme('dark-gray')}
          className={cn(btnBase, theme === 'dark-gray' ? btnActive : btnIdle)}
        >
          <MoonIcon className="w-4 h-4" />
          Серая
        </button>
        <button
          type="button"
          onClick={() => setTheme('dark')}
          className={cn(btnBase, theme === 'dark' ? btnActive : btnIdle)}
        >
          <MoonIcon className="w-4 h-4" />
          Чёрная
        </button>
        <button
          type="button"
          onClick={() => setTheme('dark-calm')}
          className={cn(btnBase, theme === 'dark-calm' ? btnActive : btnIdle)}
        >
          <SparklesIcon className="w-4 h-4" />
          Студия
        </button>
      </div>
    </div>
  )
}

/**
 * (правка 445) Масштаб интерфейса (пользователь ставил 90% в браузере и
 * просил то же из настроек). Значение — в localStorage ('h3-ui-scale'),
 * применяется мгновенно; на старте приложения подхватывается инлайн-скриптом
 * в layout.tsx (без вспышки немасштабированного UI). Механизм — см. 451 ниже.
 */
const UI_SCALE_PRESETS = [80, 90, 100, 110, 125] as const
const UI_SCALE_KEY = 'h3-ui-scale'

/**
 * (правка 451) ФИНАЛЬНЫЙ вариант: масштаб ТОЛЬКО через root font-size.
 * История: CSS `zoom` (445) не пересчитывал vw/vh → пустые поля (фикс 446
 * компенсацией width/height); затем выяснилось, что у пользователя движок
 * zoom молча игнорирует, а компенсация ширины применялась → контент уезжал
 * за экран; детект CSS.supports (450) не спас — supports=true, а рендер
 * zoom всё равно не происходит, и эффективность zoom из JS не измерить
 * (getBoundingClientRect возвращает НЕмасштабированные layout-пиксели).
 * font-size на <html>: весь Tailwind в rem → масштабируется вся раскладка
 * с текстом, честный reflow, побега за экран быть не может. Побочка:
 * жёсткие px-значения (text-[10px], w-[420px] и т.п.) не масштабируются.
 */
function applyUiScale(pct: number) {
  document.documentElement.style.fontSize = pct === 100 ? '' : `${pct}%`
}

function UiScaleSwitcher() {
  // (правка 579) дефолт масштаба UI — 80%
  const [scale, setScale] = useState(80)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    try {
      // (правка 579) дефолт масштаба UI — 80%
      const s = parseInt(localStorage.getItem(UI_SCALE_KEY) || '80', 10)
      if (!Number.isNaN(s)) setScale(s)
    } catch { /* приватный режим */ }
  }, [])

  const apply = (pct: number) => {
    setScale(pct)
    try {
      localStorage.setItem(UI_SCALE_KEY, String(pct))
      applyUiScale(pct)
    } catch { /* ignore */ }
  }

  if (!mounted) return <div className="h-10" />

  return (
    <div className="space-y-2 pt-2 border-t border-border">
      <div className="flex items-center gap-2">
        <ZoomInIcon className="w-4 h-4 text-cyan-400" />
        <span className="text-sm font-medium">Масштаб интерфейса</span>
      </div>
      <div className="grid grid-cols-5 gap-2">
        {UI_SCALE_PRESETS.map((pct) => (
          <button
            key={pct}
            type="button"
            onClick={() => apply(pct)}
            className={cn(
              'flex items-center justify-center px-2 py-2.5 rounded-lg border text-sm transition-all tabular-nums',
              scale === pct
                ? 'border-cyan-500/50 bg-cyan-500/10 text-foreground'
                : 'border-border text-muted-foreground hover:border-border/80',
            )}
          >
            {pct}%
          </button>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground/60">
        Меняет базовый размер шрифта — за ним масштабируется весь интерфейс. Применяется сразу и запоминается.
      </p>
    </div>
  )
}
