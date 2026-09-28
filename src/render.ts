import { StyledText, TextAttributes, RGBA, ansi256IndexToRgb, type TextChunk } from "@opentui/core"
import { renderMermaidASCII } from "beautiful-mermaid"

/**
 * Pure rendering pipeline: turn Mermaid source into a themed, styled OpenTUI
 * `StyledText`. Kept free of renderables so it can be unit tested without a
 * terminal.
 */

export const LANGUAGES = ["mermaid", "mmd"] as const
export const CACHE_LIMIT = 100

/** Cache keyed by palette + layout + source so streaming fences and repeated
 * diagrams do not re-layout, while theme changes still produce fresh colours. */
const cache = new Map<string, string>()

export type Kind = "label" | "border" | "line" | "arrow" | "unknown" | "space"

export type Overflow = "scroll" | "clip" | "code"

/** A coloured run of glyphs on one line. */
export interface GlyphRun {
  text: string
  kind: Kind
}

export interface Palette {
  readonly colors: { fg: string; border: string; line: string; arrow: string; accent: string; bg: string }
  readonly kinds: ReadonlyMap<string, Kind>
  readonly signature: string
}

export interface StyleOptions {
  readonly colors: boolean
  readonly bold: boolean
  readonly italic: boolean
  readonly overflow: Overflow
  readonly maxWidth: number | undefined
}

/** The subset of the OpenCode theme this plugin reads. */
export interface ThemeLike {
  text: { base: RGBA; muted: RGBA }
  border: { base: RGBA }
  background: { base: RGBA }
  markdown: { link: RGBA }
}

interface Run extends GlyphRun {
  hex: string | null
}

const ANSI_RE = /\x1b\[([0-9;]*)m/g
const ANSI_STRIP = /\x1b\[[0-9;]*m/g
const WORD = /[\p{L}\p{N}]/u
const BLOCK = /[█▓▒░]/

// Glyph classes used to tell node labels (inside boxes) from edge labels.
const VERTICAL = new Set(["│", "┃", "║", "╟", "╢", "|"])
const HORIZONTAL = new Set(["─", "═", "-", "="])
const HEADS = new Set(["►", "◄", "▲", "▼", "▶", "◀", "^", "v", "<", ">"])

export function resolveOptions(options: Readonly<Record<string, unknown>> = {}): StyleOptions {
  return {
    colors: options.colors !== false,
    bold: options.bold !== false,
    italic: options.italic !== false,
    overflow: options.overflow === "clip" || options.overflow === "code" ? options.overflow : "scroll",
    maxWidth: typeof options.maxWidth === "number" ? options.maxWidth : undefined,
  }
}

function channel(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")
}

function rgbHex(r: number, g: number, b: number): string {
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

function hexOf(color: RGBA): string {
  const [r, g, b] = color.toInts()
  return rgbHex(r, g, b)
}

export function paletteFrom(theme: ThemeLike): Palette {
  const fg = hexOf(theme.text.base)
  const border = hexOf(theme.border.base)
  const line = hexOf(theme.text.muted)
  const arrow = hexOf(theme.markdown.link)
  const accent = hexOf(theme.markdown.link)
  const bg = hexOf(theme.background.base)

  return {
    colors: { fg, border, line, arrow, accent, bg },
    kinds: new Map<string, Kind>([
      [fg, "label"],
      [border, "border"],
      [line, "line"],
      [arrow, "arrow"],
    ]),
    signature: `${fg}|${border}|${line}|${arrow}`,
  }
}

/** Split one line into colour runs, turning SGR sequences into hex colours. */
export function parseLine(line: string): { text: string; hex: string | null }[] {
  const runs: { text: string; hex: string | null }[] = []
  let hex: string | null = null
  let last = 0
  ANSI_RE.lastIndex = 0

  const push = (text: string) => {
    if (text.length > 0) runs.push({ text, hex })
  }

  let match: RegExpExecArray | null
  while ((match = ANSI_RE.exec(line)) !== null) {
    push(line.slice(last, match.index))
    const params = match[1]
    if (params === "" || params === "0") {
      hex = null
    } else {
      const parts = params.split(";").map(Number)
      if (parts[0] === 38 && parts[1] === 2) {
        hex = rgbHex(parts[2], parts[3], parts[4])
      } else if (parts[0] === 38 && parts[1] === 5) {
        const [r, g, b] = ansi256IndexToRgb(parts[2])
        hex = rgbHex(r, g, b)
      } else if (parts[0] === 39) {
        hex = null
      }
    }
    last = match.index + match[0].length
  }
  push(line.slice(last))
  return runs
}

export function kindOf(hex: string | null, kinds: ReadonlyMap<string, Kind>): Kind {
  if (hex === null) return "space"
  return kinds.get(hex) ?? "unknown"
}

/**
 * Decide whether a label belongs to an edge rather than a node.
 *
 * Both kinds of label share one colour, so we look outward for the nearest
 * structural glyph, skipping spaces and other label runs. Horizontal connectors
 * and arrow heads make it an edge label; a vertical connector (a sequence
 * lifeline) does too; any box/junction glyph means it is a node label. A label
 * cluster with no structural neighbour at all (common for top-down edge labels)
 * is treated as an edge label.
 */
export function isEdgeLabel(runs: readonly GlyphRun[], index: number): boolean {
  for (const direction of [-1, 1] as const) {
    for (let i = index + direction; i >= 0 && i < runs.length; i += direction) {
      const run = runs[i]
      if (run.kind === "space") continue
      if (WORD.test(run.text)) continue
      const glyph = direction < 0 ? run.text.slice(-1) : run.text.slice(0, 1)
      if (HORIZONTAL.has(glyph) || HEADS.has(glyph)) return true
      if (VERTICAL.has(glyph) && (run.kind === "line" || run.kind === "arrow")) return true
      return false
    }
  }
  return true
}

export function attributesFor(runs: readonly GlyphRun[], index: number, options: StyleOptions): number {
  const run = runs[index]
  if (run.kind === "arrow") return options.bold && !BLOCK.test(run.text) ? TextAttributes.BOLD : 0
  if (run.kind !== "label") return 0
  if (options.italic && isEdgeLabel(runs, index) && WORD.test(run.text)) return TextAttributes.ITALIC
  return options.bold ? TextAttributes.BOLD : 0
}

export function toStyledText(art: string, palette: Palette, options: StyleOptions): StyledText {
  const chunks: TextChunk[] = []
  const lines = art.split("\n")

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const runs: Run[] = parseLine(lines[lineIndex]).map((run) => ({
      ...run,
      kind: kindOf(run.hex, palette.kinds),
    }))

    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]
      if (run.text.length === 0) continue
      const attributes = attributesFor(runs, i, options)
      chunks.push({
        __isChunk: true,
        text: run.text,
        fg: options.colors && run.hex ? RGBA.fromHex(run.hex) : undefined,
        attributes: attributes || undefined,
      })
    }

    if (lineIndex < lines.length - 1) chunks.push({ __isChunk: true, text: "\n" })
  }

  return new StyledText(chunks)
}

/** Render Mermaid source to truecolor ANSI text, or undefined on parse error. */
export function renderArt(source: string, palette: Palette, compact = false): string | undefined {
  const key = `${palette.signature}|${compact ? "c" : "n"}|${source}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  let art: string
  try {
    art = renderMermaidASCII(source, {
      colorMode: "truecolor",
      theme: palette.colors,
      useAscii: false,
      paddingX: compact ? 2 : 3,
      paddingY: compact ? 2 : 3,
      boxBorderPadding: compact ? 0 : 1,
    })
  } catch {
    return undefined
  }

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, art)
  return art
}

/** Widest visible line, ignoring ANSI colour codes. */
export function widthOf(art: string): number {
  let max = 0
  for (const line of art.split("\n")) {
    const length = line.replace(ANSI_STRIP, "").length
    if (length > max) max = length
  }
  return max
}

export function heightOf(art: string): number {
  return art.split("\n").length
}

export function clearCache(): void {
  cache.clear()
}
