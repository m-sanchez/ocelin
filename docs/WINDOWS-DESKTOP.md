# Ocelin for Windows

Version **0.7.0-preview.3** adds **Return to a conversation** for new installations. It shows local provider availability and a recent session to preview, with separate controls to request opening, browse History, check source/profile settings or skip. After an open request, confirm only when you have checked the destination in the provider. Sending a native URI does not prove that the intended conversation rendered. Existing preferences keep the guide dismissed; reopen it through **Settings > Find a conversation**.

Version 0.7.0-preview.2 starts with a simpler session panel and dashboard. Open **Settings → What you see** to enable counts, allowances, memory, the workspace launcher, account/profile labels or help text individually. **Keep it simple** resets just these display choices; **Show all details** restores them. Other settings are grouped into collapsed sections.

The full project workspace also has **Settings → What you see**, with separate switches for charts, runs/jobs, repository cards, health, activity and advanced navigation. Sessions and attention remain visible. Workspace display choices persist across reopening; the desktop shares them across project workspaces. Standalone browser installations store them in the panel runtime directory. These controls change presentation, not monitoring or notifications.

Version 0.6.8 separates installed, development and test Windows identities. It backs up a legacy `Electron.lnk` only when the shortcut claims Ocelin's installed app ID and points to a verified Ocelin development package. This resolves a shortcut collision that can make Windows use Electron's taskbar icon despite correct window icons. Backups are kept in `%LOCALAPPDATA%\Ocelin\shortcut-backups`. The taskbar widget stays at 0.6.5.

Version 0.6.7 gives Windows a dedicated Ocelin icon file and reapplies window branding when a workspace is shown or restored. Packaged checks compare the workspace's actual small and large Windows icons with the pet artwork, including after reopening. The taskbar widget remains at 0.6.5.

Version 0.6.6 uses Ocelin's own application menu, About dialog and explicit Windows taskbar identity. The app, installer and uninstaller share the pet icon at nine sizes from 16 to 256 pixels. The existing taskbar widget remains at 0.6.5 and needs no new approval for this update.

Ocelin is the new product and mascot identity for Clawdeck. The GitHub repository is now `m-sanchez/ocelin`, with redirects from its former name. The npm package, launcher commands, configuration keys, session stores, and canonical Clawd reference remain compatible.

## Install and run

Version 0.6.5 adds a **Doctor** button to the session panel and dashboard. **Tidy safely** hides inactive sessions older than 30, 90 or 180 days in Ocelin and removes only allowlisted Ocelin workspace caches older than seven days. It preserves original conversations, native sidebars, projects and credentials. **Undo history tidy** restores the most recent batch of hidden sessions; cache deletion is separate and does not free app RAM.

Doctor lists measured app RAM and CPU. **Stop Codex…** or **Stop Claude…** previews the verified app/tool processes and reported running-session count before a separate stop button interrupts them. This affects all accounts in the selected app, not one conversation. Fresh process identity is checked again at execution; inaccessible or changed processes are skipped. **Release Ocelin workspace & index** closes Ocelin's full project window and unloads its library worker while leaving session monitoring and coding apps running.

Taskbar adapter 0.6.5 prioritizes running/attention counts with a second line selected in Settings: **Subscription % left**, **Running sessions by app**, or **App RAM**. Allowance can show each account's lowest general limit, weekly, or five-hour window. Summaries average the remaining percentages across distinct identified accounts per provider, counting duplicate profiles once. Plans have equal weight because comparable quota sizes are unavailable; this is not a token total. `avg` identifies a combined reading and `*` indicates incomplete readings. Missing, stale or reset-expired quotas show unavailable. Account identities and credentials are not shared with the taskbar host. Existing adapter users need to approve the new widget package once; the host executable needs no replacement.

Use the x64 Windows installer from [Releases](https://github.com/m-sanchez/ocelin/releases). The 0.7 preview is unsigned. It installs for the current user and includes Chromium and Node; no system Node installation is needed to run it. Startup at sign-in is off until enabled in settings. Unsigned previews update manually through Releases. Signed builds support optional automatic updates, off by default.

For development, install Node 22.12 or newer, run `npm ci` inside `desktop/`, then `npm start`. `npm run pack` produces an unpacked app; `npm run dist` produces the NSIS installer. The browser core continues to need only Node 20 or newer and no runtime npm dependencies.

## Choose your surfaces

### First return and recovery

Choose Codex or Claude, then **Preview conversation** to inspect the saved request and response. The explicit preview moves keyboard focus to its close control and returns focus when closed. Hidden tasks and subagents are not suggested. **Open in Codex/Claude** requests the saved native route using the provider's current sign-in; Ocelin does not submit a message or start work automatically. **Try another conversation** opens History.

While discovery runs, the guide reports that it is looking for conversations. If none are recent, search History. Unavailable folders direct you to source and account-profile settings. A conversation can remain previewable without its desktop provider installed; native opening stays unavailable. WSL and remote mirrors remain preview-only. For a non-default profile, inspect the source and account labels and the provider's current sign-in before opening; native actions retain their existing path checks.

**Skip** hides the guide persistently without changing source files. **Yes, this is the right conversation** is a user confirmation, not an automatically verified result. The first-return smoke uses synthetic sessions and simulated provider dispatch. It checks the interface and state transitions, not another app's rendering or an independent person's successful return.

### Available surfaces

- **Windows tray:** running and attention counts, a sliding session panel at the right edge, and a menu to reopen windows or quit.
- **Floating bar:** compact session chips or a status tile with running counts and app RAM; move freely or anchor above the Windows taskbar.
- **Dashboard:** active sessions first, collapsible project groups, provider symbols, live app RAM and searchable history; hover to preview a conversation, click to continue in its provider, or use the secondary project dashboard action for feed, trace, worktrees, reviews, cost and delivery views.

All three share one collector and notification owner. Closing a window hides it. Explicit Quit stops Ocelin's monitor and project backend, without stopping Codex or Claude. Ocelin retains a recovery surface when every option is switched off. Display changes clamp saved window positions to an available work area. Relaunching a second instance brings back the dashboard.

**Open workspace** at the top of the panel or dashboard opens the original project interface, including Overview, Activity, Worktrees, Review, Cost and Delivery. Choose a project from the list or use **Choose folder…** when it has no recent session. Each project heading also has a **Workspace** button. The last opened folder is remembered. **All sessions** opens the separate global session list.

Preferences, checkpoints, notification history and acknowledgements live in `%LOCALAPPDATA%\Ocelin`. Provider transcripts stay where their provider wrote them. The monitor saves metadata and file offsets. The separate history index caches titles and bounded first-request text locally; previews read provider history on demand. Saved native task names, session IDs and project paths are local metadata. Uninstall preserves these preferences so reinstalling is reversible.

## Sources and state

### Subscription allowance

Ocelin 0.6.4 shows **percentage remaining** for Codex and Claude at the top of the dashboard and right-edge panel. Each reported five-hour, weekly or model-specific window has its own reset countdown. A five-hour window is shared across conversations using that account. Hover the countdown for the exact local reset time. Expand **Other model allowances** for separate limits such as Codex Spark. Missing windows are not invented; an expired or stale reading is unavailable until refreshed.

**Settings → Account profiles** connects up to eight additional existing local Codex or Claude Code profiles. Choose the provider's configuration folder, such as `.codex-work` or `.claude-work`, containing its sign-in and `sessions` or `projects` directory. Each profile has its own allowance card, name and reported account email. Rename or disconnect it in Settings; disconnecting never deletes provider files or signs out. Profiles sharing an account share its allowance, so percentages are never summed.

Codex profiles use separate `CODEX_HOME` values and app-server clients. Claude profiles read their own `.credentials.json` and use the same token for the usage and identity requests. Ocelin does not copy credentials, initiate login, refresh Claude credentials or change another app's account. Sign in with the provider's own tools first. Temporary environment-token sign-ins, credentials held only in another app's memory, remote hosts and WSL profiles are not automatically connected.

Session rows and history previews distinguish **CLI**, **Desktop**, **IDE**, and other recorded clients from the **source profile** folder. They show account identities when session records provide them. Claude's account-scoped Desktop records and bridge metadata identify saved accounts; Codex Desktop notification records identify accounts observed on that task. A conversation seen under multiple accounts retains them all. These records establish past association, not the current sign-in or the account responsible for every turn. A source folder or current login never assigns ownership to old sessions. Sessions without account evidence show **Account unknown**.

The allowance summary shows combined percentages; expand **Account details** for each connected profile and accounts detected in saved sessions. An account observed in Desktop without accessible sign-in credentials is listed with allowance unavailable. Connecting its existing profile enables a separate usage reading. Codex Desktop discovery reads at most 64 recent log files, initially up to 2 MiB per file, and then follows appended records. Deleted or older logs can leave account attribution unknown. Session and library searches include recorded client and account labels. Native actions retain their existing transcript-path checks and may be unavailable when the owning profile is not the default provider app's home.

The desktop checks every two minutes. Codex uses its signed-in CLI's `account/rateLimits/read` API. Claude reads its existing Claude Code subscription sign-in and makes a read-only request to Anthropic's usage endpoint. Credentials stay in the background process and are never copied into Ocelin's state, UI, logs or taskbar payload. Ocelin does not refresh Claude credentials itself; open Claude Code if its sign-in expires. The source label identifies the sign-in being measured, which can differ from another app signed into a different account.

The original project **Cost** view reads the same sanitized local snapshot while Ocelin desktop runs. API-equivalent cost estimates remain separate from subscription allowance. This integration does not redeem credits, purchase usage or change either subscription. The Claude OAuth usage endpoint is not a public stable API and may change. References: [Codex account API](https://learn.chatgpt.com/docs/app-server#auth-endpoints), [CodexBar's Claude source investigation](https://github.com/steipete/CodexBar/blob/main/docs/claude.md).

### Keep the first screen useful

The **Now** view shows recent running and attention signals, grouped by project. Collapse a project or all projects to scan the list. **History** and **Archived & hidden** use a separate, paginated library. Search titles, first requests, projects and IDs; filter by provider, age or missing folder. A discovered transcript is not a running process.

Hover or keyboard-focus a conversation to preview recent text without opening another screen. Click it to continue in the exact provider task. Codex paginated sessions use the native history API. Known archived Claude tasks are labelled as restoring when opened. Project dashboards and folders remain secondary actions.

Select conversations to preview **Hide in Ocelin**, **Show again**, **Archive in Codex** or **Restore in Codex**. Hiding is local visibility only. Native archive requires the Codex CLI, confirmed completion and validated child-task scope. It preserves original history and frees no disk space. Claude native archive and permanent deletion are not offered.

Under **Settings → Session history**, **Clear older sessions from view** hides finished and stale entries up to that moment. Active work stays visible. New activity brings a session back; **Show older sessions again** restores the view. This does not delete provider conversations or modify their history.

RAM cards show private working set for each app and its recognized child tools. Click a card for process names, PIDs and CPU. Ocelin measures every 12 seconds with one hidden Windows helper; inaccessible or stale measurements stay unavailable. Shared desktop memory is not divided between projects or sessions.

### Taskbar choices

Enable the floating bar, choose **Compact status tile**, then **Above Windows taskbar** for the built-in readout. Drag the mascot to move it; dragging releases the taskbar anchor and remembers its position. Its hide button keeps it hidden across settings changes and restarts. Restore it from the tray's **Toggle floating bar** or Settings. Both layouts remain selectable.

For native Windows hover cards, install the separate [App Tasks development bridge](../desktop/native/README.md) and enable **Native Windows hover cards (experimental)**. This uses Microsoft's public, experimental API and reports whether Windows stores the tasks. Storage is distinct from visible rendering. It needs a supported Windows rollout and package identity.

For a persistent text strip inside the taskbar, enable **Share counts and RAM with the taskbar text strip** and choose **Connect taskbar strip**. Follow the [integration guide](../desktop/integrations/taskbar-widgets/README.md) to install the optional host and review its permissions. This host uses private Windows APIs; Ocelin does not grant its permissions. The animated pet and text form one clickable widget with adapter 0.6.4 and the patched host. Clicking opens the session panel at the right edge of that monitor. Escape, its close button or clicking outside dismisses it; the arrow in the panel opens the full dashboard. Windows or Ocelin reduced-motion settings disable the slide. Only aggregate counts, RAM and the system light/dark theme are shared locally. Both native cards and the strip are selectable.

If a widget update reports **os error 32** or **Installed widget could not be staged for update**, choose **Quit** in Ocelin's tray menu, reopen the installed Ocelin from the Start menu, then review the update again in Taskbar Widgets Settings. An older URI launch could leave Ocelin and its helpers using the widget folder as their working directory, blocking Windows from renaming it. Version 0.6.2 uses stable data directories for the app, provider and URI launch. The host's permission review still applies.

Default discovery reads `%CODEX_HOME%\sessions` (or `~/.codex/sessions`) and `%CLAUDE_CONFIG_DIR%\projects` (or `~/.claude/projects`). Add additional local source folders from Settings. Claude Desktop metadata is joined by `cliSessionId`, not by matching project names. Subagents carry parent identity when present. Codex's optional `session_index.jsonl` supplies native task names.

Live monitoring is bounded to 2,000 recent transcript files per source, selected by modification time from at most 20,000 entries. Settings reports a reached limit. Historical entries older than 30 days are pruned from Ocelin's metadata. Reconciliation runs approximately every 30 seconds; active files are incrementally read on a three-second cycle after the previous cycle finishes. Initial discovery of a large history takes longer. Checkpoints restore the last known state while reconciliation runs. The separate history library includes older and archived conversations, scans up to 100,000 files per source, and returns at most 100 entries per page. Search covers metadata and first requests by default. **Include transcript text** also searches conversation messages and tool results without saving their contents in the index. It reads at most 32 MiB per file in eight-second batches, reports partial scans, and offers **Search remaining transcripts** for further batches.

Add a WSL source by selecting its provider transcript folder under `\\wsl.localhost\<distribution>\...` or `\\wsl$\<distribution>\...`. Use **Add remote Codex mirror** or **Add remote Claude mirror** for a local folder synchronized from another machine. Ocelin reads those folders; synchronization must already be configured. WSL and mirror conversations support monitoring, search and previews. Native reopening and provider archive/restore are disabled for these sources.

The trace view highlights slow turns, inactivity, repeated calls, repeated failures and possible loops. Expand a span for timing, status, arguments and call ID. Preview cards show recent findings, and `ocelin inspect <transcript.jsonl> --provider codex` prints the same diagnostics. Recorded human waits are excluded from slow-turn time and inactivity warnings. These are bounded transcript heuristics, not proof that an agent is stuck.

| Signal | Meaning |
| --- | --- |
| Lifecycle hook | A locally received provider lifecycle event |
| Transcript inference | State inferred from local records; not a provider status API |
| Stale activity | No update for 15 minutes; outcome remains unknown |
| Turn finished | An explicit observed end of a response, not proof an entire task is complete |
| Seen | Acknowledges this signal without changing the agent's execution state |

Late events for an older known turn cannot finish a newer turn. Notification identities and acknowledgements survive restart. Historical events do not generate a notification storm. Quiet mode, provider/project muting, optional completion notices and sound settings apply at the shared notification owner. Windows notification policy also applies.

## Optional hooks

Settings previews the exact hook groups before any write. Applying creates a backup and preserves unrelated hooks and settings. Remove uses the recorded command ownership list and removes only Ocelin handlers. A changed configuration invalidates an older preview. The capture process writes only session ID, cwd, timestamp, turn ID when available and lifecycle state, with bounded input and a short timeout.

Codex stores these in its home `hooks.json`; Claude uses its home `settings.json`. **Codex requires review and trust through `/hooks` before new hooks run.** Existing sessions may need restarting. The app cannot grant hook trust on your behalf. Remove the integrations in Ocelin before uninstalling if you enabled them. Backups are in Ocelin's `hooks` data directory; selective removal is preferable to restoring an entire older provider configuration.

Installed versions inspected during development: Codex CLI 0.153.2, Claude Code 2.1.260, Electron 44.4.1. Transcript formats can change. Diagnostics show source availability and the time of the last actual hook received; merely installing hooks does not imply live coverage.

| Host | Local transcript monitoring | Optional lifecycle coverage | Return navigation |
| --- | --- | --- | --- |
| Codex CLI / native Codex local tasks | Implemented | Session, prompt, tool, permission, stop, interrupt; provider trust required | Exact conversation in the installed provider Desktop app; project feed and folder as secondary actions |
| Claude Code CLI | Implemented | Session, prompt, tool, permission, stop, failure, permission notification | Exact conversation in the installed provider Desktop app; project feed and folder as secondary actions |
| Claude Desktop Code local sessions | Implemented when a local CLI transcript exists | Depends on the host loading the configured hooks; last-received diagnostic is authoritative | Exact conversation in the installed provider Desktop app; project feed and folder as secondary actions |
| WSL transcript folders and local remote mirrors | Read-only monitoring, search and previews | No remote hook installation | Preview only; reopen on the source host |
| Cloud-only sessions without local transcripts | Not included | Not included | Not included |

Exact native task routes are dispatched to the owning Desktop app. Claude's resume route may restore a natively archived task, which is labelled when that metadata is available. Ocelin does not click approval buttons or synthesize keystrokes in either provider. Ctrl Alt O opens the quick panel; notification clicks return to their specific conversation.

## Boundaries and packaging

The desktop package is isolated under `desktop/`; the core server and UI still use built-ins only. Sandboxed renderers have no Node access. IPC validates the window, frame, action and arguments. Folder/project actions resolve known session IDs, rather than accept arbitrary paths from a renderer. Navigation is restricted. The existing backend stays token-gated and bound to `127.0.0.1` with strict Host validation. A selected project starts one owned utility-process backend; no project backends or git polling are started for the global tray/bar monitor.

The monitor and history library use worker threads in the desktop process. A selected project backend uses Electron's bundled Node mode. Hidden windows release their renderers after 30 seconds, and the history worker stops after 60 seconds without requests. RAM sampling stops when no visible surface, RAM-exporting taskbar strip or native task bridge needs it. Ocelin owns only the workers and utility processes it starts and never stops a standalone dashboard. The approved Ocelin art extends the original state/motion implementation; the canonical Clawd reference remains unchanged.

Signed builds support manual update checks and optional automatic downloads from Ocelin's stable GitHub releases. Automatic updates are off by default. The updater requires the configured publisher and verifies each installer with Windows Authenticode; unverifiable signatures fail closed. Unsigned previews use the Releases download link. To produce a signed build, configure the GitHub variable `OCELIN_SIGNING_PUBLISHER` with the full certificate subject beginning `CN=`, the secrets `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`, then dispatch **Windows desktop** with **signed** enabled. The build fails if signing is requested without a publisher or usable certificate. The workflow produces artifacts without publishing a release.

## Validation and preview limits

Automated coverage includes independent providers and sessions, late turn events, partial UTF-8 records, growth with unchanged mtime, truncation/rotation, checkpoint recovery, notification deduplication, privacy filtering, selective hook install/removal and stale previews, all surface combinations, and offscreen placement recovery. Existing HTTP authorization, checkout scoping and Codex feed/trace tests remain required.

Native Windows and packaged-build results are recorded in the [validation notes](OCELIN-0.6-VALIDATION.md). Production signing and an actual signed update round trip require a release certificate. The user confirmed the pet, counts and RAM are visible inside the taskbar, and adapter 0.6.4 opens the right-edge panel with a visible slide. Native Windows App Tasks hover cards remain visually unverified. Direct SSH/cloud transport, reserved-edge AppBar mode and direct approvals remain outside this preview. A complete physical multi-monitor, sleep/lock, and 100/125/150/200% DPI matrix still needs hardware coverage; unit-tested placement recovery is not a substitute for that matrix.

## Sources and attribution

Provider icons come from the official installed Codex Windows app and Anthropic's official Claude Code extension. Their original colors and geometry are preserved, including supplied Codex light/dark variants. [Asset sources and ownership](../desktop/renderer/vendor/ATTRIBUTION.md).

The research and licensed reference extracts are in [Windows research](WINDOWS-DESKTOP-RESEARCH.md) and `research/windows-desktop-2026-09-16/`.

Primary integration references: [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Claude hooks](https://code.claude.com/docs/en/hooks), [Electron utility processes](https://www.electronjs.org/docs/latest/api/utility-process), [Electron security](https://www.electronjs.org/docs/latest/tutorial/security).
