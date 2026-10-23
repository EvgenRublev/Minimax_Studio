from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction

from .models import ENGINE_CHOICES, InterpolationPlan


def output_frame_count(duration: Fraction, target_rate: Fraction) -> int:
    """Count timestamps n/rate in the half-open interval [0, duration)."""
    if duration <= 0 or target_rate <= 0:
        return 0
    value = duration * target_rate
    return (value.numerator + value.denominator - 1) // value.denominator


def exact_native_multiplier(
    source_rate: Fraction, target_rate: Fraction, native_multiplier_max: int
) -> int | None:
    if target_rate <= source_rate:
        return 1
    ratio = target_rate / source_rate
    if ratio.denominator != 1:
        return None
    multiplier = ratio.numerator
    return multiplier if 2 <= multiplier <= native_multiplier_max else None


def choose_interpolation_plan(
    source_rate: Fraction,
    target_rate: Fraction,
    engine: str,
    native_multiplier_max: int,
    *,
    cfr: bool = True,
) -> InterpolationPlan:
    # Migrate callers and saved settings from the feature's original display name.
    if engine == "Experimental Cascade":
        engine = "Cascade"
    if engine not in ENGINE_CHOICES:
        raise ValueError(f"Unknown DLSS engine {engine!r}.")
    if source_rate <= 0 or target_rate <= 0:
        raise ValueError("Source and output FPS must be positive.")
    ratio = target_rate / source_rate
    if target_rate <= source_rate:
        return InterpolationPlan(
            path="Source-frame resampling",
            source_rate=source_rate,
            target_rate=target_rate,
            native_multiplier=1,
            grid_multiplier=1,
            cascade_stages=0,
            maximum_temporal_error=Fraction(1, 2) / source_rate,
            generated_per_interval=0,
        )

    native_exact = exact_native_multiplier(source_rate, target_rate, native_multiplier_max)
    if engine == "Native DLSSG":
        if not cfr:
            raise ValueError(
                "Native DLSSG requires constant-frame-rate input. Choose Auto or Cascade so "
                "the file can be placed on a deterministic CFR timeline."
            )
        if native_exact is None:
            raise ValueError(
                f"{source_rate} → {target_rate} is not an exact native DLSSG grid supported by "
                f"this runtime (native maximum {native_multiplier_max}×). Choose Auto or Cascade."
            )
    native = native_exact if cfr else None
    if native is not None and engine in {"Auto", "Native DLSSG"}:
        return InterpolationPlan(
            path="Native DLSSG",
            source_rate=source_rate,
            target_rate=target_rate,
            native_multiplier=native,
            grid_multiplier=native,
            cascade_stages=0,
            maximum_temporal_error=Fraction(0),
            generated_per_interval=native - 1,
        )

    if ratio == 2:
        stages = 1
    elif ratio == 4:
        stages = 2
    else:
        stages = 3
    grid = 1 << stages
    exact_dyadic = cfr and ratio in {Fraction(2), Fraction(4)}
    return InterpolationPlan(
        path="Cascade",
        source_rate=source_rate,
        target_rate=target_rate,
        native_multiplier=2,
        grid_multiplier=grid,
        cascade_stages=stages,
        maximum_temporal_error=(
            Fraction(0)
            if exact_dyadic
            else Fraction(1, 2 * grid) / source_rate
        ),
        generated_per_interval=grid - 1,
    )


@dataclass(frozen=True, slots=True)
class GridSelection:
    source_interval: int
    grid_index: int
    ideal_time: Fraction
    grid_time: Fraction
    error: Fraction


def select_grid_timestamps(
    duration: Fraction,
    source_rate: Fraction,
    target_rate: Fraction,
    grid_multiplier: int,
) -> list[GridSelection]:
    """Map exact output timestamps to the nearest deterministic DLSSG grid point.

    Exact half-grid ties alternate direction. This prevents a persistent early/late bias,
    while every non-tie remains the mathematically nearest generated instant.
    """
    count = output_frame_count(duration, target_rate)
    selections: list[GridSelection] = []
    tie_late = False
    for output_index in range(count):
        ideal = Fraction(output_index, 1) / target_rate
        grid_position = ideal * source_rate * grid_multiplier
        lower = grid_position.numerator // grid_position.denominator
        remainder = grid_position - lower
        if remainder < Fraction(1, 2):
            nearest = lower
        elif remainder > Fraction(1, 2):
            nearest = lower + 1
        else:
            nearest = lower + int(tie_late)
            tie_late = not tie_late
        interval, grid_index = divmod(nearest, grid_multiplier)
        grid_time = Fraction(nearest, grid_multiplier) / source_rate
        selections.append(
            GridSelection(interval, grid_index, ideal, grid_time, grid_time - ideal)
        )
    return selections


def is_cfr_timeline(timestamps: list[Fraction], rate: Fraction) -> bool:
    if len(timestamps) < 3:
        return True
    expected = Fraction(1, 1) / rate
    return all(b - a == expected for a, b in zip(timestamps, timestamps[1:]))
