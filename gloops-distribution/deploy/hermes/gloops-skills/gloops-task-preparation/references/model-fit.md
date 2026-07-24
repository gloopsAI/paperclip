# Hermes model-fit matrix

Use this matrix until superseded by a newer receipted bake-off.

| Task class | Primary | Fallback | Evidence |
|---|---|---|---|
| Evidence lookup | GLM 5.2 | Kimi K2.7 Code | All five candidates were exact; GLM was concise and fast. |
| Bounded implementation | GLM 5.2 | Kimi K2.7 Code | Both produced a correct verified patch; GLM used the fewest turns and tools. |
| Focused review | GLM 5.2 | MiniMax M3 | GLM found the full concurrency defect; MiniMax found both material issues but proposed a partial fix. |
| Bounded planning | Kimi K2.7 Code | GLM 5.2 | Kimi produced the most bounded complete plan. |
| Terminal reconciliation | GLM 5.2 | Kimi K2.7 Code | Both returned exact terminal truth in one turn without tools. |

DeepSeek V4 Flash and Qwen 3.5 remain evaluated candidates, not default routes. Both completed useful work, but their implementation runs added unrelated receipt files; focused review also missed or failed to implement material findings.

Use Grok Build through its CLI only after an Ollama route is unavailable or unsuitable. Use Codex as the compact advisor or final fallback under the trigger policy in `SKILL.md`; do not route routine work to Codex.
