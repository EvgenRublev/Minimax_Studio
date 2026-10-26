'use client'

/**
 * Assistant stream engine (правка 31) — lives at MODULE scope, NOT in a
 * component, so an in-flight LLM reply SURVIVES AssistantView unmount.
 *
 * Why this exists: switching app tabs unmounts AssistantView (page.tsx uses
 * AnimatePresence). Previously the SSE read loop was a fire-and-forget
 * closure inside the component (`void runCompletion(...)`): after unmount its
 * state updates no-oped, its only strong references were gone, and the
 * re-mounted view never reattached to the in-flight stream — so the model
 * answered "into the void" and the user had to resend.
 *
 * Now:
 *  • the async fetch/reader loop runs here, at module level, and completes
 *    regardless of component lifecycle;
 *  • on completion the reply is committed to the persisted chats store —
 *    a (re)mounted view renders it because it derives messages from the
 *    store reactively;
 *  • while streaming, any mounted view reattaches by subscribing to the
 *    tiny `useAssistantStream` store below and renders the live tail.
 */
import { create } from 'zustand'
import { toast } from 'sonner'
import { useAssistantChats, type AssistantChatMessage, type AssistantChatMode } from './assistant-chats-store'
import { useGenStore } from './gen-store'
import { useControlNetTarget } from './controlnet-target-store' // (правка 502)
import { H3_SPEC_A, H3_SPEC_B, H3_SPEC_EXTEND } from './h3-prompt-spec'

export interface LlmStatusResp {
  running: boolean
  starting: boolean
  gpuMode: 'gpu' | 'cpu' | null
  modelReady: boolean
  /** Активный ID модели LLM (зависит от выбранной квантизации). */
  modelId: string
  /** (правка 257) Имя файла активной модели (для подписей своей модели). */
  modelName?: string
  /** Ассистент сейчас стримит ответ (для блокировки генерации). */
  streaming: boolean
  /** Ассистент занят (грузится или отвечает). */
  assistantBusy: boolean
  /** Идёт генерация видео — чат заблокирован. */
  blockedByGeneration: boolean
}

/**
 * Pre-cap on the wire (равен потолку стора — 200 сообщ./чат); точную
 * токен-обрезку делает сервер (правка 169): системный промпт + самый
 * длинный влезающий хвост последних сообщений. Длинные чаты деградируют
 * мягко — отрезается только начало истории, ассистент всегда помнит
 * системный промпт и то, что обсуждалось в конце.
 */
const HISTORY_LIMIT = 200

/** System prompt: compact OFFICIAL H3 spec + live session context.
 * (правка 168) Контекст генерации (режим, рефы, кадры, длительность) модель
 * видит АВТОМАТИЧЕСКИ и всегда ТЕКУЩИЙ — без ручных действий, как раньше.
 * Черновик промпта из формы генерации в системный промпт НЕ подставляется:
 * это был главный канал «утечки» тем между чатами (вставленный из другого
 * чата промпт модель тащила в новый диалог). Пользователь цитирует черновик
 * в самом сообщении (кнопка «Улучшить мой промпт» делает это автоматически).
 * (правка 53) `videoVisionOn` — видит ли ассистент видео-рефы (настройка
 * «Видение видео ассистентом», включена по умолчанию). Видео идёт сжатым
 * digest-описанием, а не сырыми кадрами. Без этого флага промпт не должен
 * говорить модели «ты ВИДИШЬ кадры», иначе она выдумывает содержимое.
 * (правка 150) Ассистент видит ТЕКУЩИЙ РЕЖИМ ГЕНЕРАЦИИ (t2v/flf/ref) из gen-store
 * и строит system-промпт с учётом режима: в t2v/flf запрещает метки <Picture N>,
 * <Video N>, <Subject N> (нода MiniMaxH3ReferenceToVideo не используется),
 * <Audio N> остаётся разрешённым для аудио-референсов.
 * (правка 427) `chatMode` — режим ЧАТА ('generate' | 'extend'), а не режим
 * генерации формы: extend-чаты получают отдельный системный промпт
 * (buildExtendSystemMessage) — раньше режим 'extend' формы проваливался в
 * ref-ветку с чужими рефами вкладки «Генерация». Async: extend-ветка дочитывает
 * мету исходника через /api/comfy/meta.
 * (правка 502) Режим 'controlnet' — свой системный промпт
 * (buildControlNetSystemMessage) и референсы вкладки «ControlNet». */
async function buildSystemMessage(
  videoVisionOn: boolean,
  chatMode: AssistantChatMode = 'generate',
  signal?: AbortSignal,
): Promise<string> {
  // (правка 427) extend-чат — свой контекст (клипы, extend-рефы, мета исходника).
  if (chatMode === 'extend') return buildExtendSystemMessage(signal)
  // (правка 502) controlnet-чат — свой контекст (контрольное видео,
  // refImages вкладки «ControlNet», параметры контроля).
  if (chatMode === 'controlnet') return buildControlNetSystemMessage(videoVisionOn)
  const v = useGenStore.getState().video
  const mode = v.mode // (правка 150) 'ref' | 't2v' | 'flf' | 'extend'
  const refs = v.refs
  // (правка 138) дефолт 124 → 60: минимум 2.5 с (60 кадров при 24 fps)
  const frames = v.videoLength || 60
  const seconds = Math.max(2.5, Math.round(frames / 24))
  // Бюджет шотов из выставленной длины: шоту нужно ≥ ~2 с, чтобы «прочитаться».
  // Без этого ограничения модель под запрос «эпичная сцена» выдавала план на
  // 15 шотов, который физически не влезает в 5–10-секундный клип.
  const maxShots = Math.max(1, Math.floor(seconds / 2))

  // (правка 717) Спека — по формату вывода:
  //   ref      → FORMAT B (шесть секций, теги <Subject N>) — нужен Ref2VA-гайд;
  //   t2v/flf  → FORMAT A (три поля) — гайд НЕ нужен (лишние ~1k токенов);
  //   extend   → вкладка «Генерация» в режиме продления: чат остаётся
  //              обычной генерацией, но режим НЕЛЬЗЯ молча игнорировать
  //              (раньше он проваливался в ветку t2v и давал модели
  //              противоречивые указания «ФОРМАТ A» + «переключись на
  //              Референсы»).
  const isExtendMode = mode === 'extend'
  const H3_SPEC = isExtendMode ? H3_SPEC_A : mode === 'ref' ? H3_SPEC_B : H3_SPEC_A

  // (правка 150) В t2v/flf из рефов уходят ТОЛЬКО аудио (картинки/видео не используются нодой).
  // Ассистенту показываем только аудио-рефы, чтобы LLM не вписывала <Picture N>/<Video N>.
  // (правка 168) рефы видны ВСЕГДА, без исключения для новых чатов (правка 166):
  // поведение единое и предсказуемое — модель всегда видит текущий рабочий стол.
  const effectiveRefs = mode === 'ref' ? refs : refs.filter((r) => r.kind === 'audio')

  const images = effectiveRefs.filter((r) => r.kind === 'image')
  const videos = effectiveRefs.filter((r) => r.kind === 'video')
  const audios = effectiveRefs.filter((r) => r.kind === 'audio')

  // ── Explicit "attached references" block, numbered exactly like MiniMax ──
  // (images → <Picture N>, videos → <Video N>, audios → <Audio N>, each 1-based
  //  within its type — this is what MiniMax's ref_images/ref_videos/ref_audios expect)
  let attachedBlock: string

  // (правка 150) Режим-специфичный префикс для system-промпта
  // (правка 717) Режим 'extend' больше не проваливается в ветку 'ref':
  // раньше он получал подпись «Референсы (ref, Ref2VA)», а следом — блок
  // «референсы картинок и видео НЕ ИСПОЛЬЗУЮТСЯ, формат FORMAT A»
  // (противоречие «FORMAT B / FORMAT A» в одном промпте).
  const modeHint = isExtendMode
    ? '⚠️ Вкладка «Генерация» сейчас в режиме ПРОДЛЕНИЯ. Этот чат — обычная генерация: пиши FORMAT A. Промпты для продления — в чате на вкладке «Продление».'
    : mode === 't2v'
      ? '⚠️ ТЕКУЩИЙ РЕЖИМ ГЕНЕРАЦИИ: «Текст» (t2v). Метки <Picture N>, <Video N>, <Subject N> ЗАПРЕЩЕНЫ — референсы картинок и видео не используются. <Audio N> ДОПУСКАЕТСЯ ТОЛЬКО если аудио-рефы прикреплены ниже. Формат — FORMAT A.'
      : mode === 'flf'
        ? '⚠️ ТЕКУЩИЙ РЕЖИМ ГЕНЕРАЦИИ: «Кадры» (flf, первый/последний кадр → видео). Метки <Picture N>, <Video N>, <Subject N> ЗАПРЕЩЕНЫ — кадры задаются полями формы, не референсами. <Audio N> ДОПУСКАЕТСЯ ТОЛЬКО если аудио-рефы прикреплены ниже. Формат — FORMAT A. Описывай движение/переход между первым и последним кадрами.'
        : '⚠️ ТЕКУЩИЙ РЕЖИМ ГЕНЕРАЦИИ: «Референсы» (ref, Ref2VA).'

  // (правка 151) В flf-режиме кадры (startFrame/endFrame) — это НЕ refs, но они
  // прикреплены к LLM как изображения. Поэтому условие «нет референсов» должно
  // учитывать кадры: если есть кадры или аудио → идём в ветку flf, не в «нет».
  // (правка 168) кадры — живые из текущей формы генерации.
  const hasFlfFrames = mode === 'flf' && (!!v.startFrame?.path || !!v.endFrame?.path)

  if (effectiveRefs.length === 0 && !hasFlfFrames) {
    attachedBlock =
      modeHint + '\n' +
      'Прикреплённых референсов НЕТ → это FORMAT A (text-to-video).\n' +
      'ЗАПРЕЩЕНО использовать любые метки <Picture N>, <Video N>, <Audio N>, <Subject N>.'
  } else if (mode === 'ref') {
    const lines: string[] = []
    // (правка 137) ЖЁСТКИЙ режим: референсы прикреплены → ТОЛЬКО FORMAT B
    // с метками. Модели регулярно «забывали» про референсы и выдавали
    // text-to-video промпт без единого тега — теперь это явно запрещено.
    lines.push('⚠️ РЕЖИМ ГЕНЕРАЦИИ: прикреплены РЕФЕРЕНСЫ → промпт ТОЛЬКО в FORMAT B (Ref2VA).')
    lines.push('ЗАПРЕЩЕНО выдавать FORMAT A (text-to-video) или промпт без меток, когда референсы прикреплены.')
    lines.push('Первое поле fence — subject_definitions (НЕ integrated_multimodal_description).')
    lines.push('Каждое ПРИКРЕПЛЁННОЕ ИЗОБРАЖЕНИЕ обязано попасть в промпт своей меткой <Picture N>: создай <Subject N> в subject_definitions, привяжи к <Picture N> и упомяни в описании кадра.')
    lines.push('<Video N> — проставь метку, если в кадре используется движение/сцена из видео-референса; <Audio N> — если голос/звучание из аудио-референса (реплики персонажа — через него).')
    lines.push('ПРОМПТ БЕЗ ЕДИНОЙ МЕТКИ РЕФЕРЕНСА при прикреплённых референсах = ОШИБКА. Перед выдачей проверь: каждая метка из списка ниже присутствует в промпте (или осознанно объяснено, почему референс не используется).')
    lines.push('')
    if (images.length) {
      lines.push('ИЗОБРАЖЕНИЯ — ты получаешь визуальное описание (digest) каждого изображения, сделанное по самому файлу (если файл приложен напрямую — видишь его):')
      images.forEach((r, i) => {
        lines.push(`  <Picture ${i + 1}> = ${r.name}${r.imageIntent ? ` (используется как: ${r.imageIntent})` : ''}`)
      })
    }
    if (videos.length) {
      if (videoVisionOn) {
        lines.push('ВИДЕО — ты получаешь визуальное описание (digest), сделанное по кадрам видео:')
        videos.forEach((r, i) => lines.push(`  <Video ${i + 1}> = ${r.name}${r.includeAudio ? ' (есть звуковая дорожка — модель её НЕ слышит, см. правило по АУДИО)' : ''}`))
        lines.push('  Описывай по факту digest: сцену, персонажей, ДВИЖЕНИЕ и поведение камеры по ходу ролика, а не только первый кадр. Не выдумывай деталей, которых нет в описании.')
      } else {
        // (правка 53) видение видео выключено: кадры НЕ прикреплены — модель
        // знает только о НАЛИЧИИ видео. Строго запрещаем описывать/выдумывать.
        lines.push('ВИДЕО — прикреплены ТОЛЬКО как теги (кадры НЕ прикреплены: видение видео ассистентом выключено, экономия контекста):')
        videos.forEach((r, i) => lines.push(`  <Video ${i + 1}> = ${r.name}${r.includeAudio ? ' (есть звуковая дорожка — модель её НЕ слышит, см. правило по АУДИО)' : ''}`))
        lines.push('  Ссылайся на <Video N> как на тег, когда пользователь просит (например, «motion from <Video 1>»). НЕ описывай, НЕ угадывай и НЕ выдумывай, что происходит внутри видео — ты его НЕ видишь.')
      }
    }
    if (audios.length) {
      lines.push('АУДИО — прикреплены как референсы ГОЛОСА/звучания для MiniMax (ref_audios). Модель НЕ МОЖЕТ их прослушать и НЕ знает, какие там реплики:')
      audios.forEach((r, i) => lines.push(`  <Audio ${i + 1}> = ${r.name}`))
      lines.push('  В промпте ссылайся на <Audio N> как на референс голоса/звучания (MiniMax сам использует файл). Конкретную реплику бери ТОЛЬКО из текста запроса пользователя — не выдумывай то, что «слышно» в аудио.')
    }
    const forbidden: string[] = []
    if (!videos.length) forbidden.push('<Video N>')
    if (!audios.length) forbidden.push('<Audio N>')
    lines.push('')
    if (forbidden.length) {
      lines.push(`⚠️ ПРАВИЛО: в промпте ДОПУСКАЮТСЯ ТОЛЬКО метки из списка выше. Запрещено использовать ${forbidden.join(', ')} — таких референсов в этой сессии НЕТ, не выдумывай их.`)
    } else {
      lines.push('⚠️ ПРАВИЛО: в промпте используй ТОЛЬКО те метки, которые перечислены выше (например, если есть только <Audio 1> — пиши <Audio 1>, а не <Audio 2>).')
    }
    if (!audios.length) lines.push('Голоса и реплики пиши в <d>...</d> БЕЗ привязки к <Audio N> (аудио не прикреплено). Не описывай голос как «referenced from <Audio N>» / «voice timbre from <Audio N>» — просто укажи тон/пол/возраст словами.')
    if (!videos.length) lines.push('Движение и камеру описывай словами, а не как «from <Video N>» (видео не прикреплено).')
    attachedBlock = lines.join('\n')
  } else if (mode === 'flf') {
    // (правка 151) Режим «Кадры»: кадры (startFrame/endFrame) прикреплены как image-рефы —
    // LLM их ВИДИТ и описывает словами. <Picture N> ЗАПРЕЩЁН (кадры не являются ref2va-рефами).
    // Аудио-рефы также уходят (через MiniMaxH3AddGuide) — <Audio N> допустим.
    const lines: string[] = [modeHint, '']

    // (правка 151) Показываем кадры как «визуальные описания» (или сами
    // приложенные файлы, если digest не удался).
    const hasStartFrame = !!v.startFrame?.path
    const hasEndFrame = !!v.endFrame?.path
    if (hasStartFrame || hasEndFrame) {
      lines.push('КАДРЫ (ты получаешь их визуальное описание/видишь приложенный файл):')
      if (hasStartFrame) {
        lines.push(`  ПЕРВЫЙ КАДР = ${v.startFrame!.name} — это стартовая точка видео. Опиши его содержимое словами (сцену, персонажей, композицию, освещение).`)
      }
      if (hasEndFrame) {
        lines.push(`  ПОСЛЕДНИЙ КАДР = ${v.endFrame!.name} — это финальная точка видео. Опиши его содержимое словами.`)
      }
      lines.push('  ⚠️ ЗАПРЕЩЕНО использовать метку <Picture N> для этих кадров — они НЕ являются ref2va-референсами.')
      lines.push('  В промпте описывай движение/переход МЕЖДУ первым и последним кадрами: что меняется, как камера движется, какие действия происходят.')
      lines.push('  Если пользователь говорит «на основе рефа» или «скажи что на кадре» — опиши то, что видно в digest/на приложенном изображении.')
      lines.push('')
    }

    if (audios.length) {
      lines.push('АУДИО-РЕФЕРЕНСЫ (прикреплены, <Audio N> ДОПУСКАЕТСЯ):')
      audios.forEach((r, i) => lines.push(`  <Audio ${i + 1}> = ${r.name}`))
      lines.push('  Ссылайся на <Audio N> для голоса/звучания. Конкретную реплику бери ТОЛЬКО из текста запроса пользователя.')
      lines.push('')
    }

    const forbidden = ['<Picture N>', '<Video N>', '<Subject N>']
    lines.push(`⚠️ ЗАПРЕЩЕНО использовать метки ${forbidden.join(', ')} — кадры задаются полями формы, не референсами. Формат — FORMAT A.`)
    if (!audios.length) lines.push('Голоса и реплики пиши в <d>...</d> БЕЗ привязки к <Audio N> (аудио не прикреплено).')
    attachedBlock = lines.join('\n')
  } else {
    // (правка 150) t2v: только аудио-рефы, формат A (кадров нет)
    const lines: string[] = [modeHint, '']
    if (audios.length) {
      lines.push('АУДИО-РЕФЕРЕНСЫ (прикреплены, <Audio N> ДОПУСКАЕТСЯ):')
      audios.forEach((r, i) => lines.push(`  <Audio ${i + 1}> = ${r.name}`))
      lines.push('  Ссылайся на <Audio N> для голоса/звучания. Конкретную реплику бери ТОЛЬКО из текста запроса пользователя.')
    }
    const forbidden = ['<Picture N>', '<Video N>', '<Subject N>']
    lines.push('')
    lines.push(`⚠️ ЗАПРЕЩЕНО использовать метки ${forbidden.join(', ')} — в этом режиме референсы картинок и видео НЕ ИСПОЛЬЗУЮТСЯ. Если пользователь просит референс — скажи, что нужно переключить на режим «Референсы». Формат — FORMAT A.`)
    if (!audios.length) lines.push('Голоса и реплики пиши в <d>...</d> БЕЗ привязки к <Audio N> (аудио не прикреплено).')
    attachedBlock = lines.join('\n')
  }

  // ── Visual anchor: lock characters/objects by what the model actually sees ──
  // (правка 717) Сжато: было 4 пункта по 200+ символов каждый.
  const anchorBlock = images.length
    ? '\n=== ВИЗУАЛЬНЫЙ ЯКОРЬ ===\n' +
      'Ты получаешь визуальное описание (digest) прикреплённых изображений. Для каждого персонажа/объекта, который должен попасть в кадр:\n' +
      '1) Опиши по факту digest: черты лица, глаза, волосы, кожа, возраст, телосложение, одежда (цвет, фасон, детали), характерные признаки (шрамы, тату, очки, украшения).\n' +
      '2) Создай <Subject N>, привяжи к его <Picture N>, в retention_analysis отметь fully_preserved с перечислением деталей.\n' +
      '3) В detailed_description ссылайся на <Subject N> и повторяй ключевые детали — иначе MiniMax выдумает другого персонажа.\n' +
      'Если на рефе нет персонажа (только локация или стиль) — якорь не нужен.'
    : ''

  // ── Audio anchor: reference voice/tone for MiniMax (правки 36: модель НЕ слышит) ──
  // (правка 717) Пункты 3 и 4 слились с общим правилом «аудио не слышно»
  // из honestyBlock — здесь осталось только специфичное для MiniMax.
  const hasAudioRefs = audios.length > 0 || videos.some((r) => r.includeAudio)
  const audioAnchorBlock = hasAudioRefs
    ? '\n=== АУДИО-ЯКОРЬ ===\n' +
      'Аудио-референсы (и звуковые дорожки видео) прикреплены для MiniMax (ref_audios) — они задают ГОЛОС/ЗВУЧАНИЕ в генерации.\n' +
      '1) Ссылайся на <Audio N> (или звуковую дорожку <Video N>) как на референс голоса/звучания — MiniMax использует сам файл.\n' +
      '2) Реплику/текст бери ТОЛЬКО из запроса пользователя. Если он не дал текст — укажи, что персонаж говорит, и привяжи <Audio N>, но не выдумывай слова.\n' +
      '3) Характер голоса (тон, пол, возраст) указывай словами, только если пользователь его описал.'
    : ''

  // (правка 53) подсказка зависит от видения видео: при выключенном виде
  // модель не должна «смотреть» видео, а только ссылаться на тег <Video N>.
  const rescanHint = videoVisionOn
    ? 'use the reference digests/attached images and the video digests; do not invent details beyond them'
    : 'look at images; videos are TAGS ONLY — you do NOT see their frames, so never describe, guess or invent their content'

  // (правка 717) ОДИН блок вместо трёх: «СТРОГОЕ ПРАВИЛО ЧЕСТНОСТИ» +
  // «НЕЗАВИСИМОСТЬ ЧАТОВ» + «CHAT ATTACHMENTS» + хвост «Chat behaviour».
  // Пункты 1-3, 6 и 8 старых блоков говорили одно и то же разными словами
  // (метки запрещены / текущий список — истина / аудио не слышно), из-за
  // чего блок занимал ~2.4k токенов и правило «не слышишь аудио» повторялось
  // ещё и в аудио-якоре.
  const honestyBlock =
    '\n=== ЧЕСТНОСТЬ И ГРАНИЦЫ ЧАТА ===\n' +
    '1) Текущий список референсов выше — единственный источник правды. Описывай только их и только то, что в них реально есть. Чего не видишь или не уверен — прямо скажи «не вижу», не выдумывай.\n' +
    '2) Референсов, которых нет в текущем списке, БОЛЬШЕ НЕ СУЩЕСТВУЕТ: не переноси их описания из прошлых реплик этого чата.\n' +
    '3) Аудио ты НЕ слышишь: не цитируй и не описывай его содержимое, ссылайся только как <Audio N>; реплики бери из текста пользователя.\n' +
    '4) Этот чат — независимый диалог: сообщений других чатов ты не видишь и не помнишь. Не переноси оттуда тему, персонажей, сцены, промпт или настройки.\n' +
    '5) Черновик промпта из формы генерации тебе НЕ показан. Просят «улучшить текущий промпт», а текста нет — попроси нажать «Исправить мой промпт» или прислать текст. Не выдумывай его.\n' +
    '6) Вложения из чата — только для описания/анализа, это НЕ референсы генерации: НИКОГДА не помечай их <Picture N>/<Video N>/<Audio N>. Если вложение должно попасть в видео — скажи добавить его в референсы на вкладке «Генерация».'

  // (правка 540) 3D-болванка → ControlNet: тогл и инструкции убраны
  const guide3dBlock = ''

  return `${H3_SPEC}

=== SESSION CONTEXT ===
Длительность клипа: ~${seconds} с (${frames} кадров @ 24 fps). Таймкоды внутри длительности.
Бюджет шотов: не более ~${maxShots} (шот читается за ~2 с).${seconds <= 6 ? ' На такой длине — ОДИН непрерывный [Shot 1], без склеек.' : ' Посчитай [Shot N] до ответа: больше бюджета — объедини в более длинные шоты.'}

=== РЕЖИМ И РЕФЕРЕНСЫ ===
${attachedBlock}
${anchorBlock}${audioAnchorBlock}
${honestyBlock}
${guide3dBlock}

Перед КАЖДЫМ промптом сверься с ТЕКУЩИМ списком референсов выше (${rescanHint}), но НЕ пересказывай его пользователю и не повторяй список идей. Про длительность не спрашивай — она указана.`
}

/**
 * (правка 427) Системный промпт чата режима «Продление» (extend).
 * Отдельный от генерации: контекст — клипы продления (extendClips), ОТДЕЛЬНЫЕ
 * картинки-рефы продления (extendImageRefs, НЕ v.refs!) и метаданные исходного
 * видео (.meta.json: промпт исходника + история продлений). Главные правила:
 * промпт каждого клипа — отдельным ```text fence с маркером `clip: N` первой
 * строкой (UI вставляет в карточку по маркеру); <Video 1> и camera-lock
 * ЗАПРЕЩЕНЫ — они добавляются автоматически при сабмите (extend-view.tsx,
 * правки 165/197), дублирование портит conditioning.
 */
async function buildExtendSystemMessage(signal?: AbortSignal): Promise<string> {
  const v = useGenStore.getState().video
  const clips = v.extendClips
  const refs = v.extendImageRefs

  const lines: string[] = []
  lines.push('⚠️ РЕЖИМ ЧАТА: «Продление» (extend). Помогаешь писать промпты КЛИПОВ продления видео. Общего промпта здесь нет — каждый клип продолжает предыдущий (клип 1 продолжает исходное видео).')

  // ── Клипы продления: номер, длительность, текущий промпт ──
  lines.push('')
  if (clips.length) {
    lines.push(`КЛИПЫ ПРОДЛЕНИЯ (всего ${clips.length}):`)
    clips.forEach((c, i) => {
      const p = c.prompt.trim()
      lines.push(`  Клип ${i + 1}: ${c.duration} с, промпт: ${p ? `"${p}"` : '«пусто»'}`)
    })
  } else {
    lines.push('Клипов продления пока НЕТ. Если пользователь просит промпт для клипа — скажи, что клип нужно добавить на вкладке «Продление», либо предложи промпты с номерами клипов, которые надо создать.')
  }

  // ── Исходное видео ──
  if (v.extendSourceVideoPath) {
    lines.push(`Исходное видео: ${v.extendSourceName ?? v.extendSourceVideoPath}${v.extendSourceDuration > 0 ? ` (~${v.extendSourceDuration.toFixed(1)} с)` : ''}.`)
  } else {
    lines.push('Исходное видео пока НЕ выбрано — без него продление не запустится; при необходимости подскажи пользователю выбрать его на вкладке «Продление».')
  }

  // ── Референсы продления (extendImageRefs — своя нумерация <Picture N>) ──
  lines.push('')
  if (refs.length) {
    lines.push('РЕФЕРЕНСЫ ПРОДЛЕНИЯ (картинки; ты получаешь их визуальное описание/видишь приложенный файл):')
    refs.forEach((r, i) => {
      lines.push(`  <Picture ${i + 1}> = ${r.name}${r.imageIntent ? ` (используется как: ${r.imageIntent})` : ''}`)
    })
  } else {
    lines.push('РЕФЕРЕНСОВ ПРОДЛЕНИЯ НЕТ → метки <Picture N> ЗАПРЕЩЕНЫ, не выдумывай их.')
  }

  // ── Мета исходника: промпт оригинала + история продлений ──
  // Читаем .meta.json сайдкар (как extend-view.tsx, правка 389): модель должна
  // продолжать ИМЕННО эту сцену, а не выдумывать содержимое исходника.
  if (v.extendSourceName) {
    try {
      const metaPath = v.extendSourceSubfolder
        ? `${v.extendSourceSubfolder}/${v.extendSourceName}`
        : v.extendSourceName
      const mr = await fetch(`/api/comfy/meta?path=${encodeURIComponent(metaPath)}`, {
        // (правка 717) Таймаут и сигнал отмены. Раньше этот запрос шёл без
        // signal: зависший /api/comfy/meta навсегда подвешивал await, а
        // значит — и весь цикл стрима: UI оставался в состоянии «стримит»,
        // send() отказывал, и без «Стоп» чат было не разбудить.
        signal: signal ?? AbortSignal.timeout(8000),
      })
      if (mr.ok) {
        const meta = (await mr.json()) as {
          prompt?: unknown
          source_prompt?: unknown
          extend_prompts?: unknown
        }
        const srcPrompt =
          typeof meta.source_prompt === 'string' && meta.source_prompt.trim()
            ? meta.source_prompt.trim()
            : typeof meta.prompt === 'string'
              ? meta.prompt.trim()
              : ''
        const history = Array.isArray(meta.extend_prompts)
          ? meta.extend_prompts.filter((p): p is string => typeof p === 'string' && !!p.trim())
          : []
        if (srcPrompt || history.length) {
          lines.push('')
          lines.push('=== ИСХОДНОЕ ВИДЕО (из метаданных) ===')
          if (srcPrompt) lines.push(`Промпт исходника: "${srcPrompt.slice(0, 2000)}"`)
          if (history.length) {
            lines.push('История продлений (уже сгенерированные клипы, от старых к новым):')
            history.forEach((p, i) => lines.push(`  ${i + 1}. "${p.trim().slice(0, 500)}"`))
          }
        }
      }
    } catch { /* нет сайдкара/сеть — блок пропускаем, это не ошибка */ }
  }

  // (правка 717) Правила продления сжаты: 10 пунктов → 8 (было ~2.8k токенов).
  // Что важно и ОСТАЛОСЬ: маркер clip: N, «не переписывай статику»,
  // «метки <Picture N> только из списка», «один шот по умолчанию», «звук».
  // Что УБРАНО как дубли: «честность» (перенесена в общий блок ниже),
  // повтор «не переписывай статику» (было и в DETAIL_ACTION, и здесь),
  // повтор «метки только из списка» (было и тут, и в блоке честности).
  const rulesBlock =
    '\n=== ПРАВИЛА ПРОДЛЕНИЯ (строго) ===\n' +
    '1) Промпт КАЖДОГО клипа — ОТДЕЛЬНЫМ fence. ПЕРВАЯ строка внутри fence — маркер `clip: N` (N = номер карточки клипа из списка выше, 1-based), дальше — только текст промпта. UI вставляет промпт в карточку ПО ЭТОМУ МАРКЕРУ — без него вставка невозможна.\n' +
    '2) ЗАПРОС → ВСЕ КЛИПЫ: общий запрос пользователя распределяй последовательно на ВСЕ клипы из списка выше (clip: 1 … clip: N) с учётом длительности каждого. Меньше промптов, чем клипов, — только если пользователь явно просит конкретный клип («перепиши клип 2»).\n' +
    '3) НИКОГДА не пиши в промпте клипа метку <Video 1> и указания вида «продолжай ту же сцену/камеру» (camera lock) — они добавляются в КАЖДЫЙ клип автоматически. Дублирование портит промпт.\n' +
    '4) НЕ ПЕРЕОПИСЫВАЙ УЖЕ ДАННОЕ: модель видит хвост предыдущего видео и референсы — внешность, одежда, локация, свет и атмосфера УЖЕ заданы и продолжаются сами. Промпт клипа = НОВОЕ действие/движение/событие куска (и новые элементы, если появляются). Статику упоминай ТОЛЬКО если она меняется.\n' +
    '5) МЕТКИ РЕФЕРЕНСОВ: если есть картинки-рефы — при ПЕРВОМ упоминании персонажа/объекта в КАЖДОМ клипе ставь его метку <Picture N> («<Picture 1> останавливается и оборачивается…»). Только из списка выше. Метки <Subject N>, <Character N> и т.п. ЗАПРЕЩЕНЫ — они не привязаны ни к чему, и референс не сработает.\n' +
    '6) ОДИН ШОТ ПО УМОЛЧАНИЮ: всё продление — один непрерывный дубль (та же камера, то же действие разворачивается во времени). НЕ дроби клип на несколько шотов («[Shot 1]/[Shot 2]», «cut to») и не начинай клип «новым кадром». Мультишот — только по ЯВНОМУ просьбе («сделай мультишот», «другой ракурс»). Клипы продолжают друг друга бесшовно: клип 1 стартует с последнего кадра исходника, клип N — с последнего кадра клипа N−1; таймкоды укладывай в длительность клипа.\n' +
    '7) ЗВУК: если речь/диалог/озвучка НЕ запрошены — в overall_soundscape ОБЯЗАТЕЛЬНО первым словом напиши «no voice, no speech, no dialogue, no narration», потом ambient-звуки сцены. non_diegetic_music: N/A. Голос, реплики, закадровый текст и музыку по умолчанию НЕ добавляй.\n' +
    '8) Формат промпта клипа — как в спеке H3: integrated_multimodal_description / overall_soundscape / non_diegetic_music. Без camera-lock и без <Video 1>.'

  // (правка 717) Общий блок честности/границ — тот же, что в generate-режиме.
  const honestyBlock =
    '\n=== ЧЕСТНОСТЬ И ГРАНИЦЫ ЧАТА ===\n' +
    '1) Описывай только то, что видишь на референсах или знаешь из метаданных выше. Чего не видишь — прямо скажи «не вижу / не знаю», не домысливай содержимое исходного видео.\n' +
    '2) Клипы, референсы и исходник выше — ТЕКУЩЕЕ состояние вкладки «Продление» (общий рабочий стол), а не история чата. Клипы/рефы из прошлых реплик, которых нет в списках выше, больше НЕ существуют.\n' +
    '3) Этот чат — независимый диалог режима «Продление»: сообщений других чатов ты не видишь. Не переноси оттуда тему, персонажей, сцены или промпт.\n' +
    '4) Вложения из чата — только для описания, это НЕ референсы продления: НИКОГДА не помечай их <Picture N>. Если вложение должно попасть в видео — скажи добавить его в картинки-рефы на вкладке «Продление».'

  return `${H3_SPEC_EXTEND}

=== SESSION CONTEXT (ПРОДЛЕНИЕ) ===
${lines.join('\n')}
${rulesBlock}
${honestyBlock}

Промпт клипа — ТОЛЬКО в fence, первая строка — \`clip: N\`. Несколько клипов = несколько fence подряд. Короткая русская заметка до fence — ОК.
Перед КАЖДЫМ промптом перечитывай ТЕКУЩИЕ списки клипов и референсов выше (look at attached images).`
}

/**
 * (правка 502) Системный промпт чата режима «ControlNet».
 * Контрольное видео подаётся как <Video 1> (ref_video_0) — это официальный
 * видео-референс. Промпт — FORMAT B: с <Video 1> и (опционально) <Picture N>.
 * Движение НЕ описывай словами — его задаёт контроль; промпт описывает
 * ТОЛЬКО внешний вид: сцену, персонажей, стиль, свет, звук.
 */
function buildControlNetSystemMessage(videoVisionOn: boolean): string {
  const st = useControlNetTarget.getState()
  const direct = st.params.controlType === 'direct'

  const lines: string[] = []
  lines.push(
    direct
      ? '⚠️ РЕЖИМ ГЕНЕРАЦИИ: «ControlNet» (direct). Это перенос анимации: движения, жестов, тайминга и камеры — из контрольного видео; новый вид создаётся по запросу. Промпт описывает внешний вид, а не пересказывает движение. Формат — FORMAT B.'
      : '⚠️ РЕЖИМ ГЕНЕРАЦИИ: «ControlNet» (Ref2VA). Видео повторяет движение контрольного ролика; промпт описывает внешний вид. Формат — FORMAT B.',
  )

  // ── ПРИКРЕПЛЁННЫЕ РЕФЕРЕНСЫ ──
  lines.push('')
  lines.push('=== ПРИКРЕПЛЁННЫЕ РЕФЕРЕНСЫ (available references) ===')
  lines.push('⚠️ ТЕКУЩИЙ РЕЖИМ ГЕНЕРАЦИИ: «ControlNet» (Ref2VA).')
  if (st.source) {
    if (direct) {
      lines.push(`<Video 1> = ${st.source.filename} — ПРИКРЕПЛЕНО как контрольное видео и источник анимации (ref_video_0): тайминг, движения тела, жесты, мимика, камера и монтажный ритм.`)
      if (videoVisionOn) {
        lines.push('Ты получаешь digest/кадры этого видео (сцена, персонажи, движение, камера). Используй их, чтобы понять перенос анимации, но НЕ пересказывай движение в промпте.')
      } else {
        lines.push('Кадры/digest не приложены: видение видео ассистентом выключено. Не угадывай содержимое; в промпте только сошлись на <Video 1> как на источник движения.')
      }
    } else {
      lines.push(`<Video 1> = ${st.source.filename} — ПРИКРЕПЛЕНО как контрольное видео. Это официальный видео-референс: ОН ЕСТЬ в референсах.`)
      lines.push('Ты не видишь КАДРЫ этого видео (оно видео, не картинка) — но оно ПРИКРЕПЛЕНО и УЧИТываетСЯ при генерации. Движение/камера НЕ описываются словами (их задаёт контроль), но <Video 1> ОБЯЗАНО быть упомянуто в detailed_description.')
    }
  } else {
    lines.push('Контрольное видео пока НЕ выбрано — без него генерация не запустится; подскажи выбрать на вкладке «ControlNet».')
  }
  if (st.refImages.length) {
    lines.push('Изображения-референсы (ты получаешь их визуальное описание/видишь приложенный файл):')
    st.refImages.forEach((r, i) => {
      lines.push(`  <Picture ${i + 1}> = ${r.name}`)
    })
  } else {
    lines.push('Изображений-референсов НЕТ → метки <Picture N>, <Subject N> ЗАПРЕЩЕНЫ.')
  }
  lines.push('')
  lines.push(`Тип контроля: ${st.params.controlType}. Длительность: ~${st.params.duration} с.`)

  // ── Жёсткие правила режима ──
  // (правка 717) Сжато: 7 пунктов → 5, блок «ЧЕСТНОСТЬ» и «НЕЗАВИСИМОСТЬ
  // ЧАТОВ» объединены с «ЖЁСТКИМИ ПРАВИЛАМИ» (было ~1.3k токенов).
  // Direct — отдельная ветка: это не «карта движения», а перенос анимации.
  const rulesBlock = direct
    ? '\n=== ПРАВИЛА РЕЖИМА CONTROLNET (DIRECT: ПЕРЕНОС АНИМАЦИИ) ===\n' +
      '1) ⚠️ <Video 1> — источник анимации: движения тела, жестов, мимики, тайминга, камеры и монтажного ритма. В detailed_description ОБЯЗАТЕЛЬНО одной фразой укажи: «The motion, timing, gestures and camera movement follow <Video 1>». Другие метки <Video N> ЗАПРЕЩЕНЫ.\n' +
      '2) digest/кадры <Video 1> используй только чтобы понять перенос. НЕ расписывай движение и камеру по кадрам — контроль уже задаёт анимацию (это важнее общего требования базовой спеки описывать камеру). Если digest нет — не выдумывай содержимое видео.\n' +
      '3) Новый вид создавай по запросу и <Picture N>: по умолчанию НЕ копируй из <Video 1> лицо, внешность, одежду и локацию. Сохранять их можно только по ЯВНОЙ просьбе. Каждое изображение — своей меткой <Picture N> (создай <Subject N>).\n' +
      `4) Одна НЕПРЕРЫВНАЯ сцена (~${st.params.duration} с), английский, ОДИН fence (FORMAT B), БЕЗ clip: N.\n` +
      '5) ЗВУК: если речь/диалог/озвучка НЕ запрошены — overall_soundscape: ambient/тишина, non_diegetic_music: N/A. Голос, реплики, закадровый текст и музыку по умолчанию НЕ добавляй.\n' +
      '6) ЧЕСТНОСТЬ/ГРАНИЦЫ: список референсов выше — единственный источник правды; digest <Video 1> — только если приложен; деталей не выдумывай. Вложения чата — не референсы (никаких <Picture N>); другие чаты ты не видишь.'
    : '\n=== ПРАВИЛА РЕЖИМА CONTROLNET ===\n' +
      '1) ⚠️ ОБЯЗАТЕЛЬНО: <Video 1> — это контрольное видео, официальный видео-референс. УПОМЯНИ его в detailed_description («The camera and subject motion follow <Video 1>»). Другие метки <Video N> ЗАПРЕЩЕНЫ.\n' +
      '2) Движение/камеру/позы НЕ описывай словами — их задаёт контроль. Текст о движении МЕШАЕТ контролю.\n' +
      '3) Промпт описывает ТОЛЬКО: сцена/локация, внешность, одежда, стиль, свет, атмосфера, звук. Каждое прикреплённое изображение — со своей меткой <Picture N> (создай <Subject N>, привяжи к <Picture N>).\n' +
      `4) Одна НЕПРЕРЫВНАЯ сцена (~${st.params.duration} с), промпт на английском, ОДНИМ fence (FORMAT B). БЕЗ clip: N.\n` +
      '5) ЗВУК: если речь/диалог/озвучка НЕ запрошены — overall_soundscape: ambient/тишина, non_diegetic_music: N/A. Голос, реплики, закадровый текст и музыку по умолчанию НЕ добавляй.\n' +
      '6) ЧЕСТНОСТЬ: текущий список референсов выше — единственный источник правды. Кадров <Video 1> ты НЕ видишь (это видео, не картинка) — не угадывай и не описывай его содержимое, но в промпте он ОБЯЗАТЕЛЬНО упоминается. Деталей, которых не видишь на картинках, не выдумывай — скажи «не вижу».\n' +
      '7) Этот чат независим: сообщений других чатов ты не видишь. Источник, параметры и референсы выше — ТЕКУЩЕЕ состояние вкладки «ControlNet». Вложения из чата — только для описания, это НЕ референсы: НИКОГДА не помечай их <Picture N>.'

  return `${H3_SPEC_B}

=== SESSION CONTEXT (CONTROLNET) ===
${lines.join('\n')}
${rulesBlock}

Промпт — ОДИН \`\`\`text fence (FORMAT B), на английском. Русская заметка до fence — ОК.
${direct ? 'Главная связка: новый вид — из запроса и <Picture N>; анимация, тайминг и камера — из <Video 1>.' : 'Перед промптом перечитывай ТЕКУЩИЙ список референсов выше.'}`
}
/** Ensure roles alternate: merge consecutive same-role, and ensure first is user.
 *  Merge, NOT replace: два подряд user-сообщения появляются, когда прошлый
 *  запрос упал без ответа (409/503/сеть) — при замене терялся первый вопрос
 *  вместе с его контекстом; модель видела только последний. */
function sanitizeRoles(msgs: AssistantChatMessage[]): AssistantChatMessage[] {
  const out: AssistantChatMessage[] = []
  for (const m of msgs) {
    if (out.length && out[out.length - 1].role === m.role) {
      const prev = out[out.length - 1]
      const merged = typeof prev.content === 'string' && typeof m.content === 'string'
        ? `${prev.content}\n\n${m.content}`
        : m.content
      out[out.length - 1] = { ...prev, content: merged }
    } else {
      out.push(m)
    }
  }
  // LLM requires the first non-system message to be 'user'
  while (out.length && out[0].role !== 'user') out.shift()
  return out
}

/**
 * A one-character reply like "1" is ambiguous to a small local model,
 * especially when the system prompt is full of reference rules. If the
 * previous assistant message contains a numbered list, make the selection
 * explicit for this request only (the stored chat stays unchanged).
 */
function numberSelectionHint(msgs: AssistantChatMessage[], n: number): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== 'assistant' || typeof m.content !== 'string') continue
    const named = new RegExp(
      `(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:Идея|Вариант|Idea|Option)\\s*${n}\\b`,
      'i',
    )
    const numbered = new RegExp(
      `(?:^|\\n)\\s*\\*{0,2}${n}[.)]\\s+`,
    )
    if (named.test(m.content) || numbered.test(m.content)) {
      return `[Выбор пользователя: вариант ${n} из твоего предыдущего списка. Выдай готовый промпт именно для него. Не повторяй список идей и не пересказывай референсы.]`
    }
    // Only the immediately preceding assistant turn is relevant.
    return null
  }
  return null
}

/**
 * Build the multimodal reference list for the LLM: images, videos AND audios.
 * (правка 168) Источник — ЖИВОЕ состояние вкладки «Генерация» (gen-store):
 * модель видит контекст генерации автоматически, без ручных действий —
 * в том числе рефы, добавленные пользователем посреди диалога.
 * - images  → sharp-resized 512px JPEG  ({"type":"image"})
 * - videos  → whole downscaled video + its audio track when includeAudio
 * - audios  → 16 kHz mono WAV           ({"type":"audio"})
 * The server prepares the media (see src/lib/llm-media.ts).
 * (правка 427) В extend-чате источник — extendImageRefs вкладки «Продление».
 * (правка 502) В controlnet-чате — refImages вкладки «ControlNet»
 * (controlnet-target-store; пути — имена файлов в ComfyUI input/).
 */
/**
 * (правка 717) Лимиты референсов — как у самой модели H3 и как в UI
 * (generate-view.tsx: FALLBACK_REF_LIMITS = image 9 / video 3 / audio 3,
 * всего 15).
 *
 * Раньше список референсов НИЧЕМ не ограничивался, а сервер на /api/llm/chat
 * обрезал его до 9 позиций ПО ПОРЯДКУ. Из-за этого системный промпт
 * перечислял <Picture 10>, <Video 2>…, которые на провод не уходили: модель
 * писала в промпт метки несуществующих референсов и описывала картинки,
 * которых НЕ ВИДЕЛА. Теперь лимит применяется ЗДЕСЬ, по видам, и промпт
 * нумерует ровно то, что уйдёт на провод.
 */
const REF_LIMITS = { image: 9, video: 3, audio: 3, total: 15 } as const

function getReferences(chatMode: AssistantChatMode = 'generate'): Array<{
  path: string
  trigger: string
  intent?: string
  kind: 'image' | 'video' | 'audio'
  includeAudio?: boolean
}> {
  const v = useGenStore.getState().video
  // (правка 502) controlnet-чат: референсы — картинки вкладки «ControlNet»:
  // нумерация <Picture N> в системном промпте controlnet-чата идёт по ним.
  //
  // (direct) В режиме «Прямой» контрольное видео подаётся в H3 как
  // ref_video_0 и является источником анимации. Добавляем его в refs, чтобы
  // сервер построил digest по кадрам и закэшировал его по содержимому файла.
  // Для depth/canny/pose оставляем прежнее поведение: ассистент видит только
  // картинки, а движение задаёт карта.
  if (chatMode === 'controlnet') {
    const cn = useControlNetTarget.getState()
    const out: Array<{
      path: string
      trigger: string
      intent?: string
      kind: 'image' | 'video' | 'audio'
      includeAudio?: boolean
    }> = []
    if (cn.params.controlType === 'direct' && cn.source) {
      const sourcePath = cn.source.inputSource
        || (cn.source.subfolder ? `${cn.source.subfolder}/${cn.source.filename}` : cn.source.filename)
      out.push({
        path: sourcePath,
        trigger: 'Video 1',
        // inputSource — файл с диска, уже лежит в input/staging; иначе это
        // галерейный output-файл, и resolver должен искать его в output.
        intent: cn.source.inputSource ? 'control_source_input' : 'control_source',
        kind: 'video',
        includeAudio: false,
      })
    }
    for (const [i, r] of cn.refImages.entries()) {
      out.push({
        path: r.path,
        trigger: `Picture ${i + 1}`,
        kind: 'image',
      })
    }
    return out
  }
  // (правка 427) extend-чат: референсы — картинки вкладки «Продление»
  // (extendImageRefs), а НЕ v.refs вкладки «Генерация»: нумерация <Picture N>
  // в системном промпте extend-чата идёт по ним, и прикреплять надо именно их.
  if (chatMode === 'extend') {
    return v.extendImageRefs.map((r, i) => ({
      path: r.path,
      trigger: `Picture ${i + 1}`,
      intent: r.imageIntent || 'identity',
      kind: 'image' as const,
    }))
  }
  // (правка 150) В t2v/flf из рефов уходят ТОЛЬКО аудио (картинки/видео не используются нодой).
  // (правка 151) В flf: кадры (startFrame/endFrame) прикрепляются как image-рефы,
  // чтобы LLM их ВИДЕЛА и описала словами (запрет <Picture N> — см. system-промпт).
  const refs = v.mode === 'ref' ? v.refs : v.refs.filter((r) => r.kind === 'audio')
  const out: Array<{
    path: string
    trigger: string
    intent?: string
    kind: 'image' | 'video' | 'audio'
    includeAudio?: boolean
  }> = []
  const counters: Record<'image' | 'video' | 'audio', number> = { image: 0, video: 0, audio: 0 }

  // (правка 151) В flf-режиме кадры идут ПЕРВЫМИ (они главные), затем аудио.
  // LLM должна их увидеть и описать словами; <Picture N> запрещён в system-промпте.
  if (v.mode === 'flf') {
    // (правка 717) Кадры занимают слоты <Picture 1..2> — учитываем их в
    // лимите картинок, иначе общее число картинок могло превысить 9.
    if (v.startFrame?.path && counters.image < REF_LIMITS.image) {
      out.push({ path: v.startFrame.path, trigger: 'Первый кадр', intent: 'first_frame', kind: 'image' })
      counters.image++
    }
    if (v.endFrame?.path && counters.image < REF_LIMITS.image) {
      out.push({ path: v.endFrame.path, trigger: 'Последний кадр', intent: 'last_frame', kind: 'image' })
      counters.image++
    }
  }

  for (const r of refs) {
    // (правка 717) Лимит по видам + общий потолок. Приоритет: картинки
    // (их модель видит и они несут внешность), потом видео, потом аудио.
    if (out.length >= REF_LIMITS.total) break
    if (r.kind === 'image') {
      if (counters.image >= REF_LIMITS.image) continue
      out.push({ path: r.path, trigger: `Picture ${++counters.image}`, intent: r.imageIntent || 'identity', kind: 'image' })
    } else if (r.kind === 'video') {
      if (counters.video >= REF_LIMITS.video) continue
      out.push({ path: r.path, trigger: `Video ${++counters.video}`, kind: 'video', includeAudio: r.includeAudio })
    } else if (r.kind === 'audio') {
      if (counters.audio >= REF_LIMITS.audio) continue
      out.push({ path: r.path, trigger: `Audio ${++counters.audio}`, kind: 'audio' })
    }
  }
  return out
}

/* ── Live stream state (subscribed by mounted views) ────────────────── */

interface StreamState {
  /** Chat id of the in-flight reply, or null when idle. */
  chatId: string | null
  /** Accumulated assistant text of the in-flight reply. */
  text: string
  /**
   * (правка 717) Идентификатор ЭКЗЕМПЛЯРА стрима (монотонный счётчик).
   *
   * Раньше «это ещё мой стрим?» проверялось по chatId. Но после «Стоп» в том
   * же чате мог начаться НОВЫЙ стрим, и finally СТАРОГО стрима (он выполняется
   * асинхронно, на следующем тике) видел chatId === chatId и сбрасывал
   * состояние ЖИВОГО нового стрима: текст нового ответа пропадал, а
   * isStreamActive() становился false при running === true → следующее
   * сообщение молча терялось. Идентификатор экземпляра снимает гонку.
   */
  runId: number
}

export const useAssistantStream = create<StreamState>(() => ({
  chatId: null,
  text: '',
  runId: 0,
}))

let activeAbort: AbortController | null = null
let running = false
/** (правка 717) Счётчик экземпляров стрима. */
let runCounter = 0
/**
 * (правка 717) id текущего запроса к LLM — передаётся в тело /chat и в
 * /abort, чтобы прерывание попало ровно в эту генерацию (без адресации
 * «Стоп» мог оборвать СЛЕДУЮЩИЙ запрос).
 */
let activeRequestId: string | null = null

/** True while a reply is in flight (for guards from non-reactive code). */
export function isStreamActive(): boolean {
  return useAssistantStream.getState().chatId !== null
}

/**
 * Send history[] to the LLM, stream the reply, commit to the store.
 * Module-level: keeps running after AssistantView unmounts.
 * No-op while another reply is already in flight (one at a time).
 */
/** (правка 86; обновлено правкой 108) Вложение к сообщению чата:
 *  изображение или видео. (правка 108) Хранится в изолированном каталоге
 *  data/chat-attachments/ — файл существует ТОЛЬКО в чате и используется
 *  ТОЛЬКО для LLM-анализа/описания. НЕ смешивается с референсами генерации
 *  (<Picture N>/<Video N>), не лежит в ComfyUI/input/, не попадает в галерею,
 *  upscale и «чистку input». */
export interface ChatAttachment {
  /** Имя файла в хранилище вложений (data/chat-attachments/, или legacy ComfyUI/input/). */
  path: string
  /** Изначальное имя файла (для отображения). */
  name: string
  /** Тип медиа. */
  kind: 'image' | 'video'
  /** (правка 108) Legacy-вложение (правки 86–87) лежит в ComfyUI/input/ —
   *  сервер читает его из input/, но оно ТОЖЕ не является ген-рефом. */
  legacyComfy?: boolean
}

export function runAssistantCompletion(
  chatId: string,
  history: AssistantChatMessage[],
  attachments?: ChatAttachment[],
): void {
  if (running) return
  running = true
  const ac = new AbortController()
  activeAbort = ac
  // (правка 717) Идентификатор экземпляра стрима — по нему finally понимает,
  // «это ещё мой стрим» (см. StreamState.runId).
  const runId = ++runCounter
  // (правка 717) Адрес запроса для /abort.
  const requestId = `r${runId}_${Date.now().toString(36)}`
  activeRequestId = requestId
  useAssistantStream.setState({ chatId, text: '', runId })

  void (async () => {
    let final = ''
    // false = сервер ответил ошибкой на сам POST (409/503/...): показываем
    // ЭТУ ошибку; true = стрим начался и оборвался посередине
    let streamStarted = false
    // (клиентский idle-watchdog) объявлены ДО try: catch читает их даже если
    // throw случился до открытия стрима.
    let idleTimedOut = false
    // (правка 717) Ответ упёрся в лимит max_tokens (finish_reason='length'):
    // ответ неполный, но и не «ошибка» — помечаем в тексте.
    let truncatedByLimit = false
    // (правка 717) Ответ прерван пользователем («Стоп»).
    let abortedByUser = false
    // (правка 717) Текст ошибки запроса — попадёт в чат синтетической
    // репликой ассистента (вместо «осиротевшего» сообщения пользователя).
    let errorMessage: string | null = null
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    // (правка 267) Таймаут ожидания ЗАГОЛОВКОВ ответа: fetch до res.headers не
    // имеет ни таймаута, ни abort — зависший POST (VRAM-арбитр ждёт минутами)
    // оставлял running=true навсегда и блокировал чат. Взводим ДО первого
    // fetch, снимаем при получении заголовков; стоп пользователя (тот же
    // ac.signal) прерывает ожидание молча, таймаут — с ошибкой.
    // 10 минут: первый ход может сначала строить reference digests (несколько
    // изолированных LLM-вызовов) — 5 минут было слишком близко к таймауту на
    // наборе из 9 картинок + 3 видео.
    let headerTimedOut = false
    let headerTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      headerTimedOut = true
      ac.abort()
    }, 10 * 60_000)
    try {
      // (правка 427) Режим ЧАТА (generate/extend/controlnet (правка 502)) —
      // из стора чатов по chatId:
      // от него зависят системный промпт и набор прикрепляемых референсов
      // (контексты вкладок «Генерация»/«Продление»/«ControlNet» не смешиваются).
      const chatMode: AssistantChatMode =
        useAssistantChats.getState().chats.find((c) => c.id === chatId)?.mode ?? 'generate'
      // (правка 168) Рефы для прикрепления — из ЖИВОГО gen-store: модель видит
      // контекст генерации автоматически, включая рефы, добавленные посреди
      // диалога. Никаких ручных привязок.
      const refs = getReferences(chatMode)
      // (правка 108) Вложения чата — ОТДЕЛЬНО от рефов генерации: они существуют
      // ТОЛЬКО в чате и нужны ТОЛЬКО для LLM-описания/анализа. В references
      // (<Picture N>/<Video N>) они НЕ попадают — сервер получает их отдельным
      // полем chatAttachments, прикрепляет как «Chat N» и запрещает тегирование
      // в промпте (раньше они пушались в refs → LLM вписывала <Picture N> →
      // MiniMax подтягивал файл из input/ в генерацию).
      const chatAttachments = (() => {
        // (правка 717) Вложения чата переприкрепляются на КАЖДЫЙ ход.
        // Раньше attachments приходили только для того хода, где файл был
        // загружен, и со следующего сообщения модель картинку НЕ ВИДЕЛА —
        // хотя её вопрос («что на фото?») оставался в истории. Правило
        // «не выдумывай, чего не видишь» толкало модель сказать «не вижу»
        // или выдумать. Теперь берём вложения последних ходов из истории
        // сообщений (там они сохранены вместе с текстом).
        const explicit = attachments?.length
          ? attachments.map((a) => ({
              path: a.path,
              name: a.name,
              kind: a.kind,
              legacyComfy: a.legacyComfy === true,
            }))
          : []
        if (explicit.length) return explicit
        const fromHistory: Array<{ path: string; name: string; kind: 'image' | 'video'; legacyComfy?: boolean }> = []
        for (const m of history) {
          if (m.role !== 'user' || !m.attachment) continue
          fromHistory.push({
            path: m.attachment.path,
            name: m.attachment.name,
            kind: m.attachment.kind,
            legacyComfy: m.attachment.src !== 'chat',
          })
        }
        // Не больше 3 (лимит вложений на ход) — иначе раздувается префилл.
        return fromHistory.slice(-3)
      })()
      // (правка 53) Свежее значение «видение видео» из конфига — системный
      // промпт должен совпадать с тем, что сервер реально прикрепит.
      // Лёгкий локальный GET; при ошибке остаёмся по умолчанию (выкл).
      let videoVisionOn = true
      try {
        const cfgRes = await fetch('/api/config', { signal: ac.signal })
        if (cfgRes.ok) {
          const cfg = await cfgRes.json()
          videoVisionOn = cfg.llm_video_vision !== false
        }
      } catch { /* ignore — default ON (сжатый digest) */ }
      // The stored history is untouched; this copy may get a one-line
      // clarification for numeric selections ("1", "2", ...).
      const apiHistory = sanitizeRoles(history.slice(-HISTORY_LIMIT))
      const lastApiMsg = apiHistory[apiHistory.length - 1]
      if (lastApiMsg && lastApiMsg.role === 'user' && typeof lastApiMsg.content === 'string') {
        const selection = /^\s*([1-9]|1[0-9]|2[0-5])\s*$/.exec(lastApiMsg.content)
        if (selection) {
          const hint = numberSelectionHint(apiHistory.slice(0, -1), Number(selection[1]))
          if (hint) {
            apiHistory[apiHistory.length - 1] = {
              ...lastApiMsg,
              content: `${lastApiMsg.content.trim()}\n\n${hint}`,
            }
          }
        }
      }
      const res = await fetch('/api/llm/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // (правка 717) request_id — адрес прерывания: /abort с этим id
          // останавливает именно эту генерацию.
          request_id: requestId,
          messages: [
            // (правка 168) Системный промпт строится по ЖИВОМУ состоянию
            // вкладки «Генерация» (режим, рефы, кадры, длительность) — модель
            // видит контекст генерации сама, без ручных действий. Черновик
            // промпта сюда НЕ входит: это был канал утечки тем между чатами;
            // при необходимости пользователь цитирует его в сообщении
            // (кнопка «Улучшить мой промпт» делает это автоматически).
            // (правка 427) Для extend-чата — системный промпт продления
            // (клипы, extend-рефы, мета исходника); await: дочитывает мету.
            { role: 'system', content: await buildSystemMessage(videoVisionOn, chatMode, ac.signal) },
            // Replay the (capped) chat history so the model "remembers"
            ...apiHistory,
          ],
          // Send image references so the server can inject them as vision
          ...(refs.length > 0 ? { references: refs } : {}),
          // (правка 108) Вложения чата — отдельное поле (НЕ references):
          // сервер читает их из data/chat-attachments/ (или legacy input/)
          // и прикрепляет к LLM как «Chat N» с запретом тегов <Picture N>.
          ...(chatAttachments ? { chatAttachments } : {}),
        }),
        signal: ac.signal,
      })
      // (правка 267) Заголовки получены — header-таймаут снимаем; дальше
      // сторожит idle-watchdog тела стрима.
      if (headerTimer) {
        clearTimeout(headerTimer)
        headerTimer = null
      }
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => '')
        let msg = `HTTP ${res.status}`
        try {
          msg = (JSON.parse(errText) as { error?: string }).error || msg
        } catch {
          /* keep */
        }
        throw new Error(msg)
      }
      const reader = res.body.getReader()
      streamStarted = true
      const decoder = new TextDecoder()
      let buf = ''
      // (клиентский idle-watchdog) Half-open соединение (сон/гибернация ПК,
      // сдохший прокси) не разрешает reader.read() никогда — стрим висел
      // вечно, чат блокировался до перезагрузки страницы. Зеркалим серверный
      // сторож: 5 мин без единого чанка = принудительный abort с тостом.
      idleTimer = setTimeout(() => {
        idleTimedOut = true
        ac.abort()
      }, 5 * 60_000)
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          idleTimedOut = true
          ac.abort()
        }, 5 * 60_000)
      }
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          armIdle()
          buf += decoder.decode(value, { stream: true })
        const events = buf.split('\n\n')
        buf = events.pop() ?? ''
        for (const ev of events) {
          const line = ev.split('\n').find((l) => l.startsWith('data: '))
          if (!line) continue
          // JSON.parse — в ОТДЕЛЬНОМ try: раньше фильтр «не JSON в сообщении»
          // глотал и payload.error, если текст ошибки сервера упоминал JSON
          // (например, исключения llama-cpp) — стрим «завершался» как успешный
          // с обрезанным ответом.
          // (правка 717) Сервер различает «дошли до конца» и «оборвалось»:
          // финальный кадр несёт finish_reason и флаг aborted (см.
          // tools/llm_server.py). Раньше клиент эти поля ИГНОРИРОВАЛ, и
          // оборванный ответ коммитился в чат как ПОЛНЫЙ — пользователь видел
          // готовый промпт, которого на самом деле нет.
          let payload: {
            delta?: string
            error?: string
            done?: boolean
            aborted?: boolean
            finish_reason?: string | null
          } | null = null
          try {
            payload = JSON.parse(line.slice(6))
          } catch {
            continue // битый/незавершённый чанк — ждём следующий
          }
          if (!payload) continue
          if (payload.error) throw new Error(payload.error)
          if (payload.aborted) {
            throw new Error('Ответ прерван (остановлен пользователем или сбой сервера).')
          }
          if (payload.done && payload.finish_reason === 'length') {
            // Ответ упёрся в max_tokens — это не «ошибка», но и не полный
            // промпт. Помечаем, чтобы пользователь знал.
            truncatedByLimit = true
          }
          if (payload.delta) {
            final += payload.delta
            const s = useAssistantStream.getState()
            // (правка 717) Сверяем ЭКЗЕМПЛЯР стрима, а не чат: после «Стоп»
            // в том же чате мог начаться новый стрим, и старый дописывал бы
            // свой текст в его хвост.
            if (s.runId === runId) useAssistantStream.setState({ text: final })
          }
        }
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
      }
    } catch (err) {
      if (headerTimer) {
        clearTimeout(headerTimer)
        headerTimer = null
      }
      // (правка 717) AbortError БЕЗ header/idle-таймаутов = пользователь
      // нажал «Стоп» (см. stopAssistantStream). Помечаем ответ как прерванный,
      // чтобы обрывок не был закоммичен как готовый промпт.
      if ((err as Error).name === 'AbortError' && !idleTimedOut && !headerTimedOut) {
        abortedByUser = true
      }
      if ((err as Error).name !== 'AbortError' || idleTimedOut || headerTimedOut) {
        // Ошибка ДО старта стрима = структурированный ответ сервера
        // (409 «идёт генерация», 503 «не освободил VRAM», ...) — показываем
        // её как есть, БЕЗ маскирующих «дружелюбных» подмен.
        // Обрыв уже начавшегося ответа — отдельный случай.
        let msg = err instanceof Error ? err.message : String(err)
        if (headerTimedOut) {
          // (правка 267) Сервер принял запрос и не отдал заголовки 5 мин
          // (зависший VRAM-арбитраж/сервер) — освобождаем чат и сервер.
          msg = 'Ассистент не ответил за 5 минут (сервер занят или завис) — запрос прерван. Отправьте сообщение ещё раз.'
        } else if (idleTimedOut) {
          msg = 'Ответ ассистента завис (нет данных 5 мин) — соединение прервано. Отправьте сообщение ещё раз.'
        } else if (streamStarted) {
          try {
            const s = (await fetch('/api/llm/status').then((r) => r.json())) as LlmStatusResp
            if (s && !s.running) {
              msg = 'Соединение с ассистентом оборвалось (сервер остановился). Отправьте сообщение ещё раз — ассистент поднимется заново.'
            }
          } catch {
            /* status unavailable — показываем исходную ошибку */
          }
        }
        toast.error('Ассистент', { description: msg })
        if (idleTimedOut || headerTimedOut) void fetch('/api/llm/abort', { method: 'POST' }).catch(() => {})
        // (правка 717) Ошибку фиксируем В ЧАТЕ, а не только тостом: тост
        // исчезает через несколько секунд, и сообщение пользователя оставалось
        // без ответа навсегда. На следующем ходу sanitizeRoles сливал два
        // user-сообщения, и невыясненный вопрос смешивался со следующим.
        // Синтетическая реплика ассистента делает сбой видимым и durable.
        errorMessage = msg
      }
    } finally {
      // Commit the finished assistant reply to the persisted chat. This runs
      // even when the view is UNMOUNTED — exactly what makes the answer
      // survive tab switches.
      //
      // (правка 717) Прерванный ответ НЕ коммитится как готовый: раньше
      // обрыв (abort, обрыв сокета, finish_reason='length') молча
      // сохранял полупромпт в чат, и пользователь видел «готовый» ответ,
      // которого нет. Теперь в текст добавляется явная пометка.
      if (final.trim()) {
        const marker = abortedByUser
          ? '\n\n_[Ответ прерван — показан обрывок.]_'
          : truncatedByLimit
            ? '\n\n_[Ответ обрезан лимитом длины ответа — показан обрывок.]_'
            : errorMessage
              ? '\n\n_[Соединение прервано — показан обрывок.]_'
              : ''
        useAssistantChats.getState().appendMessage(chatId, {
          role: 'assistant',
          content: final + marker,
        })
      } else if (errorMessage) {
        // (правка 717) Ответа не было вовсе — оставляем в чате явную
        // реплику ассистента, чтобы не «осиротело» сообщение пользователя.
        useAssistantChats.getState().appendMessage(chatId, {
          role: 'assistant',
          content: `_[Ошибка: ${errorMessage}]_`,
        })
      }
      // (правка 268) Сбрасываем running/activeAbort только если стрим всё ещё
      // НАШ: stopAssistantStream теперь сбрасывает состояние синхронно, и новый
      // стрим мог начаться ДО нашего finally — без guard он «погасил» бы чужой
      // running и чужой AbortController.
      if (activeAbort === ac) {
        running = false
        activeAbort = null
      }
      // (правка 717) Сбрасываем живое состояние ТОЛЬКО своего экземпляра.
      // Проверка по chatId была недостаточна: после «Стоп» в этом же чате
      // мог начаться новый стрим, и finally старого гасил его (текст нового
      // ответа пропадал, а running оставался true → следующее сообщение
      // молча терялось). Сверяем runId.
      if (useAssistantStream.getState().runId === runId) {
        useAssistantStream.setState({ chatId: null, text: '', runId })
      }
    }
  })()
}

/** Stop the in-flight reply (user pressed «Стоп»). */
export function stopAssistantStream(): void {
  // (правка 268) Синхронный сброс состояния ДО abort: раньше running=false и
  // сброс chatId происходили только в finally асинхронного цикла чтения, и
  // send(), вызванный в это окно, проходил guard isStreamActive(), но молча
  // отбрасывался (текст терялся). Теперь повторная отправка сразу видит
  // свободный движок. Повторный вызов (activeAbort уже null) — no-op:
  // /api/llm/abort не шлём дважды.
  const ac = activeAbort
  if (!ac) return
  activeAbort = null
  running = false
  const requestId = activeRequestId
  activeRequestId = null
  // (правка 717) Сбрасываем Идентификатор экземпляра, чтобы finally старого
  // стрима не счёл свой runId актуальным и не погасил новый стрим в этом чате.
  useAssistantStream.setState({ chatId: null, text: '', runId: 0 })
  ac.abort()
  // (правка 717) /api/llm/abort — С request_id и с ожиданием ответа: раньше он
  // был fire-and-forget и мог прийти ПОЗЖЕ следующего /chat, обрывая уже
  // НОВУЮ генерацию. Теперь прерывание адресное, а клиент ждёт его завершения
  // до возврата (кнопка «Стоп» гасит только текущий запрос).
  const abortUrl = requestId
    ? `/api/llm/abort?request_id=${encodeURIComponent(requestId)}`
    : '/api/llm/abort'
  void fetch(abortUrl, { method: 'POST' }).catch(() => {})
}

/**
 * Stop the in-flight reply ONLY if it belongs to `chatId` (правка 32).
 *
 * Used when deleting the chat that owns the stream: the engine's `finally`
 * runs its `appendMessage` AFTER the chat is already gone, so the partial
 * reply is dropped (the store map finds no such chat) — exactly what we want
 * — and the model is freed via the abort POST. No-op when the stream is
 * owned by another chat or when idle.
 */
export function stopStreamForChat(chatId: string): void {
  if (useAssistantStream.getState().chatId !== chatId) return
  stopAssistantStream()
}
