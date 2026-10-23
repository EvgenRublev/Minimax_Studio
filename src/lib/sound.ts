/**
 * Sound notification — короткий "ding" через Web Audio API.
 * Без внешних файлов, работает офлайн.
 */
let audioCtx: AudioContext | null = null

function getContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext()
  }
  if (audioCtx.state === 'suspended') {
    void audioCtx.resume()
  }
  return audioCtx
}

/**
 * Play a short two-tone "ding" notification sound.
 * Frequency: 880 Hz → 1320 Hz, each ~120ms, with exponential decay.
 */
export function playNotificationSound(): void {
  try {
    const ctx = getContext()
    const now = ctx.currentTime

    // Tone 1: 880 Hz (A5)
    const osc1 = ctx.createOscillator()
    const gain1 = ctx.createGain()
    osc1.type = 'sine'
    osc1.frequency.value = 880
    gain1.gain.setValueAtTime(0.3, now)
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.15)
    osc1.connect(gain1).connect(ctx.destination)
    osc1.start(now)
    osc1.stop(now + 0.15)

    // Tone 2: 1320 Hz (E6), starts 100ms later
    const osc2 = ctx.createOscillator()
    const gain2 = ctx.createGain()
    osc2.type = 'sine'
    osc2.frequency.value = 1320
    gain2.gain.setValueAtTime(0, now + 0.1)
    gain2.gain.linearRampToValueAtTime(0.25, now + 0.11)
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.3)
    osc2.connect(gain2).connect(ctx.destination)
    osc2.start(now + 0.1)
    osc2.stop(now + 0.3)
  } catch {
    /* AudioContext unavailable (e.g. autoplay policy) — ignore */
  }
}