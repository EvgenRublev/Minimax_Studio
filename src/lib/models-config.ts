/**
 * Model registry — defines all required models with their download URLs
 * and target paths relative to the ComfyUI root.
 */

export interface ModelDef {
  id: string
  label: string
  /** Relative path from ComfyUI root (e.g. "diffusion_models/xxx.safetensors") */
  relPath: string
  /** Direct download URL */
  url: string
  /**
   * Точный размер файла в БАЙТАХ.
   *
   * ВАЖНО: это ровно то значение `content-length`, которое отдаёт сервер
   * (проверено HEAD-запросом), а не округлённое «N ГБ». Размер нужен для
   * двух проверок в model-downloader.ts:
   *   • sizeOk()      — файл считается скачанным, если отличается от
   *                      ожидаемого не более чем на ±10%;
   *   • doDownload()  — недокачанным считается файл с completion < 0.9.
   *
   * Раньше здесь стояло `gb(N)` = N × 2³⁰ (двоичные ГБ), а размеры были
   * переписаны из интерфейса HuggingFace, где ГБ десятичные (10⁹). Разница
   * 7,4% съедала запас: у `llm_assistant_q5` до порога 0.9 оставалось всего
   * 1,1 п.п., и полностью скачанный файл мог быть объявлен неполным.
   * Теперь expected == фактическому размеру байт в байт.
   */
  sizeBytes: number
  /** Human-readable size */
  sizeLabel: string
  /** (правка 269) Category for grouping in UI */
  category: 'diffusion' | 'text_encoder' | 'vae' | 'lora' | 'upscaler' | 'preview' | 'llm' | 'fps' | 'veda' | 'preprocessor' | 'face'
  /** (правка 138 / Bonsai / 269) Куда класть файл: 'comfy' (по умолчанию —
   *  ComfyUI/models/<relPath>), 'bonsai' (<bonsai_dir>/<relPath>) или
   *  'custom' (<baseDir>/<relPath> — произвольный каталог, например
   *  папка моделей кастомной ноды). */
  target?: 'comfy' | 'bonsai' | 'custom'
  /** (правка 269) Абсолютный корневой каталог при target='custom'. */
  baseDir?: string
  /** (правка 138 / Bonsai) URL указывает на ZIP: после скачивания извлечь
   *  ТОЛЬКО эти файлы (рекурсивный поиск по архиву) в каталог relPath. */
  extractFiles?: string[]
  /** (правка 138) Опциональная модель: панель показывает, но «Скачать все»
   *  НЕ тянет (лишние гигабайты без ведома пользователя). */
  optional?: boolean
}

export const MODELS: ModelDef[] = [
  {
    id: 'diffusion',
    // (правка 293) Основная модель — вернули обратно (была лучше по качеству).
    // Kijai/MiniMax-H3-experimental. 4-шаговая генерация (FastH3 VSA DataFree), ~22.9 ГБ.
    label: 'Diffusion Model (FastH3 VSA DataFree 4-step INT8 ConvRot)',
    relPath: 'diffusion_models/minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors',
    url: 'https://huggingface.co/Kijai/MiniMax-H3-experimental/resolve/main/minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors?download=true',
    sizeBytes: 22898594920,
    sizeLabel: '~22.9 GB',
    category: 'diffusion',
  },
  {
    id: 'text_encoder',
    label: 'Text Encoder (Qwen3VL 32B NVFP4)',
    relPath: 'text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    url: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors?download=true',
    sizeBytes: 15687142551,
    sizeLabel: '~15.7 GB',
    category: 'text_encoder',
  },
  {
    id: 'vae_video',
    label: 'Video VAE (INT8 ConvRot)',
    relPath: 'vae/minimax_h3_video_vae_int8_convrot.safetensors',
    url: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_int8_convrot.safetensors?download=true',
    sizeBytes: 2811065184,
    sizeLabel: '~2.8 GB',
    category: 'vae',
  },
  {
    id: 'vae_audio',
    label: 'Audio VAE (FP32)',
    relPath: 'vae/minimax_h3_audio_vae_fp32.safetensors',
    url: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors?download=true',
    sizeBytes: 605254808,
    sizeLabel: '~0.6 GB',
    category: 'vae',
  },
  {
    id: 'lora_turbo',
    label: 'Turbo LoRA (4-step v0.1)',
    relPath: 'loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
    url: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors?download=true',
    sizeBytes: 1956193000,
    sizeLabel: '~1.8 GB',
    category: 'lora',
    // (правка 720) Опциональная: турбо-лора убрана из пайплайна генерации
    // (правки 578/587 — turboLoraOn = false, кастомные LoRA подключаются
    // напрямую к modelSrc). Файл остаётся в реестре и его можно скачать
    // вручную одной кнопкой, но «Скачать все» его не тянет, и жёлтый
    // баннер «модели не скачаны» его не требует.
    optional: true,
  },
  {
    id: 'upscaler',
    label: 'Latent Upscaler 3D (FP16)',
    relPath: 'latent_upscale_models/minimax_h3_latent_upscaler_3d_fp16.safetensors',
    url: 'https://huggingface.co/LBH-123-AI/Minimax_h3_latent_Upscaler/resolve/main/minimax_h3_latent_upscaler_3d_conv_v1/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors?download=true',
    sizeBytes: 690592672,
    sizeLabel: '~691 MB',
    category: 'upscaler',
  },
  {
    id: 'tae_preview',
    label: 'TAE Preview Decoder (taeh3)',
    relPath: 'vae_approx/taeh3.safetensors',
    url: 'https://huggingface.co/Kijai/MiniMax-H3-TAE/resolve/main/vae_approx/taeh3.safetensors?download=true',
    sizeBytes: 9791388,
    sizeLabel: '~9.8 MB',
    category: 'preview',
  },
  {
    id: 'llm_assistant',
    label: 'Ассистент — Gemma 4 12B (Q4_K_M, omni)',
    relPath: 'llm/gemma-4-12b-it-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/main/gemma-4-12b-it-Q4_K_M.gguf?download=true',
    sizeBytes: 7121861440,
    sizeLabel: '~7.1 GB',
    category: 'llm',
  },
  {
    id: 'llm_assistant_q3',
    label: 'Ассистент — Gemma 4 12B (Q3_K_M, лёгкая, ~8 ГБ VRAM)',
    relPath: 'llm/gemma-4-12b-it-Q3_K_M.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/main/gemma-4-12b-it-Q3_K_M.gguf?download=true',
    sizeBytes: 5693872960,
    sizeLabel: '~5.7 GB',
    category: 'llm',
  },
  {
    id: 'llm_assistant_q5',
    label: 'Ассистент — Gemma 4 12B (Q5_K_M, качество, ~12 ГБ VRAM)',
    relPath: 'llm/gemma-4-12b-it-Q5_K_M.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/main/gemma-4-12b-it-Q5_K_M.gguf?download=true',
    sizeBytes: 8413576000,
    sizeLabel: '~8.4 GB',
    category: 'llm',
  },
  {
    id: 'llm_assistant_mmproj',
    label: 'Vision Projector (mmproj BF16) — для зрения LLM',
    relPath: 'llm/mmproj-BF16.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/main/mmproj-BF16.gguf?download=true',
    sizeBytes: 175115840,
    sizeLabel: '~175 MB',
    category: 'llm',
  },
  // ── Qwen3.5 9B (правка 52) — альтернативная LLM для слабых машин: ──
  // мультимодальная (картинка + видео), ~5.7 ГБ Q4 против 7.1 у Gemma 12B,
  // гибрид Gated DeltaNet → экономнее по KV-кэшу. Нужен свежий llama.cpp
  // (архитектура qwen35) — пользователь тестирует на своём железе.
  // Файлы в подпапке llm/qwen3.5-9b/, чтобы не конфликтовать с Gemma.
  {
    id: 'llm_assistant_qwen',
    label: 'Ассистент — Qwen3.5 9B (Q4_K_M, vision, лёгкая по VRAM)',
    relPath: 'llm/qwen3.5-9b/Qwen3.5-9B-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf?download=true',
    sizeBytes: 5680522464,
    sizeLabel: '~5.7 GB',
    category: 'llm',
  },
  {
    id: 'llm_assistant_qwen_mmproj',
    label: 'Vision Projector (Qwen3.5 mmproj F16) — зрение для Qwen3.5 9B',
    relPath: 'llm/qwen3.5-9b/mmproj-F16.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/mmproj-F16.gguf?download=true',
    sizeBytes: 918166080,
    sizeLabel: '~918 MB',
    category: 'llm',
  },
  // ── (правка 138) Bonsai 2 27B — тернарная LLM-ассистент на форке llama.cpp
  // (PrismML). Движок и модели живут в <bonsai_dir> (по умолчанию
  // <проект>/Bonsai_2_27B), НЕ в models ComfyUI. Точная версия движка
  // подобрана под кванты модели (prism-b10709-9a9394a, CUDA 12.4).
  {
    id: 'bonsai_engine_bin',
    label: 'Bonsai: движок llama-server (PrismML b10709, бинарники)',
    relPath: 'llama.cpp/',
    target: 'bonsai',
    url: 'https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b10709-9a9394a/llama-prism-b10709-9a9394a-bin-win-cuda-12.4-x64.zip',
    sizeBytes: 253442371,
    sizeLabel: '~242 MB',
    category: 'llm',
    extractFiles: [
      'llama-server.exe',
      'llama-server-impl.dll',
      'llama-common.dll',
      'llama.dll',
      'mtmd.dll',
      'ggml.dll',
      'ggml-base.dll',
      'ggml-cpu.dll',
      'ggml-cuda.dll',
      'ggml-rpc.dll',
    ],
  },
  {
    id: 'bonsai_engine_cudart',
    label: 'Bonsai: движок — CUDA DLL (cublas/cudart 12.4)',
    relPath: 'llama.cpp/',
    target: 'bonsai',
    url: 'https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b10709-9a9394a/cudart-llama-bin-win-cuda-12.4-x64.zip',
    sizeBytes: 391443627,
    sizeLabel: '~373 MB',
    category: 'llm',
    extractFiles: ['cublas64_12.dll', 'cublasLt64_12.dll', 'cudart64_12.dll'],
  },
  {
    id: 'bonsai_model',
    label: 'Bonsai 2 27B — модель (PQ2_0, тернарная, vision)',
    relPath: 'models/Ternary-Bonsai-2-27B-PQ2_0.gguf',
    target: 'bonsai',
    url: 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/main/Ternary-Bonsai-2-27B-PQ2_0.gguf?download=true',
    sizeBytes: 7206168928,
    sizeLabel: '~7.2 GB',
    category: 'llm',
  },
  {
    id: 'bonsai_mmproj',
    label: 'Bonsai 2 27B — Vision Projector (mmproj Q8_0)',
    relPath: 'models/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf',
    target: 'bonsai',
    url: 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/main/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf?download=true',
    sizeBytes: 629246976,
    sizeLabel: '~630 MB',
    category: 'llm',
  },
  // ── (правка 269) FPS (frame interpolation, VFI) — вкладка «FPS». ──
  // Пакет Fannovel16/ComfyUI-Frame-Interpolation ищет модели НЕ в
  // ComfyUI/models, а в своей папке custom_nodes/.../ckpts/<тип>/<файл>
  // (ckpts_path из config.yaml). Поэтому target='custom' + baseDir.
  // По одной модели на режим (решение пользователя): RIFE → rife49.pth,
  // FILM → film_net_fp32.pt. Скачиваются в Настройках → Модели, а не при
  // первом запуске генерации (пакет сам докачает при запуске — fallback).
  {
    id: 'fps_rife',
    label: 'FPS RIFE VFI — rife49.pth',
    relPath: 'rife/rife49.pth',
    target: 'custom',
    baseDir: 'ComfyUI/custom_nodes/ComfyUI-Frame-Interpolation/ckpts',
    url: 'https://huggingface.co/marduk191/rife/resolve/main/rife49.pth',
    sizeBytes: 21345274,
    sizeLabel: '~21.3 MB',
    category: 'fps',
  },
  {
    id: 'fps_film',
    label: 'FPS FILM VFI — film_net_fp32.pt',
    relPath: 'film/film_net_fp32.pt',
    target: 'custom',
    baseDir: 'ComfyUI/custom_nodes/ComfyUI-Frame-Interpolation/ckpts',
    url: 'https://github.com/dajes/frame-interpolation-pytorch/releases/download/v1.0.0/film_net_fp32.pt',
    sizeBytes: 137905674,
    sizeLabel: '~132 MB',
    category: 'fps',
  },
  // ── (правка 301) Veda Sparse Attention — предиктор спарсификации. ──
  // Обученный предиктор (Veda-Sparse/Minimax-H3-T2VA-Veda-8NFE-600Step-Preview)
  // для VedaSparseAttention ноды. Файл лежит в ComfyUI/models/veda/.
  // Опциональная: нужна ТОЛЬКО если пользователь включил Veda в настройках.
  {
    id: 'veda_predictor',
    label: 'Veda Sparse Attention — предиктор (FP8)',
    relPath: 'veda/minimax_h3_t2va_veda_8nfe_600step_preview_fp8.safetensors',
    url: 'https://huggingface.co/Veda-Sparse/Minimax-H3-T2VA-Veda-8NFE-600Step-Preview/resolve/main/minimax_h3_t2va_veda_8nfe_600step_preview_fp8.safetensors?download=true',
    sizeBytes: 275415648,
    sizeLabel: '~275 MB',
    category: 'veda',
    optional: true,
  },
  // Depth-препроцессор вкладки «ControlNet» (Depth Anything V2 Small).
  // Нода comfyui_controlnet_aux ищет его в СВОЕЙ папке ckpts/<repo>/<файл>
  // (custom_hf_download), НЕ в ComfyUI/models — поэтому target='custom'.
  {
    id: 'depth_anything_v2_vits',
    label: 'Depth Anything V2 Small (препроцессор глубины)',
    relPath: 'depth_anything_v2_vits.pth',
    target: 'custom',
    baseDir: 'ComfyUI/custom_nodes/comfyui_controlnet_aux/ckpts/depth-anything/Depth-Anything-V2-Small',
    url: 'https://huggingface.co/depth-anything/Depth-Anything-V2-Small/resolve/main/depth_anything_v2_vits.pth?download=true',
    sizeBytes: 99218434,
    sizeLabel: '~99 MB',
    category: 'preprocessor',
    optional: true,
  },
  // ── (правка 722) Face Refine — детекторы лиц для вкладки «Face Refine». ──
  // Пакет ComfyUI-H3-FaceRefine ищет модели детекции в models/ultralytics/bbox
  // (fallback в самой ноде, если папка не зарегистрирована в ComfyUI как
  // категория). face_yolov8m — детектор лиц, person_yolov8m-seg — человек
  // целиком (fallback-детектор для далёких планов, где лицо не видно).
  {
    id: 'face_yolov8m',
    label: 'Face Refine — детектор лиц (face_yolov8m)',
    relPath: 'ultralytics/bbox/face_yolov8m.pt',
    url: 'https://huggingface.co/Bingsu/adetailer/resolve/main/face_yolov8m.pt',
    sizeBytes: 52026019,
    sizeLabel: '~50 MB',
    category: 'face',
    optional: true,
  },
  {
    id: 'person_yolov8m_seg',
    label: 'Face Refine — детектор человека (person_yolov8m-seg)',
    relPath: 'ultralytics/segm/person_yolov8m-seg.pt',
    url: 'https://huggingface.co/Bingsu/adetailer/resolve/main/person_yolov8m-seg.pt',
    sizeBytes: 54827683,
    sizeLabel: '~52 MB',
    category: 'face',
    optional: true,
  },
  {
    id: 'bonsai_model_light',
    label: 'Bonsai 2 27B — модель (PTQ1_0, самая лёгкая, ~6 ГБ, для карт ≤8 ГБ)',
    relPath: 'models/Ternary-Bonsai-2-27B-PTQ1_0.gguf',
    target: 'bonsai',
    url: 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/main/Ternary-Bonsai-2-27B-PTQ1_0.gguf?download=true',
    // (правка 169) Реальный размер PTQ1_0 = 5.95 ГБ (HuggingFace model card).
    // Было 595 MB → не проходил modelExists(); было 6.2 → не проходил
    // финальную валидацию в doDownload (5.95/6.2 = 0.91, но с погрешностью
    // округления HuggingFace иногда отдаёт чуть меньше → <0.9 → ошибка).
    sizeBytes: 5946648928,
    sizeLabel: '~5.95 GB',
    category: 'llm',
    // Опциональная: качается только вручную; раннер подхватит её, если
    // основной PQ2_0 не скачан, а PTQ1_0 есть.
    optional: true,
  },
]

/** Group by category for UI display */
export const MODEL_CATEGORIES: { key: ModelDef['category']; label: string }[] = [
  { key: 'diffusion', label: 'Diffusion Model' },
  { key: 'text_encoder', label: 'Text Encoder' },
  { key: 'vae', label: 'VAE' },
  { key: 'lora', label: 'LoRA' },
  { key: 'upscaler', label: 'Upscaler' },
  { key: 'preview', label: 'Preview' },
  { key: 'llm', label: 'LLM-ассистент' },
  // (правка 269) FPS (frame interpolation)
  { key: 'fps', label: 'FPS (VFI)' },
  // (правка 301) Veda Sparse Attention предиктор
  { key: 'veda', label: 'Veda Attention' },
  // Препроцессоры (depth/canny для вкладки ControlNet)
  { key: 'preprocessor', label: 'Препроцессоры' },
  // (правка 722) Детекторы лиц/человека для вкладки Face Refine
  { key: 'face', label: 'Face Refine (детекторы)' },
]
