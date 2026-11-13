import { NextResponse } from 'next/server'
import { resetLorasToDefaults } from '@/lib/loras-config'
import { useTranslation } from 'react-i18next' // (правка 955)

/**
 * POST /api/loras/reset — (правка 130) Заводской сброс настроек LoRA.
 *
 * Все лоры выключаются (enabled=false), сила сбрасывается к 1.0,
 * триггеры очищаются. Файл data/loras.json перезаписывается «чистым»
 * состоянием. Вызывается из «Заводской сброс» в настройках.
 */
export async function POST() {
  const { t: st } = useTranslation() // (правка 955)

  try {
    const defaults = resetLorasToDefaults()
    return NextResponse.json({
      ok: true,
      count: defaults.length,
      message: st("Настройки LoRA сброшены (лоров: {{p1}})", { p1: defaults.length }),
    })
  } catch (e) {
    console.error('[loras/reset] error:', e)
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : st("Ошибка сброса LoRA") },
      { status: 500 },
    )
  }
}
