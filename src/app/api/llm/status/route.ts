import { NextResponse } from 'next/server'
import { llmStatus, activeLlmModelId, llmModelPath, llmBackend, llmBonsaiPaths } from '@/lib/llm-runner'
import { llmStreaming, comfyBusy, assertGenerationAllowed } from '@/lib/vram-arbiter'
import { existsSync, statSync } from 'fs'
import { basename } from 'path'

export const dynamic = 'force-dynamic'

/** (правка 258) comfyBusy() — сетевой запрос к ComfyUI (таймаут до 4 с);
 *  каждый полл /api/llm/status платил эту цену и висел при недоступном
 *  ComfyUI. Кэшируем результат на 3 с: для UI-поллинга свежести достаточно,
 *  а стоимость и hang устранены. */
let busyCache: { at: number; busy: boolean } | null = null
async function comfyBusyCached(): Promise<boolean> {
  if (busyCache && Date.now() - busyCache.at < 3000) return busyCache.busy
  const busy = await comfyBusy()
  busyCache = { at: Date.now(), busy }
  return busy
}

/** GET /api/llm/status — runner state + model presence (for the chat tab). */
export async function GET() {
  const s = llmStatus()
  const backend = llmBackend()
  // (правка 136) Для Bonsai «модель» — GGUF во внешней папке сборки.
  const modelFile = backend === 'bonsai' ? llmBonsaiPaths().model : llmModelPath()
  let modelBytes = 0
  try {
    modelBytes = statSync(modelFile).size
  } catch {
    modelBytes = 0
  }
  // (правка 257) У своей модели порог меньше (лёгкие кванты < 100 МБ легальны)
  const minBytes = backend === 'custom' ? 1_000_000 : 100_000_000
  return NextResponse.json({
    ...s,
    // Ассистент сейчас стримит ответ (блокировка генерации)
    streaming: llmStreaming(),
    // Ассистент занят: грузит модель (chatActive) ИЛИ пишет ответ —
    // именно это состояние должно блокировать кнопку генерации в UI
    assistantBusy: assertGenerationAllowed() !== null,
    // Идёт генерация видео — блокировка чата в UI
    blockedByGeneration: await comfyBusyCached(),
    modelId: activeLlmModelId(),
    // (правка 257) Имя файла модели — для подписей UI (своя модель)
    modelName: basename(modelFile),
    modelBytes,
    modelReady: s.modelExists && modelBytes > minBytes,
    // Cheap existence check that also works before any spawn
    fileExists: existsSync(modelFile),
  })
}
