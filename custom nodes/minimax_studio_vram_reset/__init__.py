"""MiniMax Studio (правка 1055): нода-сброс VRAM между стадиями H3.

Зачем: DynamicVRAM (comfy-aimdo) оставляет веса моделей резидентными между
стадиями/сегментами одного прогона. В длинных многоклиповых задачах (продление,
двухпроходная генерация, refine) резидентность деградирует: страницы VBAR
вытесняются и перекачиваются по кругу (апстрим comfy-aimdo #117/#118/#133) -
генерация «висит» минутами при 100% утилизации GPU на ~60 Вт и забитой VRAM.
В README aimdo прямо рекомендовано полностью флашить кеш аллокатора перед
каждым новым прогоном модели; авторы #118 убрали висельники именно
unload_all_models + empty_cache между сегментами.

MiniMaxStudioVRAMReset стоит разрывом на линии латента (вход = выход, тот же
объект) и при исполнении выгружает все модели и чистит кеш аллокатора.
Ставится в шаблоне: после сэмплера перед separate/decode (освободить DiT под
всплеск VAE-декода и NVENC) и между клипами продления (сбросить резидентность
перед следующим сегментом).
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
            "после: свободно %s (+%s)",
            tag, loaded, _gb(max(0, free_before)),
            "нет данных" if used is None else _gb(used),
            _gb(max(0, free_after)),
            _gb(max(0, free_after - free_before)))
        return (flow,)


NODE_CLASS_MAPPINGS = {
    "MiniMaxStudioVRAMReset": MiniMaxStudioVRAMReset,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxStudioVRAMReset": "MiniMax Studio · VRAM Reset",
}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
