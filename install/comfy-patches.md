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
| `utils/extra_config.py` | принимает списки путей в `extra_model_paths.yaml` (студия пишет их списками) |

## Чего здесь больше нет (и почему)

На 0.33 мы также подменяли два файла ядра. В 0.44 всё, что они добавляли,
уже есть в upstream, а наши копии — это старый код, который затирал новое:

| Файл | Статус на 0.44 |
| --- | --- |
| `comfy/ldm/minimax/model.py` | **Не патчим.** В 0.44 уже есть `gate_compress` / `to_gate_compress` в `Attention`, `minimax_h3_layout` и `block_index` в `transformer_options`. Наша копия — база 0.33 без PDD-голов, malloc-graph, масок и `attention=`-хука |
| `comfy/model_detection.py` | **Не патчим.** `gate_compress` детектится upstream-ом. Наша копия удаляла бы поддержку FLUX.3, PDD (`pdd_steps`), Ming-Image и ID-V2V |

Проверено на тестовой сборке 0.44: Veda `tests/unit` — 112 passed, 1 skipped;
t2v + audio guide, ref2va и flf (2 прохода, 960x544) — успешно, всё на
стоковых `model.py` и `model_detection.py`.

Файлы — полные копии из рабочей установки, а не diff-патчи: так установка не
зависит от наличия `git`/`patch` на машине.

При обновлении ComfyUI эти файлы нужно перенести на новую базу и обновить
здесь; для 0.44 перенос уже сделан (`E:\ComfyUI_v044_test\merged\`).
