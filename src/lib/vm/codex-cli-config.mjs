export const CODEX_CLI_VERSION = '0.166.0'
export const CODEX_CLI_BINARY_SHA256 = 'b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8'
export const CODEX_CLI_ARCHIVE_SHA256 = 'a0bf572d2f93f056c6712a6da348e96078dc84f3885fd7be67807ef389cb3978'
export const CODEX_CLI_GUEST_BIN = '/home/kincli/.local/share/vm2api-codex/codex'
export const CODEX_CLI_GUEST_HOME = '/home/kincli/.codex-vm2api'
export const CODEX_CLI_GUEST_WORKDIR = '/home/kincli/.local/share/vm2api-codex/workspace'

export function isCodexCliVm(vm) { return vm?.codex_cli?.enabled === true }

/** Managed gateway process: only caller-declared functions are exposed to the model. */
export function codexCliAppServerArgs() {
  const disabled = [
    'shell_tool', 'unified_exec', 'apply_patch_freeform', 'multi_agent', 'multi_agent_v2',
    'code_mode', 'code_mode_host', 'plugins', 'apps', 'memories', 'memory_tool', 'view_image',
    'computer_use', 'browser_use', 'browser_use_external', 'image_generation', 'imagegenext',
    'js_repl', 'hooks', 'goals', 'remote_control', 'skill_search', 'tool_search', 'sleep_tool',
    'collaboration_modes', 'default_mode_request_user_input', 'personality', 'model_catalog_in_context',
    'current_time_reminder', 'terminal_visualization_instructions', 'workspace_owner_usage_nudge',
    'send_message_to_user_async', 'request_permissions_tool', 'shell_snapshot', 'shell_snapshot_v2',
  ]
  return ['app-server', '--stdio',
    '-c', 'cli_auth_credentials_store="file"', '-c', 'web_search="disabled"',
    '-c', 'analytics.enabled=false', '-c', 'tools.update_plan.enabled=false',
    '-c', 'project_doc_max_bytes=0',
    '-c', 'include_environment_context=false', '-c', 'include_environment_context_time=false',
    '-c', 'include_permissions_instructions=false', '-c', 'include_collaboration_mode_instructions=false',
    '-c', 'include_apps_instructions=false', '-c', 'features.skip_host_skill_discovery=true',
    '-c', 'features.fast_mode=true', '-c', 'features.ultrafast_mode=true',
    ...disabled.flatMap((name) => ['-c', `features.${name}=false`]),
  ]
}
