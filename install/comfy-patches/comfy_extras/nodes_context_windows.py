from comfy_api.latest import ComfyExtension, io
import logging

import comfy.context_windows
import comfy.model_management as mm
import nodes
from comfy_extras.nodes_minimax_h3 import video_latent_t

LOG = logging.getLogger(__name__)


def _studio_install_window_meta():
    """(правка 1145, фикс) Запоминаем РЕАЛЬНЫЕ total_windows/num_frames окна.

    Колбэк EVALUATE_CONTEXT_WINDOWS получает x_in — это уже упакованный
    мультимодальный тензор (огромное число), а не видеолатент: `shape[dim]`
    давал 5 635 008 вместо 62. Оборачиваем evaluate_context_windows и берём
    `window_state.latents[0].shape[dim]` + len(enumerated_context_windows) —
    ровно то, что печатает ядро в «Context window 3/4: ... of 62».
    """
    try:
        handler_cls = comfy.context_windows.IndexListContextHandler
        if getattr(handler_cls, "_studio_meta_wrapped", False):
            return
        orig = handler_cls.evaluate_context_windows

        def _wrapped(self, calc_cond_batch, model, x_in, conds, timestep,
                     enumerated_context_windows, model_options, window_state, *args, **kwargs):
            try:
                lat = window_state.latents[0]
                self._studio_total_frames = int(lat.shape[self.dim])
                self._studio_total_windows = int(len(enumerated_context_windows))
            except Exception:
                pass
            return orig(self, calc_cond_batch, model, x_in, conds, timestep,
                        enumerated_context_windows, model_options, window_state, *args, **kwargs)

        handler_cls.evaluate_context_windows = _wrapped
        handler_cls._studio_meta_wrapped = True
    except Exception as exc:
        LOG.debug("context windows: window meta wrapper not installed: %s", exc)


_studio_install_window_meta()


def _studio_window_vram_cleanup():
    """(правка 1137) Очистки aimdo между окнами контекста.

    Обработчик окон сэмплирует окна внутри ОДНОГО sampler-вызова. Ядро делает
    cleanup_prefetch_queues / reset_cast_buffers / vbars_reset_watermark_limits
    только после ноды, поэтому после первого окна очереди пре-фетча пиннят
    страницы VBAR, watermark дренируется, и первый fault следующего окна
    возвращает OOM/дедлок (comfy-aimdo #117): «VRAM полна, GPU ~60 Вт, стоит».
    Это те же три действия, что делает MiniMaxStudioVRAMReset, но без unload
    моделей — веса остаются резидентными, перечитывания с диска нет.
    """
    try:
        import comfy.model_prefetch as mp
        fn = getattr(mp, "cleanup_prefetch_queues", None)
        if fn is not None:
            fn()
    except Exception:
        pass
    try:
        fn = getattr(mm, "reset_cast_buffers", None)
        if fn is not None:
            fn()
    except Exception:
        pass
    try:
        import comfy.memory_management as mem
        if getattr(mem, "aimdo_enabled", False):
            import comfy_aimdo.model_vbar as vbar
            fn = getattr(vbar, "vbars_reset_watermark_limits", None)
            if fn is not None:
                fn()
    except Exception:
        pass


def _studio_window_cleanup_callback(handler, model, x_in, conds, timestep, model_options,
                                    window_idx, window, *args, **kwargs):
    # (правка 1145) Сообщаем студии, какое окно считается: верхняя панель
    # показывает «Окно 3/4: кадры 25–46 из 62» вместо немого сэмплера.
    try:
        from server import PromptServer  # noqa: PLC0415 — сервер есть только в ComfyUI
        total_windows = int(getattr(handler, "_studio_total_windows", 0) or 0)
        total_frames = int(getattr(handler, "_studio_total_frames", 0) or 0)
        first = int(window.index_list[0]) if getattr(window, "index_list", None) else 0
        last = int(window.index_list[-1]) if getattr(window, "index_list", None) else 0
        PromptServer.instance.send_sync("minimax_context_window", {
            "index": int(window_idx) + 1,
            "total": total_windows,
            "start": first,
            "end": last,
            "frames": total_frames,
        })
    except Exception as exc:
        LOG.debug("context windows: status event not sent: %s", exc)

    # Первое окно — сразу после загрузки модели, чистить нечего.
    if window_idx >= 1:
        LOG.info("Context windows: VRAM cleanup перед окном %d (prefetch/cast/watermark)", window_idx + 1)
        _studio_window_vram_cleanup()


class ContextWindowsManualNode(io.ComfyNode):
    # (правка 1137) Только H3: между окнами чистим aimdo (#117). Для Wan/LTXV
    # окна живут на других моделях и другой памяти — там не включаем.
    window_vram_cleanup = False

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="ContextWindowsManual",
            display_name="Context Windows (Manual)",
            category="model/patch",
            description="Manually set context windows.",
            inputs=[
                io.Model.Input("model", tooltip="The model to apply context windows to during sampling."),
                io.Int.Input("context_length", min=1, default=16, tooltip="The length of the context window."),
                io.Int.Input("context_overlap", min=0, default=4, tooltip="The overlap of the context window."),
                io.Combo.Input("context_schedule", options=[
                    comfy.context_windows.ContextSchedules.STATIC_STANDARD,
                    comfy.context_windows.ContextSchedules.UNIFORM_STANDARD,
                    comfy.context_windows.ContextSchedules.UNIFORM_LOOPED,
                    comfy.context_windows.ContextSchedules.BATCHED,
                    ], default=comfy.context_windows.ContextSchedules.STATIC_STANDARD, tooltip="Step-dependent scheduling algorithm for context windows."),
                io.Int.Input("context_stride", min=1, default=1, tooltip="The stride of the context window; only applicable to uniform schedules."),
                io.Boolean.Input("closed_loop", default=False, tooltip="Whether to close the context window loop; only applicable to looped schedules."),
                io.Combo.Input("fuse_method", options=comfy.context_windows.ContextFuseMethods.LIST_STATIC, default=comfy.context_windows.ContextFuseMethods.PYRAMID, tooltip="The method to use to fuse the context windows."),
                io.Int.Input("dim", min=0, max=5, default=0, tooltip="The dimension to apply the context windows to."),
                io.Boolean.Input("freenoise", default=False, tooltip="Whether to apply FreeNoise noise shuffling, improves window blending."),
                io.String.Input("cond_retain_index_list", default="", tooltip="List of latent indices to retain in the conditioning tensors for each window. For concat-style I2V models (e.g. Wan I2V, HunyuanVideo I2V, Cosmos I2V, SVD) the encoded start image lives in the c_concat conditioning channels; setting this to '0' will retain that start image content at sub-pos 0 of every window."),
                io.Boolean.Input("split_conds_to_windows", default=False, tooltip="Whether to split multiple conditionings (created by ConditionCombine) to each window based on region index."),
                io.String.Input("latent_retain_index_list", default="", tooltip="List of latent indices to retain in the noise latent itself for each window. Use for workflows where reference content (e.g. a start image) lives directly in the noise latent rather than in separate conditioning channels (e.g. inplace-style I2V like LTXV, AnimateDiff). Independent of cond_retain_index_list."),
                io.Boolean.Input("causal_window_fix", default=True, tooltip="Whether to add a causal fix frame to non-0-indexed context windows."),
            ],
            outputs=[
                io.Model.Output(tooltip="The model with context windows applied during sampling."),
            ],
            is_experimental=True,
        )

    @classmethod
    def execute(cls, model: io.Model.Type, context_length: int, context_overlap: int, context_schedule: str, context_stride: int, closed_loop: bool, fuse_method: str, dim: int, freenoise: bool,
                cond_retain_index_list: list[int]=[], split_conds_to_windows: bool=False, latent_retain_index_list: list[int]=[], causal_window_fix: bool=True) -> io.Model:
        model = model.clone()
        handler = comfy.context_windows.IndexListContextHandler(
            context_schedule=context_schedule if isinstance(context_schedule, comfy.context_windows.ContextSchedule) else comfy.context_windows.get_matching_context_schedule(context_schedule),
            fuse_method=comfy.context_windows.get_matching_fuse_method(fuse_method),
            context_length=context_length,
            context_overlap=context_overlap,
            context_stride=context_stride,
            closed_loop=closed_loop,
            dim=dim,
            freenoise=freenoise,
            cond_retain_index_list=cond_retain_index_list,
            split_conds_to_windows=split_conds_to_windows,
            latent_retain_index_list=latent_retain_index_list,
            causal_window_fix=causal_window_fix,
        )
        # (правка 1137) Колбэк перед каждым окном: чистим prefetch-очереди,
        # cast-буферы и watermark, иначе второе окно ловит OOM/дедлок aimdo.
        if getattr(cls, "window_vram_cleanup", False):
            try:
                callbacks = getattr(comfy.context_windows, "IndexListCallbacks", None)
                if callbacks is not None and hasattr(handler, "callbacks"):
                    # (правка 1137) ВАЖНО: структура — как у
                    # comfy.patcher_extension.add_callback (внешний ключ
                    # "callbacks"), иначе get_all_callbacks в обработчике окон
                    # находит пустой список и колбэк не вызывается.
                    import comfy.patcher_extension as _pe
                    _pe.add_callback(
                        callbacks.EVALUATE_CONTEXT_WINDOWS,
                        _studio_window_cleanup_callback,
                        handler.callbacks,
                    )
            except Exception as exc:
                LOG.warning("context windows: cleanup callback not registered: %s", exc)
        model.model_options["context_handler"] = handler
        # make memory usage calculation only take into account the context window latents
        comfy.context_windows.create_prepare_sampling_wrapper(model)
        if freenoise: # no other use for this wrapper at this time
            comfy.context_windows.create_sampler_sample_wrapper(model)
        return io.NodeOutput(model)

class WanContextWindowsManualNode(ContextWindowsManualNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        schema = super().define_schema()
        schema.node_id = "WanContextWindowsManual"
        schema.display_name = "WAN Context Windows (Manual)"
        schema.display_name = "Wan Context Windows"
        schema.description = "Set context windows for Wan-like models."
        schema.category="model/patch/wan"
        schema.inputs = [
            io.Model.Input("model", tooltip="The model to apply context windows to during sampling."),
                io.Int.Input("context_length", min=1, max=nodes.MAX_RESOLUTION, step=4, default=81, tooltip="The length of the context window in real frames. Must be 4*n + 1."),
                io.Int.Input("context_overlap", min=0, default=30, tooltip="The overlap of the context window in real frames."),
                io.Combo.Input("context_schedule", options=[
                    comfy.context_windows.ContextSchedules.STATIC_STANDARD,
                    comfy.context_windows.ContextSchedules.UNIFORM_STANDARD,
                    comfy.context_windows.ContextSchedules.UNIFORM_LOOPED,
                    comfy.context_windows.ContextSchedules.BATCHED,
                    ], default=comfy.context_windows.ContextSchedules.UNIFORM_STANDARD, tooltip="Step-dependent scheduling algorithm for context windows."),
                io.Int.Input("context_stride", min=1, default=1, tooltip="The stride of the context window; only applicable to uniform schedules.", advanced=True),
                io.Boolean.Input("closed_loop", default=False, tooltip="Whether to close the context window loop; only applicable to looped schedules.", advanced=True),
                io.Combo.Input("fuse_method", options=comfy.context_windows.ContextFuseMethods.LIST_STATIC, default=comfy.context_windows.ContextFuseMethods.PYRAMID, tooltip="The method to use to fuse the context windows."),
                io.Boolean.Input("freenoise", default=True, tooltip="Whether to apply FreeNoise noise shuffling, improves window blending.", advanced=True),
                io.Boolean.Input("retain_first_frame", default=False, tooltip="Retain the first I2V frame in every context window (may help retain initial reference)."),
                io.Boolean.Input("split_conds_to_windows", default=False, tooltip="Whether to split multiple conditionings (created by ConditionCombine) to each window based on region index.", advanced=True),
        ]
        return schema

    @classmethod
    def execute(cls, model: io.Model.Type, context_length: int, context_overlap: int, context_schedule: str, context_stride: int, closed_loop: bool, fuse_method: str, freenoise: bool,
                retain_first_frame: bool=False, split_conds_to_windows: bool=False) -> io.Model:
        context_length = max(((context_length - 1) // 4) + 1, 1) # at least length 1
        context_overlap = max(context_overlap // 4, 0)  # at least overlap 0
        retain_index_list = "0" if retain_first_frame else ""
        return super().execute(model, context_length, context_overlap, context_schedule, context_stride, closed_loop, fuse_method, dim=2, freenoise=freenoise, cond_retain_index_list=retain_index_list, split_conds_to_windows=split_conds_to_windows)


class LTXVContextWindowsNode(ContextWindowsManualNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        schema = super().define_schema()
        schema.node_id = "LTXVContextWindows"
        schema.display_name = "LTXV Context Windows"
        schema.description = "Set context windows for LTXV-like models."
        schema.category="model/patch/ltxv"
        schema.inputs = [
            io.Model.Input("model", tooltip="The model to apply context windows to during sampling."),
            io.Int.Input("context_length", min=1, max=nodes.MAX_RESOLUTION, step=8, default=145, tooltip="The length of the context window in real frames. Must be 8*n + 1."),
            io.Int.Input("context_overlap", min=0, step=8, default=40, tooltip="The overlap of the context window in real frames."),
            io.Combo.Input("context_schedule", options=[
                comfy.context_windows.ContextSchedules.STATIC_STANDARD,
                comfy.context_windows.ContextSchedules.UNIFORM_STANDARD,
                comfy.context_windows.ContextSchedules.UNIFORM_LOOPED,
                comfy.context_windows.ContextSchedules.BATCHED,
                ], default=comfy.context_windows.ContextSchedules.UNIFORM_STANDARD, tooltip="Step-dependent scheduling algorithm for context windows."),
            io.Int.Input("context_stride", min=1, default=1, tooltip="The stride of the context window; only applicable to uniform schedules.", advanced=True),
            io.Boolean.Input("closed_loop", default=False, tooltip="Whether to close the context window loop; only applicable to looped schedules.", advanced=True),
            io.Combo.Input("fuse_method", options=comfy.context_windows.ContextFuseMethods.LIST_STATIC, default=comfy.context_windows.ContextFuseMethods.PYRAMID, tooltip="The method to use to fuse the context windows."),
            io.Boolean.Input("freenoise", default=True, tooltip="Whether to apply FreeNoise noise shuffling, improves window blending.", advanced=True),
            io.Boolean.Input("retain_first_frame", default=False, tooltip="Retain the first latent frame in every context window (may help retain initial reference)."),
            io.Boolean.Input("split_conds_to_windows", default=False, tooltip="Whether to split multiple conditionings (created by ConditionCombine) to each window based on region index.", advanced=True),
        ]
        return schema

    @classmethod
    def execute(cls, model: io.Model.Type, context_length: int, context_overlap: int, context_schedule: str, fuse_method: str, freenoise: bool,
                retain_first_frame: bool=False, split_conds_to_windows: bool=False, context_stride: int=1, closed_loop: bool=False) -> io.Model:
        context_length = max(((context_length - 1) // 8) + 1, 1)  # at least length 1
        context_overlap = max(context_overlap // 8, 0)  # at least overlap 0
        retain_index_list = "0" if retain_first_frame else ""
        return super().execute(model, context_length, context_overlap, context_schedule, context_stride, closed_loop, fuse_method, dim=2, freenoise=freenoise,
                               cond_retain_index_list=retain_index_list, latent_retain_index_list=retain_index_list, split_conds_to_windows=split_conds_to_windows)


# (правка 1052) «Фазовая» статическая сетка окон для H3. Штатный
# create_windows_static_standard сдвигает последнее окно назад: из-за этого
# границы окон и «края» pyramid-веса всю диффузию стоят на одних местах, и
# систематический краевой брак окон (сильный denoise в Refine «частями»)
# не усредняется ничем и читается как мерцание к хвосту клипа. Здесь сетка
# выстраивается так, чтобы окно кончалось ровно на последнем кадре, а
# внутренние границы на каждом шаге сэмплирования сдвигаются на 5 токенов
# (цикл латента H3: 5 токенов = 17 кадров, старты окон остаются на
# 5-токенной фазе). ЧИСЛО ОКОН — ровно как у штатного графика: программа
# рассчитана на слабые ГПУ, ротация не должна стоить ни одного лишнего
# прогона модели.
def _h3_static_phased_windows(num_frames: int, handler, model_options: dict) -> list[list[int]]:
    length = handler.context_length
    if num_frames <= length:
        return [list(range(num_frames))]
    delta = length - handler.context_overlap
    last = num_frames - length
    # столько же окон, сколько у штатного STATIC_STANDARD
    k = -(-last // delta) + 1
    step = last / (k - 1)
    starts = [0]
    if k > 2:
        # фаза ограничена, чтобы разрыв между соседними окнами не превысил длину окна
        nph = min(20, int(length - step)) // 5 + 1
        phase = (handler._step % nph) * 5
        for i in range(1, k - 1):
            s = round((step * i + phase) / 5) * 5
            starts.append(max(starts[-1] + 5, min(s, last - 5)))
    starts.append(last)
    return [list(range(s, s + length)) for s in starts]


class MiniMaxH3ContextWindowsNode(ContextWindowsManualNode):
    # (правка 1137) Чистка aimdo между окнами H3 (см. _studio_window_vram_cleanup).
    window_vram_cleanup = True

    @classmethod
    def define_schema(cls) -> io.Schema:
        schema = super().define_schema()
        schema.node_id = "MiniMaxH3ContextWindows"
        schema.display_name = "MiniMax H3 Context Windows"
        schema.description = "Set context windows for MiniMax H3. Windows start on the model's 17-frame chunks to keep video and audio in sync."
        schema.category = "model/patch/minimax"
        schema.inputs = [
            io.Model.Input("model", tooltip="The model to apply context windows to during sampling."),
            io.Int.Input("context_length", min=22, max=nodes.MAX_RESOLUTION, step=17, default=124, tooltip="The length of the context window in real frames. Must be 17*n + 5."),
            io.Int.Input("context_overlap", min=5, step=17, default=39, tooltip="The overlap of the context window in real frames. Must be 17*n + 5."),
            io.Combo.Input("fuse_method", options=comfy.context_windows.ContextFuseMethods.LIST_STATIC, default=comfy.context_windows.ContextFuseMethods.PYRAMID, tooltip="The method to use to fuse the context windows."),
            io.Boolean.Input("freenoise", default=True, tooltip="Whether to apply FreeNoise noise shuffling, improves window blending.", advanced=True),
            io.Boolean.Input("split_conds_to_windows", default=False, tooltip="Whether to split multiple conditionings (created by ConditionCombine) to each window based on region index.", advanced=True),
        ]
        return schema

    @classmethod
    def execute(cls, model: io.Model.Type, context_length: int, context_overlap: int, fuse_method: str, freenoise: bool,
                split_conds_to_windows: bool=False) -> io.Model:
        # length and overlap of 5n + 2 latents start every static window on a chunk boundary
        context_length = video_latent_t(context_length)
        context_overlap = min(video_latent_t(context_overlap), context_length - 5)
        # (правка 1052) вместо штатного STATIC_STANDARD — «фазовая» сетка
        # (_h3_static_phased_windows): выравнивание по концу + сдвиг на 5
        # токенов каждый шаг, иначе хвост длинного Refine «частями» мерцает.
        schedule = comfy.context_windows.ContextSchedule("h3_static_phased", _h3_static_phased_windows)
        return super().execute(model, context_length, context_overlap, schedule, 1, False, fuse_method, dim=2, freenoise=freenoise,
                               split_conds_to_windows=split_conds_to_windows, causal_window_fix=False)


class ContextWindowsExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            ContextWindowsManualNode,
            WanContextWindowsManualNode,
            LTXVContextWindowsNode,
            MiniMaxH3ContextWindowsNode,
        ]

def comfy_entrypoint():
    return ContextWindowsExtension()
