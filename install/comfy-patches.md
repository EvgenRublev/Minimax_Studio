# Патчи ядра ComfyUI

Файлы из папки `comfy-patches/` копируются установщиком поверх скачанного
ComfyUI при каждом запуске (шаг 4, идемпотентно).

Базовая сборка: **ComfyUI 0.44.0** (тег `v0.44.0`), перешли с 0.33.0
(коммит `5f0c4e18cb7e98f0e7c46c2c7ce928d641351e67`).

| Файл | Что меняет |
| --- | --- |
| `comfy_extras/nodes_minimax_h3.py` | Наши правки поверх файла 0.44: второй выход `latent` у `MiniMaxH3AddGuide` и сидинг гайд-аудио в аудио-стрим латента с AV-маской 0 (правка 888); ноды `MiniMaxH3AudioOrSilent` и `MiniMaxH3AudioSliceFrom` (правки 313/885); flf-фикс keyframe-латентов при смене разрешения (правки 146/149); `first_frame` через cover-crop `center` (правка 154); сохранение aspect ratio референсов (правка 693) |
| `comfy/ldm/minimax/vae.py` | `MiniMaxH3ImageVAE` — официальный image-VAE Comfy-Org (16 голов, 2D-rope, 2D `post_quant_conv`); в 0.44 его не было, и файл грузился как `PH3ImageVAE` с падением на `size mismatch` (правка 946) |
| `comfy/sd.py` | загрузчик различает image-VAE по ширине `decoder.x_embedder`: 1024 — официальный, 2048 — p-h3-image (правка 946) |
| `comfy/ldm/minimax/model.py` | `MiniMaxH3ImageModel` — H3 DiT без аудио-потока (один кадр-латент), необязательный `audio_patch_proj`, PDD-сетка `pdd_grid`; часть `MiniMaxH3ImageModelSampling` лежит здесь же, а не отдельным `sampling.py`, иначе патч добавлял бы новый файл ядра (правка 949) |
| `comfy/model_base.py` | `MiniMaxH3Image` — `ModelType.FLOW` и собственная `MiniMaxH3ImageModelSampling`; `latent_shapes` не уезжает в однопоточную модель (правка 949) |
| `comfy/supported_models.py` | класс `MiniMaxH3Image` (латент-формат `MiniMaxH3Video`) и его регистрация в списке моделей (правка 949) |
| `comfy/model_detection.py` | image-чекпоинт определяется по отсутствию `audio_patch_proj` → `minimax_h3_image` (правка 949) |
| `utils/extra_config.py` | принимает списки путей в `extra_model_paths.yaml` (студия пишет их списками) |

## Чего здесь больше нет (и почему)

На 0.33 мы подменяли `comfy/ldm/minimax/model.py` и
`comfy/model_detection.py` целыми копиями старой базы, и это затирало новое из
0.44 (PDD-головы, malloc-graph, `gate_compress`, FLUX.3, Ming-Image, ID-V2V).
Теперь оба файла снова в патчах, но по другой причине: официальная
**MiniMax-H3-Image** появилась в upstream позже 0.44.0, и без этих трёх правок
ядро не распознаёт её чекпоинт (`ERROR: Could not detect model type of`).
Правки точечные и поверх текущего 0.44, а не поверх базы 0.33.

Файлы — полные копии из рабочей установки, а не diff-патчи: так установка не
зависит от наличия `git`/`patch` на машине.

При обновлении ComfyUI эти файлы нужно перенести на новую базу и обновить
здесь; для 0.44 перенос уже сделан (`E:\ComfyUI_v044_test\merged\`).
