'use client'

/**
 * (правка 929) ImageResultsGrid — сетка полученных картинок во вкладке
 * «Изображение» + полноэкранный просмотр по клику.
 *
 * Отдельный файл, потому что сетка живёт своими состоянием (увеличенное фото)
 * и используется только как правая колонка ImageView.
 */
import { useState } from 'react'
import { DownloadIcon, XIcon, ImageOffIcon } from 'lucide-react'
import type { ImageResult } from '@/lib/image-store'

export function imageUrl(r: { filename: string; subfolder?: string }, width?: number): string {
  const base = `/api/comfy/file?filename=${encodeURIComponent(r.filename)}&subfolder=${encodeURIComponent(r.subfolder || '')}`
  return width ? `${base}&width=${width}` : base
}

export function ImageResultsGrid({
  results,
  onClear,
}: {
  results: ImageResult[]
  onClear: () => void
}) {
  const [zoom, setZoom] = useState<ImageResult | null>(null)

  if (results.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
        <ImageOffIcon className="w-10 h-10 opacity-40" />
        <p className="max-w-sm">
          Здесь появятся картинки после генерации. Файлы сохраняются в папку вывода
          ComfyUI с префиксом <span className="font-mono">Minimax_Studio_image</span>.
        </p>
      </div>
    )
  }

  return (
    <div className="p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-muted-foreground">Результаты: {results.length}</span>
        <button
          type="button"
          onClick={onClear}
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
        >
          Очистить список
        </button>
      </div>

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
        {results.map((r) => (
          <button
            key={`${r.subfolder}/${r.filename}`}
            type="button"
            onClick={() => setZoom(r)}
            className="group text-left rounded-lg overflow-hidden border border-border bg-[var(--surface-2)] hover:border-primary/60 transition-colors"
          >
            <div className="aspect-square bg-black/30 flex items-center justify-center overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl(r, 512)}
                alt={r.filename}
                loading="lazy"
                className="w-full h-full object-contain"
              />
            </div>
            <div className="p-2 space-y-0.5">
              <div className="text-[11px] font-mono truncate">{r.filename}</div>
              {r.seed != null && r.seed !== 0 && (
                <div className="text-[11px] text-muted-foreground">seed {r.seed}</div>
              )}
            </div>
          </button>
        ))}
      </div>

      {zoom && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setZoom(null)}
        >
          <div
            className="max-w-full max-h-full flex flex-col gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl(zoom)}
              alt={zoom.filename}
              className="max-h-[80vh] w-auto object-contain rounded-lg"
            />
            <div className="flex items-center gap-2 text-xs text-white/80">
              <span className="font-mono truncate">{zoom.filename}</span>
              <a
                href={imageUrl(zoom)}
                download={zoom.filename}
                className="flex items-center gap-1 ml-auto px-2 py-1 rounded bg-white/10 hover:bg-white/20"
              >
                <DownloadIcon className="w-3.5 h-3.5" />
                Скачать
              </a>
              <button
                type="button"
                onClick={() => setZoom(null)}
                className="p-1 rounded bg-white/10 hover:bg-white/20"
                aria-label="Закрыть"
              >
                <XIcon className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
