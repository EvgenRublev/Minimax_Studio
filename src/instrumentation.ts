/**
 * (правка 722) Старт сервера.
 *
 * Переписываем ComfyUI/extra_model_paths.yaml до запуска бэкенда: в нём студия
 * регистрирует свою папку детекторов Face Refine (models/ultralytics → категория
 * `ultralytics`). ComfyUI читает файл при импорте, поэтому к моменту сборки
 * /object_info категория уже есть — и в комбо H3FaceTrackCrop появляется
 * модель человека для fallback_detector.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  try {
    const { syncExtraModelPathsYaml } = await import('./lib/extra-model-paths')
    syncExtraModelPathsYaml()
  } catch (e) {
    console.error('[startup] extra_model_paths.yaml:', e instanceof Error ? e.message : e)
  }
}
