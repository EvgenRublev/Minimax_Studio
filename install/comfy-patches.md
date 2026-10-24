# Патчи ядра ComfyUI

Файлы из папки `comfy-patches/` копируются установщиком поверх скачанного
ComfyUI при каждом запуске (шаг 4, идемпотентно).

Базовая сборка: коммит
`5f0c4e18cb7e98f0e7c46c2c7ce928d641351e67` (25.08.2026, `__version__ = "0.33.0"`).

| Файл | Что меняет |
| --- | --- |
| `comfy/ldm/minimax/model.py` | `to_gate_compress` в `Attention` (веса VSA), `minimax_h3_layout` и `block_index` в `transformer_options` для Veda sparse attention |
| `comfy/model_detection.py` | определяет `gate_compress` в VSA-чекпоинтах |
| `comfy_extras/nodes_minimax_h3.py` | keyframe-latent: пересчёт latent'ов при переключении разрешения (правки 146/149) |
| `utils/extra_config.py` | принимает списки путей в `extra_model_paths.yaml` (студия пишет их списками) |

Файлы — полные копии из рабочей установки, а не diff-патчи: так установка не
зависит от наличия `git`/`patch` на машине.

При обновлении ComfyUI эти файлы нужно перенести на новую базу и обновить здесь.
