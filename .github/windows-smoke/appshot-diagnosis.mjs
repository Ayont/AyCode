// Diagnostic A/B fixture only; this never emits the release-gating Windows proof.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.argv.length, 4);
const packageRoot = fs.realpathSync(path.resolve(process.argv[2]));
const evidence = path.resolve(process.argv[3]);
const helper = path.join(packageRoot, 'resources', 'app.asar.unpacked', 'dist', 'appshot-windows.ps1');
assert(fs.statSync(helper).isFile());
fs.mkdirSync(evidence, { recursive: true });
const quote = value => `'${value.replaceAll("'", "''")}'`;
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|SYSTEMROOT|WINDIR|COMSPEC|USERNAME|USERDOMAIN|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\))$/i.test(key)));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const observations = [];
for (const windowsHide of [true, false]) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "AppShot AB proof O'Brien "));
  const title = `AppShot synthetic ${randomUUID()}`;
  const shotId = `as-${randomUUID()}`, wrongId = `as-${randomUUID()}`, selfId = `as-${randomUUID()}`;
  const shotDir = path.join(temporary, shotId), wrongDir = path.join(temporary, wrongId), selfDir = path.join(temporary, selfId);
  const script = path.join(temporary, 'probe.ps1');
  const body = `
$ErrorActionPreference = 'Stop'
. ${quote(helper)} -Mode check
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PublicProbeWindow {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct StartupInfo {
    public uint cb; public IntPtr reserved, desktop, title;
    public uint x, y, width, height, charsX, charsY, fill, flags;
    public ushort showWindow, reservedBytes; public IntPtr reservedData, stdIn, stdOut, stdErr;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetStartupInfoW")]
  public static extern void GetStartupInfo(out StartupInfo info);
  public static bool StartupLayoutValid() {
    return IntPtr.Size == 8 && Marshal.SizeOf(typeof(StartupInfo)) == 104 &&
      Marshal.OffsetOf(typeof(StartupInfo), "flags").ToInt32() == 60 &&
      Marshal.OffsetOf(typeof(StartupInfo), "showWindow").ToInt32() == 64;
  }
}
'@
$form = New-Object System.Windows.Forms.Form
$form.Text = ${quote(title)}
$form.ClientSize = New-Object System.Drawing.Size(560, 320)
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedSingle
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(19, 149, 87)
$right = New-Object System.Windows.Forms.Panel
$right.Dock = [System.Windows.Forms.DockStyle]::Right
$right.Width = 280
$right.BackColor = [System.Drawing.Color]::FromArgb(207, 61, 123)
$form.Controls.Add($right)
try {
  $form.Show()
  $form.Activate()
  [void][PublicProbeWindow]::SetForegroundWindow($form.Handle)
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    [System.Windows.Forms.Application]::DoEvents()
    if ([PublicProbeWindow]::GetForegroundWindow() -eq $form.Handle) { break }
    Start-Sleep -Milliseconds 50
  }
  $foreground = [PublicProbeWindow]::GetForegroundWindow()
  [uint32]$foregroundPid = 0
  [void][PublicProbeWindow]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
  $fixturePid = [System.Diagnostics.Process]::GetCurrentProcess().Id
  $initialForegroundMatches = $foreground -eq $form.Handle -and $foregroundPid -eq $fixturePid
  $bounds = New-Object PublicProbeWindow+Rect
  if (-not [PublicProbeWindow]::GetWindowRect($form.Handle, [ref]$bounds)) { throw 'Cannot read synthetic fixture bounds.' }
  [System.Windows.Forms.Application]::DoEvents()
  if (-not [PublicProbeWindow]::StartupLayoutValid()) { throw 'Unexpected native startup layout.' }
  $startup = New-Object PublicProbeWindow+StartupInfo
  [PublicProbeWindow]::GetStartupInfo([ref]$startup)
  $beforeForeground = [PublicProbeWindow]::GetForegroundWindow()
  [uint32]$beforePid = 0
  [void][PublicProbeWindow]::GetWindowThreadProcessId($beforeForeground, [ref]$beforePid)
  $before = @{
    handle = $form.Handle.ToInt64(); foregroundHandle = $beforeForeground.ToInt64()
    visible = [PublicProbeWindow]::IsWindowVisible($form.Handle)
    iconic = [PublicProbeWindow]::IsIconic($form.Handle)
    foregroundMatches = $beforeForeground -eq $form.Handle; foregroundPid = $beforePid
  }
  $shot = [AyCodeAppShot]::Capture(${quote(shotId)}, ${quote(shotDir)}, 0, $fixturePid)
  $after = @{
    visible = [PublicProbeWindow]::IsWindowVisible($form.Handle)
    iconic = [PublicProbeWindow]::IsIconic($form.Handle)
    foregroundMatches = [PublicProbeWindow]::GetForegroundWindow() -eq $form.Handle
  }
  $pixels = @()
  if ($shot.image) {
    $bitmap = [System.Drawing.Bitmap]::FromFile($shot.image.file)
    try {
      foreach ($fraction in @(0.25, 0.75)) {
        $pixel = $bitmap.GetPixel([int]($bitmap.Width * $fraction), [int]($bitmap.Height * 0.5))
        $pixels += ,@([int]$pixel.R, [int]$pixel.G, [int]$pixel.B)
      }
    } finally { $bitmap.Dispose() }
  }
  # A different expected process must not receive an image, even with a valid folder.
  $wrong = [AyCodeAppShot]::Capture(${quote(wrongId)}, ${quote(wrongDir)}, 0, ($fixturePid + 1))
  $self = [AyCodeAppShot]::Capture(${quote(selfId)}, ${quote(selfDir)}, $fixturePid, $fixturePid)
  @{
    fixturePid = $fixturePid; foregroundPid = $foregroundPid
    initialForegroundMatches = $initialForegroundMatches; before = $before; after = $after
    startup = @{ flags = $startup.flags; showWindow = $startup.showWindow }
    width = $bounds.Right - $bounds.Left; height = $bounds.Bottom - $bounds.Top
    shot = $shot; pixels = $pixels; wrong = $wrong; self = $self
  } | ConvertTo-Json -Depth 12 -Compress
} finally { $form.Close(); $form.Dispose() }
`;
  try {
    fs.writeFileSync(script, '\uFEFF' + body, 'utf8');
    const stdout = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script], {
      cwd: temporary, env: cleanEnv, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024, windowsHide,
    });
    const result = JSON.parse(stdout.trim());
    const observation = { windowsHide, fixturePid: result.fixturePid, initialForegroundMatches: result.initialForegroundMatches,
      startup: result.startup, before: result.before, after: result.after,
      shot: { problems: result.shot.problems, image: Boolean(result.shot.image),
        hasAppName: Object.hasOwn(result.shot, 'appName'), hasTitle: Object.hasOwn(result.shot, 'title'),
        syntheticTitleMatches: result.shot.title === title, timings: result.shot.timings },
      wrongPid: result.wrong.problems, ownerPid: result.self.problems, positiveAssertions: false };
    // Only fixture flags/PIDs are logged. No desktop titles, paths, profiles or image bytes.
    console.log(`AYCODE_APPSHOT_VISIBILITY=${JSON.stringify(observation)}`);
    for (const rejected of [result.wrong, result.self]) {
      assert.equal(rejected.image, null);
      assert.equal(rejected.text, null);
      assert.deepEqual(rejected.problems, ['no-window']);
    }
    assert(!fs.existsSync(wrongDir));
    assert(!fs.existsSync(selfDir));
    if (result.shot.image) {
      assert.deepEqual(result.shot.problems, []);
      assert.equal(result.shot.text, null);
      assert.equal(result.shot.title, title);
      assert.equal(result.shot.image.mediaType, 'image/png');
      assert.equal(result.shot.image.width, result.width);
      assert.equal(result.shot.image.height, result.height);
      assert.deepEqual(result.pixels, [[19, 149, 87], [207, 61, 123]]);
      assert.equal(path.resolve(result.shot.image.file), path.join(shotDir, 'window.png'));
      const png = fs.readFileSync(result.shot.image.file);
      assert(png.length > 8 && png.length <= 3_500_000);
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      observation.positiveAssertions = true;
    }
    observations.push(observation);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
const result = { status: 'diagnostic-only', observations };
fs.writeFileSync(path.join(evidence, 'visibility-ab.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`AYCODE_APPSHOT_AB_DIAGNOSTIC=${JSON.stringify(result)}`);
