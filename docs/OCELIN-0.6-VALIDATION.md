# Ocelin 0.6 integration preview

## 0.7.0-preview.3 first-return follow-up

All 743 tests, the server self-test and four focused first-return tests passed. Source and packaged Electron smoke checks passed, including keyboard previews for both providers, explicit confirmation after simulated dispatch, History selection, persistent skipping and recovery through Settings. The packaged executable and installer passed branding checks for all nine icon sizes. The packaged evidence is recorded in `.ocelin-smoke/v060-1791101714201/data/proof/report.json`.

The version-matched tour uses synthetic source-build captures from `.ocelin-smoke/v060-1791101325884/data/proof`; [the asset manifest](assets/screenshots.json) records their file hashes. These checks establish interface and state behavior, not external provider rendering or an independent person's successful return. This remains an unsigned experimental preview with manual updates. The signing, hardware, native shell and sustained performance limits below remain open.

## 0.7.0-preview.1 follow-up

The local preview adds deterministic trace diagnostics, expandable tool-span details, the `ocelin inspect` command, opt-in transcript text search, read-only WSL transcript folders and local remote mirrors. It completes the pending account identity and subscription allowance integration. Search runs in bounded batches and reports incomplete coverage; it does not yet meet the research's indexed-search latency target.

The core self-test and all 735 tests pass. Development and packaged Windows desktop smoke verify diagnostic evidence, transcript search beyond the first request, span expansion across polling, account allowances and existing navigation, hooks and history controls. All 28 packaged checks pass. Both the executable and installer pass the branding verifier for all nine icon sizes. A fixture in the installed Ubuntu WSL distribution was discovered and previewed through `\\wsl.localhost`; native dispatch was correctly refused. This does not establish direct SSH or cloud monitoring.

The packaged memory check confirms that tray-only mode releases hidden renderers and stops the RAM sampler. After 65 seconds idle, Electron reported 380.9 MiB of working set and 252.3 MiB of private bytes across its browser, GPU and network processes. This is one post-interaction snapshot, not a sustained private-working-set benchmark. The 150 MiB resident target remains unmet; releasing the worker and sampler is not sufficient evidence for that target.

Signing configuration and a publisher-verified updater are implemented. This local installer is unsigned because no release certificate is configured. Automatic updates remain disabled in unsigned previews; a real signed update round trip remains unverified. Windows App Tasks visual proof, sustained performance targets and the physical monitor/DPI/sleep matrix remain separate acceptance gates. The historical 0.6 evidence below is retained as originally recorded.

This implements the next session-management slice from the [native integration research](OCELIN-NEXT-RESEARCH.md). Desktop 0.6.2 and the optional Taskbar Widgets adapter 0.6.4 are versioned independently. This is a Windows preview, with explicit provider and shell limitations.

## Implemented paths

- **Now:** compact project groups, provider icons, running/attention status and measured app memory. Old discovered records no longer populate the first screen.
- **Peek:** hover or keyboard-focus a conversation to read its latest request, response and recent tools. Codex paginated history uses the installed CLI's native history API. A missing project folder does not block a preview.
- **Continue:** click opens the exact `codex://threads/<id>` or `claude://resume?session=<id>` route. Notification clicks use the same dispatch. Known archived Claude conversations are labelled “restore and open.”
- **History:** independent, paginated library with search by title, first request, project and ID; provider/age/missing-folder filters; explicit selection and reviewed actions. It includes Codex archives and joins Claude Desktop titles/archive metadata.
- **Cleanup:** reversible Ocelin hide/show for both providers, and Codex native archive/restore through app-server. No direct provider database writes or permanent deletion. Native archive refuses active, recently modified or unconfirmed tasks; checks provider-home identity and descendant scope; revalidates the selection before applying.
- **Windows:** registered activation protocol, notification routing, jump-list entry, Ctrl Alt O quick panel, selectable native App Tasks bridge and selectable Taskbar Widgets strip. Adapter 0.6.4 uses `ocelin://panel` to open a panel from the display's right edge through a whole-widget action. The user approved the adapter and confirmed the click and visible slide with the patched 0.5.36 host. Host permission review remains user-controlled.
- **Resources:** the monitor and library share the desktop process through worker threads; hidden windows release their renderers after 30 seconds. Provider API connections close when idle. Shared app memory is not represented as per-session RAM.

## Evidence

- Package self-test passed.
- Full core suite: 694 tests passed. Regression coverage includes mixed parent/child archive ordering, provider-home identity, Windows extended paths and aliases, native activity dates, reconnecting native tasks and installed widgets, and distinguishing native creation from storage and rendering.
- Packaged 0.6.0 desktop smoke passed native URI construction/dispatch, history, keyboard-focus preview, hide/restore through IPC, official icons, project routing/reopening, sign-in startup restoration, settings, sandboxing and 320/420/700-pixel layouts. URI dispatch checks do not prove external provider rendering.
- Installed Codex CLI 0.153.2 successfully archived and restored an isolated fixture through its real API, with no model turn and no real-user history changes.
- Read-only live library probe indexed 884 distinct conversations, including 203 archived/hidden records, and read a paginated Codex preview through the native API. Indexing plus first native preview took about 7 seconds in the final cached probe on this machine; this is not an instant cold-start guarantee.
- The installed dashboard was checked against live activity and measured app memory. A Codex lifecycle hook was received. Existing preferences, source folders and history cutoff survived the installer update; the standalone dashboard stayed running.
- Taskbar Widgets 0.5.36's `twdev validate` accepted the earlier 0.6.0 widget package. Schema validation does not prove Explorer placement or the new whole-widget action.
- Native App Tasks 0.6.0.2 installed successfully through an elevated update on Windows 11 build 26200.9457. `FindAll()` in the packaged helper returned both current tasks, with matching IDs and zero hidden tasks. This confirms Windows task storage. The user still reported no taskbar readout; their screenshot showed only the tray tooltip and floating tile. Native cards have not been visually verified.
- The English Taskbar Widgets host and Ocelin widget 0.6.1 were installed. The user's approval was persisted. Its runtime attached to both taskbars, but Ocelin remained disabled because upstream's stale catalog selected a built-in widget after installation. Enabling the already-approved widget started its live provider; the user confirmed the inside-taskbar readout was visible. The setup patch starts the runtime and waits for the exact widget before enabling it; 14 mocked regressions cover delayed catalogs, failed writes, updates and failures without changing permission approval.
- The user approved adapter 0.6.2 and confirmed its counts and RAM were visible inside the taskbar, but the pet was missing. The installed manifest, enabled configuration and provider state matched the update. Its state animations use the existing Ocelin artwork; reduced-motion preferences select static assets.
- The missing pet was traced to MSIX file virtualization: an independent WMI check found no asset at the logical path emitted by the provider, while the physical package-cache file existed. Adapter 0.6.3 resolves bundled assets to their physical paths before publishing them. An isolated probe using the real redirected assets emitted a path visible through WMI; all seven provider tests passed, including GIF/PNG paths through a directory junction. The user subsequently confirmed the 0.6.3 pet was visible in Explorer.
- The optional 0.5.36 host's `native-primary-action.patch` adds the whole-widget action. CI run 35219044416 passed with the cursor patch, and that host was installed after a controlled Explorer restart. Adapter 0.6.4 passed the actual host validator at 170×44 pixels. The user approved the adapter and confirmed whole-widget activation and the panel's visible slide.
- Earlier packaged 0.6.2 desktop smoke passed. The anchored tile is movable, dragging releases its anchor, and its visible hide button and window close both persist the disabled preference. Hiding it does not reopen a dismissed dashboard; restoring through preferences works. The physical drag gesture has not been verified in this run. The 0.6.2 widget passes the actual host validator at 198×44 pixels, and its GIF exports reproduce identical hashes across three runs.
- A 0.6.2 widget update failed with Windows error 32. A handle scan identified Ocelin and its helpers holding the installed widget directory, inherited from the provider's URI launch. Quitting those processes released rename access. Ocelin now selects its data directory before starting children; the provider uses host data and supplies a stable working directory for URI launches.
- The packaged regression renamed the original launch directory while Ocelin and its helpers remained running. Smoke tests skip protocol registration; before/after registry checks confirmed the installed `ocelin://` association was unchanged. These earlier packaged checks do not cover the new panel behavior.

## Remaining limits

The public Windows App Tasks API is experimental and needs an enabled Windows rollout plus package identity. The local MSIX is an unsigned development package; production signing is separate. The Taskbar Widgets host uses private Windows APIs and is optional. Native shell rendering must not be inferred from schema/protocol checks.

An earlier replacement of the optional host binary after unloading it caused one Explorer crash in `Windows.UI.Xaml.dll` and automatic shell restart. The primary-action host was later installed after a controlled Explorer restart; no second crash has been observed so far. Avoid replacing a host inside a running Explorer session; use a fresh sign-in before loading the replacement. This does not establish general shell stability.

Claude's supported local integration does not expose a general native archive API. Ocelin offers local hiding and native reopening; it does not edit Claude's private descriptors. Agent approvals remain in the owning app. An independent Codex app-server is used for saved history and lifecycle operations, not as a claimed attachment to Desktop's running process.

History previews are bounded, and search covers metadata and first requests rather than complete transcript full-text. The current app remains Electron-based; the research's 150 MiB idle target has not been demonstrated. WSL, remote-only sessions and a full physical multi-monitor/DPI/sleep matrix remain outside this validation.

## Right-edge panel update

The packaged desktop smoke passes cold `ocelin://panel` startup without a dashboard, right-edge placement, Escape/close/outside-focus dismissal, reopening, reduced motion, and operation without a tray icon. The panel waits for its renderer before presentation and keeps its surface offscreen until opening. Cards and controls have additional spacing.

The user approved adapter 0.6.4 and confirmed that clicking the pet or counts opens the panel. Native hook logs record the matching `openOcelin` action. Packaged desktop smoke captures intermediate positions from the right edge to zero over a 360 ms slide, checks reduced motion, and verifies that brief row/action hover stays quiet while deliberate title hover previews. The user confirmed the revised slide is visible. The cursor host passed CI and is installed; its hand cursor still needs a live hover check.
