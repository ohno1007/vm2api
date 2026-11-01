import { codexCliError } from '../transport/codex-app-server-rpc.mjs'
import { createHash } from 'node:crypto'

const key = (namespace, name) => JSON.stringify([namespace || '', name])
const invalid = code => { throw codexCliError(code, 400) }
const validName = name => typeof name === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(name)

/** Client tools execute at the client. Bridge freeform text through a typed CLI string argument. */
export function prepareCodexCliTools(tools = []) {
  if (!Array.isArray(tools)) return invalid('invalid_tools')
  const registry = new Map(), dynamicTools = [], roots = new Set(), namespaces = new Map()
  let webSearch = null
  function leaf(tool, namespace) {
    if (!validName(tool?.name)) return invalid('invalid_tool_name')
    if (!['function', 'custom'].includes(tool.type)) return invalid(`unsupported_tool_${tool.type || 'unknown'}`)
    const id = key(namespaces.get(namespace) || namespace, tool.name)
    if (registry.has(id)) return invalid('duplicate_tool_name')
    const custom = tool.type === 'custom'
    registry.set(id, { name: tool.name, namespace, custom })
    const format = tool.format
    if (custom && format && !['text', 'grammar'].includes(format.type)) return invalid('unsupported_custom_tool_format')
    if (custom && format?.type === 'grammar' && (!['lark', 'regex'].includes(format.syntax) || typeof format.definition !== 'string')) return invalid('invalid_custom_tool_grammar')
    const textDescription = custom ? [
      tool.description || '', 'This is a client-executed freeform tool. Put the exact raw tool input in the input string. Do not JSON-encode it a second time.',
      format?.type === 'grammar' ? `The raw input must satisfy this ${format.syntax} grammar:\n${format.definition}` : '',
    ].filter(Boolean).join('\n\n') : tool.description || ''
    return { type: 'function', name: tool.name, description: textDescription,
      inputSchema: custom ? { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false }
        : tool.parameters || { type: 'object', properties: {} },
      // All declared tools are available immediately, so discovery never hides a client tool.
      deferLoading: false,
    }
  }
  for (const tool of tools) {
    if (['web_search', 'web_search_preview', 'web_search_preview_2025_03_11'].includes(tool?.type)) {
      if (webSearch) return invalid('duplicate_web_search_tool')
      webSearch = tool
      continue
    }
    if (!validName(tool?.name)) return invalid(`unsupported_tool_${tool?.type || 'unknown'}`)
    if (roots.has(tool.name)) return invalid('duplicate_tool_name')
    roots.add(tool.name)
    if (tool.type === 'namespace') {
      if (!Array.isArray(tool.tools)) return invalid('invalid_namespace_tools')
      // CLI reserves mcp__* for its own MCP servers. Stable wire aliases preserve
      // the client's original namespace on every returned call and history replay.
      const wireName = /^mcp__/i.test(tool.name) ? `gateway_ns_${createHash('sha256').update(tool.name).digest('hex').slice(0,24)}` : tool.name
      if (dynamicTools.some(t => t.name === wireName)) return invalid('duplicate_tool_name')
      namespaces.set(tool.name, wireName)
      dynamicTools.push({ type: 'namespace', name: wireName, description: tool.description || '', tools: tool.tools.map(t => leaf(t, tool.name)) })
    } else dynamicTools.push(leaf(tool))
  }
  const config = { web_search: webSearch ? webSearch.external_web_access === false ? 'cached' : 'live' : 'disabled' }
  if (webSearch) {
    const options = {}
    if (webSearch.search_context_size) options.context_size = webSearch.search_context_size
    if (webSearch.filters?.allowed_domains) options.allowed_domains = webSearch.filters.allowed_domains
    if (webSearch.user_location) {
      const { type, ...location } = webSearch.user_location
      options.location = location
    }
    if (Object.keys(options).length) config['tools.web_search'] = options
  }
  return { dynamicTools, config, webSearch: !!webSearch,
    lookup: (namespace, name) => registry.get(key(namespace, name)),
    historyItem(item) {
      if (!item || typeof item !== 'object') return item
      if (item.namespace && namespaces.has(item.namespace)) item = { ...item, namespace: namespaces.get(item.namespace) }
      if (item.type === 'custom_tool_call') {
        if (typeof item.input !== 'string') return invalid('invalid_custom_tool_input')
        const { input, ...rest } = item
        return { ...rest, type: 'function_call', arguments: JSON.stringify({ input }) }
      }
      if (item.type === 'custom_tool_call_output') return { ...item, type: 'function_call_output' }
      return item
    },
  }
}

export function codexCliToolCall(prepared, params, id) {
  const tool = prepared.lookup(params.namespace, params.tool)
  if (!tool) throw codexCliError('undeclared_cli_tool_request')
  const base = { id, type: tool.custom ? 'custom_tool_call' : 'function_call', status: 'completed', call_id: params.callId,
    name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}) }
  if (tool.custom) {
    if (typeof params.arguments?.input !== 'string') throw codexCliError('invalid_custom_tool_arguments')
    return { ...base, input: params.arguments.input }
  }
  return { ...base, arguments: JSON.stringify(params.arguments) }
}
