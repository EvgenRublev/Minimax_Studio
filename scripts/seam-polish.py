#!/usr/bin/env python3
"""(правка 982) Шлифовка швов в склеенном видео.

Порт подхода из ComfyUI-MiniMax-H3-Extender:
  • color_match = "seam_fade" — выравниваем средний цвет/контраст начала
    следующего клипа по последнему кадру предыдущего и плавно (косинусом)
    возвращаемся к родным цветам за 24 кадра;
  • seam_smooth — оптическим потоком (Farneback) сглаживаем стык: последний
    кадр A и первый кадр B слегка подтягиваются друг к другу, без потери кадров.

Вызывается из /api/comfy/concat после ffmpeg-склейки. Аудио не трогаем:
готовое видео перекодируется, звук копируется из исходного файла.
"""
import argparse
import math
import os
import subprocess
import sys
import wave

import cv2
import numpy as np


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--seams", required=True, help="comma-separated frame indexes of B start")
    p.add_argument("--fade-span", type=int, default=24)
    p.add_argument("--radius", type=int, default=1)
    p.add_argument("--crossfade-frames", type=int, default=0,
                   help="сколько кадров перекрыть на стыке (2 = ~83 мс)")
    p.add_argument("--tone-fade-frames", type=int, default=16,
                   help="короткий локальный tone-fade после стыка (0 = выкл.)")
    p.add_argument("--tone-fade-max", type=float, default=3.0,
                   help="максимальная поправка тона на кадр, 0–255")
    p.add_argument("--audio-patch-seconds", type=float, default=0.0,
                   help="сколько секунд нового звука после стыка заполнить эмбиентом "
                        "предыдущего куска (0 = выкл.; продление — 0.5)")
    p.add_argument("--audio-patch-fade", type=float, default=0.3,
                   help="длина кроссфейда обратно в родной звук, секунды")
    p.add_argument("--ffmpeg", required=True)
    return p.parse_args()


def color_match_seam_fade(frames, seam, fade_span):
    """Выравниваем ВЕСЬ новый кусок по яркости/контрасту границы.

    Раньше здесь был косинусный возврат к «родным» цветам за 24 кадра — на
    медленном движении он читался как просадка/градиент яркости. Теперь
    коррекция применяется ко всему куску B, без видимого фейда.
    """
    if seam <= 0 or seam >= len(frames):
        return
    a = frames[seam - 1].astype(np.float32) / 255.0
    b = frames[seam:].astype(np.float32) / 255.0
    if b.shape[0] == 0:
        return
    m_s = a.mean(axis=(0, 1), keepdims=True)
    s_s = np.maximum(a.std(axis=(0, 1), keepdims=True), 1e-5)
    m_t = b[0].mean(axis=(0, 1), keepdims=True)
    s_t = np.maximum(b[0].std(axis=(0, 1), keepdims=True), 1e-5)

    corrected = (b - m_t) / s_t * s_s + m_s
    corrected = np.clip(corrected, 0.0, 1.0)
    frames[seam:] = np.clip(corrected * 255.0, 0, 255).astype(np.uint8)


def local_tone_delta(frames, seam, max_delta=3.0):
    """Низкочастотная разница тона A→B для локального tone-fade.

    Считается ДО color_match/seam_smooth: сравниваем родные последний кадр A
    и первый кадр B. Иначе глобальная коррекция уже «съест» разницу, а на
    персонаже она останется.
    """
    if seam <= 0 or seam >= len(frames):
        return None
    a = frames[seam - 1].astype(np.float32)
    b = frames[seam].astype(np.float32)
    if a.shape != b.shape:
        return None
    h, w = a.shape[:2]
    sigma = max(3.0, min(h, w) / 90.0)
    da = cv2.GaussianBlur(a, (0, 0), sigma)
    db = cv2.GaussianBlur(b, (0, 0), sigma)
    delta = np.clip(da - db, -max_delta, max_delta)
    mag = np.max(np.abs(delta), axis=2, keepdims=True)
    mask = np.clip((mag - 0.05) / 0.25, 0.0, 1.0)
    return delta * mask


def apply_local_tone_fade(frames, seam, delta, span=16):
    """(правка 1017) Плавно гасит заранее снятую разницу тона за span кадров."""
    if delta is None or span <= 0 or seam <= 0 or seam >= len(frames):
        return
    n = min(int(span), len(frames) - seam)
    if n <= 0:
        return
    peak = float(np.max(np.abs(delta)))
    if peak < 0.05:
        return
    print(f"[tone-fade] seam {seam}: dmax={peak:.2f}, span={n}")
    for k in range(n):
        # 1 → 0 по косинусу: первый кадр B уже в тоне A, затем плавно
        # возвращается к родному тону продолжения.
        w = 0.5 * (1.0 + math.cos(math.pi * k / max(1, n - 1)))
        frames[seam + k] = np.clip(
            frames[seam + k].astype(np.float32) + delta * w, 0, 255
        ).astype(np.uint8)


def _gray_u8(rgb):
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.uint8)


def _flow(a_rgb, b_rgb):
    return cv2.calcOpticalFlowFarneback(
        _gray_u8(a_rgb), _gray_u8(b_rgb), None,
        0.5, 3, 15, 3, 5, 1.2, 0,
    )


def seam_smooth(frames, seam, radius):
    """Сглаживание движения на стыке (без сдвига кадров)."""
    if radius <= 0 or seam <= 0 or seam >= len(frames) or len(frames) < 3:
        return
    a_last = frames[seam - 1]
    b_first = frames[seam]
    if seam + 1 >= len(frames):
        return
    b_second = frames[seam + 1]
    h, w = a_last.shape[:2]
    x, y = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))

    # 1) Первый кадр B после диффузии часто «тормозит» — слегка двигаем его к B+1.
    # (правка 1002) Значения как в референсной ноде MiniMaxH3VideoMerge:
    # advance_frac 0.20, seam_frac 0.15, веса 0.85/0.15. Более агрессивные
    # 0.25/0.25/80-20 сами создавали неравномерность движения.
    flow_b = _flow(b_first, b_second)
    adv = 0.20
    b0 = b_first.astype(np.float32)
    b1 = b_second.astype(np.float32)
    fwd = cv2.remap(b0, (x - flow_b[..., 0] * adv), (y - flow_b[..., 1] * adv), cv2.INTER_LINEAR)
    bwd = cv2.remap(b1, (x + flow_b[..., 0] * (1 - adv)), (y + flow_b[..., 1] * (1 - adv)), cv2.INTER_LINEAR)
    b_first_adv = (1.0 - adv) * fwd + adv * bwd

    # 2) Балансируем движение между последним A и первым B.
    flow_s = _flow(a_last, b_first_adv)
    frac = 0.15
    a_f = a_last.astype(np.float32)
    warped_a = cv2.remap(a_f, (x - flow_s[..., 0] * frac), (y - flow_s[..., 1] * frac), cv2.INTER_LINEAR)
    warped_b = cv2.remap(b_first_adv, (x + flow_s[..., 0] * frac), (y + flow_s[..., 1] * frac), cv2.INTER_LINEAR)

    frames[seam - 1] = np.clip(0.85 * a_f + 0.15 * warped_b, 0, 255).astype(np.uint8)
    frames[seam] = np.clip(0.85 * b_first_adv + 0.15 * warped_a, 0, 255).astype(np.uint8)

    # 3) Радиус 2+ — мягко размазываем дрожание на соседние кадры.
    if radius >= 2:
        r = min(radius, seam, len(frames) - seam - 1)
        for i in range(2, r + 1):
            wd = 0.10 * (1.0 - (i - 1) / max(1, r))
            frames[seam - i] = np.clip((1 - wd) * frames[seam - i] + wd * frames[seam + i - 1], 0, 255).astype(np.uint8)
            frames[seam + i - 1] = np.clip((1 - wd) * frames[seam + i - 1] + wd * frames[seam - i], 0, 255).astype(np.uint8)


def decode_audio(ffmpeg, path):
    """PCM f32le stereo 44100. None, если аудиодорожки нет."""
    try:
        p = subprocess.run(
            [ffmpeg, '-v', 'error', '-i', path, '-vn', '-f', 'f32le',
             '-acodec', 'pcm_f32le', '-ar', '44100', '-ac', '2', '-'],
            capture_output=True, check=False,
        )
        if p.returncode != 0 or not p.stdout:
            return None
        return np.frombuffer(p.stdout, dtype=np.float32).reshape(-1, 2).copy()
    except Exception:
        return None


def crossfade_video(frames, seams, d):
    """Короткий настоящий xfade в питоне: D кадров A смешиваются с D кадрами B,
    длина видео уменьшается на D кадров; звук ниже уменьшается так же."""
    if d <= 0:
        return frames
    for s in sorted(seams, reverse=True):
        if s - d < 0 or s + d > len(frames):
            continue
        a = frames[s - d:s].astype(np.float32)
        b = frames[s:s + d].astype(np.float32)
        out = np.empty_like(a)
        for k in range(d):
            w = (k + 0.5) / d
            out[k] = a[k] * (1.0 - w) + b[k] * w
        frames = np.concatenate([
            frames[:s - d],
            np.clip(out, 0, 255).astype(np.uint8),
            frames[s + d:],
        ], axis=0)
    return frames


def crossfade_audio(audio, seams, fps, d, sr=44100):
    if d <= 0 or audio is None:
        return audio
    ds = max(1, int(round(d / fps * sr)))
    for seam in sorted(seams, reverse=True):
        center = int(round(seam / float(fps) * sr))
        if center - ds < 0 or center + ds > len(audio):
            continue
        a = audio[center - ds:center]
        b = audio[center:center + ds]
        t = np.linspace(0.0, 1.0, ds, dtype=np.float32)
        w = 0.5 * (1.0 - np.cos(np.pi * t))  # equal-power-ish fade
        mix = a * (1.0 - w[:, None]) + b * w[:, None]
        audio = np.concatenate([audio[:center - ds], mix, audio[center + ds:]], axis=0)
    return audio


def declick_audio(audio, seams, fps, sr=44100):
    """Короткие fade-out/fade-in вокруг стыка — убирают щелчок/скачок,
    не меняя длину и синхронизацию с видео."""
    fade = max(16, int(0.010 * sr))  # 10 мс
    for seam in seams:
        center = int(round(seam / float(fps) * sr))
        start = max(0, center - fade)
        end = min(len(audio), center + fade)
        if start >= center or center >= end:
            continue
        n_out = center - start
        n_in = end - center
        # перед стыком — плавно в тишину, после — плавно из тишины
        ramp_out = 0.5 * (1.0 + np.cos(np.linspace(0.0, math.pi, n_out, dtype=np.float32)))
        ramp_in = 0.5 * (1.0 - np.cos(np.linspace(0.0, math.pi, n_in, dtype=np.float32)))
        audio[start:center] *= ramp_out[:, None]
        audio[center:end] *= ramp_in[:, None]
    return audio


def _is_stationary_ambience(tail, sr):
    """Похож ли хвост на ровный эмбиент (дождь, гул, ветер), а не на музыку/речь.

    Возвращает (ok, почему). Зацикливать можно только стационарный шум: у
    музыки и речи повтор полусекунды слышен как «тот же звук ещё раз», поэтому
    для них патч не ставим вовсе.
    """
    x = tail.mean(axis=1)
    n = len(x)
    if n < int(0.1 * sr):
        return False, 'хвост короче 0.1 с'
    # 1) Ровность громкости: у речи/ударов RMS по 20 мс скачет.
    win = max(16, int(0.02 * sr))
    frames = n // win
    if frames < 4:
        return False, 'мало фреймов'
    rms = np.array([float(np.sqrt(np.mean(x[i * win:(i + 1) * win] ** 2))) for i in range(frames)])
    mean_rms = float(rms.mean())
    if mean_rms < 1e-4:
        return True, 'тишина'
    # 1a) Уровень: «мост» имеет смысл только для ТИХОГО фона. Громкий звук
    # (музыка, речь, эффекты) при копировании слышен как повтор последнего
    # звука — порог −34 dBFS.
    if mean_rms > 0.02:
        return False, f'слишком громко для фонового моста (RMS {mean_rms:.3f})'
    if float(rms.std()) / mean_rms > 0.5:
        return False, 'громкость скачет (речь/удары/бит)'
    # 2) Периодичность: у музыки/тонального гула автокорреляция даёт чёткий пик.
    x = x - x.mean()
    denom = float(np.dot(x, x))
    if denom <= 1e-8:
        return True, 'тишина'
    lo = max(1, int(0.03 * sr))
    hi = min(n - 1, int(0.40 * sr))
    if hi <= lo:
        return False, 'хвост короткий для проверки тона'
    peak = 0.0
    step = max(1, (hi - lo) // 64)
    for lag in range(lo, hi, step):
        c = float(np.dot(x[:-lag], x[lag:])) / denom
        if c > peak:
            peak = c
    if peak > 0.45:
        return False, f'тонально/периодично (autocorr {peak:.2f}) — музыка'
    return True, f'эмбиент (autocorr {peak:.2f})'


def patch_audio_seams(audio, seams, fps, sr=44100, patch_sec=0.5, fade_sec=0.3):
    """(правка 1109) Скрыть «перезапуск» ровного эмбиента на стыке.

    Полсекунды нового звука после стыка заполняются хвостом предыдущего куска
    (БЕЗ зацикливания — один проход, не длиннее самого хвоста), затем кроссфейд
    обратно в родной звук клипа. Длина дорожки не меняется.

    Ставится только для СТАЦИОНАРНОГО эмбиента (дождь, гул, ветер). Для музыки,
    речи и любых событий патч пропускается: повтор уже услышанного там читается
    как «последний звук повторился» — ровно то, от чего патч должен спасать.
    """
    if audio is None or patch_sec <= 0.01 or len(audio) < 16:
        return audio
    amb_n = max(1, int(round(0.5 * sr)))
    patch_n = max(1, int(round(patch_sec * sr)))
    for seam in sorted(seams, reverse=True):
        center = int(round(seam / float(fps) * sr))
        if center < amb_n or center + patch_n > len(audio):
            continue
        tail = audio[center - amb_n:center]
        ok, why = _is_stationary_ambience(tail, sr)
        if not ok:
            print(f"[audio-patch] seam {seam}: пропуск — {why}")
            continue
        # Без зацикливания: максимум один проход хвоста.
        use_n = min(patch_n, len(tail))
        fade_n = max(1, min(use_n - 1, int(round(fade_sec * sr))))
        if use_n - fade_n < 1:
            continue
        # Громкость нового звука не должна быть заметно выше «моста».
        head_n = max(1, int(round(0.15 * sr)))
        native_head = audio[center:min(len(audio), center + head_n)]
        if native_head.size and \
                float(np.abs(native_head).mean()) > 2.0 * float(np.abs(tail).mean()) + 1e-4:
            print(f"[audio-patch] seam {seam}: пропуск (новый звук громче эмбиента — речь/удар)")
            continue
        fill = tail[:use_n]
        t = np.linspace(0.0, 1.0, fade_n, dtype=np.float32)
        w = 0.5 * (1.0 - np.cos(np.pi * t))  # equal-power-ish
        fade_start = center + use_n - fade_n
        native = audio[fade_start:center + use_n]
        audio[center:fade_start] = fill[:use_n - fade_n]
        audio[fade_start:center + use_n] = (
            fill[use_n - fade_n:] * (1.0 - w[:, None]) + native * w[:, None]
        )
        print(f"[audio-patch] seam {seam}: {use_n / sr:.2f} c эмбиента + фейд {fade_sec:.2f} c")
    return audio


def write_wav(path, audio, sr=44100):
    pcm = np.clip(audio, -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype(np.int16)
    with wave.open(path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm16.tobytes())


def main():
    args = parse_args()
    seams = [int(x) for x in args.seams.split(",") if x.strip().isdigit()]
    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        print("seam-polish: cannot open input", file=sys.stderr)
        return 1
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    frames = []
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        frames.append(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    cap.release()
    if not frames:
        print("seam-polish: no frames", file=sys.stderr)
        return 1
    frames = np.stack(frames, axis=0)
    # защита от гигантских файлов: шлифовка рассчитана на короткие ролики
    if len(frames) > 2400:
        print("seam-polish: too many frames, skipped", file=sys.stderr)
        return 2

    seams = sorted({s for s in seams if 0 < s < len(frames)})
    for s in seams:
        color_match_seam_fade(frames, s, args.fade_span)
    # (правка 1017) После глобальной коррекции остаётся разница именно на
    # персонаже. Её снимаем коротким локальным tone-fade.
    tone_maps = {
        s: local_tone_delta(frames, s, args.tone_fade_max)
        for s in seams
    } if args.tone_fade_frames > 0 else {}
    for s in seams:
        seam_smooth(frames, s, args.radius)
    for s in seams:
        apply_local_tone_fade(frames, s, tone_maps.get(s), args.tone_fade_frames)

    # (правка 1002) Никакого xfade: референсная нода MiniMaxH3VideoMerge
    # рекомендует blend_frames=0 при seam_smooth. Перекрытие двух разных
    # моментов само даёт «резиновый» неравномерный переход. Движение правим
    # оптическим потоком в окне radius кадров, таймлайн не меняется.
    audio_path = args.output + ".audio.wav"
    audio = decode_audio(args.ffmpeg, args.input)
    if audio is not None and len(audio) > 0:
        # звук не растягиваем: только 10 мс де-клик на стыке
        audio = declick_audio(audio, seams, fps)
        # (правка 1109) После де-клика: «мост» из эмбиента прошлого куска на
        # стыке, чтобы музыка/эмбиент не стартовали заново.
        if args.audio_patch_seconds > 0.01:
            audio = patch_audio_seams(
                audio, seams, fps, 44100,
                args.audio_patch_seconds, args.audio_patch_fade,
            )
        write_wav(audio_path, audio)
    else:
        audio_path = None

    h, w = frames[0].shape[:2]
    tmp = args.output + ".part.mp4"
    cmd = [
        args.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{w}x{h}", "-r", f"{fps:.6f}", "-i", "-",
    ]
    if audio_path:
        cmd += ["-i", audio_path, "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"]
    else:
        cmd += ["-i", args.input, "-map", "0:v:0", "-map", "1:a?", "-c:a", "copy"]
    cmd += [
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", tmp,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for rgb in frames:
        # ffmpeg ждёт -pix_fmt rgb24, поэтому отдаём RGB как есть;
        # обратная конвертация в BGR здесь меняла красный и синий местами.
        proc.stdin.write(rgb.tobytes())
    proc.stdin.close()
    rc = proc.wait()
    if rc != 0 or not os.path.exists(tmp):
        print("seam-polish: ffmpeg encode failed", file=sys.stderr)
        try:
            os.remove(tmp)
        except OSError:
            pass
        if audio_path:
            try:
                os.remove(audio_path)
            except OSError:
                pass
        return 1
    os.replace(tmp, args.output)
    if audio_path:
        try:
            os.remove(audio_path)
        except OSError:
            pass
    print(f"seam-polish: ok, {len(frames)} frames, seams={seams}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
