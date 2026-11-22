#!/usr/bin/env python3
"""Забрать VRAM отдельным процессом, чтобы проверить генерацию «на слабой карте».

Зачем: у PyTorch/CUDA нет лимита «не больше N ГБ на процесс», а подмена учёта в
comfy/model_management.py для такой проверки не годится - comfy-aimdo
(DynamicVRAM) живёт ниже Python-слоя и по NVML видит реальную карту. Поэтому
просто держим свои аллокации в отдельном CUDA-контексте, пока свободными не
останется заданное количество гигабайт. ComfyUI при этом честно упирается в
реальные 8 ГБ, а nvml_pressure=1 (правка 1077) сообщает aimdo, что память
занята чужим процессом.

Запуск: vram-hog.bat [сколько ГБ оставить свободными] - по умолчанию 8.
Остановка: Ctrl+C или закрытие окна - блоки освобождаются сразу.

Что проверяется таким способом честно: нехватка видеопамяти как таковая -
offload весов, pinned-хост кэш, страничевание, решения malloc-graph, ошибки
1450/1453. Что НЕ меняется: vram_total в /system_stats остаётся реальным
(24 ГБ), поэтому авто-ветки студии, которые смотрят на объём карты (bounded
attention при vramGb < 12, потолок тайлов Refine), сами не переключатся - их
выставляют вручную в настройках.

См. также --no-touch: блоки специально трогаются раз в 2 секунды, иначе WDDM
имеет право выгрузить их в системную память и «занятость» исчезнет. Если в
строке статуса свободно больше заданного - значит так и произошло или память
уже была занята (ComfyUI запущен до старта хога).
"""

from __future__ import annotations

import argparse
import sys
import time

import torch

MB = 1024 * 1024
GB = 1024 * MB
# Минимальный кусок аллокации: меньше - лишние вызовы, больше - хуже подгонка
# под заданный остаток.
MIN_CHUNK = 2 * MB


def human(nbytes: float) -> str:
    return f"{nbytes / GB:.2f} GB"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Hold part of the VRAM so ComfyUI runs like on a weak GPU."
    )
    p.add_argument(
        "--free-gb",
        type=float,
        default=8.0,
        help="how many GB must stay free (default 8)",
    )
    p.add_argument(
        "--hold-gb",
        type=float,
        default=0.0,
        help="instead of --free-gb: hold exactly this many GB (0 = off)",
    )
    p.add_argument(
        "--block-mb",
        type=int,
        default=128,
        help="block size, MB (default 128)",
    )
    p.add_argument(
        "--max-gb",
        type=float,
        default=0.0,
        help="never hold more than this (0 = only --free-gb limits us)",
    )
    p.add_argument(
        "--seconds",
        type=int,
        default=0,
        help="release after this many seconds (0 = hold until Ctrl+C)",
    )
    p.add_argument("--device", type=int, default=0, help="CUDA device index")
    p.add_argument(
        "--no-touch",
        action="store_true",
        help="do not touch blocks on a timer (WDDM may spill them into RAM)",
    )
    p.add_argument(
        "--quiet",
        action="store_true",
        help="print the summary only, no live status line",
    )
    return p.parse_args()


def sample(blocks: list[torch.Tensor]) -> None:
    """Трогает блоки с шагом 64 КБ: трафик копеечный, страницы «свежие»."""
    for b in blocks:
        b.view(torch.int64)[::8192].sum()


def main() -> int:
    args = parse_args()
    if not torch.cuda.is_available():
        print("[hog] no CUDA device, nothing to hold", file=sys.stderr)
        return 1

    dev = torch.device("cuda", args.device)
    props = torch.cuda.get_device_properties(dev)
    free0, total0 = torch.cuda.mem_get_info(dev)
    print(f"[hog] {props.name}: total {human(total0)}, free {human(free0)}")

    # Сам контекст тоже стоит память (сотни МБ) - меряем после его создания.
    probe = torch.empty(MIN_CHUNK, dtype=torch.uint8, device=dev)
    held = [probe]
    free, _ = torch.cuda.mem_get_info(dev)

    block = max(MIN_CHUNK, args.block_mb * MB)
    if args.hold_gb > 0:
        target_free = None
        want_bytes = int(args.hold_gb * GB)
    else:
        target_free = int(args.free_gb * GB)
        want_bytes = max(0, free - target_free)
    if args.max_gb > 0:
        want_bytes = min(want_bytes, int(args.max_gb * GB))

    print(f"[hog] going to hold {human(want_bytes)} in {args.block_mb} MB blocks")

    grabbed = 0
    while grabbed < want_bytes:
        # Блоки кратны 8 байт: sample() смотрит на них как на int64.
        chunk = int(min(block, want_bytes - grabbed) // 8) * 8
        if target_free is not None:
            # Каждые 128 МБ карту перечитываем: её могут трогать другие процессы.
            free, _ = torch.cuda.mem_get_info(dev)
            room = int((free - target_free) // MIN_CHUNK) * MIN_CHUNK
            if room < MIN_CHUNK:
                break
            chunk = min(chunk, room)
        try:
            held.append(torch.empty(chunk, dtype=torch.uint8, device=dev))
        except RuntimeError:
            # OutOfMemoryError - подкласс RuntimeError; другой RuntimeError тут
            # означает, что карту уже нечем забить, и это тот же исход.
            print("[hog] hit OOM, stopping short of the target", file=sys.stderr)
            break
        grabbed += chunk

    if grabbed == 0:
        print("[hog] nothing to hold: the card is already below the target", file=sys.stderr)
        return 2

    free, _ = torch.cuda.mem_get_info(dev)
    print(f"[hog] holding {human(grabbed)} in {len(held)} blocks, free now {human(free)}")
    if target_free is not None and free > target_free + block:
        print(
            f"[hog] WARNING: missed the target ({human(free)} > {human(target_free)}), "
            "something else already used that memory",
            file=sys.stderr,
        )

    print("[hog] holding. Ctrl+C (or close the window) releases everything.")
    started = time.time()
    try:
        while True:
            if not args.no_touch:
                sample(held)
            if args.seconds and time.time() - started > args.seconds:
                print("[hog] time is up, releasing")
                break
            if not args.quiet:
                free, _ = torch.cuda.mem_get_info(dev)
                print(
                    f"\r[hog] holding {human(grabbed)} in {len(held)} blocks | "
                    f"free {human(free)}   ",
                    end="",
                    flush=True,
                )
            time.sleep(2.0)
    except KeyboardInterrupt:
        print("\n[hog] Ctrl+C, releasing")

    held.clear()
    probe = None
    torch.cuda.empty_cache()
    free, _ = torch.cuda.mem_get_info(dev)
    print(f"[hog] released, free now {human(free)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
