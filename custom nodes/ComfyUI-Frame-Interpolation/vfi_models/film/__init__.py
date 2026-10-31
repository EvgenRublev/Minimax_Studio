# NOTE (MiniMax Studio): this file is maintained in the studio repo at
# "custom nodes/ComfyUI-Frame-Interpolation/vfi_models/film/__init__.py" and
# copied over the GitHub clone by install.ps1. Local changes: eager FILM model
# load (_load_film_eager + film_arch.SamePadConv) and (fix 786) interrupt
# checkpoints in the FILM frame loop — the original code had none, so the
# "Cancel" button did nothing until the whole node finished.
import torch
from comfy.model_management import get_torch_device, soft_empty_cache
# (fix 786) FILM has its own frame loop (it does not use generic_frame_loop),
# and the original code had no interruption points inside it — so "Cancel" did
# nothing until the whole node finished. Check between frame pairs now.
from comfy.model_management import throw_exception_if_processing_interrupted
import bisect
import numpy as np
import typing
from vfi_utils import InterpolationStateList, load_file_from_github_release, preprocess_frames, postprocess_frames
import pathlib
import gc

from . import film_arch

MODEL_TYPE = pathlib.Path(__file__).parent.name
DEVICE = get_torch_device()
def _load_film_eager(model_path):
    """Load the TorchScript weights into the eager, explicitly-padded model."""
    scripted = torch.jit.load(model_path, map_location='cpu')
    model = film_arch.Interpolator()
    samepad = {
        name for name, module in model.named_modules()
        if isinstance(module, film_arch.SamePadConv)
    }
    state = {}
    for key, value in scripted.state_dict().items():
        if key.endswith(('.weight', '.bias')):
            base, suffix = key.rsplit('.', 1)
            if base in samepad:
                key = f'{base}.conv.{suffix}'
        state[key] = value
    model.load_state_dict(state)
    model.eval()
    return model


def inference(model, img_batch_1, img_batch_2, inter_frames):
    results = [
        img_batch_1,
        img_batch_2
    ]

    idxes = [0, inter_frames + 1]
    remains = list(range(1, inter_frames + 1))

    splits = torch.linspace(0, 1, inter_frames + 2)

    for _ in range(len(remains)):
        throw_exception_if_processing_interrupted()  # (fix 786)
        starts = splits[idxes[:-1]]
        ends = splits[idxes[1:]]
        distances = ((splits[None, remains] - starts[:, None]) / (ends[:, None] - starts[:, None]) - .5).abs()
        matrix = torch.argmin(distances).item()
        start_i, step = np.unravel_index(matrix, distances.shape)
        end_i = start_i + 1

        x0 = results[start_i].to(DEVICE)
        x1 = results[end_i].to(DEVICE)
        dt = x0.new_full((1, 1), (splits[remains[step]] - splits[idxes[start_i]])) / (splits[idxes[end_i]] - splits[idxes[start_i]])

        with torch.no_grad():
            prediction = model(x0, x1, dt)
        insert_position = bisect.bisect_left(idxes, remains[step])
        idxes.insert(insert_position, remains[step])
        results.insert(insert_position, prediction.clamp(0, 1).float())
        del remains[step]

    return [tensor.flip(0) for tensor in results]

class FILM_VFI:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "ckpt_name": (["film_net_fp32.pt"], ),
                "frames": ("IMAGE", ),
                "clear_cache_after_n_frames": ("INT", {"default": 10, "min": 1, "max": 1000}),
                "multiplier": ("INT", {"default": 2, "min": 2, "max": 1000}),
            },
            "optional": {
                "optional_interpolation_states": ("INTERPOLATION_STATES", )
            }
        }
    
    RETURN_TYPES = ("IMAGE", )
    FUNCTION = "vfi"
    CATEGORY = "ComfyUI-Frame-Interpolation/VFI"        

    def vfi(
        self,
        ckpt_name: typing.AnyStr,
        frames: torch.Tensor,
        clear_cache_after_n_frames = 10,
        multiplier: typing.SupportsInt = 2,
        optional_interpolation_states: InterpolationStateList = None,
        **kwargs
    ):
        interpolation_states = optional_interpolation_states
        model_path = load_file_from_github_release(MODEL_TYPE, ckpt_name)
        model = _load_film_eager(model_path).to(DEVICE)
        dtype = torch.float32

        frames = preprocess_frames(frames)
        number_of_frames_processed_since_last_cleared_cuda_cache = 0
        output_frames = []
        
        if type(multiplier) == int:
            multipliers = [multiplier] * len(frames)
        else:
            multipliers = list(map(int, multiplier))
            multipliers += [2] * (len(frames) - len(multipliers) - 1)
        for frame_itr in range(len(frames) - 1): # Skip the final frame since there are no frames after it
            throw_exception_if_processing_interrupted()  # (fix 786)
            if interpolation_states is not None and interpolation_states.is_frame_skipped(frame_itr):
                continue
            #Ensure that input frames are in fp32 - the same dtype as model
            frame_0 = frames[frame_itr:frame_itr+1].to(DEVICE).float()
            frame_1 = frames[frame_itr+1:frame_itr+2].to(DEVICE).float()
            relust = inference(model, frame_0, frame_1, multipliers[frame_itr] - 1)
            output_frames.extend([frame.detach().cpu().to(dtype=dtype) for frame in relust[:-1]])

            number_of_frames_processed_since_last_cleared_cuda_cache += 1
            # Try to avoid a memory overflow by clearing cuda cache regularly
            if number_of_frames_processed_since_last_cleared_cuda_cache >= clear_cache_after_n_frames:
                print("Comfy-VFI: Clearing cache...", end = ' ')
                soft_empty_cache()
                number_of_frames_processed_since_last_cleared_cuda_cache = 0
                print("Done cache clearing")
            gc.collect()
        
        output_frames.append(frames[-1:].to(dtype=dtype)) # Append final frame
        output_frames = [frame.cpu() for frame in output_frames] #Ensure all frames are in cpu
        out = torch.cat(output_frames, dim=0)
        # clear cache for courtesy
        print("Comfy-VFI: Final clearing cache...", end = ' ')
        soft_empty_cache()
        print("Done cache clearing")
        return (postprocess_frames(out), )
