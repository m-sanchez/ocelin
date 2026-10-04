param([int]$OwnerProcessId, [string]$ExpectedExecutable, [int]$IntervalSeconds = 5)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class ProfileTree {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Entry { public uint size, usage, pid; public IntPtr heap; public uint module, threads, parent; public int priority; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name; }
  [StructLayout(LayoutKind.Sequential)]
  struct Memory { public uint size, faults; public UIntPtr peakWorking, working, peakPaged, paged, peakNonPaged, nonPaged, pagefile, peakPagefile, privateUsage, privateWorking; public ulong sharedCommit; }
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr handle, ref Entry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr handle, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("psapi.dll")] static extern bool GetProcessMemoryInfo(IntPtr process, ref Memory counters, uint size);
  public class Row { public int pid; public string started, name; public long startedAt; public ulong? privateWorkingBytes, workingBytes; public double? cpuSeconds; }
  public class Result { public List<Row> processes = new List<Row>(); public List<string> errors = new List<string>(); }
  static Dictionary<uint, long> owned = new Dictionary<uint, long>();
  public static Result Read(int owner, long expectedStart) {
    var result = new Result(); var entries = new Dictionary<uint, Entry>(); var starts = new Dictionary<uint, long>();
    using (var root = Process.GetProcessById(owner)) { if (root.StartTime.ToUniversalTime().Ticks != expectedStart) throw new Exception("Root process identity changed"); }
    owned[(uint)owner] = expectedStart;
    var handle = CreateToolhelp32Snapshot(2, 0);
    if (handle == new IntPtr(-1)) throw new Exception("Process snapshot unavailable");
    try { var entry = new Entry(); entry.size = (uint)Marshal.SizeOf(typeof(Entry)); if (Process32FirstW(handle, ref entry)) do { entries[entry.pid] = entry; } while (Process32NextW(handle, ref entry)); } finally { CloseHandle(handle); }
    Func<uint, long> start = id => { long value; if (starts.TryGetValue(id, out value)) return value; try { using (var p = Process.GetProcessById((int)id)) { value = p.StartTime.ToUniversalTime().Ticks; } } catch { value = 0; } starts[id] = value; return value; };
    foreach (var entry in entries.Values) {
      var current = entry; var seen = new HashSet<uint>(); var belongs = false;
      while (seen.Add(current.pid)) {
        long known; var currentStart = start(current.pid);
        if (owned.TryGetValue(current.pid, out known) && currentStart == known) { belongs = true; break; }
        Entry parent; if (!entries.TryGetValue(current.parent, out parent)) break;
        var parentStart = start(parent.pid); if (currentStart == 0 || parentStart == 0 || parentStart > currentStart) break;
        current = parent;
      }
      if (!belongs) continue;
      var stamp = start(entry.pid); owned[entry.pid] = stamp;
      var row = new Row { pid = (int)entry.pid, started = stamp.ToString(), startedAt = new DateTimeOffset(new DateTime(stamp, DateTimeKind.Utc)).ToUnixTimeMilliseconds(), name = entry.name };
      try { using (var p = Process.GetProcessById(row.pid)) {
        if (p.StartTime.ToUniversalTime().Ticks != stamp) throw new Exception("Process identity changed");
        row.cpuSeconds = p.TotalProcessorTime.TotalSeconds;
        var memory = new Memory(); memory.size = (uint)Marshal.SizeOf(typeof(Memory));
        if (!GetProcessMemoryInfo(p.Handle, ref memory, memory.size)) throw new Exception("Memory counters unavailable");
        row.privateWorkingBytes = memory.privateWorking.ToUInt64(); row.workingBytes = memory.working.ToUInt64();
      } } catch { result.errors.Add("Counters unavailable for owned process " + row.pid); }
      result.processes.Add(row);
    }
    return result;
  }
}
'@
$profileOwner = Get-Process -Id $OwnerProcessId
if (-not [string]::Equals($profileOwner.MainModule.FileName, $ExpectedExecutable, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected root executable' }
$OwnerStarted = $profileOwner.StartTime.ToUniversalTime().Ticks.ToString()
do {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  try {
    $reading = [ProfileTree]::Read($OwnerProcessId, [long]$OwnerStarted)
    @{ sampledAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); durationMs = $timer.ElapsedMilliseconds; processes = @($reading.processes); errors = @($reading.errors) } | ConvertTo-Json -Depth 4 -Compress | ForEach-Object { [Console]::WriteLine($_) }
  } catch {
    @{ sampledAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); durationMs = $timer.ElapsedMilliseconds; processes = @(); errors = @('Owned process snapshot unavailable') } | ConvertTo-Json -Depth 4 -Compress | ForEach-Object { [Console]::WriteLine($_) }
    break
  }
  Start-Sleep -Seconds $IntervalSeconds
} while (Get-Process -Id $OwnerProcessId -ErrorAction SilentlyContinue)
