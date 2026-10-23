/**
 * (правка 293) Слияние метаданных combined-файла продления с сайдкаром
 * ИСХОДНИКА (роут /api/comfy/concat не может экспортировать хелперы —
 * Next.js разрешает в route-файле только HTTP-методы, поэтому функция здесь).
 *
 * Чистая функция (вынесена для тестов):
 *  • references — если клиент их не прислал (extend-вкладка рефы в meta не
 *    несла), наследуем от исходника (references / minimax_h3_references);
 *  • extend_prompts — цепочка исходника + промпты клипов этого продления:
 *    накопление через несколько продлений, дубли на стыке схлопываются;
 *  • source_prompt — prompt исходника (или его source_prompt — самый ранний
 *    в цепочке), если отличается от prompt combined. prompt не перетираем.
 */
export function mergeExtendMeta(
  bodyMeta: Record<string, unknown>,
  sourceMeta: Record<string, unknown> | null,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...bodyMeta }
  if (!sourceMeta) return merged

  const hasRefs = Array.isArray(merged.references) && (merged.references as unknown[]).length > 0
  if (!hasRefs) {
    const srcRefs = Array.isArray(sourceMeta.references) ? sourceMeta.references
      : Array.isArray(sourceMeta.minimax_h3_references) ? sourceMeta.minimax_h3_references
      : null
    if (srcRefs && srcRefs.length > 0) merged.references = srcRefs
  }

  const srcChain = (Array.isArray(sourceMeta.extend_prompts) ? sourceMeta.extend_prompts : [])
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
  const clipPrompts = (Array.isArray(merged.extend_prompts) ? (merged.extend_prompts as unknown[]) : [])
    .filter((p): p is string => typeof p === 'string' && (p as string).trim().length > 0)
  const chain = [...srcChain, ...clipPrompts]
  const deduped = chain.filter((p, i) => i === 0 || p !== chain[i - 1])
  if (deduped.length > 0) merged.extend_prompts = deduped
  else delete merged.extend_prompts

  // Самый ранний промпт цепочки важнее: сначала source_prompt исходника.
  if (typeof sourceMeta.source_prompt === 'string' && sourceMeta.source_prompt.trim()
      && sourceMeta.source_prompt !== merged.prompt && merged.source_prompt === undefined) {
    merged.source_prompt = sourceMeta.source_prompt
  } else if (typeof sourceMeta.prompt === 'string' && sourceMeta.prompt.trim()
      && sourceMeta.prompt !== merged.prompt && merged.source_prompt === undefined) {
    merged.source_prompt = sourceMeta.prompt
  }
  return merged
}
