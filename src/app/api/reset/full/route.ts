import { NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { getAppConfig, resetConfigToDefaults } from '@/lib/app-config'
import { resetLorasToDefaults } from '@/lib/loras-config'
import { writeExtraModelPathsYaml } from '@/lib/extra-model-paths'
import { clearInflight } from '@/lib/inflight-journal'
import { stopLlm } from '@/lib/llm-runner'
import { stopStt } from '@/lib/stt-runner'

export const dynamic = 'force-dynamic'

/**
 * POST /api/reset/full — полный сброс «как с завода» (серверная часть).
 *
 * (полный сброс) Удаляет ВСЁ, что создал пользователь:
 *   • ComfyUI/input          — референсы, кадры, загрузки
 *   • ComfyUI/output         — сгенерированные видео и .meta.json
 *   • ComfyUI/temp           — временные файлы ComfyUI
 *   • data/chat-attachments  — вложения чатов ассистента
 *   • data/upscale-*         — входы/выходы апскейла
 *   • upscale/outputs|jobs|logs — результаты и журналы апскейла
 *   • .local-input           — офлайн-загрузки
 *   • data/assistant-chats.json, data/inflight-generate.json — чаты и журнал задач
 *   • start_error.log        — лог запуска (может содержать текст промптов)
 *   • data/loras.json        — настройки LoRA → заводские
 *   • ComfyUI/extra_model_paths.yaml — внешние папки моделей → пусто
 *   • config/config.ini      — настройки → заводские
 *
 * Сами каталоги сохраняются (удаляется только содержимое), поэтому
 * ComfyUI и приложение продолжают работать без переустановки.
 * Модели, custom_nodes и код программы НЕ трогаются.
 *
 * Клиентская часть (localStorage, Zustand-сторы, очередь ComfyUI)
 * очищается в settings-dialog.tsx.
 */

/** Рекурсивно очищает содержимое каталога. Возвращает число удалённых элементов. */
async function cleanDirectory(dir: string): Promise<{ deleted: number; error?: string }> {
  try {
    await fs.stat(dir)
  } catch {
    return { deleted: 0 } // каталога нет — уже пусто
  }

  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (e) {
    return { deleted: 0, error: e instanceof Error ? e.message : String(e) }
  }

  let deleted = 0
  const failed: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      await fs.rm(full, { recursive: true, force: true })
      deleted++
    } catch (e) {
      failed.push(`${entry.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { deleted, error: failed.length ? failed.join('; ') : undefined }
}

/** Удаляет файл, если он есть. Возвращает 1 при удалении, иначе 0. */
async function removeFile(file: string): Promise<number> {
  try {
    await fs.unlink(file)
    return 1
  } catch {
    return 0
  }
}

export async function POST() {
  const cwd = process.cwd()
  // Конфиг читаем ДО сброса: пути input/output берутся из текущего backend,
  // а не из заводского (у пользователя может быть своя папка ComfyUI).
  const cfg = getAppConfig()

  // errors — то, из-за чего сброс нельзя считать полным (остались файлы);
  // warnings — некритичные сбои (сервис не остановился, YAML не переписался).
  const errors: string[] = []
  const warnings: string[] = []
  const details: Record<string, number> = {}
  let deleted = 0

  // 1) Останавливаем локальные модели, чтобы отпустили файлы и VRAM.
  //    Ошибки не фатальны: сброс данных важнее.
  try {
    await stopLlm()
  } catch (e) {
    warnings.push(`LLM: ${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    await stopStt()
  } catch (e) {
    warnings.push(`STT: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 2) Каталоги с пользовательским контентом.
  const dirs: Array<[string, string]> = [
    ['ComfyUI/input', cfg.inputDir],
    ['ComfyUI/output', cfg.outputDir],
    ['ComfyUI/temp', path.join(cfg.comfyRoot, 'ComfyUI', 'temp')],
    ['data/chat-attachments', path.join(cwd, 'data', 'chat-attachments')],
    ['data/upscale-input', path.join(cwd, 'data', 'upscale-input')],
    ['data/upscale-output', path.join(cwd, 'data', 'upscale-output')],
    ['upscale/outputs', path.join(cwd, 'upscale', 'outputs')],
    ['upscale/jobs', path.join(cwd, 'upscale', 'jobs')],
    ['upscale/logs', path.join(cwd, 'upscale', 'logs')],
    ['.local-input', path.join(cwd, '.local-input')],
  ]
  for (const [label, dir] of dirs) {
    const r = await cleanDirectory(dir)
    details[label] = r.deleted
    deleted += r.deleted
    if (r.error) errors.push(`${label}: ${r.error}`)
  }

  // 3) Файлы с пользовательскими данными.
  const files = [
    path.join(cwd, 'data', 'assistant-chats.json'),
    path.join(cwd, 'data', 'assistant-chats.json.tmp'),
    path.join(cwd, 'data', 'inflight-generate.json'),
    path.join(cwd, 'start_error.log'),
  ]
  for (const f of files) {
    deleted += await removeFile(f)
  }
  // Журнал inflight мог быть пересоздан параллельным запросом — чистим ещё раз.
  clearInflight()

  // 4) LoRA и внешние папки моделей → заводские (до сброса config.ini,
  //    чтобы пути брались из фактического backend).
  try {
    resetLorasToDefaults()
  } catch (e) {
    warnings.push(`LoRA: ${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    writeExtraModelPathsYaml([])
  } catch (e) {
    warnings.push(`extra_model_paths: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 5) Настройки → заводские.
  try {
    resetConfigToDefaults()
  } catch (e) {
    errors.push(`config.ini: ${e instanceof Error ? e.message : String(e)}`)
  }

  return NextResponse.json({
    ok: errors.length === 0,
    deleted,
    details,
    errors,
    warnings,
  })
}
