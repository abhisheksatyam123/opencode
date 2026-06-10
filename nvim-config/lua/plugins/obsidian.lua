return {
  dir = "/local/mnt/workspace/qprojects/obsidian.nvim_abhi",
  name = "obsidian.nvim",
  lazy = true,
  ft = "markdown",
  dependencies = {
    "nvim-lua/plenary.nvim",
  },
  config = function()
    require("obsidian").setup({
      workspaces = {
        {
          name = "personal",
          path = "/local/mnt/workspace/notes",
        },
      },

      note_id_func = function(title)
        return title
      end,

      wiki_link_func = function(opts)
        return require("obsidian.util").wiki_link_id_prefix(opts)
      end,

      markdown_link_func = function(opts)
        return require("obsidian.util").markdown_link(opts)
      end,

      -- Task Management Configuration
      tasks = {
        enabled = true,
        auto_pause_on_exit = true,
        stale_threshold_days = 3,
        daily_stats_placeholder = "<!-- obsidian-task-stats -->",
      },

      -- UI checkboxes for all task states
      ui = {
        enable = true,
        update_debounce = 200,
        max_file_length = 5000,
        checkboxes = {
          [" "] = { char = "󰄱", hl_group = "ObsidianTodo" },
          ["/"] = { char = "🟢", hl_group = "ObsidianActive" },
          ["|"] = { char = "⏸", hl_group = "ObsidianPaused" },
          ["?"] = { char = "🚧", hl_group = "ObsidianBlocked" },
          ["-"] = { char = "❌", hl_group = "ObsidianCancelled" },
          ["x"] = { char = "✅", hl_group = "ObsidianDone" },
        },
        hl_groups = {
          ObsidianTodo = { bold = true, fg = "#f78c6c" },
          ObsidianActive = { bold = true, fg = "#89ddff" },
          ObsidianPaused = { bold = true, fg = "#ffcb6b" },
          ObsidianBlocked = { bold = true, fg = "#ff5370" },
          ObsidianCancelled = { bold = true, fg = "#676e95" },
          ObsidianDone = { bold = true, fg = "#c3e88d" },
          ObsidianP1 = { bold = true, fg = "#ff5370" },
          ObsidianP2 = { bold = true, fg = "#ffcb6b" },
          ObsidianP3 = { bold = true, fg = "#89ddff" },
          ObsidianDeferred = { italic = true, fg = "#676e95" },
        },
      },
    })

    -- Patch Note.frontmatter_lines to be append-only.
    --
    -- obsidian.nvim's default implementation serialises the frontmatter table
    -- back to YAML from scratch on every save.  This destroys:
    --   • inline arrays  (model_fallbacks: [...] → block list)
    --   • quoted strings (description: "..." → unquoted)
    --   • nested maps    (permission:\n  "*": allow → reformatted)
    --   • field order    (keys sorted alphabetically)
    --   • custom keys    (agent/tier/mode/... dropped if not in metadata)
    --
    -- The replacement reads the raw frontmatter lines already in the buffer,
    -- emits them verbatim, then appends only the keys that are genuinely
    -- absent (id, aliases, tags).  Existing keys are never touched.
    local Note = require("obsidian.note")
    local yaml = require("obsidian.yaml")

    Note.frontmatter_lines = function(self, eol, _frontmatter)
      -- Read raw lines currently in the buffer for this note.
      local bufnr = self.bufnr or vim.api.nvim_get_current_buf()
      local all_lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)

      -- Extract the existing frontmatter block verbatim.
      local raw_fm = {}       -- lines between the two ---
      local has_fm = false
      local fm_end = 0        -- 1-based index of closing ---

      if all_lines[1] and all_lines[1]:match("^---") then
        has_fm = true
        for i = 2, #all_lines do
          if all_lines[i]:match("^---") then
            fm_end = i
            break
          end
          table.insert(raw_fm, all_lines[i])
        end
      end

      -- Determine which managed keys are already present.
      local has_id, has_aliases, has_tags = false, false, false
      for _, line in ipairs(raw_fm) do
        local key = line:match("^([%w_]+)%s*:")
        if key == "id"      then has_id      = true end
        if key == "aliases" then has_aliases = true end
        if key == "tags"    then has_tags    = true end
      end

      -- Build output: original lines verbatim, then append missing keys only.
      local out = { "---" }
      for _, line in ipairs(raw_fm) do
        table.insert(out, line)
      end

      if not has_id then
        table.insert(out, "id: " .. tostring(self.id))
      end

      if not has_aliases then
        local alias_lines = yaml.dumps_lines(self.aliases, nil)
        table.insert(out, "aliases:")
        for _, l in ipairs(alias_lines) do
          table.insert(out, "  " .. l)
        end
      end

      if not has_tags then
        if #self.tags > 0 then
          table.insert(out, "tags:")
          for _, t in ipairs(self.tags) do
            table.insert(out, "  - " .. t)
          end
        else
          table.insert(out, "tags: []")
        end
      end

      table.insert(out, "---")

      -- Keep the blank line after frontmatter when the note had none before.
      if not has_fm then
        table.insert(out, "")
      end

      if eol then
        return vim.tbl_map(function(l) return l .. "\n" end, out)
      end
      return out
    end

    -- SRS Keymaps
    vim.keymap.set("n", "<leader>osr", "<cmd>ObsidianSRSReview<cr>",
      { noremap = true, silent = true, desc = "SRS: Review due flashcards" })
    vim.keymap.set("n", "<leader>osd", "<cmd>ObsidianSRSDue<cr>",
      { noremap = true, silent = true, desc = "SRS: List due flashcards" })
    vim.keymap.set("n", "<leader>oss", "<cmd>ObsidianSRSStats<cr>",
      { noremap = true, silent = true, desc = "SRS: Show statistics" })
    vim.keymap.set("n", "<leader>osb", "<cmd>ObsidianSRSBrowse<cr>",
      { noremap = true, silent = true, desc = "SRS: Browse all cards" })

    -- Task Management Keymaps
    vim.keymap.set("n", "<leader>ott", "<cmd>ObsidianTaskToggle<cr>",
      { noremap = true, silent = true, desc = "Task: Smart toggle state" })
    vim.keymap.set("n", "<leader>otd", "<cmd>ObsidianTaskToggle done<cr>",
      { noremap = true, silent = true, desc = "Task: Mark done" })
    vim.keymap.set("n", "<leader>otb", "<cmd>ObsidianTaskToggle blocked<cr>",
      { noremap = true, silent = true, desc = "Task: Mark blocked" })
    vim.keymap.set("n", "<leader>otc", "<cmd>ObsidianTaskToggle cancel<cr>",
      { noremap = true, silent = true, desc = "Task: Cancel" })
    vim.keymap.set("n", "<leader>otp", "<cmd>ObsidianTaskPauseAll<cr>",
      { noremap = true, silent = true, desc = "Task: Pause all active" })
    vim.keymap.set("n", "<leader>otD", "<cmd>ObsidianTaskDashboard<cr>",
      { noremap = true, silent = true, desc = "Task: Open dashboard" })
    vim.keymap.set("n", "<leader>ots", "<cmd>ObsidianTaskStats<cr>",
      { noremap = true, silent = true, desc = "Task: Show daily stats" })

    -- Priority Keymaps
    vim.keymap.set("n", "<leader>tp", "<cmd>ObsidianTaskPriority<cr>",
      { noremap = true, silent = true, desc = "Task: Cycle priority" })
    vim.keymap.set("n", "<leader>t1", "<cmd>ObsidianTaskPriority 1<cr>",
      { noremap = true, silent = true, desc = "Task: Set P1" })
    vim.keymap.set("n", "<leader>t2", "<cmd>ObsidianTaskPriority 2<cr>",
      { noremap = true, silent = true, desc = "Task: Set P2" })
    vim.keymap.set("n", "<leader>t3", "<cmd>ObsidianTaskPriority 3<cr>",
      { noremap = true, silent = true, desc = "Task: Set P3" })
    vim.keymap.set("n", "<leader>t.", "<cmd>ObsidianTaskPriority defer<cr>",
      { noremap = true, silent = true, desc = "Task: Defer" })

    -- Auto-regenerate ## Index on every :w for markdown files in the notes vault.
    -- Uses gen-index.py from the atomic skills vault.
    -- Scoped to /local/mnt/workspace/notes/** only — never fires outside the vault.
    vim.api.nvim_create_autocmd("BufWritePost", {
      group = vim.api.nvim_create_augroup("VaultIndexRegen", { clear = true }),
      pattern = "/local/mnt/workspace/notes/**/*.md",
      callback = function(args)
        local filepath = args.file
        local script   = "/local/mnt/workspace/notes/atomic/skills/gen-index.py"

        -- Only run if the file actually has a ## Index section
        local f = io.open(filepath, "r")
        if not f then return end
        local has_index = false
        for line in f:lines() do
          if line:match("^## Index%s*$") then
            has_index = true
            break
          end
        end
        f:close()
        if not has_index then return end

        -- Run gen-index.py async so :wq doesn't block
        vim.fn.jobstart({ "python3", script, filepath }, {
          on_exit = function(_, code)
            if code == 0 then
              -- Reload buffer silently so the updated index is visible immediately
              vim.schedule(function()
                local bufnr = vim.fn.bufnr(filepath)
                if bufnr ~= -1 and vim.api.nvim_buf_is_loaded(bufnr) then
                  vim.api.nvim_buf_call(bufnr, function()
                    vim.cmd("silent! checktime")
                  end)
                end
              end)
            else
              vim.notify("gen-index: failed on " .. vim.fn.fnamemodify(filepath, ":t"), vim.log.levels.WARN)
            end
          end,
        })
      end,
    })
  end,
}
