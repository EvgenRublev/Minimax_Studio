# Самописные ноды MiniMax Studio

Копии кастомных нод студии, чтобы их можно было поставить в другой ComfyUI.
Установка: скопировать папки целиком в `<ComfyUI>/custom_nodes/` и перезапустить
ComfyUI. Ничего дополнительно настраивать не нужно — ноды появляются в меню
добавления нод, все они в категории **MiniMax Studio**, кроме sparse attention.

| Папка | Ноды | Что делают |
| --- | --- | --- |
| `minimax_studio_av_latent` | `Save AV Latent` / `Load AV Latent` (Minimax Studio) | Сохраняют и читают AV-латент H3 (`{"samples": NestedTensor(video, audio)}`) в `output/<sub>/latents/<stem>.latent` (safetensors + JSON-шапка). Нужны, чтобы Refine стартовал с латента сэмплера, а не пересжимал mp4 через VAE. Путь `Load` — относительно `output/`. |
| `minimax_studio_audio_trim` | `Audio Trim` / `Audio Gain` (Minimax Studio) | Обрезают и усиливают аудио-референс прямо в тензоре, не создавая копий файла в `input/`. `end_seconds = 0` — до конца файла. |
| `MiniMaxSparseAttn` | `Model Sparse Attention (Sol-Attn)` | Sol-Attn (training-free разреженное внимание) для H3 на этой сборке ComfyUI: патчит модель через `optimized_attention_override`, короткие последовательности остаются dense, без ядра — автоматический откат в dense. |

Зависимости:

- `minimax_studio_av_latent` — только `safetensors` (уже есть в ComfyUI);
- `minimax_studio_audio_trim` — ничего, чистый torch;
- `MiniMaxSparseAttn` — `comfy_kitchen` с `sol_attn` (в этой сборке есть). На
  другом ComfyUI без него нода просто не патчит модель — генерация идёт dense.

Подробности по каждой ноде — в шапке её `__init__.py`.
