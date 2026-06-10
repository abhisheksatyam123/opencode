-- RelationWindow command loader (always sourced from plugin/)
-- Keeps commands available even if init.lua/lazy load order changes.

local relation_window_path = "/local/mnt/workspace/qprojects/tui-relation-window/nvim/relation_window.lua"
local relation_tui_dir = "/local/mnt/workspace/qprojects/tui-relation-window"

local ok, rw = pcall(dofile, relation_window_path)
if not ok or not rw then
  vim.notify("RelationWindow: bridge load failed at " .. relation_window_path, vim.log.levels.WARN)
  return
end

local function define_cmd(name, fn)
  pcall(vim.api.nvim_del_user_command, name)
  vim.api.nvim_create_user_command(name, fn, {})
end

define_cmd("RelationWindowOpenSplit", function()
  rw.open({ mode = "incoming", layout = "split", tui_dir = relation_tui_dir })
end)

define_cmd("RelationWindowOpenTab", function()
  rw.open({ mode = "incoming", layout = "tab", tui_dir = relation_tui_dir })
end)

define_cmd("RelationWindowRefresh", function()
  rw.refresh()
end)

define_cmd("RelationWindowIncoming", function()
  rw.set_mode("incoming")
  rw.refresh()
end)

define_cmd("RelationWindowOutgoing", function()
  rw.set_mode("outgoing")
  rw.refresh()
end)

-- Toggle: open split if no session alive, close if one is (FEAT-005)
define_cmd("RelationWindowToggle", function()
  rw.toggle({ mode = "incoming", layout = "split", tui_dir = relation_tui_dir })
end)

-- SwitchMode: flip incoming↔outgoing and refresh (FEAT-006)
define_cmd("RelationWindowSwitchMode", function()
  rw.switch_mode()
end)

define_cmd("RelationWindowClose", function()
  rw.close()
end)

define_cmd("RelationWindowCloseAll", function()
  rw.close_all()
end)

define_cmd("RelationWindowSessions", function()
  local sessions = rw.list_sessions()
  if #sessions == 0 then
    vim.notify("RelationWindow: no active sessions", vim.log.levels.INFO)
    return
  end

  local lines = { "RelationWindow sessions:" }
  for _, s in ipairs(sessions) do
    table.insert(lines, string.format("id=%d mode=%s layout=%s alive=%s", s.id, s.mode, s.layout, tostring(s.alive)))
  end
  vim.notify(table.concat(lines, "\n"), vim.log.levels.INFO)
end)

define_cmd("RelationWindowDoctor", function()
  rw.doctor()
end)

-- Short aliases
for k, v in pairs({
  RWs  = "RelationWindowOpenSplit",
  RWt  = "RelationWindowOpenTab",
  RWr  = "RelationWindowRefresh",
  RWi  = "RelationWindowIncoming",
  RWo  = "RelationWindowOutgoing",
  RWx  = "RelationWindowToggle",
  RWm  = "RelationWindowSwitchMode",
  RWc  = "RelationWindowClose",
  RWca = "RelationWindowCloseAll",
  RWl  = "RelationWindowSessions",
  RWd  = "RelationWindowDoctor",
}) do
  define_cmd(k, function()
    vim.cmd(v)
  end)
end

-- Keymaps (leader is "\" in your init.lua)
vim.keymap.set("n", "<leader>rs", "<cmd>RelationWindowOpenSplit<CR>",  { desc = "Relation: open split" })
vim.keymap.set("n", "<leader>rt", "<cmd>RelationWindowOpenTab<CR>",    { desc = "Relation: open tab" })
vim.keymap.set("n", "<leader>rr", "<cmd>RelationWindowRefresh<CR>",    { desc = "Relation: refresh" })
vim.keymap.set("n", "<leader>ri", "<cmd>RelationWindowIncoming<CR>",   { desc = "Relation: incoming" })
vim.keymap.set("n", "<leader>ro", "<cmd>RelationWindowOutgoing<CR>",   { desc = "Relation: outgoing" })
vim.keymap.set("n", "<leader>rx", "<cmd>RelationWindowToggle<CR>",     { desc = "Relation: toggle" })
vim.keymap.set("n", "<leader>rm", "<cmd>RelationWindowSwitchMode<CR>", { desc = "Relation: switch mode" })
vim.keymap.set("n", "<leader>rc", "<cmd>RelationWindowClose<CR>",      { desc = "Relation: close current" })
vim.keymap.set("n", "<leader>rC", "<cmd>RelationWindowCloseAll<CR>",   { desc = "Relation: close all" })
vim.keymap.set("n", "<leader>rl", "<cmd>RelationWindowSessions<CR>",   { desc = "Relation: list sessions" })
vim.keymap.set("n", "<leader>rd", "<cmd>RelationWindowDoctor<CR>",     { desc = "Relation: doctor" })

-- Keep OpenTUI terminal buffers in terminal-job mode so keypresses are delivered
-- to the app (h/j/k/l, enter, r, ?). Without this, they may look static.
vim.api.nvim_create_autocmd({ "BufEnter", "TermEnter", "WinEnter" }, {
  callback = function(args)
    if vim.bo[args.buf].filetype ~= "relationwindow" then
      return
    end
    pcall(vim.cmd, "startinsert")
  end,
})
