import { NextRequest, NextResponse } from 'next/server'
import { promises as fs, existsSync } from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (правка 495)
import { writeMetaSidecar } from '@/lib/pending-meta'
import { mergeExtendMeta } from '@/lib/extend-meta'
import { resolveFfmpeg } from '@/lib/thumb'
import { probeVideoFile } from '@/lib/video-probe'
import { ffmpegVideoArgs } from '@/lib/video-format'
import { getVideoFormatSettings } from '@/lib/video-format-server' // (правка 386)

const execFileAsync = promisify(execFile)

/**
 * (правка 716) Рекурсивный поиск файла по имени в подпапках (глубина ≤ depth).
 * Пропускает служебные точки и папки, начинающиеся с '.'.
 */
async function findFileRecursive(root: string, fileName: string, depth: number): Promise<string | null> {
  if (depth < 0) return null
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  const direct = path.join(root, fileName)
  if (existsSync(direct)) return direct
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === '.' || entry.name === '..' || entry.name.startsWith('.')) continue
    const found = await findFileRecursive(path.join(root, entry.name), fileName, depth - 1)
    if (found) return found
  }
  return null
}

interface ProbeInfo {
  duration: number
  width: number
  height: number
  fps: number
}

interface InputSpec {
  /** Filename in ComfyUI output/ (or input/ if `kind === 'source'`). */
  name: string
  /** Subfolder inside output/ (empty string for root). */
  subfolder?: string
  /** 'output' (default) = file in output/; 'source' = file in input/. */
  kind?: 'output' | 'source'
}

/**
 * POST /api/comfy/concat
 *
 * N-way seamless crossfade concat of videos.
 *
 * Backward-compatible body shapes:
 *   { source: string, generated: string, fade?: number }
 *
 * New (N-way) shape:
 *   { inputs: InputSpec[], fade?: number, outName?: string }
 *
 * Output is saved in output/ as `Minimax_Studio_combined_<n>.mp4`
 * (or `<outName>` if provided) and returned with filename + url.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      source?: string
      generated?: string
      fade?: number
      inputs?: InputSpec[]
      outName?: string
      /** (правка 213) Подрезать КОНЕЦ первого входа (исходник) на N секунд —
       * стык «исходник → клип 0» садится на перекрытие шева из правки 210. */
      sourceTrimSeconds?: number
      /** (правка 218) Кроссфейд именно на ПЕРВОМ стыке «исходник → клип 0».
       * Там контент перекрытия одинаков с обеих сторон, поэтому длинный
       * фейд невидим как «растворение», но полностью накрывает смену
       * характера картинки (VAE-раундтрип + pass 2: микроконтраст,
       * резкость). Между клипами остаётся короткий `fade`. */
      seamFadeSeconds?: number
      /** (правка 250) Подрезать ГОЛОВУ входа i≥1 на N секунд — warmup-префикс
       *  клипа (дублированные моменты хвоста клипа i-1), не съеденный кроссфейдом.
       *  Без этой подрезки короткий fade оставлял бы повтор ~0.8 c на стыке. */
      headTrims?: number[]
      /** (правка 260) Параметры метаданных для сайдкара итогового файла. */
      meta?: Record<string, unknown>
      /** (правка 365) Подпапка output для итогового файла ('' = корень) —
       *  extend-склейка кладёт combined-файл в папку оригинала. */
      outSubfolder?: string
      /** (правка 384) Комбинированный файл УЖЕ собран воркфлоу продления
       *  (сегментный decode + один encode) — ffmpeg не нужен, только
       *  метаданные с ФАКТИЧЕСКИМИ параметрами итога (probe файла):
       *  video_length/resolution/duration для lossless-резолвера латента
       *  и диалога меты. outName = имя готового файла в output/. */
      metaOnly?: boolean
    }
    // (правка 716) Числа валидируются: раньше body.fade = "abc" давал NaN
    // (Math.min(3, "abc") → NaN), и в xfade уходило duration=NaN → ffmpeg
    // падал с 500 вместо внятного 400. headTrims без проверки массива давал
    // ".map is not a function" → тоже 500.
    const num = (v: unknown, def: number, lo: number, hi: number): number => {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
      if (!Number.isFinite(n)) return def
      return Math.max(lo, Math.min(hi, n))
    }
    const fadeSec = num(body.fade, 1, 0, 3)
    const seamFadeSec = num(body.seamFadeSeconds, fadeSec, 0, 3)
    const sourceTrim = num(body.sourceTrimSeconds, 0, 0, 10)
    const headTrimsRaw = Array.isArray(body.headTrims) ? body.headTrims : []
    const headTrims = headTrimsRaw.map((t) => num(t, 0, 0, 10))

    // Normalize inputs: legacy 2-input shape → [source, generated].
    const inputs: InputSpec[] = []
    if (Array.isArray(body.inputs) && body.inputs.length >= 2) {
      for (const it of body.inputs) {
        if (it && typeof it.name === 'string' && it.name.trim()) {
          inputs.push({ name: it.name.trim(), subfolder: it.subfolder || '', kind: it.kind || 'output' })
        }
      }
    } else if (body.source && body.generated) {
      inputs.push({ name: body.source.trim(), subfolder: '', kind: 'source' })
      inputs.push({ name: body.generated.trim(), subfolder: '', kind: 'output' })
    }

    // (правка 384) metaOnly не требует двух входов — ffmpeg не вызывается
    if (!body.metaOnly && inputs.length < 2) {
      return NextResponse.json(
        { error: 'Provide at least 2 inputs (source + generated, or inputs[] array)' },
        { status: 400 },
      )
    }

    const cfg = getAppConfig()
    const inputDir = cfg.inputDir
    const outputDir = cfg.outputDir
    const outputRoot = path.resolve(outputDir)

    // ─── (правка 384) metaOnly: файл уже собран воркфлоу — только метаданные ───
    if (body.metaOnly) {
      let mName = (body.outName || '').replace(/[\\/:*?"<>|]/g, '_')
      mName = path.basename(mName)
      if (!mName) {
        return NextResponse.json({ error: 'outName required for metaOnly' }, { status: 400 })
      }
      // (правка 716) Многоуровневый outSubfolder — как у остальных файловых
      // роутов (sanitizeFolderPath, правка 495). Раньше принимался только
      // ОДИН сегмент, а клиент передаёт сюда output_subfolder генерируемого
      // ролика (use-video-gen.ts) — для вложенной папки проекта вида
      // 'project/scenes' concat отвечал 400 Invalid outSubfolder, и итоговое
      // видео не создавалось.
      const mSub = sanitizeFolderPath(body.outSubfolder || '')
      const mPath = path.resolve(path.join(outputDir, ...(mSub ? mSub.split('/') : []), mName))
      if (mPath !== outputRoot && !mPath.startsWith(outputRoot + path.sep)) {
        return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
      }
      if (!existsSync(mPath)) {
        return NextResponse.json({ error: `File not found: ${mName}` }, { status: 404 })
      }
      let actual: { width: number; height: number; frames: number; durationSec: number } | null = null
      try {
        const pr = await probeVideoFile(mPath)
        if (pr.width > 0 && pr.height > 0 && pr.frames > 0) {
          actual = { width: pr.width, height: pr.height, frames: pr.frames, durationSec: pr.durationSec }
        }
      } catch { /* без фактических полей — запишем как прислали */ }
      if (body.meta && typeof body.meta === 'object') {
        try {
          writeMetaSidecar(mName, mSub, {
            ...body.meta,
            ...(actual && {
              video_length: actual.frames,
              duration_seconds: Number(actual.durationSec.toFixed(2)),
              resolution: `${actual.width}x${actual.height}`,
              fps: 24,
            }),
            combined_from: inputs.map((i2) => i2.name),
            created_at: Date.now() / 1000,
          })
        } catch { /* сайдкар не критичен */ }
      }
      return NextResponse.json({
        filename: mName,
        subfolder: mSub,
        audio: true,
        input_count: inputs.length,
        url: `/api/comfy/file?filename=${encodeURIComponent(mName)}${mSub ? `&subfolder=${encodeURIComponent(mSub)}` : ''}`,
      })
    }

    // Resolve each input path.
    // (правка 339) Валидация name/subfolder ДО join: basename отсекает
    // разделители, а dot-сегменты ('.', '..') отклоняем — иначе path.join
    // уходил выше outputDir/inputDir (path traversal через входы склейки).
    const inputRoot = path.resolve(inputDir)
    const resolvedPaths: string[] = []
    for (const it of inputs) {
      const base = it.kind === 'source' ? inputDir : outputDir
      const baseRoot = it.kind === 'source' ? inputRoot : outputRoot
      const safeItName = path.basename(it.name)
      if (!safeItName || safeItName === '.' || safeItName === '..') {
        return NextResponse.json({ error: `Invalid input name: ${it.name}` }, { status: 400 })
      }
      // (правка 495) Вложенные папки: subfolder — многоуровневый
      // относительный путь ('a/b'); сегменты '.'/'..' отбрасываются.
      const subSegs = sanitizeFolderPath(it.subfolder || '').split('/').filter(Boolean)
      let p = path.join(base, ...subSegs, safeItName)
      const resolvedP = path.resolve(p)
      if (resolvedP !== baseRoot && !resolvedP.startsWith(baseRoot + path.sep)) {
        return NextResponse.json({ error: `Invalid path for input: ${safeItName}` }, { status: 400 })
      }
      if (!existsSync(p) && it.kind === 'output') {
        // (правка 716) Fallback: рекурсивный поиск по подпапкам output/.
        // Раньше сканировались только папки ПЕРВОГО уровня, и клип,
        // лежащий в 'project/scenes', не находился → 404 Input not found.
        try {
          const found = await findFileRecursive(outputDir, safeItName, 3)
          if (found) p = found
        } catch { /* ignore */ }
      }
      if (!existsSync(p)) {
        return NextResponse.json({ error: `Input not found: ${it.name}` }, { status: 404 })
      }
      resolvedPaths.push(p)
    }

    const ffmpeg = await resolveFfmpeg()
    if (!ffmpeg) {
      return NextResponse.json({ error: 'FFmpeg not available' }, { status: 500 })
    }

    // Probe all inputs.
    const infos: ProbeInfo[] = []
    for (const p of resolvedPaths) {
      const info = await probeVideo(ffmpeg, p)
      if (!info) {
        return NextResponse.json({ error: `Cannot probe video: ${path.basename(p)}` }, { status: 500 })
      }
      infos.push(info)
    }

    // (правка 224) Цель = ПЕРВЫЙ КЛИП (infos[1]), не исходник: клип
    // генерится на канве pass 1 (правка 224 — аспект точный), и масштабирование
    // его обратно под исходник вернуло бы растяжение. Исходник равномерно
    // масштабируется под итог (~2% — незаметно). Fallback infos[0].
    const targetW = infos[1]?.width || infos[0]?.width || 1280
    const targetH = infos[1]?.height || infos[0]?.height || 704
    const targetFps = 24
    const evW = targetW % 2 === 0 ? targetW : targetW + 1
    const evH = targetH % 2 === 0 ? targetH : targetH + 1

    // Build filter chain: hard-cut concat (fade=0) or xfade/acrossfade (fade>0).
    const filterParts: string[] = []
    const trim0 = sourceTrim > 0 && !!infos[0] && infos[0].duration > sourceTrim + 0.05
    for (let i = 0; i < infos.length; i++) {
      // (правка 213) Первый вход (исходник) с sourceTrim: режем ХВОСТ
      // ровно на длительность перекрытия шва (правка 210 ноды) — по
      // времени, аудио тем же числом.
      if (i === 0 && trim0) {
        const keep = (infos[0].duration - sourceTrim).toFixed(4)
        filterParts.push(`[${i}:v]fps=${targetFps},trim=duration=${keep},setpts=PTS-STARTPTS,scale=${evW}:${evH},setsar=1[v${i}]`)
        filterParts.push(`[${i}:a]aresample=44100,atrim=duration=${keep},asetpts=PTS-STARTPTS[a${i}]`)
      } else {
        // (правка 239) Убран in_color_matrix — это НЕ валидный ffmpeg фильтр,
        // он ломает filter graph. Цвет уже корректен без него (правка 237 —
        // убран тон-матчинг для клипов i>0).
        // (правка 250) Головы входов i≥1: срез warmup-префикса, не съеденного
        // фейдом (дублированные моменты хвоста предыдущего клипа).
        const ht = headTrims[i] || 0
        const headCut = ht > 0.001 ? `trim=start=${ht.toFixed(4)},setpts=PTS-STARTPTS,` : ''
        filterParts.push(`[${i}:v]${headCut}scale=${evW}:${evH},setsar=1,fps=${targetFps}[v${i}]`)
      }
    }

    if (fadeSec === 0) {
      // (правка 292) Гибридный режим: fade=0 + seamFadeSec>0 →
      // первый стык (исходник→клип 0) — xfade с seamFadeSec,
      // остальные стыки — hard cut. Без seamFadeSec — все hard cut.
      if (seamFadeSec > 0.001 && infos.length >= 2) {
        // xfade на первом стыке: [v0][v1]xfade→[v1]
        const offset_0 = Math.max(0, (infos[0].duration - (trim0 ? sourceTrim : 0)) - seamFadeSec)
        filterParts.push(
          `[v0][v1]xfade=transition=fade:duration=${seamFadeSec.toFixed(3)}:offset=${offset_0.toFixed(3)}[v1]`,
        )
        // concat для остальных: [v1][v2][v3]...concat
        const rest = infos.slice(1).map((_, i) => `[v${i + 1}]`).join('')
        filterParts.push(`${rest}concat=n=${infos.length - 1}:v=1:a=0[vout]`)
        // Audio: acrossfade на первом стыке, потом concat
        if (trim0) {
          // [0:a] уже подрезан
        } else {
          filterParts.push(`[0:a]aresample=44100[a0]`)
        }
        for (let i = 1; i < infos.length; i++) {
          const ht = headTrims[i] || 0
          const ahead = ht > 0.001 ? `atrim=start=${ht.toFixed(4)},asetpts=PTS-STARTPTS,` : ''
          filterParts.push(`[${i}:a]${ahead}aresample=44100[a${i}]`)
        }
        filterParts.push(`[a0][a1]acrossfade=d=${seamFadeSec.toFixed(3)}[a1]`)
        const restA = infos.slice(1).map((_, i) => `[a${i + 1}]`).join('')
        filterParts.push(`${restA}concat=n=${infos.length - 1}:v=0:a=1[aout]`)
      } else {
        // Чистый hard-cut concat: no overlap, full duration preserved.
        const videoConcat = infos.map((_, i) => `[v${i}]`).join('') + `concat=n=${infos.length}:v=1:a=0[vout]`
        filterParts.push(videoConcat)
        for (let i = 0; i < infos.length; i++) {
          if (i === 0 && trim0) continue // [0:a] уже потреблён в подрезке
          const ht = i >= 1 ? (headTrims[i] || 0) : 0
          const ahead = ht > 0.001 ? `atrim=start=${ht.toFixed(4)},asetpts=PTS-STARTPTS,` : ''
          filterParts.push(`[${i}:a]${ahead}aresample=44100[a${i}]`)
        }
        const audioConcat = infos.map((_, i) => `[a${i}]`).join('') + `concat=n=${infos.length}:v=0:a=1[aout]`
        filterParts.push(audioConcat)
      }
    } else {
      // N-way xfade chain (правка 182, финальная):
      // После каждого xfade промежуточный вывод имеет длительность
      //   prev_out_dur + d[next] - fadeSec
      // Поэтому offset следующего xfade считается от БЕГУЩЕЙ длительности
      // промежуточного вывода, а НЕ от суммы входных клипов.
      //
      // Верификация: 3 клипа по 5.17s, fade=1s
      //   running = 5.17
      //   offset_0 = 5.17 - 1 = 4.17 → out dur = 5.17+5.17-1 = 9.34
      //   offset_1 = 9.34 - 1 = 8.34 → out dur = 9.34+5.17-1 = 13.51
      //   ИТОГО: 13.51s ✅ (совпадает с ручным ffmpeg)
      //
      // Старая формула (cumulative += d[i]; offset = cumulative - fadeSec)
      // давала offset_1 = 9.34, что ВЫХОДИЛО за пределы промежуточного вывода
      // (длительность 9.34s), ffmpeg обрезал хвост и итог был 9.33s.
      let running = infos[0].duration - (trim0 ? sourceTrim : 0)
      for (let i = 0; i < infos.length - 1; i++) {
        // (правка 218) Первый стык — «исходник → клип 0»: контент с обеих
        // сторон одинаков (перекрытие шева), длинный фейд невидим, но
        // накрывает смену характера картинки. Остальные стыки — короткий fade.
        const f = i === 0 ? seamFadeSec : fadeSec
        const offset_i = Math.max(0, running - f)
        filterParts.push(
          `[v${i}][v${i + 1}]xfade=transition=fade:duration=${f}:offset=${offset_i.toFixed(3)}[v${i + 1}]`,
        )
        // (правка 250) следующий вход короче на свою головную подрезку
        running += infos[i + 1].duration - (headTrims[i + 1] || 0) - f
      }

      // Audio chain: acrossfade between consecutive clips.
      // (правка 250) головная подрезка синхронно с видеорядом.
      for (let i = 0; i < infos.length; i++) {
        if (i === 0 && trim0) continue // [0:a] уже потреблён в подрезке
        const ht = i >= 1 ? (headTrims[i] || 0) : 0
        const ahead = ht > 0.001 ? `atrim=start=${ht.toFixed(4)},asetpts=PTS-STARTPTS,` : ''
        filterParts.push(`[${i}:a]${ahead}aresample=44100[a${i}]`)
      }
      for (let i = 0; i < infos.length - 1; i++) {
        filterParts.push(`[a${i}][a${i + 1}]acrossfade=d=${i === 0 ? seamFadeSec : fadeSec}[a${i + 1}]`)
      }
    }

    let outName = (body.outName || `Minimax_Studio_combined_${infos.length}`).replace(/[\\/:*?"<>|]/g, '_')
    outName = path.basename(outName)
    if (!/\.mp4$/i.test(outName)) outName = outName + '.mp4'
    // (правка 342) Фиксированное имя + '-y' молча перезаписывало прежний
    // результат склейки — counter-цикл, как в /api/comfy/trim.
    // (правка 716) Многоуровневый outSubfolder (как у остальных файловых
    // роутов — sanitizeFolderPath, правка 495). Раньше принимался только
    // ОДИН сегмент, а клиент передаёт сюда output_subfolder генерируемого
    // ролика (use-video-gen.ts) — для вложенной папки проекта вида
    // 'project/scenes' concat отвечал 400 Invalid outSubfolder, и итоговое
    // видео не создавалось.
    const outSub = sanitizeFolderPath(body.outSubfolder || '')
    const outExt = path.extname(outName)
    const outStem = outName.slice(0, outName.length - outExt.length)
    let outPath = path.join(outputDir, ...(outSub ? outSub.split('/') : []), outName)
    {
      let counter = 1
      while (existsSync(outPath)) {
        outName = `${outStem}_${counter++}${outExt}`
        outPath = path.join(outputDir, ...(outSub ? outSub.split('/') : []), outName)
        if (counter > 100) {
          return NextResponse.json({ error: 'Too many combined outputs' }, { status: 500 })
        }
      }
    }
    await fs.mkdir(path.dirname(outPath), { recursive: true })

    const inputArgs: string[] = []
    for (const p of resolvedPaths) {
      inputArgs.push('-i', p)
    }

    // Determine output label based on concat mode.
    const vOutLabel = fadeSec === 0 ? 'vout' : `v${infos.length - 1}`
    const aOutLabel = fadeSec === 0 ? 'aout' : `a${infos.length - 1}`

    // (правка 213а) outPath идёт ПОСЛЕДНИМ: раньше -map [a..]/-c:a приклеивались
    // ПОСЛЕ имени файла — ffmpeg считал их опциями фантомного «второго
    // выхода», [a1] оставался незамкнутым, и ВСЕ склейки теряли аудио.
    const baseArgs = [
      '-hide_banner', '-loglevel', 'error',
      ...inputArgs,
      '-filter_complex', filterParts.join(';'),
      '-map', `[${vOutLabel}]`,
      // (правка 386) кодек/качество — из [video] настроек студии
      '-preset', 'fast', ...ffmpegVideoArgs(getVideoFormatSettings()),
      '-movflags', '+faststart',
      '-y',
    ]

    let usedAudio = true
    const audioArgs = ['-map', `[${aOutLabel}]`, '-c:a', 'aac', '-b:a', '192k', outPath]
    try {
      await execFileAsync(ffmpeg, [...baseArgs, ...audioArgs], {
        timeout: 600_000, maxBuffer: 32 * 1024 * 1024,
      })
    } catch (err: unknown) {
      // Retry without audio (some clips may lack audio streams).
      const e = err as { stderr?: string; message?: string }
      const stderr = e.stderr || e.message || String(err)
      console.error('[concat] FFmpeg with-audio FAILED:', stderr.slice(0, 800))
      usedAudio = false
      const noAudioFilter = filterParts.filter((s) => !s.includes('[a') && !s.includes('acrossfade') && !s.includes('[aout]'))
      try {
        await execFileAsync(
          ffmpeg,
          [
            '-hide_banner', '-loglevel', 'error',
            ...inputArgs,
            '-filter_complex', noAudioFilter.join(';'),
            '-map', `[${vOutLabel}]`,
            '-an',
            // (правка 386) кодек/качество — из [video] настроек студии
      '-preset', 'fast', ...ffmpegVideoArgs(getVideoFormatSettings()),
            '-movflags', '+faststart',
            '-y',
            outPath,
          ],
          { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
        )
      } catch {
        throw new Error(`FFmpeg concat failed: ${stderr.slice(0, 600)}`)
      }
    }

    // (правка 260) Метаданные комбинированного файла (например, итог
    // продления): вызывающая сторона передаёт готовые параметры — сюда
    // добавляем только служебные поля. Без meta сайдкар не пишем (роут
    // используют и другие вызовы).
    if (body.meta && typeof body.meta === 'object') {
      try {
        // (правка 293) Наследование от сайдкара исходника продления
        // (references / цепочка extend_prompts / source_prompt — mergeExtendMeta
        // в src/lib/extend-meta.ts). Ищем сайдкар
        // в корне output и, как fallback, в подпапках первого уровня (как
        // входы выше). Нет сайдкара — пишем meta как прислали.
        let sourceMeta: Record<string, unknown> | null = null
        const sv = (body.meta as { source_video?: { name?: unknown } }).source_video
        const srcName = typeof sv?.name === 'string' && sv.name ? path.basename(sv.name) : ''
        if (srcName) {
          const outputRoot = path.resolve(outputDir)
          const candidates = [path.join(outputDir, srcName + '.meta.json')]
          try {
            for (const entry of await fs.readdir(outputDir, { withFileTypes: true })) {
              if (entry.isDirectory()) candidates.push(path.join(outputDir, entry.name, srcName + '.meta.json'))
            }
          } catch { /* ignore */ }
          for (const c of candidates) {
            const resolved = path.resolve(c)
            if (!resolved.startsWith(outputRoot + path.sep) && resolved !== outputRoot) continue
            if (!existsSync(resolved)) continue
            try {
              sourceMeta = JSON.parse(await fs.readFile(resolved, 'utf-8')) as Record<string, unknown>
            } catch { /* битый сайдкар — без наследования */ }
            break
          }
        }
        // (правка 383) Фактические параметры ИТОГОВОГО файла (ffprobe):
        // video_length/resolution/duration. Раньше мета несла параметры
        // ДЖОБА (длительность клипа, а не склейки) — теперь совпадают с
        // реальным файлом; это же условие lossless-ветки: резолвер латента
        // сверяет video_length/resolution меты с пробой mp4.
        let actual: { width: number; height: number; frames: number; durationSec: number } | null = null
        try {
          const pr = await probeVideoFile(outPath)
          if (pr.width > 0 && pr.height > 0 && pr.frames > 0) {
            actual = { width: pr.width, height: pr.height, frames: pr.frames, durationSec: pr.durationSec }
          }
        } catch { /* проба не критична: мета без фактических полей */ }
        writeMetaSidecar(outName, outSub, { // (правка 365) сайдкар рядом с результатом
          ...mergeExtendMeta(body.meta as Record<string, unknown>, sourceMeta),
          ...(actual && {
            video_length: actual.frames,
            duration_seconds: Number(actual.durationSec.toFixed(2)),
            resolution: `${actual.width}x${actual.height}`,
            fps: 24,
          }),
          combined_from: inputs.map((i2) => i2.name),
          combined_audio: usedAudio,
          created_at: Date.now() / 1000,
        })
      } catch { /* сайдкар не критичен для самой склейки */ }
    }

    return NextResponse.json({
      filename: outName,
      subfolder: outSub, // (правка 365)
      audio: usedAudio,
      input_count: infos.length,
      url: `/api/comfy/file?filename=${encodeURIComponent(outName)}${outSub ? `&subfolder=${encodeURIComponent(outSub)}` : ''}`,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/** Probe a video file for duration, width, height, fps. */
async function probeVideo(ffmpeg: string, filePath: string): Promise<ProbeInfo | null> {
  let stderr = ''
  try {
    const r = await execFileAsync(ffmpeg, ['-hide_banner', '-i', filePath], { timeout: 15_000 })
    stderr = r.stderr ?? ''
  } catch (e) {
    stderr = (e as { stderr?: string }).stderr ?? ''
  }

  const durM = /Duration:\s*(\d+):(\d{2}):(\d{2}\.\d{2})/.exec(stderr)
  const duration = durM
    ? Number(durM[1]) * 3600 + Number(durM[2]) * 60 + Number(durM[3])
    : 0

  // (правка 359) Разрешение — только из строки видеопотока, иначе общий
  // регекс цеплял чужие NxM из тегов/метаданных контейнера.
  const videoLine = stderr.split('\n').find((l) => /Stream #.*Video:/.test(l)) ?? stderr
  const resM = /(\d{2,5})x(\d{2,5})/.exec(videoLine)
  let width = resM ? parseInt(resM[1], 10) : 0
  let height = resM ? parseInt(resM[2], 10) : 0

  // (правка 218) SAR≠1: масштаб цели — DISPLAY-аспект (как файл выглядит при
  // воспроизведении), иначе исходник с квадратными пикселями исказился бы
  // под storage-пропорцию, а клип (генерился по display) — наоборот.
  const sarM = /SAR (\d+):(\d+) DAR (\d+):(\d+)/.exec(stderr)
  if (sarM) {
    const sarW = parseInt(sarM[1], 10)
    const sarH = parseInt(sarM[2], 10)
    if (sarW > 0 && sarH > 0 && sarW !== sarH) {
      const w = 2 * Math.round((width * sarW) / 2)
      const h = 2 * Math.round((height * sarH) / 2)
      if (w > 0 && h > 0) { width = w; height = h }
    }
  }

  const fpsM = /([\d.]+)\s*fps/.exec(stderr)
  const fps = fpsM ? parseFloat(fpsM[1]) : 24

  if (duration <= 0 || width <= 0 || height <= 0) return null
  return { duration, width, height, fps }
}