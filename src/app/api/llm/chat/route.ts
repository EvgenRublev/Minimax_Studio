import { NextRequest } from 'next/server'
import { ensureLlm, LLM_PORT, actualLlmContextSize, activeLlmModelId, llmBackend, llmVisionAvailable, noteLlmActivity } from '@/lib/llm-runner'
import { samplingForModel } from '@/lib/llm-sampling'
import { startChat, noteLlmStreaming } from '@/lib/vram-arbiter'
import { getAppConfig } from '@/lib/app-config'
import { prepVideoForLlm, extractVideoFrames } from '@/lib/llm-media'
import { findPriorDigest, getReferenceDigest } from '@/lib/llm-ref-digest'
import { toOpenAiMessages, openAiSseToDelta } from '@/lib/llm-bonsai'
import { LLM_STOP_TOKENS, probeAudioAnswer } from '@/lib/llm-audio-guard'
import {
  trimToContext,
  degradeMediaToBudget,
  videoBudgetSec,
  messageTokens,
} from '@/lib/llm-context-trim'
import { existsSync, mkdirSync, unlinkSync, rmdirSync, readdirSync, statSync } from 'fs'
import path, { join } from 'path'
import sharp from 'sharp'
import { stagedPath } from '@/lib/staging' // (правка 697)

export const dynamic = 'force-dynamic'

/**
 * POST /api/llm/chat
 * Body: {
 *   messages: [{role, content}],
 *   references?: [{ path: "file.png", trigger: "Picture 1", intent: "identity" }],
 *   chatAttachments?: [{ path, name, kind: 'image'|'video', legacyComfy?: boolean }] — (правка 108)
 *   вложения чата из data/chat-attachments/ (или legacy input/): ТОЛЬКО для
 *   LLM-описания, НЕ ген-рефы — прикрепляются как «Chat N» с запретом тегов.
 *   maxTokens?, temperature?
 * }
 * Lazily starts the local LLM server, then proxies the SSE stream.
 * If references are provided, image files are read and injected as
 * vision content into the first user message.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const messages = body?.messages as Array<{ role: string; content: string | unknown[]; images?: string[] }> | undefined
    // (правка 717) request_id прокидывается до llm_server.py — по нему
    // /abort адресуется ровно в эту генерацию.
    const requestId = typeof body?.request_id === 'string' && body.request_id ? body.request_id : null
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: 'messages required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Cleanup temp vision files (idempotent; called on error paths and at stream end)
    // (правка 162) Папки с кадрами (Bonsai видео-видение) удаляем rmdirSync.
    const tempFiles: string[] = []
    const cleanup = () => { tempFiles.forEach((f) => { try { unlinkSync(f) } catch { try { rmdirSync(f, { recursive: true }) } catch {} } }) }

    // (правка 108) Sweep орфанов: temp-файлы _tmp_vision старше 1 часа — остаток
    // после краха процесса (свой cleanup уже не сработал). Свежие НЕ трогаем
    // (они могут принадлежать активному стриму, завершённому позже).
    const cfg = getAppConfig()
    // (правка 136) Активный бэкенд ассистента: 'standard' (llm_server.py)
    // или 'bonsai' (prism llama-server, OpenAI-протокол).
    const backend = llmBackend()
    try {
      // (правка 108) ВАЖНО: путь берётся из cfg.comfyRoot — реальный корень
      // ComfyUI конфигурируемый (по умолчанию ./ComfyUI-Easy-Install), а не cwd.
      const sweepDir = path.join(cfg.comfyRoot, 'ComfyUI', 'models', 'llm', '_tmp_vision')
      const now = Date.now()
      for (const f of readdirSync(sweepDir)) {
        try {
          const st = statSync(join(sweepDir, f))
          if (st.isFile() && now - st.mtimeMs > 3600_000) {
            unlinkSync(join(sweepDir, f))
          } else if (
            // (правка 172) Директории кадров llmvidframes_*/llmvidcaframes_*
            // (Bonsai видео-видение, src/lib/llm-media.ts) после крахов
            // копились бесконечно — свип раньше удалял только файлы.
            // Удаляем рекурсивно с тем же age-порогом (1 час).
            st.isDirectory() && /^(llmvidframes_|llmvidcaframes_|digest_)/.test(f) &&
            now - st.mtimeMs > 3600_000
          ) {
            rmdirSync(join(sweepDir, f), { recursive: true })
          }
        } catch { /* файл мог исчезнуть — игнорируем */ }
      }
    } catch { /* папки нет — ок */ }

    // Guard + выгрузка MiniMax (verified) под mutex. Вся подготовка запроса и
    // открытие upstream-соединения происходят ТОЛЬКО под тем же mutex, а
    // счётчик стриминга включается до его освобождения (контракт startChat):
    // с этого момента генерация получает 409 до конца ответа ассистента.
    const gate = await startChat(async () => {
      const started = await ensureLlm()
      if (!started.ok) {
        return { kind: 'start-error' as const, error: started.error ?? 'LLM сервер не отвечает' }
      }

      // Inject references as multimodal CONTENT PARTS (llama-cpp-python 0.3.46
      // mtmd format — the legacy `images` message field is NOT read by this
      // version and would be silently dropped):
      //   {"type":"image"} — sharp-resized JPEG
      //   {"type":"video"} — whole MP4 (≤512px, 8 fps) — the MTMD video helper
      //                      (lazy bitmap, patched into llama_multimodal.py)
      //                      decodes it frame-by-frame during tokenization;
      //                      + optional {"type":"audio"} part for the track
      //   {"type":"audio"} — 16 kHz mono WAV
      const references = body?.references as Array<{
        path: string
        trigger: string
        intent?: string
        kind?: 'image' | 'video' | 'audio'
        includeAudio?: boolean
      }> | undefined
      // (правка 717) Бюджет под медиа считаем по УЖЕ ОБРЕЗАННОЙ истории.
      // Раньше videoBudgetSec() получал полный (необрезанный) список
      // сообщений: в длинном чате «свободного места» не оставалось, и
      // видео-реф обрезался до 2-секундного пола (Math.max(2, …)) — модель
      // описывала 2 секунды ролика вместо, скажем, 20. Смысл обрезки — «в
      // контекст влезает только хвост», значит и бюджет медиа считать надо
      // по хвосту.
      const budgetBase = trimToContext(
        messages as unknown as Parameters<typeof trimToContext>[0],
        actualLlmContextSize(),
        cfg.llmMaxOutputTokens,
      )
      // ПРАВКА 36: аудио в LLM не отправляется (модель не может его слышать),
      // поэтому hasAudioParts всегда false и аудио-проба (llm-audio-guard) —
      // no-op safety net. Оставлено на случай, если поддержку аудио в LLM
      // вернут: тогда прогон на надёжность снова заработает автоматически.
      let hasAudioParts = false
      // (правка 716/717) Потолок на число референсов — по видам, ровно как
      // на клиенте (getReferences в assistant-stream.ts: REF_LIMITS =
      // image 9 / video 3 / audio 3, всего 15) и как у самой модели H3.
      //
      // Раньше был единый потолок 9 ПО ПОРЯДКУ: системный промпт нумеровал
      // ВСЕ референсы (номер по виду), а на провод уходили только первые 9
      // позиций. Модель писала в промпт <Picture 12> и описывала картинки,
      // которых НЕ видела. Теперь обе стороны режут одинаково, по видам, —
      // промпт и фактическое крепление всегда совпадают.
      const REF_LIMITS = { image: 9, video: 3, audio: 3, total: 15 } as const
      const cappedReferences = (() => {
        if (!Array.isArray(references)) return undefined
        const counters = { image: 0, video: 0, audio: 0 }
        const out: NonNullable<typeof references> = []
        for (const r of references as NonNullable<typeof references>) {
          if (out.length >= REF_LIMITS.total) break
          const kind = r.kind ?? 'image'
          if (kind === 'image') {
            if (counters.image >= REF_LIMITS.image) continue
            counters.image++
          } else if (kind === 'video') {
            if (counters.video >= REF_LIMITS.video) continue
            counters.video++
          } else if (kind === 'audio') {
            if (counters.audio >= REF_LIMITS.audio) continue
            counters.audio++
          }
          out.push(r)
        }
        return out
      })()
      if (references && cappedReferences && references.length > cappedReferences.length) {
        console.warn(
          `[llm] референсов ${references.length} — используем ${cappedReferences.length} (лимиты по видам)`,
        )
      }
      if (cappedReferences?.length) {
        const inputDir = path.join(cfg.comfyRoot, 'ComfyUI', 'input')
        const outputDir = cfg.outputDir
        const tmpDir = path.join(cfg.comfyRoot, 'ComfyUI', 'models', 'llm', '_tmp_vision')
        mkdirSync(tmpDir, { recursive: true })
        const mediaParts: Array<Record<string, unknown>> = []
        const textParts: string[] = []
        // Digests are CONTEXT, not the user's request. They are appended to the
        // system message so a short answer like "1" is not buried under a big
        // reference-description block in the last user message.
        const digestTextParts: string[] = []
        // (правка 53) true, если к запросу прикреплены кадры хотя бы одного видео-рефа
        let videoAttached = false
        // Reference digests: video first (as agreed with the user), then images.
        // Each one is generated in an isolated LLM request and cached by file
        // identity; the main chat receives only the compact text. If a digest
        // fails, the old raw-media path below is kept as a fallback.
        const digestByTrigger = new Map<string, string>()
        // (правка 771) прошлые дайджесты из индекса путей: файл удалён или
        // дайджест не сгенерировать — тег ВСЁ РАВНО приходит с описанием
        const priorDigestByTrigger = new Map<string, string>()
        let digestUsed = false
        const useRefDigest = body?.useRefDigest !== false
        // Model fingerprint for cache invalidation: switching Qwen/Bonsai,
        // a different quantization, or another custom GGUF must not reuse
        // descriptions produced by the previous model.
        const digestModelKey = [
          activeLlmModelId(),
          cfg.llmModel,
          backend === 'custom' ? cfg.llmCustomModel : '',
        ].filter(Boolean).join('|')
        const resolveRefPath = async (refPath: string, preferOutput = false): Promise<string | null> => {
          const tryInput = (): string | null => {
            const absPath = path.resolve(inputDir, refPath)
            const inside = absPath.startsWith(path.resolve(inputDir) + path.sep)
            return inside && existsSync(absPath) ? absPath : null
          }
          const tryOutput = (): string | null => {
            const absPath = path.resolve(outputDir, refPath)
            const inside = absPath.startsWith(path.resolve(outputDir) + path.sep)
            return inside && existsSync(absPath) ? absPath : null
          }
          // ControlNet direct берёт источник из галереи (output), а не из input:
          // при совпадении имён input-копия может быть от другой задачи.
          // Обычные референсы output не ищут: там может лежать чужой файл с
          // тем же именем, а staged-копия — их законный fallback.
          if (preferOutput) {
            const output = tryOutput()
            if (output) return output
          }
          const input = tryInput()
          if (input) return input
          // (правка 697) Fallback на staging: когда ComfyUI не запущен,
          // uploadInputFile() кладёт реф в .local-input/ и возвращает staged-имя.
          return await stagedPath(refPath)
        }
        if (useRefDigest) {
          const digestStartedAt = Date.now()
          // Keep the first turn from blocking the 10-minute client header
          // watchdog indefinitely. If we run out of budget, remaining refs use
          // the raw-media fallback and the chat still starts.
          const digestBudgetMs = 7 * 60_000
          const digestOrder = [...cappedReferences].sort((a, b) => {
            const rank = (k: string | undefined) => (k === 'video' ? 0 : k === 'image' ? 1 : 2)
            return rank(a.kind) - rank(b.kind)
          })
          for (const ref of digestOrder) {
            if (Date.now() - digestStartedAt > digestBudgetMs) {
              console.warn('[llm] ref digest budget exhausted — remaining references use raw media')
              break
            }
            const kind = ref.kind ?? 'image'
            if (kind === 'audio') continue
            if (kind === 'video' && !cfg.llmVideoVision) continue
            const resolved = await resolveRefPath(ref.path, ref.intent === 'control_source')
            if (!resolved) {
              // (правка 771) файл исчез с диска («чистка input», перезапись) —
              // берём последнее созданное описание этого имени
              const prior = await findPriorDigest(ref.path, digestModelKey)
              if (prior) {
                priorDigestByTrigger.set(ref.trigger, prior)
                digestUsed = true
              }
              continue
            }
            const result = await getReferenceDigest({
              ref,
              resolvedPath: resolved,
              backend,
              modelId: digestModelKey,
              videoVision: cfg.llmVideoVision,
              signal: req.signal,
            })
            if (result.ok && result.digest) {
              digestByTrigger.set(ref.trigger, result.digest)
              digestUsed = true
            } else {
              // (правка 771) генерация не удалась (нет зрения / таймаут / LLM
              // недоступен / вышел бюджет) — фолбэк на прошлое описание
              const prior = await findPriorDigest(ref.path, digestModelKey)
              if (prior) {
                priorDigestByTrigger.set(ref.trigger, prior)
                digestUsed = true
              } else {
                console.warn(`[llm] ref digest unavailable for ${ref.trigger}: ${result.error ?? 'unknown error'} — falling back to raw media`)
              }
            }
          }
        }
        const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        // (правка 169) сколько целых видео уйдёт в контекст (standard backend
        // с включённым видением): длительность каждого ограничиваем свободным
        // местом ЗАРАНЕЕ — кадр 512px стоит ~768 vision-токенов, и 60-секундный
        // реф на 8 fps один занял бы всё окно контекста.
        const genVideoCount = cfg.llmVideoVision && backend !== 'bonsai'
          ? cappedReferences.filter((r) => r.kind === 'video').length
          : 0
        const refVideoSec = videoBudgetSec(budgetBase, genVideoCount, actualLlmContextSize(), cfg.llmMaxOutputTokens)

        for (const ref of cappedReferences) {
          // (правка 170) SECURITY: ref.path приходит от клиента без проверок —
          // path traversal (../../ или абсолютный путь) давал чтение
          // произвольных файлов. resolveRefPath держит путь внутри input/output
          // (подход safeAttachPath) и делает fallback на staging.
          const resolvedPath = await resolveRefPath(ref.path, ref.intent === 'control_source')
          if (!resolvedPath) {
            // (правка 771) файла нет, но описание уже создавалось — тег
            // остаётся с описанием, модель НЕ получает пустую ссылку
            const prior = priorDigestByTrigger.get(ref.trigger)
            if (prior) {
              digestTextParts.push(
                `[${ref.trigger}] file="${ref.path}" (description from a PREVIOUS analysis of this reference — the file is currently NOT on disk; treat the text below as what you saw earlier; if the actual file matters for the generation, ask the user to re-attach it):\n${prior}`,
              )
              continue
            }
            // ПРАВКА 36: файл рефа отсутствует на диске — явно сообщаем модели,
            // чтобы она НЕ выдумывала его содержимое. Раньше тихий `continue`
            // давал расхождение: системный промпт реф перечислял, а медиа не
            // было прикреплено → модель конфабулировала (баг #3).
            textParts.push(`[${ref.trigger}] file="${ref.path}" (COULD NOT ATTACH — file not found on disk; do NOT describe, reference, or invent its content; if it matters, ask the user to re-attach it)`)
            continue
          }
          const safeName = path.basename(resolvedPath).replace(/[^a-zA-Z0-9.]/g, '_')

          if (ref.kind === 'video') {
            // A successful digest already contains the visual facts; do not
            // attach raw frames/video again (that is the whole point of the
            // cache). The old path below remains as a fallback.
            const digest = digestByTrigger.get(ref.trigger)
            if (digest) {
              digestTextParts.push(
                `[${ref.trigger}] file="${ref.path}" (reference digest generated from the actual video frames — treat it as what you observed${ref.includeAudio !== false ? '; it has an audio track for MiniMax — reference it as <Video N> and do NOT invent what is "heard" in it' : ''}):\n${digest}`,
              )
              continue
            }
            // (правка 771) свежий дайджест недоступен — прошлое описание этого же имени
            const priorVideo = priorDigestByTrigger.get(ref.trigger)
            if (priorVideo) {
              digestTextParts.push(
                `[${ref.trigger}] file="${ref.path}" (description from a PREVIOUS analysis of this video — it could not be re-analyzed right now; treat the text below as what you saw earlier; it may be outdated if the file changed${ref.includeAudio !== false ? '; it has an audio track for MiniMax — reference it as <Video N> and do NOT invent what is "heard" in it' : ''}):\n${priorVideo}`,
              )
              continue
            }
            // (правка 53) По умолчанию ассистент НЕ смотрит кадры видео —
            // экономия контекста: модель знает только о НАЛИЧИИ видео-рефа и
            // НЕ описывает/не выдумывает его содержимое. Полное видение включается
            // галочкой «Видение видео ассистентом» в настройках (llm.video_vision).
            if (!cfg.llmVideoVision) {
              textParts.push(
                `[${ref.trigger}] file="${ref.path}" (video reference — its frames are NOT attached: assistant video-vision is OFF. You only know the video EXISTS. Reference it as <Video N> when the user asks to use it; do NOT describe, guess or invent what happens inside it. If the user wants you to "see" the video, tell them to enable «Видение видео ассистентом» in Settings → LLM)`,
              )
              continue
            }
            // (правка 162) Bonsai: целые видео не принимает — извлекаем кадры
            // ffmpeg'ом в JPEG и отправляем как image_url (OpenAI-формат).
            if (backend === 'bonsai') {
              const stamp = uid()
              const framesDir = path.join(tmpDir, `llmvidframes_${stamp}`)
              const frames = await extractVideoFrames(resolvedPath, framesDir) // (правка 697)
              if (frames) {
                mediaParts.push({ type: 'video', video_frames: frames })
                videoAttached = true
                tempFiles.push(...frames, framesDir)
                textParts.push(
                  `[${ref.trigger}] file="${ref.path}" (video frames attached — describe the scene, motion and camera behaviour over time, ONLY what is actually in the frames${ref.includeAudio !== false ? '; it has an audio track for MiniMax — reference as <Video N> and do NOT invent what is "heard" in it' : ''})`,
                )
              } else {
                textParts.push(`[${ref.trigger}] file="${ref.path}" (video reference — could NOT extract frames to attach, ask user if visual details matter; do NOT describe it as if you saw it)`)
              }
              continue
            }
            // Whole video as ONE {"type":"video"} part: the MTMD video helper
            // (patched into llama_multimodal.py via lazy bitmap) decodes it
            // frame-by-frame during tokenization. We only downscale (≤512px)
            // and cap the rate at 8 fps so the frame count — and hence the
            // vision tokens — stay small.
            //
            // ПРАВКА 36: звуковую дорожку видео НЕ отправляем в LLM — модель
            // НЕ может прослушать аудио (в тестах отвечает «unable to hear»),
            // а старый промпт говорил «ты её слышишь» → выдумывала реплики.
            // Аудио уходит в MiniMax напрямую (ref_video_audio); LLM лишь
            // расставляет <Video N> в тексте промпта.
            const stamp = uid()
            const baseName = ref.path.replace(/[^a-zA-Z0-9]/g, '_')
            const videoOut = path.join(tmpDir, `llmvid_${stamp}_${baseName}.mp4`)
            const audioOut = path.join(tmpDir, `llmvidaud_${stamp}_${baseName}.wav`)
            // (правка 169) длительность — по свободному месту в контексте
            const prepared = await prepVideoForLlm(resolvedPath, videoOut, audioOut, 512, 8, refVideoSec) // (правка 697)
            if (prepared) {
              mediaParts.push({ type: 'video', video: prepared.videoPath, est_frames: refVideoSec * 8 })
              videoAttached = true
              tempFiles.push(prepared.videoPath)
              if (prepared.audioPath) tempFiles.push(prepared.audioPath) // создаётся для MiniMax, но в LLM не идёт
              textParts.push(
                `[${ref.trigger}] file="${ref.path}" (whole video attached — describe the scene, motion and camera behaviour over time, ONLY what is actually in the frames${ref.includeAudio !== false ? '; it has an audio track for MiniMax — reference as <Video N> and do NOT invent what is "heard" in it' : ''})`,
              )
            } else {
              textParts.push(`[${ref.trigger}] file="${ref.path}" (video reference — could NOT transcode it to attach, ask user if visual details matter; do NOT describe it as if you saw it)`)
            }
            continue
          }

          if (ref.kind === 'audio') {
            // ПРАВКА 36: аудио НЕ отправляем в LLM. Модель НЕ может его
            // прослушать (в тестах: «I'm unable to hear or process the audio»),
            // а старый промпт утверждал «ты их СЛЫШИШЬ» → модель либо отказывала,
            // либо ВЫДУМЫВАЛА содержимое (баги #2 и #3). Аудио уходит в MiniMax
            // как ref_audios напрямую (см. use-video-gen.ts), LLM лишь расставляет
            // <Audio N> в тексте промпта. WAV для LLM не генерируем вообще.
            textParts.push(
              `[${ref.trigger}] file="${ref.path}" (audio reference for MiniMax voice/tone, intent: ${ref.intent || 'voice'} — the model CANNOT hear it; reference it as <Audio N> and do NOT describe or quote its content)`,
            )
            continue
          }

          const imageDigest = digestByTrigger.get(ref.trigger)
          if (imageDigest) {
            digestTextParts.push(
              `[${ref.trigger}] file="${ref.path}" (intent: ${ref.intent || 'identity'}; reference digest generated from the actual image — treat it as what you observed):\n${imageDigest}`,
            )
            continue
          }
          // (правка 771) свежий дайджест недоступен — прошлое описание этого же имени
          const priorImage = priorDigestByTrigger.get(ref.trigger)
          if (priorImage) {
            digestTextParts.push(
              `[${ref.trigger}] file="${ref.path}" (intent: ${ref.intent || 'identity'}; description from a PREVIOUS analysis of this image — it could not be re-analyzed right now; treat the text below as what you saw earlier; it may be outdated if the file changed):\n${priorImage}`,
            )
            continue
          }

          // Image: resize to max 512px longest side — keeps vision tokens low
          const outPath = path.join(tmpDir, `vision_${uid()}_${safeName}`)
          try {
            await sharp(resolvedPath) // (правка 697) staged-fallback
              .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 80 })
              .toFile(outPath)
            mediaParts.push({ type: 'image', image: outPath })
            tempFiles.push(outPath)
          } catch {
            // Fallback: use original (might be slow)
            mediaParts.push({ type: 'image', image: resolvedPath }) // (правка 697)
          }
          // (правка 771) без mmproj прикреплённая картинка для модели пустое
          // место — она её НЕ видит; запрещаем выдумывать содержимое.
          if (!llmVisionAvailable()) {
            textParts.push(`[${ref.trigger}] file="${ref.path}" (intent: ${ref.intent || 'identity'}; vision is NOT available for this model — the mmproj file is missing, so you CANNOT see this image: do NOT describe or invent its content; if visuals matter, tell the user to download the vision file (mmproj) in Settings → LLM)`)
          } else {
            textParts.push(`[${ref.trigger}] file="${ref.path}" (intent: ${ref.intent || 'identity'})`)
          }
        }

        // Digests go into the SYSTEM context, never into the last user
        // message. A short reply like "1" must remain the actual request; a
        // big reference block in the same message made the model answer the
        // block (repeating reference summaries/ideas) instead of "1".
        if (digestTextParts.length > 0) {
          const digestBlock = [
            '=== REFERENCE DIGESTS (internal visual memory) ===',
            'These are descriptions of the current generation references, not a user request. Use them as visual context for the actual request in the last user message; do not repeat or summarize this block unless the user asks. Do not mention the word "digest" to the user.',
            ...digestTextParts,
          ].join('\n')
          const sys = messages[0]
          if (sys && sys.role === 'system') {
            if (typeof sys.content === 'string') {
              messages[0] = { ...sys, content: `${sys.content}\n\n${digestBlock}` }
            } else if (Array.isArray(sys.content)) {
              messages[0] = { ...sys, content: [...sys.content, { type: 'text', text: digestBlock }] }
            } else {
              messages[0] = { ...sys, content: digestBlock }
            }
          } else {
            messages.unshift({ role: 'system', content: digestBlock })
          }
        }

        // (правка 53) прикрепляем не только при наличии медиа: textParts могут
        // содержать «tag-only» заметки (видео с выключенным видением, аудио).
        // Раньше такие заметки молча терялись, и модель не знала о рефах.
        if (mediaParts.length > 0 || textParts.length > 0) {
          // Привязываем к ПОСЛЕДНЕМУ user-сообщению (текущий ход), а не к
          // первому (правки 35): модель отвечает именно на последний ход —
          // референсы должны стоять рядом с ним; а trimToContext режет
          // историю с начала, и старое первое сообщение (с медиа) улетало
          // первым — видение тихо терялось в длинных чатах.
          const introText = digestUsed
            ? [
                'Reference digests are in the system context (internal visual memory; not a user request).',
                mediaParts.length > 0
                  ? 'References that could not be digested are attached as raw media; you can see those directly.'
                  : '',
                'You CANNOT hear the audios — reference them as <Audio N> and do NOT describe or quote their content.',
              ].filter(Boolean).join(' ')
            : videoAttached
              ? 'Attached references (you can SEE the images and WATCH the video frames; you CANNOT hear the audios — this model has no reliable audio input). Images: describe faces, hair, clothing, colors, distinguishing details — ONLY what is actually visible, do not invent details. Videos: attached as whole short clips (≤512px, 8 fps) — describe the scene, motion and camera behaviour over time, ONLY what is actually in the frames. Audios: attached for MiniMax voice/tone ONLY — the model CANNOT hear them, so reference them as <Audio N> and do NOT describe or quote their content.'
              : 'Attached references (you can SEE the attached images — describe faces, hair, clothing, colors, distinguishing details — ONLY what is actually visible, do not invent details; video references are TAGS ONLY — their frames are NOT attached to save context, so you only know they EXIST: use their <Video N> tags when the user asks, and do NOT describe, guess or invent what happens inside them). You CANNOT hear the audios — reference them as <Audio N> and do NOT describe or quote their content.'
          let lastUserIdx = -1
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') { lastUserIdx = i; break }
          }
          if (lastUserIdx >= 0) {
            const existingText = typeof messages[lastUserIdx].content === 'string'
              ? messages[lastUserIdx].content
              : ''
            messages[lastUserIdx] = {
              role: 'user',
              // Text part first, media parts in reference order — the chat
              // template renders media markers exactly in part order.
              content: [
                {
                  type: 'text',
                  text: `${introText} ${textParts.join('; ')}.\n\n${existingText}`,
                },
                ...mediaParts,
              ],
            }
          }
        }
      }

      // (правка 108) Вложения чата — ИЗОЛИРОВАНЫ от референсов генерации.
      // Файлы лежат в data/chat-attachments/ (новое хранилище) или legacy
      // ComfyUI/input/ (правки 86–87, legacyComfy). Они нужны ТОЛЬКО для
      // LLM-описания/анализа:
      //   • прикрепляются к LLM как «Chat N» (НЕ «Picture N»/«Video N»);
      //   • модели явно запрещено использовать их как <Picture N>/<Video N> в
      //     промпте — они НЕ являются ген-референсами (MiniMax не должен их
      //     подтягивать из input/ в генерацию);
      //   • видео-вложения ВСЕГДА прикрепляются как кадры (пользователь явно
      //     приложил их в чат ради описания) — НЕ зависят от llmVideoVision
      //     (тот флаг управляет только видео-реферами генерации).
      const chatAttachments = body?.chatAttachments as Array<{
        path: string
        name?: string
        kind: 'image' | 'video'
        legacyComfy?: boolean
      }> | undefined
      if (chatAttachments?.length) {
        const attachDir = path.resolve(process.cwd(), 'data', 'chat-attachments')
        const caInputDir = path.join(cfg.comfyRoot, 'ComfyUI', 'input')
        const caTmpDir = path.join(cfg.comfyRoot, 'ComfyUI', 'models', 'llm', '_tmp_vision')
        mkdirSync(caTmpDir, { recursive: true })
        const caMediaParts: Array<Record<string, unknown>> = []
        const caTextParts: string[] = []
        const caUid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        let caNum = 0
        // (правка 169) длительность видео-вложений — тоже по свободному месту
        // в контексте (кадр 512px ≈ 768 токенов; см. videoBudgetSec).
        const caVideoSec = videoBudgetSec(
          budgetBase,
          chatAttachments.filter((a) => a.kind === 'video').length,
          actualLlmContextSize(),
          cfg.llmMaxOutputTokens,
        )
        for (const att of chatAttachments) {
          caNum++
          // (правка 117) att.path — имя файла в хранилище вложений АС-ЕСТЬ.
          // Эндпоинт загрузки уже генерирует безопасное имя из basename
          // оригинала (например mtyx1rqu-j776gm-photo.jpg — С ДЕФИСАМИ).
          // Раньше мы повторно «обезвреживали» имя
          // (replace(/[^a-zA-Z0-9.]/g, '_')), и дефисы превращались в
          // подчёркивания → файл «не находился» у КАЖДОГО нового вложения
          // (модель получала COULD NOT ATTACH). Теперь берём basename как есть
          // (traversal-безопасно: разделителей в имени нет по построению).
          const attName = String(att.path).split(/[\\/]/).pop() || ''
          const safeName = (attName || 'attachment').replace(/[^a-zA-Z0-9.]/g, '_')
          // (правка 170) SECURITY: флаг legacyComfy контролируется клиентом, а
          // startsWith-проверка раньше применялась только к не-legacy ветке —
          // path traversal через att.path. Резолвим и требуем остаться внутри
          // caInputDir; нарушение отклоняется как «файл не найден» ниже.
          const legacyResolved = att.legacyComfy ? path.resolve(caInputDir, att.path) : null
          const legacySafe = legacyResolved !== null &&
            legacyResolved.startsWith(path.resolve(caInputDir) + path.sep)
          const absPath = att.legacyComfy
            ? (legacySafe ? legacyResolved : null)
            : attName && attName !== '.' && attName !== '..'
              ? path.resolve(attachDir, attName)
              : null
          const missing =
            !absPath ||
            (att.legacyComfy ? !existsSync(absPath) : !absPath.startsWith(attachDir) || !existsSync(absPath))
          if (missing) {
            console.warn('[llm] chatAttachment MISSING:', att.path, '→ resolved:', absPath ?? 'null', 'attachDir:', attachDir)
            caTextParts.push(
              `[Chat ${caNum}] file="${att.path}" (COULD NOT ATTACH — file not found in the chat-attachments store; do NOT describe or invent its content; ask the user to re-attach it)`,
            )
            continue
          }
          if (att.kind === 'video') {
            // (правка 162) Bonsai: извлекаем кадры → отправляем как картинки.
            if (backend === 'bonsai') {
              const stamp = caUid()
              const framesDir = path.join(caTmpDir, `llmvidcaframes_${stamp}`)
              const frames = await extractVideoFrames(absPath, framesDir)
              if (frames) {
                caMediaParts.push({ type: 'video', video_frames: frames })
                tempFiles.push(...frames, framesDir)
                caTextParts.push(
                  `[Chat ${caNum}] file="${att.path}" (chat video frames attached — describe the scene, motion and camera behaviour over time, ONLY what is actually in the frames, do NOT invent details; it is NOT a generation reference: NEVER reference it as <Video N> in the prompt)`,
                )
              } else {
                caTextParts.push(
                  `[Chat ${caNum}] file="${att.path}" (chat video — could NOT extract frames to attach; ask the user if visual details matter; do NOT describe it as if you saw it; it is NOT a generation reference)`,
                )
              }
              continue
            }
            // (правка 108) видео-вложение чата ВСЕГДА как кадры (не зависит
            // от llmVideoVision — он только для ген-рефов).
            // (правка 169) длительность — по свободному месту в контексте.
            const stamp = caUid()
            const videoOut = path.join(caTmpDir, `llmvidca_${stamp}_${safeName}.mp4`)
            const audioOut = path.join(caTmpDir, `llmvidaudca_${stamp}_${safeName}.wav`)
            const prepared = await prepVideoForLlm(absPath, videoOut, audioOut, 512, 8, caVideoSec)
            if (prepared) {
              caMediaParts.push({ type: 'video', video: prepared.videoPath, est_frames: caVideoSec * 8 })
              tempFiles.push(prepared.videoPath)
              if (prepared.audioPath) tempFiles.push(prepared.audioPath)
              caTextParts.push(
                `[Chat ${caNum}] file="${att.path}" (chat video attached as frames — describe the scene, motion and camera behaviour over time, ONLY what is actually in the frames, do NOT invent details; it is NOT a generation reference: NEVER reference it as <Video N> in the prompt)`,
              )
            } else {
              caTextParts.push(
                `[Chat ${caNum}] file="${att.path}" (chat video — could NOT transcode it to attach; ask the user if visual details matter; do NOT describe it as if you saw it; it is NOT a generation reference)`,
              )
            }
            continue
          }
          // Image: resize to max 512px longest side — keeps vision tokens low
          const outPath = path.join(caTmpDir, `visionca_${caUid()}_${safeName}`)
          try {
            await sharp(absPath)
              .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 80 })
              .toFile(outPath)
            caMediaParts.push({ type: 'image', image: outPath })
            tempFiles.push(outPath)
          } catch {
            // Fallback: use original (might be slow)
            caMediaParts.push({ type: 'image', image: absPath })
          }
          caTextParts.push(
            `[Chat ${caNum}] file="${att.path}" (chat attachment — attached ONLY for your description/analysis; it is NOT a generation reference: NEVER reference it as <Picture N>, <Video N> or <Audio N> in the prompt)`,
          )
        }
        // (правка 689) Отладка: подтверждаем, что вложения чата прикреплены
        console.log('[llm] chatAttachments:', caTextParts.length, 'text parts,', caMediaParts.length, 'media parts')
        if (caTextParts.length > 0) {
          // (правка 108) Прикрепляем к ТОМУ ЖЕ последнему user-сообщению (текущий
          // ход) — модель отвечает именно на него; trimToContext не режет
          // медиа-сообщения, а история режется с начала (правки 35, 53, 108).
          const caIntro =
            'CHAT ATTACHMENTS (isolated from generation references — they exist ONLY in this chat and are used ONLY for your description/analysis; they are NOT <Picture N>/<Video N>/<Audio N> — do NOT reference them as such in any prompt):'
          let caLastIdx = -1
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') { caLastIdx = i; break }
          }
          if (caLastIdx >= 0) {
            const existing = messages[caLastIdx].content
            const existingMedia = (Array.isArray(existing)
              ? (existing as Array<Record<string, unknown>>)
              : []
            ).filter((p) => p && p.type !== 'text')
            // (правка 717) Порядок маркеров и порядок медиа теперь СОВПАДАЮТ:
            // текст в порядке [рефы…, Chat N…], затем медиа в том же порядке
            // (сначала медиа ген-рефов, потом медиа вложений чата).
            // Раньше текст начинался с caIntro (маркеры чата — ПЕРВЫМИ), а
            // медиа шли сначала рефов: шаблон чата рендерит маркеры строго по
            // порядку частей, и модель сопоставляла маркер с ЧУЖОЙ картинкой.
            const refTextParts = typeof existing === 'string'
              ? existing
              : (Array.isArray(existing)
                  ? (existing as Array<Record<string, unknown>>)
                      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
                      .map((p) => String(p.text))
                      .join(' ')
                  : '')
            messages[caLastIdx] = {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: [
                    refTextParts,
                    `${caIntro} ${caTextParts.join('; ')}.`,
                  ]
                    .filter(Boolean)
                    .join('\n\n'),
                },
                ...existingMedia,
                ...caMediaParts,
              ],
            }
          }
        }
      }

      // Автозаполнение остатка контекста, но не больше ручной настройки
      // [llm] max_output_tokens (UI «Max output tokens»).
      // ВАЖНО: считаем вход по УЖЕ обрезанной истории — иначе в длинном чате
      // необрезанный объём прижимал maxTokens к полу, и ответы обрубались
      // даже там, где трим освобождал кучу контекста.
      // (правка 169, 338) пол адаптивный: обычно 256 (минимально полезный
      // ответ), но при почти полном окне — 64: короткий ответ лучше
      // гарантированного переполнения. Медиа к этому моменту уже ограничено
      // (videoBudgetSec), а кадры Bonsai при нужде прореживает
      // degradeMediaToBudget.
      // (правка 338) ОДИН проход trimToContext (было два: для подсчёта room
      // и для итога). Трим резервирует под ответ ручной лимит
      // cfg.llmMaxOutputTokens; итоговый maxTokens никогда его не превышает
      // (раньше Math.max(256, …) пробивал ручной лимит снизу). Минимум 64:
      // при критически малом room контекст честно дотримится до бюджета 64.
      const ctxSize = actualLlmContextSize()
      const preTrimmed = trimToContext(messages, ctxSize, cfg.llmMaxOutputTokens)
      const inputTokens = preTrimmed.reduce((sum, m) => sum + messageTokens(m), 0)
      const room = ctxSize - inputTokens - 128
      const maxTokens = Math.max(64, Math.min(cfg.llmMaxOutputTokens, room))
      // (правка 169) трим → деградация медиа: гарантия, что [system + хвост]
      // реально влезает в окно даже при «тяжёлом» последнем сообщении.
      const trimmed = degradeMediaToBudget(preTrimmed, ctxSize, maxTokens)

      // (правка 135) Тонкая настройка сэмплинга: набор подбирается под
      // семейство АКТИВНОЙ модели (Gemma 4 12B vs Qwen3.5 9B) — см.
      // src/lib/llm-sampling.ts. До этой правки в llm_server уходил только
      // temperature, а top_p/top_k/min_p/penalty шли дефолтами llama-cpp
      // (top_k=40, top_p=0.95, min_p=0.05), что хуже под наши модели →
      // периодическое зацикливание и дегенерация thought-канала.
      // Приоритет — стабильность (меньше глючей), а не креативность.
      const baseSampling = body.sampling ?? samplingForModel(activeLlmModelId())

      // (правка 716) Сэмплинг от клиента ВАЛИДИРУЕТСЯ и клампится. Раньше
      // body.sampling/body.temperature уходили вверх как есть, обходя все
      // ограничения, которые app-config.ts применяет к тем же полям при
      // чтении из config.ini (top_p <= 1, top_k 1..200, penalties 0..2.5).
      // Строка вместо числа тоже проходила дальше.
      const clampNum = (v: unknown, def: number, lo: number, hi: number): number => {
        const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
        if (!Number.isFinite(n)) return def
        return Math.max(lo, Math.min(hi, n))
      }
      const rawSampling = (body.sampling ?? {}) as Partial<typeof baseSampling>
      const sampling = {
        temperature: clampNum(rawSampling.temperature, baseSampling.temperature, 0, 2),
        top_p: clampNum(rawSampling.top_p, baseSampling.top_p, 0, 1),
        top_k: Math.round(clampNum(rawSampling.top_k, baseSampling.top_k, 0, 200)),
        min_p: clampNum(rawSampling.min_p, baseSampling.min_p, 0, 1),
        presence_penalty: clampNum(rawSampling.presence_penalty, baseSampling.presence_penalty, 0, 2.5),
        frequency_penalty: clampNum(rawSampling.frequency_penalty, baseSampling.frequency_penalty, 0, 2.5),
        repeat_penalty: clampNum(rawSampling.repeat_penalty, baseSampling.repeat_penalty, 0, 2.5),
      }

      // Аудио-надёжность (без Whisper): модель нестабильна на «сыром» аудио —
      // часть прогонов дегенерирует в зацикливание (<|channel>thought × N и
      // повтор одной фразы × N). Если в запросе есть аудио — делаем короткий
      // не-стриминговый прогон (~48 токенов) с возрастающей температурой и
      // берём первый НЕ-дегенеративный: его температура пойдёт в основной
      // ответ. Stop-токены (LLM_STOP_TOKENS) в любом случае обрезают
      // thought-канал на лету. Проба не падает ассистента: любой сбой —
      // продолжаем с исходной температурой.
      let finalTemperature = clampNum(body.temperature, sampling.temperature, 0, 2)
      if (hasAudioParts) {
        try {
          const probe = await probeAudioAnswer({
            baseUrl: `http://127.0.0.1:${LLM_PORT}`,
            messages: trimmed,
            baseTemperature: finalTemperature,
            sampling, // (правка 135) — проба идёт с тем же top_p/top_k/penalty, что и основной ответ
            log: (m) => console.log('[llm] audio-probe:', m),
          })
          finalTemperature = probe.temperature
          console.log('[llm] audio-probe:', probe.note)
        } catch (e) {
          console.warn('[llm] audio-probe failed, continuing:', e)
        }
      }

      // Таймаут только на установку соединения (см. комментарий у fetch).
      const headerTimeout = {
        controller: new AbortController(),
        timer: setTimeout(() => headerTimeout.controller.abort(), 120_000),
      }
      // (правка 136) Bonsai-бэкенд: OpenAI /v1/chat/completions + конвертация
      // медиа-частей в data-URI, ответ заворачивается в наш SSE-формат.
      noteLlmActivity()
      let upstream: Response
      let upstreamBody: ReadableStream<Uint8Array> | null = null
      // (правка 717) Таймер снимается в finally: раньше clearTimeout стоял
      // ПОСЛЕ fetch, и при исключении (сервер LLM не поднят → ECONNREFUSED)
      // таймер оставался взведённым на 120 с на каждый упавший запрос.
      try {
        if (backend === 'bonsai') {
          const oaiMessages = await toOpenAiMessages(trimmed)
          upstream = await fetch(`http://127.0.0.1:${LLM_PORT}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messages: oaiMessages,
              max_tokens: maxTokens,
              stream: true,
              // (фикс) Выключаем «думание» на уровне ШАБЛОНА — флаг запуска
              // --reasoning-budget 0 у форка не работает, и с включённым
              // thinking ответы деградировали (уезжали не на ту тему, а при
              // малых max_tokens не успевали родиться вовсе — finish:length
              // внутри reasoning). enable_thinking=false — параметр шаблона
              // Qwen-семейства: <think> закрывается сразу, отвечает мгновенно.
              chat_template_kwargs: { enable_thinking: false },
              temperature: finalTemperature,
              top_p: sampling.top_p,
              top_k: sampling.top_k,
              min_p: sampling.min_p,
              presence_penalty: sampling.presence_penalty,
              frequency_penalty: sampling.frequency_penalty,
              repeat_penalty: sampling.repeat_penalty,
              // stop-токены НЕ шлём: <|channel|> — специфичный маркер Qwen3.5,
              // для Bonsai-шаблона не нужен (EOS обрабатывает llama-server).
            }),
            signal: headerTimeout.controller.signal,
          })
          if (upstream.ok && upstream.body) {
            upstreamBody = openAiSseToDelta(upstream.body)
          }
        } else {
          upstream = await fetch(`http://127.0.0.1:${LLM_PORT}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              // (правка 717) request_id — адрес прерывания: /abort с этим id
              // останавливает именно эту генерацию.
              ...(requestId ? { request_id: requestId } : {}),
              messages: trimmed,
              max_tokens: maxTokens,
              // (правка 135) — передаём весь набор сэмплинга; llm_server.py читает
              // каждый ключ и передаёт в llama-cpp-python create_chat_completion.
              temperature: finalTemperature,
              top_p: sampling.top_p,
              top_k: sampling.top_k,
              min_p: sampling.min_p,
              presence_penalty: sampling.presence_penalty,
              frequency_penalty: sampling.frequency_penalty,
              repeat_penalty: sampling.repeat_penalty,
              stop: LLM_STOP_TOKENS,
            }),
            // Страховка от зависшего llm_server: таймаут действует ТОЛЬКО на
            // установку соединения (заголовки SSE приходят сразу, поэтому в норме
            // fetch разрешается за миллисекунды). Как только ответ получен,
            // таймер снимается — AbortSignal.timeout здесь нельзя: он абортирует
            // и body-стрим, обрывая любой ответ длиннее 2 минут. От зависания
            // самого стрима защищает idle-watchdog ниже.
            signal: headerTimeout.controller.signal,
          })
          if (upstream.ok && upstream.body) {
            upstreamBody = upstream.body
          }
        }
      } finally {
        clearTimeout(headerTimeout.timer)
      }
      if (!upstream.ok || !upstreamBody) {
        const errText = await upstream.text().catch(() => '')
        cleanup()
        // (правка 173) 409 от llm_server.py («LLM уже генерирует другой
        // ответ») — это НЕ сбой 502: прокидываем чистый 409 с понятным
        // JSON, а не вложенный JSON в тексте ошибки (UI его не распознавал).
        if (upstream.status === 409) {
          return { kind: 'busy' as const }
        }
        return { kind: 'upstream-error' as const, error: `LLM error: ${errText || upstream.status}` }
      }
      // Счётчик стриминга включается под mutex (контракт startChat): с этого
      // момента и до конца ответа генерация получает 409.
      noteLlmStreaming(1)
      return { kind: 'ok' as const, body: upstreamBody }
    })

    if (!gate.ok) {
      cleanup()
      return new Response(JSON.stringify({ error: gate.error }), {
        status: gate.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const v = gate.result
    if (v.kind === 'start-error') {
      cleanup()
      return new Response(JSON.stringify({ error: v.error }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (v.kind === 'busy') {
      // (правка 173) Чистый 409 для параллельного запроса — клиент
      // (assistant-stream) парсит { error } и показывает его как есть.
      return new Response(
        JSON.stringify({ ok: false, error: 'Ассистент уже генерирует другой ответ — дождитесь завершения' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (v.kind === 'upstream-error') {
      return new Response(JSON.stringify({ error: v.error }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Виден в catch ниже (переменные try-блока там не в скоупе).
    let finishRef: (() => void) | null = null

    // Проксируем SSE вручную (reader → writer): во-первых, сервер ЗНАЕТ момент
    // конца ответа (включая обрыв соединения) и снимает блокировку генерации;
    // во-вторых, idle-сторож прерывает ЗАВИСШИЙ стрим — иначе счётчик
    // стриминга завис бы навсегда и генерация навечно получила бы 409.
    // temp-файлы: safety net. 60 с мало — ленивое декодирование видео и
    // сама генерация идут ПОСЛЕ старта стрима и могут длиться минутами;
    // normally finish() чистит файлы сразу по концу ответа.
    // 15 минут = граница finishWatchdog: temp-файлы удаляются не раньше,
    // чем стрим гарантированно завершён (при 10 мин живой стрим мог
    // остаться без своих видео-файлов в разгар ленивой токенизации).
    const safetyTimer = setTimeout(cleanup, 15 * 60_000)
    // (правка 110) Сторож finish(): если drain-насос завис (зависший
    // writer.write/close на half-open сокете клиента), finish() из finally
    // никогда бы не выполнился и счётчик стриминга держал блокировку генерации
    // ВЕЧНО (кнопка 409 навсегда). Здорогому стриму не жить 15 минут —
    // idle-сторож прерывает LLM после 5 мин тишины.
    let finishWatchdog: ReturnType<typeof setTimeout> | null = null
    try {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
      const reader = v.body.getReader()
      const writer = writable.getWriter()

      // Правка 31: чтение модели и подача клиенту ДЕКОУПЛЕНЫ через буфер.
      // Старый насос был последовательным (read → await writer.write): медленный
      // клиент (фоновая вкладка) создавал back-pressure на llm_server, и
      // idle-сторож мог сработать из-за «клиент не читает», а не из-за
      // зависшей модели. Теперь: upstream-цикл только читает модель в буфер,
      // drain-цикл только кормит клиента — ни один не ждёт другого.
      const buffer: Uint8Array[] = []
      let bufferedBytes = 0
      let upstreamDone = false
      let upstreamFailed = false
      let clientGone = false
      const MAX_BUFFERED = 8 * 1024 * 1024 // не копим в памяти больше 8 МБ

      let idleTimer: ReturnType<typeof setTimeout> | null = null
      const armIdleWatchdog = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          console.log('[llm] стрим завис (нет данных 5 мин) — прерываю')
          upstreamFailed = true
          void reader.cancel().catch(() => {})
        }, 5 * 60_000)
      }

      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        if (idleTimer) clearTimeout(idleTimer)
        clearTimeout(safetyTimer)
        if (finishWatchdog) clearTimeout(finishWatchdog) // (правка 110)
        noteLlmStreaming(-1)
        cleanup()
      }
      finishRef = finish

      // (правка 110) Форсируем finish() даже если drain-цикл завис навсегда.
      finishWatchdog = setTimeout(() => {
        if (!finished) {
          console.warn('[llm] (правка 110) finish-сторож: 15 мин без finish() — форсирую снятие блокировки')
          finish()
        }
      }, 15 * 60_000)

      // Upstream: читаем модель в буфер независимо от клиента. Если клиент
      // сильно отстал — ждём, пока буфер стечёт (back-pressure на модель, а
      // не на вкладку).
      void (async () => {
        try {
          armIdleWatchdog()
          for (;;) {
            if (clientGone) break
            const { done, value } = await reader.read()
            if (done) break
            armIdleWatchdog()
            // (правка 171) Bonsai idle-watchdog (llm-runner, 10 мин) убивал
            // сервер посреди длинного ответа: активность отмечалась один раз
            // до стрима. Обновляем на каждую SSE-дельту — как touch() на
            // каждый чанк в standard-бэкенде (tools/llm_server.py).
            if (backend === 'bonsai') noteLlmActivity()
            buffer.push(value)
            bufferedBytes += value.length
            while (bufferedBytes > MAX_BUFFERED && !clientGone) {
              // Медленный клиент ≠ зависшая модель: перезапускаем idle-сторож,
              // иначе 8 МБ буфера, стекающие дольше 5 мин, ложно убивали
              // здоровый стрим.
              armIdleWatchdog()
              await new Promise((r) => setTimeout(r, 20))
            }
          }
          upstreamDone = true
        } catch {
          upstreamFailed = true
        }
      })()

      // Drain: кормим клиента, пока буфер не опустеет и upstream не завершён.
      void (async () => {
        try {
          for (;;) {
            const chunk = buffer.shift()
            if (chunk) {
              bufferedBytes -= chunk.length
              await writer.write(chunk)
              continue
            }
            if (upstreamDone || upstreamFailed || clientGone) break
            await new Promise((r) => setTimeout(r, 10))
          }
          if (upstreamFailed && !clientGone) {
            try { await writer.abort() } catch { /* уже закрыт */ }
          } else if (!clientGone) {
            try { await writer.close() } catch { /* уже закрыт */ }
          }
        } catch {
          // клиент отключился (вкладка закрыта, сеть) — останавливаем и чтение
          // upstream, чтобы не держать соединение с llm_server
          clientGone = true
          void reader.cancel().catch(() => {})
        } finally {
          finish()
        }
      })()

      return new Response(readable, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      })
    } catch (err) {
      // Гатчина между «стрим начат» и «насос запущен»: снимаем счётчик и
      // перебрасываем во внешний catch (500), не оставляя блокировку.
      // Через finish() — он идемпотентен (guard `finished`); прямой
      // noteLlmStreaming(-1) здесь дал бы двойное декрементирование, если
      // насосы уже успели запланировать свой finish().
      if (finishRef) {
        finishRef()
      } else {
        // throw случился до создания finish — сырой откат
        noteLlmStreaming(-1)
        cleanup()
        clearTimeout(safetyTimer)
        if (finishWatchdog) clearTimeout(finishWatchdog) // (правка 110)
      }
      throw err
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
}
