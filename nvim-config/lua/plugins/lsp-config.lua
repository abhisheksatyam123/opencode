-- lua/plugins/lsp_and_treesitter.lua
return {
  -- Mason core
  {
    "williamboman/mason.nvim",
    lazy = false,
    config = function()
      require("mason").setup()
    end,
  },

  -- Mason ↔ LSP bridge (v2+)
  {
    "mason-org/mason-lspconfig.nvim",
    lazy = false,
    opts = {
      -- Install the servers you actually use
      ensure_installed = {
        -- General
        "lua_ls", "html", "cssls", "jsonls", "ts_ls",
        -- C/C++
        "clangd",
        -- markdown_oxide is built locally from source; not managed by Mason
      },
      -- We'll enable explicitly below (to avoid double-enabling)
      automatic_enable = false,
    },
  },

  -- Native LSP config and UI
  {
    "neovim/nvim-lspconfig",
    lazy = false,
    config = function()
      -- === Capabilities (nvim-cmp) ===
      local ok_cmp, cmp_nvim_lsp = pcall(require, "cmp_nvim_lsp")
      local capabilities = vim.tbl_deep_extend(
        "force",
        {},
        vim.lsp.protocol.make_client_capabilities(),
        ok_cmp and cmp_nvim_lsp.default_capabilities() or {}
      )

      -- === Diagnostic UI ===
      vim.diagnostic.config({
        virtual_text = { prefix = "●", source = "if_many" },
        signs = true,
        underline = true,
        update_in_insert = false,
        severity_sort = true,
        float = { border = "rounded", source = "always", header = "", prefix = "" },
      })
      local signs = { Error = " ", Warn = " ", Hint = "󰠠 ", Info = " " }
      for type, icon in pairs(signs) do
        local hl = "DiagnosticSign" .. type
        vim.fn.sign_define(hl, { text = icon, texthl = hl, numhl = "" })
      end

      -- === Bordered hover/signature ===
      vim.lsp.handlers["textDocument/hover"] =
        vim.lsp.with(vim.lsp.handlers.hover, { border = "rounded" })
      vim.lsp.handlers["textDocument/signatureHelp"] =
        vim.lsp.with(vim.lsp.handlers.signature_help, { border = "rounded" })

      -- === LspAttach: common keymaps ===
      vim.api.nvim_create_autocmd("LspAttach", {
        group = vim.api.nvim_create_augroup("UserLspConfig", { clear = true }),
        callback = function(ev)
          local bufnr = ev.buf
          local client = vim.lsp.get_client_by_id(ev.data.client_id)
          local opts = { buffer = bufnr, noremap = true, silent = true }

          local function clangd_source_definition_or_lsp()
            local word = vim.fn.expand("<cword>")
            local file = vim.api.nvim_buf_get_name(bufnr)
            local root = (client and client.config and client.config.root_dir)
              or (vim.fs.root and vim.fs.root(file, { "compile_commands.json", ".git" }))
              or vim.fn.getcwd()

            local function jump_to_first_rg_match(matches)
              if vim.v.shell_error ~= 0 or #matches == 0 then
                return false
              end
              local target, line, col = matches[1]:match("^(.-):(%d+):(%d+):")
              if not target then
                return false
              end
              vim.cmd("edit " .. vim.fn.fnameescape(target))
              vim.api.nvim_win_set_cursor(0, { tonumber(line), math.max(tonumber(col) - 1, 0) })
              vim.cmd("normal! zz")
              return true
            end

            if word ~= "" then
              local names = { word }
              if not word:match("^_") then
                table.insert(names, "_" .. word)
              end

              for _, name in ipairs(names) do
                -- Prefer real C function bodies over macro/declaration targets.
                -- This handles public macros such as offldmgr_foo -> _offldmgr_foo.
                local pattern = "^[[:space:]]*[A-Za-z_][A-Za-z0-9_[:space:]*]*[[:space:]*]+" .. name .. "[[:space:]]*\\("
                if jump_to_first_rg_match(vim.fn.systemlist({ "rg", "--vimgrep", "--glob", "*.c", pattern, root })) then
                  return
                end
              end

              -- clangd sometimes misses macro/type/enum locations while the index is stale.
              -- Prefer exact header/source declarations before falling back to LSP.
              for _, name in ipairs(names) do
                local symbol_patterns = {
                  "^[[:space:]]*(typedef[[:space:]]+)?(struct|union|enum)[[:space:]]+" .. name .. "\\b",
                  "^[[:space:]]*#[[:space:]]*define[[:space:]]+" .. name .. "\\b",
                  "^[[:space:]]*" .. name .. "[[:space:]]*=",
                  "^[[:space:]]*}[[:space:]]*" .. name .. "[[:space:]]*;",
                  "^[[:space:]]*typedef[[:space:]].*\\b" .. name .. "[[:space:]]*;",
                }
                for _, pattern in ipairs(symbol_patterns) do
                  if jump_to_first_rg_match(vim.fn.systemlist({ "rg", "--vimgrep", "--glob", "*.[ch]", pattern, root })) then
                    return
                  end
                end
              end
            end

            vim.lsp.buf.definition()
          end

          -- Navigation
          if client and client.name == "clangd" then
            vim.keymap.set("n", "gd", clangd_source_definition_or_lsp, vim.tbl_extend("force", opts, { desc = "Go to C source definition" }))
          else
            vim.keymap.set("n", "gd", vim.lsp.buf.definition, vim.tbl_extend("force", opts, { desc = "Go to definition" }))
          end
          vim.keymap.set("n", "gD", vim.lsp.buf.declaration,     vim.tbl_extend("force", opts, { desc = "Go to declaration" }))
          vim.keymap.set("n", "gr", vim.lsp.buf.references,      vim.tbl_extend("force", opts, { desc = "Find references" }))
          vim.keymap.set("n", "gi", vim.lsp.buf.implementation,  vim.tbl_extend("force", opts, { desc = "Go to implementation" }))
          vim.keymap.set("n", "gt", vim.lsp.buf.type_definition, vim.tbl_extend("force", opts, { desc = "Go to type definition" }))

          -- Docs
          vim.keymap.set("n", "K",       vim.lsp.buf.hover,          vim.tbl_extend("force", opts, { desc = "Hover documentation" }))
          vim.keymap.set("n", "<C-k>",   vim.lsp.buf.signature_help, vim.tbl_extend("force", opts, { desc = "Signature help" }))
          vim.keymap.set("i", "<C-k>",   vim.lsp.buf.signature_help, vim.tbl_extend("force", opts, { desc = "Signature help (insert)" }))

          -- Code actions, rename, format
          vim.keymap.set("n", "<leader>ca", vim.lsp.buf.code_action, vim.tbl_extend("force", opts, { desc = "Code action" }))
          vim.keymap.set("n", "<leader>rn", vim.lsp.buf.rename,      vim.tbl_extend("force", opts, { desc = "Rename symbol" }))
          vim.keymap.set("n", "<leader>f",  function() vim.lsp.buf.format({ async = true }) end,
            vim.tbl_extend("force", opts, { desc = "Format document" }))

          -- Diagnostics
          vim.keymap.set("n", "[d",        vim.diagnostic.goto_prev,   vim.tbl_extend("force", opts, { desc = "Prev diagnostic" }))
          vim.keymap.set("n", "]d",        vim.diagnostic.goto_next,   vim.tbl_extend("force", opts, { desc = "Next diagnostic" }))
          vim.keymap.set("n", "<leader>e", vim.diagnostic.open_float,  vim.tbl_extend("force", opts, { desc = "Diagnostic float" }))
          vim.keymap.set("n", "<leader>q", vim.diagnostic.setloclist,  vim.tbl_extend("force", opts, { desc = "Diagnostic list" }))

          -- Toggle inlay hints (Nvim 0.10+)
          if vim.lsp.inlay_hint then
            vim.keymap.set("n", "<leader>ih", function()
              vim.lsp.inlay_hint.enable(not vim.lsp.inlay_hint.is_enabled())
            end, vim.tbl_extend("force", opts, { desc = "Toggle inlay hints" }))
          end

          -- === markdown_oxide special bindings ===
          if client and client.name == "markdown_oxide" then
            -- gf: follow link (same as gd for markdown)
            vim.keymap.set("n", "gf", vim.lsp.buf.definition,
              { buffer = bufnr, desc = "Follow link (markdown)" })

            -- <CR>: follow link under cursor, or create note if unresolved
            vim.keymap.set("n", "<CR>", function()
              local params = vim.lsp.util.make_position_params(0, client.offset_encoding)
              client:request("textDocument/definition", params, function(err, result)
                vim.schedule(function()
                  if not err and result and not (vim.islist(result) and #result == 0) then
                    if vim.islist(result) then
                      vim.lsp.util.jump_to_location(result[1], client.offset_encoding)
                    else
                      vim.lsp.util.jump_to_location(result, client.offset_encoding)
                    end
                  else
                    -- Fallback: no definition found → offer code action (create note)
                    vim.lsp.buf.code_action({ apply = true })
                  end
                end)
              end, ev.buf)
            end, { buffer = bufnr, desc = "Follow link or create note" })

            -- <leader>ms: workspace symbol search (find headings/files across vault)
            vim.keymap.set("n", "<leader>ms", vim.lsp.buf.workspace_symbol,
              { buffer = bufnr, desc = "Moxide: search vault symbols" })

            -- <leader>mr: find all references to symbol under cursor
            vim.keymap.set("n", "<leader>mr", vim.lsp.buf.references,
              { buffer = bufnr, desc = "Moxide: find references" })

            -- <leader>ml: toggle code lens (reference counts)
            vim.keymap.set("n", "<leader>ml", function()
              vim.lsp.codelens.refresh()
            end, { buffer = bufnr, desc = "Moxide: refresh code lens" })

            -- <leader>md: open daily note (today)
            vim.keymap.set("n", "<leader>md", function()
              vim.lsp.buf.execute_command({ command = "today", arguments = {} })
            end, { buffer = bufnr, desc = "Moxide: open today's daily note" })

            -- :Daily <date> command (e.g. :Daily tomorrow, :Daily next monday)
            vim.api.nvim_create_user_command("Daily", function(args)
              local cmd = args.args ~= "" and args.args or "today"
              vim.lsp.buf.execute_command({ command = cmd, arguments = {} })
            end, { desc = "Open daily note (today/tomorrow/yesterday/weekday)", nargs = "*" })
          end
        end,
      })

      -- === Defaults for ALL servers
      vim.lsp.config("*", {
        capabilities = capabilities,
      })

      -- === Server-specific configs ===

      -- Lua
      vim.lsp.config("lua_ls", {
        settings = {
          Lua = {
            diagnostics = { globals = { "vim" } },
            workspace = { checkThirdParty = false },
            telemetry = { enable = false },
          },
        },
      })

      -- TypeScript / JavaScript (new name: ts_ls)
      vim.lsp.config("ts_ls", {})

      -- Web stack
      vim.lsp.config("html", {})
      vim.lsp.config("cssls", {})
      vim.lsp.config("jsonls", {})

      -- clangd
      vim.lsp.config("clangd", {
        cmd = {
          "/usr/local/bin/clangd",
          "--enable-config",
          "--background-index",
          "--background-index-priority=background",
          "-j=2",
          "--pch-storage=disk",
          "--malloc-trim",
          "--header-insertion=iwyu",
          "--completion-style=detailed",
          "--function-arg-placeholders",
          "--fallback-style=llvm",
          "--compile-commands-dir=/local/mnt/workspace/code1/WLAN.CNG.1.0-02042-QCACNGSWPL_V2_TO_SILICON-1",
        },
        root_markers = { "compile_commands.json" },
        init_options = {
          usePlaceholders = true,
          completeUnimported = true,
          clangdFileStatus = true,
        },
        capabilities = vim.tbl_deep_extend("force", capabilities, {
          textDocument = { completion = { editsNearCursor = true } },
        }),
        on_attach = function(client, bufnr)
          if vim.lsp.inlay_hint and client.server_capabilities.inlayHintProvider then
            vim.lsp.inlay_hint.enable(true, { bufnr = bufnr })
          end
        end,
      })

      -- Markdown Oxide (PKM Markdown LSP) — built locally from source.
      -- To update: cd /local/mnt/workspace/qprojects/markdown-oxide && cargo build --release
      -- Then :LspRestart in nvim.
      vim.lsp.config("markdown_oxide", {
        cmd = { "/local/mnt/workspace/qprojects/markdown-oxide/target/release/markdown-oxide" },
        filetypes = { "markdown" },
        -- Extend capabilities: enable willSaveWaitUntil and watched-file dynamic registration
        capabilities = vim.tbl_deep_extend("force", capabilities, {
          workspace = {
            didChangeWatchedFiles = { dynamicRegistration = true },
          },
          textDocument = {
            synchronization = {
              willSave = true,
              willSaveWaitUntil = true,
              didSave = true,
            },
          },
        }),
        root_markers = { ".git", ".obsidian", ".moxide.toml" },
        on_attach = function(client, bufnr)
          -- Enable inlay hints for markdown buffers if supported
          if vim.lsp.inlay_hint and client.server_capabilities.inlayHintProvider then
            vim.lsp.inlay_hint.enable(true, { bufnr = bufnr })
          end

          -- Fix completion for [[ and [text]( triggers.
          --
          -- nvim-cmp's default keyword_length=1 suppresses completion when the
          -- cursor is right after [[ with 0 keyword chars typed.  We override
          -- the nvim_lsp source for this buffer:
          --   keyword_length = 0  → trigger immediately on [ and (
          --   keyword_pattern     → capture the full [[note#heading or path#heading
          --                         prefix including hyphens, dots, spaces, #, ^
          --
          -- This is the right place for this: the LSP server already advertises
          -- trigger characters ([, (, #, >, space) via ServerCapabilities.
          -- nvim-cmp reads those automatically; we only need to fix the
          -- keyword_length and pattern so the prefix is sent correctly.
          local ok, cmp = pcall(require, "cmp")
          if ok then
            cmp.setup.buffer({
              sources = cmp.config.sources({
                {
                  name = "nvim_lsp",
                  -- Allow completion to fire with 0 keyword chars (e.g. right after [[)
                  keyword_length = 0,
                  -- Capture: word chars, hyphen, dot, space, slash, hash, caret, [, (
                  -- Plain Lua string (double-escaped) to avoid raw-string issues.
                  keyword_pattern = "\\(\\k\\|-\\|\\.\\| \\|\\/\\|#\\|\\^\\|\\[\\|(\\)\\+",
                },
                { name = "luasnip" },
              }, {
                { name = "buffer" },
              }),
            })
          end

          -- Trigger willSaveWaitUntil before every write so the server can
          -- normalize doc/ notes synchronously before the file hits disk.
          -- Neovim does not send this automatically even when the capability
          -- is advertised, so we fire it manually via BufWritePre.
          vim.api.nvim_create_autocmd("BufWritePre", {
            buffer = bufnr,
            group = vim.api.nvim_create_augroup("MoxideWillSave_" .. bufnr, { clear = true }),
            callback = function()
              local params = {
                textDocument = vim.lsp.util.make_text_document_params(bufnr),
                reason = 1, -- TextDocumentSaveReason.Manual
              }
              local result = client:request_sync(
                "textDocument/willSaveWaitUntil",
                params,
                1000, -- 1 second timeout
                bufnr
              )
              if result and result.result and #result.result > 0 then
                vim.lsp.util.apply_text_edits(result.result, bufnr, client.offset_encoding)
              end
            end,
          })
        end,
      })

      -- Enable exactly what we configured (no duplicates)
      vim.lsp.enable({ "lua_ls", "ts_ls", "html", "cssls", "jsonls", "clangd", "markdown_oxide" })
    end,
    dependencies = {
      "hrsh7th/nvim-cmp",
      "hrsh7th/cmp-nvim-lsp",
    },
  },

  -- Tree-sitter: make sure Markdown parsers exist so hover/signature never crash
  {
    "nvim-treesitter/nvim-treesitter",
    lazy = false,
    build = ":TSUpdate",
    opts = {
      ensure_installed = {
        "lua", "html", "css", "json", "javascript", "typescript",
        "markdown", "markdown_inline",
      },
      highlight = { enable = true, additional_vim_regex_highlighting = false },
      indent = { enable = true },
    },
    config = function(_, opts)
      require("nvim-treesitter.configs").setup(opts)
    end,
  },
}
