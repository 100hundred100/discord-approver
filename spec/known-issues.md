# Known Issues

**Status:** Active as of 2026-03-16
**Last Updated:** 2026-03-16

---

## "[Preview Required]" Stop Hook Feedback

### Description
After every Claude Code session completes, the user sees a message in the session:
```
Stop hook feedback: [Preview Required]
Code was edited but no dev server is running. Install dependencies if needed, call preview_start, then follow <verification_workflow>.
```

### Root Cause
This is a **built-in Claude Desktop app behavior**, not a project-level feature.
- Sourced from Claude Desktop's embedded system MCP (not accessible via settings.json)
- Triggered by the Claude Preview MCP's Stop hook
- Checks if code was modified without running a dev server before session end
- Appears regardless of actual code changes or dev server status

### Impact
- **Severity:** Low (cosmetic, does not block functionality)
- **Scope:** Session end message only
- **Workaround:** User can safely ignore the notification
- **False Positives:** Common — appears even when no code was edited or when dev server is running

### Why It Cannot Be Disabled
- Removal attempts have been tried:
  - Removed `stop-ci.sh` Stop hook from project `settings.json`
  - Removed `mcp__Claude_Preview__preview_start` from `permissions.allow` list
  - Both had no effect
- Root cause: built-in system MCP from Claude Desktop ASAR bundle
- No project-level configuration can override system MCP behavior

### Recommendation
**No action required.** This is expected behavior from Claude Desktop and does not indicate any problem with the discord-approver implementation.

If the message becomes too noisy, report to Anthropic at https://github.com/anthropics/claude-code/issues.

---

## "@bot auto" Polling Race Condition (Deprecated)

### Description
Previous implementation used `@bot auto` @mention to toggle auto-approve mode.
Approval requests would arrive with Approve/Deny buttons despite the channel being set to auto-approve.

### Root Cause
- Approval requests arrive **synchronously** via webhook from Mac daemon
- `@bot auto` is processed by **10-second polling cycle** in `worker/src/routes/session.ts`
- Race: request saved to DB before polling detects `auto_approve = 1`

### Resolution
Replaced with `/auto` and `/manual` **slash commands** (Discord Interaction API).
- Synchronous, immediate response via Interaction API
- Sets `auto_approve` flag **before** next approval request can arrive
- Eliminates race condition entirely

### Current Status
- `@bot auto/manual` code still exists in `worker/src/routes/session.ts` (fallback)
- Not removed for robustness, but not the primary path
- Primary path: `/auto` slash command

### Migration Path
Users who were using `@bot auto` should now use `/auto` instead for guaranteed immediate effect.

---

## References
- Agent Teams: `spec/feature-agent-teams.md`
- Auto-Approve Commands: `spec/feature-auto-approve-commands.md`
