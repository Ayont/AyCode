/**
 * Public-safe packaged AppShot probe. No private source imports or product hooks.
 * Usage: node appshot-probe.mjs <verified-extracted-package> <evidence-directory>
 * Requires an interactive Windows desktop. A locked/headless session fails closed.
 * The caller MUST verify the release manifest/signature and archive before extraction.
 * This exercises the shipped helper, not the Electron hotkey/composer integration.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

assert.equal(process.platform, 'win32', 'This probe requires native Windows.');
assert.equal(process.argv.length, 4, 'Usage: node appshot-probe.mjs <verified-extracted-package> <evidence-directory>');
const packageRoot = fs.realpathSync(path.resolve(process.argv[2]));
const evidence = path.resolve(process.argv[3]);
const helper = path.join(packageRoot, 'resources', 'app.asar.unpacked', 'dist', 'appshot-windows.ps1');
assert(fs.statSync(helper).isFile(), 'The verified package must contain the shipped AppShot helper.');
fs.mkdirSync(evidence, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "AppShot public proof O'Brien "));
const quote = value => `'${value.replaceAll("'", "''")}'`;
const title = `AppShot synthetic ${randomUUID()}`;
const shotId = `as-${randomUUID()}`;
const shotDir = path.join(temporary, shotId);
const wrongId = `as-${randomUUID()}`;
const wrongDir = path.join(temporary, wrongId);
const selfId = `as-${randomUUID()}`;
const selfDir = path.join(temporary, selfId);
const script = path.join(temporary, 'probe.ps1');
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|SYSTEMROOT|WINDIR|COMSPEC|USERNAME|USERDOMAIN|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\))$/i.test(key)));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// Load the installed helper unchanged. Its check mode compiles its public capture
// class but does not start a keyboard watcher or capture an unrelated window.
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
  if ($foreground -ne $form.Handle -or $foregroundPid -ne $fixturePid) { throw 'Synthetic fixture did not acquire foreground; no capture attempted.' }
  $bounds = New-Object PublicProbeWindow+Rect
  if (-not [PublicProbeWindow]::GetWindowRect($form.Handle, [ref]$bounds)) { throw 'Cannot read synthetic fixture bounds.' }
  [System.Windows.Forms.Application]::DoEvents()
  if (-not [PublicProbeWindow]::IsWindowVisible($form.Handle) -or [PublicProbeWindow]::IsIconic($form.Handle)) { throw 'Synthetic fixture must be visible and not minimized.' }
  $shot = [AyCodeAppShot]::Capture(${quote(shotId)}, ${quote(shotDir)}, 0, $fixturePid)
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
    width = $bounds.Right - $bounds.Left; height = $bounds.Bottom - $bounds.Top
    shot = $shot; pixels = $pixels; wrong = $wrong; self = $self
  } | ConvertTo-Json -Depth 12 -Compress
} finally { $form.Close(); $form.Dispose() }
`;

try {
  fs.writeFileSync(script, '\uFEFF' + body, 'utf8');
  const stdout = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script], {
    // windowsHide:true also hides this process's WinForms window via STARTUPINFO.
    cwd: temporary, env: cleanEnv, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024, windowsHide: false,
  });
  const result = JSON.parse(stdout.trim());
  fs.writeFileSync(path.join(evidence, 'appshot-probe.json'), JSON.stringify(result, null, 2) + '\n');
  assert.equal(result.fixturePid, result.foregroundPid);
  assert.deepEqual(result.shot.problems, []);
  assert.equal(result.shot.text, null);
  assert.equal(result.shot.title, title);
  assert.equal(result.shot.image?.mediaType, 'image/png');
  assert.equal(result.shot.image.width, result.width);
  assert.equal(result.shot.image.height, result.height);
  assert.deepEqual(result.pixels, [[19, 149, 87], [207, 61, 123]], 'The image must show both synthetic colors, not the desktop or a blank frame.');
  assert.equal(path.resolve(result.shot.image.file), path.join(shotDir, 'window.png'));
  const png = fs.readFileSync(result.shot.image.file);
  assert(png.length > 8 && png.length <= 3_500_000);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  for (const rejected of [result.wrong, result.self]) {
    assert.equal(rejected.image, null);
    assert.equal(rejected.text, null);
    assert.deepEqual(rejected.problems, ['no-window']);
  }
  assert(!fs.existsSync(wrongDir), 'A PID mismatch must not write a capture.');
  assert(!fs.existsSync(selfDir), 'The owner exclusion must not write a capture.');
  fs.writeFileSync(path.join(evidence, 'appshot-synthetic.png'), png);
  const proof = {
    status: 'passed', helperSha256: createHash('sha256').update(fs.readFileSync(helper)).digest('hex'),
    imageSha256: createHash('sha256').update(png).digest('hex'),
    checks: ['foreground HWND and PID', 'window-only dimensions', 'two synthetic image colors', 'wrong expected PID rejected', 'owner PID rejected'],
    scope: 'Shipped Windows helper only; no Electron hotkey, composer, real user window or updater test.',
  };
  fs.writeFileSync(path.join(evidence, 'appshot-proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
} catch (error) {
  fs.writeFileSync(path.join(evidence, 'appshot-failure.txt'), String(error?.stack || error) + '\n');
  throw error;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
