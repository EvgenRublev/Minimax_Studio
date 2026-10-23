# Воркфлоу продления видео (режим «Extend») — РАБОЧАЯ СХЕМА (правки 419+420)

> ✅ **ПРОВЕРЕНО ПОЛЬЗОВАТЕЛЕМ 11.10.2026 — «работает ИДЕАЛЬНО, ещё и быстрее
> в разы».** Цепочка ниже — эталон. Не менять параметры подачи, не «улучшать»
> окно контекста и способ референса без живого теста продления: каждая из
> этих вещей уже ломала режим (см. §7 «История регрессий»).
>
> Источник истины — функция `buildExtendWorkflow()` в
> `src/lib/comfy/minimax-h3-template.ts` и UI-слой
> `src/components/h3/extend-view.tsx`, `src/hooks/use-video-gen.ts`.
> Снапшот нашей рабочей сборки (правки 419+420, формат prompt-API, 2 клипа —
> включая цепочку сегментов и пост-сборку combined-латента):
> **`docs/Minimax_Studio_Extend_Workflow_420.json`**
> — можно грузить в ComfyUI напрямую или сравнивать при правках.
> Эталонный воркфлоу-референс:
> `docs/Minimax-H3_V2V_Extend_Any_Video_latent_masking.json` — правка 419
> приводит подачу к нему.

## 0. ЗОЛОТАЯ ЦЕПОЧКА (краткая шпаргалка)

| Параметр подачи | Значение | Чем грозит отклонение |
| --- | --- | --- |
| Окно контекста исходника (`tailFrames`) | **2 с = 56 кадров** (сетка 17k+5, кламп к длине исходника вниз) | 5-с окно скармливает модели ВЕСЬ 5-секундный клип и в затравку, и в референс → модель «до-рендеривает» исходник заново (реплей с кадра 0) вместо продолжения |
| Референс исходника в conditioning | **весь клин (батч кадров) как `ref_images.ref_image_N`** (слот после картинок юзера), нода `extv_fres` | Подача через `ref_videos`/`ref_video_audios` вместе с 5-с окном давала тот же реплей; эталон подаёт видео именно картинкой |
| Перекрытие сегмент-к-сегменту (`CHAIN_OVERLAP_FRAMES`) | **56 кадров** (то же 2-с окно) | — |
| Затравка (preserved-голова клипа 0) | пиксельный VAE-энкод последних `tailFrames` кадров (`extv_tres`→`extv_tenc`), маска 0 | — |
| Шов «исходник → клип 0» | 17 кадров: срез головы файла клипа на `tailFrames − 17` (`ext_sl_0`) + ffmpeg Trim 9/24 + xfade 8/24 | Без среза головы файл клипа нёс ВЕСЬ хвост → «оригинал, ещё раз оригинал, потом новое» (правка 418 чинила именно это) |
| Схема вывода | **поштучные файлы клипов** `Minimax_Studio_extclip_<i>` + ffmpeg-склейка `/api/comfy/concat` | Комбинированный латент-вывод одним файлом (правки 383–416) откачен: реплей/заморозка/стыковые артефакты |
| Сэмплер | euler + `simple` + `firstSamplerSteps` (UI), **denoise=1** + SetLatentNoiseMask | — (в эталоне er_sde/beta/6 — не портировано, текущее работает) |
| Аудио-продолжение | из preserved-аудио-латента; аудио-референс в conditioning НЕ подаётся | — |
| **Combined-латент итога** (правка 420) | ПОСТ-СБОРКА после сэмплеров (модель не участвует!): `src[:F−17] ⊕ клип0[от tailFrames−17] ⊕ клипы i>0[от 56]` → `latents/Minimax_Studio_combined_*.latent`, `latent_file` в мету итога | Собирать латент ДО/ВО ВРЕМЯ генерации и подавать в сэмплер — ЗАПРЕЩЕНО (комбинер 383–416: реплей/заморозка). Пост-сборка безопасна: это чистые срезы/конкаты готовых выходов |

---

## 1. Архитектура (общая схема)

Продление = **однопроходная** генерация цепочки клипов с **латент-маскингом**
(по референсу «V2V Extend Any Video (latent masking)»). Никаких проходов
low-res → upscale → high-res нет: единственная канва = разрешение исходника.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                        MODEL LOADING (общие ноды)                          │
│  UNETLoader ('46:30') → CLIPLoader ('46:15') →                             │
│  VAELoader video ('46:3') → VAELoader audio ('46:4')                       │
└────────────────────────────────────────────────────────────────────────────┘
                                   │
┌────────────────────────────────────────────────────────────────────────────┐
│                     MODEL OPTIMIZATION CHAIN                               │
│  [MiniMaxLowVRAMAttention '46:43'] → [MiniMaxChunkFeedForward '46:40'] →   │
│  [LoraLoaderModelOnly Turbo '46:36'] → [custom LoRAs] →                    │
│  MiniMaxH3SigmaShift '46:38' (shift_video=12, shift_audio=3) →             │
│  [VedaSparseAttention | MiniMaxSparseAttention '46:44'] →                  │
│  ModelAttentionBackend '46:37' → ModelPreviewOverrideKJ 'extpv'            │
└────────────────────────────────────────────────────────────────────────────┘
                                   │
┌────────────────────────────────────────────────────────────────────────────┐
│            SOURCE VIDEO CHAIN (хвост исходника, только если есть           │
│            исходник — hasSeed = !!p.extendSourceVideo)                     │
│  VHS_LoadVideo 'extv_load' (force_rate=24!) →                              │
│  GetImageSizeAndCount 'extv_cnt' + ComfyMathExpression 'extv_tailidx'      │
│    (batch_index = max(0, count − tail)) →                                  │
│  ImageFromBatch 'extv_tail' (последние tailFrames = 56 кадров) →           │
│  ImageResizeKJv2 'extv_tres' (→ канва genW×genH) →                         │
│  VAEEncode 'extv_tenc' (видео)                                             │
│  MiniMaxH3AudioSliceFrom 'extv_asl_seed' (аудио-хвост той же длины,        │
│    start_seconds = −tailFrames/24) → VAEEncodeAudio 'extv_taenc'           │
│  LTXVConcatAVLatent 'extv_seed' → LTXVSeparateAVLatent 'extv_ssep'         │
│  ImageResizeKJv2 'extv_fres' (ВЕСЬ клин → канва) — реф для conditioning    │
│    (правка 419)                                                            │
└────────────────────────────────────────────────────────────────────────────┘
                                   │
┌────────────────────────────────────────────────────────────────────────────┐
│              PER-CLIP ЦЕПОЧКА (по одной на клип i = 0..N−1)                │
│  MiniMaxH3ReferenceToVideo 'ext_cond_i' (conditioning + рефы:              │
│    картинки юзера ref_image_0..k−1 + ИСХОДНИК ЦЕЛИКОМ ref_image_k,         │
│    правка 419 — ref_videos не используется)                                │
│  EmptyMiniMaxH3LatentAV 'ext_empty_i' (totalFrames кадров)                 │
│  LatentCut (хвост прошлого) → LatentConcat → LatentCut (trim)              │
│  маски (EmptyImage/ImageBatchMulti/ImageToMask — видео;                    │
│         SolidMask/MaskComposite — аудио) → SetLatentNoiseMask              │
│  LTXVConcatAVLatent 'ext_join_i'                                           │
│  RandomNoise + BasicScheduler 'ext_sched_i' (denoise=1) + BasicGuider +    │
│  SamplerCustomAdvanced 'ext_samp_i' → LTXVSeparateAVLatent 'ext_ssep_i'    │
│  VAEDecode 'ext_decv_i' + VAEDecodeAudio 'ext_deca_i'                      │
│  GetImageRangeFromBatch 'ext_sl_i' + MiniMaxH3AudioSliceFrom 'ext_asl_i'   │
│    (срез preserved-головы) → [ImageCrop 'ext_crop_i'] →                    │
│  VHS_VideoCombine 'ext_out_i' → Minimax_Studio_extclip_<i>_*.mp4           │
└────────────────────────────────────────────────────────────────────────────┘
                                   │
┌────────────────────────────────────────────────────────────────────────────┐
│              ПОСТ-ОБРАБОТКА (Next.js, вне ComfyUI)                         │
│  /api/comfy/concat: исходник (trim 9/24 с с конца) + клип 0 + ... +       │
│  клип N−1 → Minimax_Studio_combined_*.mp4 (seam-fade 8/24 с только на     │
│  стыке «исходник → клип 0», между клипами fade=0 — жёсткая склейка) →     │
│  удаление extclip-клипов → .meta.json на итоговом файле                    │
└────────────────────────────────────────────────────────────────────────────┘
```

## 2. Ключевые параметры и константы

| Параметр | Значение / источник | Комментарий |
| --- | --- | --- |
| Канва генерации | `targetDimensions` исходника (ffprobe, проставляет роут), ceil16 | Без исходника — MP-путь `finalDimsFromMegapixels(aspectRatio, finalResolution ?? 0.7)` |
| FPS на входе | 24 (`VHS_LoadVideo force_rate=24`) | Исходник 25/30 fps нормализуется, иначе скачок скорости на шве (правка 211) |
| FPS на выходе | 24 (`VHS_VideoCombine frame_rate=24`) | формат/качество — из [video] настроек студии (правка 386) |
| Сетка кадров | `snapUp`: F ≥ 5, (F − 5) % 17 == 0 | Токены видео-латента: `tok(F) = round(((F−5)/17)*5 + 2)` |
| Аудио-шаги | `round(F × 5/3)` | F кадров × 40 Гц / 24 fps |
| `tailFrames` (хвост исходника) | **2 с = 56 кадров** (`framesForDuration(2)`), кламп к длине исходника, выравнивание ВНИЗ по сетке | **Правка 419 (эталон V2V Extend)**. ЗАПРЕЩЕНО возвращать «min 5 с» (правка 322): на 5-секундных исходниках модель получала весь клин в затравку+референс и реплеила его с кадра 0 |
| `CHAIN_OVERLAP_FRAMES` | **56** | Правка 419: перекрытие между клипами i−1 → i = тому же 2-с окну (раньше 22) |
| `seamOverlapFrames` | 17 | Геометрия шва «исходник → клип 0»: 9 кадров trim исходника + 8 кадров fade (историческая ffmpeg-склейка) |
| `sliceStart` (срез головы файла клипа 0) | `max(0, tailFrames − 17)` → 39 при tail=56 | Правки 216/251, восстановлено правкой 418 после потери при 417: клип 0 пишется в файл только с 17-кадровым перекрытием шва |
| Длительность клипа | **минимум 5 с** (жёсткий кламп в `extend-view.tsx`, правка 309) | При более коротких клипах первый кадр клипа 0 отъезжает от хвоста |
| Сэмплер клипа | `KSamplerSelect` = `pass1Sampler` (default `euler`), шаги = `firstSamplerSteps` (default 4) | Сигмы — от `BasicScheduler` (scheduler = `pass1Scheduler`, default `simple`), **denoise = 1** |
| denoise = 1 | правка 291 | Эталонная схема latent masking: шум добавляется ТОЛЬКО в белую зону маски; чёрная зона (хвост) восстанавливается из входного латента без перешумливания |
| Seed клипа | `clips[i].seed < 0 ? seed + i : clips[i].seed` | Базовый seed — случайный при `p.seed < 0` |
| Turbo LoRA | вкл по умолчанию, strength 0–2 (default 1.0) | `LoraLoaderModelOnly '46:36'` |

## 3. Как работает стык «оригинал → клип 0 → клип 1 → …»

### 3.1. Conditioning клипа (`ext_cond_i`)

- Нода `MiniMaxH3ReferenceToVideo`: prompt клипа, width/height = канва,
  length = totalFrames, `ref_image_size` = `referenceDetail` (`match`/`max`).
- Картинки-рефы пользователя (до 9) — обычные `LoadImage` + привязка
  `ref_images.ref_image_N` (правка 266), как в режиме 'ref'.
- **(правка 419)** Если есть исходник: ВЕСЬ клин (батч кадров, `extv_fres`)
  подаётся как **`ref_images.ref_image_N`** — слотом ПОСЛЕ картинок юзера.
  `ref_videos` / `ref_video_audios` НЕ используются (эталон подаёт видео
  именно картинкой; аудио-продолжение идёт из preserved-аудио-латента).
- Промпт клипа 0 получает преамбулу продолжения (`CONTINUATION_PREAMBLE`,
  правка 207) с меткой `<Video 1>`; UI дополнительно оборачивает промпт:
  префикс `<Video 1>` + `CAMERA_LOCK`-директива, если их нет в тексте
  (`extend-view.tsx`).

### 3.2. Латент клипа (правка 252)

Окно клипа i = `overlapFrames ⊕ clipFrames`, приведённое к сетке `snapUp`:

- клип 0: `overlapFrames = tailFrames` = **56** (пиксельный VAE-энкод хвоста
  исходника, `extv_ssep` — правка 409/417);
- клип i > 0: `overlapFrames = CHAIN_OVERLAP_FRAMES = 56` (хвост ВЫХОДА
  сэмплера клипа i−1 — `LatentCut` последних `oTok` токенов из `ext_ssep_{i-1}`).

Видео: `LatentCut` (хвост прошлого) ⊕ `LatentConcat` с пустым латентом →
`LatentCut` trim до `tTok` токенов. Маска — жёсткая: чёрная (`color: 0`) на
`oTok` токенов головы + белая на остальное (`EmptyImage` × 2 →
`ImageBatchMulti` → `ImageToMask`) → `SetLatentNoiseMask`.

Аудио — тот же паттерн вдоль оси x: `LatentCut`/`LatentConcat`/`LatentCut`,
маска через `SolidMask` (чёрная канва `aTotal`) + `SolidMask` (белая
`aTotal − aOver`) → `MaskComposite` (x = aOver) → `SetLatentNoiseMask`.

Без исходника у клипа 0 preserved-головы нет — чистая генерация (маски и
concat не создаются, латент = пустой trim).

### 3.3. Сэмплинг и декод

- `SamplerCustomAdvanced`: noise (`RandomNoise`, seed клипа) + `BasicGuider`
  (модель = `extpv` с живым превью, conditioning = `ext_cond_i`) +
  `KSamplerSelect '46:18a'` + sigmas от `BasicScheduler` (denoise=1).
- Выход сэмплера разделяется `LTXVSeparateAVLatent 'ext_ssep_i'` — его хвост
  становится preserved-головой следующего клипа.
- Декод: `VAEDecode` + `VAEDecodeAudio`.

### 3.4. Срез preserved-головы (внутри workflow)

- **Клип 0 (с исходником)**: окно «хвост⊕продолжение», срез за 17 кадров до
  конца хвоста (`ext_sl_0`, `start_index = tailFrames − 17`; аудио `ext_asl_0`
  от `sliceStart/24`) — шов на перекрытии (правки 216/251, восстановлено
  правкой 418). Файл клипа = [17 кадров перекрытия][новое содержимое].
- **Клип i > 0**: срез ВСЕЙ preserved-головы (`start_index` = 56) — файл
  клипа = чистое новое содержимое. Аудио — срез от `56/24` с.
- Дальше опциональный `ImageCrop` (если gen ≠ out) и `VHS_VideoCombine`
  (`Minimax_Studio_extclip_<i>` в подпапке `outputSubfolder`, если задана).

### 3.5. Склейка (Next.js, `/api/comfy/concat`)

- Входы: исходник (с trim 9/24 с с конца — `sourceTrimSeconds`) + extclip-файлы
  по порядку индексов из имён `Minimax_Studio_extclip_<i>`.
- Seam-fade 8/24 с ТОЛЬКО на стыке «исходник → клип 0» (`seamFadeSeconds`);
  между клипами `fade: 0` — жёсткая склейка (xfade на 1 кадр давал
  «задвоение» на стыках).
- Результат: `Minimax_Studio_combined_*.mp4`; после успешного concat
  промежуточные extclip-файлы удаляются (правка 291).
- При error/cancel extend-задачи extclip-мусор чистится `cleanupExtendClips`
  (правка 336, `use-video-gen.ts`): фильтр по имени, своей подпапке и
  mtime ≥ started_at − 10 с — чужие клипы параллельной задачи не трогаются.
- (правка 384, ОТКАЧЕНА 417) ветка `metaOnly` («файл уже собран воркфлоу,
  только метаданные») больше клиентом не вызывается.

## 4. Что пробрасывается из UI (`extend-view.tsx` → `generate()`)

`mode: 'extend'`, `prompt` (первый осмысленный клиповый промпт — подпись
карточки и .meta.json), `seed`, `extendClips` (prompt/duration≥5 с/seed,
с `<Video 1>`-префиксом и CAMERA_LOCK), `extendRefs` (картинки),
`extendSourceVideo` (путь в input/), `referenceDetail` (`match`/`max`),
`lowResMP`, `firstSamplerSteps`, `sigmaVariant`, `pass1Sampler`,
`pass1Scheduler`, `sparseAttention`, `vedaAttention`, `lowVramAttention`,
`chunkFeedForward` (+ chunks/threshold), `outputSubfolder`.

## 5. Метаданные (.meta.json сайдкары)

- Сайдкар пишется на КАЖДОМ видеовыходе джоба — включая каждый клип продления
  (правка 260, `saveMetadata` в `use-video-gen.ts`), с `output_index`,
  `job_id` и серверным `generation_time` (execution_ms ComfyUI).
- Итоговый combined-файл: `generation_mode: 'extend'`,
  `workflow: 'extend-latent-chain-combined'`, `source_video`,
  `extend_clips_count` (правка 176), `extend_prompts` — ВСЯ цепочка осмысленных
  промптов клипов (правка 303); concat-роут дописывает перед ними цепочку
  исходника → полный путь «исходник → клип 1 → … → клип N».

## 6. Ограничения и известные моменты

- Минимум **5 с на клип** (правки 309/325): короче — скачок на стыке
  «исходник → клип 0» (модели не хватает контекста движения).
- Исходник приводится к **24 fps** на входе (`force_rate`); выход тоже 24 fps.
- denoise=1 + маска: зона хвоста не пересчитывается, поэтому при длинных
  цепочках (3+ клипа) возможно накопление ошибок через `ext_ssep_{i-1}` —
  это известное свойство схемы (комментарий к правке 291), а не регрессия.
- Живое превью (`ModelPreviewOverrideKJ`, tiny VAE `taeh3.safetensors`,
  preview_fps=6) считает кадры по самому длинному клипу.
- Продление без исходника поддерживается (чистая генерация цепочки клипов),
  канва тогда — из `aspectRatio`/`finalResolution`.

## 7. История регрессий (чтобы не наступать снова)

Хронология поломок режима продления — все они уже были, не повторять:

1. **Правки 383/384 (10.10)** — комбинированный латент-вывод одним файлом:
   с пиксельной головой (409) модель реплеила исходник с кадра 0, с латентной
   (416) — заморозка конца, сегментный декод (411) — стыковые артефакты.
   **Откачено правкой 417** на поштучные клипы + ffmpeg-склейку.
2. **Правка 417 потеряла срез головы клипа 0** (восстановлен правкой 418):
   файл клипа нёс ВЕСЬ хвост → «оригинал, ещё раз оригинал, потом новое».
3. **Правка 322 «минимум 5 с контекста» + подача референса через
   `ref_videos`** — на 5-секундных исходниках модель получала весь клин в
   затравку И в референс → перегенерация исходника вместо продолжения.
   **Исправлено правкой 419** (окно 2 с, референс картинкой — как в эталоне
   «V2V Extend Any Video»). Подтверждено пользователем 11.10.2026:
   бесшовно и в разы быстрее.
4. **(правка 420 — возврат латента итога, безопасный)** combined-латент
   снова сохраняется — но ТОЛЬКО пост-сборкой после сэмплеров (чистые
   LatentCut/LatentConcat готовых выходов, модель не участвует) для
   lossless-рефайна/апскейла итога. Это не комбайн 383: латент никогда не
   подаётся в сэмплер. Таймлайн сходится с ffmpeg-склейкой кадр в кадр
   (проверено: mp4 260 = латент 107+153).
4. Отдельно: прод-сервер Next.js **не подхватывает пересборку на лету** —
   после `npm run build` приложение надо перезапускать (start.bat), иначе
   тестируется старый билд.
