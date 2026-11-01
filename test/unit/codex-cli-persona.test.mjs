import test from 'node:test'
import assert from 'node:assert/strict'
import { renderCodexCliPersona } from '../../src/lib/protocol/codex-cli-persona.mjs'
import { CodexCliHistory } from '../../src/lib/protocol/codex-cli-history.mjs'

const body = { model: 'fixture', instructions: 'Caller developer rule', input: 'Hello' }
const config = (text = 'Synthetic custom rule') => ({ compatibility: {
  persona_preset: 'custom', persona_templates: { custom: [{ text }] }, overlay_preset: 'off',
} })

test('built-in presets use Codex defaults without Claude attribution; zero adds no instructions', () => {
  const result = renderCodexCliPersona({ body, routing: { compatibility: {} } })
  assert.match(result.baseInstructions, /OpenAI assistant/)
  assert.doesNotMatch(result.baseInstructions, /Claude|Anthropic|cc_version|prompt_version|__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__/)
  assert.equal(renderCodexCliPersona({ body, routing: { compatibility: { persona_preset: 'zero' } } }).baseInstructions, '')
  assert.equal(renderCodexCliPersona({ body, routing: config('Literal Claude reference stays unchanged') }).baseInstructions, 'Literal Claude reference stays unchanged')
})

test('custom template reaches base instructions verbatim and updates per request without mutating input', () => {
  const routing = config('Synthetic rule\nNo report headers.')
  const snapshot = structuredClone({ body, routing })
  const first = renderCodexCliPersona({ body, routing })
  assert.equal(first.baseInstructions, 'Synthetic rule\nNo report headers.')
  assert.equal(first.body, body)
  assert.deepEqual({ body, routing }, snapshot)
  routing.compatibility.persona_templates.custom[0].text = 'Edited rule'
  assert.equal(renderCodexCliPersona({ body, routing }).baseInstructions, 'Edited rule')
})

test('slot override, retired preset migration and block switches use the shared settings', () => {
  const routing = config()
  Object.assign(routing.compatibility, {
    persona_templates: { ...routing.compatibility.persona_templates,
      official_303: [{ id: 'harness', text: 'Slot rule' }, { id: 'guidance', text: 'Opt-in guidance' }, { id: 'disabled', text: 'Excluded' }] },
    persona_block_presets: { official_303: { disabled: false } },
  })
  const opts = { body, routing, vm: { persona_preset: 'official_303' } }
  assert.equal(renderCodexCliPersona(opts).baseInstructions, 'Slot rule')
  routing.compatibility.persona_block_presets.official_303.guidance = true
  assert.equal(renderCodexCliPersona(opts).baseInstructions, 'Slot rule\n\nOpt-in guidance')
})

test('environment variables come from this slot and honor preset switches', () => {
  const routing = config('{{model}}|{{cwd}}|{{timezone}}|{{locale}}')
  const compat = routing.compatibility
  compat.persona_timezone_presets = { custom: true }
  compat.persona_locale_presets = { custom: true }
  const opts = { body, routing, vm: { timezone: 'America/Los_Angeles', locale: 'en_US.UTF-8' }, cwd: '/guest/work' }
  assert.equal(renderCodexCliPersona(opts).baseInstructions, 'fixture|/guest/work|America/Los_Angeles|en_US.UTF-8')
  compat.persona_env_presets = { custom: false }
  assert.equal(renderCodexCliPersona(opts).baseInstructions, 'fixture|/guest/work||')
})

test('caller system placeholders consume only system text once; roles, tools and images survive', () => {
  const input = [
    { role: 'system', content: 'Caller system rule' },
    { role: 'developer', content: 'Keep developer role' },
    { type: 'function_call', call_id: 'c1', name: 'lookup', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    { role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/image.png' }, { type: 'input_text', text: 'Describe' }] },
  ]
  const original = { ...body, input }
  const routing = config('Gateway rule\n{{caller_system}}')
  const result = renderCodexCliPersona({ body: original, routing })
  assert.equal(result.baseInstructions, 'Gateway rule\nCaller system rule')
  assert.equal(result.body.instructions, body.instructions)
  assert.deepEqual(result.body.input, input.slice(1))
  assert.equal(original.input.length, 5)
  assert.equal(renderCodexCliPersona({ body: original, routing: config() }).body, original)
})

test('standing, overlay, zero preset and empty templates follow explicit switches', () => {
  const routing = config()
  const compat = routing.compatibility
  compat.persona_templates.custom = [{ id: 'harness', text: 'Harness' }]
  compat.agent_standing = 'Standing rule'
  compat.agent_standing_presets = { custom: true }
  compat.overlay_preset = 'custom'
  compat.overlay_templates = { custom: [{ text: 'Overlay {{standing}}' }] }
  compat.persona_standing = 'Constraint'
  assert.equal(renderCodexCliPersona({ body, routing }).baseInstructions, 'Standing rule\nHarness\n\nOverlay Constraint')
  compat.persona_templates.zero = [{ text: ' ', drop_if_empty: true }]
  assert.equal(renderCodexCliPersona({ body, routing, vm: { persona_preset: 'zero' } }).baseInstructions, '')
})

test('stored continuation contains raw caller data; freshly rendered persona does not accumulate', () => {
  const history = new CodexCliHistory()
  const routing = config('First rule')
  const first = { ...body, input: [{ role: 'system', content: 'Caller rule' }, { role: 'user', content: 'Hello' }] }
  renderCodexCliPersona({ body: first, routing })
  history.remember(first, { id: 'r1', status: 'completed', output: [{ role: 'assistant', content: 'Reply' }] }, 'owner')
  routing.compatibility.persona_templates.custom[0].text = 'Second rule {{caller_system}}'
  const expanded = history.expand({ ...body, previous_response_id: 'r1', input: 'Continue' }, 'owner')
  const rendered = renderCodexCliPersona({ body: expanded, routing })
  assert.equal(rendered.baseInstructions, 'Second rule Caller rule')
  assert.equal(JSON.stringify(rendered.body).includes('First rule'), false)
  assert.equal(expanded.input.filter(i => i.role === 'system').length, 1)
  assert.equal(rendered.body.input.filter(i => i.role === 'system').length, 0)
})
