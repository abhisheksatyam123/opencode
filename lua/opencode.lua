local M = {}

M.config = {
  server_url = "http://127.0.0.1:4096",
  opencode_cmd = "opencode",
  root_session_id = nil,
  password = nil,
  keymaps = true,
  auto_start_server = true,
  auto_create_session = true,
  auto_attach_todo = true,
  todo_filename = "todo.md",
  server_start_args = { "serve", "--hostname", "127.0.0.1", "--port", "4096", "--no-auth=true" },
  log_path = nil,
  session_state_path = nil,
  ui = {
    enabled = true,
    virtual_text = true,
    signs = true,
    refresh_ms = 3000,
  },
  float = {
    width = 0.9,
    height = 0.85,
    border = "rounded",
  },
}

M.state = {
  chats = {},
  server_job = nil,
  setup_done = false,
  attached_files = {},
  attach_inflight = {},
  ui_ns = vim.api.nvim_create_namespace("opencode.todo"),
  ui_timer = nil,
  status_panel = nil,
}

local function log_path()
  if M.config.log_path and M.config.log_path ~= "" then
    return M.config.log_path
  end
  return vim.fn.stdpath("state") .. "/opencode.nvim.log"
end

function M.log(level, message, data)
  local path = log_path()
  vim.fn.mkdir(vim.fn.fnamemodify(path, ":h"), "p")
  local suffix = data ~= nil and (" " .. vim.inspect(data)) or ""
  local line = string.format("%s [%s] %s%s\n", os.date("!%Y-%m-%dT%H:%M:%SZ"), level, message, suffix)
  vim.fn.writefile({ line }, path, "a")
end

local function notify(message, level)
  M.log(level == vim.log.levels.ERROR and "error" or level == vim.log.levels.WARN and "warn" or "info", message)
  vim.notify("[opencode] " .. message, level or vim.log.levels.INFO)
end

local function trim(value)
  local result = (value or ""):gsub("^%s+", ""):gsub("%s+$", "")
  return result
end

local function xml_escape(value)
  local result = tostring(value or ""):gsub("&", "&amp;"):gsub('"', "&quot;"):gsub("<", "&lt;"):gsub(">", "&gt;")
  return result
end

local function json_encode(value)
  if vim.json and vim.json.encode then
    return vim.json.encode(value)
  end
  return vim.fn.json_encode(value)
end

local function json_decode(value)
  if value == nil or value == "" then
    return nil
  end
  if vim.json and vim.json.decode then
    return vim.json.decode(value)
  end
  return vim.fn.json_decode(value)
end



local function list_copy(items)
  local result = {}
  for _, item in ipairs(items or {}) do
    table.insert(result, item)
  end
  return result
end

local function opencode_command(extra)
  local base = type(M.config.opencode_cmd) == "table" and list_copy(M.config.opencode_cmd) or { M.config.opencode_cmd }
  for _, item in ipairs(extra or {}) do
    table.insert(base, item)
  end
  return base
end

local function local_source_command(root)
  local entry = root .. "/src/index.ts"
  if vim.fn.filereadable(entry) == 1 and vim.fn.executable("bun") == 1 then
    return { "bun", "run", "--conditions=browser", entry }
  end
  return nil
end

local function session_state_path()
  if M.config.session_state_path and M.config.session_state_path ~= "" then
    return M.config.session_state_path
  end
  return vim.fn.stdpath("state") .. "/opencode.nvim.session.json"
end

local function load_persisted_root_session()
  local path = session_state_path()
  if vim.fn.filereadable(path) ~= 1 then
    return nil
  end
  local content = table.concat(vim.fn.readfile(path), "\n")
  local ok, data = pcall(json_decode, content)
  if ok and type(data) == "table" and type(data.root_session_id) == "string" and data.root_session_id ~= "" then
    return data.root_session_id
  end
  return nil
end

local function persist_root_session(session_id)
  if not session_id or session_id == "" then
    return
  end
  local path = session_state_path()
  vim.fn.mkdir(vim.fn.fnamemodify(path, ":h"), "p")
  vim.fn.writefile({ json_encode({ root_session_id = session_id }) }, path)
  M.log("info", "persist root session", { session = session_id, path = path })
end

local function server_url()
  return (M.config.server_url or ""):gsub("/+$", "")
end

local function auth_header()
  local password = M.config.password or vim.env.OPENCODE_SERVER_PASSWORD
  if not password or password == "" then
    return nil
  end
  if not (vim.base64 and vim.base64.encode) then
    error("password auth requires vim.base64.encode; upgrade Neovim or omit password for local no-auth server")
  end
  return "Authorization: Basic " .. vim.base64.encode("opencode:" .. password)
end

local function root_session()
  local session = M.config.root_session_id or vim.env.OPENCODE_ROOT_SESSION_ID or vim.env.OPENCODE_SESSION_ID
  if session and session ~= "" then
    M.config.root_session_id = session
    persist_root_session(session)
    return session
  end
  session = load_persisted_root_session()
  if session and session ~= "" then
    M.config.root_session_id = session
    M.log("info", "loaded persisted root session", { session = session })
    return session
  end
  if M.config.auto_create_session and type(M.create_session) == "function" then
    M.log("info", "root session missing; creating one automatically")
    local created = M.create_session()
    return created.id
  end
  error("root_session_id is required; set setup({ root_session_id = 'ses_...' }) or enable auto_create_session")
end

local function base_curl_args()
  local args = { "curl", "-sS" }
  local auth = auth_header()
  if auth then
    table.insert(args, "-H")
    table.insert(args, auth)
  end
  return args
end

function M.ping_server()
  local cmd = base_curl_args()
  vim.list_extend(cmd, { "--max-time", "1", "-o", "/dev/null", "-w", "%{http_code}", server_url() .. "/session" })
  local out = vim.fn.system(cmd)
  local code = tonumber((out or ""):match("(%d%d%d)%s*$") or "0")
  local alive = vim.v.shell_error == 0 and code > 0 and code ~= 000
  M.log("debug", "ping server", { url = server_url(), code = code, alive = alive })
  return alive
end

function M.start_server()
  if M.state.server_job and M.state.server_job > 0 then
    M.log("debug", "server job already started", { job = M.state.server_job })
    return M.state.server_job
  end
  local cmd = opencode_command(M.config.server_start_args or {})
  M.log("info", "starting opencode server", { cmd = cmd, log_path = log_path() })
  M.state.server_job = vim.fn.jobstart(cmd, {
    stdout_buffered = false,
    stderr_buffered = false,
    on_stdout = function(_, data)
      for _, line in ipairs(data or {}) do
        if line ~= "" then
          M.log("server.stdout", line)
        end
      end
    end,
    on_stderr = function(_, data)
      for _, line in ipairs(data or {}) do
        if line ~= "" then
          M.log("server.stderr", line)
        end
      end
    end,
    on_exit = function(_, code)
      M.log("warn", "opencode server exited", { code = code })
      M.state.server_job = nil
    end,
  })
  if M.state.server_job <= 0 then
    error("failed to start opencode server; see " .. log_path())
  end
  notify("starting opencode server; log: " .. log_path())
  return M.state.server_job
end

function M.ensure_server()
  if M.ping_server() then
    return true
  end
  if not M.config.auto_start_server then
    error("opencode server is not reachable at " .. server_url() .. "; enable auto_start_server or start `opencode serve`")
  end
  M.start_server()
  for _ = 1, 40 do
    vim.wait(200)
    if M.ping_server() then
      notify("opencode server ready at " .. server_url())
      return true
    end
  end
  error("timed out waiting for opencode server at " .. server_url() .. "; see " .. log_path())
end

local function http(method, path, body, opts)
  opts = opts or {}
  if not opts.no_ensure then
    M.ensure_server()
  end
  M.log("debug", "http request", { method = method, path = path, body = body })
  local cmd = {
    "curl",
    "-sS",
    "-w",
    "\n%{http_code}",
    "-X",
    method,
    server_url() .. path,
    "-H",
    "content-type: application/json",
  }
  local auth = auth_header()
  if auth then
    table.insert(cmd, "-H")
    table.insert(cmd, auth)
  end
  if body ~= nil then
    table.insert(cmd, "-d")
    table.insert(cmd, json_encode(body))
  end

  local out = vim.fn.system(cmd)
  if vim.v.shell_error ~= 0 then
    M.log("error", "http command failed", { method = method, path = path, output = out })
    error(trim(out))
  end

  local response_body, status_text = out:match("^(.*)\n(%d%d%d)%s*$")
  local status = tonumber(status_text or "0")
  response_body = response_body or out
  local decoded = nil
  if trim(response_body) ~= "" then
    local ok, parsed = pcall(json_decode, response_body)
    decoded = ok and parsed or response_body
  end

  if status < 200 or status >= 300 then
    local message = response_body
    if type(decoded) == "table" then
      message = decoded.message or (decoded.data and decoded.data.message) or response_body
    end
    message = trim(message)
    M.log("error", "http response error", { method = method, path = path, status = status, message = message })
    error(message)
  end

  M.log("debug", "http response ok", { method = method, path = path, status = status })
  return decoded
end

local function is_todo_file(file)
  if not file or file == "" then
    return false
  end
  return vim.fn.fnamemodify(file, ":t") == (M.config.todo_filename or "todo.md")
end

local function current_file()
  local file = vim.api.nvim_buf_get_name(0)
  if file == "" then
    error("current buffer has no file path")
  end
  return file
end

local function line_is_task(line)
  return line and line:match("^%s*[-*+]%s+%[[ xX~%-]%]") ~= nil
end

local function line_is_heading(line)
  return line and line:match("^%s*##%s+") ~= nil
end

local function slice(lines, start_line, end_line)
  local result = {}
  for i = start_line, end_line do
    table.insert(result, lines[i])
  end
  return result
end

local function mdx_open_attr_text(line, component)
  if not line then
    return nil
  end
  return line:match("^%s*<%s*" .. component .. "%f[%s>]([^>]*)>")
end

local function line_is_mdx_open(line, component)
  return mdx_open_attr_text(line, component) ~= nil
end

local function line_is_mdx_close(line, component)
  return line and line:match("^%s*</%s*" .. component .. "%s*>") ~= nil
end

local function parse_mdx_attrs(attr_text)
  local attrs = {}
  attr_text = attr_text or ""
  for key, value in attr_text:gmatch("([%w_:-]+)%s*=%s*\"([^\"]*)\"") do
    attrs[key] = value
  end
  for key, value in attr_text:gmatch("([%w_:-]+)%s*=%s*'([^']*)'") do
    attrs[key] = value
  end
  return attrs
end

local function mdx_attrs_from_line(line, component)
  return parse_mdx_attrs(mdx_open_attr_text(line, component))
end

local function mdx_component_block(lines, start_line, component)
  local end_line = start_line
  while end_line <= #lines and not line_is_mdx_close(lines[end_line], component) do
    end_line = end_line + 1
  end
  if end_line > #lines then
    end_line = start_line
  end
  return {
    start_line = start_line,
    end_line = end_line,
    attrs = mdx_attrs_from_line(lines[start_line], component),
    markdown = table.concat(slice(lines, start_line, end_line), "\n"),
  }
end

local function all_comment_blocks(lines)
  lines = lines or vim.api.nvim_buf_get_lines(0, 0, -1, false)
  local comments = {}
  local i = 1
  while i <= #lines do
    if line_is_mdx_open(lines[i], "Comment") then
      local block = mdx_component_block(lines, i, "Comment")
      table.insert(comments, block)
      i = block.end_line + 1
    else
      i = i + 1
    end
  end
  return comments
end

local function comment_target(comment)
  return comment and comment.attrs and (comment.attrs.to or comment.attrs.agent)
end

local function comment_status(comment)
  return (comment and comment.attrs and comment.attrs.status) or "pending"
end

local function comment_is_pending(comment)
  local status = comment_status(comment)
  return status == "" or status == "pending" or status == "open" or status == "new"
end

local function related_comments_markdown(lines, agent_name)
  if not agent_name then
    return ""
  end
  local blocks = {}
  for _, comment in ipairs(all_comment_blocks(lines)) do
    if comment_target(comment) == agent_name then
      table.insert(blocks, comment.markdown)
    end
  end
  return table.concat(blocks, "\n\n")
end

local function mdx_agent_block_from_start(lines, start_line)
  local block = mdx_component_block(lines, start_line, "Agent")
  local name = block.attrs.id or block.attrs.name or block.attrs.agent
  local comments = related_comments_markdown(lines, name)
  if comments ~= "" then
    block.markdown = block.markdown .. "\n\n" .. comments
  end
  block.kind = "mdx_agent"
  block.agent_name = name
  return block
end

local function find_mdx_agent_start(lines, name)
  if not name then
    return nil
  end
  for i, line in ipairs(lines) do
    if line_is_mdx_open(line, "Agent") then
      local attrs = mdx_attrs_from_line(line, "Agent")
      if attrs.id == name or attrs.name == name or attrs.agent == name then
        return i
      end
    end
  end
end

local function find_mdx_comment_around_row(lines, row)
  local i = math.min(row, #lines)
  while i >= 1 do
    if line_is_mdx_open(lines[i], "Comment") then
      local block = mdx_component_block(lines, i, "Comment")
      if row <= block.end_line then
        return block
      end
      return nil
    end
    if line_is_mdx_close(lines[i], "Comment") or line_is_mdx_open(lines[i], "Agent") or line_is_heading(lines[i]) then
      return nil
    end
    i = i - 1
  end
end

local function find_mdx_agent_around_row(lines, row)
  local i = math.min(row, #lines)
  while i >= 1 do
    if line_is_mdx_open(lines[i], "Agent") then
      local block = mdx_component_block(lines, i, "Agent")
      if row <= block.end_line then
        return i
      end
      return nil
    end
    if line_is_mdx_open(lines[i], "Comment") or line_is_heading(lines[i]) then
      return nil
    end
    i = i - 1
  end
end


local function markdown_has_agent_assignment(markdown)
  return markdown:match("%f[%w]assign:%s*[^\n]+") ~= nil
end

local function task_block_from_start(lines, start_line)
  local end_line = start_line + 1
  while end_line <= #lines and not line_is_task(lines[end_line]) and not line_is_heading(lines[end_line]) and not line_is_mdx_open(lines[end_line], "Agent") do
    end_line = end_line + 1
  end
  end_line = end_line - 1

  return {
    start_line = start_line,
    end_line = end_line,
    markdown = table.concat(slice(lines, start_line, end_line), "\n"),
    kind = "task",
  }
end

local function current_task_block()
  local row = vim.api.nvim_win_get_cursor(0)[1]
  local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  if #lines == 0 then
    error("empty buffer")
  end

  row = math.min(row, #lines)

  local agent_start = find_mdx_agent_around_row(lines, row)
  if agent_start then
    return mdx_agent_block_from_start(lines, agent_start)
  end

  local comment = find_mdx_comment_around_row(lines, row)
  if comment then
    local target = comment_target(comment)
    local target_start = find_mdx_agent_start(lines, target)
    if target_start then
      return mdx_agent_block_from_start(lines, target_start)
    end
  end

  local start_line = row
  while start_line > 1 and not line_is_task(lines[start_line]) and not line_is_heading(lines[start_line]) do
    start_line = start_line - 1
  end
  if line_is_task(lines[start_line]) then
    local block = task_block_from_start(lines, start_line)
    if markdown_has_agent_assignment(block.markdown) then
      return block
    end
  end

  -- If the cursor is on a section heading/blank/header area, use the next task or Agent below it.
  -- This keeps command-mode usage forgiving: opening todo.md and immediately running
  -- from the top of the file operates on the first visible task.
  local next_line = row
  while next_line <= #lines do
    if line_is_task(lines[next_line]) then
      local block = task_block_from_start(lines, next_line)
      if markdown_has_agent_assignment(block.markdown) then
        return block
      end
      next_line = block.end_line + 1
    elseif line_is_mdx_open(lines[next_line], "Agent") then
      return mdx_agent_block_from_start(lines, next_line)
    else
      next_line = next_line + 1
    end
  end

  error("no markdown todo task or Agent found near cursor")
end

local function all_assigned_task_blocks()
  local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  local blocks = {}
  local i = 1
  while i <= #lines do
    if line_is_task(lines[i]) then
      local start_line = i
      local end_line = i + 1
      while end_line <= #lines and not line_is_task(lines[end_line]) and not line_is_heading(lines[end_line]) and not line_is_mdx_open(lines[end_line], "Agent") do
        end_line = end_line + 1
      end
      end_line = end_line - 1
      local markdown = table.concat(slice(lines, start_line, end_line), "\n")
      if markdown_has_agent_assignment(markdown) then
        table.insert(blocks, { start_line = start_line, end_line = end_line, markdown = markdown, kind = "task" })
      end
      i = end_line + 1
    elseif line_is_mdx_open(lines[i], "Agent") then
      local block = mdx_agent_block_from_start(lines, i)
      table.insert(blocks, block)
      i = block.end_line + 1
    else
      i = i + 1
    end
  end
  return blocks
end

local function systems_text()
  local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  local start_line = nil
  for i, line in ipairs(lines) do
    if line:match("^%s*##%s+Systems%s*$") then
      start_line = i + 1
      break
    end
  end
  if not start_line then
    return nil
  end
  return table.concat(slice(lines, start_line, #lines), "\n")
end

local function mdx_attr(markdown, component, attr)
  local attrs = markdown:match("^%s*<%s*" .. component .. "%f[%s>]([^>]*)>")
    or markdown:match("\n%s*<%s*" .. component .. "%f[%s>]([^>]*)>")
  if not attrs then
    return nil
  end
  return attrs:match(attr .. "%s*=%s*\"([^\"]+)\"") or attrs:match(attr .. "%s*=%s*'([^']+)'")
end

local function assignment_agent_name(markdown)
  local assign = markdown:match("%f[%w]assign:%s*([^\n]+)")
  if not assign then
    return mdx_attr(markdown, "Agent", "id")
      or mdx_attr(markdown, "Agent", "name")
      or mdx_attr(markdown, "Agent", "agent")
  end
  assign = trim(assign)
  local fork_target = assign:match("%-%>fork%-%>(.+)$")
  local spec = trim(fork_target or assign)
  if spec:match("^[A-Za-z][A-Za-z0-9_-]*$") then
    return spec
  end
  local left = spec:match("^([^/]+)/")
  if not left then
    return nil
  end
  local name, suffix = left:match("^(.+)%-([A-Za-z0-9_]+)$")
  if name and (suffix == "qgenie" or suffix == "qpilot") then
    return name
  end
  return left
end

local function has_pending_comment(markdown)
  if markdown:match("^%s*comment>%s*$") ~= nil or markdown:match("\n%s*comment>%s*$") ~= nil then
    return true
  end
  for attrs in markdown:gmatch("<%s*[Uu]ser[Cc]omment%f[%s>]([^>]*)>") do
    local parsed = parse_mdx_attrs(attrs)
    local status = parsed.status or "pending"
    if status == "" or status == "pending" or status == "open" or status == "new" then
      return true
    end
  end
  for attrs in markdown:gmatch("<%s*Comment%f[%s>]([^>]*)>") do
    local parsed = parse_mdx_attrs(attrs)
    local status = parsed.status or "pending"
    if status == "" or status == "pending" or status == "open" or status == "new" then
      return true
    end
  end
  return false
end


local function mdx_agent_task_payload(block)
  if not block or block.kind ~= "mdx_agent" then
    return block and block.markdown or ""
  end
  local attrs = block.attrs or {}
  local agent = attrs.id or attrs.name or attrs.agent or assignment_agent_name(block.markdown)
  local provider_attr = attrs.provider or attrs.providerID or "qgenie"
  local model_attr = attrs.model or attrs.modelID or "anthropic::claude-4-6-sonnet"
  local source = attrs.from or attrs.forkFrom or attrs.sourceAgent
  local body = block.markdown:match("^%s*<%s*Agent%f[%s>][^>]*>\n?([%s%S]-)\n?%s*</%s*Agent%s*>") or ""
  local task = {
    string.format(
      '<Agent id="%s" provider="%s" model="%s"%s>',
      xml_escape(agent),
      xml_escape(provider_attr),
      xml_escape(model_attr),
      source and string.format(' from="%s"', xml_escape(source)) or ""
    ),
    trim(body),
    "</Agent>",
  }
  for _, comment in ipairs(all_comment_blocks(vim.split(block.markdown, "\n", { plain = true }))) do
    local status_text = xml_escape(comment_status(comment))
    local comment_body = comment.markdown:match("^%s*<%s*Comment%f[%s>][^>]*>\n?([%s%S]-)\n?%s*</%s*Comment%s*>") or ""
    local comment_text = trim(comment_body)
    table.insert(task, string.format('<Comment to="%s" status="%s">', xml_escape(agent), status_text))
    table.insert(task, comment_text)
    table.insert(task, "</Comment>")
  end
  return table.concat(task, "\n")
end

local function request_run(block, opts)
  opts = opts or {}
  local payload = mdx_agent_task_payload(block)
  local pending = has_pending_comment(payload)
  local default_async = block.kind == "mdx_agent" or not pending
  return http("POST", "/session/" .. root_session() .. "/todo-agent/run", {
    taskMarkdown = payload,
    systemsText = systems_text(),
    mode = pending and "follow-up" or "initial",
    async = opts.async ~= nil and opts.async or default_async,
  })
end

local function patch_followup(block, response_text)
  if block.kind == "mdx_agent" then
    return
  end
  if not response_text or trim(response_text) == "" then
    return
  end

  local lines = vim.api.nvim_buf_get_lines(0, block.start_line - 1, block.end_line, false)
  for i, line in ipairs(lines) do
    if line:match("^%s*comment>%s*$") then
      lines[i] = line:gsub("comment>", "comment resolved>", 1)
    end
  end

  local insert_index = #lines + 1
  for i, line in ipairs(lines) do
    if line:match("^%s*conversation_end:%s*$") then
      insert_index = i
      break
    end
  end

  local agent_block = { "  agent>" }
  for line in trim(response_text):gmatch("([^\n]*)\n?") do
    if line ~= "" then
      table.insert(agent_block, "  " .. line)
    end
  end
  table.insert(agent_block, "  agent_end>")

  for i = #agent_block, 1, -1 do
    table.insert(lines, insert_index, agent_block[i])
  end

  vim.api.nvim_buf_set_lines(0, block.start_line - 1, block.end_line, false, lines)
  vim.cmd("silent write")
end

local function list_agents()
  local res = http("GET", "/session/" .. root_session() .. "/todo-agent")
  return (res and res.agents) or {}
end

local function session_statuses()
  local res = http("GET", "/session/status")
  return res or {}
end

local function find_agent_for_block(block)
  local name = assignment_agent_name(block.markdown)
  if not name then
    return nil
  end
  for _, agent in ipairs(list_agents()) do
    if agent.name == name then
      return agent
    end
  end
  return nil
end

local function state_icon(state)
  if state == "busy" then
    return "●", "OpencodeBusy"
  end
  if state == "retry" then
    return "↻", "OpencodeBusy"
  end
  if state == "paused" then
    return "Ⅱ", "OpencodePaused"
  end
  if state == "error" then
    return "!", "OpencodeError"
  end
  if state == "new" then
    return "○", "OpencodeMuted"
  end
  return "✓", "OpencodeIdle"
end

local function count_pending_comments(markdown)
  local count = 0
  for line in markdown:gmatch("([^\n]*)\n?") do
    if line:match("^%s*comment>%s*$") then
      count = count + 1
    end
  end
  for attrs in markdown:gmatch("<%s*[Uu]ser[Cc]omment%f[%s>]([^>]*)>") do
    local parsed = parse_mdx_attrs(attrs)
    local status = parsed.status or "pending"
    if status == "" or status == "pending" or status == "open" or status == "new" then
      count = count + 1
    end
  end
  for attrs in markdown:gmatch("<%s*Comment%f[%s>]([^>]*)>") do
    local parsed = parse_mdx_attrs(attrs)
    local status = parsed.status or "pending"
    if status == "" or status == "pending" or status == "open" or status == "new" then
      count = count + 1
    end
  end
  return count
end

local function build_agent_maps()
  local agents = list_agents()
  local statuses = session_statuses()
  local by_name = {}
  for _, agent in ipairs(agents) do
    local status = statuses[agent.sessionID]
    agent._state = status and status.type or "idle"
    by_name[agent.name] = agent
  end
  return by_name
end

function M.clear_ui(buf)
  if type(buf) ~= "number" then
    buf = vim.api.nvim_get_current_buf()
  end
  if vim.api.nvim_buf_is_valid(buf) then
    vim.api.nvim_buf_clear_namespace(buf, M.state.ui_ns, 0, -1)
  end
end

function M.refresh_ui(buf)
  if not (M.config.ui and M.config.ui.enabled) then
    return
  end
  if type(buf) ~= "number" then
    buf = vim.api.nvim_get_current_buf()
  end
  if not vim.api.nvim_buf_is_valid(buf) then
    return
  end
  local file = vim.api.nvim_buf_get_name(buf)
  if not is_todo_file(file) then
    M.clear_ui(buf)
    return
  end
  if not M.state.attached_files[file] then
    M.clear_ui(buf)
    return
  end

  local ok, by_name = pcall(build_agent_maps)
  if not ok then
    M.log("warn", "refresh ui failed", { error = tostring(by_name) })
    return
  end

  local current_buf = vim.api.nvim_get_current_buf()
  if current_buf ~= buf then
    vim.api.nvim_set_current_buf(buf)
  end
  local blocks = all_assigned_task_blocks()
  local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  local comments = all_comment_blocks(lines)
  if current_buf ~= buf and vim.api.nvim_buf_is_valid(current_buf) then
    vim.api.nvim_set_current_buf(current_buf)
  end

  M.clear_ui(buf)
  for _, block in ipairs(blocks) do
    local name = assignment_agent_name(block.markdown)
    local agent = name and by_name[name] or nil
    local state = agent and agent._state or "new"
    local icon, hl = state_icon(state)
    local pending = count_pending_comments(block.markdown)
    local text = string.format(" %s @%s %s", icon, name or "unassigned", state)
    if pending > 0 then
      text = text .. string.format(" · %d comment%s", pending, pending == 1 and "" or "s")
    end
    if agent and agent.sessionID then
      text = text .. " · " .. agent.sessionID
    end

    local opts = {
      virt_text = M.config.ui.virtual_text and { { text, hl } } or nil,
      virt_text_pos = "eol",
      hl_mode = "combine",
    }
    if M.config.ui.signs then
      opts.sign_text = icon
      opts.sign_hl_group = hl
    end
    pcall(vim.api.nvim_buf_set_extmark, buf, M.state.ui_ns, block.start_line - 1, 0, opts)
  end

  for _, comment in ipairs(comments) do
    local target = comment_target(comment) or "unassigned"
    local status = comment_status(comment)
    local hl = comment_is_pending(comment) and "OpencodeBusy" or "OpencodeIdle"
    local icon = comment_is_pending(comment) and "◌" or "✓"
    local text = string.format(" %s comment → @%s %s", icon, target, status)
    local opts = {
      virt_text = M.config.ui.virtual_text and { { text, hl } } or nil,
      virt_text_pos = "eol",
      hl_mode = "combine",
    }
    if M.config.ui.signs then
      opts.sign_text = icon
      opts.sign_hl_group = hl
    end
    pcall(vim.api.nvim_buf_set_extmark, buf, M.state.ui_ns, comment.start_line - 1, 0, opts)
  end
  M.log("debug", "refresh ui", { file = file, tasks = #blocks, comments = #comments })
end

function M.start_ui_timer()
  if not (M.config.ui and M.config.ui.enabled) then
    return
  end
  if M.state.ui_timer then
    pcall(vim.fn.timer_stop, M.state.ui_timer)
  end
  local interval = M.config.ui.refresh_ms or 3000
  if interval <= 0 then
    return
  end
  M.state.ui_timer = vim.fn.timer_start(interval, function()
    vim.schedule(function()
      pcall(M.refresh_ui)
    end)
  end, { ["repeat"] = -1 })
end

function M.stop_ui_timer()
  if M.state.ui_timer then
    pcall(vim.fn.timer_stop, M.state.ui_timer)
    M.state.ui_timer = nil
  end
end

function M.attach()
  local file = current_file()
  M.log("info", "attach current file", { file = file })
  local res = http("POST", "/session/" .. root_session() .. "/todo-file/attach", { path = file })
  M.state.attached_files[file] = res.task_path or res.taskPath or true
  notify("attached " .. (res.task_path or res.taskPath or file))
  M.refresh_ui()
  return res
end

function M.auto_attach_current_todo()
  if not M.config.auto_attach_todo then
    return
  end
  local file = vim.api.nvim_buf_get_name(0)
  if not is_todo_file(file) then
    return
  end
  if M.state.attached_files[file] or M.state.attach_inflight[file] then
    return
  end
  M.state.attach_inflight[file] = true
  M.log("info", "auto attach todo detected", { file = file })
  vim.schedule(function()
    local ok, err = pcall(M.attach)
    M.state.attach_inflight[file] = nil
    if not ok then
      M.log("error", "auto attach failed", { file = file, error = tostring(err) })
      notify("auto attach failed: " .. tostring(err) .. " (see :OpencodeLog)", vim.log.levels.ERROR)
    end
  end)
end


local function ensure_current_todo_attached()
  local file = vim.api.nvim_buf_get_name(0)
  if not is_todo_file(file) then
    return
  end
  if M.state.attached_files[file] then
    return
  end
  M.attach()
end

function M.create_session()
  local session = http("POST", "/session", vim.empty_dict())
  if not session or not session.id then
    error("server did not return a session id")
  end
  M.config.root_session_id = session.id
  persist_root_session(session.id)
  notify("created root session " .. session.id)
  return session
end

function M.select_session()
  local sessions = http("GET", "/session?roots=true&limit=50") or {}
  local roots = {}
  for _, session in ipairs(sessions) do
    if not session.parentID then
      table.insert(roots, session)
    end
  end
  if #roots == 0 then
    notify("no root sessions found", vim.log.levels.WARN)
    return
  end
  vim.ui.select(roots, {
    prompt = "opencode root session",
    format_item = function(session)
      return string.format("%s  %s", session.id, session.title or "untitled")
    end,
  }, function(session)
    if session then
      M.config.root_session_id = session.id
      persist_root_session(session.id)
      notify("selected root session " .. session.id)
    end
  end)
end

function M.create_todo()
  vim.ui.input({ prompt = "todo title: " }, function(title)
    if not title or trim(title) == "" then
      return
    end
    vim.ui.input({ prompt = "assignment (optional): " }, function(assignment)
      local body = { title = trim(title) }
      if assignment and trim(assignment) ~= "" then
        body.assignment = trim(assignment)
      end
      local res = http("POST", "/session/" .. root_session() .. "/todo-file", body)
      notify("created " .. (res.task_path or res.taskPath or title))
      if res.file and res.file ~= "" then
        M.state.attached_files[res.file] = res.task_path or res.taskPath or true
        vim.cmd("edit " .. vim.fn.fnameescape(res.file))
      end
    end)
  end)
end

function M.run()
  ensure_current_todo_attached()
  local block = current_task_block()
  local res = request_run(block)
  if res and res.responseText then
    patch_followup(block, res.responseText)
    notify("completed follow-up")
    M.refresh_ui()
  else
    local name = res and res.agent and res.agent.name or assignment_agent_name(block.markdown) or "agent"
    notify("dispatched @" .. name)
    M.refresh_ui()
  end
  return res
end

function M.run_all()
  local blocks = all_assigned_task_blocks()
  if #blocks == 0 then
    notify("no assigned todo tasks found", vim.log.levels.WARN)
    return
  end

  local sent = 0
  local seen = {}
  for _, block in ipairs(blocks) do
    local name = assignment_agent_name(block.markdown)
    if name and not seen[name] then
      seen[name] = true
      request_run(block, { async = true })
      sent = sent + 1
    end
  end
  notify("dispatched " .. sent .. "/" .. #blocks .. " assigned task(s)")
  M.refresh_ui()
end


local function chat_command(session_id)
  local cmd = opencode_command({ "attach", server_url(), "--session", session_id, "--dir", vim.fn.getcwd() })
  local password = M.config.password or vim.env.OPENCODE_SERVER_PASSWORD
  if password and password ~= "" then
    table.insert(cmd, "--password")
    table.insert(cmd, password)
  end
  return cmd
end

local function job_is_running(job)
  if type(job) ~= "number" or job <= 0 then
    return false
  end
  local ok, result = pcall(vim.fn.jobwait, { job }, 0)
  return ok and type(result) == "table" and result[1] == -1
end

local function terminal_job_for_buf(buf)
  if not buf or not vim.api.nvim_buf_is_valid(buf) then
    return nil
  end
  local ok, job = pcall(function()
    return vim.b[buf].terminal_job_id
  end)
  if ok and type(job) == "number" then
    return job
  end
  return nil
end

local function open_existing_agent_chat(opts)
  local agents = list_agents()
  if #agents == 0 then
    notify("no todo agents registered", vim.log.levels.WARN)
    return true
  end
  local latest = agents[1]
  for _, agent in ipairs(agents) do
    local agent_time = tonumber(agent.timeUpdated or agent.timeCreated or 0) or 0
    local latest_time = tonumber(latest.timeUpdated or latest.timeCreated or 0) or 0
    if agent_time > latest_time then
      latest = agent
    end
  end
  notify("opening @" .. (latest.name or "agent"))
  M.open_chat(latest.sessionID, opts)
  return true
end

function M.open_chat(session_id, opts)
  opts = opts or {}
  if not session_id then
    ensure_current_todo_attached()
    local ok, block = pcall(current_task_block)
    if not ok then
      open_existing_agent_chat(opts)
      return
    end
    local agent = find_agent_for_block(block)
    if not agent then
      local res = request_run(block, { async = true })
      agent = res and res.agent
    end
    if not agent or not agent.sessionID then
      error("could not resolve agent session for current task")
    end
    session_id = agent.sessionID
  end

  local existing = M.state.chats[session_id]
  if existing and existing.win and vim.api.nvim_win_is_valid(existing.win) then
    vim.api.nvim_set_current_win(existing.win)
    vim.cmd("startinsert")
    return
  end

  local existing_job = existing and (existing.job or terminal_job_for_buf(existing.buf))
  local reuse_terminal = existing and vim.api.nvim_buf_is_valid(existing.buf or -1) and job_is_running(existing_job)
  local buf = reuse_terminal and existing.buf or vim.api.nvim_create_buf(false, true)

  local win
  if opts.split then
    vim.cmd(opts.vertical and "botright vsplit" or "botright split")
    win = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(win, buf)
  else
    local width = math.max(40, math.floor(vim.o.columns * M.config.float.width))
    local height = math.max(12, math.floor(vim.o.lines * M.config.float.height))
    win = vim.api.nvim_open_win(buf, true, {
      relative = "editor",
      width = width,
      height = height,
      row = math.floor((vim.o.lines - height) / 2),
      col = math.floor((vim.o.columns - width) / 2),
      border = M.config.float.border,
      title = " opencode " .. session_id .. " ",
      title_pos = "center",
    })
  end

  M.state.chats[session_id] = { buf = buf, win = win, job = reuse_terminal and existing_job or nil }

  if not reuse_terminal then
    local cmd = chat_command(session_id)
    M.log("info", "open chat terminal", { cmd = cmd, session = session_id })
    local job = vim.fn.termopen(cmd, {
      cwd = vim.fn.getcwd(),
      on_exit = function(_, code)
        M.log("warn", "chat terminal exited", { session = session_id, code = code })
      end,
    })
    if type(job) ~= "number" or job <= 0 then
      M.log("error", "chat terminal failed to start", { session = session_id, job = job, cmd = cmd })
      notify("failed to start opencode chat terminal; see :OpencodeLog", vim.log.levels.ERROR)
      return
    end
    M.state.chats[session_id].job = job
    vim.keymap.set({ "n", "t" }, "<C-q>", function()
      local current_win = vim.api.nvim_get_current_win()
      if vim.api.nvim_win_is_valid(current_win) then
        vim.api.nvim_win_close(current_win, true)
      end
    end, { buffer = buf, silent = true, desc = "close opencode chat window" })
  end

  vim.cmd("startinsert")
end

function M.open_chat_split()
  M.open_chat(nil, { split = true })
end

local function current_task_agent_name()
  local ok, block = pcall(current_task_block)
  if not ok then
    return nil
  end
  return assignment_agent_name(block.markdown)
end

local function agent_status_lines()
  local agents = list_agents()
  local statuses = session_statuses()
  local current_name = current_task_agent_name()
  local root = M.config.root_session_id or vim.env.OPENCODE_ROOT_SESSION_ID or vim.env.OPENCODE_SESSION_ID or "(auto)"
  local lines = {
    "opencode todo agents",
    "root session: " .. root,
    "current task agent: " .. (current_name and ("@" .. current_name) or "(none)"),
    "",
  }
  local line_agents = {}

  if #agents == 0 then
    table.insert(lines, "no todo agents registered")
    return lines, line_agents
  end

  table.insert(lines, "  STATE   AGENT                 MODEL                         SESSION")
  for _, agent in ipairs(agents) do
    local status = statuses[agent.sessionID]
    local state = status and status.type or "idle"
    local marker = agent.name == current_name and "›" or " "
    local line = string.format(
      "%s %-7s @%-20s %-29s %s",
      marker,
      state,
      agent.name,
      (agent.providerID .. "/" .. agent.modelID):sub(1, 29),
      agent.sessionID
    )
    table.insert(lines, line)
    line_agents[#lines] = agent
  end
  return lines, line_agents
end

function M.agent_status(opts)
  opts = opts or {}
  local lines, line_agents = agent_status_lines()
  M.log("info", "agent status", { lines = lines })

  if opts.notify then
    vim.notify("[opencode] " .. table.concat(lines, "\n"), vim.log.levels.INFO)
    return lines
  end

  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = "opencode-status"
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false

  local max_width = 40
  for _, line in ipairs(lines) do
    max_width = math.max(max_width, #line + 2)
  end
  local width = math.min(math.max(60, max_width), math.max(60, vim.o.columns - 6))
  local height = math.min(math.max(8, #lines + 2), math.max(8, vim.o.lines - 6))
  local win = vim.api.nvim_open_win(buf, true, {
    relative = "editor",
    width = width,
    height = height,
    row = math.floor((vim.o.lines - height) / 2),
    col = math.floor((vim.o.columns - width) / 2),
    border = M.config.float.border,
    title = " opencode agents ",
    title_pos = "center",
  })

  M.state.status_panel = { buf = buf, win = win, line_agents = line_agents }

  local function close()
    if vim.api.nvim_win_is_valid(win) then
      vim.api.nvim_win_close(win, true)
    end
  end

  vim.keymap.set("n", "q", close, { buffer = buf, silent = true, desc = "close opencode status" })
  vim.keymap.set("n", "<Esc>", close, { buffer = buf, silent = true, desc = "close opencode status" })
  vim.keymap.set("n", "r", function()
    close()
    M.agent_status()
  end, { buffer = buf, silent = true, desc = "refresh opencode status" })
  vim.keymap.set("n", "<CR>", function()
    local row = vim.api.nvim_win_get_cursor(0)[1]
    local agent = M.state.status_panel and M.state.status_panel.line_agents[row]
    if not agent then
      notify("move cursor to an agent row", vim.log.levels.WARN)
      return
    end
    close()
    M.open_chat(agent.sessionID)
  end, { buffer = buf, silent = true, desc = "open opencode agent chat" })

  return lines
end

function M.sessions()
  local agents = list_agents()
  if #agents == 0 then
    notify("no todo agents registered", vim.log.levels.WARN)
    return
  end

  local statuses = session_statuses()
  vim.ui.select(agents, {
    prompt = "opencode agents",
    format_item = function(agent)
      local status = statuses[agent.sessionID]
      local state = status and status.type or "idle"
      return string.format("@%s  %-6s  %s/%s  %s", agent.name, state, agent.providerID, agent.modelID, agent.sessionID)
    end,
  }, function(agent)
    if agent then
      M.open_chat(agent.sessionID)
    end
  end)
end

function M.comment()
  local block = current_task_block()
  vim.ui.input({ prompt = "opencode comment: " }, function(text)
    if not text or trim(text) == "" then
      return
    end
    if block.kind == "mdx_agent" then
      local agent = assignment_agent_name(block.markdown)
      if not agent then
        notify("current Agent has no id/name", vim.log.levels.ERROR)
        return
      end
      local id = "c-" .. tostring(os.time())
      local comment = {
        "",
        string.format('<Comment id="%s" from="human" to="%s" status="pending" created="%s">', xml_escape(id), xml_escape(agent), os.date("!%Y-%m-%dT%H:%M:%SZ")),
      }
      for line in trim(text):gmatch("([^\n]*)\n?") do
        if line ~= "" then
          table.insert(comment, line)
        end
      end
      table.insert(comment, "</Comment>")
      vim.api.nvim_buf_set_lines(0, block.end_line, block.end_line, false, comment)
      vim.cmd("silent write")
      notify("comment queued for @" .. agent)
      M.refresh_ui()
      return
    end

    local lines = vim.api.nvim_buf_get_lines(0, block.start_line - 1, block.end_line, false)
    local insert_index = #lines + 1
    for i, line in ipairs(lines) do
      if line:match("^%s*conversation_end:%s*$") then
        insert_index = i
        break
      end
    end
    local comment = { "  comment>" }
    for line in trim(text):gmatch("([^\n]*)\n?") do
      if line ~= "" then
        table.insert(comment, "  " .. line)
      end
    end
    table.insert(comment, "  comment_end>")
    for i = #comment, 1, -1 do
      table.insert(lines, insert_index, comment[i])
    end
    vim.api.nvim_buf_set_lines(0, block.start_line - 1, block.end_line, false, lines)
    vim.cmd("silent write")
    notify("comment added")
  end)
end

function M.status()
  local file = vim.api.nvim_buf_get_name(0)
  return {
    setup_done = M.state.setup_done,
    server_url = M.config.server_url,
    opencode_cmd = M.config.opencode_cmd,
    root_session_id = M.config.root_session_id or vim.env.OPENCODE_ROOT_SESSION_ID or vim.env.OPENCODE_SESSION_ID,
    session_state_path = session_state_path(),
    auto_start_server = M.config.auto_start_server,
    auto_create_session = M.config.auto_create_session,
    auto_attach_todo = M.config.auto_attach_todo,
    current_file = file,
    current_file_is_todo = is_todo_file(file),
    current_file_attached = file ~= "" and M.state.attached_files[file] or nil,
    server_job = M.state.server_job,
    log_path = log_path(),
  }
end

function M.stop_server()
  if M.state.server_job and M.state.server_job > 0 then
    M.log("info", "stopping opencode server", { job = M.state.server_job })
    vim.fn.jobstop(M.state.server_job)
    M.state.server_job = nil
    return true
  end
  M.log("info", "no managed opencode server job to stop")
  return false
end

function M.restart_server()
  M.stop_server()
  return M.start_server()
end

function M.open_log()
  local path = log_path()
  if vim.fn.filereadable(path) == 0 or vim.fn.getfsize(path) <= 0 then
    M.log("info", "log opened before any activity; writing diagnostic status", M.status())
  else
    M.log("info", "log opened", M.status())
  end
  vim.cmd("edit " .. vim.fn.fnameescape(path))
  vim.bo.filetype = "log"
  vim.bo.buftype = ""
  vim.bo.swapfile = false
end

function M.doctor()
  local status = M.status()
  M.log("info", "doctor", status)
  vim.notify("[opencode] " .. vim.inspect(status), vim.log.levels.INFO)
  return status
end

function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", M.config, opts or {})
  if M.config.opencode_cmd == "opencode" then
    local source = debug.getinfo(1, "S").source:gsub("^@", "")
    local root = vim.fn.fnamemodify(source, ":h:h")
    M.config.opencode_cmd = local_source_command(root) or M.config.opencode_cmd
    if M.config.opencode_cmd == "opencode" then
      local bin = root .. "/dist/opencode-linux-x64/bin/opencode"
      if vim.fn.executable(bin) == 1 then
        M.config.opencode_cmd = bin
      end
    end
  end
  M.state.setup_done = true
  vim.api.nvim_set_hl(0, "OpencodeBusy", { fg = "#e0af68", bold = true })
  vim.api.nvim_set_hl(0, "OpencodeIdle", { fg = "#9ece6a" })
  vim.api.nvim_set_hl(0, "OpencodePaused", { fg = "#7aa2f7" })
  vim.api.nvim_set_hl(0, "OpencodeError", { fg = "#f7768e", bold = true })
  vim.api.nvim_set_hl(0, "OpencodeMuted", { fg = "#565f89" })
  M.log("info", "setup", { server_url = M.config.server_url, auto_attach_todo = M.config.auto_attach_todo })

  local group = vim.api.nvim_create_augroup("OpencodeTodoAutoAttach", { clear = true })
  vim.api.nvim_create_autocmd({ "BufReadPost", "BufEnter" }, {
    group = group,
    pattern = "*",
    callback = function()
      M.auto_attach_current_todo()
      M.refresh_ui()
    end,
  })
  vim.api.nvim_create_autocmd({ "BufWritePost", "CursorHold", "CursorHoldI" }, {
    group = group,
    pattern = "*",
    callback = function()
      M.refresh_ui()
    end,
  })
  M.auto_attach_current_todo()
  M.start_ui_timer()

  -- Minimal public contract. Session creation and todo attachment are automatic.
  vim.api.nvim_create_user_command("OpencodeTodoRun", M.run, {})
  vim.api.nvim_create_user_command("OpencodeTodoOpen", function()
    M.open_chat()
  end, {})
  vim.api.nvim_create_user_command("OpencodeStatus", M.agent_status, {})
  vim.api.nvim_create_user_command("OpencodeTodoComment", M.comment, {})
  vim.api.nvim_create_user_command("OpencodeTodoRefresh", function()
    M.refresh_ui()
  end, {})
  vim.api.nvim_create_user_command("OpencodeLog", M.open_log, {})

  if M.config.keymaps then
    vim.keymap.set("n", "<leader>or", M.run, { desc = "opencode run current task" })
    vim.keymap.set("n", "<leader>oo", function()
      M.open_chat()
    end, { desc = "opencode open/reopen agent" })
    vim.keymap.set("n", "<leader>o?", M.agent_status, { desc = "opencode agent status" })
    vim.keymap.set("n", "<leader>oc", M.comment, { desc = "opencode comment to agent" })
    vim.keymap.set("n", "<leader>ou", M.refresh_ui, { desc = "opencode refresh todo UI" })
  end
end

M._test = {
  current_task_block = current_task_block,
  all_assigned_task_blocks = all_assigned_task_blocks,
  assignment_agent_name = assignment_agent_name,
  has_pending_comment = has_pending_comment,
  mdx_agent_task_payload = mdx_agent_task_payload,
  chat_command = chat_command,
}

return M
