import { Plugin } from "@opencode/plugin"

/**
 * Server-side entrypoint.
 *
 * The Mermaid renderer is a terminal-UI feature, so this plugin does nothing on
 * the server. It exists so the package can be installed with
 * `opencode plugin add`; the CLI then picks up the `./tui` export automatically.
 */
export default Plugin.define({
  id: "opencode-mermaid",
  setup() {},
})
