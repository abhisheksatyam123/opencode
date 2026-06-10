return {
    "Mr-LLLLL/interestingwords.nvim",
    config = function()
        require("interestingwords").setup {
            colors = { '#aeee00', '#ff0000', '#0000ff', '#b88823', '#ffa722', '#ff00ff' },
            search_count = true,
            navigation = true,
            -- Keep <leader> ("\") free for leader-prefixed mappings.
            search_key = "gz",
            cancel_search_key = "<leader>c",
            color_key = "<leader>k",
            cancel_color_key = "<leader>K",
        }
    end
}
