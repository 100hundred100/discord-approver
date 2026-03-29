# Agent Teams: Orchestrator Pattern

**Status:** ✅ Implemented
**Last Updated:** 2026-03-16
**Author:** Claude Code

---

## Overview

Agent Teams enables Discord users to trigger multi-agent Claude Code sessions via the `/agents` slash command. The feature uses an **Orchestrator pattern** where a primary agent (Orchestrator) manages task decomposition and delegates sub-tasks to specialized agents (product-owner, senior-engineer, api-reviewer).

### Purpose
- Enable complex collaborative tasks that require multiple AI agents with different expertise
- Leverage the Claude Agent SDK orchestrator pattern
- Provide real-time async progress feedback via Discord threads
- Support multiple Claude models (Opus, Sonnet, Haiku) for cost/performance tuning

---

## User Stories

**As a** Discord user
**I want to** run multi-agent tasks via `/agents <task>` with an explicit Orchestrator context
**So that** complex projects can be decomposed and solved by specialized agents

**As a** task operator
**I want to** see each agent's work (PostToolUse notifications) streamed to Discord
**So that** I can monitor progress in real-time

**As a** cost optimizer
**I want to** choose different Claude models (Opus/Sonnet/Haiku) for Agent Teams
**So that** I can balance speed and cost

---

## Acceptance Criteria

### Command Registration
- [ ] `/agents` slash command is registered and available in Discord
- [ ] Command accepts `instruction` (required) and `model` (optional, default: Sonnet) options
- [ ] Model options include Sonnet, Opus, Haiku

### Channel Creation
- [ ] Running `/agents` creates a channel in the 🤖 AGENT TEAMS category
- [ ] Channel name includes emoji prefix (🤖) and timestamp for uniqueness
- [ ] Channel is registered in `task_channels` table with type='agents'

### Agent Execution
- [ ] User instruction is wrapped with Orchestrator context from `.claude/agents/orchestrator.md`
- [ ] Instruction includes list of available sub-agents: product-owner, senior-engineer, api-reviewer
- [ ] Claude Code is spawned with `cwd = config.daemon.defaultWorkingDir` (agent definitions location)
- [ ] Execution timeout is 120 minutes (vs. 30 min for standard tasks)

### Discord Integration
- [ ] Initial response sends purple embed with:
  - Title: "🤖 **Agent Team[model]**を起動しました！"
  - Instruction preview
  - Command ID (first 8 chars)
  - Note: "Orchestrator → product-owner / senior-engineer / api-reviewer が連携して実行します"
- [ ] PostToolUse notifications appear as embedded Agent messages with agent type + description
- [ ] Final result/errors appear in the same thread

### Model Selection
- [ ] Model parameter is case-insensitive and maps:
  - `opus` → `claude-opus-4-6`
  - `sonnet` → `claude-sonnet-4-6` (default)
  - `haiku` → `claude-haiku-4-5-20251001`
- [ ] Model label appears in initial Discord response: `[Opus]`, `[Haiku]` (Sonnet is default, no label)

---

## Implementation Notes

### Files Modified

| File | Changes |
|------|---------|
| `worker/src/discord.ts` | Added `🤖 AGENT TEAMS` category; added `sendAgentTeamReceived()` function |
| `worker/src/routes/interaction.ts` | Added `handleAgentsCommand()` with MODEL_MAP; imported color `0x6366f1` for PostToolUse |
| `worker/src/routes/session.ts` | Updated type emoji map: `agents: '🤖'` |
| `scripts/register-commands.mjs` | Added `/agents` command definition |
| `local/daemon.mjs` | Added `buildOrchestratorInstruction()` wrapper; 120min timeout for `type=agents`; forces `cwd = defaultWorkingDir` |
| `local/post-tool-hook.mjs` | Added Agent tool handling in `formatSummary()` and `formatOutput()` |

### Orchestrator Instruction Format

User instruction is wrapped as:
```
You are Claude Code's Orchestrator Agent.
You have access to these sub-agents:
  - orchestrator (main dispatcher)
  - product-owner (specs, design, roadmap)
  - senior-engineer (architecture, implementation)
  - api-reviewer (API design, security, performance)

User task:
<user instruction>
```

The `.claude/agents/orchestrator.md` file must exist in the working directory with the orchestrator configuration.

### Color Codes

- **Discord Embed:** `color: 0x9333ea` (purple, per design in `sendAgentTeamReceived`)
- **PostToolUse Notification:** `Agent: 0x6366f1` (light blue)
- **Type Emoji:** `🤖` for agents tasks

### Database

No schema changes; uses existing `commands` table with:
- `type: 'agents'`
- `discord_thread_id: channelId` (AGENT TEAMS category channel)
- `model: claude-*-4-6` (specific model version)

---

## Known Issues

### "[Preview Required]" Stop Hook Feedback
- **Issue:** After each session, Claude Desktop shows "[Preview Required]" notification
- **Cause:** Built-in Claude Desktop MCP system hook that checks if code was edited without running a dev server
- **Status:** Cannot be disabled via project settings.json; not applicable to remote execution
- **Workaround:** User can ignore the notification; it does not block functionality

---

## Out of Scope

- Persistent agent memory across sessions
- Custom agent definitions (uses only built-in agents from `.claude/agents/`)
- Multi-turn interactive agent conversations (one-shot orchestration only)
- Fine-tuning agent routing or priorities
- Fallback handling if specific agents fail (errors propagate as-is)

---

## Cross-References

**Related Features:**
- `/task` command (standard single-model execution)
- `/file` command (file operation tasks)
- `/team` command (long-running autonomous tasks)
- `/status` command (view execution state)

**Related Files:**
- `.claude/agents/orchestrator.md` — Orchestrator agent definition
- `.claude/agents/product-owner.md` — Product owner agent
- `.claude/agents/senior-engineer.md` — Senior engineer agent
- `.claude/agents/api-reviewer.md` — API reviewer agent

**External Docs:**
- [Claude Agent SDK Docs](https://github.com/anthropics/claude-agent-sdk)
- [Orchestrator Pattern](https://github.com/naoto13/claude-project-template/.claude)

---

## Testing Checklist

- [ ] `/agents help me design a REST API` executes successfully
- [ ] Agent type appears in PostToolUse notifications
- [ ] Purple embed appears with correct model label
- [ ] Channel is created in 🤖 AGENT TEAMS (not 💻 WORKSPACES)
- [ ] Execution time does not exceed 120 minutes
- [ ] Model selection works: `/agents ... model:opus`
- [ ] Default model (Sonnet) is used when model option omitted
