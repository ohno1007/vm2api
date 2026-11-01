import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareCodexCliTools, codexCliToolCall } from '../../src/lib/protocol/codex-cli-tools.mjs'
import { prepareCodexCliRequest } from '../../src/lib/protocol/codex-cli-responses.mjs'

const tools = [{ type: 'custom', name: 'exec', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } },
  { type: 'function', name: 'wait', parameters: { type: 'object' } },
  { type: 'namespace', name: 'clock', tools: [{ type: 'function', name: 'sleep' }] },
  { type: 'namespace', name: 'mcp__cua_repl', tools: [{ type: 'custom', name: 'js' }, { type: 'function', name: 'sleep' }] },
  { type: 'web_search', search_context_size: 'low', filters: { allowed_domains: ['example.com'] } }]

test('CC Switch custom, function, namespace and web search declarations survive preparation', () => {
  const p = prepareCodexCliTools(tools)
  assert.equal(p.dynamicTools.length, 4)
  assert.equal(p.dynamicTools[0].inputSchema.properties.input.type, 'string')
  assert.match(p.dynamicTools[0].description, /start: /)
  assert.equal(p.dynamicTools[2].tools[0].name, 'sleep')
  assert.equal(p.config.web_search, 'live')
  assert.deepEqual(p.config['tools.web_search'], { context_size: 'low', allowed_domains: ['example.com'] })
  assert.equal(prepareCodexCliTools([]).config.web_search, 'disabled')
})

test('freeform and namespace calls retain exact text, namespace and caller correlation', () => {
  const p = prepareCodexCliTools(tools), text = 'const x = "hi";\nreturn x;'
  const wireNamespace = p.dynamicTools[3].name
  const call = codexCliToolCall(p, { tool: 'js', namespace: wireNamespace, callId: 'c1', arguments: { input: text } }, 'i1')
  assert.equal(call.type, 'custom_tool_call');assert.equal(call.input, text);assert.equal(call.namespace, 'mcp__cua_repl')
  assert.equal(codexCliToolCall(p, { tool: 'sleep', namespace: 'clock', callId: 'c2', arguments: { duration_ms: 1 } }, 'i2').namespace, 'clock')
  assert.throws(() => codexCliToolCall(p, { tool: 'sleep', namespace: 'other' }, 'i3'), /undeclared/)
  const original = { model: 'fixture', tools, input: [call, { type: 'custom_tool_call_output', call_id: 'c1', output: 'hi' }] }
  const ready = prepareCodexCliRequest(original)
  assert.equal(ready.history[0].arguments, JSON.stringify({ input: text }))
  assert.equal(ready.history[0].namespace, wireNamespace)
  assert.equal(ready.history[1].type, 'function_call_output')
  assert.equal(original.input[0].type, 'custom_tool_call')
})

test('same names across namespaces are legal; duplicates in one scope are rejected', () => {
  assert.doesNotThrow(() => prepareCodexCliTools(tools))
  assert.throws(() => prepareCodexCliTools([{ type: 'function', name: 'x' }, { type: 'function', name: 'x' }]), /duplicate/)
  assert.throws(() => prepareCodexCliTools([{ type: 'namespace', name: 'x', tools: [{ type: 'function', name: 'a' }, { type: 'function', name: 'a' }] }]), /duplicate/)
})
