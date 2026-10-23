/**
 * Type support for bundling markdown files as plain strings.
 * Webpack loads them via `type: "asset/source"` (see next.config.ts), so the
 * prompt guide's backticks / code fences need no escaping and the user can
 * edit the .md directly.
 */
declare module '*.md' {
  const content: string
  export default content
}
