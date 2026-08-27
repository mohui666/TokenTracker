# Privacy Policy

_Last updated: 2026-07-27 · Applies to the `tokentracker-cli` npm package, the macOS app, and the Windows app._

TokenTracker reads the local logs that AI coding tools already write to your disk, and turns them into token counts and cost estimates. It is local-first: the dashboard, the parsers and the database all run on your machine.

This document lists **every** network request the software can make, what each one sends, and how to switch it off. If you find a request that is not listed here, that is a bug — please [open an issue](https://github.com/mohui666/TokenTracker/issues).

---

## 1. What never leaves your machine

TokenTracker's parsers extract numbers and timestamps only. TRAE Work CN is a narrow exception to the local-only source model, and it is off by default: only when you explicitly set `TOKENTRACKER_TRAE_CN_USAGE=1`, during an eligible non-background sync, when local TRAE Work CN auth exists, does TokenTracker transmit the existing sign-in authorization from the locally signed-in app to TRAE's internal API for a read-only usage request. Without that variable nothing is ever sent. It is not an unconditional or default generic network request. That authorization is never persisted or logged.

**Apart from the disclosed TRAE Work CN authorization, never read or recorded anywhere:**

- **Prompts, responses, and conversation bodies**
- **File contents** from your projects
- **Commit messages and diffs** — Git attribution runs `git log` locally, uses the subject line only to detect reverts, and keeps nothing
- **API keys, cookies, and session tokens** belonging to your AI providers are never persisted or logged by TokenTracker

**Recorded locally, never uploaded:**

- **File paths, project names, and repository names.** The Projects view needs to know which repo a session belonged to, so `project.queue.jsonl` stores a project key and git remote URL, and `session.queue.jsonl` stores each session's working directory. Both files stay on your machine — they are never uploaded — and the Projects view is computed entirely locally. Set `TOKENTRACKER_DISABLE_GIT_ATTRIBUTION=1` to stop deriving them at all.

You can verify this in [`src/lib/rollout.js`](../src/lib/rollout.js): every `parse*Incremental` function emits only the queue row shapes described below.

---

## 2. What is stored locally

Everything lives under `~/.tokentracker/` (`%USERPROFILE%\.tokentracker\` on Windows):

| Path | Contents |
|---|---|
| `tracker/queue.jsonl` | Append-only hourly buckets: source, model, token counts, timestamp |
| `tracker/project.queue.jsonl` | The same hourly buckets, split per project: git remote URL and `owner/repo` key. Never uploaded |
| `tracker/session.queue.jsonl` | Per-session token totals and timing for the Sessions view, plus each session's working directory. Never uploaded |
| `tracker/cursors.json` | Read offsets so parsing stays incremental |
| `tracker/config.json` | Your preferences |
| `tracker/*-usage-limits-cache.json` | Last successful quota reading per provider, so a timeout shows stale bars instead of an error |
| `pets/`, `skills/`, `cache/` | Desktop pet assets, skill index, misc caches |

To erase everything TokenTracker knows about you, delete that directory. `tokentracker uninstall` additionally removes the hooks it installed into your AI tools.

---

## 3. Network requests

### 3.1 Enabled by default

| Request | Destination | What is sent | Frequency |
|---|---|---|---|
| **Provider quota reads** | The provider's own API (`api.anthropic.com`, `chatgpt.com`, `cursor.com`, `api.github.com`, `api.kimi.com`, `api.z.ai`, `qoder.com`, `qoder.com.cn`, `openapi.qoder.sh`, `openapi.qoder.com.cn`, `cloudcode-pa.googleapis.com`, …) | Whatever that provider's own endpoint requires, authenticated with the credentials **that provider already stored on your machine**. These requests go directly from your machine to the provider — they never pass through our servers, and we never see the response. | While quota bars are visible |
| **TRAE Work CN usage read** | TRAE's internal API | Transmits the existing sign-in authorization from the locally signed-in TRAE Work CN app to TRAE; reads usage metadata only. TokenTracker never persists or logs the auth token or prompt/response content. | Off unless you set `TOKENTRACKER_TRAE_CN_USAGE=1`; then during eligible non-background sync when local TRAE Work CN auth exists |
| **GitHub star count** | `api.github.com` | Nothing but the request itself (public repo metadata) | On dashboard load |
| **Update check** | `api.github.com` | Nothing but the request itself | Windows: once at launch. macOS: only when you click "Check for Updates" |

### 3.2 Only after you opt in or click something

| Request | Destination | What is sent | Trigger |
|---|---|---|---|
| **Exchange rates** | `open.er-api.com` | Nothing but the request itself | Selecting a non-USD display currency |
| **Desktop pet download** | `codex-pets.net` | The pet id you chose | Importing a pet from a link |
| **Service status page** | Provider status pages (`status.claude.com`, `status.openai.com`, `status.cursor.com`, …) | Nothing but the request itself | Opening the Service Status page |
| **Share card fonts** | `fonts.googleapis.com` | Standard web-font request; Google can see your IP address | Generating a share image |

### 3.3 Never

- No request contains prompt text, responses, file contents, paths, or project names.
- We operate no ad network, no data broker integration, and no cross-site tracking.
- We do not sell, rent, or share your data with third parties.

---

## 4. No cloud account, no sync

This build has no account system, no cloud sync, and no leaderboard. There is nothing to sign in to and nothing to opt out of: your usage data is stored only under `~/.tokentracker/` on your device and never leaves it.

---

## 5. Third parties

| Service | Role | Their policy |
|---|---|---|
| GitHub | Source hosting, releases, star counts | [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement) |
| Google | Fonts on share cards | [policies.google.com/privacy](https://policies.google.com/privacy) |

AI providers whose quota endpoints TokenTracker reads (Anthropic, OpenAI, Cursor, GitHub Copilot, Google, Moonshot, Z.ai, Qoder, …) are governed by their own policies. TokenTracker acts on your behalf with credentials already on your machine; it does not create any new relationship with them.

---

## 6. Turning things off

| Variable | Effect |
|---|---|
| `TOKENTRACKER_DISABLE_GIT_ATTRIBUTION=1` | Stops TokenTracker running `git log` inside your project directories |

---

## 7. Children

TokenTracker is a developer tool and is not directed at children under 13. We do not knowingly collect personal information from children.

## 8. Changes

Material changes to this policy will be noted in the release notes and in the `Last updated` date above. The full history is in [this file's Git log](https://github.com/mohui666/TokenTracker/commits/main/docs/PRIVACY.md).

## 9. Contact

Questions, corrections, or deletion requests: [github.com/mohui666/TokenTracker/issues](https://github.com/mohui666/TokenTracker/issues)
