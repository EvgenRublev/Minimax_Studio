'use client'

/**
 * (правка 973) «Быстрый старт» — короткий экскурс для абсолютных новичков.
 * Без технических терминов: что нажать, в каком порядке и что получится.
 * Подробный тур остаётся отдельной подвкладкой «Подробный тур».
 */
import {
  ArrowRightIcon,
  CheckIcon,
  CircleHelpIcon,
  ClapperboardIcon,
  ClockIcon,
  DownloadIcon,
  FilmIcon,
  GaugeIcon,
  Grid3x3Icon,
  ImagesIcon,
  KeyboardIcon,
  LightbulbIcon,
  PlayIcon,
  RocketIcon,
  ScanFaceIcon,
  ScissorsIcon,
  SparklesIcon,
  WandSparklesIcon,
  WaypointsIcon,
  ZapIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const TABS = [
  {
    icon: SparklesIcon,
    color: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/25',
    title: 'Генерация',
    text: 'Создать видео с нуля: описать сцену словами, по картинкам или по начальному кадру.',
  },
  {
    icon: FilmIcon,
    color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/25',
    title: 'Продление',
    text: 'Продолжить готовое видео: программа допишет следующие секунды в той же сцене.',
  },
  {
    icon: WandSparklesIcon,
    color: 'text-violet-400 bg-violet-500/10 border-violet-500/25',
    title: 'Refine',
    text: 'Улучшить готовое видео: больше деталей, чёткости и аккуратности.',
  },
  {
    icon: WaypointsIcon,
    color: 'text-orange-400 bg-orange-500/10 border-orange-500/25',
    title: 'ControlNet',
    text: 'Взять движение из другого видео, а внешний вид придумать по описанию.',
  },
  {
    icon: Grid3x3Icon,
    color: 'text-pink-400 bg-pink-500/10 border-pink-500/25',
    title: 'Tile Upscale',
    text: 'Увеличить разрешение видео — например, сделать 720p или 1080p.',
  },
  {
    icon: GaugeIcon,
    color: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/25',
    title: 'FPS',
    text: 'Сделать движение плавнее: добавить кадры между уже существующими.',
  },
  {
    icon: ScanFaceIcon,
    color: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/25',
    title: 'Face Refine',
    text: 'Аккуратно перерисовать лица, если они получились мелкими или размытыми.',
  },
  {
    icon: ZapIcon,
    color: 'text-violet-400 bg-violet-500/10 border-violet-500/25',
    title: 'DLSS',
    text: 'Быстрое улучшение чёткости на видеокартах NVIDIA RTX.',
  },
  {
    icon: ImagesIcon,
    color: 'text-sky-400 bg-sky-500/10 border-sky-500/25',
    title: 'Галерея',
    text: 'Все готовые видео: смотреть, сравнивать, искать по папкам и удалять.',
  },
  {
    icon: ScissorsIcon,
    color: 'text-amber-400 bg-amber-500/10 border-amber-500/25',
    title: 'Монтаж',
    text: 'Собрать несколько видео в один ролик, обрезать и добавить эффекты.',
  },
  {
    icon: RocketIcon,
    color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/25',
    title: 'Обучение',
    text: 'Эта подсказка. Сюда всегда можно вернуться, если что-то забыли.',
  },
]

const FIRST_VIDEO = [
  {
    n: 1,
    title: 'Откройте «Генерацию»',
    text: 'Это первая вкладка слева. С неё начинается любое новое видео.',
  },
  {
    n: 2,
    title: 'Выберите режим',
    text: '«Текст» — просто описать сцену. «Кадры» — задать первый и последний кадр. «Референсы» — показать картинки или видео-образцы.',
  },
  {
    n: 3,
    title: 'Опишите сцену',
    text: 'Пишите обычными словами, по-русски тоже можно. Например: «Ночной город под дождём, камера медленно приближается к человеку в плаще».',
  },
  {
    n: 4,
    title: 'Поставьте разрешение и длительность',
    text: 'Для первых проб хватит 480p и 5 секунд. Так быстрее и меньше нагрузка на компьютер.',
  },
  {
    n: 5,
    title: 'Выберите качество',
    text: '«Драфт» — быстрый черновик, чтобы проверить идею. «Полное» — финальный вариант, он считается дольше.',
  },
  {
    n: 6,
    title: 'Нажмите «Сгенерировать видео»',
    text: 'Кнопка справа от описания. Или Ctrl+Enter. Прогресс виден прямо на экране, готовое видео появится в «Галерее».',
  },
]

const IMPROVE = [
  {
    icon: WandSparklesIcon,
    title: 'Не понравился результат',
    text: 'Измените описание и сгенерируйте ещё раз. Можно оставить те же настройки, но поменять пару слов — это уже даст другой вариант.',
  },
  {
    icon: FilmIcon,
    title: 'Хочется длиннее',
    text: 'Откройте «Продление», выберите готовое видео и добавьте следующий кусок. Программа сама склеит их в один ролик.',
  },
  {
    icon: Grid3x3Icon,
    title: 'Нужно чётче и больше',
    text: 'Сначала сделайте драфт, потом запустите Refine или Tile Upscale. Так быстрее, чем сразу считать финал в большом разрешении.',
  },
  {
    icon: ScissorsIcon,
    title: 'Нужен один ролик из нескольких',
    text: 'Откройте «Монтаж», перетащите видео из галереи на дорожку и соберите их в нужном порядке.',
  },
]

const FAQ = [
  {
    icon: ClockIcon,
    title: 'Долго ждать?',
    text: 'Первый запуск всегда дольше: программа загружает всё необходимое. Драфт считается быстрее полного качества, короткое видео — быстрее длинного.',
  },
  {
    icon: CircleHelpIcon,
    title: 'Пишет, что не хватает памяти',
    text: 'Уменьшите разрешение или длительность, закройте другие тяжёлые программы и попробуйте «Драфт». Настройки можно менять в любой момент.',
  },
  {
    icon: DownloadIcon,
    title: 'Нет моделей или кнопка неактивна',
    text: 'Откройте «Настройки» (шестерёнка внизу слева) → «Общие» → «Скачать все». Это делается один раз, потом интернет для работы не нужен.',
  },
  {
    icon: ImagesIcon,
    title: 'Где готовое видео?',
    text: 'В «Галерее». Там же можно открыть видео на весь экран, посмотреть папки, сравнить два ролика и удалить лишнее.',
  },
]

const HOTKEYS = [
  { keys: 'Ctrl + Enter', text: 'начать генерацию' },
  { keys: 'Space', text: 'пауза в просмотрщике видео' },
  { keys: 'F', text: 'полный экран' },
  { keys: 'Esc', text: 'закрыть окно или просмотр' },
  { keys: 'Ctrl + V', text: 'вставить картинку как пример' },
  { keys: '← →', text: 'листать этот тур' },
]

const TERMS = [
  { word: 'Промпт', text: 'описание сцены обычными словами.' },
  { word: 'Референс', text: 'картинка, видео или звук-образец, по которому нужно сделать похоже.' },
  { word: 'Драфт', text: 'быстрый черновик. Нужен, чтобы проверить идею, не тратя много времени.' },
  { word: 'Полное', text: 'финальный вариант в хорошем качестве. Считается дольше.' },
  { word: 'Ассистент', text: 'помощник справа на вкладках «Генерация» и «Продление». Подсказывает и улучшает описание.' },
  { word: 'Галерея', text: 'место, где хранятся все готовые видео.' },
]

function SectionTitle({ icon: Icon, title, sub }: { icon: typeof SparklesIcon; title: string; sub?: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
        <Icon className="h-4 w-4" />
      </span>
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
      </div>
    </div>
  )
}

export function LearnQuickStart() {
  return (
    <div className="select-text mx-auto w-full max-w-5xl space-y-7 pb-8 pt-1">
      {/* Приветствие */}
      <div className="rounded-2xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/10 via-cyan-500/5 to-transparent p-5">
        <div className="flex items-center gap-2 text-xs font-medium text-emerald-300">
          <RocketIcon className="h-3.5 w-3.5" />
          Быстрый старт
        </div>
        <h1 className="mt-2 text-xl font-semibold text-foreground">
          Сделайте первое видео, даже если никогда не работали с нейросетями
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          Здесь всё по шагам и простыми словами: куда нажать, что написать и где забрать результат.
          Технические подробности знать не нужно — программа сделает всё сама.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-[var(--surface-2)]/60 px-2.5 py-1 text-[11px] text-foreground/80">
            <CheckIcon className="h-3 w-3 text-emerald-400" /> Первое видео — 5–10 минут
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-[var(--surface-2)]/60 px-2.5 py-1 text-[11px] text-foreground/80">
            <CheckIcon className="h-3 w-3 text-emerald-400" /> Всё на русском
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-[var(--surface-2)]/60 px-2.5 py-1 text-[11px] text-foreground/80">
            <CheckIcon className="h-3 w-3 text-emerald-400" /> Настройки можно менять без страха
          </span>
        </div>
      </div>

      {/* Три первых шага */}
      <section className="space-y-3">
        <SectionTitle icon={PlayIcon} title="С чего начать" sub="Три вещи, которые нужны один раз." />
        <div className="grid gap-3 md:grid-cols-3">
          {[
            {
              n: 1,
              icon: DownloadIcon,
              title: 'Скачайте модели',
              text: '«Настройки» внизу слева → «Общие» → «Скачать все». Это файлы, которые создают видео. Качать один раз, потом интернет не нужен.',
            },
            {
              n: 2,
              icon: SparklesIcon,
              title: 'Придумайте сцену',
              text: 'Кто в кадре, что происходит, где это, какое настроение. Не нужно знать специальных слов — опишите как другу.',
            },
            {
              n: 3,
              icon: ClapperboardIcon,
              title: 'Нажмите «Сгенерировать»',
              text: 'Программа сделает видео и положит его в «Галерею». Первый раз может быть дольше обычного.',
            },
          ].map((s) => (
            <div key={s.n} className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-[11px] font-bold text-white">
                  {s.n}
                </span>
                <s.icon className="h-4 w-4 text-emerald-400" />
              </div>
              <p className="mt-2.5 text-sm font-semibold text-foreground">{s.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Карта вкладок */}
      <section className="space-y-3">
        <SectionTitle
          icon={ClapperboardIcon}
          title="Что находится слева"
          sub="Одиннадцать вкладок. Начинающим нужны первые три, остальные — когда захочется большего."
        />
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {TABS.map((t) => (
            <div key={t.title} className="flex gap-3 rounded-xl border border-border bg-[var(--surface-1)] p-3">
              <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border', t.color)}>
                <t.icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-foreground">{t.title}</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{t.text}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Первое видео */}
      <section className="space-y-3">
        <SectionTitle icon={PlayIcon} title="Первое видео: шесть шагов" sub="Держите этот список перед глазами — больше ничего не нужно." />
        <div className="space-y-2">
          {FIRST_VIDEO.map((s) => (
            <div key={s.n} className="flex gap-3 rounded-xl border border-border bg-[var(--surface-2)]/30 p-3.5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-cyan-500/30 bg-cyan-500/10 text-xs font-bold text-cyan-300">
                {s.n}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{s.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{s.text}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="flex gap-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3.5">
          <LightbulbIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div className="text-xs leading-relaxed text-amber-100/80">
            <p className="font-medium text-amber-300">Не знаете, что написать?</p>
            <p className="mt-1">
              Откройте ассистента справа и нажмите «Предложить идеи» или «Исправить мой промпт».
              Он задаст пару вопросов и сам соберёт описание. Готовый текст можно сразу отправить в генерацию.
            </p>
          </div>
        </div>
      </section>

      {/* Что дальше */}
      <section className="space-y-3">
        <SectionTitle icon={WandSparklesIcon} title="Что делать с результатом" sub="Простые пути, если хочется лучше." />
        <div className="grid gap-3 sm:grid-cols-2">
          {IMPROVE.map((c) => (
            <div key={c.title} className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4">
              <div className="flex items-center gap-2">
                <c.icon className="h-4 w-4 text-cyan-400" />
                <p className="text-sm font-semibold text-foreground">{c.title}</p>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{c.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Частые вопросы */}
      <section className="space-y-3">
        <SectionTitle icon={CircleHelpIcon} title="Если что-то пошло не так" sub="Самые частые ситуации у новичков." />
        <div className="grid gap-3 md:grid-cols-2">
          {FAQ.map((q) => (
            <div key={q.title} className="rounded-xl border border-border bg-[var(--surface-1)] p-4">
              <div className="flex items-center gap-2">
                <q.icon className="h-4 w-4 text-violet-400" />
                <p className="text-xs font-semibold text-foreground">{q.title}</p>
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{q.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Клавиши */}
      <section className="space-y-3">
        <SectionTitle icon={KeyboardIcon} title="Полезные клавиши" sub="Необязательно, но ускоряет работу." />
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {HOTKEYS.map((h) => (
            <div key={h.keys} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-[var(--surface-2)]/40 px-3 py-2">
              <kbd className="rounded border border-border bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-foreground/90">
                {h.keys}
              </kbd>
              <span className="text-[11px] text-muted-foreground">{h.text}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Словарик */}
      <section className="space-y-3">
        <SectionTitle icon={CircleHelpIcon} title="Словарик" sub="Шесть слов, которые встретятся в интерфейсе." />
        <div className="grid gap-2 sm:grid-cols-2">
          {TERMS.map((t) => (
            <div key={t.word} className="rounded-lg border border-border bg-[var(--surface-1)] px-3 py-2.5">
              <span className="text-xs font-semibold text-foreground">{t.word}</span>
              <span className="ml-1.5 text-[11px] text-muted-foreground">— {t.text}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Финал */}
      <div className="flex flex-col items-start justify-between gap-3 rounded-2xl border border-cyan-500/25 bg-cyan-500/5 p-5 sm:flex-row sm:items-center">
        <div>
          <p className="text-sm font-semibold text-foreground">Готово — можно пробовать</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Откройте «Генерацию», опишите сцену и нажмите большую кнопку. Если что-то непонятно — вернитесь сюда
            или загляните в «Подробный тур».
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-300">
          Первый шаг — «Генерация» <ArrowRightIcon className="h-3.5 w-3.5" />
        </span>
      </div>
    </div>
  )
}
