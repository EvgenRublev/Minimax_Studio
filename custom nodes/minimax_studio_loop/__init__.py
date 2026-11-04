"""MiniMax Studio (правка 745): режим «Зациклено» — бесшовный цикл H3.

Проблема: H3 генерирует клип 17k+5 кадров как обычное видео — первый и
последний кадр никак не связаны. Склейка «конец → начало» даёт рывок в
картинке и щелчок/обрыв в звуке.

Решение — круговой латент-паддинг. Сэмплер видит латент, у которого по
краям добавлены клипы, «обёрнутые» с другого конца цикла. Поэтому стык
конец→начало денойзится ровно как любая другая граница клипов, а края
последовательности попадают в контекст, который потом выбрасывается.

  • MiniMaxStudioLoop — патч модели (DIFFUSION_MODEL wrapper): по краям
    латента добавляются pad_clips клипов с другого конца; денойз идёт по
    расширенной последовательности, из предсказания вырезается один цикл.
  • MiniMaxStudioLoopDecode — декод: VAE получает тот же латент с
    обёрнутым контекстом с двух сторон и отдаёт ровно один цикл кадров и
    звука (иначе декодер «видит» жёсткий край на месте стыка).

Геометрия латента H3 (17 кадров ↔ 5 латентов, хвост 5 кадров ↔ 2 латента):
клип = 17 кадров = 5 видео-латентов, 17k+5 кадров = 5k+2 латента.
Аудио — 40 латентов/с при 24 fps → 17k кадров = round(k*17*40/24).

Почему views=2: H3 рядом с дублированным контекстом портит звук (на стыке
громче в 3–10 раз / «каша»). Второй проход со сдвигом на полцикла даёт
каждой аудио-позиции предсказание из того вида, где она дальше всего от
точки склейки. Картинка остаётся с первого вида: два вида могут «разъехаться»
по направлению движения и развернуть его в середине цикла. Время сэмплинга
растёт примерно вдвое (каждый вид — отдельный проход по расширенному латенту).

Длина латента задаётся как обычно (17k+5 кадров: 107, 158, 209, 260, 311,
328 …), цикл — 17k кадров (length − 5). При pad_clips=1 длина больше 328
кадров уже после паддинга выходит за обученный диапазон H3 (362 кадра).
"""

import logging

import torch

import comfy.patcher_extension
import comfy.utils
from comfy_extras.nodes_audio import vae_decode_audio

# 17 кадров ↔ 5 видео-латентов; хвост 5 кадров ↔ 2 латента
CLIP_LATENTS = 5
VIDEO_TAIL = 2
AUDIO_PER_CLIP = 17 * 40 / 24  # аудио-латентов (40/с) на клип 17 кадров (24 fps)

LOG = logging.getLogger(__name__)


def audio_span(clips):
    """Сколько аудио-латентов занимает `clips` клипов."""
    return round(clips * AUDIO_PER_CLIP)


def wrap_pad(x, before, after, dim):
    """Периодическое продолжение x по оси dim на before/after элементов.

    x считается бесконечным повтором самого себя: добавляем перед началом
    `before` элементов, после конца — `after`. Если паддинг длиннее самого
    цикла, x повторяется столько раз, сколько нужно.
    """
    n = x.shape[dim]
    if n == 0:
        raise ValueError(
            "MiniMax H3 Loop: нужна длина не меньше 22 кадров "
            "(один клип 17 кадров + хвост 5 кадров)")
    lead = -(-before // n)  # ceil(before / n)
    reps = lead + 1 + -(-after // n)
    return torch.cat([x] * reps, dim=dim).narrow(dim, lead * n - before, before + n + after)


def joint_weight(n, joint, like):
    """Вес второго вида по позициям аудио.

    Точка склейки второго вида стоит за `joint` позиций до начала цикла:
    вес 0 в его собственной точке склейки, 1 в точке склейки первого вида
    (позиция 0), линейно между ними.
    """
    t = torch.arange(n, dtype=like.dtype, device=like.device) + 0.5
    d_own = torch.minimum((t - joint) % n, (joint - t) % n)
    d_other = torch.minimum(t, n - t)
    return d_own / (d_own + d_other)


def probe(x):
    """(правка 745) Короткая сводка по тензору для диагностического лога.

    Только ASCII и цифры: лог ComfyUI на Windows открыт в cp1251, и любой
    символ вне неё (например «→») ломает запись строки.
    """
    t = x.detach()
    nan = int(torch.isnan(t).sum())
    if nan:
        return "nan=%d" % nan
    f = t.float()
    return "absmax=%.1f rms=%.2f mean=%.2f" % (
        float(f.abs().max()), float(f.square().mean().sqrt()), float(f.mean()))


def loop_wrapper(executor, x, timestep, context, transformer_options, **kwargs):
    """DIFFUSION_MODEL wrapper: сэмплируем латент с обёрнутыми краями.

    x — [видео, аудио] после того, как H3 снял audio_scale (см.
    MiniMaxH3Model.forward): звук здесь в собственной шкале.
    """
    video, audio = x[0], x[1]
    n = video.shape[2] - VIDEO_TAIL           # 5k — «чистые» видеолатенты цикла
    clips = n // CLIP_LATENTS
    na = audio_span(clips)                    # аудиолатенты цикла
    audio_tail = audio.shape[-1] - na         # ~8 латентов хвоста
    pad = int(transformer_options["minimax_studio_loop_pad_clips"])
    pv = pad * CLIP_LATENTS
    pa = audio_span(pad)
    masks = (kwargs.get("denoise_mask"), kwargs.get("audio_denoise_mask"))

    # cond и uncond идут одной пачкой, каждый — копия батча сэмплера
    noise_swap = transformer_options["minimax_studio_loop_noise_swap"]
    noise_swap = noise_swap.repeat(video.shape[0] // noise_swap.shape[0], 1, 1, 1, 1)
    sigma = transformer_options["sigmas"].view(-1, 1, 1, 1, 1).to(video.dtype)

    def view(shift):
        """Один проход с циклом, повёрнутым на `shift` целых клипов.

        Возвращает предсказание цикла в исходной (неповёрнутой) ориентации.
        """
        sv, sa = shift * CLIP_LATENTS, audio_span(shift)
        args = dict(kwargs)
        payload = kwargs.get("minimax_payload")
        if payload and payload.get("keyframes"):
            # first/last frame и якоря Add Guide привязаны к позициям таймлайна:
            # переносим каждый туда, где его кадр цикла стоит в этом виде
            # (конец цикла заворачивается на начало).
            frames = clips * 17
            keyframes = [dict(kf, resolved_frame_index=pad * 17 + (kf["resolved_frame_index"] + shift * 17) % frames)
                         for kf in payload["keyframes"]]
            args["minimax_payload"] = dict(payload, keyframes=keyframes)
        # маски инпейнтинга едут за своими потоками через поворот и паддинг
        if masks[0] is not None:
            args["denoise_mask"] = wrap_pad(masks[0][:, :, :n].roll(sv, dims=2), pv, pv + VIDEO_TAIL, 2)
        if masks[1] is not None:
            args["audio_denoise_mask"] = wrap_pad(masks[1][..., :na].roll(sa, dims=-1), pa, pa + audio_tail, -1)
        # паддинг повторяет латент цикла вместе с его стартовым шумом; дистил-
        # лированные модели (FastH3) рисуют белые точки там, где видят один и
        # тот же шум дважды — поэтому в паддинг подставляем свежий шум.
        swap = wrap_pad(noise_swap[:, :, :n].roll(sv, dims=2), pv, pv + VIDEO_TAIL, 2).to(video.dtype)
        swap[:, :, pv:pv + n] = 0
        if masks[0] is not None:
            swap = swap * args["denoise_mask"]
        padded = torch.addcmul(wrap_pad(video[:, :, :n].roll(sv, dims=2), pv, pv + VIDEO_TAIL, 2), sigma, swap)
        padded_audio = wrap_pad(audio[..., :na].roll(sa, dims=-1), pa, pa + audio_tail, -1)
        sig = float(sigma.flatten()[0])
        if shift == 0:
            # (правка 745) диагностика: строка на каждый шаг и на каждый проход
            # (первый проход и второй в full pipeline) — видно длины, pad и
            # насколько здоров латент на входе.
            LOG.info(
                "MiniMax Studio Loop: шаг sigma=%.3f, видео %d->%d [%s], звук %d->%d [%s], "
                "клипов %d, pad %d, views %d",
                sig, video.shape[2], padded.shape[2], probe(video),
                audio.shape[-1], padded_audio.shape[-1], probe(audio),
                clips, pad, int(transformer_options["minimax_studio_loop_views"]))
        out = executor([padded, padded_audio],
                       timestep, context, transformer_options, **args)
        if shift == 0:
            # (правка 745) то же по предсказанию: если проход «взорвался»,
            # это видно здесь, а не только по готовому видео
            LOG.info("MiniMax Studio Loop: шаг sigma=%.3f, предсказание видео [%s], звук [%s]",
                     sig, probe(out[0]), probe(out[1]))
        return out[0][:, :, pv:pv + n].roll(-sv, dims=2), out[1][..., pa:pa + na].roll(-sa, dims=-1)

    v, a = view(0)
    if int(transformer_options["minimax_studio_loop_views"]) == 2 and clips > 1:
        half = clips // 2
        _, a2 = view(half)
        wa = joint_weight(na, na - audio_span(half), a)
        a = torch.lerp(a, a2, wa.view(1, 1, 1, -1))
    return [wrap_pad(v, 0, VIDEO_TAIL, 2), wrap_pad(a, 0, audio_tail, -1)]


def loop_sampler_wrapper(executor, guider, sigmas, extra_args, callback, noise, *args, **kwargs):
    """SAMPLER_SAMPLE wrapper: готовит «свежий» шум для паддинга.

    Шум сэмплера на старте: x = sigma * noise + (1 - sigma) * clean.
    Прибавив к паддингу sigma * (fresh - noise), заменяем его шум на
    свежий и сохраняем содержимое.
    """
    shapes = guider.inner_model.latent_shapes
    # flat pack сэмплера → видео-поток
    video_noise = comfy.utils.unpack_latents(noise, shapes)[0] if shapes and len(shapes) > 1 else noise
    if torch.count_nonzero(video_noise) == 0:
        swap = video_noise
    else:
        # рисуем на CPU, как это делает сам сэмплер: seed даёт одинаковый
        # шум паддинга на любом устройстве
        generator = torch.Generator().manual_seed(((extra_args.get("seed") or 0) + 1) % 2 ** 64)
        swap = torch.randn(video_noise.shape, generator=generator, dtype=video_noise.dtype).to(video_noise.device) - video_noise
    extra_args["model_options"].setdefault("transformer_options", {})["minimax_studio_loop_noise_swap"] = swap
    return executor(guider, sigmas, extra_args, callback, noise, *args, **kwargs)


class MiniMaxStudioLoop:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",),
            "pad_clips": ("INT", {"default": 1, "min": 1, "max": 8,
                                  "tooltip": "Сколько клипов по 17 кадров обёрнутого контекста добавить с каждой стороны цикла. Каждый клип — плюс время сэмплинга."}),
        }, "optional": {
            "views": ("INT", {"default": 2, "min": 1, "max": 2,
                              "tooltip": "2 — дополнительно сэмплировать цикл со сдвигом на полцикла и брать звук вокруг стыка оттуда. Убирает «кашу» в звуке на стыке; время сэмплинга примерно вдвое."}),
        }}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "MiniMax Studio"
    DESCRIPTION = ("Seamless H3 loop: sample the latent with its end wrapped around to its start. "
                   "Set the latent length to 17k+5 frames; the loop is 17k frames. Decode with MiniMax Studio Loop Decode.")

    def patch(self, model, pad_clips, views=2):
        model = model.clone()
        to = model.model_options.setdefault("transformer_options", {})
        to["minimax_studio_loop_pad_clips"] = int(pad_clips)
        to["minimax_studio_loop_views"] = int(views)
        model.add_wrapper_with_key(comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL,
                                   "minimax_studio_loop", loop_wrapper)
        model.add_wrapper_with_key(comfy.patcher_extension.WrappersMP.SAMPLER_SAMPLE,
                                   "minimax_studio_loop", loop_sampler_wrapper)
        return (model,)


class MiniMaxStudioLoopDecode:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "samples": ("LATENT",),
            "vae": ("VAE",),
            "audio_vae": ("VAE",),
            "pad_clips": ("INT", {"default": 1, "min": 1, "max": 8,
                                  "tooltip": "Сколько клипов по 17 кадров обёрнутого латента декодировать с каждой стороны, чтобы декодер не начинал и не заканчивал внутри цикла."}),
        }}

    RETURN_TYPES = ("IMAGE", "AUDIO")
    FUNCTION = "decode"
    CATEGORY = "MiniMax Studio"
    DESCRIPTION = ("Decode a MiniMax Studio Loop latent with wrapped context on both sides; "
                   "returns exactly one loop of frames and audio.")

    def decode(self, samples, vae, audio_vae, pad_clips):
        video, audio = samples["samples"].unbind()
        n = video.shape[2] - VIDEO_TAIL
        clips = n // CLIP_LATENTS
        na = audio_span(clips)
        pad = int(pad_clips)
        pv = pad * CLIP_LATENTS
        pa = audio_span(pad)

        images = vae.decode(wrap_pad(video[:, :, :n], pv, pv + VIDEO_TAIL, 2))
        images = images.reshape(-1, images.shape[-3], images.shape[-2], images.shape[-1])
        total_frames = images.shape[0]
        images = images[17 * pad:17 * (pad + clips)]

        a = wrap_pad(audio[..., :na], pa, pa, -1)
        out = vae_decode_audio(audio_vae, {"samples": a})
        per_latent = out["waveform"].shape[-1] // a.shape[-1]
        out["waveform"] = out["waveform"][..., pa * per_latent:(pa + na) * per_latent]

        # (правка 745) диагностика: геометрия и замер шва прямо по кадрам.
        # Шов — разница «последний кадр → первый»: у готовой петли она такая же,
        # как разница любых соседних кадров (отношение ≈ 1).
        LOG.info(
            "MiniMax Studio Loop Decode: видео-латент %d [%s] (цикл %d лат = %d кадров, хвост %d), "
            "декод %d кадров, срез %d:%d, звук %d->%d латентов по %d сэмплов",
            video.shape[2], probe(video), n, clips * 17, video.shape[2] - n, total_frames,
            17 * pad, 17 * (pad + clips), audio.shape[-1], a.shape[-1], per_latent)
        f = images[..., ::2, ::2, :].float()
        if f.shape[0] > 2:
            step_diff = (f[1:] - f[:-1]).abs().mean(dim=(1, 2, 3))
            seam = float((f[0] - f[-1]).abs().mean())
            median = float(step_diff.median())
            LOG.info(
                "MiniMax Studio Loop Decode: шов %.2f при медиане соседних кадров %.2f "
                "(%.1fx, норма 1-2x), максимум внутри %.2f, кадры %.2f..%.2f",
                seam, median, seam / max(median, 1e-6), float(step_diff.max()),
                float(f.min()), float(f.max()))
        return (images, out)


NODE_CLASS_MAPPINGS = {
    "MiniMaxStudioLoop": MiniMaxStudioLoop,
    "MiniMaxStudioLoopDecode": MiniMaxStudioLoopDecode,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxStudioLoop": "MiniMax Studio · Loop",
    "MiniMaxStudioLoopDecode": "MiniMax Studio · Loop Decode",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
