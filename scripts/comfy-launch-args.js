/**
 * (правка 1081) Флаги запуска ComfyUI, зависящие от поколения ядра.
 *
 * Зачем отдельный модуль: в right-время эти флаги собирал inline-код
 * electron/main.js, и опечатка в имени локальной переменной (после переименования
 * `branch` → `coreVer`) уронила приложение на старте с «branch is not defined» —
 * `node --check` такое не ловит, а ловится только исполнением. Теперь сборка
 * аргументов вынесена сюда, а scripts/check-comfy-sync.mjs прогоняет её на
 * явных версиях ядра (0.33 / 0.34 / 0.44) и падает, если поведение разъехалось.
 *
 * Поколения (см. CORE_PATCH_SETS в scripts/sync_custom_nodes.js):
 *   • 0.33.x  — откатное ядро (comfy-aimdo 0.4.13), --disable-fast-disk НЕТ;
 *   • 0.44+   — актуальное ядро.
 * Неизвестная версия ядра ничего не обрезает: раньше флаги передавались всегда.
 */
const { readComfyVersion, compareVersions } = require('./sync_custom_nodes')

/** Флаг → минимальная версия ядра, которая его понимает. */
const FLAG_MIN_VERSION = [
  { flag: '--vram-headroom', min: '0.33.0' },
  { flag: '--disable-nvml-pressure', min: '0.33.0' },
  { flag: '--disable-async-offload', min: '0.33.0' },
  { flag: '--disable-pinned-memory', min: '0.33.0' },
  { flag: '--disable-dynamic-vram', min: '0.33.0' },
  { flag: '--use-ck-attention', min: '0.33.0' },
  { flag: '--fast-disk', min: '0.33.0' },
  { flag: '--disable-fast-disk', min: '0.34.0' },
]

/** Версия ядра в каталоге ('0.33.0'); '' — не прочиталась. */
function comfyCoreVersion(coreDir) {
  try {
    return readComfyVersion(coreDir) || ''
  } catch {
    return ''
  }
}

/** Понимает ли ядро этой версии флаг. Неизвестная версия — понимает (как раньше). */
function flagSupported(flag, version) {
  if (!version) return true
  const rule = FLAG_MIN_VERSION.find((r) => r.flag === flag)
  if (!rule) return true
  return compareVersions(version, rule.min) >= 0
}

/**
 * Аргументы командной строки для main.py по значениям из config.ini.
 * `v` — { reserveGb, dynamicVram, asyncOffload, pinnedMemory, nvmlPressure,
 * vramHeadroom, fastDisk } (строки '0'/'1'/число/'auto').
 * Возвращает { flags: ['--flag', 'значение', ...], skipped: ['--flag', ...] }.
 */
function comfyFlags(v, coreVer) {
  const wanted = [
    ['--windows-standalone-build'],
    ['--use-ck-attention'],
    ['--disable-auto-launch'],
    ['--reserve-vram', v.reserveGb],
  ]
  if (v.dynamicVram === '0') wanted.push(['--disable-dynamic-vram'])
  // (правка 1073) Флаги разведены: async_offload=0 убирает только async-конвейер
  // (он и был причиной падений aimdo с ошибкой 1450/1453), а pinned-память
  // остаётся включённой — на картах меньше 15 ГБ без неё страничевание весов
  // идёт с диска. pinned_memory=0 в config.ini — аварийный выключатель для тех,
  // у кого с pinned действительно падает загрузка.
  if (v.asyncOffload !== '1') wanted.push(['--disable-async-offload'])
  if (v.pinnedMemory === '0') wanted.push(['--disable-pinned-memory'])
  // (правка 1077) nvml_pressure=0 — aimdo перестаёт учитывать чужие процессы за VRAM.
  if (v.nvmlPressure === '0') wanted.push(['--disable-nvml-pressure'])
  if (v.vramHeadroom !== '0') wanted.push(['--vram-headroom', v.vramHeadroom])
  if (v.fastDisk === '1') wanted.push(['--fast-disk'])
  else if (v.fastDisk === '0') wanted.push(['--disable-fast-disk'])

  const flags = []
  const skipped = []
  for (const [flag, ...rest] of wanted) {
    if (!flagSupported(flag, coreVer)) {
      skipped.push(flag)
      continue
    }
    flags.push(flag, ...rest)
  }
  return { flags, skipped }
}

module.exports = { FLAG_MIN_VERSION, comfyCoreVersion, flagSupported, comfyFlags }
