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
  в `<ComfyUI>/ComfyUI/custom_nodes`;
- `scripts/sync_custom_nodes.js` → `syncCorePatches()` пофайлово копирует
  `install/comfy-patches/*` поверх `<ComfyUI>/ComfyUI`;
- вызывается в `electron/main.js` (`startComfy`) и в `start.bat`;
- `scripts/release.mjs` на шаге verify запускает `scripts/check-comfy-sync.mjs`
  и падает, если эта связка нарушена.

## Правила при изменениях

1. **Новая кастом-нода.** Папка в `custom nodes/<имя>/` с `__init__.py`.
   Ничего дополнительно регистрировать не нужно: синхронизатор копирует папки
   целиком. Если ноде нужны pip-зависимости — обнови `install/install.ps1`
   (иначе у новых пользователей `ModuleNotFoundError`).
2. **Изменение патча ядра.** Меняй файл в `install/comfy-patches/...`, а не
   только в dev-копии `ComfyUI-Easy-Install`. Если меняется сигнатура ноды
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

