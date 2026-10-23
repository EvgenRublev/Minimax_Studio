import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { submitVideo, uploadImage, uploadExtenderRef, COMFY_URL } from '@/lib/comfy/minimax-h3-client'
import type { ExtenderRefDescriptor } from '@/lib/comfy/minimax-h3-client'
import { setActivePrompt } from '@/lib/comfy/progress-tracker'
import { readStaged, deleteStaged } from '@/lib/staging'
import { recordPendingMeta } from '@/lib/pending-meta'
import { recordInflight } from '@/lib/inflight-journal'
import { loadLoras, listLoraFiles } from '@/lib/loras-config'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (правка 495)
import { resolveSourceLatent } from '@/lib/refine-meta' // (правка 420)
import { resolveFfmpeg } from '@/lib/thumb'
import { probeVideoFile } from '@/lib/video-probe'
import { compressRefVideo480 } from '@/lib/ref-video-compress' // (правка 493)
import { runGeneration, assertGenerationAllowed } from '@/lib/vram-arbiter'
import type { MiniMaxH3Params } from '@/lib/comfy/minimax-h3-template'

const execFileAsync = promisify(execFile)

/**
 * POST /api/comfy/generate
 * Body: MiniMaxH3Params (prompt, refImages[], aspectRatio, duration, seed, finalResolution?, lowResMP?, sigmaVariant?)
 * If refImages contains base64 data, uploads them first.
 * Staged reference names (uploaded while ComfyUI was down) are transferred
 * to ComfyUI's input/ here; the response carries `staged_transfers`
 * (stagedName → comfyName) so the client can update its references.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    // (правка 716) Лимит тела. Везде в проекте загрузки идут потоком с
    // явным лимитом (multipart-stream.ts, 1 ГБ на загрузку), а здесь
    // req.json() буферизует тело целиком, включая refImagesBase64 — клиент
    // мог прислать сотни мегабайт и уронить процесс Next.js по памяти.
    const MAX_BODY_BYTES = 256 * 1024 * 1024
    const declared = Number(req.headers.get('content-length') || 0)
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: 'Запрос слишком большой (максимум 256 МБ). Загрузите референсы через /api/comfy/upload.' },
        { status: 413 },
      )
    }
    const body = await req.json() as MiniMaxH3Params & {
      refImagesBase64?: string[]
      extendRefsBase64?: string[]
      /** (правка 385, ОТКАЧЕНА правкой 417; возвращено правкой 420 в новом
       *  качестве) extend: адрес оригинала в output/. Используется ТОЛЬКО
       *  для резолва первозданного латента исходника под пост-сборку
       *  combined-латента (правка 420) — в генерацию не подаётся. */
      extendSourceName?: string
      extendSourceSubfolder?: string
    }

    if (!body?.prompt) {
      return NextResponse.json({ error: 'Prompt is required.' }, { status: 400 })
    }
    const cfg = getAppConfig()

    // (правка 91) Папка проекта — дальше уходит в filename_prefix VHS
    // («folder/Minimax_Studio») и в пути сайдкаров. Клиент шлёт '' (общая)
    // или путь существующей папки.
    // (правка 495) Вложенные папки: многоуровневый относительный путь
    // ('a/b'), каждый сегмент санитизируется, '.'/'..' отбрасываются.
    body.outputSubfolder = sanitizeFolderPath(String(body.outputSubfolder ?? ''))

    // Fast-path 409 (до загрузки референсов): ассистент занят — не тратим
    // время на upload и не оставляем осиротевших файлов в input/ ComfyUI.
    // Полная проверка выполняется под mutex в runGeneration.
    const quickBlock = assertGenerationAllowed()
    if (quickBlock) {
      return NextResponse.json({ error: quickBlock }, { status: 409 })
    }

    // (правка 587) Имена, залитые в input/ ComfyUI в ЭТОМ запросе: если
    // генерация будет отбита ПОЗЖЕ (409/503 под mutex — быстрый чек выше не
    // ловит окно между ним и runGeneration), удаляем их, не оставляя сирот.
    const uploadedThisRequest: string[] = []

    // Upload base64 images if provided
    if (body.refImagesBase64?.length) {
      // (правка 716) Потолок на число картинок: модель принимает до 9
      // изображений-референсов. Без ограничения клиент мог прислать
      // тысячи base64-картинок — каждая декодировалась и писалась на диск.
      const MAX_REF_IMAGES = 9
      if (body.refImagesBase64.length > MAX_REF_IMAGES) {
        return NextResponse.json(
          { error: `Слишком много референсов (максимум ${MAX_REF_IMAGES})` },
          { status: 400 },
        )
      }
      for (let i = 0; i < body.refImagesBase64.length; i++) {
        const b64 = body.refImagesBase64[i].replace(/^data:image\/\w+;base64,/, '')
        const buf = Buffer.from(b64, 'base64')
        const ext = body.refImagesBase64[i].includes('/png') ? 'png' : 'jpg'
        const name = `ref_${Date.now()}_${i}.${ext}`
        const uploaded = await uploadImage(buf, name)
        uploadedThisRequest.push(uploaded)
        body.refImages = body.refImages || []
        // (правка 341) push, а не присваивание по индексу: staged-имена уже
        // лежат в refImages[0..n], и base64-загрузка затирала их по индексу.
        body.refImages.push(uploaded)
      }
    }

    // Transfer staged reference files (uploaded while ComfyUI was down)
    const transfers: Record<string, string> = {}
    const transferStaged = async (name: string) => {
      const staged = await readStaged(name)
      if (staged) {
        const comfyName = await uploadImage(staged, name)
        uploadedThisRequest.push(comfyName)
        transfers[name] = comfyName
        // Локальную копию удаляем: клиент обновляет пути через
        // staged_transfers, а .local-input/ иначе растёт бесконечно и
        // продолжает затенять превью (file-роут смотрит staging первым).
        await deleteStaged(name)
        return comfyName
      }
      return name
    }
    if (body.refImages?.length) {
      for (let i = 0; i < body.refImages.length; i++) {
        body.refImages[i] = await transferStaged(body.refImages[i])
      }
    }
    if (body.refVideos?.length) {
      for (let i = 0; i < body.refVideos.length; i++) {
        body.refVideos[i].path = await transferStaged(body.refVideos[i].path)
      }
    }
    // (правка 493) «Сжать видео»: референсы с флагом compress ресайзятся до
    // 480p (короткая сторона, пропорции сохраняются). Подменяем путь ТОЛЬКО
    // для сабмита — в мету уходит оригинальный файл + флаг compress (так
    // «Повторить» восстановит исходник и сожмёт его заново, а сжатые копии
    // кэшируются — повторный прогон бесплатен).
    let refVideosForSubmit = body.refVideos
    if (body.refVideos?.some((v) => v.compress === true)) {
      refVideosForSubmit = []
      for (const v of body.refVideos) {
        if (v.compress === true) {
          try {
            refVideosForSubmit.push({ ...v, path: await compressRefVideo480(v.path) })
          } catch (e) {
            return NextResponse.json(
              { error: `Сжатие видео-референса «${v.path}»: ${e instanceof Error ? e.message : String(e)}` },
              { status: 500 },
            )
          }
        } else {
          refVideosForSubmit.push(v)
        }
      }
    }
    if (body.refAudios?.length) {
      for (let i = 0; i < body.refAudios.length; i++) {
        body.refAudios[i] = await transferStaged(body.refAudios[i])
      }
    }
    // (правка 146) Кадры режима flf — тот же staged-трансфер, что у референсов
    if (body.firstFrame) body.firstFrame = await transferStaged(body.firstFrame)
    if (body.lastFrame) body.lastFrame = await transferStaged(body.lastFrame)
    // (правка 164) Источник видео для продления — staged transfer
    // (правка 421) basename(): если файла нет в стейджинге, transferStaged
    // возвращает сырое клиентское имя, а оно дальше уходит в
    // path.join(input/, ...) — то же, что basename у outputSubfolder (91).
    if (body.extendSourceVideo) body.extendSourceVideo = path.basename(await transferStaged(body.extendSourceVideo))

    // (правка 212) Extend: итоговое разрешение клипов = РАЗМЕР ИСХОДНИКА.
    // Раньше оставался дефолт (16:9 + finalResolution) — клипы генерились
    // в чужом разрешении, и на шве «оригинал → продолжение» был виден
    // скачок масштаба. ffmpeg -i даёт точные W×H исходника.
    if (body.mode === 'extend' && body.extendSourceVideo) {
      try {
        const srcPath = path.join(cfg.inputDir, body.extendSourceVideo)
        if (fs.existsSync(srcPath)) {
          const ffmpegBin = await resolveFfmpeg()
          if (ffmpegBin) {
            const probe = await execFileAsync(ffmpegBin, ['-hide_banner', '-i', srcPath], { timeout: 15_000 })
              .then(() => '')
              .catch((e: unknown) => ((e as { stderr?: string }).stderr ?? ''))
            // (правка 359) Разрешение ищем ТОЛЬКО в строке видеопотока —
            // общий /\d+x\d+/ мог зацепить размер из метаданных/тегов.
            const videoLine = probe.split('\n').find((l) => /Stream #.*Video:/.test(l)) ?? probe
            const m = /(\d{2,5})x(\d{2,5})/.exec(videoLine)
            if (m) {
              let w = parseInt(m[1], 10)
              let h = parseInt(m[2], 10)
              // (правка 218) SAR≠1: генерируем в DISPLAY-аспекте — как файл
              // выглядит при воспроизведении (конкат склейки тоже считает
              // цель по DAR), иначе клип и исходник расходятся по пропорции.
              const sarM = /SAR (\d+):(\d+) DAR (\d+):(\d+)/.exec(probe)
              if (sarM) {
                const sw = parseInt(sarM[1], 10)
                const sh = parseInt(sarM[2], 10)
                if (sw > 0 && sh > 0 && sw !== sh) {
                  w = w * sw
                  h = h * sh
                }
              }
              // чётные стороны — yuv420p не умеет нечётные
              body.targetDimensions = {
                width: 2 * Math.round(w / 2),
                height: 2 * Math.round(h / 2),
              }
            }
          }
        }
      } catch {
        // проба не удалась — остаётся путь по aspectRatio, как раньше
      }

      // (правка 254) Фактическая длина исходника в кадрах: план хвоста
      // латент-маскирующей цепочки клампится к ней в билдере. Без этого
      // короткий исходник давал сдвиг preserved-зоны маски → «чистый шум»
      // в начале первого клипа.
      try {
        const srcPath2 = path.join(cfg.inputDir, body.extendSourceVideo)
        if (fs.existsSync(srcPath2)) {
          const pr = await probeVideoFile(srcPath2)
          if (Number.isFinite(pr.frames) && pr.frames > 0) {
            body.extendSourceFrames = pr.frames
          }
          // (правка 420) Резолв первозданного латента исходника — НЕ для
          // генерации (сид остаётся пиксельным, правки 409/419), а для
          // ПОСТ-СБОРКИ combined-латента итога: таймлайн склейки собирается
          // из латентных кусков ПОСЛЕ сэмплеров и сохраняется файлом
          // (lossless-рефайн/апскейл продлённого видео). Латента нет или он
          // не бьётся с mp4 — билдер сам энкоднет исходник целиком (fallback).
          const srcName = typeof body.extendSourceName === 'string' ? path.basename(body.extendSourceName) : ''
          const srcSubRaw = typeof body.extendSourceSubfolder === 'string'
            ? body.extendSourceSubfolder.split(/[\\/]/).filter(Boolean)
            : []
          if (srcName && srcSubRaw.length <= 1 && !srcSubRaw.some((x) => x === '.' || x === '..')) {
            const resolved = resolveSourceLatent(srcSubRaw[0] ?? '', srcName, pr, (reason) =>
              console.warn(`[generate/extend] первозданный латент не используется (${srcName}): ${reason}`),
            )
            if (resolved) {
              body.extendSourceLatentFile = resolved.file
            }
          }
        }
      } catch {
        // проба кадров не удалась — билдер останется на плане по длительности
      }
    }

    // (правка 161) extend-рефы: картинки загружаются в ВНУТРЕННИЙ кэш
    // Extender-ноды через /h3_extender/ref/upload — нода ожидает
    // content-addressed descriptor (id = 64 hex), а НЕ имя файла из
    // input/ ComfyUI. Поэтому: (1) staged-файл читаем локально;
    // (2) upload в кэш ноды;
    // (3) в body.extendRefsDescriptor[] — descriptors (не имена файлов),
    //     body.extendRefs — оставляем имена для метаданных («Повторить»).
    // (правка 161) Клиент может прислать extendRefsBase64 — массив base64
    // (data-URI), если картинки ещё не загружены в staged.
    const extendRefDescriptors: ExtenderRefDescriptor[] = []
    const extendRefsStaged: string[] = []
    if (body.extendRefs?.length) {
      for (const rawName of body.extendRefs) {
        // (правка 421) basename(): имя приходит от клиента и дальше уходит в
        // path.join(input/, ...) — единообразно с остальными роутами.
        const name = path.basename(String(rawName))
        const staged = await readStaged(name)
        if (staged) {
          const desc = await uploadExtenderRef(staged, name)
          extendRefDescriptors.push(desc)
          extendRefsStaged.push(name)
          await deleteStaged(name)
        } else {
          // Файл уже в ComfyUI input/ — читаем с диска и upload в кэш ноды.
          const filePath = path.join(cfg.inputDir, name)
          if (!fs.existsSync(filePath)) {
            return NextResponse.json(
              { error: `Реф продления «${name}» не найден в input/ ComfyUI — удалите его из списка и загрузите заново.` },
              { status: 400 },
            )
          }
          const buf = fs.readFileSync(filePath)
          const desc = await uploadExtenderRef(buf, name)
          extendRefDescriptors.push(desc)
          extendRefsStaged.push(name)
        }
      }
    }
    if (body.extendRefsBase64?.length) {
      for (let i = 0; i < body.extendRefsBase64.length; i++) {
        const raw = body.extendRefsBase64[i]
        const b64 = raw.replace(/^data:image\/\w+;base64,/, '')
        const buf = Buffer.from(b64, 'base64')
        const ext = raw.includes('/png') ? 'png' : 'jpg'
        const name = `extref_${Date.now()}_${i}.${ext}`
        const desc = await uploadExtenderRef(buf, name)
        extendRefDescriptors.push(desc)
        extendRefsStaged.push(name)
      }
    }
    if (extendRefDescriptors.length > 0) {
      body.extendRefDescriptors = extendRefDescriptors as unknown as Array<Record<string, unknown> & { id: string }>
      if (extendRefsStaged.length > 0) {
        // Обновляем имена (staged → comfy) для метаданных.
        body.extendRefs = extendRefsStaged.map((n) => transfers[n] ?? n)
      }
    }

    // Custom LoRAs: inject enabled ones from config (правка 44).
    // (правка 89) Сверка с файлами на диске: запись в loras.json, файл
    // которой удалён вручную мимо приложения, — «призрак», ComfyUI упал бы
    // на загрузке несуществующей лоры. Такие записи молча пропускаем.
    // (правка 95) Турбо-лора управляется той же записью в loras.json
    // (enabled/strength) — в кастомную цепочку не входит.
    const loraFiles = new Set(listLoraFiles())
    const allEntries = loadLoras()
    // (правка 578) Турбо-лора убрана — все включённые LoRA теперь кастомные
    const loraEntries = allEntries.filter((e) => e.enabled && loraFiles.has(e.name))
    body.turboLoraEnabled = false
    body.turboLoraStrength = 1.0
    // (правка 89) Исходный промпт БЕЗ триггеров — уйдёт в метаданные,
    // иначе «Повторить генерацию» допишет триггеры к уже дописанному
    // промпту и они начнут накапливаться с каждым повтором.
    const promptForMeta = body.prompt
    // (правка 483) То же для extend-клипов: conditioning продления строится
    // из extendClips[i].prompt (а не body.prompt), поэтому триггеры
    // дописываем в КАЖДЫЙ клип. Оригиналы сохраняем — в мету уходят чистые,
    // иначе «Повторить» накапливал бы триггеры в клипах.
    const extendClipsForMeta = body.extendClips
    if (loraEntries.length > 0) {
      body.customLoras = loraEntries.map((e) => ({ name: e.name, strength: e.strength }))
      // Append trigger words to the prompt (правка 46)
      const triggers = loraEntries
        .map((e) => e.trigger?.trim())
        .filter((t): t is string => !!t)
      if (triggers.length > 0) {
        const suffix = ' ' + triggers.join(', ')
        body.prompt = body.prompt + suffix
        // (правка 483) extend: триггеры в промпт каждого клипа
        if (body.mode === 'extend' && body.extendClips?.length) {
          body.extendClips = body.extendClips.map((c) => ({ ...c, prompt: c.prompt + suffix }))
        }
      }
    }

    // Diffusion model: inject from config if set (правка 45).
    // (правка 89) Файл мог быть удалён с диска после выбора — проверяем
    // существование, иначе шаблон падает на UNETLoader с отсутствующим файлом.
    if (cfg.diffusionModel) {
      const modelPath = path.join(cfg.comfyRoot, 'ComfyUI', 'models', 'diffusion_models', cfg.diffusionModel)
      if (fs.existsSync(modelPath)) {
        body.diffusionModel = cfg.diffusionModel
      }
    }

    // VRAM arbitration: LLM должен ПОЛНОСТЬЮ покинуть VRAM до загрузки MiniMax.
    // Mutex держится и на submit — окно для гонки с чатом исключено.
    // (правка 493) refVideosForSubmit — с подменёнными путями сжатых копий.
    const run = await runGeneration(() => submitVideo({ ...body, refVideos: refVideosForSubmit }))
    if (!run.ok) {
      // (правка 587) Отказ ПОСЛЕ загрузки референсов (409/503 из-под mutex —
      // LLM-чат начался между quick-чеком и здесь) оставлял файлы-сироты в
      // input/ ComfyUI. Удаляем best-effort; только для 409/503: при 500
      // submit мог частично встать в очередь, и удаление сломало бы джоб.
      if (uploadedThisRequest.length && (run.status === 409 || run.status === 503)) {
        try {
          await fetch(`${COMFY_URL}/upload/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ delete: uploadedThisRequest }),
          }).catch(() => {})
        } catch { /* best-effort */ }
      }
      return NextResponse.json({ error: run.error }, { status: run.status })
    }
    const result = run.result
    // Set active prompt so KJ preview events can be mapped
    if (result.prompt_id) {
      setActivePrompt(result.prompt_id)
      // Server-side metadata: persist the job params NOW so the sidecar can
      // be written on completion even if the browser tab is closed.
      // (правка 89) промпт без триггерных слов — см. комментарий выше;
      // (правка 483) extend-клипы в мету — тоже чистые (без триггеров)
      recordPendingMeta(result.prompt_id, {
        ...body,
        prompt: promptForMeta,
        ...(extendClipsForMeta ? { extendClips: extendClipsForMeta } : {}),
      })
      // (правка 331) Журнал inflight: фронт прислал clientToken в теле POST —
      // после перезагрузки страницы во время этого запроса он найдёт здесь
      // prompt_id через GET /api/comfy/inflight и re-attach'ит поллинг.
      const clientToken = (body as { clientToken?: unknown }).clientToken
      if (typeof clientToken === 'string' && clientToken.length > 0 && clientToken.length <= 100) {
        recordInflight(clientToken, result.prompt_id)
      }
    }
    return NextResponse.json({ ...result, staged_transfers: transfers })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
