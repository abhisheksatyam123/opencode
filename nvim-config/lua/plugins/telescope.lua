return {
  "nvim-telescope/telescope.nvim",
  dependencies = { "nvim-lua/plenary.nvim" },
  config = function()
    local builtin = require("telescope.builtin")

    -- fdfind/rg both respect .gitignore by default; do not add --no-ignore.
    local find_command = { "fdfind", "--type", "f", "--color", "never" }
    local grep_arguments = {
      "rg",
      "--color=never",
      "--no-heading",
      "--with-filename",
      "--line-number",
      "--column",
      "--smart-case",
    }

    require("telescope").setup({
      defaults = {
        preview = { treesitter = false },
        path_display = { "filename_first", "truncate" },
        vimgrep_arguments = grep_arguments,
      },
      pickers = {
        find_files = {
          find_command = find_command,
          no_ignore = false,
          no_ignore_parent = false,
        },
        live_grep = {
          vimgrep_arguments = grep_arguments,
        },
      },
    })

    vim.keymap.set("n", "<leader>ff", builtin.find_files, { desc = "Find files" })
    vim.keymap.set("n", "<leader>fg", builtin.live_grep, { desc = "Live grep" })
    vim.keymap.set("n", "<leader>fb", builtin.buffers, { desc = "Buffers" })
    vim.keymap.set("n", "<leader>fh", builtin.help_tags, { desc = "Help tags" })
  end,
}
