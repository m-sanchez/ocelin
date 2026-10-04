# Windows resource profile

This measurement uses the released 0.7.0-preview.3 runtime with an instrumented test driver. It is not an untouched-package measurement, a real-provider workload or a hardware compatibility result.

This is a new counter-specific observation, not a before/after performance improvement. The earlier snapshot reported working set and private committed bytes after a different interaction sequence; those numbers cannot be directly compared with this profile's private working set.

The driver creates a disposable copy of `desktop/dist/win-unpacked`. Only `smoke.cjs` inside its `app.asar` is replaced. The original release directory is unchanged. Both archive hashes, the executable hash, the driver hashes and unchanged-file manifests are recorded before launch. The measured copy keeps the release's monitor, library, renderer and resource lifecycle code. Future runs verify all 292 original package files against the recorded public installer payload before launch.

## Reproduce

Use Windows 11 22H2 with the September 2023 cumulative update or newer, Node 22.12 or newer and the repository's installed desktop development dependencies. The recorded host is Windows 11 build 26200. Place the unpacked 0.7.0-preview.3 release at `desktop/dist/win-unpacked`. The harness uses the existing `@electron/asar` dependency; it does not install tools or fetch packages.

```powershell
node scripts/desktop-resource-profile.mjs desktop/dist/win-unpacked --sanity
node scripts/desktop-resource-profile.mjs desktop/dist/win-unpacked
```

`--sanity` runs only 15 scored seconds and cannot pass a 30-minute target. The ordinary command scores at least 1,800 seconds. Output is stored in a new ignored `.ocelin-smoke/resource-profile-*` directory. A failed target is retained as a result; thresholds do not change to fit the observation.

An existing completed sample series can be evaluated again without starting the app:

```powershell
node scripts/desktop-resource-profile.mjs --evaluate .ocelin-smoke/resource-profile-RUN
```

This writes a separate `evaluated-summary.json` with the sample and evaluator hashes, leaving the collection's original summary intact.

| Phase | Duration | Workload |
| --- | --- | --- |
| UI warm-up | At least 20 seconds, unscored | Three completed synthetic sessions, a loaded dashboard and one history-library query. |
| Hidden warm-up | At least 75 seconds, unscored | Hide the dashboard and allow the existing renderer and library idle-release timers to run. Verify that windows are released and the app's RAM sampler is paused. |
| Tray idle | At least 30 minutes, scored | Fixed synthetic sources, closed library UI, no project backend, no visible window, no RAM export and fixture subscription readings. |

The first scored sample starts the 30-minute interval. Preparation, warm-up and shutdown are outside it. Open-UI samples remain in the evidence, but are not a sustained dashboard benchmark.

## Isolation

- App data and both provider homes point to new fixture directories. No existing conversation or account is selected.
- The release's smoke mode disables real subscription requests, desktop-log discovery, update integration, protocol registration, normal app identity repair and native session dispatch.
- Preferences are written only in the disposable app-data directory. The measurement driver never changes startup registration, installs hooks or submits work.
- The driver rejects external opening and registration calls. Its `defaultSession.webRequest` handler blocks Chromium's HTTP, HTTPS and WebSocket requests; background networking is disabled and Chromium's proxy points to an unused loopback destination. Node-side provider isolation comes from fixture subscription mode and empty provider homes. A blocked action or Chromium request fails the driver rather than being counted as successful UI activity.
- The sampler records names, PIDs, process start identities and counters for the measured app's descendants. It does not retain command lines, account information, provider transcripts or unrelated processes.

## Counters and interpretation

The external Windows sampler runs every five seconds. It verifies the root executable before recording its start ticks, then uses PID plus start ticks throughout. Parent chains must have valid start ordering. Previously observed children retain their identity after their parent exits, and an unrelated `Ocelin.exe` is not included by name.

Private working set uses [`PROCESS_MEMORY_COUNTERS_EX2.PrivateWorkingSetSize`](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex2); total working set uses `WorkingSetSize`. [`GetProcessMemoryInfo`](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-getprocessmemoryinfo) accepts the EX2 structure on supported Windows versions. Private committed bytes are a different quantity and are not compared with the resident-memory goal. The memory result compares the maximum sampled sum of private working set with 150 MiB. It does not bound memory between samples.

CPU is accumulated from process CPU-time deltas and divided by elapsed wall time and logical processor count. New observed children contribute their lifetime CPU only when their recorded birth is inside the interval. Counter failures, PID reuse, disappeared observed processes and gaps over 15 seconds are retained and prevent a complete result.

Children created and exited entirely between snapshots are not observed. Consequently CPU is a sampled-process lower bound: an observed result above the 0.5% goal establishes a failure, but a lower result cannot establish that the complete process-tree target passed. Closing that target requires process-lifetime accounting. The external sampler and controller are separate from the measured app tree; their system overhead can still affect the shared machine.

A completed driver, zero app exit status, valid counters and sufficient duration are all required before a memory target can pass. A short or failed run remains inconclusive. Three static synthetic sessions exclude live provider requests, active tasks, large histories, multiple accounts, long-running project backends and representative customer load.

## Recorded run

The 4 October 2026 run scored 09:38:40.599 to 10:08:41.569 UTC on Windows 11 build 26200, an Intel Core Ultra 7 155H with 22 logical processors and 63.46 GiB total RAM. Other work continued on the shared laptop.

| Measure | Observation |
| --- | --- |
| Scored duration / samples | 1,800.970 seconds / 344 |
| Sampled process-tree private working set | 100.60 to 103.91 MiB; maximum below the 150 MiB goal for this fixture |
| Sampled total working set | 292.82 to 296.33 MiB |
| Observed process CPU time | 2.609375 seconds |
| Observed whole-machine CPU percentage | 0.006586%, a lower bound; complete-tree 0.5% target remains inconclusive |
| Counter errors / long gaps / condition failures | 0 / 0 / 0 |
| App exit / blocked Chromium requests / blocked external actions | 0 / 0 / 0 |

The [evaluated summary](evidence/resource-profile-2026-10-04/evaluated-summary.json) and [sample series](evidence/resource-profile-2026-10-04/samples.json) retain the values behind this table. [Collection and evaluation provenance](evidence/resource-profile-2026-10-04/provenance.json) records separate code hashes: collection stayed unchanged while the final evaluator was tightened to require successful execution and keep CPU coverage inconclusive. The original unqualified CPU interpretation was superseded before publication.

The public installer's SHA256 was `ebc2f83d28b7f5f1b4705f0f4b9284585f67160ed8618347c2a49b72026aa028`. Extraction without installation confirmed that all 292 package files matched the original profile package. The [release verification](evidence/resource-profile-2026-10-04/release-payload-verification.json), unchanged [package](evidence/resource-profile-2026-10-04/unchanged-package-manifest.json) and [archive](evidence/resource-profile-2026-10-04/unchanged-archive-manifest.json) manifests, [test-driver delta](evidence/resource-profile-2026-10-04/test-driver.patch) and [evidence hashes](evidence/resource-profile-2026-10-04/SHA256SUMS.txt) make that relationship inspectable.

Validation included the package self-test, 748 repository tests and seven focused counter/result tests after final guard refinements. The historical 65-second snapshot remains in [the preview validation record](OCELIN-0.6-VALIDATION.md). No runtime feature, release version or binary was published by this measurement work. Live-provider load, large libraries, production signing, physical display/sleep coverage and independent usability remain separate work.
