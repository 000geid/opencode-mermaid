import assert from "node:assert/strict"
import { test } from "node:test"
import { TextAttributes, type RGBA } from "@opentui/core"
import {
  attributesFor,
  heightOf,
  isEdgeLabel,
  kindOf,
  paletteFrom,
  parseLine,
  renderArt,
  resolveOptions,
  toStyledText,
  widthOf,
  type Kind,
  type Palette,
  type StyleOptions,
} from "../src/render.ts"

const rgb = (r: number, g: number, b: number) => ({ toInts: () => [r, g, b, 255] }) as unknown as RGBA

const FAKE_THEME = {
  text: { base: rgb(0xcd, 0xd6, 0xf4), muted: rgb(0x93, 0x99, 0xb2) },
  border: { base: rgb(0x6c, 0x70, 0x86) },
  background: { base: rgb(0x1e, 0x1e, 0x2e) },
  markdown: { link: rgb(0x89, 0xb4, 0xfa) },
}

const PALETTE = paletteFrom(FAKE_THEME)
const OPTIONS = resolveOptions({})

// SGR colour codes matching FAKE_THEME, used to build realistic runs.
const CODE = { fg: "205;214;244", border: "108;112;134", line: "147;153;178", arrow: "137;180;250" } as const
const c = (key: keyof typeof CODE, text: string) => `\u001b[38;2;${CODE[key]}m${text}\u001b[0m`

function runsOf(line: string, palette: Palette = PALETTE): { text: string; kind: Kind }[] {
  return parseLine(line).map((run) => ({ text: run.text, kind: kindOf(run.hex, palette.kinds) }))
}

test("resolveOptions defaults", () => {
  assert.deepEqual(resolveOptions(), {
    colors: true,
    bold: true,
    italic: true,
    overflow: "scroll",
    maxWidth: undefined,
  })
})

test("resolveOptions honours overrides", () => {
  const options = resolveOptions({ colors: false, bold: false, italic: false, overflow: "code", maxWidth: 90 })
  assert.equal(options.colors, false)
  assert.equal(options.bold, false)
  assert.equal(options.italic, false)
  assert.equal(options.overflow, "code")
  assert.equal(options.maxWidth, 90)
})

test("resolveOptions ignores an unknown overflow value", () => {
  assert.equal(resolveOptions({ overflow: "nope" }).overflow, "scroll")
})

test("paletteFrom maps theme tokens to hex and kinds", () => {
  assert.deepEqual(PALETTE.colors, {
    fg: "#cdd6f4",
    border: "#6c7086",
    line: "#9399b2",
    arrow: "#89b4fa",
    accent: "#89b4fa",
    bg: "#1e1e2e",
  })
  assert.equal(kindOf("#cdd6f4", PALETTE.kinds), "label")
  assert.equal(kindOf("#6c7086", PALETTE.kinds), "border")
  assert.equal(kindOf("#9399b2", PALETTE.kinds), "line")
  assert.equal(kindOf("#89b4fa", PALETTE.kinds), "arrow")
  assert.equal(kindOf(null, PALETTE.kinds), "space")
  assert.equal(kindOf("#123456", PALETTE.kinds), "unknown")
})

test("parseLine turns truecolor SGR into hex runs", () => {
  const runs = parseLine("\u001b[38;2;255;0;0mhi\u001b[0m there")
  assert.deepEqual(runs, [
    { text: "hi", hex: "#ff0000" },
    { text: " there", hex: null },
  ])
})

test("parseLine handles 256-colour SGR", () => {
  const runs = parseLine("\u001b[38;5;196mx\u001b[0m")
  assert.equal(runs.length, 1)
  assert.match(runs[0].hex ?? "", /^#[0-9a-f]{6}$/)
})

test("parseLine returns no runs for an empty string", () => {
  assert.deepEqual(parseLine(""), [])
})

test("kindOf classifies border / label / space / arrow", () => {
  const runs = runsOf(`${c("border", "│")}${c("fg", "Parser")} ${c("arrow", "►")}`)
  assert.deepEqual(
    runs.map((r) => r.kind),
    ["border", "label", "space", "arrow"],
  )
})

test("isEdgeLabel: boxed label is a node label, connector neighbour is an edge label", () => {
  const boxed = runsOf(`${c("border", "│")}${c("fg", "Lexer")}${c("border", "│")}`)
  assert.equal(isEdgeLabel(boxed, 1), false)

  const inline = runsOf(`${c("line", "─")}${c("fg", "parse")}${c("line", "─")}`)
  assert.equal(isEdgeLabel(inline, 1), true)

  const isolated = runsOf(c("fg", "tokens"))
  assert.equal(isEdgeLabel(isolated, 0), true)
})

test("isEdgeLabel skips past other label runs", () => {
  const line = runsOf(`${c("border", "│")}${c("fg", "IR")} ${c("fg", "Cache")}${c("border", "│")}`)
  assert.equal(isEdgeLabel(line, 1), false)
  assert.equal(isEdgeLabel(line, 3), false)
})

test("isEdgeLabel: a line-coloured lifeline counts as a connector", () => {
  const line = runsOf(`${c("line", "│")}${c("fg", "POST /login")}${c("line", "│")}`)
  assert.equal(isEdgeLabel(line, 1), true)
})

test("attributesFor applies bold to labels/arrows and italic to edge labels", () => {
  const edge = runsOf(`${c("line", "─")}${c("fg", "parse")}${c("line", "─")}`)
  assert.equal(attributesFor(edge, 1, OPTIONS), TextAttributes.ITALIC)

  const node = runsOf(`${c("border", "│")}${c("fg", "Lexer")}${c("border", "│")}`)
  assert.equal(attributesFor(node, 1, OPTIONS), TextAttributes.BOLD)

  const arrow = runsOf(c("arrow", "►"))
  assert.equal(attributesFor(arrow, 0, OPTIONS), TextAttributes.BOLD)

  const noItalic = runsOf(`${c("line", "─")}${c("fg", "parse")}${c("line", "─")}`)
  assert.equal(attributesFor(noItalic, 1, { ...OPTIONS, italic: false }), TextAttributes.BOLD)
})

test("attributesFor leaves chart blocks unemphasised", () => {
  const blocks = runsOf(c("arrow", "████"))
  assert.equal(attributesFor(blocks, 0, OPTIONS), 0)
})

const PIPELINE = `flowchart TD
  S([Start]) -->|parse| L[Lexer]
  L -->|tokens| P{Parser}
  P -->|ok| A[[AST]]
  P -->|error| R[Error Reporter]
  A -->|lower| C[(IR Cache)]
  C -->|optimize| O{Optimizer}
  O -->|inline| C
  O -->|codegen| G[Codegen]
  G -->|emit| Out([Output])
  R -.->|halt| Out`

test("renderArt produces coloured, multi-line output", () => {
  const art = renderArt(PIPELINE, PALETTE)
  assert.ok(art, "expected a diagram")
  assert.ok(heightOf(art) > 3)
  assert.ok(widthOf(art) > 10)
  assert.match(art, /\u001b\[38;2;/)
})

test("renderArt compact layout is never wider", () => {
  const roomy = renderArt(PIPELINE, PALETTE, false)
  const compact = renderArt(PIPELINE, PALETTE, true)
  assert.ok(roomy && compact)
  assert.ok(widthOf(compact) <= widthOf(roomy))
})

test("renderArt returns undefined for invalid source", () => {
  assert.equal(renderArt("this is not a mermaid diagram at all", PALETTE), undefined)
})

test("widthOf ignores ANSI escape codes", () => {
  assert.equal(widthOf("\u001b[38;2;255;0;0mabc\u001b[0m"), 3)
})

test("toStyledText bolds node labels and italicises edge labels", () => {
  const art = renderArt(PIPELINE, PALETTE)
  assert.ok(art)
  const styled = toStyledText(art, PALETTE, OPTIONS)

  const italic = styled.chunks.filter((chunk) => chunk.attributes === TextAttributes.ITALIC).map((chunk) => chunk.text)
  const bold = styled.chunks.filter((chunk) => chunk.attributes === TextAttributes.BOLD).map((chunk) => chunk.text)

  assert.ok(italic.includes("parse"), `expected "parse" to be italic, got ${JSON.stringify(italic)}`)
  assert.ok(bold.includes("Lexer"), `expected "Lexer" to be bold, got ${JSON.stringify(bold)}`)
})

test("toStyledText with colors:false omits foreground colours", () => {
  const art = renderArt(PIPELINE, PALETTE)
  assert.ok(art)
  const styled = toStyledText(art, PALETTE, { ...OPTIONS, colors: false } as StyleOptions)
  assert.ok(styled.chunks.every((chunk) => chunk.fg === undefined))
})
