"""Ordered CPU/GPU overlap with bounded admission and a single queue owner."""
from __future__ import annotations

import time
from collections import deque
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from typing import Callable, Iterable

from ..core.jobs import Cancelled, JobController

BUFFER_LIMIT_BYTES = 1 << 30


class PipeWriter:
    """A subprocess pipe cannot seek, even when its Python wrapper has seek()."""

    def __init__(self, stream):
        self.stream = stream

    def write(self, data):
        view = memoryview(data)
        offset = 0
        while offset < len(view):
            count = self.stream.write(view[offset:])
            if not count:
                raise BrokenPipeError("Video encoder closed its input.")
            offset += count
        return offset

    def flush(self):
        self.stream.flush()


def run_pipeline(
    source: Iterable,
    stages: list,
    writer,
    controller: JobController,
    frame_bytes: int,
    timings: dict[str, float],
    progress: Callable[[int], None] | None = None,
    *,
    buffer_limit_bytes: int = BUFFER_LIMIT_BYTES,
) -> dict:
    """Coordinate four single-owner workers; workers never wait on queue puts.

    One credit represents one packed RGBA or FP16 motion array. Reserve all
    possible native outputs before evaluation, plus motion storage before guide
    preparation. Conservative accounting counts shared arrays more than once.
    Existing per-stage history, guide scratch space and codec buffers are not
    additional queue storage and are not included in this limit.
    """
    if frame_bytes <= 0 or buffer_limit_bytes <= 0:
        raise ValueError("Frame size and buffer limit must be positive.")
    started = time.perf_counter()
    iterator = iter(source)
    max_generated = max((stage.generated_count for stage in stages), default=0)
    capacity = buffer_limit_bytes // frame_bytes
    decoded = 0
    processed = 0
    used = peak = 0

    def timed(key, function, *args):
        before = time.perf_counter()
        try:
            return function(*args)
        finally:
            timings[key] = timings.get(key, 0.0) + time.perf_counter() - before

    # Even one input/output transaction may exceed the queue budget for enormous
    # frames. Keep the sequential path available without allocating extra queues.
    if capacity < max_generated + 3:
        try:
            for frame in iterator:
                if controller.cancel.is_set():
                    raise Cancelled("Frame interpolation stopped by user.")
                items = [frame]
                for index, stage in enumerate(stages):
                    next_items = []
                    for item in items:
                        prepared = timed(f"guide_{index + 1}_seconds", stage.prepare, item)
                        next_items.extend(timed(f"native_{index + 1}_seconds", stage.evaluate, prepared))
                    items = next_items
                for item in items:
                    timed("encode_write_seconds", writer.push, item)
                decoded += 1
                if progress:
                    progress(decoded)
            timed("encode_write_seconds", writer.finish)
        except BaseException:
            controller.terminate_processes()
            raise
        finally:
            if hasattr(iterator, "close"):
                iterator.close()
        timings["pipeline_seconds"] = time.perf_counter() - started
        return {"mode": "sequential", "buffer_limit_bytes": buffer_limit_bytes,
                "peak_buffer_bytes": 0, "decoded_frames": decoded}

    edges = [deque() for _ in range(len(stages) + 1)]
    prepared_queues = [deque() for _ in stages]
    edge_capacity = max(4, max_generated + 1)
    pools = {name: ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"FI-{name}")
             for name in ("decode", "guide", "native", "encode")}
    pending = {}
    ended = False

    def reserve(credits):
        nonlocal used, peak
        used += credits
        if used > capacity:
            raise RuntimeError("Frame interpolation buffer reservation exceeded its limit.")
        peak = max(peak, used)

    def consume(items):
        for item in items:
            if controller.cancel.is_set():
                raise Cancelled("Frame interpolation stopped by user.")
            writer.push(item)

    try:
        while True:
            if controller.cancel.is_set():
                raise Cancelled("Frame interpolation stopped by user.")
            # Harvest before dispatch. Results own their arrays until consumed;
            # neither futures nor workers can block while publishing a result.
            for name, (future, index, credits) in list(pending.items()):
                if not future.done():
                    continue
                result = future.result()
                del pending[name]
                if name == "decode":
                    if result is None:
                        ended = True
                        used -= 1
                    else:
                        edges[0].append(result)
                        decoded += 1
                elif name == "guide":
                    prepared_queues[index].append(result)
                elif name == "native":
                    if len(result) > credits + 1:
                        raise RuntimeError("DLSSG produced more frames than reserved.")
                    edges[index + 1].extend(result)
                    used -= 2 + credits - len(result)
                    if index == 0:
                        processed += 1
                        if progress:
                            progress(processed)
                else:
                    used -= credits
                    if not stages and progress:
                        processed += credits
                        progress(processed)
                # Do not keep the last harvested frame/result alive in locals.
                result = None
                future = None

            if "encode" not in pending and edges[-1]:
                items = [edges[-1].popleft() for _ in range(min(edge_capacity, len(edges[-1])))]
                pending["encode"] = (pools["encode"].submit(timed, "encode_write_seconds", consume, items),
                                     -1, len(items))
                items = None

            if "native" not in pending:
                for index in reversed(range(len(stages))):
                    count = stages[index].generated_count
                    if (prepared_queues[index] and used + count <= capacity
                            and len(edges[index + 1]) + count + 1 <= edge_capacity):
                        reserve(count)
                        prepared = prepared_queues[index].popleft()
                        pending["native"] = (pools["native"].submit(
                            timed, f"native_{index + 1}_seconds", stages[index].evaluate, prepared), index, count)
                        prepared = None
                        break

            if "guide" not in pending:
                for index in reversed(range(len(stages))):
                    # Retain native output headroom even if the GPU is idle.
                    if (edges[index] and len(prepared_queues[index]) < 2
                            and used + 1 <= capacity - max_generated):
                        reserve(1)
                        item = edges[index].popleft()
                        pending["guide"] = (pools["guide"].submit(
                            timed, f"guide_{index + 1}_seconds", stages[index].prepare, item), index, 1)
                        item = None
                        break

            if (not ended and "decode" not in pending and len(edges[0]) < edge_capacity
                    and used + 1 <= capacity - max_generated - 1):
                reserve(1)
                pending["decode"] = (pools["decode"].submit(timed, "decode_seconds", next, iterator, None), -1, 1)

            if not pending:
                if ended and not any(edges) and not any(prepared_queues):
                    break
                raise RuntimeError("Frame interpolation could not drain its bounded pipeline.")
            before_wait = time.perf_counter()
            wait([value[0] for value in pending.values()], timeout=0.05, return_when=FIRST_COMPLETED)
            timings["coordinator_wait_seconds"] = timings.get("coordinator_wait_seconds", 0.0) + time.perf_counter() - before_wait

        pools["encode"].submit(timed, "encode_write_seconds", writer.finish).result()
    except BaseException:
        # Closing worker/encoder processes releases any OS pipe I/O in flight.
        # Do not mark the shared batch controller cancelled for a failed item.
        controller.terminate_processes()
        raise
    finally:
        for pool in pools.values():
            pool.shutdown(wait=True, cancel_futures=True)
        pending.clear()
        for edge in [*edges, *prepared_queues]:
            edge.clear()
        if hasattr(iterator, "close"):
            iterator.close()
    timings["pipeline_seconds"] = time.perf_counter() - started
    return {"mode": "overlapped", "buffer_limit_bytes": buffer_limit_bytes,
            "peak_buffer_bytes": peak * frame_bytes, "decoded_frames": decoded}
