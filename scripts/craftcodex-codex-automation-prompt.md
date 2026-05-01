# CraftCodex Codex Automation

Title:
CraftCodex upstream update monitor

Recommended settings:
- Project: `/Users/Kosta/LocalDev/CraftAgentCodex`
- Schedule: daily at 9:00 AM, or hourly if you want faster detection
- Execution environment: Worktree
- Model: GPT-5.5
- Thinking: Low

Prompt:

```text
You are the CraftCodex upstream update monitor for /Users/Kosta/LocalDev/CraftAgentCodex.

Use GPT-5.5 with low thinking effort if the automation settings allow it.

Goal:
Monitor the official Craft Agents update feed and, only when an official update is newer than the current CraftCodex GitHub release feed, compose and publish a new CraftCodex release.

Steps:
1. cd /Users/Kosta/LocalDev/CraftAgentCodex.
2. Run `bun scripts/craftcodex-check-upstream-update.ts`.
3. If `update_available=false`, report "CraftCodex is current" with the official version and CraftCodex version, then stop.
4. If `update_available=true`, first ensure the git worktree is clean. If it is dirty, report the dirty files and stop without publishing.
5. Fetch upstream: `git fetch upstream main --tags`.
6. Create or switch to a branch named `craftcodex/upstream-<official_version>`.
7. Merge `v<official_version>` if that tag exists, otherwise merge `upstream/main`.
8. Resolve conflicts carefully:
   - preserve CraftCodex branding, icon, bundle id, GitHub update feed, and app name,
   - preserve Droid, Hermes, and Codex ACP agent support,
   - preserve Factory BYOK model support, model picker fixes, agent readiness/status work, and tests,
   - prefer official upstream changes where they do not conflict with CraftCodex additions.
9. Run `bun scripts/craftcodex-bump-version.ts <official_version>`.
10. Run:
    - `bun test apps/electron/src/main/__tests__/auto-update-config.test.ts apps/electron/src/shared/__tests__/ipc-channels.test.ts`
    - `bun run typecheck:electron`
    - `git diff --check`
11. Build:
    `CRAFTCODEX_UPDATE_FEED_URL=https://github.com/ildunari/craft-agents-oss/releases/download/craftcodex-latest bun run electron:dist:dev:mac`
12. If checks and build pass, commit the composed source changes with this trailer exactly once:
    `Co-authored-by: Codex <noreply@openai.com>`
13. Push the branch to origin.
14. Publish the update feed with `bun scripts/upload.ts --electron`.
15. Open or update a PR to main if GitHub CLI is authenticated.

Safety:
- Never publish if tests, typecheck, build, conflict checks, or `git diff --check` fail.
- Never run destructive git reset or checkout commands on user changes.
- If secrets or auth are missing, report exactly what is missing and stop.

Final report must include:
- official version
- previous CraftCodex version
- branch
- PR URL if available
- release feed URL
- tests run
- whether the update was published
```
