# Auto-Approve Mode: `/auto` and `/manual` Commands

**Status:** ✅ Implemented
**Last Updated:** 2026-03-16
**Author:** Claude Code

---

## Overview

Auto-Approve Mode allows Discord users to toggle automatic approval of tool-use requests within a specific channel using `/auto` and `/manual` slash commands. Instead of waiting for manual Approve/Deny button clicks, approval requests are immediately resolved when auto-approve is enabled.

### Purpose
- Reduce friction for trusted, high-confidence tasks in specific channels
- Provide immediate Interaction API response (no polling delay)
- Support both task channels (WORKSPACES) and session channels (dynamic)
- Enable per-channel approval workflows

### Problem Solved
Previous attempt using `@bot auto` @mention suffered from **race condition**:
- Approval requests arrive synchronously via webhook
- `@bot auto` is processed by 10-second polling cycle
- Requests show Approve/Deny buttons before polling detects auto-approve setting

Solution: Discord Interaction API slash commands provide **synchronous, immediate** response.

---

## User Stories

**As a** task channel operator
**I want to** run `/auto` in my WORKSPACES channel
**So that** all approval requests in that channel are automatically approved without buttons

**As a** user
**I want to** run `/manual` to revert to manual approval mode
**So that** I can re-enable Approve/Deny buttons for critical tasks

**As a** session manager
**I want to** enable auto-approve in both task channels AND dynamically-created session channels
**So that** approval workflows are consistent across all execution contexts

---

## Acceptance Criteria

### `/auto` Command
- [ ] Slash command `/auto` is registered and available in Discord
- [ ] Can be invoked in any channel (task, session, or general)
- [ ] Sets `auto_approve = 1` in `task_channels` table for the channel
- [ ] If channel is new to `task_channels`, INSERT operation creates row (via upsert)
- [ ] If channel already exists in `task_channels`, UPDATE sets `auto_approve = 1` (via upsert)
- [ ] Returns ephemeral reply: "✅ **自動承認モード ON** — このチャンネルの承認リクエストは自動的に承認されます。\n`/manual` で手動承認に戻せます。"

### `/manual` Command
- [ ] Slash command `/manual` is registered and available in Discord
- [ ] Sets `auto_approve = 0` in `task_channels` table for the channel
- [ ] Returns ephemeral reply: "🔔 **手動承認モードに戻しました** — 承認リクエストには Approve/Deny ボタンが表示されます。"

### Auto-Approve Behavior
- [ ] When approval request arrives at `/api/request`, system calls `isAutoApprove(channelId)`
- [ ] If true:
  - Immediately resolves request with status='approved' (no button message)
  - Sends minimal notification: "✅ **自動承認** \`{tool_name}\`"
- [ ] If false (default):
  - Sends standard approval message with Approve/Deny buttons
  - Waits for user interaction

### Response Timing
- [ ] Slash command response is immediate (Interaction API, no delay)
- [ ] Next approval request within the channel respects the new setting
- [ ] No polling latency or race conditions

---

## Implementation Notes

### Files Modified

| File | Changes |
|------|---------|
| `worker/src/routes/interaction.ts` | Added `case 'auto':` and `case 'manual':` to switch; added `handleAutoCommand(enable: boolean)` function |
| `worker/src/routes/approval.ts` | Added auto-approve check after saving request; calls `isAutoApprove()` and either auto-resolves or sends buttons |
| `worker/src/db.ts` | Added `TaskChannel.auto_approve` field; added `setTaskChannelAutoApprove()` (upsert); added `isAutoApprove()` query |
| `worker/src/routes/session.ts` | Added `@bot auto/manual` @mention detection (fallback polling method, for context) |
| `scripts/register-commands.mjs` | Added `/auto` and `/manual` command definitions |
| **D1 Migration** | `ALTER TABLE task_channels ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0;` |

### Database Schema

```sql
-- task_channels table (existing + new column)
CREATE TABLE task_channels (
  channel_id TEXT PRIMARY KEY,
  working_dir TEXT,
  last_message_id TEXT,
  auto_approve INTEGER NOT NULL DEFAULT 0  -- NEW: 0=manual, 1=auto
);
```

### Key Functions

#### `setTaskChannelAutoApprove(db, channelId, enabled, workingDir?)`
Uses **INSERT ... ON CONFLICT ... DO UPDATE** (upsert pattern):
```typescript
INSERT INTO task_channels (channel_id, working_dir, auto_approve)
VALUES (?, ?, ?)
ON CONFLICT(channel_id) DO UPDATE SET auto_approve = excluded.auto_approve
```
- Works for channels not yet in table (INSERT)
- Works for existing channels (UPDATE)
- Preserves `working_dir` if provided

#### `isAutoApprove(db, channelId): boolean`
```typescript
SELECT auto_approve FROM task_channels WHERE channel_id = ?
// Returns (row?.auto_approve ?? 0) === 1
```

#### `handleAutoCommand(body, env, enable: boolean)`
Reads `body.channel_id` from Discord Interaction context and calls `setTaskChannelAutoApprove`.

#### Approval Request Flow
In `approval.ts` `handleCreateRequest()`:
```typescript
const autoApprove = threadId ? await isAutoApprove(env.DB, threadId) : false;

if (autoApprove) {
  await resolveApprovalRequest(env.DB, body.id, 'approved');
  if (threadId) {
    await sendMessage(env.DISCORD_TOKEN, threadId, {
      content: `✅ **自動承認** \`${toolLabel}\``,
    });
  }
} else {
  // sendApprovalMessage with Approve/Deny buttons
}
```

### Scope Coverage

Auto-approve applies to:
- ✅ Task channels (WORKSPACES) created by `/task`, `/file`, `/team`
- ✅ Session channels created by `approve-hook.mjs`
- ✅ Any channel where `/auto` is run
- ✅ Both standard tasks and Agent Teams

---

## Known Issues

### "@bot auto" Polling Method (Deprecated Fallback)
- Previous attempt using `@bot auto` @mention is still in code (`worker/src/routes/session.ts`)
- Suffers from race condition: approval arrives before 10-second polling cycle detects setting
- **Recommendation:** Keep as fallback for UX, but primary path is `/auto` slash command
- Not removed because it provides alternative if Interaction API fails

### "[Preview Required]" Stop Hook (Unrelated)
- Appears after every session; origin: Claude Desktop app built-in MCP
- Not related to approval workflows
- Cannot be suppressed via project settings
- Does not affect functionality

---

## Out of Scope

- Approval scheduling or delayed auto-approval
- Per-tool-type approval rules (e.g., auto-approve Bash but not Read)
- Approval quotas or rate limiting
- Audit trail of auto-approved requests (separate from manual approvals)
- Granular user-level permissions for enabling auto-approve

---

## Cross-References

**Related Features:**
- Approval workflow (`/api/request` POST endpoint)
- Task channels system (WORKSPACES category)
- Session management (session channels in approval.ts)

**Related Files:**
- `worker/src/routes/approval.ts` — Approval request handling
- `worker/src/db.ts` — Database functions
- `worker/src/routes/interaction.ts` — Slash command handler
- `local/daemon.mjs` — Task execution (passes channel ID via DISCORD_CHANNEL_ID env var)
- `local/approve-hook.mjs` — Approval request hook

**Discord Concepts:**
- Interaction API (slash commands) vs. Message API (buttons)
- Ephemeral replies (visible only to command user)
- Channel ID in Interaction context (`body.channel_id`)

---

## Testing Checklist

- [ ] `/auto` command succeeds and returns ephemeral message
- [ ] Subsequent approval requests in the channel show no buttons
- [ ] `/manual` command succeeds
- [ ] Next approval request shows Approve/Deny buttons
- [ ] Auto-approve works in both task channels (WORKSPACES) and session channels
- [ ] Channel not yet in `task_channels` can be auto-enabled (INSERT succeeds)
- [ ] Existing channel can be toggled (UPDATE succeeds)
- [ ] Auto-resolved approvals log "✅ **自動承認**" notification
- [ ] Model parameter in `/task` + auto-approve in channel works correctly
- [ ] Agent Teams tasks respect auto-approve setting

---

## Deployment Checklist

- [x] Code changes implemented and tested
- [x] Worker deployed: `npx wrangler deploy`
- [x] D1 migration executed: `ALTER TABLE task_channels ADD COLUMN auto_approve ...`
- [x] Commands registered: `DISCORD_TOKEN=... DISCORD_APPLICATION_ID=... node scripts/register-commands.mjs`
- [x] `/auto` and `/manual` appear in Discord slash command list
- [ ] User confirmation: run `/auto` in a test channel, trigger approval request, verify no buttons appear
