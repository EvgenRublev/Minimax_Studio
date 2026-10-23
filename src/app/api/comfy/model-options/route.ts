import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/comfy/model-options?model_type=minimax_h3_ref2va
 * Returns H3 model options for the UI.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const modelType = searchParams.get('model_type') || ''

  if (!modelType.includes('minimax_h3')) {
    return NextResponse.json({}, { status: 404 })
  }

  return NextResponse.json({
    model_type: modelType,
    fps: 24,
    // Bounds of the H3 model: 60 = 2.5 s min, 719 = 17·42+5 ≈ 30 s max.
    // (правка 59) max повышен с 14.4 с (345) до 30 с — по факту модель
    // генерирует и 30-секундные ролики, реального жёсткого лимита 14.4 с нет.
    // (правка 55): min 124 — нижняя граница, backend сам поднимает ниже.
    // (правка 131) min снижен 124 → 42: минимум теперь ~2 с (42 кадра = 1.75 с
    // при 24 fps, ближайшее к 2 с значение на сетке 17n+5).
    // (правка 138) min повышен 42 → 60: минимум 2.5 с (60 кадров при 24 fps),
    // 1.75 с (42 кадра) полностью убрано из диапазона.
    frames_minimum: 60,
    frames_maximum: 719,
    frames_steps: 17,
    default_num_inference_steps: 4,
    turbo_available: true,
    // (правка 124) Значения = ТОЧНОЕ итоговое разрешение (короткая сторона
    // = качество, соотношение точное). Генерация идёт чуть крупнее (каждая
    // ось поднята до кратного 32), в конце — кроп ровно до этого номинала:
    // 16:9 1080p → генерация 1920×1088 → итог 1920×1080.
    resolution_presets: {
      '480p': {
        label: '480p',
        values: {
          '16:9': '854x480',
          '9:16': '480x854',
          '1:1': '480x480',
          '4:3': '640x480',
          '3:4': '480x640',
          '21:9': '1120x480',
        },
      },
      '720p': {
        label: '720p',
        values: {
          '16:9': '1280x720',
          '9:16': '720x1280',
          '1:1': '720x720',
          '4:3': '960x720',
          '3:4': '720x960',
          '21:9': '1680x720',
        },
      },
      '1080p': {
        label: '1080p',
        values: {
          '16:9': '1920x1080',
          '9:16': '1080x1920',
          '1:1': '1080x1080',
          '21:9': '2520x1080',
        },
      },
    },
    resolution_preset_order: ['480p', '720p', '1080p'],
    minimax_h3_text_encoder_choices: [
      { value: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', label: 'Qwen3VL 32B (рекомендуется)' },
    ],
    minimax_h3_text_encoder_default: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    omni_reference_limits: { image: 9, video: 3, audio: 3, total: 15 },
    omni_reference_detail_choices: [
      ['Соответствовать выходу (рекомендуется)', 'match'],
      ['Максимальная детализация', 'max'],
    ],
  }, {
    // Static stub data — safe for the browser to cache for the session
    headers: { 'Cache-Control': 'private, max-age=300' },
  })
}
