import { Plugin } from "@opencode/plugin/tui"
import { BoxRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import {
  LANGUAGES,
  clearCache,
  heightOf,
  paletteFrom,
  renderArt,
  resolveOptions,
  toStyledText,
  widthOf,
} from "./render.ts"

/**
 * Render ```mermaid fences as inline Unicode diagrams in the TUI.
 *
 * Diagrams are laid out by beautiful-mermaid, which emits per-run truecolor
 * ANSI. Those runs become OpenTUI `StyledText` chunks, so the diagram is
 * coloured from the active OpenCode theme, with node labels bold and edge
 * labels italic. Everything falls back to the default code block on failure.
 *
 * Options (see README): colors, bold, italic, overflow, maxWidth.
 */
export default Plugin.define({
  id: "opencode-mermaid",
  setup(context) {
    const options = resolveOptions(context.options)

    const availableWidth = () => {
      if (options.maxWidth !== undefined) return options.maxWidth
      const terminal = typeof context.renderer.width === "number" ? context.renderer.width : 80
      return Math.max(24, terminal - 6)
    }

    let counter = 0
    const cleanups = LANGUAGES.map((language) =>
      context.markdown.registerCodeBlockRenderer(language, (token, render) => {
        try {
          const source = typeof token.text === "string" ? token.text : ""
          if (!source.trim()) return render.defaultRender()

          const palette = paletteFrom(context.theme)

          // Prefer the roomy layout; fall back to compact spacing only when it
          // actually narrows the diagram.
          let art = renderArt(source, palette, false)
          if (art === undefined) return render.defaultRender()
          let width = widthOf(art)
          if (width + 2 > availableWidth()) {
            const compact = renderArt(source, palette, true)
            if (compact !== undefined && widthOf(compact) < width) {
              art = compact
              width = widthOf(compact)
            }
          }

          if (options.overflow === "code" && width + 2 > availableWidth()) return render.defaultRender()

          const id = `mermaid-${counter++}`
          const text = new TextRenderable(context.renderer, {
            id: `${id}-text`,
            content: toStyledText(art, palette, options),
            fg: context.theme.text.base,
            wrapMode: "none",
            flexShrink: 0,
          })

          if (options.overflow === "clip") {
            const box = new BoxRenderable(context.renderer, {
              id,
              width: "100%",
              flexDirection: "column",
              flexShrink: 0,
              border: ["left"],
              borderColor: context.theme.border.base,
              paddingLeft: 1,
              marginBottom: 1,
            })
            box.add(text)
            return box
          }

          // A ScrollBox measures the real container width at layout time. When
          // the diagram fits, OpenTUI hides the scrollbar (display: none, so it
          // leaves the layout) and this looks like a plain box. One extra row is
          // reserved for the scrollbar; marginBottom is dropped to compensate.
          const scroll = new ScrollBoxRenderable(context.renderer, {
            id,
            width: "100%",
            height: heightOf(art) + 1,
            flexShrink: 0,
            border: ["left"],
            borderColor: context.theme.border.base,
            paddingLeft: 1,
            marginBottom: 0,
            scrollX: true,
            scrollY: false,
            viewportCulling: false,
            horizontalScrollbarOptions: { showArrows: false },
          })
          scroll.add(text)
          return scroll
        } catch {
          return render.defaultRender()
        }
      }),
    )

    return () => {
      clearCache()
      for (const cleanup of cleanups) cleanup()
    }
  },
})
