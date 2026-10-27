# AI terminal for Zazabor: research and recommendations

*Researched 2026-10-19. Target: Tauri 2 (Rust) + plain TypeScript on Linux (X11, WebKitGTK). Frontend is xterm.js 6, backend is `portable-pty` 0.9. A first `src-tauri/src/term.rs` already exists: it spawns the default shell, streams `term-data` events, and reads the foreground program and cwd from `/proc`.*

## Summary

- **Blocks come from shell integration, not from the terminal.** The shell's `precmd`/`preexec` hooks print escape sequences that mark where the prompt, the command and the output start and stop. Warp sends a custom DCS carrying JSON and draws a separate grid for each command ([How Warp works](https://www.warp.dev/blog/how-warp-works)). Everyone else (VS Code, Ghostty, kitty, iTerm2, WezTerm) uses the **OSC 133** marks inside one ordinary grid, and adds an explicit command line and the cwd. xterm.js has one buffer, so Zazabor should follow **the VS Code model: markers plus decorations**.
- **You can inject integration without editing anyone's rc files.** The pattern is settled: bash `--init-file`, a temporary `ZDOTDIR` for zsh, and `XDG_DATA_DIRS` or `--init-command` for fish. In each case the injected script first sources the user's own files.
- **The AI work splits into two tiers.** *Command help* is one cheap, stateless call: turn plain English into a command, or explain a failed block. *Agent mode* is a Messages API tool loop. Each command the model proposes is shown, approved, run in the visible terminal, and read back from its block. Every product converges on deny, then ask, then allow rules: the denylist always wins, and only read-only commands may run without asking.
- **The main platform risk is WebKitGTK WebGL.** It can quietly fall back to a slow software path, and xterm.js 6 **removed the canvas renderer**, so the only fallback is the DOM renderer.

## Feature comparison

| Product | Stack | Command structure | Shell integration | AI | Command safety |
|---|---|---|---|---|---|
| **Warp** | Rust, own GPU UI, forked Alacritty grid | True blocks: one grid per command; copy, rerun, share, bookmark, filter, sticky header ([docs](https://docs.warp.dev/terminal/blocks/block-basics)) | precmd/preexec hooks emit a DCS with JSON; "Warpify" bootstraps subshells and SSH ([subshells](https://docs.warp.dev/terminal/warpify/subshells)) | Agent mode; auto-detects plain English vs a shell command ([modes](https://docs.warp.dev/agents/local-agents/interacting-with-agents/terminal-and-agent-modes/)); attach blocks as context ([docs](https://docs.warp.dev/agents/using-agents/agent-context/blocks-as-context)); "Full Terminal Use" types into vim or psql ([docs](https://docs.warp.dev/agents/full-terminal-use)) | Autonomy per action; the denylist (`rm`, `curl`, `wget`, `eval`) always asks; allowlist; the model judges whether a command is read-only ([permissions](https://docs.warp.dev/agents/capabilities/agent-profiles-permissions.md)); regex secret redaction, off by default ([docs](https://docs.warp.dev/privacy/secret-redaction)) |
| **Wave** (Apache-2.0) | Electron, React 19, Go backend (`creack/pty`), xterm.js 6 with fit, search, serialize, web-links and webgl, Monaco | Tiled "blocks" are widgets (terminal, preview, editor, web, AI), not commands | Own `OSC 16162` (A/C/D/M, command in base64); bash via `--rcfile` plus bash-preexec, zsh via `ZDOTDIR`; turned off inside tmux and screen ([script](https://github.com/wavetermdev/waveterm/blob/main/pkg/util/shellutil/shellintegration/bash_bashrc.sh)) | AI panel reads terminal scrollback and files, and writes files with a diff and approval; bring your own key; running commands is "coming soon" ([docs](https://github.com/wavetermdev/waveterm/blob/main/docs/docs/waveai.mdx)) | File access needs approval |
| **VS Code terminal** | Electron, xterm.js | One grid: exit-status decorations, overview ruler, sticky scroll, command navigation, quick fixes ([docs](https://code.visualstudio.com/docs/terminal/shell-integration)) | Injected automatically; `OSC 633` (A–E, P) plus 133 and 1337 | (not reviewed here) | Per-session nonce on the command-line sequence |
| **Ghostty / kitty** | Native GPU | Jump to prompt, select a command's output, click to move the cursor, show last output in a pager | bash: POSIX mode plus `ENV`; zsh: `ZDOTDIR`; fish/elvish/nushell: `XDG_DATA_DIRS` ([Ghostty](https://raw.githubusercontent.com/ghostty-org/ghostty/main/src/shell-integration/README.md), [kitty](https://sw.kovidgoyal.net/kitty/shell-integration/)) | — | — |
| **iTerm2** | macOS | Marks, cwd, user variables | OSC 133 plus `OSC 1337` (CurrentDir, RemoteHost, SetUserVar, ShellIntegrationVersion) ([codes](https://iterm2.com/documentation-escape-codes.html)) | — | — |
| **Zed** | Rust | Terminal panel and tabs | — | Inline assistant in the terminal (Ctrl+Enter) explains errors and suggests commands; the agent panel runs commands ([docs](https://zed.dev/docs/terminal)) | `always_allow` / `always_confirm` / `always_deny` regexes; chained commands are split; `rm -rf` of `/`, `~`, `.` and `..` is always blocked ([docs](https://zed.dev/docs/ai/tool-permissions)) |
| **Claude Code** | CLI agent | — | — | Agent loop with a Bash tool | Deny, then ask, then allow; checks each part of a command chained with `&&`, `\|\|`, `;`, `\|`, `&` or a newline; strips `timeout`, `nice` and similar wrappers before matching; built-in read-only commands ([docs](https://code.claude.com/docs/en/permissions)) |
| **Tabby** (MIT) | Electron | Tabs and splits, SSH/serial client, encrypted secrets vault ([repo](https://github.com/Eugeny/tabby)) | — | Only through an MCP plugin | — |
| **Atuin** | Rust | SQLite history with cwd, duration, success, host and session; Ctrl+R search; end-to-end encrypted sync ([docs](https://docs.atuin.sh/latest/)) | bash-preexec | `?` on an empty prompt turns plain English into a command ([AI](https://docs.atuin.sh/latest/ai/introduction/)) | The model rates how dangerous a command is; above a threshold, an extra confirmation |
| **Kiro CLI** (formerly Amazon Q / Fig) | Rust | — | — | Declarative completion specs, a dropdown, and inline ghost text ([AWS](https://aws.amazon.com/about-aws/whats-new/2024/06/amazon-q-inline-completions-command-line)) | — |

## Techniques

### 1. The marking protocol

| Sequence | Meaning |
|---|---|
| `OSC 133;A ST` | The prompt starts (the spec says to do a fresh-line first) |
| `OSC 133;B ST` | The prompt ends and the user starts typing |
| `OSC 133;C ST` | The command runs; output starts |
| `OSC 133;D;<exit> ST` | The command finished. `D` with no preceding `C` means it was cancelled |
| `OSC 633;E;<cmdline>;<nonce> ST` | The exact command line (VS Code) |
| `OSC 633;P;Cwd=<path> ST` / `OSC 7;file://host/path ST` | The working directory |

Sources: [iTerm2](https://iterm2.com/documentation-escape-codes.html), [VS Code](https://code.visualstudio.com/docs/terminal/shell-integration). The [semantic-prompts spec](https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md) adds:

- `133;L` (fresh-line).
- `133;P;k=c|s` for continuation prompts (PS2).
- `cl=line`: the terminal turns a click into arrow keys to move the cursor.
- A recommendation not to reflow the input line on resize.

**Don't scrape the command text** from the screen between B and C. Wrapped lines, right-hand prompts and autosuggestion ghost text all end up in it. Have the shell send the command explicitly:

- VS Code: `633;E`.
- kitty: `133;C;cmdline=`.
- Wave: base64 in `16162;C`.

**Spoofing:** any program's output can contain these sequences (`cat evil.txt`). VS Code passes `VSCODE_NONCE` to the shell and attaches it to `633;E`. Zazabor should do the same, and trust command text for the AI only when it carries the nonce.

**Recommendation:** emit `133` A/B/C/D, `633;E` with the nonce, and OSC 7. Accept 133, 633, 7 and `1337;CurrentDir`, so marks from other sources keep working too, such as fish 4's built-in marks.

### 2. Injecting integration without touching rc files

| Shell | How (VS Code, from [`terminalEnvironment.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/node/terminalEnvironment.ts)) | What the script must do |
|---|---|---|
| bash | `bash --init-file <dir>/zazabor.bash`. Ghostty and kitty instead use POSIX mode plus `ENV`; Wave uses `--rcfile` | Source `~/.bashrc`. For a login shell, also source `/etc/profile` and the first of `~/.bash_profile`, `~/.bash_login`, `~/.profile`, because `--init-file` can't be combined with `-l`. Hook in with [bash-preexec](https://github.com/rcaloras/bash-preexec) (DEBUG trap plus `PROMPT_COMMAND`). Reuse it if `bash_preexec_imported` is already set (Atuin, Starship), and give up if `extdebug` is on, as Wave does. Bash 4.4+ `PS0` can print `C` without the DEBUG trap |
| zsh | `ZDOTDIR` points at a private temp dir (mode `0700`/`1700`) holding `.zshenv`, `.zprofile`, `.zshrc` and `.zlogin`. `USER_ZDOTDIR` remembers the original | Each file restores `ZDOTDIR` and sources the user's matching file. Hooks go in with `add-zsh-hook precmd/preexec`. A `ZDOTDIR` set in `/etc/zshenv` overrides this |
| fish | `fish --init-command 'source …'`, or put a `fish/vendor_conf.d/` dir first in `XDG_DATA_DIRS` (Ghostty/kitty) | Use the `fish_prompt`, `fish_preexec` and `fish_postexec` events, then remove the added `XDG_DATA_DIRS` entry |

Rules that every implementation follows:

- **Only the first shell gets integration.** Nested shells, `sudo -s`, `ssh` and `docker exec` don't ([Ghostty](https://ghostty.org/docs/features/shell-integration)). When no marks arrive, fall back to a plain terminal.
- **Turn integration off inside tmux and screen**, as Wave does.
- **Offer a manual snippet** guarded by `$TERM_PROGRAM == Zazabor`, as VS Code does, plus a setting to opt out.

### 3. cwd, exit codes, the foreground program, and interactive programs

- **Exit code and duration:** read the code from `133;D`, and time the gap from C to D.
- **cwd:** OSC 7 or `633;P;Cwd`. These also work over SSH when the remote shell sends them. Fall back to `/proc/<shell pid>/cwd`, which `term.rs` already does.
- **Foreground program:** `MasterPty::process_group_leader()` (`tcgetpgrp`) plus `/proc/<pid>/comm`, which `term_info` already does ([docs](https://docs.rs/portable-pty/latest/portable_pty/trait.MasterPty.html)).
- **Full-screen programs** (vim, htop, less): `term.buffer.active.type === 'alternate'` and `onBufferChange` tell you. Hide the block chrome; `registerDecoration` returns `undefined` while the alternate buffer is active anyway. Pass PageUp, PageDown, Home and End through to the program, as Warp does.
- **Interactive programs that stay on the main screen** (a REPL, `ssh`, a `read` prompt): the command started (`C`), no `D` has arrived, and the foreground process is not the shell.
- **Password prompts:** `MasterPty::get_termios()` shows ECHO off. Mark the block "input hidden". The AI must never read it or type into it.

### 4. A block UI on xterm.js

**The APIs** ([typings](https://github.com/xtermjs/xterm.js/blob/master/typings/xterm.d.ts)):

- `parser.registerOscHandler(133, cb)` receives the marks. Payloads are capped at 10 MB.
- `registerMarker(offset)` returns an `IMarker` that follows its line as scrollback moves. Its `line` becomes `-1` once the line is trimmed.
- `registerDecoration({marker, anchor, x, width, height, backgroundColor, foregroundColor, layer, overviewRulerOptions})` returns a DOM element through `onRender`. The overview ruler needs `scrollbar.width`.

**Limits:**

- Decorations sit on the cell grid. You can't add vertical gaps, so Warp-style separate cards aren't possible inside one xterm.
- Colours must be `#RRGGBB`.
- Decorations don't appear in the alternate buffer.
- Decorations die when their lines leave the scrollback.

**So build what VS Code built:**

- A gutter bar on each command, coloured by its exit status, with failures also marked on the overview ruler.
- A toolbar on hover: copy command, copy output, rerun, explain, attach to AI.
- Ctrl+Up/Down to jump between commands.
- A sticky header showing the command at the top of the view.
- Output read from the lines between the C and D markers (`getLine(i).translateToString(true)`).

**Addons** (xterm 6.0.0; [release notes](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0)):

| Addon | Use |
|---|---|
| `fit` | Resize the terminal to its container |
| `web-links` | Clickable links |
| `search` | Find in scrollback |
| `unicode11` | Correct character widths; needs `allowProposedApi: true` |
| `serialize` | Restore sessions; HTML export of a block |
| `clipboard` | OSC 52 |
| `image` | Sixel and iTerm images |
| `progress` | ConEmu `OSC 9;4` progress |
| `webgl` | GPU rendering, opt-in only (see risks); there is no canvas fallback any more |

**Throughput:**

- Use xterm's write-callback watermarks (HIGH ≈ 100 KB, LOW ≈ 10 KB, never above 500 KB) and push back on the PTY ([guide](https://xtermjs.org/docs/guides/flowcontrol/)).
- Tauri says events are "not designed for low latency or high throughput"; **use `tauri::ipc::Channel`**, which is ordered and fast ([docs](https://v2.tauri.app/develop/calling-frontend/)).

### 5. The AI side

**API** ([tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview), [streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)):

- `POST /v1/messages` is stateless. Claude replies with `tool_use` blocks; we run the tool and answer with `tool_result` blocks, all in one user message.
- Streaming arrives as SSE: `message_start`, then `content_block_start/delta/stop` (text or `input_json_delta`), then `message_delta` and `message_stop`.

**Models** (current list, per 1M tokens):

| Model | Price (in / out) | Use |
|---|---|---|
| `claude-haiku-5-5` | $0.10 / $0.50 (prompts up to 100K tokens), 1M context | Command help |
| `claude-sonnet-5-5` | $2 / $10 | Agent loop |
| `claude-opus-5-5` | $4 / $20, 128K max output | Hard tasks |

**Current API details:**

- Opus 5.5 and Sonnet 5.5 reject a forced `tool_choice` (`any`/`tool`). Use `auto` with `strict: true` on the tools instead.
- Thinking is `{type: "adaptive"}`, tuned with `output_config.effort`. Opus 5.5's default effort is `medium`.
- Assistant prefill isn't allowed.
- Large `max_tokens` needs streaming.
- Prompt caching works on an exact prefix, so keep the system prompt and tool definitions byte-stable.

**Tool choice:** Anthropic's built-in `bash_20250124` tool assumes the app owns a persistent bash session. Its docs say to run it isolated, use an allowlist, set `ulimit`, log everything, **redact secrets**, and truncate output. They also note that it can't run interactive commands and that the API never truncates results ([bash tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/bash-tool)). For Zazabor, a **custom `run_command` tool** works better:

- Inputs: `{command, reason, expected_effect: read_only|modifies|destructive|network}`. The UI shows `reason`; the risk is the model's own claim and is never trusted.
- Companion tools: `list_blocks` and `read_block(id, range)`, and later a `read_file` confined to the workspace.

**Where the loop runs: in Rust.**

- The key never enters the webview, where hostile terminal output or rendered markdown could leak it.
- There are no CORS or CSP problems.
- Rust still knows when a command finished even while the window is hidden.

There's no official Rust SDK, so use `reqwest` with an SSE parser. The alternative is the TypeScript SDK in the webview, which puts the key in the webview.

**Keys:** store them in the OS keyring with the `keyring` crate (4.x, Secret Service on Linux), with `ANTHROPIC_API_KEY` as a fallback. Never put them in settings JSON or `localStorage`. Minimal Linux setups have no Secret Service; show a clear error there. `tauri-plugin-stronghold` is an option if a master password is acceptable.

**Context budget:**

- Keep each request to roughly 20–30K tokens of terminal context: OS, shell, cwd, git branch, the last N blocks (command, exit code, and the head and tail of the output), and the current selection.
- Measure with `/v1/messages/count_tokens`.
- Cut each block to about 200 lines or 16 KB, keeping head and tail.

**Redaction, done in Rust before anything is sent:**

- Regexes like Warp's recommended list: AWS, GitHub, Slack and Stripe keys, JWTs, OpenAI and Anthropic keys, IP addresses.
- PEM blocks, `*_KEY=`/`*_TOKEN=`/`PASSWORD=` assignments, and long high-entropy strings.
- Leave out blocks whose command starts with a space (the `HISTCONTROL=ignorespace` convention) and blocks marked "input hidden". Never send an environment dump.
- Show a "what will be sent" preview.
- Regexes miss things; Warp's feature is opt-in, and [critics](https://speedscale.com/blog/what-the-warp-terminal-sends-home/) say patterns can't reliably catch credentials. So redaction is defence in depth, not a guarantee.

## Recommended feature set

### P1: A solid terminal and blocks through shell integration

**Rust**

- Move `term.rs` from `emit_to("term-data")` to one `Channel` per terminal. Batch output (about 4 ms or 64 KB) and add flow control: stop reading when unacknowledged bytes pass HIGH, and resume when the frontend acknowledges.
- Inject integration (§2):
  - Bundle `zazabor.bash`, a zsh `ZDOTDIR` set, and `zazabor.fish` as resources.
  - Detect the shell from `$SHELL` or passwd.
  - Set `ZAZABOR_NONCE` (the script copies it into a shell variable and unsets the exported one) and `TERM_PROGRAM_VERSION`.
  - Add a setting to turn it off.
- In the reader thread, add a light OSC scanner (a byte state machine for `ESC ] 133/633/7`, not a full emulator). It tracks each terminal's state (at prompt, running, alternate screen), last exit code and cwd, which P3 and "close while running?" need.
- Add the termios ECHO check to `term_info`.
- Optional: an Atuin-style SQLite history of command, cwd, exit code, duration and time, without output, behind a privacy setting.

**Frontend**

- xterm 6 with fit, web-links, search, unicode11, serialize and clipboard. DOM renderer by default; WebGL behind a setting, disposed on `onContextLoss`.
- OSC handlers build a block model: `{id, markers A/B/C/D, command, exit, cwd, start, end}`.
- Block UI from §4: gutter colours, ruler ticks, hover toolbar, sticky header, Ctrl+Up/Down, copy output, rerun.
- Hide the chrome on the alternate screen.
- Handle keys with `attachCustomKeyEventHandler`: Ctrl+Shift+C/V/F, and keep Monaco's shortcuts out while the terminal has focus.
- Map Zazabor's colour tokens to an xterm `ITheme` for light and dark.
- Show the terminal both as the editor window's panel and as its own window, with tabs titled from the foreground program and cwd.
- When there are no marks, act as a plain terminal.

### P2: AI command help

**Rust:** an `ai` module.

- Key in the keyring.
- A streaming `/v1/messages` client with cancel, mapping of 429 and 5xx errors to messages, and usage and cost counters.
- Redaction and context assembly. The frontend sends rendered block text; Rust redacts it and streams deltas back over a Channel.

**Frontend:**

- **Ask bar** (Ctrl+I, as in Warp, or a `#` prefix): plain English in, 1–3 candidate commands with one-line explanations out (Haiku 5.5). **Insert with bracketed paste and no Enter**, so the user reviews and runs it.
- **Explain** and **Suggest fix** buttons on failed blocks.
- **Attach blocks or a selection as context.**
- A preview of what will be sent, with redaction marks.
- Saved commands with `{{arg}}` placeholders (like [Warp workflows](https://docs.warp.dev/terminal/entry/yaml-workflows)) in the command palette. They're cheap and work well alongside the AI.

### P3: Agent mode

**Rust:** a manual agent loop. Each step:

1. Read the proposed `tool_use` and validate its input.
2. Run the **policy engine**:
   - Split chains (`&&`, `||`, `;`, `|`, `&`, newlines, `$(…)`, backticks) and strip wrappers.
   - Order: deny, then ask, then allow.
   - Built-in denials no setting can override: `rm -r` on `/`, `~`, `.` or `..`; `mkfs`; `dd of=/dev/*`; `curl … | sh`.
   - Always ask for `sudo`, `rm`, `git push`, `chmod -R`, network commands, and anything writing outside the workspace.
3. Show the **approval card**.
4. The **executor** writes the command into the visible PTY, only when the shell is at the prompt, using bracketed paste plus `\r`. It then waits for `D`:
   - It times out after a set time and offers Ctrl+C.
   - It stops and hands control back on the alternate screen or ECHO off.
5. Collect the block output: strip ANSI codes, truncate, redact.
6. Return a `tool_result` that includes the exit code.

Around the loop:

- An iteration and token budget.
- A JSONL audit log in the app data folder.
- Cancel with Esc.

**Frontend:**

- An agent side panel in the editor window.
- An approval card showing the exact command, cwd, reason and risk badge, with **Run / Edit / Skip / Always allow `prefix *`**.
- The agent's own blocks tinted, a Stop button, and an editor for the rules.

**Defaults:** always ask, except for allowlisted read-only commands (`ls`, `cat`, `pwd`, `which`, `git status/log/diff`, and `grep`/`find` without `-exec` or `-delete`). There is no "run to completion" in v1. If it's added later, the denylist must still apply. Warp's default is to bypass the denylist in that mode; avoid copying that.

## Risks

**Security**

- **Never run a command the user hasn't approved** unless it is allowlisted and read-only. Destructive commands always ask.
- **Prompt injection:** a `curl`'d page, a README or a log file can tell the model what to do. Treat output as data (wrap it in tags, and say so in the system prompt), show the full command, and rely on the policy engine. Don't rely on the model to judge risk.
- **Secrets in context:** regex redaction is incomplete. Keep the preview, skip hidden-input blocks, and send no environment dumps.
- **OSC spoofing:** require the nonce on command text.
- **Key exposure:** handle the key and the HTTP calls only in Rust.

**WebKitGTK**

- WebGL2 creation "succeeds even when the result is backed by a software rasterizer", and the renderer string is masked ([Tauri](https://v2.tauri.app/develop/debug/linux-graphics/)). Make the renderer a setting and default to DOM.
- NVIDIA and DMABUF problems: offer `WEBKIT_DISABLE_DMABUF_RENDERER=1`, but don't force it.
- Wait for `document.fonts.ready` before `fit()`, or cell widths come out wrong.
- Fractional scaling changes `devicePixelRatio`; refit when it does.
- Check whether middle-click (PRIMARY selection) paste works in the webview. If it doesn't, implement it in Rust; `arboard` has Linux primary-selection support.
- Test IME composition.

**Shell integration is fragile.** Heavy rc frameworks, `PROMPT_COMMAND` overwrites, prompt themes, tmux, SSH and old fish versions can all break it. Detect missing marks and degrade quietly.

**Cost and latency.** Agent loops resend the history on every turn. Use prompt caching, budgets and truncation.

## Open questions for the user

1. **Provider:** Anthropic only, or also OpenAI, local Ollama, or a self-hosted gateway (as Wave supports)? This decides how abstract the `ai` module needs to be.
2. **The API key:** paste it into Settings (stored in the keyring), use the `ANTHROPIC_API_KEY` env var, or both? Do you want a monthly spend cap?
3. **Model defaults:** OK with Haiku 5.5 for help and Sonnet 5.5 for the agent, with Opus 5.5 as an opt-in?
4. **The agent's home:** the editor window's side panel, the terminal window, or both? Should it see the open Monaco file and workspace?
5. **Where agent commands run:** in your visible terminal (transparent, the recommendation) or a hidden separate session?
6. **Autonomy:** should anything ever auto-run? Which commands go on the read-only allowlist?
7. **Shells and remotes:** which shell do you use (bash, zsh or fish)? Do blocks need to work over SSH or in tmux?
8. **Rendering:** do you have an NVIDIA GPU? Are you OK with DOM as the default and WebGL as an opt-in?
9. **History and privacy:** may Zazabor keep command history (no output) on disk? Should AI requests be logged locally?
