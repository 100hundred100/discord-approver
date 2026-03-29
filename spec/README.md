# Discord Approver Specifications

This directory contains feature specifications for the Discord Approver system — a Cloudflare Worker + D1 relay that bridges Claude Code (Mac) to Discord for approval workflows, task dispatch, and multi-agent orchestration.

---

## Feature Specs

| Spec | Status | Summary |
|------|--------|---------|
| `feature-agent-teams.md` | ✅ Implemented | Multi-agent orchestration via `/agents` command with Orchestrator pattern |
| `feature-auto-approve-commands.md` | ✅ Implemented | Toggle auto-approval mode with `/auto` and `/manual` slash commands |
| `known-issues.md` | Active | "[Preview Required]" stop hook feedback; deprecated `@bot auto` polling |

---

## Quick Links

**Getting Started:**
- Agent Teams: Trigger complex multi-agent tasks with `/agents <instruction> [model:opus/sonnet/haiku]`
- Auto-Approve: Enable auto-approval in a channel with `/auto`

**Technical Overview:**
- All features use Discord Interaction API (slash commands)
- Approval requests checked via `isAutoApprove()` in `worker/src/routes/approval.ts`
- Slash commands registered via `scripts/register-commands.mjs`
- D1 schema includes `task_channels.auto_approve` flag

**Known Limitations:**
- Agent Teams only works with built-in agents (orchestrator, product-owner, senior-engineer, api-reviewer)
- Auto-approve is per-channel; no per-tool or per-user granularity
- No persistent agent memory across sessions

---

## Implementation Status

| Component | Files | Status |
|-----------|-------|--------|
| Agent Teams Command | `interaction.ts`, `discord.ts`, `daemon.mjs` | ✅ Complete |
| Auto-Approve Commands | `interaction.ts`, `approval.ts`, `db.ts` | ✅ Complete |
| Discord Integration | `post-tool-hook.mjs`, `discord.ts` | ✅ Complete |
| D1 Schema | Migration completed | ✅ Complete |
| Slash Commands | `scripts/register-commands.mjs` | ✅ Registered |

---

## Architecture Notes

**Layers:**
- **Discord**: `worker/src/discord.ts` — channel creation, message formatting
- **Routes**: `worker/src/routes/interaction.ts`, `approval.ts` — request handling
- **Database**: `worker/src/db.ts` — D1 operations
- **Daemon**: `local/daemon.mjs` — Mac-side task execution, channel IPC
- **Hooks**: `local/approve-hook.mjs`, `local/post-tool-hook.mjs` — approval and completion notifications

**Channel Categories:**
```
🏢 COMMAND CENTER  (dispatch, status-board, completed-tasks)
💻 WORKSPACES      (task channels from /task, /file, /team)
🤖 AGENT TEAMS     (channels from /agents)
🗄️ ARCHIVE         (retired channels)
```

---

## Testing Recommendations

1. **Agent Teams**
   - Run `/agents help me design a REST API`
   - Verify channel created in 🤖 AGENT TEAMS
   - Check for purple embed + Orchestrator note
   - Monitor PostToolUse notifications

2. **Auto-Approve**
   - Run `/auto` in a test channel
   - Trigger an approval request (e.g., `/task ls`)
   - Verify no Approve/Deny buttons appear
   - Run `/manual` to re-enable buttons

3. **Model Selection**
   - Try `/agents ... model:opus` and `/agents ... model:haiku`
   - Verify model label appears in Discord response

---

## Deployment Checklist

- [x] Feature code implemented
- [x] Worker deployed: `npx wrangler deploy`
- [x] D1 schema migrated: `auto_approve` column added
- [x] Slash commands registered: `/agents`, `/auto`, `/manual`, `/status`, `/history`, `/task`, `/file`, `/team`, `/setup`
- [ ] **User Verification:** Confirm `/auto` prevents approval button display

---

## Contact & Issues

Questions or issues? Refer to the individual spec files for detailed implementation notes and known issues.

See `known-issues.md` for "[Preview Required]" feedback and other open items.
