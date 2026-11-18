"""Smoke-тест MiniMaxStudioVRAMReset на CPU (правка 1055): импорт, регистрация,
прокидывание латента без изменений, корректные вызовы model_management."""
import sys, os, importlib

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "ComfyUI"))          # пакет comfy
sys.path.insert(0, os.path.join(ROOT, "custom nodes"))    # сама нода

import torch
m = importlib.import_module("minimax_studio_vram_reset")

assert "MiniMaxStudioVRAMReset" in m.NODE_CLASS_MAPPINGS
cls = m.NODE_CLASS_MAPPINGS["MiniMaxStudioVRAMReset"]
spec = cls.INPUT_TYPES()
assert spec["required"]["flow"][0] == "LATENT"
assert cls.RETURN_TYPES == ("LATENT",)
assert cls.FUNCTION == "reset"
print("INPUT_TYPES/RETURN_TYPES OK")

# фикк model_management: считаем счётчики, проверяем что reset дёргает разгрузку
import comfy.model_management as mm
calls = {"unload": 0, "soft": 0}
_orig_unload, _orig_soft = mm.unload_all_models, mm.soft_empty_cache
mm.unload_all_models = lambda: calls.__setitem__("unload", calls["unload"] + 1)
mm.soft_empty_cache = lambda *a, **k: calls.__setitem__("soft", calls["soft"] + 1)

lat = {"samples": torch.zeros(1, 2, 7, 4, 4)}
out = cls().reset(lat, label="smoke")
mm.unload_all_models, mm.soft_empty_cache = _orig_unload, _orig_soft
assert isinstance(out, tuple) and len(out) == 1
assert out[0] is lat, "лата должен прокидываться тем же объектом"
assert calls == {"unload": 1, "soft": 1}, calls
print("reset OK: латент прокинут, unload_all_models=%d soft_empty_cache=%d" % (calls["unload"], calls["soft"]))

# aimdo_usage не должен падать, когда DynamicVRAM не инициализирован
dev = mm.get_torch_device()
u = m.aimdo_usage(dev)
print("aimdo_usage (неинициализированный aimdo) =", u, "— без исключения")
print("\nВСЁ ОК")
