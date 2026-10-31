# Самописные ноды MiniMax Studio

Копии кастомных нод студии, чтобы их можно было поставить в другой ComfyUI.
Установка: скопировать папки целиком в `<ComfyUI>/custom_nodes/` и перезапустить
ComfyUI. Ничего дополнительно настраивать не нужно — ноды появляются в меню
добавления нод, все они в категории **MiniMax Studio**, кроме sparse attention.

| Папка | Ноды | Что делают |
| --- | --- | --- |
| `minimax_studio_av_latent` | `Save AV Latent` / `Load AV Latent` (Minimax Studio) | Сохраняют и читают AV-латент H3 (`{"samples": NestedTensor(video, audio)}`) в `output/<sub>/latents/<stem>.latent` (safetensors + JSON-шапка). Нужны, чтобы Refine стартовал с латента сэмплера, а не пересжимал mp4 через VAE. Путь `Load` — относительно `output/`. |
| `minimax_studio_audio_trim` | `Audio Trim` / `Audio Gain` (Minimax Studio) | Обрезают и усиливают аудио-референс прямо в тензоре, не создавая копий файла в `input/`. `end_seconds = 0` — до конца файла. |
| `minimax_studio_extend` | `Extend Keyframes` / `Extend Latent Lock` (MiniMax Studio) | Бесшовное продление: `ExtendKeyframes` кладёт хвост-латент предыдущего клипа в conditioning нативным keyframe-каналом H3 (видео — на кадр 0, аудио-контекст — на отрицательный кадр); `LatentLock` — модель-обёртка, жёстко фиксирующая предсказание в зоне перекрытия (замена video-SetLatentNoiseMask; аудио-маска остаётся). Чистый torch + comfy API, зависимостей нет. |
| `MiniMaxSparseAttn` | `Model Sparse Attention (Sol-Attn)` | Sol-Attn (training-free разреженное внимание) для H3 на этой сборке ComfyUI: патчит модель через `optimized_attention_override`, короткие последовательности остаются dense, без ядра — автоматический откат в dense. |

Зависимости:

- `minimax_studio_av_latent` — только `safetensors` (уже есть в ComfyUI);
- `minimax_studio_audio_trim` — ничего, чистый torch;
- `minimax_studio_extend` — ничего, чистый torch + `comfy.nested_tensor`;
- `MiniMaxSparseAttn` — `comfy_kitchen` с `sol_attn` (в этой сборке есть). На
  другом ComfyUI без него нода просто не патчит модель — генерация идёт dense.

## Оверрайд чужой ноды: `ComfyUI-Frame-Interpolation`

Это НЕ самописная нода, а частичная копия GitHub-ноды
`Fannovel16/ComfyUI-Frame-Interpolation` (pin в `install/nodes.json`).
Установщик скачивает оригинальный зип (шаг 6), а папки из `custom nodes/`
копируются ПОСЛЕГО и перекрывают одноимённые файлы. Здесь лежат только
изменённые файлы:

| Файл | Правка |
| --- | --- |
| `vfi_utils.py` | зеркала для RIFE-чекпоинтов (`CKPT_FALLBACK_URLS`); «Opt 7» — пакетная обработка пар кадров + параметр `batch_size`; **чекпоинты прерывания** `throw_exception_if_processing_interrupted()` в циклах кадров — без них «Отмена» не останавливала RIFE/прочие VFI до конца узла |
| `vfi_models/film/film_arch.py` | eager-версия FILM с явными padding-слоями (`SamePadConv`) вместо TorchScript-графa |
| `vfi_models/film/__init__.py` | загрузка eager-модели (`_load_film_eager`); **чекпоинты прерывания** в собственном цикле FILM (правка 786) —FILM не использует `generic_frame_loop`, и «Стоп» на вкладке FPS его не останавливал |

При смене sha в `install/nodes.json` эти три файла нужно сверить с новой
версией ноды и перенести правки заново.

Подробности по каждой ноде — в шапке её `__init__.py`.
