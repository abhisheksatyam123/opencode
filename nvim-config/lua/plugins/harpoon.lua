return {
    "ThePrimeagen/harpoon",
    branch = "harpoon2",
    dependencies = { "nvim-lua/plenary.nvim", "nvim-telescope/telescope.nvim" },
    config = function()
        local harpoon = require("harpoon")
        harpoon:setup()
        -- REQUIRED

        local function toggle_telescope(harpoon_files)
            local telescope = require("telescope")
            local conf = require("telescope.config").values
            local make_entry = require("telescope.make_entry")
            local file_entry_maker = make_entry.gen_from_file({})
            local file_paths = {}
            for _, item in ipairs(harpoon_files.items) do
                table.insert(file_paths, item.value)
            end

            require("telescope.pickers").new({}, {
                prompt_title = "Harpoon",
                finder = require("telescope.finders").new_table({
                    results = file_paths,
                    entry_maker = file_entry_maker,
                }),
                previewer = conf.file_previewer({}),
                sorter = conf.generic_sorter({}),
                attach_mappings = function(prompt_bufnr, map)
                    local state = require("telescope.actions.state")
                    map({"n", "i"}, "<C-d>", function()
                        local selected_entry = state.get_selected_entry()
                        if not selected_entry then return end
                        local current_picker = state.get_current_picker(prompt_bufnr)

                        -- Find item and remove it
                        for _, item in pairs(harpoon_files.items) do
                            if item and item.value == selected_entry.value then
                                harpoon_files:remove(item)
                                break
                            end
                        end

                        -- Pack list.items to collapse the index gaps so that ipairs, select, next/prev navigation remains fully intact
                        local packed = {}
                        for _, item in pairs(harpoon_files.items) do
                            if item and item.value ~= "" then
                                table.insert(packed, item)
                            end
                        end
                        harpoon_files.items = packed
                        harpoon_files._length = #packed

                        -- Build updated paths list for telescope finder (filtering empty paths)
                        local new_paths = {}
                        for _, item in ipairs(harpoon_files.items) do
                            table.insert(new_paths, item.value)
                        end

                        current_picker:refresh(
                            require("telescope.finders").new_table({
                                results = new_paths,
                                entry_maker = file_entry_maker,
                            }),
                            { reset_prompt = false }
                        )
                    end)
                    return true
                end,
            }):find()
        end

        vim.keymap.set("n", "<leader>ha", function() toggle_telescope(harpoon:list()) end,
            { desc = "Open harpoon window" })

        vim.keymap.set("n", "<leader>he", function() harpoon.ui:toggle_quick_menu(harpoon:list()) end,
            { desc = "Open harpoon default menu" })

        vim.keymap.set("n", "<leader>hm", function() harpoon:list():add() end,
            { desc = "Add file to harpoon" })

        -- Basic navigation
        vim.keymap.set("n", "<leader>hn", function() harpoon:list():next() end, { desc = "Next harpoon" })
        vim.keymap.set("n", "<leader>hp", function() harpoon:list():prev() end, { desc = "Previous harpoon" })
    end
}
