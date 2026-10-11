# Public Windows package check

This directory tests AyCode's already-built Windows release files. It contains no
private application source and does not check out the private repository.

`windows-package.yml` is manually dispatched on public `main`. Supply the exact
release ID, X.Y.Z version, private source commit, pipeline ID and SHA-256 of
`SHA256SUMS` from the producing pipeline. The source identity is read from the
signed `release.json`, not inferred from this public repository's commit.

The downloader reads only `Ayont/AyCode`, verifies the Ed25519 publisher signature,
the requested manifest hash and each downloaded file hash/size. Draft access uses
the job's short-lived automatic `GITHUB_TOKEN`. GitHub requires push-level access
even to read drafts: the read-only probe returned HTTP 403. Consequently this one
manually dispatched job requests `contents: write`; the driver itself only sends
GET requests. There is no persistent custom token and no write API in the driver.
A failed request is never a fallback to a newer or published release.
Authentication is stripped before any CDN redirect.

The disposable `windows-2025` runner checks the ZIP and a silent NSIS installation
in a temporary directory. Both must boot the expected version and real engine,
run the packaged PowerShell terminal, close, and start again with a persisted
fixture project. No personal accounts, provider logins or user files are used.
The app and installer receive a small environment allowlist without CI tokens.

From version 7.5.6, the shipped AppShot PowerShell helper must also capture a
synthetic foreground WinForms window with the expected dimensions and colors,
and reject a wrong process ID and the excluded owner process. The helper is
loaded unchanged from the verified package. Its child receives the same
environment allowlist; evidence stays in the disposable runner's temporary folder.
Earlier baselines explicitly report `appShotCapture: false`.

A successful run emits `AYCODE_WINDOWS_PROOF=...` in the log, including the source
identity and exact asset hashes. The run name carries the requested identity.
There are no Actions artifact uploads or caches. Standard hosted runner minutes
for public repositories are covered by GitHub's public-repository policy; this
workflow uses no larger runner and changes no billing settings.

This is **not** proof of an in-app upgrade from an older version, the Electron
AppShot hotkey/composer integration, SmartScreen reputation or Authenticode
signing. Those are separate checks. A skipped or failed job is not native Windows proof.

## Local verification of the public driver

```
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

Download/verification tests run on any supported Node platform. The application
and installer check requires native Windows x64 and deliberately fails elsewhere.
Node is pinned to 22.22.3, Playwright to 1.63.0 and Actions to full commit SHAs.
