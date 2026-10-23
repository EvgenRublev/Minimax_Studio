'use client'

/**
 * (правка 65) useVoiceDictation — запись микрофона и расшифровка через
 * STT-сервис (transcribe.cpp) на CPU (tools/stt_server.py).
 *
 * Цепочка: getUserMedia → AudioContext (16 кГц, если браузер поддерживает)
 * → ScriptProcessorNode (захват) → 16-битный PCM WAV (собирается в JS,
 * без внешних зависимостей) → POST /api/stt/transcribe → текст.
 *
 * (правка 85) Выбор микрофона: selectedMicId хранится на уровне модуля
 * (общая переменная для всех инстансов хука на странице). Устанавливается
 * через setSttMicDevice() из панели настроек, сохраняется в localStorage.
 */
import { useCallback, useRef, useState } from 'react'

export type VoiceDictationState = 'idle' | 'recording' | 'processing'

export interface VoiceDictationResult {
  /** Распознанный текст (null при ошибке или пустом результате). */
  text: string | null
  /** Текст ошибки на русском (null при успехе). */
  error: string | null
}

export interface VoiceDictationApi {
  state: VoiceDictationState
  /** Начать запись. Бросает Error с русским текстом при неудаче. */
  start: () => Promise<void>
  /** Остановить запись и вернуть результат: текст и/или ошибку.
   *  Ошибку возвращаем значением, а не только через `error` стейта —
   *  замыкание в обработчике клика не видит стейт, установленный
   *  внутри этого вызова (stale closure). */
  stop: () => Promise<VoiceDictationResult>
  /** Отменить запись без расшифровки. */
  cancel: () => void
  error: string | null
  clearError: () => void
}

const TARGET_RATE = 16000

/* ── (правка 85) Выбранный микрофон (общий для всех инстансов хука) ──
   undefined = ещё не читали из localStorage
   null      = системный микрофон по умолчанию
   string    = конкретный deviceId                               */
let _selectedMicId: string | null | undefined = undefined
const LS_KEY = 'stt.micDeviceId'

function _readStoredMic(): string | null {
  if (typeof window === 'undefined') return null
  try { return localStorage.getItem(LS_KEY) } catch { return null }
}

/** Установить deviceId микрофона (null = системный по умолчанию). */
export function setSttMicDevice(id: string | null): void {
  _selectedMicId = id
  try {
    if (id) localStorage.setItem(LS_KEY, id)
    else localStorage.removeItem(LS_KEY)
  } catch { /* private mode / SSR */ }
}

/** Получить deviceId выбранного микрофона (null = по умолчанию). */
export function getSttMicDevice(): string | null {
  if (_selectedMicId === undefined) {
    _selectedMicId = _readStoredMic()
  }
  return _selectedMicId
}

/** Линейная ресемплинг до 16 кГц (вход — любой sampleRate). */
function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const outLen = Math.max(0, Math.floor(input.length / ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = pos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

/** 44-байтовый WAV-заголовок + 16-бит PCM mono @16 кГц. */
function buildWav16(samples: Float32Array): ArrayBuffer {
  const n = samples.length
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  v.setUint32(4, 36 + n * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  v.setUint32(16, 16, true)          // fmt chunk size
  v.setUint16(20, 1, true)           // PCM
  v.setUint16(22, 1, true)           // mono
  v.setUint32(24, TARGET_RATE, true) // sample rate
  v.setUint32(28, TARGET_RATE * 2, true) // byte rate
  v.setUint16(32, 2, true)           // block align
  v.setUint16(34, 16, true)          // bits per sample
  writeStr(36, 'data')
  v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    let s = samples[i]
    if (s > 1) s = 1
    else if (s < -1) s = -1
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buf
}

export function useVoiceDictation(): VoiceDictationApi {
  const [state, setState] = useState<VoiceDictationState>('idle')
  const [error, setError] = useState<string | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const procRef = useRef<ScriptProcessorNode | null>(null)
  const chunksRef = useRef<Float32Array[]>([])
  const rateRef = useRef(TARGET_RATE)
  const startingRef = useRef(false)

  const teardown = useCallback(() => {
    try { procRef.current?.disconnect() } catch { /* уже отключён */ }
    procRef.current = null
    try { void ctxRef.current?.close() } catch { /* уже закрыт */ }
    ctxRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  const start = useCallback(async () => {
    if (startingRef.current) return
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Голосовой ввод недоступен: браузер не даёт доступа к микрофону')
    }
    startingRef.current = true
    setError(null)
    try {
      // (правка 85) Если выбран конкретный микрофон — указываем deviceId.
      // Используем `ideal`, а не `exact`: если устройство отключено,
      // браузер gracefully fallback-нёт на другой, а не упадёт с ошибкой.
      const micId = getSttMicDevice()
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
      if (micId) {
        audioConstraints.deviceId = { ideal: micId }
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
      streamRef.current = stream
      let ctx: AudioContext
      try {
        ctx = new AudioContext({ sampleRate: TARGET_RATE })
      } catch {
        ctx = new AudioContext() // fallback: ресемплинг сделаем сами
      }
      ctxRef.current = ctx
      rateRef.current = ctx.sampleRate
      const source = ctx.createMediaStreamSource(stream)
      const proc = ctx.createScriptProcessor(4096, 1, 1)
      chunksRef.current = []
      proc.onaudioprocess = (e) => {
        const ch = e.inputBuffer.getChannelData(0)
        chunksRef.current.push(new Float32Array(ch))
      }
      // Замкнутый затухающий контур: onaudioprocess обязан «звучать»,
      // поэтому шлём в заземлённый gain (в динамиках ничего не слышно).
      const mute = ctx.createGain()
      mute.gain.value = 0
      source.connect(proc)
      proc.connect(mute)
      mute.connect(ctx.destination)
      procRef.current = proc
      setState('recording')
    } catch (err) {
      teardown()
      const name = (err as { name?: string } | null)?.name
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new Error('Доступ к микрофону запрещён — разрешите микрофон в настройках браузера для этого сайта')
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        throw new Error('Микрофон не найден — подключите устройство ввода')
      }
      throw err instanceof Error ? err : new Error(String(err))
    } finally {
      startingRef.current = false
    }
  }, [teardown])

  const stop = useCallback(async (): Promise<VoiceDictationResult> => {
    const chunks = chunksRef.current
    const rate = rateRef.current
    chunksRef.current = []
    teardown()

    if (chunks.length === 0) {
      setState('idle')
      return { text: null, error: null }
    }
    let total = 0
    for (const c of chunks) total += c.length
    let samples: Float32Array = new Float32Array(total)
    let off = 0
    for (const c of chunks) {
      samples.set(c, off)
      off += c.length
    }
    samples = resampleLinear(samples, rate, TARGET_RATE)

    setState('processing')
    try {
      const r = await fetch('/api/stt/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buildWav16(samples),
      })
      const data: { ok?: boolean; text?: string; error?: string } = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) {
        const err = data.error || 'Не удалось распознать речь (сервис STT недоступен)'
        setError(err)
        setState('idle')
        return { text: null, error: err }
      }
      const text = String(data.text ?? '').trim()
      setState('idle')
      if (!text) {
        const err = 'Ничего не распознано — попробуйте говорить чётче или ближе к микрофону'
        setError(err)
        return { text: null, error: err }
      }
      return { text, error: null }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const e = msg || 'Не удалось распознать речь'
      setError(e)
      setState('idle')
      return { text: null, error: e }
    }
  }, [teardown])

  const cancel = useCallback(() => {
    chunksRef.current = []
    teardown()
    setState('idle')
    setError(null)
  }, [teardown])

  const clearError = useCallback(() => setError(null), [])

  return { state, start, stop, cancel, error, clearError }
}