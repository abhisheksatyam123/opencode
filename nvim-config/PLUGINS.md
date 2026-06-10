# Neovim Plugin Documentation 🚀

This document explains the purpose and key features of the currently active plugins installed in your Neovim configuration (`~/.config/nvim/lua/plugins/`).

## Index

- [🎨 UI & Aesthetics](#ui-aesthetics) — L9
- [🔍 Navigation & Search](#navigation-search) — L18
- [🛠️ Coding & LSP](#coding-lsp) — L31
- [🤖 AI](#ai) — L48
- [🐛 Debug (DAP)](#debug-dap) — L53
- [📊 Diagnostics](#diagnostics) — L62
- [🐙 Git](#git) — L69
- [📝 Notes (Obsidian)](#notes-obsidian) — L77
- [🔗 Specialized](#specialized) — L86
- [⚙️ Core Options (init.lua)](#core-options-initlua) — L98
- [🔧 Local Projects](#local-projects) — L115

## 🎨 UI & Aesthetics

- **Catppuccin** (`catppuccin.lua`): Soothing high-contrast colorscheme. Default theme.
- **Lualine** (`lualine.lua3`): Statusline — file info, encoding, cursor position.
- **Indent-Blankline** (`indent-blankline.lua3`): Vertical indent guides for nested code.
- **Highlight-Colors** (`highlight-colors.lua`): Highlight specific words in different colors.
  - `\` search/highlight, `<leader>k` toggle
- **Which-Key** (`which-key.lua`): Popup showing available keybindings after leader key.

## 🔍 Navigation & Search

- **Telescope** (`telescope.lua`): Fuzzy finder — files, grep, buffers. Also UI backend for other plugins.
  - `<leader>ff` find files, `<leader>fg` live grep, `<leader>fb` buffers, `<leader>fh` help tags
- **Harpoon 2** (`harpoon.lua`): Pin frequently used files for instant jumping.
  - `<leader>hm` add, `<leader>ha` toggle list, `<leader>hn`/`<leader>hp` next/prev, `<C-d>` remove in picker
- **Oil** (`oil.lua`): Filesystem editor — edit directories like a buffer.
  - `-` toggle float explorer
- **Flash** (`flash.lua2`): Jump to any character on screen.
  - `s` search/jump
- **Auto-Session** (`auto-session.lua1`): Auto save/restore sessions per working directory.
  - `<leader>wr` restore, `<leader>ws` save

## 🛠️ Coding & LSP

- **Mason + mason-lspconfig** (`lsp-config.lua`): LSP server manager. Auto-installs: `lua_ls`, `html`, `cssls`, `jsonls`, `ts_ls`, `clangd`.
- **nvim-lspconfig** (`lsp-config.lua`): Connects servers. Common keymaps on LspAttach:
  - `gd` definition, `gD` declaration, `gr` references, `gi` implementation, `gt` type def
  - `K` hover, `<C-k>` signature help, `<leader>ca` code action, `<leader>rn` rename
  - `[d`/`]d` prev/next diagnostic, `<leader>e` diagnostic float, `<leader>ih` toggle inlay hints
- **markdown_oxide** (local build): PKM Markdown LSP — wikilinks, backlinks, vault symbols.
  - `gf`/`<CR>` follow link, `<leader>ms` vault symbol search, `<leader>mr` references
  - `<leader>md` open today's daily note, `:Daily <date>` open any daily note
- **nvim-cmp + LuaSnip** (`completions.lua2`): Autocompletion from LSP + snippets.
- **Conform** (`conform.lua`): Formatter — prettier (JS/TS/CSS/HTML/JSON/MD), stylua (Lua).
  - `<leader>mp` format file or range
- **Treesitter** (`lsp-config.lua`): Syntax highlighting + indent. Parsers: lua, html, css, json, js, ts, markdown.
- **Autopairs + Autotag** (`autopairs.lua1`): Auto-close brackets, quotes, HTML/JSX tags.
- **AutoSave** (`autosave.lua1`): Auto-saves on InsertLeave.

## 🤖 AI

- **CodeCompanion** (`codecompanion.lua2`): AI chat + inline suggestions via Gemini.
  - `<leader>a` actions, `<leader>aa` toggle chat

## 🐛 Debug (DAP)

- **nvim-dap + nvim-dap-ui** (`dap.lua2`): Full debug adapter protocol UI.
  - `<leader>dc` continue, `<leader>db` breakpoint, `<leader>do` step over, `<leader>di` step into
  - `<leader>du` toggle UI, `<leader>de` eval expression, `<leader>dR` REPL
  - `<leader>dT` attach opencode TUI on :6499, `<leader>dA` attach to any Bun port
- **Adapters configured**: Bun (JS/TS via bun-debug-adapter-protocol), codelldb (Rust), delve (Go), local-lua (Lua)
- **Bun adapter**: uses `~/.local/share/nvim/bun-dap-adapter/server.cjs`; `stopOnEntry=true` so breakpoints bind before execution.

## 📊 Diagnostics

- **Trouble** (`trouble.lua2`): Centralized diagnostics dashboard.
  - `<leader>xx` toggle list
- **Todo-Comments** (`todo-comments.lua2`): Highlights TODO/FIXME/BUG/NOTE in code.
  - `<leader>st` search project-wide

## 🐙 Git

- **Gitsigns** (`gitsigns.lua4`): Diff markers in gutter, stage/reset hunks.
  - `]c`/`[c` next/prev hunk
- **Fugitive** (`fugitive.lua2`): `:Git` commands — blame, diff, etc.
- **LazyGit** (`lazygit.lua`): Full TUI git client inside Neovim.
  - `<leader>gg` toggle

## 📝 Notes (Obsidian)

- **obsidian.nvim** (`obsidian.lua`): PKM integration. Workspace: `/local/mnt/workspace/notes`.
  - Frontmatter patch: append-only (preserves inline arrays, field order, custom keys)
  - SRS: `<leader>osr` review, `<leader>osd` due, `<leader>oss` stats, `<leader>osb` browse
  - Tasks: `<leader>ott` toggle, `<leader>otd` done, `<leader>otb` blocked, `<leader>otc` cancel
  - Priority: `<leader>tp` cycle, `<leader>t1`/`t2`/`t3` set, `<leader>t.` defer
  - `conceallevel=0` globally (Neovim 0.12-dev TSHighlighter crash workaround)

## 🔗 Specialized

- **RelationWindow** (`plugin/relation_window.lua`): TUI backlink/forward-link graph for notes.
  - Local plugin: `/local/mnt/workspace/qprojects/tui-relation-window`
  - `:RWs` open split, `:RWt` open tab, `:RWr` refresh, `:RWtoggle` toggle
  - `:RelationWindowIncoming`/`Outgoing` switch direction
- **Cscope-Maps** (`cscope.lua2`): C/C++ cross-reference navigation.
  - `<leader>cs...` various search ops
- **Harpoon** (see Navigation above)
- **Fzf-Lua** (`fzf-lua.lua`): **disabled** (`enabled = false`)
- **Image** (`image.lua3`): **disabled** — terminal image rendering

## ⚙️ Core Options (init.lua)

| Option                      | Value                |
| --------------------------- | -------------------- |
| `mapleader`                 | `\`                  |
| `clipboard`                 | `unnamedplus`        |
| `number` + `relativenumber` | true                 |
| `tabstop` / `shiftwidth`    | 4                    |
| `expandtab`                 | true                 |
| `swapfile`                  | false                |
| `conceallevel`              | 0 (crash workaround) |
| `winborder`                 | `double`             |
| `timeoutlen`                | 1000ms               |

**Tab keymaps** (`<leader>tt*`): `c` create, `x` close, `n` next, `p` prev, `1-9` jump
**Window keymaps** (`<leader>tw*`): `x` close, `%` hsplit, `"` vsplit, `h/j/k/l` move, `1-9` jump

## 🔧 Local Projects

| Plugin               | Path                                                                          |
| -------------------- | ----------------------------------------------------------------------------- |
| obsidian.nvim (fork) | `/local/mnt/workspace/qprojects/obsidian.nvim_abhi`                           |
| tui-relation-window  | `/local/mnt/workspace/qprojects/tui-relation-window`                          |
| markdown-oxide       | `/local/mnt/workspace/qprojects/markdown-oxide/target/release/markdown-oxide` |
| bun                  | `/local/mnt/workspace/qprojects/opencode_pack/bun`                            |
| bun-dap-adapter      | `~/.local/share/nvim/bun-dap-adapter/server.cjs`                              |
