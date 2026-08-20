export const type = "grok_local";
export const label = "Grok Build";

export const DEFAULT_GROK_LOCAL_MODEL = "grok-build";

export const models = [
  { id: DEFAULT_GROK_LOCAL_MODEL, label: DEFAULT_GROK_LOCAL_MODEL },
];

export const agentConfigurationDoc = `# grok_local agent configuration

Adapter: grok_local

Use when:
- You want Paperclip to run the native Grok Build CLI locally on the host machine
- You want resumable Grok sessions across heartbeats via \`--resume\`
- You want Paperclip-managed instructions and skills supplied through a run-scoped \`--rules\` bundle outside the Git worktree

Don't use when:
- You need a webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- Grok CLI is not installed or authenticated on the machine that runs Paperclip

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file included in the run-scoped rules bundle
- promptTemplate (string, optional): run prompt template
- model (string, optional): Grok model id. Defaults to grok-build.
- permissionMode (string, optional): Grok permission mode. Defaults to \`dontAsk\`
- reasoningEffort (string, optional): Grok reasoning effort passed via \`--reasoning-effort\`
- maxTurns (number, optional): maximum agent turns for the run
- command (string, optional): defaults to "grok"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use \`grok --single\` with \`--output-format streaming-json\`.
- Sessions resume with \`--resume <sessionId>\` when the saved session cwd matches the current cwd.
- Paperclip combines desired runtime skills into a temporary rules bundle and never writes generated context into the Git worktree.
- Use \`grok models\` to inspect authentication and available models on the host.
`;
