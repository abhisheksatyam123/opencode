-- Auto-load the single-file opencode.nvim plugin when this repository is on Neovim's runtimepath.
-- Set `vim.g.opencode_auto_setup = false` before startup to disable automatic setup.
if vim.g.opencode_auto_setup ~= false then
  local source = debug.getinfo(1, "S").source:gsub("^@", "")
  local root = vim.fn.fnamemodify(source, ":h:h")
  local opts = {}
  local source_entry = root .. "/src/index.ts"
  if vim.fn.filereadable(source_entry) == 1 and vim.fn.executable("bun") == 1 then
    opts.opencode_cmd = { "bun", "run", "--conditions=browser", source_entry }
  else
    local bin = root .. "/dist/opencode-linux-x64/bin/opencode"
    if vim.fn.executable(bin) == 1 then
      opts.opencode_cmd = bin
    end
  end
  local oc = require("opencode")
  oc.setup(opts)
  oc.log("info", "autoload plugin sourced", { root = root, opencode_cmd = opts.opencode_cmd or "opencode" })
end
