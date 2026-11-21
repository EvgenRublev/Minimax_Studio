Патчи ядра ComfyUI 0.33.x — откатная ветка бэкенда (comfy-aimdo 0.4.13).

Набор генерируется скриптом scripts/make-core-patches-033.mjs, руками его
править нельзя: при следующем запуске скрипта правки потеряются.

Отличия от набора comfy-patches (ядро 0.44+):
  • main.py — тот же патч 967, но поверх 0.33;
  • comfy/audio.py — в 0.33 модуля нет вовсе, его зовёт наш патч нод;
  • comfy/model_prefetch.py — версия 0.33 + shim pause_malloc_graph;
  • utils/extra_config.py — из набора 0.44: понимает и строки, и списки
    путей (студия пишет списки, штатный 0.33 падал на них при старте);
  • comfy/ldm/minimax/* и comfy/context_windows.py не подменяются: 0.44-версии
    тянут ComfyAttention из 0.44, а в файлах 0.33 есть всё нужное
    (FRAME_PER_TOKEN, FRAME_RESCALE, IMAGENET_MEAN, ContextSchedules,
    ContextFuseMethods).
