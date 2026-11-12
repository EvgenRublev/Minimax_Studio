<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Обновления и ноды ComfyUI (обязательный инвариант)

Пользователь обновляется **внутри приложения**: `install/apply_update.ps1` меняет
только файлы студии и **никогда не трогает папку ComfyUI**. Значит, всё, что
нужно ComfyUI, должно доезжать до него при запуске. Это уже реализовано:

- `scripts/sync_custom_nodes.js` → `syncStudioNodes()` копирует `custom nodes/*`
  в `<comfyCore>/custom_nodes`;
- `scripts/sync_custom_nodes.js` → `syncCorePatches()` пофайлово копирует
  `install/comfy-patches/*` поверх `<comfyCore>`;
- вызывается в `electron/main.js` (`startComfy`) и в `start.bat`;
- `scripts/release.mjs` на шаге verify запускает `scripts/check-comfy-sync.mjs`
  и падает, если эта связка нарушена.

## Раскладка бэкенда (правка 905)

Папка бэкенда называется `ComfyUI` (до 7.1.19 — `ComfyUI-Easy-Install`, это
была сборка Pixaroma; теперь ставим официальное ядро по тегу). Раскладка
плоская, каталог ядра (`main.py`, `models`, `custom_nodes`, `user`, `output`,
`input`, `temp`, `extra_model_paths.yaml`) совпадает с корнем бэкенда:

```
ComfyUI/            ← comfyRoot == comfyCore
├── main.py
├── models/  custom_nodes/  user/  output/  input/  temp/
├── extra_model_paths.yaml
└── python_embeded/ ← портативный Python
```

Старые установки (`ComfyUI-Easy-Install/ComfyUI/...` + `python_embeded` рядом)
поддерживаются: корень определяет `resolveComfyRoot()`, каталог ядра —
`resolveComfyCore()` (`src/lib/app-config.ts` и `scripts/sync_custom_nodes.js`,
в bat — переменная `COMFY_CORE`). **Пути к моделям, входам/выходам и yaml
обязательно брать от `comfyCore`**, иначе код сломается на одной из раскладок.

## Правила при изменениях

1. **Новая кастом-нода.** Папка в `custom nodes/<имя>/` с `__init__.py`.
   Ничего дополнительно регистрировать не нужно: синхронизатор копирует папки
   целиком. Если ноде нужны pip-зависимости — обнови `install/install.ps1`
   (иначе у новых пользователей `ModuleNotFoundError`).
2. **Изменение патча ядра.** Меняй файл в `install/comfy-patches/...`, а не
   только в dev-копии `ComfyUI`. Если меняется сигнатура ноды
   (входы/выходы) — сразу правь воркфлоу-шаблоны в `src/lib/comfy/*-template.ts`,
   иначе ComfyUI вернёт `HTTP 400 ... IndexError`.
3. **Не полагайся на установщик.** `install.ps1` раскладывает ноды только при
   установке/ремонте. Для обновившихся пользователей работает только синк при
   запуске.
4. **Проверка перед коммитом/релизом:** `npm run check:comfy-sync`
   (плюс `node --check` для изменённых `.js`). Релиз без этого не пройдёт.
5. **Регресс-тест синка.** Скопируй старую версию файла во временную папку
   `.../<comfy>/ComfyUI/...`, запусти `scripts/sync_custom_nodes.js <comfy>`:
   первый запуск должен обновить файл, второй — ничего не делать.
6. **CHANGELOG.** Любая правка нод/патчей — отдельный пункт с пометкой, что
   фикс доезжает через апдейт-зип и срабатывает при первом запуске после
   обновления, без переустановки.

Историческая справка: 866 — забыли `MiniMaxStudioLoop` (missing_node_type);
901 — забыли второй выход `latent` у `MiniMaxH3AddGuide` (IndexError на
`av_latent`). Оба раза причина одна: апдейтер не трогает ComfyUI.

## Установщик: целостность загрузок (правка 939)

Половина обращений «у меня не устанавливается» — это битый архив в `.install-cache`
(обрванное качание, HTML-страница прокси/портала вместо файла). Раньше такой файл
считался «уже скачанным» и ронял каждый следующий запуск на
«не удалось распаковать архив» в одной и той же точке.

Инварианты:

1. **Распаковка только через `Expand-ZipSafe` / `Expand-TarGz`** в `install\*.ps1`:
   они проверяют магические байты, имеют запасной движок `Expand-Archive` и при
   неудаче удаляют архив вместе с `.part` и сегментами докачки. Прямые
   `[IO.Compression.ZipFile]::ExtractToDirectory` / `Expand-Archive` в установщике
   запрещены.
2. **Контрольные суммы — в `install/checksums.json`** (он в git; сам бандл
   `install/cache/` — нет). После добавления/смены любого скачиваемого архива:
   `node scripts/make-installer-cache.mjs` (ключ `--fill` докачает недостающий
   бандл). `pinned: true` ставится только неизменяемым артефактам (nodejs.org,
   python.org, релизные ассеты GitHub); для архивов тегов GitHub (`codeload`,
   `archive/refs/tags`) сумма проверяется только у бандла — GitHub пересобирает их
   не байт-в-байт.
3. **Проверка перед релизом:** `node scripts/check-installer.mjs` (177 проверок:
   sha256 всего бандла, версии из `install.ps1`/`package.json` против имён файлов
   бандла, наличие всей механики целостности, кодировки `.ps1`). Уже вшит в
   `scripts/release.mjs` как обязательный шаг verify.
4. **Поведенческий тест:** `powershell -NoProfile -ExecutionPolicy Bypass -File
   scripts/installer-integrity-test.ps1` — вытаскивает реальные блоки из
   `install/install.ps1` и гоняет их на поддельных файлах (валидный zip,
   обрезанный zip, HTML вместо архива, осколки докачки). Сеть и ГПУ не нужны.
5. **Осторожно с регистром имён в PowerShell:** параметр `$Kind` и локальная
   `$kind` — одна переменная (реальный баг правки 939: проверка типа архива
   always-pass). Локальные переменные не должны совпадать с параметрами.
   Тот же класс ошибок (правка 942): `[string]$X = $null` в PowerShell приводит
   дефолт к `""`, поэтому проверка `$null -ne $X` всегда истина (так `Set-Speed`
   стирал `hint`); а `Get-Content` без `-Encoding` читает UTF-8 без BOM как ANSI
   и портит кириллицу — все файлы с русским текстом (`install.ps1`,
   `checksums.json`, `.next\BUILD_ID`, патчи ядра) читать только с
   `-Encoding UTF8` или `[IO.File]::ReadAllText(..., UTF8)`.
6. **Самодиагностика (правка 941):** `install\install.ps1 -SelfCheck [-Deep]`
   (точка входа для пользователя — `diagnostics.bat`) — read-only проверка уже поставленной
   студии: Node, node_modules, `.next`, раскладка ComfyUI, `python_embeded` +
   импорт torch, кастом-ноды по `install/nodes.json` и `custom nodes/*`, патчи
   ядра, папки моделей; `-Deep` сверяет sha256 бандла и кэша. Новое поле статуса
   — `hint`/`log`; долгий шаг держит живым heartbeat (`Start-StatusHeartbeat`),
   иначе заставка считает установщика мёртвым по `ts` старше 12 минут.
   Регресс-тест: `scripts/installer-heartbeat-test.ps1`.

Историческая справка: юзер с `I:\Minimax_Studio-main` (архив исходников вместо
setup.exe, офлайн-бандла нет) падал на 0% именно из-за неизвлекаемого мусора в кэше.

