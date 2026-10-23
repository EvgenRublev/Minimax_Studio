import { NextRequest, NextResponse } from 'next/server'
import { writeMetaSidecar, clearPendingMeta } from '@/lib/pending-meta'
import { readDraftPrompt } from '@/lib/refine-meta'

/**
 * POST /api/comfy/metadata
 * Body: { filename, subfolder, params: {...} }
 * Client fast path: saves a .meta.json sidecar next to the output file.
 * The server-side pending copy is cleared for this job so it never
 * overwrites the fresher client data.
 *
 * GET /api/comfy/metadata?filename=&subfolder=
 * Читает сайдкар вывода и возвращает промпт драфта, зачищенный для
 * refine-conditioning (без аудио-секций и тегов-референсов). Префилл
 * Caption вкладки «Refine» убран (промпт/референсы резолвит сервер
 * /api/comfy/refine через readDraftSource) — endpoint остаётся как
 * утилита чтения сайдкара.
 */
export const dynamic = 'force-dynamic'

interface MetadataBody {
  filename: string
  subfolder?: string
  params: Record<string, unknown>
}

export async function GET(req: NextRequest) {
  const filename = req.nextUrl.searchParams.get('filename') || ''
  const subfolder = req.nextUrl.searchParams.get('subfolder') || ''
  if (!filename) {
    return NextResponse.json({ error: 'filename is required' }, { status: 400 })
  }
  const prompt = readDraftPrompt(subfolder, filename)
  return NextResponse.json({ exists: prompt !== null, prompt })
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as MetadataBody

    if (!body.filename || !body.params) {
      return NextResponse.json({ error: 'filename and params are required' }, { status: 400 })
    }

    // (правка 722) СЛИЯНИЕ, а не перезапись: серверный писатель (pending-meta)
    // уже мог записать свой набор полей в этот же сайдкар — реально
    // применённые кастомные LoRA (`lora`), output_subfolder, flf_resolution и
    // т.д. Клиент о них не знает, и полная перезапись их вычёркивала
    // («метаданные записываются не все и не везде»). Новые поля перетирают
    // старые, незнакомые старые — сохраняются.
    const metaFile = writeMetaSidecar(body.filename, body.subfolder || '', body.params, { merge: true })
    if (!metaFile) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
    }

    // Drop the server-side pending copy (client data wins)
    if (typeof body.params.job_id === 'string') {
      clearPendingMeta(body.params.job_id)
    }

    return NextResponse.json({ ok: true, path: metaFile })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to save metadata' },
      { status: 500 },
    )
  }
}
