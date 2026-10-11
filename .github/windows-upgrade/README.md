# Native Windows in-app upgrade checks

This generic black-box driver uses only already-public signed Windows packages.
It contains no private product source or provider credentials. The native upgrade
checks are prepared; a successful in-app upgrade has **not yet been measured**.
The separate Windows package workflow checks fresh ZIP and NSIS installations.

## Exact release phases

The manually dispatched `windows-upgrade.yml` workflow accepts ten explicit inputs.
The stable/nightly versions, source commits, global pipeline IDs and manifest hashes
are supplied independently, then compared with publisher-signed `release.json`.
The stable release ID is also fixed. Expected identity is never derived from a feed.

| Phase | Stable target | Source constraint | Meaning |
| --- | --- | --- | --- |
| `pre-release-helper` | Exactly 7.4.5 | Independently pinned old stable and new nightly sources | Preliminary updater/helper/relaunch check; never a final 7.4.6 proof |
| `final-release` | Exactly 7.4.6 | Independently pinned stable and nightly sources must also match | Required final upgrade check, including new Windows UI checks |

Both require a normal `7.4.7-nightly.<UTC>.<pipeline-IID>` release. Unknown phases,
other target versions, drafts, invalid signatures, changed hashes and mismatched
sources/pipelines fail. These deliberate release-specific bounds need review for
future release series. The phase and both source commits appear in the run title
and proof. `finalReleaseProof` can only be true for a successful final phase.

## What the native workflow checks

- Download fixed public GitHub/AyCode endpoints without authentication. Redirects
  are restricted to approved HTTPS asset CDNs. Ed25519 signatures, pinned manifests,
  declared sizes and hashes are checked before extraction and checked again before use.
- Start a verified nightly in a new directory whose path contains spaces. HOME,
  USERPROFILE, AppData, LocalAppData, TEMP and application data are all inside a
  fresh fixture. The child environment contains no CI credentials or Node/Electron
  execution overrides. A native Known Folder preflight prevents profile fallback.
- Create a temporary project through the ordinary API and reload the renderer to
  discover it. Verify first-start UI, menu visibility, navigation, draft retention,
  Windows shortcuts and feature disclosure without installing or authenticating
  a provider, sending a message or opening a real vault.
- Use the real application's normal settings, public feeds, signature verifier,
  update download and installation APIs. Require the exact stable channel switch.
  Do not override feeds, version, staged files, installer or relaunch behavior.
- Observe the original process exit and the shipped updater helper launch a new
  process at the exact fixture path with a responding native window. The driver
  does not launch the replacement. Verify the complete installed tree against the
  signed stable ZIP, plus the real helper acknowledgement and successful log marker.
- Only after proving automatic relaunch, close that exact process and perform a
  separately identified controlled cold start. Verify stable version, Windows,
  engine readiness, retained project and fixture contents. Final 7.4.6 also requires
  the new UI checks after this cold start; old 7.4.5 marks only that UI portion as
  not applicable. Both phases still require all updater/payload/persistence checks.

Success emits `AYCODE_WINDOWS_UPGRADE_PROOF` and local runner evidence; it uploads
no profile, package or artifact. Failures remain failures and must be investigated.
The workflow does not publish releases or run automatically on source changes.

## Limits

This is a normal current-nightly-to-stable upgrade, not a historical 7.0.0 binary
upgrade, an existing NSIS installation upgrade, Authenticode/SmartScreen check,
rollback, interrupted-install test or file-lock recovery test. Draft preservation
checks navigation within a session; only project/file persistence is asserted
across the upgrade. No actual provider OAuth or Windows Credential Manager
isolation is claimed.

## Local checks

`npm test` and `node --check prepare.mjs && node --check run.mjs` run without starting
an application. Node 22.22.3, Playwright 1.63.0 and the workflow actions are pinned.
Native success must be established by the exact successful workflow run and proof.
