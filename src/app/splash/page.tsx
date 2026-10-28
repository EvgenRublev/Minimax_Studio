'use client'

/**
 * Splash — экран-заставка на время загрузки ComfyUI.
 *
 * (правка 522) Новый дизайн: вместо ОДНОГО видео в центре — «видео-стена»
 * из 8 карточек 9:16 (public/splash-videos/tile_01..08.mp4), которые медленно
 * скроллясь вниз, бесконечно повторяются. Карточки без рамок, подписей и
 * отступов — буквально сшиты, и служат живым фоном из кинематографичных
 * кадров, сгенерированных в этой программе.
 *
 * Сохранена вся прежняя логика:
 *  - опрос готовности ComfyUI через /api/comfy/health каждые 2 с;
 *  - таймер загрузки (m:ss) + шиммер-полоска;
 *  - после ~5 мин — честное предупреждение, что ComfyUI стартует дольше;
 *  - при готовности — «Готово — открываем студию…» и router.replace('/').
 *
 * (правка 748) Первый запуск без зависимостей: параллельно опрашивается
 * /api/setup-status (пишет install.ps1 через Electron). Пока установка идёт —
 * вместо шиммера показывается «Установка компонентов: [N/9] …» с честным
 * прогресс-баром; при ошибке — текст ошибки. Вверху справа — маленькая
 * кнопка «закрыть» (только в десктоп-режиме, через preload-мост h3desktop):
 * закрывает программу целиком, Electron по пути убивает и установщик.
 *
 * Оформление строится на CSS-переменных темы (--surface-*, --foreground,
 * --splash-*) и следует светлой/тёмной теме приложения.
 */
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

const POLL_MS = 2000
/** Пауза на «Готово» перед переходом, мс. */
const EXIT_DELAY_MS = 700

/** (правка 748) Статус установки зависимостей из .install-cache\setup_status.json. */
interface SetupStatus {
  state: 'running' | 'done' | 'error'
  step?: number
  total?: number
  title?: string
}

/** 8 видео-кадров (public/splash-videos). 9:16, зациклены, без звука. */
const SPLASH_TILES = [
  '/splash-videos/tile_01.mp4',
  '/splash-videos/tile_02.mp4',
  '/splash-videos/tile_03.mp4',
  '/splash-videos/tile_04.mp4',
  '/splash-videos/tile_05.mp4',
  '/splash-videos/tile_06.mp4',
  '/splash-videos/tile_07.mp4',
  '/splash-videos/tile_08.mp4',
]

export default function SplashPage() {
  const router = useRouter()
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const startedAt = useRef(Date.now())
  // (правка 748) Статус установки зависимостей (первый запуск) и сам
  // десктоп-мост: кнопка «закрыть» нужна только в Electron-окне.
  const [setup, setSetup] = useState<SetupStatus | null>(null)
  const [desktop, setDesktop] = useState(false)

  /* Порядок кадров: при каждой загрузке экрана — перемешанный.
   * Перемешиваем ОДИН базовый порядок и дублируем его в обеих группах
   * (для бесшовного цикла translateY 0 → -50% группы обязаны совпадать).
   * Инициализируем каноническим порядком, чтобы не было рассинхрона на
   * hydration; перемешивание происходит после монтирования. */
  const [order, setOrder] = useState<string[]>(SPLASH_TILES)

  /* Автозапуск всех видео (muted, чтобы автоплей не блокировался). */
  useEffect(() => {
    const vids = Array.from(document.querySelectorAll<HTMLVideoElement>('.splash-tile video'))
    vids.forEach((v) => {
      v.play().catch(() => { /* автоплей может быть заблокирован — молча игнорируем */ })
    })
  }, [])

  /* Перемешиваем порядок кадров один раз после монтирования (Fisher–Yates).
   * Благодаря этому на каждой загрузке сплэш порядок плиток другой, но
   * дублирование в обеих группах остаётся — цикл скролла бесшовный. */
  useEffect(() => {
    const a = [...SPLASH_TILES]
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    setOrder(a)
  }, [])

  /* Опрос готовности ComfyUI. Ссылка на контроллер — чтобы таймеры не
   * стреляли после размонтирования при переходе в приложение. */
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    // (правка 587) Таймер перехода в приложение тоже трекаем: без этого
    // уход со сплэша в окно 700 мс «Готово» оставлял висящий setTimeout,
    // который после размонтирования насильно возвращал приложение на '/'.
    let exitTimer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      try {
        const r = await fetch('/api/comfy/health', { signal: AbortSignal.timeout(8000) })
        if (!cancelled && r.ok) {
          const d = await r.json().catch(() => ({}))
          if (d.ok !== false) {
            setReady(true)
            exitTimer = setTimeout(() => router.replace('/'), EXIT_DELAY_MS)
            return
          }
        }
      } catch {
        /* ComfyUI ещё грузится (или веб-сервер сам ещё стартует) — ждём */
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      clearTimeout(timer)
      if (exitTimer) clearTimeout(exitTimer)
    }
  }, [router])

  /* (правка 748) Опрос статуса установки зависимостей. Пока state=running —
   * ComfyUI заведомо не поднялся (Electron поднимет его после установки),
   * поэтому показываем честные шаги «[N/9]» вместо шиммера. done → null:
   * дальше обычная «загрузка ComfyUI». */
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const r = await fetch('/api/setup-status', { signal: AbortSignal.timeout(5000) })
        if (r.ok) {
          const d = await r.json().catch(() => ({}))
          const st = (d as { status?: SetupStatus | null }).status ?? null
          if (!cancelled) setSetup(st && st.state !== 'done' ? st : null)
        }
      } catch {
        /* веб-сервер только стартует или статус-файла нет — как обычно */
      }
    }
    void poll()
    const id = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  /* (правка 748) Десктоп-режим? (preload-мост h3desktop есть только в Electron) */
  useEffect(() => {
    setDesktop(Boolean((window as unknown as { h3desktop?: unknown }).h3desktop))
  }, [])

  /* Счётчик секунд загрузки — чтобы было видно, что всё живо. */
  useEffect(() => {
    if (ready) return
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000)
    return () => clearInterval(id)
  }, [ready])

  /* ComfyUI не поднялся за ~5 минут — честно сообщаем, но продолжаем ждать. */
  useEffect(() => {
    if (elapsed > 300 && !failed) setFailed(true)
  }, [elapsed, failed])

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-[var(--surface-0)]">
      {/* ── Живой фон: «видео-стена» из 8 кадров 9:16, скроллится вниз ── */}
      <div className="relative flex-1 min-h-0 overflow-hidden bg-[var(--surface-1)]">
        <div className="splash-scroll absolute inset-0">
          {/* Две одинаковые группы для бесшовного цикла (translateY 0 → -50%). */}
          <div className="splash-track">
            {[0, 1].map((set) => (
              <div key={set} className="splash-set" aria-hidden={set === 1}>
                {order.map((src) => (
                  <div key={`${set}-${src}`} className="splash-tile">
                    <video src={src} muted playsInline loop preload="auto" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Затухание к краям, чтобы стена «растворялась» под панелями. */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-24"
          style={{ background: 'linear-gradient(to bottom, var(--surface-0), transparent)' }}
        />
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-28"
          style={{ background: 'linear-gradient(to top, var(--surface-0), transparent)' }}
        />
      </div>

      {/* ── Верхняя панель: бренд слева, подписи справа ── */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between px-8 py-5">
        <div className="flex items-center gap-3">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold text-white"
            style={{ background: 'linear-gradient(135deg, var(--splash-a), var(--splash-b))', boxShadow: '0 0 20px -6px var(--splash-glow)' }}
          >
            H3
          </div>
          <div>
            <div className="text-[15px] font-semibold leading-tight" style={{ color: 'var(--foreground)' }}>
              MiniMax H3 Studio
            </div>
            <div className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>
              AI Video Generation
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--muted-foreground)' }}>
          <span>by Evgen Rublev</span>
          <span className="opacity-50">·</span>
          <span className="font-medium">Comfy UI</span>
          {/* (правка 748) «закрыть» — только в десктоп-окне (preload-мост):
              закрывает программу целиком, Electron убивает и установщик. */}
          {desktop && (
            <button
              onClick={() =>
                (window as unknown as { h3desktop?: { close: () => void } }).h3desktop?.close()
              }
              className="pointer-events-auto ml-1 rounded-md border border-white/10 bg-black/25 px-2 py-1 text-[11px] leading-none text-white/55 backdrop-blur-sm transition-colors hover:bg-black/45 hover:text-white"
              title="Закрыть программу"
            >
              закрыть ✕
            </button>
          )}
        </div>
      </div>

      {/* ── Статус загрузки (как в прежнем splash) ── */}
      <div className="relative z-10 flex flex-col items-center gap-3 px-8 pb-3 pt-2">
        {ready ? (
          <div className="flex items-center gap-2 text-emerald-400">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
            <span className="text-sm font-medium">Готово — открываем студию…</span>
          </div>
        ) : setup?.state === 'error' ? (
          /* (правка 748) Установка упала — честно говорим и не ждём вечно. */
          <div className="flex flex-col items-center gap-1.5">
            <p className="text-sm font-medium text-red-400">
              {setup.title || 'Установка завершилась с ошибкой'}
            </p>
            <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
              Подробности — в файле install.log в папке программы. Можно закрыть
              программу и запустить снова — установка продолжится с того места, где оборвалась.
            </p>
          </div>
        ) : setup?.state === 'running' ? (
          /* (правка 748) Установка зависимостей идёт — детерминированный
             прогресс по шагам install.ps1 (N/9), а не бесконечный шиммер. */
          <>
            <div className="h-1 w-64 overflow-hidden rounded-full bg-[var(--surface-2)] relative">
              <div
                className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700"
                style={{
                  width: `${Math.min(100, Math.round(((setup.step ?? 0) / Math.max(1, setup.total ?? 9)) * 100))}%`,
                  background: 'linear-gradient(90deg, var(--splash-a), var(--splash-b))',
                }}
              />
            </div>
            <p className="flex items-center gap-2 text-xs tabular-nums" style={{ color: 'var(--muted-foreground)' }}>
              <span
                className="inline-block h-1.5 w-1.5 rounded-full animate-[splash-pulse_1.5s_ease-in-out_infinite]"
                style={{ background: 'var(--splash-a)' }}
              />
              Установка компонентов: [{setup.step ?? 0}/{setup.total ?? 9}] {setup.title || '…'}
              <span className="opacity-50">·</span>
              <span className="font-semibold" style={{ color: 'var(--foreground)' }}>
                {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
              </span>
            </p>
          </>
        ) : (
          <>
            {/* Бегущая полоска-шиммер */}
            <div className="h-1 w-64 overflow-hidden rounded-full bg-[var(--surface-2)] relative">
              <div
                className="absolute inset-y-0 w-1/3 rounded-full animate-[splash-slide_1.6s_ease-in-out_infinite]"
                style={{ background: 'linear-gradient(90deg, transparent, var(--splash-a), transparent)' }}
              />
            </div>
            <p className="flex items-center gap-2 text-xs tabular-nums" style={{ color: 'var(--muted-foreground)' }}>
              <span
                className="inline-block h-1.5 w-1.5 rounded-full animate-[splash-pulse_1.5s_ease-in-out_infinite]"
                style={{ background: 'var(--splash-a)' }}
              />
              {failed
                ? 'ComfyUI стартует дольше обычного — детали в окне консоли…'
                : 'Идёт загрузка ComfyUI…'}
              <span className="opacity-50">·</span>
              <span className="font-semibold" style={{ color: 'var(--foreground)' }}>
                {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
              </span>
            </p>
          </>
        )}
      </div>

      {/* Ключевые кадры анимаций (локально, не плодим классы в globals.css). */}
      <style>{`
        .splash-scroll { overflow: hidden; }
        .splash-track {
          display: flex;
          flex-direction: column;
          animation: splash-wall 80s linear infinite;
          will-change: transform;
        }
        .splash-set {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 0;
        }
        .splash-tile { position: relative; aspect-ratio: 9 / 16; overflow: hidden; background: var(--surface-1); }
        .splash-tile video { width: 100%; height: 100%; object-fit: cover; display: block; }

        @keyframes splash-wall {
          0% { transform: translateY(0); }
          100% { transform: translateY(-50%); }
        }
        @keyframes splash-slide {
          0% { left: -35%; }
          100% { left: 100%; }
        }
        @keyframes splash-pulse {
          0%, 100% { opacity: 0.4; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.3); }
        }
      `}</style>
    </div>
  )
}
