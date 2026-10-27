"""
stt_server.py — STT (whisper / transcribe.cpp) bridge for MiniMax H3 Studio (правка 65).

Loads the bundled transcribe.dll from the project's local `stt/` folder (self-contained,
portable — no external installation) and exposes a tiny HTTP API on 127.0.0.1:8091
(stdlib only: http.server + ctypes):

  GET  /health     -> {"ok": true, "model": ..., "language": ..., "threads": ..., "version": ...}
  POST /transcribe -> body = raw WAV (16-bit/float, any rate/channels)
                      -> {"ok": true, "text": "...", "ms": 1234}
  POST /reload     -> body {"model"?, "language"?, "threads"?} -> reloads model
  POST /shutdown   -> frees the model and exits

Constraints:
  * CPU-only: model_load_params.backend = TRANSCRIBE_BACKEND_CPU (1).
  * Input is 16 kHz mono float32 PCM — this server resamples/downmixes itself.
  * Single-threaded inference (session is not thread-safe) — guarded by a lock.

ABI notes (verified against the bundled DLL, transcribe.cpp v0.1.3):
  * model_load_params: 16 B — +0 u64 struct_size, +8 i32 backend (0=AUTO, 1=CPU)
  * session_params:    24 B — +0 u64 size, +8 i32 n_threads (0=auto),
                                       +12 i32 kv_type (0=auto), +16 i32 n_ctx (0=default)
  * run_params:        64 B — +0 u64 size, +8 i32 task (0=TRANSCRIBE),
                                       +12 i32 timestamps, +16/20/24 i32 pnc/itn/diarize,
                                       +28 pad, +32 char* language (NULL=auto),
                                       +40 char* target_language, +48 bool keep_special_tags,
                                       +56 family (sentinel — leave untouched)
  Safest path: call the library's own transcribe_*_params_init(&buf) to stamp
  struct_size + defaults, then write only the fields we need at the offsets above.
  (правка 65)
"""

import argparse
import array
import ctypes
import json
import os
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# (правка 743) Принудительный UTF-8 для stdout/stderr. На русской Windows Python
# печатает в cp866/cp1251, а Node читает pipe как UTF-8 → в UI вместо причины
# ошибки приходили «кракозябры». Ошибки запуска должны быть читаемыми.
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# ── args ──
# (правка 72) STT-рантайм встроен в проект: <root>/stt (рядом с tools/)
_DEFAULT_STT_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'stt')
)
ap = argparse.ArgumentParser()
ap.add_argument('--stt-dir', default=_DEFAULT_STT_DIR,
                help='STT runtime folder (contains transcribe.dll + models/). Default: <project>/stt')
ap.add_argument('--model', default='',
                help='Model filename (in stt/models) or absolute path. Empty = auto')
ap.add_argument('--port', type=int, default=8091)
ap.add_argument('--language', default='ru', help='Language code ("ru", "en") or "auto"')
ap.add_argument('--threads', type=int, default=0, help='CPU threads (0 = auto)')
ap.add_argument('--idle-sec', type=int, default=900, help='Exit after N sec without requests')
args = ap.parse_args()

TRANSCRIBE_BACKEND_CPU = 1  # 0=AUTO, 1=CPU, 2=METAL, 3=VULKAN

# Struct sizes (verified via transcribe_abi_struct_size on the bundled DLL).
MODEL_LOAD_PARAMS_SIZE = 16
SESSION_PARAMS_SIZE = 24
RUN_PARAMS_SIZE = 64

log = lambda msg: print(f'[stt] {msg}', flush=True)


# ─────────────────────────── DLL loading ───────────────────────────

# (правка 716) Хэндл os.add_dll_directory() — держим на уровне модуля,
# иначе деструктор убирает каталог из пути поиска DLL.
_DLL_DIR_HANDLE = None


def load_lib(stt_dir):
    dll = os.path.join(stt_dir, 'transcribe.dll')
    if not os.path.isfile(dll):
        raise RuntimeError(f'transcribe.dll не найдена: {dll} — папка STT-рантайма не найдена в проекте')
    # (правка 72) Явно добавляем папку рантайма в поиск DLL-зависимостей (ggml, onnxruntime),
    # чтобы transcribe.dll находила соседние .dll независимо от CWD и PATH.
    # (правка 716) Результат add_dll_directory() ОБЯЗАН удерживаться: его
    # деструктор закрывает хэндл и тем самым УБИРАЕТ каталог из пути поиска.
    # Раньше значение отбрасывалось, объект собирался GC'ом, и заявленная цель
    # не достигалась (работало лишь случайно, из-за LOAD_WITH_ALTERED_SEARCH_PATH).
    global _DLL_DIR_HANDLE
    try:
        if hasattr(os, 'add_dll_directory'):
            _DLL_DIR_HANDLE = os.add_dll_directory(stt_dir)
    except OSError:
        pass  # уже добавлена
    except Exception:
        pass
    try:
        lib = ctypes.CDLL(dll)
    except OSError as e:
        raise RuntimeError(f'Не удалось загрузить transcribe.dll: {e}')

    def sig(name, restype, argtypes):
        fn = getattr(lib, name, None)
        if fn is None:
            raise RuntimeError(f'Функция {name} отсутствует в transcribe.dll')
        fn.restype = restype
        fn.argtypes = argtypes
        return fn

    sig('transcribe_init_backends_default', ctypes.c_int, [])
    sig('transcribe_model_load_file', ctypes.c_int,
        [ctypes.c_char_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)])
    sig('transcribe_session_init', ctypes.c_int,
        [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)])
    sig('transcribe_run', ctypes.c_int,
        [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_int, ctypes.c_void_p])
    sig('transcribe_full_text', ctypes.c_char_p, [ctypes.c_void_p])
    sig('transcribe_session_free', None, [ctypes.c_void_p])
    sig('transcribe_model_free', None, [ctypes.c_void_p])
    sig('transcribe_status_string', ctypes.c_char_p, [ctypes.c_int])
    return lib


def status_text(lib, code):
    try:
        raw = lib.transcribe_status_string(code)
        return raw.decode('utf-8', errors='replace') if raw else f'код {code}'
    except Exception:
        return f'код {code}'


def make_params(lib, size, init_name):
    """Zeroed buffer + the library's own init (stamps struct_size + defaults)."""
    buf = ctypes.create_string_buffer(size)
    init = getattr(lib, init_name, None)
    if init is not None:
        try:
            init.argtypes = [ctypes.c_void_p]
            init.restype = ctypes.c_int
            init(ctypes.byref(buf))
        except Exception as e:
            log(f'предупреждение: {init_name} не вызвалась: {e}')
    # Defensive: make sure struct_size is stamped even if init was missing.
    ctypes.c_uint64.from_buffer(buf, 0).value = size
    return buf


def set_i32(buf, offset, value):
    ctypes.c_int32.from_buffer(buf, offset).value = value


# ─────────────────────────── model state ───────────────────────────

STATE = {
    'lib': None,
    'model': None,      # c_void_p handle (keep a Python reference alive!)
    'session': None,    # c_void_p handle
    'model_path': None,
    'language': 'ru',
    'threads': 0,
    'version': '',
}
LOCK = threading.RLock()
BACKENDS_INITIALIZED = False


def free_state():
    lib = STATE['lib']
    if not lib:
        return
    if STATE['session'] is not None:
        try:
            lib.transcribe_session_free(STATE['session'])
        except Exception:
            pass
    if STATE['model'] is not None:
        try:
            lib.transcribe_model_free(STATE['model'])
        except Exception:
            pass
    STATE['session'] = None
    STATE['model'] = None


def resolve_model(explicit, stt_dir):
    if explicit:
        candidates = [explicit] if os.path.isabs(explicit) else [
            os.path.join(stt_dir, 'models', explicit),
            os.path.join(stt_dir, 'resources', 'models', explicit),
            os.path.join(stt_dir, 'Data', 'models', explicit),
        ]
        for c in candidates:
            if os.path.isfile(c):
                return c
        raise RuntimeError(f'Модель не найдена: {explicit}')
    # (правка 72) Авто: первая *.bin / *.gguf в stt/models, затем resources/models, Data/models.
    for d in (os.path.join(stt_dir, 'models'),
              os.path.join(stt_dir, 'resources', 'models'),
              os.path.join(stt_dir, 'Data', 'models')):
        try:
            files = sorted(
                f for f in os.listdir(d)
                if f.lower().endswith(('.bin', '.gguf')) and os.path.isfile(os.path.join(d, f))
            )
            if files:
                return os.path.join(d, files[0])
        except OSError:
            pass
    raise RuntimeError(
        'Модели STT не найдены. Скачайте ggml-модель (например, whisper small/medium) '
        f'в папку {os.path.join(stt_dir, "models")} через кнопку «Скачать» в настройках «Голосовой ввод».'
    )


def load_state(model_arg, language, threads):
    lib = STATE['lib']
    model_path = resolve_model(model_arg, args.stt_dir)
    language = (language or 'auto').strip().lower()
    threads = max(0, int(threads or 0))

    global BACKENDS_INITIALIZED
    if not BACKENDS_INITIALIZED:
        rc = lib.transcribe_init_backends_default()
        if rc != 0:
            log(f'предупреждение: init_backends_default -> {rc} (продолжаем)')
        BACKENDS_INITIALIZED = True

    # model_load_params: CPU backend (правка 65: голосовой ввод работает на CPU)
    mlp = make_params(lib, MODEL_LOAD_PARAMS_SIZE, 'transcribe_model_load_params_init')
    set_i32(mlp, 8, TRANSCRIBE_BACKEND_CPU)

    model = ctypes.c_void_p()
    t0 = time.time()
    rc = lib.transcribe_model_load_file(model_path.encode('utf-8'), ctypes.byref(mlp), ctypes.byref(model))
    if rc != 0:
        # (правка 716) Старая (рабочая) модель НЕ тронута — сервер остаётся
        # с ней. Раньше free_state() вызывался ДО загрузки, и неудачный
        # /reload оставлял сервер вообще без модели (503 / «Модель не
        # загружена») без отката.
        raise RuntimeError(f'Не удалось загрузить модель ({status_text(lib, rc)}). Файл: {model_path}')
    log(f'модель загружена: {model_path} ({(time.time() - t0) * 1000:.0f} мс)')

    sp = make_params(lib, SESSION_PARAMS_SIZE, 'transcribe_session_params_init')
    set_i32(sp, 8, threads)

    session = ctypes.c_void_p()
    rc = lib.transcribe_session_init(model, ctypes.byref(sp), ctypes.byref(session))
    if rc != 0:
        # (правка 716) free_state() тут НЕ освобождает только что загруженную
        # модель: STATE['model'] присваивается ниже, а хэндл живёт в локальной
        # переменной model. Без явного transcribe_model_free модель (сотни МБ)
        # утекала при каждом неудачном /reload.
        try:
            lib.transcribe_model_free(model)
        except Exception:
            pass
        raise RuntimeError(f'Не удалось создать сессию ({status_text(lib, rc)})')

    # (правка 716) Новая модель и сессия готовы — только теперь освобождаем
    # прежнюю и подменяем STATE. До этого момента рабочая модель оставалась
    # доступна, поэтому неудачный /reload не ломал сервис.
    free_state()

    # Keep Python references so the ctypes handles/buffers are never GC'd.
    STATE['model'] = model
    STATE['session'] = session
    STATE['model_path'] = model_path
    STATE['language'] = language
    STATE['threads'] = threads
    STATE['_mlp'] = mlp
    STATE['_sp'] = sp


# ─────────────────────────── WAV decoding ───────────────────────────

def decode_wav(data):
    """Parse WAV, return (float32 PCM @16 kHz mono as bytes, n_samples)."""
    if len(data) < 12 or data[:4] != b'RIFF' or data[8:12] != b'WAVE':
        raise RuntimeError('Это не WAV-файл')

    pos = 12
    fmt = None
    data_off = None
    data_len = 0
    while pos + 8 <= len(data):
        cid = data[pos:pos + 4]
        (csize,) = struct.unpack_from('<I', data, pos + 4)
        body = pos + 8
        if cid == b'fmt ':
            if body + 16 > len(data):
                raise RuntimeError('Повреждённый fmt-чанк WAV')
            audio_fmt, channels, rate, _, _, bps = struct.unpack_from('<HHIIHH', data, body)
            # (правка 716) WAVE_FORMAT_EXTENSIBLE (0xFFFE) — так пишут ffmpeg,
            # DAW и MediaRecorder. Реальный формат лежит в первых 2 байтах
            # SubFormat GUID (часть fmt-чанка с 24-го байта). Раньше такой WAV
            # отвергался с «Неподдерживаемый формат WAV (fmt=65534)», хотя
            # докстринг обещал «16-bit/float, any rate/channels».
            if audio_fmt == 0xFFFE and body + 26 <= len(data):
                (sub_fmt,) = struct.unpack_from('<H', data, body + 24)
                audio_fmt = sub_fmt
            fmt = (audio_fmt, channels, rate, bps)
        elif cid == b'data':
            data_off = body
            data_len = min(csize, len(data) - body)
        if fmt is not None and data_off is not None:
            break
        pos = body + csize + (csize & 1)
    if fmt is None or data_off is None:
        raise RuntimeError('Некорректный WAV (нет чанков fmt/data)')

    audio_fmt, channels, rate, bps = fmt
    # bps в стандартном WAV — биты на сэмпл (16/24/32). Браузерный клиент
    # шлёт ровно это (16-bit PCM). Для совместимости с клиентами, которые
    # передают байты на сэмпл (2/3/4), принимаем оба варианта.
    if bps >= 8:
        bps = bps // 8

    raw = data[data_off:data_off + data_len]

    # Сэмпл-буферы — array.array вместо Python-списков: список ел ~24+ байта
    # на сэмпл и валил процесс по памяти на длинных WAV. Промежуточный
    # формат 'd' хранит те же double, что были в list-версии, — результат
    # downmix/resample бит-в-бит тот же (для float32-WAV значения и так
    # float32-точные, поэтому их можно хранить прямо в 'f').
    if audio_fmt == 1 and bps == 2:
        n = len(raw) // 2
        src = array.array('h')
        src.frombytes(raw[:n * 2])
        mono = array.array('d', (s / 32768.0 for s in src))
    elif audio_fmt == 1 and bps == 1:
        # (правка 716) 8-bit PCM (беззнаковый, 128 = ноль) — раньше отвергался.
        n = len(raw)
        mono = array.array('d', ((b - 128) / 128.0 for b in raw[:n]))
    elif audio_fmt == 1 and bps == 4:
        n = len(raw) // 4
        src = array.array('i')
        src.frombytes(raw[:n * 4])
        mono = array.array('d', (s / 2147483648.0 for s in src))
    elif audio_fmt == 1 and bps == 3:
        n = len(raw) // 3
        mono = array.array('d')
        for i in range(n):
            b = raw[i * 3:i * 3 + 3]
            v = b[0] | (b[1] << 8) | (b[2] << 16)
            if v >= 0x800000:
                v -= 0x1000000
            mono.append(v / 8388608.0)
    elif audio_fmt == 3 and bps == 4:
        n = len(raw) // 4
        mono = array.array('f')
        mono.frombytes(raw[:n * 4])
    else:
        raise RuntimeError(f'Неподдерживаемый формат WAV (fmt={audio_fmt}, bps={bps})')

    if channels > 1:
        n_ch = len(mono) // channels
        mono = array.array('d', (
            sum(mono[i * channels:(i + 1) * channels]) / channels for i in range(n_ch)
        ))

    if rate != 16000:
        ratio = rate / 16000
        n_out = int(len(mono) / ratio)
        out = array.array('d', bytes(8 * n_out))  # нули без временного списка
        for i in range(n_out):
            p = i * ratio
            i0 = int(p)
            i1 = min(i0 + 1, len(mono) - 1)
            fr = p - i0
            out[i] = mono[i0] * (1.0 - fr) + mono[i1] * fr
        mono = out

    pcm = array.array('f', mono).tobytes()
    return pcm, len(mono)


# ─────────────────────────── inference ───────────────────────────

def run_transcribe(wav_bytes):
    with LOCK:
        lib = STATE['lib']
        if lib is None or STATE['session'] is None:
            raise RuntimeError('Модель не загружена')
        pcm, n = decode_wav(wav_bytes)
        if n < 160:
            return '', 0

        # run_params: defaults from the library init; language at +32.
        rp = make_params(lib, RUN_PARAMS_SIZE, 'transcribe_run_params_init')
        keepalive = [rp]
        lang = STATE['language']
        if lang and lang not in ('auto', ''):
            cp = ctypes.c_char_p.from_buffer(rp, 32)
            cp.value = lang.encode('utf-8')
            keepalive.append(cp)

        arr = (ctypes.c_float * n).from_buffer_copy(pcm)
        t0 = time.time()
        rc = lib.transcribe_run(STATE['session'], arr, n, ctypes.byref(rp))
        if rc != 0:
            raise RuntimeError(f'Ошибка распознавания: {status_text(lib, rc)}')
        ms = int((time.time() - t0) * 1000)
        text = lib.transcribe_full_text(STATE['session'])
        return (text.decode('utf-8', errors='replace') if text else '').strip(), ms


# ─────────────────────────── HTTP server ───────────────────────────

# Лимит тела запроса: decode_wav разворачивает WAV в сэмпл-буферы по
# несколько байт на сэмпл — гигантское тело валило процесс по памяти.
# Настраивается переменной окружения STT_MAX_BODY_MB (по умолчанию 256 МБ).
# (правка 716) decode_wav держит ОДНОВРЕМЕННО ~5 копий сэмплов
# (raw → array('d') моно → array('d') ресемпл → float32 bytes → c_float
# буфер), т.е. усиление ≈13x к размеру тела. Прежний лимит 256 МБ давал
# ~3.3 ГБ живых аллокаций — «легальное» тело всё равно убивало процесс.
# Поэтому лимит понижен до 48 МБ (≈ 25 минут аудио 16 кГц моно 16 бит),
# а значение из окружения валидируется (0/мусор больше не ломают старт).
try:
    _max_body_mb = int(os.environ.get('STT_MAX_BODY_MB', '48'))
except (TypeError, ValueError):
    _max_body_mb = 48
MAX_BODY_BYTES = max(1, min(_max_body_mb, 1024)) * 1024 * 1024

LAST_ACTIVITY = [time.time()]


def mark_activity():
    LAST_ACTIVITY[0] = time.time()


class Handler(BaseHTTPRequestHandler):
    server_version = 'MiniMaxSTT/1.0'
    protocol_version = 'HTTP/1.1'

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        mark_activity()
        if self.path == '/health':
            lib = STATE['lib']
            # БЕЗ LOCK: run_transcribe держит лок на всё время CPU-инференса
            # (десятки секунд), и health-пинги зависали бы за ним — ensureStt
            # решал бы, что здоровый сервер мёртв. Чтения простых полей
            # dict атомарны под GIL — лок для отчёта не нужен.
            ok = lib is not None and STATE['session'] is not None
            payload = {
                'ok': ok,
                'model': STATE['model_path'],
                'language': STATE['language'],
                'threads': STATE['threads'],
                'version': STATE['version'],
                'backend': 'cpu',
            }
            self._json(200 if ok else 503, payload)
        else:
            self._json(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        mark_activity()
        # int(Content-Length) без try — мусорный/отсутствующий заголовок ронял
        # обработчик traceback'ом (тот же фикс, что правка 353 в llm_server.py).
        # Плюс лимит размера тела — см. MAX_BODY_BYTES выше.
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except (TypeError, ValueError):
            return self._json(400, {'ok': False, 'error': 'bad content-length'})
        if length < 0 or length > MAX_BODY_BYTES:
            return self._json(413, {'ok': False, 'error': 'request too large'})
        body = self.rfile.read(length) if length > 0 else b''
        if self.path == '/transcribe':
            try:
                text, ms = run_transcribe(body)
                # Долгая транскрипция (> --idle-sec) не обновляет активность,
                # пока идёт блокирующий вызов DLL. Отмечаем её по факту
                # завершения — иначе idle-watchdog убивал сервер сразу после
                # успешного распознавания (аналог touch() в llm_server).
                mark_activity()
                self._json(200, {'ok': True, 'text': text, 'ms': ms})
            except Exception as e:
                log(f'ошибка распознавания: {e}')
                self._json(500, {'ok': False, 'error': str(e)})
        elif self.path == '/reload':
            try:
                req = json.loads(body.decode('utf-8') or '{}')
                model = req.get('model') or STATE['model_path'] or args.model
                language = req.get('language') or STATE['language'] or 'ru'
                threads = req.get('threads', STATE['threads'])
                with LOCK:
                    load_state(model, language, threads)
                self._json(200, {'ok': True, 'model': STATE['model_path'],
                                 'language': STATE['language'], 'threads': STATE['threads']})
            except Exception as e:
                log(f'ошибка перезагрузки: {e}')
                self._json(500, {'ok': False, 'error': str(e)})
        elif self.path == '/shutdown':
            self._json(200, {'ok': True})
            threading.Thread(target=_do_shutdown, daemon=True).start()
        else:
            self._json(404, {'ok': False, 'error': 'not found'})

    def log_message(self, fmt, *a):
        # Молчим (как в llm_server.py): каждый запрос писался в stderr, и если
        # родитель не вычитывает пайп (буфер 64 КБ), поток-обработчик
        # блокировался навсегда прямо на записи лога.
        pass


def _do_shutdown():
    log('остановка: освобождаю модель')
    with LOCK:
        free_state()
    os._exit(0)


def idle_watchdog(idle_sec):
    while True:
        time.sleep(5)
        if time.time() - LAST_ACTIVITY[0] > idle_sec:
            log(f'простой {idle_sec // 60} мин — выход (освобождаю память)')
            with LOCK:
                # Перепроверка ПОСЛЕ захвата LOCK: пока мы ждали лок (долгая
                # транскрипция держит его всё время инференса), активность
                # могла обновиться уже после первой проверки — выходить нельзя.
                if time.time() - LAST_ACTIVITY[0] <= idle_sec:
                    continue
                free_state()
            os._exit(0)


def main():
    try:
        STATE['lib'] = load_lib(args.stt_dir)
    except Exception as e:
        log(f'ОШИБКА: {e}')
        sys.exit(2)

    lib = STATE['lib']
    try:
        ver = getattr(lib, 'transcribe_version', None)
        if ver is not None:
            try:
                ver.restype = ctypes.c_char_p
                ver.argtypes = []
                raw = ver()
                STATE['version'] = raw.decode('utf-8', errors='replace') if raw else ''
            except Exception:
                pass
    except Exception:
        pass

    try:
        load_state(args.model, args.language, args.threads)
    except Exception as e:
        log(f'ОШИБКА: {e}')
        sys.exit(2)

    threading.Thread(target=idle_watchdog, args=(args.idle_sec,), daemon=True).start()

    class Server(ThreadingHTTPServer):
        allow_reuse_address = True
        daemon_threads = True

    srv = Server(('127.0.0.1', args.port), Handler)
    log(f'готов: модель={STATE["model_path"]} lang={STATE["language"]} threads={STATE["threads"]} порт={args.port} (CPU)')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        with LOCK:
            free_state()


if __name__ == '__main__':
    main()
