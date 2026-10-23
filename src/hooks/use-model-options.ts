'use client'

import { useState, useEffect } from 'react'

/**
 * Subset of WanGP GET /api/v1/model-options/{model_type} used by the UI.
 * Mirrors the backend response in launch.py:get_model_options().
 */
export interface ModelOptions {
  model_type: string
  architecture: string
  fps: number
  frames_minimum: number
  frames_steps: number
  frames_maximum: number | null
  /** Frame count must satisfy `steps*n + remainder`. */
  frameAlignment?: { modulus: number; remainder: number }
  omni_reference: boolean
  omni_reference_limits?: { image: number; video: number; audio: number; total: number } | null
  omni_reference_detail_choices?: Array<[string, string]> | null
  omni_reference_detail_default?: string
  minimax_h3_text_encoder_choices?:
    | Array<{ value: string; label: string; size_hint?: string; recommended?: boolean }>
    | null
  minimax_h3_text_encoder_default?: string | null
  minimax_h3_turbo?: {
    filename: string
    label?: string
    steps?: number
    weight?: number
    experimental?: boolean
    guide?: string
  } | null
  minimax_h3_runtime_advisory?: string | null
  resolution_presets?: Record<string, unknown> | null
  resolution_preset_order?: string[] | null
  supports_auto_aspect?: boolean
  no_negative_prompt?: boolean
  i2v_class?: boolean
  t2v_class?: boolean
  returns_audio?: boolean
  supports_end_frame?: boolean
  default_num_inference_steps?: number | null
  default_guidance_scale?: number | null
  [key: string]: unknown
}

interface UseModelOptionsResult {
  options: ModelOptions | null
  loading: boolean
  error: string | null
}

/**
 * Fetches UI-relevant options for a model (resolutions, encoder variants,
 * turbo preset, reference limits, frame ranges, defaults) from WanGP.
 * Refetches whenever modelType changes; empty modelType → idle.
 */
export function useModelOptions(modelType: string | null | undefined): UseModelOptionsResult {
  const [options, setOptions] = useState<ModelOptions | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!modelType) {
      setOptions(null)
      setError(null)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    fetch(`/api/comfy/model-options?model_type=${encodeURIComponent(modelType)}`)
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.detail || `HTTP ${res.status}`)
        }
        return res.json() as Promise<ModelOptions>
      })
      .then((data) => {
        if (!cancelled) setOptions(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setOptions(null)
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [modelType])

  return { options, loading, error }
}
