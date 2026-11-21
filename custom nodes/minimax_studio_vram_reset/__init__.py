"""MiniMax Studio (правки 1055, 1061): нода-сброс VRAM между стадиями H3.

Зачем: DynamicVRAM (comfy-aimdo) оставляет веса моделей резидентными между
стадиями/сегментами одного прогона. В длинных многоклиповых задачах (продление,
двухпроходная генерация, refine) резидентность деградирует: страницы VBAR
вытесняются и перекачиваются по кругу (апстрим comfy-aimdo #117/#118/#133) -
генерация «висит» минутами при 100% утилизации GPU на ~60 Вт и забитой VRAM.
В README aimdo прямо рекомендовано полностью флашить кеш аллокатора перед
каждым новым прогоном модели; авторы #118 убрали висельники именно
unload_all_models + empty_cache между сегментами.

Правка 1061. Апстрим-разбор comfy-aimdo#117 дочитал механизм до конца:
vbar_fault() проверяет watermark ДО проверки резидентности, а watermark
восстанавливает только vbar_prioritize() - который ядро вызывает при ЗАГРУЗКЕ
модели. То есть модель, пережившая предыдущий сэмпл, остаётся с дренажнутым
watermark, и первый же re-fault (Refine после генерации!) возвращает OOM и
дедлокается в hostbuf_file_reader_read (старт висит на 0/.. «Model
Initializing»). Ядро чинит это блоком finally в execution.py
(cleanup_prefetch_queues + reset_cast_buffers + vbars_reset_watermark_limits),
но он выполняется ПОСЛЕ ноды, а не перед первым fault'ом следующей. Ноды,
которые держат несколько сегментов внутри одного execute (Loop, Tessera,
продление) вообще получают его один раз на весь прогон. Поэтому сброс делает
всё четыре действия ПЕРЕД тяжёлой стадией: полный unload (при следующей
загрузке prioritize поднимет watermark), очистка очередей пре-фетча (именно
они пинят страницы - доказанный фикс #117), сброс cast-буферов и лимитов
watermark. Все вызовы с guard'ами - на старых core/aimdo просто пропускаются.

MiniMaxStudioVRAMReset стоит разрывом на линии латента (вход = выход, тот же
объект) и при исполнении выгружает все модели и чистит кеш аллокатора.
Ставится в шаблоне: перед Refine-сэмплером (1061 - рефайн обычно идёт сразу
за генерацией и ловит re-fault на дренажнутом watermark), после сэмплера
перед separate/decode (освободить DiT под всплеск VAE-декода и NVENC) и между
клипами продления (сбросить резидентность перед следующим сегментом).
"""

import logging

import torch

import comfy.model_management as mm

LOG = logging.getLogger(__name__)


def aimdo_usage(device):
    """Сколько VRAM реально занимает aimdo (байты), если DynamicVRAM активен."""
    try:
        import comfy_aimdo.control as aimdo
        lib = getattr(aimdo, "lib", None)
        if lib is None:
            return None
        idx = getattr(device, "index", None)
        if idx is None:
            return None
        ctx = aimdo.get_devctx(int(idx))
        if not ctx:
            return None
        return int(lib.get_total_vram_usage(ctx))
    except Exception:
        return None


def _gb(x):
    # Лог ComfyUI на Windows открыт в cp1251: только кириллица/ASCII, без стрелок.
    return "%.2f GB" % (x / 1024 ** 3)


def core_cleanups():
    """(правка 1061) Тот же блок, что делает finally ядра в execution.py
    после КАЖДОЙ ноды: cleanup_prefetch_queues -> reset_cast_buffers ->
    vbars_reset_watermark_limits. Очереди пре-фетча держат ссылки на блоки
    весов и пинят VBAR-страницы (pin_count), из-за чего free_memory дренирует
    watermark в ноль, а vbar_fault после этого возвращает OOM, не глядя на
    резидентность (comfy-aimdo#117). Внутри многосегментных нод этот блок не
    выполняется между сегментами вовсе - делаем его сами. Возвращает список
    имён выполненных действий для лога. На старых core/aimdo отсутствующие
    функции молча пропускаются."""
    done = []
    try:
        import comfy.model_prefetch as mp
        fn = getattr(mp, "cleanup_prefetch_queues", None)
        if fn is not None:
            fn()
            done.append("prefetch_queues")
    except Exception:
        pass
    try:
        fn = getattr(mm, "reset_cast_buffers", None)
        if fn is not None:
            fn()
            done.append("cast_buffers")
    except Exception:
        pass
    try:
        # Нативные vbar-вызовы опасны без инициализированного DynamicVRAM
        # (могут грохнуть процесс, try/except тут не спасает) - повторяем
        # гейт ядра: только когда aimdo реально активен.
        import comfy.memory_management as mem
        if getattr(mem, "aimdo_enabled", False):
            import comfy_aimdo.model_vbar as vbar
            fn = getattr(vbar, "vbars_reset_watermark_limits", None)
            if fn is not None:
                fn()
                done.append("watermark_limits")
    except Exception:
        pass
    return done


class MiniMaxStudioVRAMReset:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "flow": ("LATENT",),
            },
            "optional": {
                "label": ("STRING", {"default": "", "multiline": False,
                                     "tooltip": "Метка в лог (например 'clip 2') - пусто = без метки."}),
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("flow",)
    FUNCTION = "reset"
    CATEGORY = "MiniMax Studio"
    DESCRIPTION = ("Flush VRAM between H3 stages: unload all models + empty the caching "
                   "allocator. Passes the latent through unchanged. Put it on the latent "
                   "link after each sampler pass / between extend clips to avoid the "
                   "DynamicVRAM residency stalls (comfy-aimdo #117/#118/#133).")

    def reset(self, flow, label=""):
        dev = mm.get_torch_device()
        try:
            free_before = mm.get_free_memory(dev)
        except Exception:
            free_before = -1
        used = aimdo_usage(dev)
        try:
            loaded = len(mm.current_loaded_models)
        except Exception:
            loaded = -1
        tag = (" [%s]" % label) if label else ""

        # Очереди пре-фетча пинят VBAR-страницы, поэтому их чистим ДО unload:
        # иначе unload дренирует watermark, а fault'ы следующего прогона
        # вернут OOM (comfy-aimdo#117).
        cleaned = core_cleanups()
        mm.unload_all_models()
        mm.soft_empty_cache()
        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

        try:
            free_after = mm.get_free_memory(dev)
        except Exception:
            free_after = -1
        # Диагностика для юзеров: до/после видно по-настоящему. aimdo usage -
        # сколько держит DynamicVRAM; если после сброса почти не упала, значит
        # память удерживают НЕ модели (чужие процессы/утечка в ядре).
        LOG.info(
            "MiniMax Studio VRAM Reset%s: моделей до сброса %d, свободно %s, aimdo держит %s; "
            "после: свободно %s (+%s); очистки: %s",
            tag, loaded, _gb(max(0, free_before)),
            "нет данных" if used is None else _gb(used),
            _gb(max(0, free_after)),
            _gb(max(0, free_after - free_before)),
            ", ".join(cleaned) if cleaned else "нет (старый core/aimdo)")
        return (flow,)


NODE_CLASS_MAPPINGS = {
    "MiniMaxStudioVRAMReset": MiniMaxStudioVRAMReset,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxStudioVRAMReset": "MiniMax Studio · VRAM Reset",
}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
