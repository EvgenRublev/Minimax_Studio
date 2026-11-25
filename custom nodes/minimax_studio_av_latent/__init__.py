"""MiniMax Studio (правка 372): сохранение/загрузка AV-латента H3 в файл.

Зачем: рефайн из mp4 заново кодирует видео через VAE — двойная потеря
(h264 + VAE roundtrip). Генерация (draft/full) сохраняет финальный AV-
латент сэмплера в output/<sub>/latents/<stem>.latent (stem совпадает с
mp4 — тот же filename_prefix/счётчик), а рефайн стартует с него
(LoadAVLatent вместо VHS_LoadVideo -> VAEEncode).

AV-латент H3 — {"samples": NestedTensor(video, audio)} (см.
LTXVConcatAVLatent/LTXVSeparateAVLatent в comfy_extras/nodes_lt.py).
Встроенные SaveLatent/LoadLatent (nodes.py) не подходят: они пишут один
тензор "latent_tensor" и не умеют nested AV-пары.

Формат файла: safetensors с тензорами video_samples и audio_samples +
JSON-шапка (fps, vae) в metadata. Расширение .latent.
"""

import json
import logging
import os

import safetensors.torch

import comfy.nested_tensor
import comfy.utils
import folder_paths

LOG = logging.getLogger(__name__)


class MiniMaxStudioSaveAVLatent:
    def __init__(self):
        self.output_dir = folder_paths.get_output_directory()

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "samples": ("LATENT",),
            "filename_prefix": ("STRING", {"default": "latents/Minimax_Studio"}),
            "vae_name": ("STRING", {"default": "minimax_h3_video_vae_int8_convrot.safetensors"}),
        }}

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("samples",)
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "MiniMax Studio"
    DESCRIPTION = "Save an H3 AV latent (video + audio) to a .latent file for lossless refine."

    def save(self, samples, filename_prefix="latents/Minimax_Studio", vae_name=""):
        streams = samples["samples"]
        if not streams.is_nested:
            raise ValueError("MiniMaxStudioSaveAVLatent: ожидается AV-латент (NestedTensor video+audio)")
        video_samples, audio_samples = streams.unbind()

        # (правка 1146) Валидность длины: H3-латент живёт на сетке 17k+5
        # кадров, т.е. T = 5m+2. Сохраняем как есть, но громко предупреждаем:
        # off-grid файл Refine/Tile отвергнут (resolveSourceLatent) и молча
        # уйдут в VAE-перекодирование mp4. Loop сюда не доходит (не сохраняет).
        try:
            t = int(video_samples.shape[2])
            frames = 5 + 17 * ((t - 2) // 5) if t >= 2 else 0
            if t < 2 or (t - 2) % 5 != 0:
                LOG.warning(
                    "SaveAVLatent: длина латента T=%s вне сетки 17k+5 (получилось бы %s кадров) — "
                    "lossless-рефайн отклонит файл", t, frames,
                )
            else:
                expected_audio = round(frames * 5 / 3)
                a = int(audio_samples.shape[-1])
                if abs(a - expected_audio) > 2:
                    LOG.warning(
                        "SaveAVLatent: аудио %s шагов при видео %s кадрах (ожидалось ~%s) — "
                        "A/V могут разъехаться", a, frames, expected_audio,
                    )
        except Exception:
            pass

        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, self.output_dir)
        file = f"{filename}_{counter:05}_.latent"
        path = os.path.join(full_output_folder, file)

        metadata = {"minimax_av_latent": json.dumps({"fps": 24, "vae": vae_name, "version": 1})}
        comfy.utils.save_torch_file(
            {"video_samples": video_samples.contiguous(), "audio_samples": audio_samples.contiguous()},
            path, metadata=metadata)
        return {"ui": {"latents": [{"filename": file, "subfolder": subfolder, "type": "output"}]},
                "result": (samples,)}


class MiniMaxStudioLoadAVLatent:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            # Путь относительно output/ ComfyUI, напр. "latents/Minimax_Studio_00001_.latent"
            # (workflow собирается сервером студии, виджет-список не нужен).
            "latent": ("STRING", {"default": ""}),
        }}

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "load"
    CATEGORY = "MiniMax Studio"
    DESCRIPTION = "Load an H3 AV latent saved by MiniMaxStudioSaveAVLatent (path relative to output/)."

    def _resolve(self, latent):
        root = os.path.realpath(folder_paths.get_output_directory())
        path = os.path.realpath(os.path.join(root, latent))
        if path != root and not path.startswith(root + os.sep):
            raise ValueError("MiniMaxStudioLoadAVLatent: путь вне output/: {}".format(latent))
        if not os.path.isfile(path):
            raise FileNotFoundError("MiniMaxStudioLoadAVLatent: файл не найден: {}".format(latent))
        return path

    def load(self, latent):
        tensors = safetensors.torch.load_file(self._resolve(latent), device="cpu")
        return ({"samples": comfy.nested_tensor.NestedTensor(
            (tensors["video_samples"], tensors["audio_samples"]))},)

    @classmethod
    def IS_CHANGED(cls, latent):
        path = os.path.realpath(os.path.join(folder_paths.get_output_directory(), latent))
        return os.path.getmtime(path) if os.path.isfile(path) else float("nan")


NODE_CLASS_MAPPINGS = {
    "MiniMaxStudioSaveAVLatent": MiniMaxStudioSaveAVLatent,
    "MiniMaxStudioLoadAVLatent": MiniMaxStudioLoadAVLatent,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxStudioSaveAVLatent": "Save AV Latent (Minimax Studio)",
    "MiniMaxStudioLoadAVLatent": "Load AV Latent (Minimax Studio)",
}
