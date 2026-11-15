'use client'

/**
 * (правка 1006) Ctrl+V → реф-картинки на любой вкладке, где они есть.
 *
 * Слушаем document paste в capture-фазе (событие доходит при фокусе на body,
 * кнопке, пустой панели) + keydown Ctrl/Cmd+V как фолбэк через Clipboard API.
 * Редактируемые поля не трогаем: там вставкой управляет сам input/textarea,
 * иначе можно отобрать картинку у чата ассистента или поля промпта.
 */
import { useEffect, useRef } from 'react'
import {
  getClipboardImageFiles,
  getClipboardImageFromApi,
  hasClipboardImage,
} from '@/lib/paste-utils'

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function usePasteImageFiles(
  onFiles: (files: File[]) => void,
  enabled = true,
): void {
  const handlerRef = useRef(onFiles)
  handlerRef.current = onFiles

  useEffect(() => {
    if (!enabled) return
    const DEDUP_MS = 2000
    let lastPasteAt = 0
    let lastSignature = ''

    const add = (files: File[], _viaPasteEvent: boolean) => {
      if (files.length === 0) return
      const now = Date.now()
      // (правка 1009) Гасим только повтор ТОЙ ЖЕ картинки (paste + keydown-
      // fallback на один Ctrl+V). Разные картинки можно вставлять подряд —
      // это важно для двух кадров во FLF, между вставками не нужно ждать 2 с.
      const sig = files.map((f) => `${f.size}:${f.type}`).join('|')
      if (sig === lastSignature && now - lastPasteAt < DEDUP_MS) return
      lastPasteAt = now
      lastSignature = sig
      handlerRef.current(files)
    }

    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented) return
      if (isEditableTarget(e.target)) return
      if (!hasClipboardImage(e.clipboardData)) return
      // preventDefault синхронно, до await — иначе браузер может отклонить.
      e.preventDefault()
      e.stopPropagation()
      void getClipboardImageFiles(e.clipboardData).then((files) => {
        if (files.length > 0) add(files, true)
      })
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      if (e.key.toLowerCase() !== 'v') return
      if (isEditableTarget(e.target)) return
      void (async () => {
        // Обычный paste-событие приходит раньше и само ставит метку;
        // этот путь нужен, когда браузер его вообще не диспатчит.
        const file = await getClipboardImageFromApi()
        if (file) add([file], false)
      })()
    }

    document.addEventListener('paste', onPaste, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('paste', onPaste, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [enabled])
}
