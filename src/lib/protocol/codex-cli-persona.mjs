import { randomUUID } from 'node:crypto'
import {
  agentStandingVar, canonicalPersonaCompat, DEFAULT_PERSONA_TEMPLATES, extractTemplateVars, normalizePersonaPreset,
  presetFlagEnabled, renderOverlayTemplate, renderPersonaTemplate, resolveOverlayTemplate,
  resolvePersonaTemplate, selectedTemplateBlocks,
} from '../identity/persona-template.mjs'
import {
  PERSONA_STANDING_MAX, modelEnvExtra, personaTemplateSettingsFromRouting,
} from '../identity/crs-persona.mjs'
import { resolveSlotPersonaPreset } from '../vm/slot-engine.mjs'
import { CODEX_CLI_VERSION, CODEX_CLI_GUEST_WORKDIR } from '../vm/codex-cli-config.mjs'

export const CODEX_CLI_BASE_INSTRUCTIONS = 'You are a helpful assistant. Follow the supplied instructions and use only the caller-provided tools.'
const GUIDANCE = 'Answer the user clearly and accurately. Use caller-provided tools when needed and report their actual results.'
const STANDING = 'Use only caller-provided tools. Do not invent tool executions or results.'

/** Reuse the template schema, but never inject built-in Claude identity, billing or tools into Codex. */
function templateVars({ body, compat, preset, vm, cwd, withEnv, callerSystem }) {
  const flag = field => withEnv && presetFlagEnabled(compat, field, preset)
  const timezone = flag('persona_timezone_presets') ? String(vm.timezone || '') : ''
  const locale = flag('persona_locale_presets') ? String(vm.locale || 'en_US.UTF-8') : ''
  const environment = () => withEnv ? [
    'Environment:', 'Platform: linux', `Working directory: ${cwd}`, `Model: ${body.model}`,
    timezone && `Timezone: ${timezone}`, locale && `Language: ${locale}`,
  ].filter(Boolean).join('\n') : ''
  const guidance = presetFlagEnabled(compat, 'persona_guidance_presets', preset) || compat.persona_block_presets?.[preset]?.guidance === true ? GUIDANCE : ''
  return {
    billing: '', billing_semi: '', dynamic_boundary: '', keep_dynamic_boundary: false,
    identity: 'You are an OpenAI assistant.', identity_cli: 'You are an OpenAI assistant.', identity_compact: 'You are an OpenAI assistant.',
    reporting: 'Report results clearly and accurately.', agent_expansion: CODEX_CLI_BASE_INSTRUCTIONS,
    agent_official: CODEX_CLI_BASE_INSTRUCTIONS, harness_303: CODEX_CLI_BASE_INSTRUCTIONS,
    main_prompt_303: [CODEX_CLI_BASE_INSTRUCTIONS, guidance].filter(Boolean).join('\n\n'), guidance_303: guidance,
    agent_standing: agentStandingVar(compat, preset), caller_agent: '', caller_system: callerSystem,
    env: environment, env_official: environment, env_303: environment,
    env_timezone_only: () => withEnv && vm.timezone ? `Timezone: ${vm.timezone}` : '',
    env_instructions_303: flag('persona_env_instructions_presets') ? STANDING : '',
    env_timezone: timezone ? `Timezone: ${timezone}` : '', env_locale: locale ? `Language: ${locale}` : '',
    timezone, locale, model: body.model, cwd, cli_version: CODEX_CLI_VERSION, session_id: randomUUID(),
    model_sentence: () => flag('model_env_extra_presets') ? modelEnvExtra(compat, body.model) : '',
  }
}

function textContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || !content.every(p => p?.type === 'input_text' && typeof p.text === 'string')) return null
  return content.map(p => p.text).join('\n\n')
}

/** Request-scoped rendering, after history expansion. Never persist rendered prompts in history. */
export function renderCodexCliPersona({ body, routing, vm = {}, cwd = CODEX_CLI_GUEST_WORKDIR } = {}) {
  if (!routing) return { body, baseInstructions: CODEX_CLI_BASE_INSTRUCTIONS }
  const compat = canonicalPersonaCompat(routing.compatibility || {})
  const settings = personaTemplateSettingsFromRouting(routing)
  const preset = normalizePersonaPreset(resolveSlotPersonaPreset(vm, routing))
  const withEnv = presetFlagEnabled(compat, 'persona_env_presets', preset)
  const blocks = selectedTemplateBlocks(resolvePersonaTemplate(preset, settings.templates), compat, preset)
    .filter(block => !block.role || (block.role === 'system' && withEnv))
    // Zero's legacy default is exclusively a Claude billing attribution wrapper.
    .filter(block => !(preset === 'zero' && block.text === DEFAULT_PERSONA_TEMPLATES.zero[0].text))
  const items = Array.isArray(body.input) ? body.input : []
  const callers = items.filter(item => item?.role === 'system' && textContent(item.content) !== null)
  // Only caller system messages may fill this placeholder. Developer instructions,
  // user messages, images and function calls retain their original roles and structure.
  const callerSystem = callers.map(item => textContent(item.content)).join('\n\n')
  const consumesCaller = blocks.some(block => extractTemplateVars(block.text).includes('caller_system'))
  const vars = templateVars({ body, compat, preset, vm, cwd, withEnv, callerSystem })
  const rendered = [
    ...renderPersonaTemplate(blocks, vars),
    ...renderPersonaTemplate(blocks, vars, { role: 'system' }),
  ].map(block => block.text).filter(text => text.replaceAll('\u200b', '').trim())
  if (preset !== 'zero') {
    const standing = compat.persona_standing == null ? STANDING : String(compat.persona_standing).trim().slice(0, PERSONA_STANDING_MAX)
    const overlay = renderOverlayTemplate(resolveOverlayTemplate(settings.overlayPreset, settings.overlayTemplates), { standing })
    if (overlay) rendered.push(overlay)
  }
  return {
    preset,
    baseInstructions: rendered.join('\n\n'),
    body: consumesCaller && callers.length ? { ...body, input: items.filter(item => !callers.includes(item)) } : body,
  }
}
