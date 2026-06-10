return {
  {
    "catppuccin/nvim",
    lazy = false,
    name = "catppuccin",
    priority = 1000,

    config = function()
      require("catppuccin").setup({
        transparent_background = false,
        custom_highlights = function(colors)
          return {
            -- Global float surfaces (hover, diagnostics, signature help)
            NormalFloat = { bg = colors.mantle },
            FloatBorder = { fg = colors.blue, bg = colors.mantle, bold = true },
            HoverFloat = { fg = colors.text, bg = colors.base },
            HoverBorder = { fg = colors.red, bg = colors.mantle, bold = true },

            -- Completion-specific borders for stronger visual distinction
            CmpBorder = { fg = colors.yellow, bg = colors.crust, bold = true },
            CmpDocBorder = { fg = colors.green, bg = colors.crust, bold = true },
          }
        end,
      })
      vim.cmd.colorscheme "catppuccin"
    end
  }
}
