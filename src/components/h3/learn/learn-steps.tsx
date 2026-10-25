'use client'

/**
 * Learn tab content: step definitions for the beginner tutorial.
 * Each step = a mockup of the relevant screen area (learn-mockups.tsx)
 * with numbered <Hl> highlights + callouts explaining "what / why / how".
 * INVARIANT: every callout number n has exactly one matching <Hl n> zone.
 *
 * (правка 114) Полная актуализация тура под текущий функционал программы:
 *   + окно приветствия (правки 112–113),
 *   + диктофон в поле промпта (правки 65/74),
 *   + горячая клавиша R/К на диктовку (правка 118),
 *   + вложения чата живут только в чате (правка 108), KV-кэш LLM (правка 109),
 *   + ручной ввод значений у слайдеров (правка 107),
 *   + два режима Upscale и метки в галерее (правки 74/77/78),
 *   + отдельный шаг по LoRA: турбо-лора в списке, сила, триггеры (правки 44/95/96),
 *   + вкладка «Внешний вид» и 8 вкладок настроек (правка 111),
 *   + шаги pass 1: 2–30, по умолчанию 4, ручной ввод 1–128 (правки 63–77).
 *
 * (правка 163) Актуализация под правки 136–162:
 *   + 3 режима генерации: Текст / Кадры / Референсы (правка 146),
 *   + Bonsai 2 27B — LLM по умолчанию (правка 162),
 *   + Ассистент видит видео-кадры на Bonsai (правка 162),
 *   + RTX VSR: HDR убран (правка 162), DLSS 1.5× работает (правка 162),
 *   + Bonsai light — optional, баннер не требует (правка 162),
 *   + Соотношение сторон в режиме «Кадры» из первого кадра (правка 152),
 *   + Ассистент знает режим и не ломает промпт при переключении (правка 150).
 *
 * (полная сверка с кодом) Исправлены расхождения и упрощён язык:
 *   + продление: минимум 3 с на клип (правка 434, было 5 — правка 309), 24 fps, автосклейка,
 *     результат — в папку оригинала (правка 363);
 *   + Refine: режимы «Целый»/«Частями», Match/Max, референсы из метаданных;
 *   + пайплайн «Полное»/«Драфт» и красный бейдж Draft (правки 310/313);
 *   + обрезка аудио-рефов в плеере (правка 326);
 *   + LoRA: сила −10…+10; резерв VRAM 1–16 ГБ (правка 315);
 *   + вкладка сайдбара называется «DLSS», всего вкладок десять (добавлена
 *     «Face Refine», правка 722).
 *
 * (правка 486) Актуализация под текущее состояние программы:
 *   + настроек стало ДЕВЯТЬ вкладок: добавились «Формат» (кодек/качество
 *     видео, правка 386) и «О программе» (правка 484), а отдельная вкладка
 *     «ComfyUI» убрана — статус и «Перепроверить» живут в «Общих», датчики
 *     VRAM/GPU/RAM — в сайдбаре;
 *   + «Видение видео» ассистента по умолчанию ВЫКЛ (правка 53);
 *   + диффузионная модель — FastH3 VSA DataFree 4-step INT8 (правка 293);
 *   + Refine: цели «Как в исходнике/720p/1080p», шаги 2–5, слайдер
 *     «Влияние Refine» (σ 0.30–0.95, дефолт 60%);
 *   + Tile Upscale: денойз 0.05–1 (дефолт 0.2), шаги 2–8 (дефолт 2),
 *     SyncTile (правка 481) — в доп. параметрах, по умолчанию вкл;
 *   + Продление: клип 3–30 с, двухпроходный режим (Драфт/Полное);
 *   + пользовательские LoRA работают также в Refine, Tile Upscale и
 *     Продлении (правка 483);
 *   + опасная зона: четыре кнопки (добавился «Заводской сброс (всё)»);
 *   + в «Обучении» появилась подвкладка «Сценарии» (правка 485).
 *
 * (правка 497) Новая вкладка «ControlNet» (сайдбар, секция тура, MockSidebar):
 *   генерация по контрольному видео (Fun ControlNet: depth/canny задают
 *   движение покадрово, внешний вид — по промпту). Вкладок стало девять.
 *
 * (правка 719) Актуализация под текущее состояние программы:
 *   + разделены «точка сплита» и «всего шагов» pass 1: дефолт теперь
 *     6 из 12 (было «4 из 8»), появился регулятор «Всего шагов (pass 1)»
 *     и живая сводка «N из M» с σ-границами (правки 719);
 *   + Extend: шаги клипа вынесены в отдельное поле (эталон = 4);
 *   + клик по превью референса открывает полноэкранный просмотр — во всех
 *     вкладках (правка 719);
 *   + при старте программа сверяет, что генерация реально идёт, и не
 *     показывает «в процессе» для несуществующей задачи (правка 719);
 *   + кнопки поля промпта — вертикальная колонка (правка 717);
 *   + встроенная турбо-лора снова в списке LoRA и включена по умолчанию;
 *     в режиме «Кадры» с аудио она пропускается, пользовательские LoRA — нет;
 *   + Refine: «Проход (шаги)» — 2/3/4/5, по умолчанию 3.
 */
import type { ReactNode } from 'react'
import {
  Hl,
  MockSidebar,
  MockRefDropzone,
  MockRefCard,
  MockPrompt,
  MockCtaButton,
  MockSelect,
  MockSlider,
  MockToggle,
  MockBar,
  MockLabel,
  MockQueuePill,
  MockGalleryTile,
  MockLightbox,
  MockMetaDialog,
  MockStats,
  MockWarningBanner,
  MockModelsList,
  MockSettingsGeneral,
  MockSettingsAppearance,
  MockSettingsLlm,
  MockSettingsDanger,
  MockSettingsComfyLinks,
  MockSettingsVoice,
  MockSettingsOpt,
  MockLoraList,
  MockUpscalePanel,
  MockWelcomeDialog,
} from './learn-mockups'

export interface LearnCallout {
  n: number
  title: string
  text: string
}

export interface LearnStep {
  id: string
  title: string
  /** One-line teaser shown in the "Что дальше" strip. */
  short: string
  mock: ReactNode
  callouts: LearnCallout[]
  tip?: string
}

/* ── helper: wrapper for mockup areas ── */
function Stage({ children }: { children: ReactNode }) {
  return <div className="w-full flex items-center justify-center gap-3 flex-wrap">{children}</div>
}

export const LEARN_STEPS: LearnStep[] = [
  /* ═══════════════ ЧАСТЬ 1. СТАРТ ═══════════════ */
  {
    id: 'welcome',
    title: 'Добро пожаловать — что это за программа',
    short: 'Локальная студия: нейросеть MiniMax H3 на вашем ПК и start.bat.',
    mock: (
      <Stage>
        <Hl n={1}><MockWelcomeDialog /></Hl>
        <Hl n={2}><MockSidebar /></Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-xs font-mono text-cyan-300 font-semibold">start.bat</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">Один клик — и запускается всё:</p>
            <div className="space-y-1 pt-1">
              <p className="text-[10px] text-foreground/80">• ComfyUI (нейросеть, порт 8188)</p>
              <p className="text-[10px] text-foreground/80">• веб-интерфейс</p>
              <p className="text-[10px] text-foreground/80">• браузер</p>
            </div>
          </div>
        </Hl>
        <Hl n={4}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-xs text-foreground font-semibold">🖥 Всё на вашем ПК</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Нейросеть работает на вашей видеокарте, а не в облаке. Для генерации интернет не нужен — только для первичной загрузки моделей.
            </p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Окно приветствия', text: 'Появляется при каждом запуске программы — пока вы не поставите галочку «Больше не показывать это окно». Внутри краткая инструкция из трёх шагов: скачать модели → сгенерировать первое видео → посмотреть результат. Из окна можно сразу открыть настройки или этот тур. Если окно «потерялось» — верните его: Настройки → Общие → «Показать окно приветствия».' },
      { n: 2, title: 'Вкладки слева', text: '«Генерация» — создание видео (3 режима: Текст / Кадры / Референсы), «Продление» — продолжить готовый ролик, «Refine» — улучшить качество видео, «ControlNet» — точный перенос движения с контрольного видео (3D-болванки), «Tile Upscale» и «DLSS» — два способа повысить чёткость, «FPS» — сделать движение плавнее, «Face Refine» — перерисовать мелкие лица, «Галерея» — все готовые видео, «Обучение» — этот тур. Ассистент (чат-помощник по промптам, Bonsai 2 27B) — правая панель на вкладках «Генерация» и «Продление». Сайдбар можно свернуть.' },
      { n: 3, title: 'start.bat — ваш пульт', text: 'Единственная точка запуска: поднимает нейросеть ComfyUI, интерфейс и открывает браузер. Если что-то пошло не так — просто перезапустите его.' },
      { n: 4, title: 'Локально и офлайн', text: 'Видео генерируется на вашей видеокарте. После единоразовой загрузки моделей интернет больше не нужен.' },
    ],
    tip: 'При первом запуске интерфейс может ждать, пока ComfyUI загрузится — это нормально, дождитесь зелёного индикатора.',
  },
  /* (правка 132) Системные требования — файл подкачки, частая причина ошибок */
  {
    id: 'sys-reqs',
    title: 'Системные требования — файл подкачки',
    short: 'Увеличьте файл подкачки до 32 ГБ, иначе будет ошибка «не хватает памяти».',
    mock: (
      <Stage>
        <Hl n={1}>
          <div className="w-[280px] rounded-xl border border-amber-400/40 bg-amber-500/10 p-3.5 space-y-2.5">
            <div className="flex items-center gap-2">
              <span className="w-9 h-9 rounded-lg bg-amber-500/20 flex items-center justify-center shrink-0">
                <svg className="w-4.5 h-4.5 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>
                  <path d="M12 9v4"/>
                  <path d="M12 17h.01"/>
                </svg>
              </span>
              <div>
                <p className="text-sm font-semibold text-amber-300">Файл подкачки</p>
                <p className="text-[10px] text-muted-foreground">Virtual Memory / Page File</p>
              </div>
            </div>
            <p className="text-xs text-foreground/80 leading-relaxed">
              Программа потребляет много оперативной памяти. Если файл подкачки небольшой — Windows выдаст ошибку «не хватает памяти».
            </p>
            <div className="rounded-lg bg-[var(--surface-2)] px-3 py-2 text-[10px] text-foreground/70 leading-relaxed space-y-1">
              <p className="font-medium text-foreground">Минимум: 32 ГБ (32768 МБ)</p>
              <p>Рекомендуется: 64 ГБ (65536 МБ)</p>
            </div>
          </div>
        </Hl>
        <Hl n={2}>
          <div className="w-[280px] rounded-xl border border-border bg-[var(--surface-1)] p-3.5 space-y-2">
            <p className="text-xs font-semibold text-foreground">Как увеличить (Windows):</p>
            <div className="space-y-1.5 text-[10px] text-muted-foreground leading-relaxed">
              <p><span className="inline-block w-4 h-4 rounded bg-cyan-500/20 text-cyan-300 text-[10px] font-bold text-center leading-4">1</span> Win + R → <code className="font-mono bg-[var(--surface-2)] px-1 rounded">sysdm.cpl</code> → Enter</p>
              <p><span className="inline-block w-4 h-4 rounded bg-cyan-500/20 text-cyan-300 text-[10px] font-bold text-center leading-4">2</span> Вкладка «Дополнительно»</p>
              <p><span className="inline-block w-4 h-4 rounded bg-cyan-500/20 text-cyan-300 text-[10px] font-bold text-center leading-4">3</span> «Быстродействие» → «Параметры» → «Изменить...»</p>
              <p><span className="inline-block w-4 h-4 rounded bg-cyan-500/20 text-cyan-300 text-[10px] font-bold text-center leading-4">4</span> Снять галочку «Автоматически определять размер»</p>
              <p><span className="inline-block w-4 h-4 rounded bg-cyan-500/20 text-cyan-300 text-[10px] font-bold text-center leading-4">5</span> Выбрать диск (обычно C:)</p>
              <p><span className="inline-block w-4 h-4 rounded bg-cyan-500/20 text-cyan-300 text-[10px] font-bold text-center leading-4">6</span> Поставить «Максимальный размер» = <b className="text-foreground">32768</b></p>
              <p><span className="inline-block w-4 h-4 rounded bg-cyan-500/20 text-cyan-300 text-[10px] font-bold text-center leading-4">7</span> «Установить» → «ОК» → <b className="text-foreground">перезагрузить ПК</b></p>
            </div>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-red-400/30 bg-red-500/5 p-3 space-y-1.5">
            <p className="text-[10px] font-semibold text-red-400">❌ Без этого:</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Ошибка «Not enough memory» / «CUDA out of memory» / программа падает при генерации.
            </p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Почему это важно', text: 'Программа (ComfyUI + нейросеть MiniMax H3) потребляет 10–20+ ГБ оперативной памяти во время генерации. Файл подкачки (virtual memory) — это «дополнительная память» на диске, которая подстраховывает, когда RAM не хватает. Если он маленький (Windows по умолчанию ставит 1–4 ГБ) — программа выдаст ошибку.' },
      { n: 2, title: 'Как увеличить', text: 'Win + R → sysdm.cpl → «Дополнительно» → «Быстродействие» → «Параметры» → «Изменить». Снять галочку «Автоматически», выбрать диск, «Максимальный размер» = 32768 (или больше), «Установить» → «ОК» → перезагрузить. Это займёт 30 секунд.' },
      { n: 3, title: 'Симптомы', text: 'Если вы видите ошибки «Not enough memory», «CUDA out of memory», «Page file» или программа просто падает при генерации — скорее всего, файл подкачки слишком маленький. Увеличьте его и перезагрузите ПК.' },
    ],
    tip: 'Это нужно сделать один раз. После увеличения файла подкачки проблема с памятью уходит навсегда.',
  },
  {
    id: 'first-run',
    title: 'Первый запуск — скачиваем модели',
    short: 'Жёлтый баннер → Настройки → скачать. Одноразово, ~50 ГБ.',
    mock: (
      <Stage>
        <Hl n={1}><MockWarningBanner /></Hl>
        <Hl n={2}><MockModelsList /></Hl>
        <Hl n={3}>
          <div className="w-[190px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">Статусы моделей</p>
            <p className="text-[10px] text-muted-foreground">✓ — готово</p>
            <p className="text-[10px] text-muted-foreground">○ — не скачано</p>
            <p className="text-[10px] text-cyan-300">⬇ — качается (% и скорость)</p>
            <p className="text-[10px] text-red-400">! — ошибка (повторите)</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Баннер вверху экрана', text: 'Появляется, когда нужные модели ещё не скачаны, — без них генерация будет работать некорректно. Кнопка «Скачать в настройках» открывает настройки, ✕ временно скрывает баннер.' },
      { n: 2, title: 'Две группы моделей', text: '«Minimax H3 (генерация)» — движок видео: диффузионная модель (FastH3 VSA DataFree 4-step INT8, ~22.9 ГБ), текстовый энкодер (~15.7 ГБ), VAE, апскейлер, Turbo LoRA (~1.8 ГБ) и др. — суммарно ~44.5 ГБ обязательных; Turbo LoRA включена по умолчанию во всех режимах (кроме «Кадров» с аудио), «Скачать все» тянет её вместе с базовыми моделями. «LLM ассистент» — модель чата: по умолчанию Qwen3.5 9B (~5.7 ГБ, vision), альтернативы — Gemma 4 12B (Q3/Q4/Q5) или Bonsai 2 27B (тернарная, ~7.2 ГБ, vision). Дополнительно: модели FPS (RIFE + FILM VFI). Достаточно выбрать ОДНУ LLM-модель.'},
      { n: 3, title: 'Загрузка — фоновая', text: 'Жмёте ⬇ рядом с моделью — видите процент и скорость. Закрыть окно настроек можно в любой момент: скачивание НЕ прервётся и продолжится в фоне, статус будет виден в баннере. Через ✕ загрузку можно остановить и продолжить позже. Скачанные модели остаются в папке models и никуда не денутся.' },
    ],
    tip: 'Уже скачивали модели старой версией программы? Настройки → Общие → «Перенос моделей из старой версии»: выбираете папку со старой сборкой, и программа перенесёт их сама.',
  },
  {
    id: 'interface',
    title: 'Интерфейс — где что находится',
    short: 'Вкладки, датчики, индикатор ComfyUI и настройки.',
    mock: (
      <Stage>
        <Hl n={1}><MockSidebar active="generate" /></Hl>
        <Hl n={2}>
          <div className="w-[210px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <MockLabel>Вкладка «Генерация»</MockLabel>
            <div className="border-2 border-dashed border-border rounded-lg py-2.5 text-center">
              <p className="text-[10px] text-muted-foreground">референсы (необязательно)</p>
            </div>
            <MockPrompt withMention />
            <MockSelect value="1280×704 · 720p" />
            <MockCtaButton label="Сгенерировать видео" />
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span className="text-[10px] text-muted-foreground">ComfyUI подключен</span>
            </div>
            <MockStats />
          </div>
        </Hl>
        <Hl n={4}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">⚙ Настройки — 9 вкладок</p>
            <p className="text-[10px] text-muted-foreground">Общие · Внешний вид · LLM · Голос</p>
            <p className="text-[10px] text-muted-foreground">Оптимизация · Формат · Ссылки</p>
            <p className="text-[10px] text-muted-foreground">О программе · Сброс</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Сайдбар', text: 'Десять вкладок — «Генерация», «Продление», «Refine», «ControlNet», «Tile Upscale», «FPS», «Face Refine», «DLSS», «Галерея», «Обучение». Ассистент живёт правой панелью на вкладках «Генерация» и «Продление» (ширина тянется за край, сворачивается кнопкой). Внизу — индикатор ComfyUI (зелёная точка = нейросеть на ногах) и шестерёнка настроек.' },
      { n: 2, title: 'Рабочее место «Генерация»', text: 'Вся цепочка в одном месте: режим (Текст / Кадры / Референсы) → промпт → рефы (зависит от режима) → разрешение и длительность → «Сгенерировать видео». Ниже — карточка статуса и галерея последних видео.' },
      { n: 3, title: 'Индикатор и датчики', text: 'Красная точка — ComfyUI не запущен: генерация невозможна (галерея и настройки доступны). Датчики VRAM / GPU / RAM — по ним видно, не упёрся ли вы в память видеокарты.' },
      { n: 4, title: 'Настройки — 9 вкладок', text: 'Всё, что программа умеет: модели и LoRA, внешний вид, ассистент, голосовой ввод, оптимизация памяти, формат сохранения видео (кодек и качество), ссылки для ручной загрузки, «О программе» (о проекте и авторе) и «Сброс» (опасная зона). Разберём каждую в последних шагах тура.' },
    ],
    tip: 'Сайдбар сворачивается — если хочется больше места под промпт.',
  },
  /* ═══════════════ ЧАСТЬ 2. ПУТЬ К ВИДЕО ═══════════════ */
  {
    id: 'modes',
    title: 'Шаг 1 — Режим генерации',
    short: 'Три режима: Текст · Кадры · Референсы — подберите под свои данные.',
    mock: (
      <Stage>
        <div className="w-[300px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
          <MockLabel>Режим генерации</MockLabel>
          <div className="grid grid-cols-3 gap-1.5">
            <Hl n={1}>
              <div className="rounded-md border border-cyan-500/50 bg-cyan-500/15 px-2 py-1.5 text-center">
                <p className="text-[10px] font-semibold text-cyan-300">Текст</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">только описание</p>
              </div>
            </Hl>
            <Hl n={2}>
              <div className="rounded-md border border-cyan-500/50 bg-cyan-500/15 px-2 py-1.5 text-center">
                <p className="text-[10px] font-semibold text-cyan-300">Кадры</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">1–2 картинки → видео</p>
              </div>
            </Hl>
            <Hl n={3}>
              <div className="rounded-md border border-cyan-500/50 bg-cyan-500/15 px-2 py-1.5 text-center">
                <p className="text-[10px] font-semibold text-cyan-300">Референсы</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">до 15 файлов</p>
              </div>
            </Hl>
          </div>
          <div className="rounded-md bg-[var(--surface-2)] px-2 py-1.5 space-y-1">
            <p className="text-[10px] text-muted-foreground"><b>Текст:</b> промпт + аудио-рефы (голос/озвучка). Картинки и видео не используются.</p>
            <p className="text-[10px] text-muted-foreground"><b>Кадры:</b> первый и (необязат.) последний кадр + аудио. Соотношение сторон из кадра. Скриншот — Ctrl+V.</p>
            <p className="text-[10px] text-muted-foreground"><b>Референсы:</b> до 15 файлов — 9 картинок, 3 видео, 3 аудио. Полный контроль.</p>
          </div>
        </div>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Текст — видео из описания', text: 'Самый простой режим: вы пишете описание сцены, модель придумывает всё остальное. Можно приложить аудио-файлы (WAV, MP3…) — например, образец голоса для озвучки. Картинки и видео в этом режиме не используются.' },
      { n: 2, title: 'Кадры — видео из картинок', text: 'Задаёте первый кадр (обязательно) и, если хотите, последний. Промпт описывает, что происходит между ними. Картинку можно просто вставить по Ctrl+V — например, скриншот. Соотношение сторон берётся из первого кадра автоматически, поэтому селектор формата заблокирован. Аудио тоже можно приложить.' },
      { n: 3, title: 'Референсы — полный контроль', text: 'До 15 файлов-образцов: 9 картинок (персонажи, объекты, стиль), 3 видео (движение, сцены), 3 аудио (голос, звук). У каждого файла задаётся роль — что именно из него брать. Самый гибкий режим.' },
    ],
    tip: 'Ассистент знает выбранный режим и не добавит в промпт теги, которые не поддерживаются: при переключении на «Текст» метки &lt;Picture N&gt; и &lt;Video N&gt; автоматически уберутся.',
  },
  {
    id: 'refs',
    title: 'Шаг 2 — Референсы (режим «Референсы»)',
    short: 'До 15 файлов: 9 картинок, 3 видео, 3 аудио. Или ноль — тоже можно.',
    mock: (
      <Stage>
        <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <MockLabel>Референсы</MockLabel>
            <span className="text-[10px] text-muted-foreground">1/9 img · 1/3 vid · 0/3 aud</span>
          </div>
          <Hl n={1}><MockRefDropzone /></Hl>
          <Hl n={2}><MockRefCard /></Hl>
          <Hl n={3}>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-[var(--surface-2)] p-2">
              <div className="w-9 h-9 rounded bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center shrink-0">
                <span className="text-[10px] text-cyan-300 font-bold">VID</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] text-foreground truncate font-mono">scene_walk.mp4</p>
                <p className="text-[10px] text-muted-foreground">сцена · движение</p>
              </div>
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
                <span className="w-3 h-3 rounded-sm border border-cyan-500/50 bg-cyan-500/30 inline-flex items-center justify-center text-[10px] text-cyan-200">✓</span>
                использовать звук
              </span>
            </div>
          </Hl>
        </div>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Можно вообще без них', text: 'В режиме «Референсы» генерация запускается и по одному только промпту. Референсы — точность: до 15 файлов — 9 картинок, 3 видео, 3 аудио. Картинки — кто/что, видео — как двигается, аудио — голос и звук. Скриншот можно просто вставить по Ctrl+V. В режиме «Текст» картинки и видео-рефы не используются — только аудио; в режиме «Кадры» картинки задаются полями «Первый кадр» / «Последний кадр». Клик по превью любого референса открывает его на весь экран — так видно детали, которые не разглядеть в маленьком квадрате. Работает одинаково на всех вкладках: «Генерация», «Продление», «Refine», «ControlNet», «FPS», «Upscale».' },
      { n: 2, title: 'Роль референса', text: 'У каждого файла задаётся роль: «персонаж / объект», «сцена», «стиль», «композиция». Это подсказка модели, ЧТО брать из файла: лицо, фон, палитру или ракурс.' },
      { n: 3, title: 'Видео и аудио', text: 'У видео-референса можно галкой включить «использовать звук» — модель возьмёт звук прямо из клипа. Аудио-файлы привязываются к намерению: «Голос», «Темп / ритм» или «Стиль». Аудио можно обрезать прямо в программе: откройте файл кликом и в плеере задайте начало и конец нужного фрагмента.' },
    ],
    tip: 'Лучше всего работают лица/объекты крупным планом при хорошем освещении. Для речей — чистая запись голоса.',
  },
  {
    id: 'prompt',
    title: 'Шаг 3 — Пишем описание (промпт)',
    short: 'Слова решают всё: теги @, озвучка <d>…</d>, диктовка голосом.',
    mock: (
      <Stage>
        <div className="w-[300px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
          {/* Поле промпта + вертикальная колонка кнопок справа (правка 717) */}
          <div className="flex gap-2">
            <div className="flex-1 min-w-0">
              <Hl n={1}><MockPrompt withMention /></Hl>
            </div>
            <div className="flex flex-col items-center gap-1.5 shrink-0">
              <Hl n={3}>
                <div className="flex flex-col items-center gap-1">
                  <span className="w-5 h-5 rounded border border-border bg-[var(--surface-3)] flex items-center justify-center text-[9px] text-muted-foreground">✎</span>
                  <span className="w-5 h-5 rounded border border-border bg-[var(--surface-3)] flex items-center justify-center text-[9px] text-muted-foreground">🗑</span>
                  <span className="w-5 h-5 rounded border border-violet-500/30 bg-[var(--surface-3)] flex items-center justify-center text-[9px] text-violet-300">✦</span>
                </div>
              </Hl>
              <Hl n={2}>
                <span className="w-5 h-5 rounded-full bg-red-500/20 border border-red-400/40 flex items-center justify-center text-[9px]">🎙</span>
              </Hl>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground/70 leading-snug">
            <span className="text-foreground/80">✎</span> редактор ·{' '}
            <span className="text-foreground/80">🗑</span> очистить ·{' '}
            <span className="text-violet-300">✦</span> исправить с ассистентом
          </p>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">Введите <span className="font-mono text-foreground/70">@</span> — появится список референсов</span>
          </div>
          <div className="flex justify-end"><Hl n={4}><MockCtaButton label="Сгенерировать видео" /></Hl></div>
        </div>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Поле промпта и теги', text: 'Опишите сцену словами: кто, где, что делает. Модель заметно лучше понимает АНГЛИЙСКИЙ — идею можно набросать по-русски, но финальный промпт лучше перевести (кнопка «Примеры» даёт готовые английские промпты). Символ @ вставляет тег <Picture 1> — «использовать вот этот референс здесь». Реплики героев оборачивайте в <d>…</d> — они будут озвучены.' },
      { n: 2, title: 'Голосовой ввод (диктофон)', text: 'Круглый микрофон внутри поля промпта: нажали — описываете сцену голосом — нажали ещё раз, и распознанный текст вставится прямо в промпт. Та же кнопка есть в полноэкранном редакторе и в чате Ассистента. Горячая клавиша: R (англ.) / К (рус.) — одна и та же физическая клавиша в обеих раскладках: нажмите, когда фокус НЕ в поле ввода (например, кликните в пустое место рядом) — запись стартует, нажмите ещё раз — стоп и вставка текста. Если диктовка уже идёт — клавиша всегда доводит её до конца. Включается и настраивается в Настройки → Голос.' },
      { n: 3, title: 'Кнопки справа от поля', text: 'Справа от поля промпта стоит вертикальная колонка кнопок: ✎ — полноэкранный редактор (удобно для длинных сценариев), 🗑 — очистить поле (появляется, только когда в поле есть текст), ✦ — «Исправить промпт»: ассистент спросит, что именно изменить, и перепишет черновик. Под ними — круглый микрофон голосового ввода.' },
      { n: 4, title: 'Запуск', text: 'Кнопка активна, когда введён промпт. Ctrl+Enter запускает генерацию прямо из поля ввода.' },
    ],
    tip: 'Пишите кинематографично: «slow camera push-in», «warm sunset light», «speaks in a whisper» — детали улучшают результат.',
  },
  {
    id: 'llm-assistant',
    title: 'Ассистент — напишет промпт за вас',
    short: 'Локальная LLM (Bonsai 2 27B) видит рефы и выдаёт готовый промпт.',
    mock: (
      <Stage>
        <div className="w-[310px] rounded-lg border border-violet-500/25 bg-[var(--surface-1)] p-3 space-y-2.5">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-violet-500/20 border border-violet-500/30 flex items-center justify-center">
              <span className="text-[10px] text-violet-300 font-bold">AI</span>
            </div>
            <div>
              <p className="text-[10px] font-medium text-foreground">Ассистент · Bonsai 2 27B (по умолчанию)</p>
              <p className="text-[10px] text-emerald-400">● локально · видит картинки И видео-кадры</p>
            </div>
          </div>
          <Hl n={1}>
            <div className="rounded-lg border border-border bg-[var(--surface-2)] p-2 space-y-1">
              <p className="text-[10px] text-muted-foreground">Вы: Опиши сцену: девушка с рефа идёт по рынку, говорит привет</p>
              <p className="text-[10px] text-foreground/90 leading-relaxed">A girl with <span className="px-1 py-0.5 rounded bg-purple-500/15 text-purple-300 text-[10px]">&lt;Picture 1&gt;</span> walks through the evening market, string lights… She says: <span className="px-1 py-0.5 rounded bg-amber-500/15 text-amber-300 text-[10px] font-mono">&lt;d&gt;Hi there!&lt;/d&gt;</span> Smooth pan, warm light.</p>
            </div>
          </Hl>
          <Hl n={2}>
            <div className="rounded-lg border border-dashed border-violet-500/30 bg-violet-500/5 p-2 flex items-center gap-2">
              <div className="w-7 h-7 rounded bg-purple-500/20 border border-purple-500/30 flex items-center justify-center shrink-0">
                <span className="text-[10px] text-purple-300 font-bold">IMG</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] text-foreground/90 font-mono truncate">photo_girl.png</p>
                <p className="text-[10px] text-muted-foreground">виден только Ассистенту — в референсы генерации не попадает</p>
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0">✕</span>
            </div>
          </Hl>
          <Hl n={3}>
            <div className="flex items-center gap-2">
              <div className="flex-1 rounded-lg border border-border bg-[var(--surface-2)] px-2.5 py-1.5 text-[10px] text-muted-foreground">Опишите идею сцены…</div>
              <div className="w-7 h-7 rounded-lg bg-violet-500/20 border border-violet-500/30 flex items-center justify-center text-violet-300 text-[10px]">➤</div>
            </div>
          </Hl>
          <div className="flex items-center justify-between gap-2">
            <Hl n={4}>
              <div className="rounded-lg border border-violet-500/30 bg-violet-500/10 px-2.5 py-1.5 text-[10px] text-violet-300 font-medium text-center">✨ Исправить промпт (из редактора)</div>
            </Hl>
            <Hl n={5}>
              <div className="rounded-lg border border-border bg-[var(--surface-2)] px-2 py-1.5 flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">KV-кэш:</span>
                <span className="px-1 py-0.5 rounded text-[10px] border border-border text-muted-foreground">Выкл</span>
                <span className="px-1 py-0.5 rounded text-[10px] border border-border text-muted-foreground">Q8</span>
                <span className="px-1 py-0.5 rounded text-[10px] border border-border text-muted-foreground">Q5</span>
                <span className="px-1 py-0.5 rounded text-[10px] border border-cyan-500/50 bg-cyan-500/15 text-cyan-300 font-medium">Q4</span>
              </div>
            </Hl>
          </div>
        </div>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Локальная модель', text: 'По умолчанию — Qwen3.5 9B (Q4_K_M, ~5.7 ГБ, vision). Альтернативы: Gemma 4 12B (Q3/Q4/Q5) или Bonsai 2 27B (тернарная, ~7.2 ГБ, vision). Всё работает на вашей видеокарте — ничего не уходит в облако. Ассистент видит прикреплённые картинки И видео-кадры, описывает то, что на них, и фиксирует персонажей в промпте — MiniMax не выдумает другие лица.' },
      { n: 2, title: 'Вложения — только в чате', text: 'Картинки и видео, прикреплённые в чате Ассистента, живут ТОЛЬКО в чате: они не попадают в список референсов генерации, в галерею и в Upscale. Их единственная цель — помочь Ассистенту описать сцену и собрать промпт. Картинку можно прикрепить скрепкой или просто вставить по Ctrl+V. Для генерации рефы добавляются отдельно, во вкладке «Генерация».' },
      { n: 3, title: 'Опишите идею по-русски', text: 'Ассистент знает полный гайд MiniMax H3, подберёт правильные теги (<Picture N>, <Video N>, <Audio N>) и выдаст готовый промпт на английском. В шапке полноэкранного редактора есть «Исправить промпт» — спросит, что именно изменить, и отправит черновик с вашим заданием в LLM.' },
      { n: 4, title: 'Видение видео', text: 'Ассистент умеет смотреть видео-референсы: понимает, что происходит в кадре, как двигаются объекты и меняется сцена — а не только первый кадр. Флаг «Видение видео» в Настройки → LLM управляет этим: по умолчанию ВЫКЛЮЧЕНО (экономия памяти и контекста) — включите, если хотите, чтобы ассистент анализировал видео.' },
      { n: 5, title: 'Память длинного чата — KV-кэш', text: 'Долгие диалоги «съедают» память. Квантизация KV-кэша (Настройки → LLM: Q8 / Q5 / Q4) заметно снижает потребление памяти чата с потерей качества, почти неощутимой в ответах. По умолчанию включена Q4 — самый экономный режим; «Выкл» ставят, только если хочется максимальной точности и памяти хватает.' },
    ],
    tip: 'Ассистент не выдумывает теги: если референсов нет — не использует <Picture N>; если есть — привязывает только существующие номера.',
  },
  {
    id: 'resdur',
    title: 'Шаг 4 — Разрешение и длительность',
    short: '480p для проб, 1080p для финала; до ~30 секунд. В режиме «Кадры» — из кадра.',
    mock: (
      <Stage>
        <div className="w-[290px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-3">
          <div className="space-y-1.5">
            <MockLabel>Разрешение</MockLabel>
            <Hl n={1}>
              <div className="space-y-1.5">
                <MockSelect value="1280×704 · 720p" />
                <div className="flex gap-1 flex-wrap">
                  {['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].map((a) => (
                    <span key={a} className={a === '16:9' ? 'px-1.5 py-0.5 rounded text-[10px] border border-cyan-500/50 bg-cyan-500/15 text-cyan-300 font-medium' : 'px-1.5 py-0.5 rounded text-[10px] border border-border text-muted-foreground'}>{a}</span>
                  ))}
                </div>
              </div>
            </Hl>
          </div>
          <div className="space-y-1.5">
            <MockLabel>Свободное разрешение</MockLabel>
            <Hl n={2}>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="px-2 py-1 rounded-md bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 text-[10px] font-medium">Свободное разрешение · вкл</span>
                  <span className="text-[10px] font-mono text-cyan-300/90">0.70 MP (1280×704)</span>
                </div>
                <MockSlider value={40} max={100} />
                <p className="text-[10px] text-muted-foreground/70">ползунок: 0.2–3 МП · <span className="text-cyan-300/80">ручной ввод: до 16 MP</span></p>
              </div>
            </Hl>
          </div>
          <div className="space-y-1.5">
            <MockLabel>Длительность</MockLabel>
            <Hl n={3}>
              <div className="space-y-1">
                <MockSlider value={45} />
                <p className="text-[10px] text-muted-foreground/60">60–719 кадров · выравнивание 17n+5 · ≈ 2.5–30 с · <span className="text-cyan-300/80">ручной ввод кадров</span></p>
              </div>
            </Hl>
          </div>
        </div>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Пресеты и формат кадра', text: 'Качество финального видео: 480p — быстро, 720p — баланс, 1080p — детально, но дольше. Формат кадра выбирается отдельно: 16:9, вертикальное 9:16, квадрат 1:1, 4:3, 3:4 или кинематографичное 21:9. В режиме «Кадры» соотношение сторон автоматически берётся из первого кадра — селектор заблокирован, чтобы не растягивать оригинал.' },
      { n: 2, title: 'Свободное разрешение + ручной ввод', text: 'Выключает пресеты: задаёте итоговый размер в мегапикселях — ширина и высота считаются сами из выбранного формата. Ползунок идёт от 0.2 до 3 МП, а поле ручного ввода позволяет выйти за его рамки — до 16 MP (выше 3 MP — заметно больше VRAM и времени рендера).' },
      { n: 3, title: 'Длительность', text: 'От 2.5 до 30 секунд. Модель работает фиксированными «ступенями» кадров (17n+5), поэтому ползунок прыгает дискретно — это нормально, а не баг. Есть и ручной ввод кадров: значение подстраивается под сетку и границы модели (60–719 кадров). Длинные ролики (20–30 с) генерируются заметно дольше — держите это в уме.' },
    ],
    tip: 'Первые пробы делайте на 480p и короткой длительности — быстрее увидите результат и подберёте промпт.',
  },
  {
    id: 'queue',
    title: 'Запуск и очередь задач',
    short: 'Ставьте несколько видео подряд — очередь всё сделает.',
    mock: (
      <div className="w-full flex flex-col items-center gap-4">
        <div className="flex items-center gap-3 flex-wrap justify-center">
          <Hl n={1}><MockCtaButton label="Сгенерировать видео" /></Hl>
          <Hl n={2}><MockCtaButton label="Ещё в очередь" /></Hl>
        </div>
        <Hl n={3}><MockQueuePill expanded /></Hl>
      </div>
    ),
    callouts: [
      { n: 1, title: 'Запуск', text: 'Одна кнопка — одна задача. Во время генерации подпись меняется на «Ещё в очередь» — так ставят несколько видео подряд.' },
      { n: 2, title: 'Несколько задач', text: 'Задачи выполняются по очереди: первая считается, вторая ждёт. Можно уйти в галерею или перезагрузить страницу — очередь продолжит работать. При перезапуске программы студия сверяется с ComfyUI: если задачи там действительно нет, «висящая» генерация снимается и помечается прерванной — карточка не будет вечно показывать «идёт» (правка 718).' },
      { n: 3, title: 'Плавающая очередь (правый нижний угол)', text: 'Статусы, проценты и счётчик задач. Клик — список; ✕ у задачи — отмена (выполняемая остановится, готовые файлы не пострадают).' },
    ],
    tip: 'Отмена — это не ошибка: вы увидите спокойное уведомление «Генерация отменена», а не красный алерт.',
  },
  {
    id: 'progress',
    title: 'Прогресс генерации',
    short: 'Общий прогресс 0→100% через оба прохода, живой черновик кадра.',
    mock: (
      <Stage>
        <div className="space-y-2 rounded-lg border border-border bg-[var(--surface-1)] p-3 w-full max-w-[280px]">
          <Hl n={1}>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-cyan-400 font-medium">Генерация… 42%</span>
                <span className="text-muted-foreground font-mono">0:47</span>
              </div>
              <MockBar pct={42} />
            </div>
          </Hl>
          <Hl n={2}>
            <div className="rounded-lg border border-cyan-500/20 bg-black/40 h-20 relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-cyan-950/60 to-blue-950/40" />
              <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-black/60 rounded text-[10px] text-cyan-300 font-medium">Pass 1 · шаг 2/3</div>
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-16 h-9 rounded bg-[var(--surface-3)]/60 border border-cyan-500/30 creative-pulse" />
              </div>
            </div>
          </Hl>
          <Hl n={3}>
            <p className="text-[10px] text-red-400/70 text-center py-0.5">Остановить</p>
          </Hl>
        </div>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Статус-карточка (низ левой панели)', text: 'Фаза («В очереди» → «Генерация… 42%» → «Готово ✓»), таймер и полоса прогресса.' },
      { n: 2, title: 'Живое превью и общий прогресс', text: 'Черновой кадр прямо во время генерации — и на первом, и на втором проходе. Полоса прогресса показывает ОБЩЕЕ выполнение (0→100%) через оба прохода — не сбрасывается между ними. Подпись «Pass 1 · шаг 2/3» — текущий проход внутри.' },
      { n: 3, title: 'Остановить', text: 'Прерывает ВСЕ активные видео-задачи; частичного файла не будет.' },
    ],
    tip: 'Видео ~5 секунд на 480p обычно занимает 1–3 минуты, на 1080p — заметно дольше.',
  },
  {
    id: 'gallery',
    title: 'Галерея готовых видео',
    short: 'Все ролики: hover-проигрывание, метки источника (Draft, DLSS 5, Refined…).',
    mock: (
      <div className="w-full max-w-[330px]">
        <div className="flex items-center justify-between mb-1.5">
          <span className="px-2 py-0.5 rounded-md bg-[var(--surface-2)] border border-border text-[10px] text-foreground">5 видео</span>
          <span className="text-[10px] text-muted-foreground">↻</span>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <Hl n={1}><MockGalleryTile index={5} /></Hl>
          <Hl n={2}><MockGalleryTile hovered index={4} /></Hl>
          <Hl n={3}><MockGalleryTile index={3} /></Hl>
          <Hl n={4}><MockGalleryTile upscaled index={2} /></Hl>
          <MockGalleryTile index={1} />
          <MockGalleryTile index={0} />
        </div>
      </div>
    ),
    callouts: [
      { n: 1, title: 'Постеры и порядок', text: 'Каждое видео — карточка с кадром-постером, новые сверху. Наведите курсор — ролик заиграет прямо в сетке (без звука).' },
      { n: 2, title: 'Действия при наведении', text: 'Кнопка «⋮» в правом верхнем углу превью — открывает выпадающее меню: скачать, метаданные, повторить генерацию, апскейл (DLSS 5), рефайн (v2v), Tile Upscale, Face Refine, ControlNet (движение), увеличить FPS, продлить, обрезать и удалить. В плеер видео открывается кликом по самой карточке. Меню не обрезается карточкой (правка 282). Ctrl+клик по двум карточкам выделяет пару для сравнения «до / после» — следующий шаг тура.' },
      { n: 3, title: 'Бейдж времени', text: 'Светящаяся подпись «1 мин 12 сек» — сколько заняла ГЕНЕРАЦИЯ видео (не его длина), число берётся из метаданных.' },
      { n: 4, title: 'Метки на карточках', text: 'Вверху слева на карточке горит метка — откуда взялось видео: «Upscale» (голубая) и «DLSS 5» (розовая) — улучшенные копии после апскейла, «Refined» (зелёная) — результат вкладки «Refine», «Tile» (розово-пурпурная) — Tile Upscale, «FPS» (фиолетовая), «Extended» (голубая) — результат продления, «ControlNet» (оранжевая, «ControlNet x2» — в двухпроходном режиме), «Face Refine» (салатовая) — перерисованные лица, «Edited» (жёлтая) — обрезка. Отдельно «Draft» (красная) — видео, сгенерированное в быстром режиме «Драфт» одним проходом (его можно довести до качества вкладкой «Refine»). Метка на карточке ВСЕГДА ОДНА: если файл прошёл через несколько вкладок, показывается последняя операция — например, обрезанный драфт помечен «Edited» (жёлтая), а не «Draft». Метки видны всегда, не только при наведении.' },
    ],
    tip: 'Стрелка ↻ обновляет список вручную — обычно он обновляется сам.',
  },
  /* (правка 91/122) Папки проектов — организация галереи, в туре не было */
  {
    id: 'folders',
    title: 'Папки проектов — порядок в галерее',
    short: 'Группируйте видео по проектам: создание, drag&drop, переименование.',
    mock: (
      <Stage>
        <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <MockLabel>Галерея · папки</MockLabel>
            <span className="text-[10px] text-muted-foreground">+ Новая папка</span>
          </div>
          <Hl n={1}>
            <div className="flex gap-1 flex-wrap">
              {['Все видео', 'Реклама', 'Отпуск', 'Тесты'].map((f, i) => (
                <span
                  key={f}
                  className={
                    i === 0
                      ? 'px-2 py-1 rounded-md text-[10px] border border-cyan-500/50 bg-cyan-500/15 text-cyan-300 font-medium'
                      : 'px-2 py-1 rounded-md text-[10px] border border-border text-muted-foreground'
                  }
                >
                  {f}
                </span>
              ))}
            </div>
          </Hl>
          <Hl n={2}>
            <div className="grid grid-cols-3 gap-1.5">
              <MockGalleryTile index={5} />
              <MockGalleryTile index={4} />
              <div className="rounded-md border border-dashed border-cyan-500/40 bg-cyan-500/5 aspect-video flex items-center justify-center">
                <span className="text-[10px] text-cyan-300">↔ перетащите видео сюда</span>
              </div>
            </div>
          </Hl>
        </div>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">Вкладка «Генерация»</p>
            <div className="rounded-md border border-border bg-[var(--surface-2)] px-2 py-1.5 text-[10px] text-foreground/80">
              📁 Папка проекта: <span className="text-cyan-300">Отпуск</span> ▾
            </div>
            <p className="text-[10px] text-muted-foreground leading-relaxed">Новые видео лягут в выбранную папку</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Папки в галерее', text: 'Кнопка «Новая папка» создаёт подпапку в output — группируйте видео по проектам («Реклама», «Отпуск»…). Клик по папке фильтрует сетку; «Все видео» показывает всё подряд. Пустую папку можно удалить, непустую — сначала очистить.' },
      { n: 2, title: 'Перетаскивание и переименование', text: 'Видео перетаскивается в папку drag-and-drop прямо по карточке. Имя папки можно поменять — видео внутри останутся на месте. Файлы не копируются, а переезжают, поэтому метаданные и бейджи времени никуда не теряются.' },
      { n: 3, title: 'Папка на вкладке «Генерация»', text: 'Рядом с кнопкой генерации есть выбор папки проекта (появляется, когда папки уже созданы): все новые видео этой сессии лягут в неё. Выбор папки на вкладке «Генерация» не зависит от фильтра в «Галерее» — у каждой вкладки свой актив. Такой же выбор есть и на вкладке «ControlNet». Остальные вкладки-обработки (Refine, FPS, Tile Upscale, Face Refine, Продление, DLSS) кладут результат в папку исходника автоматически.' },
    ],
    tip: 'Метаданные и бейджи времени переезжают вместе с видео — ничего не теряется.',
  },
  {
    id: 'player',
    title: 'Видеоплеер',
    short: 'Клик по видео — пауза, клик по чёрному — закрыть.',
    mock: (
      <div className="w-full max-w-[320px] space-y-2">
        <Hl n={1}><MockLightbox /></Hl>
        <Hl n={2}>
          <div className="flex items-center justify-center gap-3 text-[10px] text-muted-foreground border border-border rounded-lg py-1.5 bg-[var(--surface-2)]/60">
            <span>Space — пауза</span><span>M — звук</span><span>←→ — видео</span><span>Esc — выход</span>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="flex items-center justify-center gap-3 text-[10px]">
            <span className="p-1.5 rounded-lg bg-white/10 text-white">⬇ Скачать</span>
            <span className="p-1.5 rounded-lg bg-red-500/40 text-white">🗑 Удалить</span>
          </div>
        </Hl>
      </div>
    ),
    callouts: [
      { n: 1, title: 'Плеер на весь экран', text: 'Открывается кликом по карточке в галерее. Клик по САМОМУ ВИДЕО — пауза/воспроизведение, клик по чёрной области вокруг — закрыть плеер. Полоса внизу — перемотка.' },
      { n: 2, title: 'Горячие клавиши', text: 'Space — пауза, M — звук, стрелки ← → — следующее/предыдущее видео, Esc — выход.' },
      { n: 3, title: 'Скачивание и удаление', text: '⬇ сохраняет файл на диск (имя начинается с Minimax_Studio). Корзина удаляет видео из папки вывода после подтверждения — файл пропадёт и с диска.' },
    ],
    tip: 'Звук генерируется тоже: модель озвучивает реплики из <d>…</d> и учитывает аудио-референсы.',
  },
  {
    id: 'upscale',
    title: 'Upscale — сделать видео чётче',
    short: 'Два режима: Neural Rendering (DLSS 5) и RTX VSR 1×–4× (HDR отключён).',
    mock: (
      <Stage>
        <Hl n={1}><MockUpscalePanel /></Hl>
        <Hl n={2}>
          <div className="w-[220px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <p className="text-[10px] font-semibold text-foreground">Результат — в общей галерее</p>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="rounded-md border border-border bg-[var(--surface-2)]/70 p-1.5 space-y-1">
                <span className="inline-flex items-center gap-0.5 rounded bg-black/60 px-1 py-0.5 text-[10px] font-semibold text-sky-300 border border-sky-400/40">✦ Upscale</span>
                <p className="text-[10px] text-muted-foreground">RTX VSR</p>
              </div>
              <div className="rounded-md border border-border bg-[var(--surface-2)]/70 p-1.5 space-y-1">
                <span className="inline-flex items-center gap-0.5 rounded bg-black/60 px-1 py-0.5 text-[10px] font-semibold text-fuchsia-300 border border-fuchsia-400/40">✦ DLSS 5</span>
                <p className="text-[10px] text-muted-foreground">Neural Rendering</p>
              </div>
            </div>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[180px] rounded-lg border border-violet-500/25 bg-[var(--surface-1)] p-2.5 space-y-1">
            <p className="text-[10px] font-semibold text-foreground">Требования</p>
            <p className="text-[10px] text-muted-foreground">• видеокарта NVIDIA RTX</p>
            <p className="text-[10px] text-muted-foreground">• только видео (MP4 / MOV / MKV…)</p>
            <p className="text-[10px] text-muted-foreground">• обработка — на вашей GPU</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Два режима обработки', text: 'Neural Rendering (DLSS 5) — нейросеть «перерисовывает» кадр: настраиваются шум, тон, структура и выбирается пресет — качество растёт, но скорость падает. RTX Video Super Resolution — ускорение 1×–4× (включая 1.5×; HDR отключён — H.264 не поддерживает HDR-вывод) — быстрее и легче для GPU. Режим выбирается прямо на вкладке, кнопка запуска меняется под него.' },
      { n: 2, title: 'Куда попадает результат', text: 'Апскейл-видео сохраняется в галерею — в ТУ ЖЕ папку проекта, где лежит исходник (файл с диска без папки попадёт в общую). Ролик получает метку: «Upscale» (голубая) — RTX VSR или «DLSS 5» (розовая) — Neural Rendering. Метка видна на карточке всегда — исходник и улучшенную копию не перепутать.' },
      { n: 3, title: 'Требования', text: 'Нужна видеокарта NVIDIA RTX; обрабатываются только видеофайлы (MP4 / MOV / MKV и др.). Всё считается локально, на вашей GPU — файл никуда не отправляется.' },
    ],
    tip: 'Не уверены, какой режим выбрать — начните с RTX VSR 2×: быстрее всего и обычно достаточно для «зерна» и размытия.',
  },
  /* ═══════════════ НОВЫЕ ВКЛАДКИ (правки 272–283) ═══════════════ */
  {
    id: 'extend',
    title: 'Продление — продолжить видео',
    short: 'Возьмите готовый ролик и продолжите его на N секунд.',
    mock: (
      <Stage>
        <Hl n={1}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <MockLabel>Источник видео</MockLabel>
            <div className="border-2 border-dashed border-cyan-500/40 rounded-lg py-3 text-center">
              <p className="text-[10px] text-cyan-300 font-medium">Перетащите видео или кликните для выбора</p>
              <p className="text-[10px] text-muted-foreground mt-1">MP4 / MOV / MKV</p>
            </div>
          </div>
        </Hl>
        <Hl n={2}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <div className="space-y-1.5">
              <MockLabel>Длительность продолжения</MockLabel>
              <MockSlider value={45} />
              <p className="text-[10px] text-muted-foreground/60">от 3 до 30 секунд на каждый новый кусок</p>
            </div>
            <div className="space-y-1.5">
              <MockLabel>Промпт для продолжения</MockLabel>
              <div className="rounded-lg border border-border bg-[var(--surface-2)] px-2.5 py-2 text-[10px] text-muted-foreground">Опишите, что должно произойти дальше…</div>
            </div>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">Как работает</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">Последний кадр исходника становится первым кадром нового ролика. Промпт описывает развитие сюжета.</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Загрузка видео', text: 'Перетащите файл в поле или кликните, чтобы выбрать с диска. Поддерживаются MP4, MOV, MKV. Видео можно взять прямо из галереи: перетащите превьюшку в поле загрузки. Перед обработкой ролик автоматически приводится к 24 кадрам в секунду — так работает модель.' },
      { n: 2, title: 'Параметры', text: 'Для каждого нового куска задаются длительность (3–30 секунд — совсем короткие куски могут дать заметный скачок на стыке) и промпт — что должно произойти дальше. Можно добавить несколько кусков подряд. Переключатель «Качество прохода»: «Полное» (по умолчанию) — каждый кусок генерируется в черновом разрешении и тут же дорисовывается до разрешения исходника; «Драфт» — быстрее, но проще по качеству. «Шаги сэмплера» — по умолчанию «авто»: программа берёт шаги первого прохода из метаданных исходника (нет метаданных — как на вкладке «Генерация»); можно задать вручную (2–30), тогда применяется ваше значение. Готовое видео из галереи можно продолжить, не перетаскивая, — кнопкой «Продлить» на карточке.' },
      { n: 3, title: 'Результат', text: 'Программа сама склеивает исходный ролик с новыми кусками в один бесшовный файл. Готовое видео сохраняется в ту же папку, где лежит оригинал. Исходный ролик остаётся нетронутым.' },
    ],
    tip: 'Хороший промпт для продолжения — это развитие сюжета: «The camera follows her as she turns the corner and sees the ocean».'
  },
  {
    id: 'refine',
    title: 'Refine — улучшить качество видео',
    short: 'Повторная генерация с теми же референсами, но в большем разрешении.',
    mock: (
      <Stage>
        <Hl n={1}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <MockLabel>Целевое разрешение</MockLabel>
            <MockSelect value="Как в исходнике (только детализация)" />
            <div className="flex gap-1 flex-wrap">
              {['Исходник', '720p', '1080p'].map((r, i) => (
                <span key={r} className={i === 0 ? 'px-1.5 py-0.5 rounded text-[10px] border border-cyan-500/50 bg-cyan-500/15 text-cyan-300 font-medium' : 'px-1.5 py-0.5 rounded text-[10px] border border-border text-muted-foreground'}>{r}</span>
              ))}
            </div>
          </div>
        </Hl>
        <Hl n={2}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <div className="space-y-1.5">
              <MockLabel>Проход (шаги)</MockLabel>
              <MockSelect value="3 шага — быстро (эталон)" />
              <p className="text-[10px] text-muted-foreground/70">2 шага — самый быстрый · <span className="text-cyan-300/80">по умолчанию 3</span> · 4–7 — больше деталей</p>
            </div>
            <div className="space-y-1.5">
              <MockLabel>Влияние Refine</MockLabel>
              <MockSlider value={60} />
              <p className="text-[10px] text-muted-foreground/70">30–95% · выше — сильнее перерисовка</p>
            </div>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-violet-500/25 bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">Что делает Refine</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">Прогоняет готовое видео через нейросеть ещё раз в бóльшем разрешении: промпт и референсы подставляются из метаданных оригинала. Не просто апскейл — нейросеть «дорисовывает» детали.</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Разрешение и режим', text: 'Четыре цели: «Как в исходнике» (разрешение не меняется — только детализация, самый бережный вариант), «720p» (быстрее, безопаснее по памяти), «1080p» (медленнее, максимум деталей) и «Свободное» (задаётся в мегапикселях, до 4K). Два режима обработки: «Целый» — всё видео одним куском; «Частями» — кусками по ~3/5/8 секунд с бесшовной склейкой, подходит для длинных роликов и экономит память.' },
      { n: 2, title: 'Шаги и сила перерисовки', text: '«Проход (шаги)»: 2 — самый быстрый, 3 — по умолчанию (тот же эталонный профиль сигм, что и pass 2 в генерации), 4–7 — детальнее, но дольше (те же лестницы сигм, что у Pass 2 генерации; 7 — максимум). «Влияние Refine» (30–95%) — насколько сильно нейросеть перерисовывает кадр: выше — больше новых деталей, ниже — ближе к оригиналу; по умолчанию 60%. Под слайдером видна фактическая лестница сигм, которую получит сэмплер, а кнопка «Pass 2» одним нажатием ставит точную эталонную лестницу второго прохода генерации (3 шага от σ 0.9035). Промпт и референсы берутся из сохранённых метаданных оригинала (у продленных видео сохраняются все промпты кусков). Режим референсов Match / Max настраивается отдельно: Match — быстрее, Max — точнее держит лица (по умолчанию Max).' },
      { n: 3, title: 'Отличие от DLSS', text: 'Refine — это повторная генерация (нейросеть «думает» над кадром), а не простое увеличение картинки. Медленнее, но качество выше: детали, текстуры, лицо перерисовываются, а не растягиваются. Хорошо подходит для апгрейда «драфтов» из вкладки «Генерация».' },
    ],
    tip: 'Для исходника 720p — ставьте цель 1080p. Если результат ушёл далеко от оригинала — снизьте «Влияние Refine» до 40–50%.'
  },
  {
    id: 'tile-upscale',
    title: 'Tile Upscale — чанковый апскейл',
    short: 'Увеличение разрешения тайлами: экономия VRAM, 720p–2160p.',
    mock: (
      <Stage>
        <Hl n={1}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <MockLabel>Разрешение</MockLabel>
            <div className="flex gap-1 flex-wrap">
              {['720p', '1080p', '1440p', '2160p'].map((r, i) => (
                <span key={r} className={i === 1 ? 'px-1.5 py-0.5 rounded text-[10px] border border-cyan-500/50 bg-cyan-500/15 text-cyan-300 font-medium' : 'px-1.5 py-0.5 rounded text-[10px] border border-border text-muted-foreground'}>{r}</span>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground/70 mt-1">Защита: нельзя выбрать разрешение меньше исходника</p>
          </div>
        </Hl>
        <Hl n={2}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <div className="space-y-1.5">
              <MockLabel>Денойз</MockLabel>
              <MockSlider value={20} />
              <p className="text-[10px] text-muted-foreground/70">0.05–1.0 · по умолчанию 0.2 (бережно)</p>
            </div>
            <div className="space-y-1.5">
              <MockLabel>Шаги</MockLabel>
              <MockSelect value="2 шага (по умолчанию) · до 8" />
            </div>
            <div className="space-y-1.5">
              <MockLabel>▼ Дополнительные параметры</MockLabel>
              <MockSelect value="SyncTile (швы без мерцания): Вкл" />
            </div>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-violet-500/25 bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">Как работает</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">Видео разбивается на тайлы (чанки), каждый апскейлится отдельно. Экономит VRAM — можно гнать 4K даже на 12 ГБ.</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Разрешение', text: 'Выберите из 720p, 1080p, 1440p, 2160p. Защита: нельзя выбрать разрешение меньше исходника (например, для 2160p исходника нельзя поставить 720p).' },
      { n: 2, title: 'Основные настройки', text: 'Деноизинг (сила перерисовки) 0.05–1.0, по умолчанию 0.2 — бережный режим: детали добавляются, но исходник почти не меняется; выше — сильнее перерисовка, но больше риск «поплывшего» результата. Шаги — 2, 3, 4, 5, 6 или 8, по умолчанию 2; больше шагов дольше, а заметного прироста не даёт. В «Дополнительных параметрах» (кнопка ▼) живёт SyncTile — технология, которая убирает мерцание и видимые швы на стыках тайлов; включена по умолчанию, отключать не нужно. Если в настройках включены свои LoRA — они применяются и здесь (правка 483).' },
      { n: 3, title: 'Чанки', text: 'Разбиение на тайлы включено по умолчанию для экономии памяти. На слабых GPU это позволяет апскейлить до 4K без OOM.' },
    ],
    tip: 'Для 720p исходника — ставьте 1080p или 1440p. 2160p — только если VRAM позволяет (12+ ГБ).' 
  },
  {
    id: 'controlnet',
    title: 'ControlNet — точный перенос движения',
    short: 'Генерация по контрольному видео: 3D-болванка задаёт движение и камеру покадрово.',
    mock: (
      <Stage>
        <Hl n={1}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <MockLabel>Контрольное видео (болванка)</MockLabel>
            <div className="rounded-md border border-dashed border-orange-500/40 bg-orange-500/5 px-2 py-2 text-center">
              <p className="text-[10px] text-orange-300">Перетащите видео из галереи или выберите с диска</p>
            </div>
            <MockLabel>Тип контроля</MockLabel>
            <div className="flex gap-1">
              <span className="px-1.5 py-0.5 rounded text-[10px] border border-orange-500/50 bg-orange-500/15 text-orange-300 font-medium">Глубина (Depth)</span>
              <span className="px-1.5 py-0.5 rounded text-[10px] border border-border text-muted-foreground">Контуры (Canny)</span>
            </div>
          </div>
        </Hl>
        <Hl n={2}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <div className="space-y-1.5">
              <MockLabel>Сила контроля</MockLabel>
              <MockSlider value={50} />
              <p className="text-[10px] text-muted-foreground/70">0–2 · по умолчанию 1.0</p>
            </div>
            <div className="space-y-1.5">
              <MockLabel>Промпт</MockLabel>
              <p className="text-[10px] text-muted-foreground/70">Описание НОВОЙ сцены: персонажи, стиль, свет, звук</p>
            </div>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-violet-500/25 bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">Как работает</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">С болванки снимается карта глубины (или контуры) покадрово, и нейросеть генерирует новое видео, точно повторяя движение и камеру.</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Контрольное видео', text: 'Источник движения: 3D-болванка (previz из Blender и т.п.), черновая анимация или любой ролик, чьё движение камеры и объектов нужно повторить. Внешний вид источника НЕ переносится — только движение. Видео можно перетащить из галереи (или через меню ⋮ → «ControlNet (движение)») либо выбрать с диска. Режим работает на той же модели MiniMax H3, что и обычная генерация, — отдельных моделей ControlNet не требуется. Дополнительно нужен препроцессор глубины Depth Anything V2 Small (~99 МБ) — он в Настройках → Модели, категория «Препроцессоры»; он же помечен «опционально», то есть без него препроцессинг карты глубины не запустится. Кроме промпта можно добавить картинки-референсы — персонаж, локация или кадр (до 9 шт.); в промпте на них ссылаются как <Picture 1>, <Picture 2>… (правка 498).' },
      { n: 2, title: 'Тип контроля и настройки', text: '«Глубина (Depth)» — универсальный вариант: переносит объёмы сцены и движение камеры (нужна маленькая модель Depth Anything, качается там же). «Контуры (Canny)» — следует границам объектов, хорош для чёткой графики. «Сила контроля» 1.0 — строгое следование; меньше — свободнее. «Отпустить контроль после» (например 0.6) — в конце генерации модель дорисует детали свободнее, полезно если картинка выходит «плоской». Шаги пайплайна здесь такие же, как на вкладке «Генерация»: точка сплита и «Всего шагов (pass 1)» — по умолчанию 6 из 6.' },
      { n: 3, title: 'Когда что выбрать', text: 'ControlNet — когда движение должно совпадать ТОЧНО (покадрово). Если достаточно переноса «по мотивам» — проще вкладка «Генерация», режим «Референсы» + тогл «3D → Video» в чате ассистента: там движение передаётся текстовой ссылкой на видео-референс, но менее строго.' },
    ],
    tip: 'Длительность результата обрезается под длину контрольного видео — болванка должна быть нужной длины. Промпт пишите про новую сцену, движение описывать не нужно.'
  },
  {
    id: 'face-refine',
    title: 'Face Refine — перерисовка мелких лиц',
    short: 'Перерисовать лицо: кроп крупно, H3, вклейка обратно.',
    mock: (
      <Stage>
        <Hl n={1}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <MockLabel>Кого перерисовывать</MockLabel>
            <div className="rounded-md border border-dashed border-border px-2 py-2 text-center">
              <p className="text-[10px] text-muted-foreground">◎ Указать лицо кликом по кадру</p>
            </div>
            <MockSelect value="Самое крупное лицо" />
            <MockLabel>Референс конкретного человека</MockLabel>
            <div className="rounded-md border border-dashed border-yellow-500/40 bg-yellow-500/5 px-2 py-2 text-center">
              <p className="text-[10px] text-yellow-300">Загрузить фото человека</p>
            </div>
          </div>
        </Hl>
        <Hl n={2}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <div className="space-y-1.5">
              <MockLabel>Денойз</MockLabel>
              <MockSlider value={35} />
              <p className="text-[10px] text-muted-foreground/70">0.05–0.6 · по умолчанию 0.35</p>
            </div>
            <div className="space-y-1.5">
              <MockLabel>Канва</MockLabel>
              <MockSelect value="512" />
            </div>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-yellow-500/25 bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">Как работает</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">Лицо детектится покадрово, кропится крупно, перегенерируется нейросетью и вклеивается обратно — только область лица.</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Кого именно', text: 'Для лица три способа: клик по лицу в кадре исходника — самый точный (трекер возьмёт ближайшее к точке лицо и поведёт этого человека через весь ролик); правило («Самое крупное лицо», «Ближе к центру»…) плюс номер в рейтинге — работает всегда, но видит только геометрию кадра; референс-фото конкретного человека — сравнение лиц через insightface (модель buffalo_l скачивается сама).' },
      { n: 2, title: 'Денойз и канва', text: 'Денойз — насколько сильно перерисовывается лицо. Значения из SDXL-семейства здесь не переносятся: H3 — flow matching со сдвигом 12, поэтому 0.25 превращается в эффективную sigma 0.800 и переписывает кадр целиком. Рабочий диапазон 0.25–0.40. Канва — размер, в котором лицо перегенерируется: 512 дешевле 768 примерно в 2.25 раза по памяти, на 12 ГБ начинайте с 512; пресеты идут до 1280 — значения выше 768 заметно дороже по VRAM и времени (модель обучена на канве до 768×1344). Шаги — 4 (наша модель 4-шаговая).' },
      { n: 3, title: 'Когда применять', text: 'Когда лицо в кадре мелкое и «какое-то» — на дальних планах, в группах, в профиль. Лицо находит и перерисовывает та же нейросеть, что и генерацию, поэтому стиль и личность сохраняются. Промпт и референсы персонажа берутся из метаданных исходного ролика — сцена остаётся той же; свой промпт можно задать вручную. Остальной кадр не трогается: вклеивается только область лица.' },
    ],
    tip: 'Во время прогона внизу показывается живое превью кадров. Если лица не видно (человек спиной, в капюшоне), включите «Далёкие планы: искать человека» в дополнительных параметрах — голова берётся от бокса человека. Результат — обычное видео в общей галерее с меткой «Face Refine». Его можно дальше апскейлить, отпродлить или перегенерировать.'
  },
  {
    id: 'fps',
    title: 'FPS — увеличение частоты кадров',
    short: 'RIFE VFI и FILM VFI: плавность движения на слабых GPU.',
    mock: (
      <Stage>
        <Hl n={1}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <MockLabel>Режим</MockLabel>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="rounded-md border border-cyan-500/50 bg-cyan-500/15 px-2 py-1.5 text-center">
                <p className="text-[10px] font-semibold text-cyan-300">RIFE VFI</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">быстрее</p>
              </div>
              <div className="rounded-md border border-border px-2 py-1.5 text-center">
                <p className="text-[10px] text-muted-foreground">FILM VFI</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">качественнее</p>
              </div>
            </div>
          </div>
        </Hl>
        <Hl n={2}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <div className="space-y-1.5">
              <MockLabel>Множитель</MockLabel>
              <MockSelect value="×2 (48 fps из 24)" />
              <p className="text-[10px] text-muted-foreground/70">×2, ×3, ×4 — сколько раз увеличить FPS</p>
            </div>
            <div className="space-y-1.5">
              <MockLabel>Источник видео</MockLabel>
              <div className="border-2 border-dashed border-cyan-500/40 rounded-lg py-2 text-center">
                <p className="text-[10px] text-cyan-300">Перетащите или кликните</p>
              </div>
            </div>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-violet-500/25 bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">VFI — что это</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">Video Frame Interpolation: нейросеть «дорисовывает» промежуточные кадры между существующими. 24 fps → 48 fps (×2) — движение становится плавнее.</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Два режима', text: 'RIFE VFI — быстрый, подходит для слабых GPU. FILM VFI — качественнее, но тяжелее. Оба работают локально, на вашей видеокарте.' },
      { n: 2, title: 'Множитель', text: '×2 — удвоение FPS (24→48), ×3 — утроение (24→72), ×4 — учетверение (24→96). Чем выше множитель — тем дольше обработка и больше VRAM.' },
      { n: 3, title: 'Результат', text: 'Видео с плавным движением сохраняется в общую галерею. Исходный файл остаётся нетронутым.' },
    ],
    tip: 'Начните с ×2 — это оптимальный баланс скорости и плавности. Для 4K видео на слабом GPU — RIFE VFI + Анти-OOM.'
  },
  {
    id: 'meta',
    title: 'Метаданные — рецепт видео',
    short: 'Промпт + seed = точное повторение удачного видео.',
    mock: (
      <Stage>
        <div className="flex items-center gap-4 flex-wrap justify-center">
          <Hl n={1}><MockMetaDialog /></Hl>
          <Hl n={2}>
            <div className="w-[120px] aspect-video rounded-lg border border-border bg-[var(--surface-2)] relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-violet-900/30 to-cyan-900/20" />
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="p-1.5 rounded-lg bg-white/20 text-[10px] text-white">ⓘ</span>
              </div>
            </div>
          </Hl>
        </div>
        <Hl n={3}>
          <div className="flex items-center gap-2 justify-center rounded-lg border border-border bg-[var(--surface-2)]/60 px-4 py-1.5 text-[10px] text-muted-foreground">
            📋 Скопировать промпт и seed → повторить генерацию
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Что внутри', text: 'Промпт, seed, разрешение, шаги обоих проходов, референсы и их роли, время генерации и дата — полный рецепт того, КАК получено видео.' },
      { n: 2, title: 'Как открыть', text: 'Кнопка ⓘ на карточке в галерее (при наведении).' },
      { n: 3, title: 'Повторить результат', text: 'Понравилось? Скопируйте промпт и seed из метаданных и выставьте те же параметры — генерация воспроизведётся почти идентично.' },
    ],
    tip: 'Метаданные лежат рядом с видео в файле <имя>.meta.json — при переносе папки копируйте и его.',
  },
  /* (правки 728–730) Сравнение двух видео — шторка до/после */
  {
    id: 'compare',
    title: 'Сравнение двух видео — шторка до / после',
    short: 'Ctrl+клик по двум карточкам → «Сравнить» (или Enter).',
    mock: (
      <Stage>
        <Hl n={1}>
          <div className="w-[240px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <MockLabel>Галерея · выделение</MockLabel>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="relative rounded-md overflow-hidden border-2 border-cyan-500/70">
                <div className="aspect-video bg-gradient-to-br from-cyan-900/50 to-blue-950/40" />
                <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-cyan-500 text-black text-[9px] font-bold">A</span>
                <span className="absolute bottom-1 left-1 text-[9px] text-cyan-300 font-mono">до · слева</span>
              </div>
              <div className="relative rounded-md overflow-hidden border-2 border-fuchsia-500/70">
                <div className="aspect-video bg-gradient-to-br from-fuchsia-900/50 to-purple-950/40" />
                <span className="absolute top-1 right-1 px-1.5 py-0.5 rounded bg-fuchsia-500 text-black text-[9px] font-bold">B</span>
                <span className="absolute bottom-1 left-1 text-[9px] text-fuchsia-300 font-mono">после · справа</span>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground/70">третий Ctrl+клик вытесняет самый первый</p>
          </div>
        </Hl>
        <Hl n={2}>
          <div className="w-[240px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <div className="relative h-24 rounded-lg overflow-hidden bg-black/60">
              <div className="absolute inset-0 bg-gradient-to-br from-fuchsia-950/40 to-black" />
              <div className="absolute inset-y-0 left-0 w-1/2 bg-gradient-to-br from-cyan-950/50 to-black border-r-2 border-white/80" />
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-white text-black flex items-center justify-center text-[10px] font-bold">⇔</div>
              <span className="absolute top-1 left-1 px-1 py-0.5 rounded bg-black/60 text-[9px] text-cyan-300 font-bold border border-cyan-400/40">A</span>
              <span className="absolute top-1 right-1 px-1 py-0.5 rounded bg-black/60 text-[9px] text-fuchsia-300 font-bold border border-fuchsia-400/40">B</span>
            </div>
            <p className="text-[10px] text-muted-foreground/70">тяните шторку мышью или пальцем</p>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1">
            <p className="text-[10px] font-semibold text-foreground">Клавиши</p>
            <p className="text-[10px] text-muted-foreground">Enter — открыть сравнение</p>
            <p className="text-[10px] text-muted-foreground">Пробел — пауза / играть</p>
            <p className="text-[10px] text-muted-foreground">← → — по кадрам (режим «Кадр»)</p>
            <p className="text-[10px] text-muted-foreground">Esc — закрыть · сбросить выбор</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Как выбрать пару', text: 'Ctrl+клик (⌘ на Mac) по двум карточкам в галерее: первая становится «A» («до», слева), вторая — «B» («после», справа). Порядок кликов задаёт стороны. В тулбаре появятся кнопки «Сравнить» и сброс выбора (×). Вместо кнопки можно нажать Enter, а Esc снимает выделение. Работает во всех вкладках с галереей.' },
      { n: 2, title: 'Шторка и режимы', text: 'В полноэкранном окне ролики наложены друг на друга: шторка режет кадр — слева видно «до» (A), справа «после» (B). Режим «Видео» — оба играют синхронно (A ведущий), зациклены и всегда стартуют круг вместе, даже если разной длины. Режим «Кадр» — пауза и покадровое листание ←/→ (24 fps) с таймлайном. Идеально, чтобы оценить результат Refine, Tile Upscale или Face Refine против исходника.' },
      { n: 3, title: 'Управление', text: 'Шторка тянется мышью, пальцем или ставится кликом по кадру. Пробел — пауза/играть, Esc — закрыть окно. Звук по умолчанию выключен; кнопка динамика включает звук ролика A.' },
    ],
    tip: 'Сравнение — самый честный способ проверить апскейл: тяните шторку медленно по деталям (лица, текст, трава) — разница видна моментально.'
  },
  /* ═══════════════ ЧАСТЬ 3. ГЛУБЖЕ ═══════════════ */
  {
    id: 'advanced',
    title: 'Пайплайн и дополнительные параметры',
    short: '«Полное» (два прохода) или «Драфт» (один), шаги, seed. Можно смело пропустить.',
    mock: (
      <Stage>
        <div className="w-[300px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2.5">
          <p className="text-[10px] text-muted-foreground">▼ Дополнительные параметры</p>
          <Hl n={1}>
            <div className="space-y-2">
              <div className="space-y-1">
                <MockLabel>Проход 1 (черновой): разрешение, МП</MockLabel>
                <MockSlider value={20} max={200} />
                <p className="text-[10px] text-muted-foreground/70">от 0.2 МП · <span className="text-cyan-300/80">не больше финального разрешения (мин. потолок 1.0 МП)</span></p>
              </div>
              <div className="space-y-1">
                <MockLabel>Проход 1: шаги (точка сплита)</MockLabel>
                <MockSlider value={13} max={100} />
                <p className="text-[10px] text-muted-foreground/70">сколько сигм забирает черновой проход · ползунок 2–30 · <span className="text-cyan-300/80">по умолчанию 6</span></p>
              </div>
              <div className="space-y-1">
                <MockLabel>Проход 1: всего шагов</MockLabel>
                <MockSlider value={30} max={100} />
                <p className="text-[10px] text-muted-foreground/70">длина всего расписания · <span className="text-cyan-300/80">по умолчанию как у сплита (6 из 6)</span></p>
              </div>
              <p className="text-[10px] font-mono text-cyan-300/80">Pass 1: 6 из 6 · σ 1.0 → 0.167</p>
              <div className="space-y-1">
                <MockLabel>Сэмплер / планировщик · референсы</MockLabel>
                <MockSelect value="euler · simple · Match (быстро)" />
              </div>
              <div className="space-y-1">
                <MockLabel>Проход 2 (улучшение): шаги</MockLabel>
                <MockSelect value="3 шага (быстрее) · 4–7 — качество" />
              </div>
            </div>
          </Hl>
          <Hl n={2}>
            <div className="space-y-1.5">
              <MockToggle on label="Low VRAM Attention" />
              <p className="text-[10px] text-muted-foreground/70 -mt-0.5">и Chunk FeedForward — в Настройки → Оптимизация</p>
            </div>
          </Hl>
          <Hl n={3}>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <MockLabel>Seed</MockLabel>
                <span className="text-[10px] font-mono text-muted-foreground">-1 (случайный)</span>
              </div>
              <p className="text-[10px] text-muted-foreground/70">свои LoRA — в Настройки → Общие → LoRAs</p>
            </div>
          </Hl>
        </div>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Полное или Драфт', text: 'Режим «Полное» — два прохода: сначала быстрый черновик в низком разрешении (от 0.2 МП, но не крупнее финала), потом улучшение до целевого качества. Режим «Драфт» — один проход в черновом качестве: заметно быстрее, в галерее такое видео получает красный бейдж «Draft», а довести его до полного качества можно вкладкой «Refine». Шаги чернового прохода задаются ДВУМЯ числами: «Шаги сэмплера» — точка сплита (сколько сигм забирает черновик, ползунок 2–30, по умолчанию 6), «Всего шагов (pass 1)» — длина всего расписания (по умолчанию столько же, сколько у точки сплита, то есть «6 из 6»). Под полями показывается живая сводка «Pass 1: 6 из 6 · σ 1.0 → 0.167»: по ней видно, куда дошёл черновик. Можно задать всего вручную — например, 8: тогда черновик возьмёт 6 сигм из 8 и уйдёт глубже по шуму. У референсов есть режим Match / Max: Match быстрее, Max точнее держит сходство.' },
      { n: 2, title: 'Оптимизации памяти', text: 'Low VRAM Attention и Chunk FeedForward экономят видеопамять — стоят в Настройки → Оптимизация, а не в форме генерации. Если генерация падает с нехваткой VRAM — оставьте их включёнными или снизьте разрешение.' },
      { n: 3, title: 'Seed', text: '«Зерно» случайности: -1 = каждый раз новое. Понравился результат — возьмите seed из метаданных и повторите с ним.' },
    ],
    tip: 'Новичку этот блок можно не открывать — значения по умолчанию подобраны для быстрого старта.',
  },
  {
    id: 'lora',
    title: 'LoRA-модели — стиль и скорость',
    short: 'Свои LoRA: вкл/выкл, сила от −10 до +10, триггерные слова.',
    mock: (
      <Stage>
        <Hl n={1}><MockLoraList /></Hl>
        <Hl n={2}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">Зачем LoRA</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">LoRA — «надстройка» над основной моделью: добавляет стиль, персонажа или предмет.</p>
            <p className="text-[10px] text-foreground/80">Сила от −10 до +10 · триггеры подставляются в промпт автоматически</p>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[190px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">Где живут</p>
            <p className="text-[10px] text-muted-foreground">Настройки → Общие → LoRAs</p>
            <p className="text-[10px] text-muted-foreground">Файл копируется в папку LoRA программы</p>
            <p className="text-[10px] text-muted-foreground">Прогресс копирования виден в списке</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Список LoRA', text: 'В списке — все .safetensors-файлы из папки LoRA программы: и те, что скачали в Настройки → Модели, и те, что добавили кнопкой «Добавить». Встроенная турбо-лора (4-step) тоже в списке и включена по умолчанию — она ускоряет генерацию. Исключение: в режиме «Кадры» с добавленным аудио турбо-лора автоматически пропускается, а обычные LoRA работают как обычно. У каждой записи есть переключатель вкл/выкл и ползунок силы от −10 до +10. Пользовательские LoRA по умолчанию выключены. Свои LoRA дополнительно имеют поле триггерных слов — при включённой LoRA они автоматически добавляются к промпту.' },
      { n: 2, title: 'Зачем LoRA', text: 'LoRA — небольшая «надстройка» поверх основной модели: может добавить стиль, персонажа или предмет. Сила регулируется ползунком: 0 — эффекта нет, чем дальше от нуля — тем сильнее; обычно хватает значений около 1. Турбо-лора — 4-шаговый ускоритель; если её выключить, генерация пойдёт без неё (медленнее). Включённые LoRA работают не только в обычной генерации, но и в Refine, Tile Upscale и Продлении (правка 483) — стиль сохранится на всех этапах.' },
      { n: 3, title: 'Добавить свою LoRA', text: 'Кнопка «Добавить» (Настройки → Общие → LoRAs): выбираете файл — он копируется в папку LoRA программы, прогресс копирования виден в списке. Закрыть окно настроек можно в любой момент — копирование продолжится в фоне.' },
    ],
    tip: 'Если LoRA работает, но картинка «разваливается» — вероятно, несовместимость с базовой моделью: переключите основную модель на альтернативную (Настройки → Общие).',
  },
  /* ═══════════════ ЧАСТЬ 4. НАСТРОЙКИ ═══════════════ */
  {
    id: 'settings-general',
    title: 'Настройки → Общие и Внешний вид',
    short: 'Модели, перенос, основная модель + тема и звук.',
    mock: (
      <Stage>
        <Hl n={1}><MockSettingsGeneral /></Hl>
        <Hl n={2}><MockSettingsAppearance /></Hl>
        <Hl n={3}>
          <div className="w-[210px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">Список вкладок настроек</p>
            <p className="text-[10px] text-muted-foreground">Общие · Внешний вид · LLM · Голос</p>
            <p className="text-[10px] text-muted-foreground">Оптимизация · Формат · Ссылки</p>
            <p className="text-[10px] text-muted-foreground">О программе · Сброс</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Модели и перенос', text: '«Перенос моделей из старой версии» — выбираете папку со старой сборкой, программа сама найдёт ВСЕ папки models (корневая + ComfyUI/models) и перенесёт содержимое (правка 283). Защита от потери данных: проверка файла чатов, ошибки unlinkSync (правка 279). «Основная модель» — базовая (FastH3 VSA DataFree 4-step INT8, правка 293). «Свои папки моделей» — добавление своих папок с моделями (правка 257). «Своя модель (GGUF)» — выбор папки с кнопкой «Выбрать папку» (правка 278). Скачивание моделей (и копирование LoRA) не прерывается закрытием окна настроек. Bonsai light (маленькая версия) — optional, баннер не требует.' },
      { n: 2, title: 'Внешний вид', text: 'Отдельная вкладка: тема оформления — Серая (по умолчанию) или Чёрная, — и звуковой сигнал при завершении генерации (можно выключить).' },
      { n: 3, title: 'Девять вкладок', text: 'Полный список: Общие, Внешний вид, LLM, Голос, Оптимизация, Формат, Ссылки, О программе, Сброс. Каждая — свой инструмент: от моделей до опасной зоны.' },
    ],
    tip: 'Если LoRA работает, но картинка разваливается — вероятно, несовместимость с базовой моделью: переключите основную модель на альтернативную.',
  },
  {
    id: 'settings-llm-voice',
    title: 'Настройки → LLM и Голос',
    short: 'Модель ассистента, контекст, KV-кэш + диктовка голосом.',
    mock: (
      <Stage>
        <Hl n={1}><MockSettingsLlm /></Hl>
        <Hl n={2}><MockSettingsVoice /></Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Ассистент и память', text: 'Модель ассистента: по умолчанию Qwen3.5 9B (~5.7 ГБ, vision). Альтернативы: Gemma 4 12B (Q3/Q4/Q5) или Bonsai 2 27B (тернарная, ~7.2 ГБ, vision) — выбирайте под свою видеокарту. Устройство: Авто / GPU / CPU. Контекст: 8K–100K токенов, по умолчанию 25K. «Видение видео» по умолчанию ВЫКЛЮЧЕНО (экономия памяти и контекста) — включите, если хотите, чтобы ассистент видел и анализировал кадры видео-референсов. Квантизация KV-кэша (Выкл / Q8 / Q5 / Q4) — экономит память длинных диалогов, по умолчанию Q4. Кнопка «Перезапустить LLM» (правка 482) применяет смену модели без перезапуска всей программы.' },
      { n: 2, title: 'Голосовой ввод', text: 'Whisper-распознавание работает на CPU и не трогает видеопамять. Вкл/выкл, модель распознавания (small/medium — лучше для русского), язык. Живой тест: запись → распознанный текст. Кнопка микрофона появляется в поле промпта, полноэкранном редакторе и чате Ассистента. Горячая клавиша: R (англ.) / К (рус.) — одна физическая клавиша в обеих раскладках; диктовку можно запустить и остановить клавишей, не трогая мышку. Не срабатывает во время набора текста в полях (чтобы не ломать ввод R/К) и с зажатыми Ctrl/Alt/Meta.' },
    ],
    tip: 'Если на 8–12 ГБ VRAM генерация «лагает» — поставьте Qwen3.5 9B или Gemma Q3 и поднимите резерв VRAM (вкладка «Оптимизация»).',
  },
  {
    id: 'settings-opt-comfy',
    title: 'Настройки → Оптимизация, Формат, Ссылки, Сброс',
    short: 'VRAM, формат видео, ручные загрузки и опасная зона.',
    mock: (
      <Stage>
        <Hl n={1}><MockSettingsOpt /></Hl>
        <Hl n={2}><MockSettingsComfyLinks /></Hl>
        <Hl n={3}><MockSettingsDanger /></Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Оптимизация памяти', text: 'Резерв VRAM (1–16 ГБ, по умолчанию 3) и Dynamic VRAM управляют видеопамятью ComfyUI — применяются после перезапуска ComfyUI. «Резерв VRAM» — основной рычаг: менеджер моделей ComfyUI вычитает его из доступной памяти и выгружает/офлоадит веса раньше, поэтому до 100% VRAM дело не доходит. «Запас свободной VRAM (headroom)» (0–8 ГБ, по умолчанию 2 ГБ) — дополнительная страховка на стороне нативного слоя DynamicVRAM (comfy-aimdo): он следит за реально свободной VRAM по NVML, включая чужие приложения, и не даёт забрать её под веса. Low VRAM Attention и Chunk FeedForward экономят память прямо во время генерации — действуют сразу на новые генерации, без перезапуска. Если генерация падает с нехваткой видеопамяти — поднимите «Резерв VRAM», включите оба переключателя и/или снизьте разрешение.' },
      { n: 2, title: 'Формат и Ссылки', text: 'Отдельной вкладки «ComfyUI» больше нет (правка 486): статус и кнопка «Перепроверить» переехали в «Общие», а датчики VRAM/GPU/RAM всегда видны в сайдбаре. Вкладка «Формат» — как сохранять видео: кодек (H.264 / H.265, аппаратный NVENC) и качество. Вкладка «Ссылки»: прямые URL на каждую модель для ручной загрузки (копирование в один клик) + подсказка про зеркало hf-mirror.com, если Hugging Face недоступен. Есть ещё вкладка «О программе» (правка 484) — о проекте, авторе и ссылки на каналы.' },
      { n: 3, title: 'Сброс (опасная зона)', text: 'Четыре кнопки: «Сброс настроек» — все параметры к значениям по умолчанию. «Очистить кэш» — папка input ComfyUI (референсы и временные файлы). «Удалить контент» — папка output со всеми видео + чаты ассистента + история промптов. «Заводской сброс (всё)» — программа возвращается в состояние «как после установки»: настройки, контент и данные. Каждое действие требует подтверждения.' },
    ],
    tip: 'После «Сбросить настройки» ассистенту стоит дать полный контекст — дефолтных 25K токенов достаточно для инструкций.',
  },
  /* ═══════════════ ФИНАЛ ═══════════════ */
  {
    id: 'checklist',
    title: 'Чек-лист первой генерации',
    short: 'Одиннадцать пунктов с нуля — и первое видео готово.',
    mock: (
      <div className="w-full max-w-[400px] space-y-3">
        <Hl n={1}>
          <div className="rounded-xl border border-cyan-500/20 bg-[var(--surface-2)]/60 p-4 space-y-2.5 w-full">
            {[
              'Скачайте модели (окно приветствия → Настройки → скачать; загрузка — в фоне)',
              'Выберите режим: Текст / Кадры / Референсы',
              'Загрузите референсы (если режим «Референсы») — или сразу без них',
              'Опишите сцену в промпте — текст, голосом (🎙) или через Ассистента (Bonsai 2 27B)',
              'Привяжите референсы через @, реплики — в <d>…</d>',
              'Поставьте 480p и короткую длительность',
              'Нажмите «Сгенерировать видео» и следите за превью',
              'Готово: смотрите в галерее, рецепт — под ⓘ',
              'Улучшить: Refine / Tile Upscale / DLSS (RTX VSR или Neural Rendering)',
              'Продлить: вкладка «Продление» или кнопка на карточке видео',
              'Плавность: вкладка «FPS» — RIFE VFI / FILM VFI (×2–×4)',
            ].map((t, i) => (
              <div key={i} className="flex items-center gap-2.5">
                <span className="w-5 h-5 rounded-full bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 text-[10px] font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                <span className="text-xs text-foreground/90">{t}</span>
              </div>
            ))}
          </div>
        </Hl>
        <Hl n={2}>
          <div className="flex items-center gap-2 justify-center rounded-lg border border-border bg-[var(--surface-2)]/60 px-4 py-2 text-[10px] text-muted-foreground">
            ▶ Если что-то не так — перезапустите start.bat
          </div>
        </Hl>
      </div>
    ),
    callouts: [
      { n: 1, title: 'Поздравляем — тур пройден!', text: 'Сделайте первую генерацию по чек-листу, а в метаданных смотрите, какие настройки на что влияют. Загляните в подвкладку «Сценарии» (правка 485) — там три готовых сценария работы: от «сразу в большом разрешении» до «драфты → Refine → Tile Upscale». Результат улучшений удобно проверять сравнением: Ctrl+клик по двум карточкам → Enter. Вернуться к туру можно в любой момент через вкладку «Обучение».' },
      { n: 2, title: 'Типовые проблемы', text: 'Красный индикатор ComfyUI или ошибка генерации → перезапустите start.bat. «ComfyUI недоступен» во время генерации — обычно проходит само, не прерывайте. «Не хватает памяти» / «CUDA out of memory» → увеличьте файл подкачки (шаг 2) и включите Low VRAM Attention + Chunk FeedForward в Настройки → Оптимизация. Не нравится результат — смените seed (поставьте -1) или попросите Ассистента переписать промпт.' },
    ],
  },
]
