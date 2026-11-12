# Local Media Downloader

Browser-only media downloader for Chromium browsers, developed with AI-agent assistance. **Work in progress, not a finished DownloadHelper replacement.**

[Русское описание](README.ru.md)

## Current implementation

- Manifest V3 extension with a service worker, page observer, offscreen host and worker-based media engine.
- Popup, download manager and settings UI in Russian, with light/dark styles and keyboard-focus handling.
- Direct media, HLS and DASH parsing/resolution, track selection, subtitles and live-stream handling.
- Browser-local OPFS/IndexedDB storage and remuxing with Mediabunny; export through the browser Downloads API.
- Optional site permissions, URL/message validation, network error handling and cancellation.
- Unit tests, integration harnesses, synthetic fixture generators and browser architecture experiments.

Implemented code is not a claim of universal site/format compatibility. Some scenarios are only component-tested. No external companion application is required by the product architecture. FFmpeg/ffprobe are developer-only fixture/verification tools. No DRM decryption, access-control bypass or transcoding is provided.

## Build and unit tests

The current snapshot was checked locally with Node.js 26 and the lockfile dependencies. Dependencies are project-local.

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

The build creates `dist/`. In a **separate test browser profile**, enable Developer mode on the browser extensions page and use **Load unpacked** to select `dist/`. Browser UI acceptance is still incomplete; do not use a personal browser profile for development tests.

## Verification boundary

The publication check passed typecheck, ESLint, **44 unit tests** and the extension build. This publication did not rerun the full browser/integration suite.

Earlier bounded Chrome/Brave component checks exist locally. Native permission consent, Save As/cancel/collisions, interrupted-job reload and native keyboard selection still need interactive acceptance. Full release integration, large-file/performance acceptance, independent review and comparison with the original extension are not complete. No ready release or store publication is claimed.

`npm run test:integration` contains browser/fixture suites and requires prepared synthetic media, developer tools and browser installations. It is not a clean-clone unit-test command. `test:e2e` and `package` currently reference runners that are not yet implemented; they are placeholders, not working release commands. Some experimental/developer scripts contain machine-specific paths and should be reviewed before running. Large-file experiments can consume multiple gigabytes and are not part of the default checks.

## Layout

- `src/`: extension source and media engine.
- `tests/unit/`: unit tests.
- `tests/integration/`: browser, engine and fixture harnesses.
- `fixtures/`: synthetic fixture catalog and loopback server.
- `scripts/`: build and developer tooling.
- `spikes/`: historical isolated architecture experiments, not the product extension.

Browser profiles, cookies, generated media, test output, captured external pages and private agent/task records are excluded from Git. They are not needed to build the extension or run unit tests. The full local acceptance archive is not included in this portfolio snapshot.

## Branch workflow

- `main`: published baseline; currently **pre-release/WIP**, not a stable release.
- `develop`: integration branch for ongoing work.
- `feature/development`: initial working branch, created from `develop`.
- Future `feature/<name>` branches start from `develop` and return through pull requests.
- Create `release/<version>` only when preparing a real release; merge a verified release into `main` and back into `develop`. Use `hotfix/<name>` only for fixes to a released version.

The initial branches intentionally share the same snapshot. Branch names alone do not prove a completed team Git Flow process.

## Dependencies and usage

Mediabunny declares MPL-2.0; the build copies its license into `dist/licenses/`. Dependency license and source-distribution obligations remain applicable. This repository does not add an arbitrary license for the original project code. Complete third-party notices/release packaging remain pending.

Use only media you own or are authorized to download. This is an independent project, not affiliated with Video DownloadHelper.
