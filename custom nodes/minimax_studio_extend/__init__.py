"""MiniMax Studio: ноды бесшовного продления.

Проблема прежней схемы extend (SetLatentNoiseMask 0/1 на хвосте): маска
держит токены хвоста «чистыми» в траектории сэмплера, но DiT получает
один timestep на весь packed-латент и НЕ видит хвост как контекст —
для модели залоченная зона выглядит шумом. Новый контент генерируется
«вслепую» относительно головы → неплотное примыкание, двоения
(гостинг), накапливающиеся от клипа к клипу.

Решение — два якоря:

1. MiniMaxStudioExtendKeyframes — хвост-латент уходит в conditioning
   каналом minimax_keyframes (нативный keyframe-механизм H3, тот же,
   что во fl2va): PackedLayout пакует его строками cond с img_update=0
   (никогда не денойзится), модель видит его чистым на КАЖДОМ шаге.
   Аудио-хвост (плюс контекст до перекрытия) — тем же каналом.

2. MiniMaxStudioLatentLock — обёртка модели (model_function_wrapper):
   после каждого шага предсказание x0 в залоченных позициях принудительно
   заменяется чистым латентом хвоста. Замена out (предсказания), не x —
   шаг сэмплера сам приводит x к локу. Видео-маска SetLatentNoiseMask
   при этом не нужна (у H3Zero — единицы), аудио-маска остаётся: ядро
   превращает её в audio_denoise_mask conds («чистый timestep»).
"""

import math

import torch


def _pack(video, audio):
    v = video.reshape(video.shape[0], 1, -1)
    a = audio.reshape(audio.shape[0], 1, -1)
    return torch.cat([v, a], dim=-1)


def _unpack(x, shapes):
    vs, as_ = shapes
    n = math.prod(vs[1:])
    return (x[:, :, :n].reshape([x.shape[0]] + list(vs[1:])),
            x[:, :, n:].reshape([x.shape[0]] + list(as_[1:])))


class _LockWrapper:
    """model_function_wrapper: заменяет предсказанный x0 в залоченных зонах
    (перекрытие с предыдущим клипом) чистым латентом хвоста — точный порт
    LockWrapper."""

    def __init__(self, lock_v=None, w_v=None, lock_a=None, w_a=None):
        self.lock_v, self.w_v, self.lock_a, self.w_a = lock_v, w_v, lock_a, w_a

    def __call__(self, apply_model, args):
        x, t, c = args["input"], args["timestep"], args["c"]
        out = apply_model(x, t, **c)
        shapes = c.get("latent_shapes")
        if shapes is None or len(shapes) != 2 or (self.lock_v is None and self.lock_a is None):
            return out
        ov, oa = _unpack(out, shapes)
        ov, oa = ov.float(), oa.float()
        if self.lock_v is not None:
            w = self.w_v.to(ov.device).view(1, 1, -1, 1, 1)
            ov = ov * (1 - w) + self.lock_v.to(ov.device, ov.dtype) * w
        if self.lock_a is not None:
            w = self.w_a.to(oa.device)
            oa = oa * (1 - w) + self.lock_a.to(oa.device, oa.dtype) * w
        return _pack(ov.to(out.dtype), oa.to(out.dtype))


class MiniMaxStudioExtendKeyframes:
    """Добавить minimax_keyframes в conditioning клипа продления.

    Видео-латент хвоста ставится на resolved_frame_index=0 (хвост занимает
    начало клипа); аудио-латент контекста — на отрицательный кадр (звук
    «до» перекрытия, заканчивается на его границе). Ядро H3 пакует их
    cond-строками, которые не денойзятся и видны модели на каждом шаге.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"conditioning": ("CONDITIONING",)},
            "optional": {
                "video_latent": ("LATENT",),
                "video_frame": ("INT", {"default": 0, "min": -9999, "max": 9999}),
                "audio_latent": ("LATENT",),
                "audio_frame": ("INT", {"default": 0, "min": -9999, "max": 9999}),
            },
        }

    RETURN_TYPES = ("CONDITIONING",)
    FUNCTION = "append"
    CATEGORY = "MiniMax Studio"
    DESCRIPTION = "Anchor the previous clip's tail latent into conditioning via the native H3 keyframe channel."

    def append(self, conditioning, video_latent=None, video_frame=0, audio_latent=None, audio_frame=0):
        keyframes = []
        if video_latent is not None:
            keyframes.append({"resolved_frame_index": int(video_frame),
                              "latent": video_latent["samples"]})
        if audio_latent is not None:
            keyframes.append({"resolved_frame_index": int(audio_frame),
                              "audio_latent": audio_latent["samples"]})
        if not keyframes:
            return (conditioning,)
        out = []
        for t, d in conditioning:
            d = dict(d)
            d["minimax_keyframes"] = list(d.get("minimax_keyframes", [])) + keyframes
            out.append([t, d])
        return (out,)


class MiniMaxStudioLatentLock:
    """Обёртка модели: жёсткий лок перекрытия (пресечённый дрейф хвоста).

    Лок-тензоры — те же хвосты, что ушли в keyframes; веса — по числу
    залоченных temporal-токенов видео (T) и аудио-шагов (A) от начала.
    handoff_ramp: последние N аудио-шагов лок-зоны плавно отпускаются
    (0 = жёсткая граница).
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"model": ("MODEL",)},
            "optional": {
                "lock_video": ("LATENT",),
                "video_tokens_locked": ("INT", {"default": 0, "min": 0, "max": 4096}),
                "video_tokens_total": ("INT", {"default": 2, "min": 1, "max": 4096}),
                "lock_audio": ("LATENT",),
                "audio_steps_locked": ("INT", {"default": 0, "min": 0, "max": 65536}),
                "audio_steps_total": ("INT", {"default": 8, "min": 1, "max": 65536}),
                "handoff_ramp": ("INT", {"default": 0, "min": 0, "max": 4096}),
            },
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "lock"
    CATEGORY = "MiniMax Studio"
    DESCRIPTION = "Hard-lock the overlap region of an extension clip to the previous clip's tail latent."

    def lock(self, model, lock_video=None, video_tokens_locked=0, video_tokens_total=2,
             lock_audio=None, audio_steps_locked=0, audio_steps_total=8, handoff_ramp=0):
        lock_v = w_v = lock_a = w_a = None
        if lock_video is not None and video_tokens_locked > 0:
            T = max(int(video_tokens_total), int(video_tokens_locked))
            lock_v = lock_video["samples"].float()
            w_v = torch.zeros(T)
            w_v[:video_tokens_locked] = 1.0
        if lock_audio is not None and audio_steps_locked > 0:
            A = max(int(audio_steps_total), int(audio_steps_locked))
            lock_a = lock_audio["samples"].float()
            w_a = torch.zeros(A)
            w_a[:audio_steps_locked] = 1.0
            ramp = int(handoff_ramp)
            if ramp and audio_steps_locked > 2 * ramp:
                w_a[audio_steps_locked - ramp:audio_steps_locked] = \
                    1.0 - torch.arange(1, ramp + 1, dtype=torch.float32) / (ramp + 1)
        if lock_v is None and lock_a is None:
            return (model,)
        m = model.clone()
        m.set_model_unet_function_wrapper(_LockWrapper(lock_v, w_v, lock_a, w_a))
        return (m,)


NODE_CLASS_MAPPINGS = {
    "MiniMaxStudioExtendKeyframes": MiniMaxStudioExtendKeyframes,
    "MiniMaxStudioLatentLock": MiniMaxStudioLatentLock,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxStudioExtendKeyframes": "MiniMax Studio · Extend Keyframes",
    "MiniMaxStudioLatentLock": "MiniMax Studio · Extend Latent Lock",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
