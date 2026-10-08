# session-todo

A Claude Code mod that puts the session's todo list in a side pane. The agent keeps the list current through a tool it is told to use, so you can see what is done, what is in progress and what is left without asking.

## What you get

- **A "Todo" pane** beside the transcript, opened at session start. Lists are stacked sections, the active one first with a bold title, each with an optional one-line `about` under the title saying what the list is for (cut to 80 characters with an ellipsis, so it stays a line). Each row shows a status glyph, the item text and an optional note; items are numbered straight through the pane. Click the glyph to cycle an item pending → in progress → done. Every in-progress item is repeated in a `now:` block, and a legend closes the pane.
- **A status line** under the prompt: `Todo 2/5 · now: <current item> (+1)`.
- **A progress bar** in each list's title row, beside the `done/total` count: done, in progress and blocked take their share in colour, the rest is dim, and any status with at least one item keeps at least one cell.
- **A `/todo` command** for your own edits: `/todo` (show), `/todo add [@list] <text>`, `/todo start <n>`, `/todo done <n>`, `/todo remove <n>`, `/todo about <list> [text]`, `/todo clear [list]`, `/todo drop <list>`, `/todo focus <list>`, `/todo theme <name>`.
- **Row spacing:** a blank line between items by default; "Compact rows" in the ⚙ settings row, `/todo compact on|off`, or the `/config` row drops it.
- **Themes:** `classic` (the terminal's green, yellow, red), `cyberpunk` (neon green and purple), and the standard palettes `dracula`, `nord`, `solarized`, `gruvbox`, `monokai`, `catppuccin`, `tokyo-night`, `one-dark`. Pick one with the ⚙ button at the top of the pane, `/todo theme <name>`, or in `/config` under the plugin's "Theme" row; the choice is stored in your user settings.
- **A `todo` tool** the agent calls (`mcp__session-todo__todo`): `write` a named list, `add`, `update`, `remove`, `read` (every list), `clear`, `drop`, `focus`, `describe` (the `about` line). A system-prompt section tells the agent to write the plan before multi-step work, keep the step it works on in progress (one at a time preferred, several allowed), mark items done as it goes, and keep follow-ups such as "open the PR" or "report to Jira" in a second list so the main plan stays focused.

Several lists, two flat levels (list, item), item ids unique across lists. The board lives in the session's plugin state (survives hot reloads and context compaction) and is mirrored to the plugin store under the session id, so `claude --resume` brings it back. `/clear` empties it.

## Install

From a terminal session of Claude Code:

```
/plugin install session-todo --marketplace jepperip/claude-session-todo
```

Answer `y` to add the marketplace, then pick the user scope. A mod installed at the user scope also loads in the sessions the Claude desktop app starts.

### Run from a checkout instead

For a terminal session: `claude --plugin-dir <path-to-this-folder>`.

For the desktop app, which takes no flags, name the folder in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "C:\\code\\claude-session-todo" } }
```

An interactive session watches the folder and reloads the mod when a file changes.

## Layout

```
.claude-plugin/plugin.json      manifest
.claude-plugin/marketplace.json makes this repository installable as a marketplace
hooks/hooks.json                names the hooks module
hooks/register.tsx              the mod: tool, command, pane, status line, prompt section
types/index.d.ts                the state contract (what the pane draws from)
```

`claude plugin validate .` checks the manifest and module. The engine writes this build's API declarations to `.claude-plugin/types/` on every load (gitignored), so `tsc -p .` type-checks the module after the mod has loaded once.

## Status

Early access API: Claude Code's function-hook plugin API moves between releases, so a newer engine may need small changes here. Written against Claude Code 2.1.293.
