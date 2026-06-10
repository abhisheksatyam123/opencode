-- Local loader for opencode.nvim development plugin.
-- Remove this file to disable autoload from this checkout.
local repo = "/local/mnt/workspace/qprojects/opencode"
if vim.fn.isdirectory(repo) == 1 then
  vim.opt.runtimepath:prepend(repo)
  if vim.g.opencode_auto_setup ~= false then
    -- Development loader: always reload so manual tests pick up source edits.
    package.loaded["opencode"] = nil
    local bin = repo .. "/dist/opencode-linux-x64/bin/opencode"
    local opts = {}
    if vim.fn.executable(bin) == 1 then
      opts.opencode_cmd = bin
    end
    require("opencode").setup(opts)
  end
end
