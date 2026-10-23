"""MiniMax Studio: обрезка аудио-референсов без создания копий файла.

LoadAudio возвращает AUDIO = {"waveform": tensor [batch, channels, samples],
"sample_rate": int}. Нода просто срезает тензор по секундам — обрезанный
фрагмент уходит в рефы модели, а исходный файл в input/ не трогается.
"""


class MiniMaxStudioAudioTrim:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO",),
                "start_seconds": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 3600.0, "step": 0.01}),
                # 0 = до конца файла
                "end_seconds": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 3600.0, "step": 0.01}),
            }
        }

    RETURN_TYPES = ("AUDIO",)
    FUNCTION = "trim"
    CATEGORY = "MiniMax Studio"
    DESCRIPTION = "Trim audio by seconds (start/end, 0 end = to EOF). No file copies."

    def trim(self, audio, start_seconds, end_seconds):
        waveform = audio["waveform"]
        sample_rate = audio["sample_rate"]
        total = waveform.shape[-1]
        start = max(0, min(total, int(round(start_seconds * sample_rate))))
        end = total if end_seconds <= 0 else max(start, min(total, int(round(end_seconds * sample_rate))))
        return ({"waveform": waveform[..., start:end], "sample_rate": sample_rate},)


class MiniMaxStudioAudioGain:
    """(правка 694) Громкость аудио-референса: умножение волнового тензора на gain.

    Виртуально (как MiniMaxStudioAudioTrim) — без копий файла. gain=1.0 = без изменений.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO",),
                "gain": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 4.0, "step": 0.01}),
            }
        }

    RETURN_TYPES = ("AUDIO",)
    FUNCTION = "apply_gain"
    CATEGORY = "MiniMax Studio"
    DESCRIPTION = "Scale audio waveform by gain (virtual, no file copies). gain=1.0 = unchanged."

    def apply_gain(self, audio, gain):
        waveform = audio["waveform"]
        sample_rate = audio["sample_rate"]
        g = float(gain)
        if not (g == g) or g < 0.0:  # NaN guard
            g = 1.0
        if abs(g - 1.0) < 1.0e-8:
            return ({"waveform": waveform, "sample_rate": sample_rate},)
        return ({"waveform": waveform * g, "sample_rate": sample_rate},)


NODE_CLASS_MAPPINGS = {"MiniMaxStudioAudioTrim": MiniMaxStudioAudioTrim, "MiniMaxStudioAudioGain": MiniMaxStudioAudioGain}
NODE_DISPLAY_NAME_MAPPINGS = {"MiniMaxStudioAudioTrim": "Audio Trim (Minimax Studio)", "MiniMaxStudioAudioGain": "Audio Gain (Minimax Studio)"}
