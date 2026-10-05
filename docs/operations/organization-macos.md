# Organization app on an Apple Silicon Mac

The organization fork builds an unsigned Apple Silicon app from the
`organization/v2` branch. The VM hosts the organization server and its provider
sessions; the Mac app connects to that environment. Installing the app does not
move the VM's provider credentials or sessions onto your Mac.

## Download the app

1. Open the fork's [Organization Mac app workflow](https://github.com/Sami-Mannila/t3code/actions/workflows/organization-macos.yml).
2. Choose the successful run for the commit you want. Each push to
   `organization/v2` starts a build; **Run workflow** can rebuild that branch.
3. Download `organization-macos-arm64-<commit>` from the run's artifacts. Extract
   the artifact, then its app ZIP, and move the app to Applications.
4. This personal build is unsigned and not notarized. If macOS blocks opening it,
   use **System Settings → Privacy & Security → Open Anyway** after verifying
   that you downloaded your fork's expected commit.
5. Connect through Tailscale to `https://agent-sami.tailfcd410.ts.net` using the
   app's remote environment connection flow. If pairing is required, generate
   the pairing link privately on the VM; never put it in this repository. Select
   the organization project and its named Chief of Staff thread. The Mac app and
   VM server must both run this fork's matching V2 build.

The workflow produces downloadable artifacts only. It does not publish a release,
use signing secrets, or replace an installed app automatically. Fork versions
`0.0.46-preview.org20261005.<run>` are branded **T3 Organization** and contain no
upstream update feed, so an upstream release cannot replace this build. Artifacts expire
in 14 days; retain the downloaded ZIP if needed.

## Build locally

On an Apple Silicon Mac with Node 24, Vite+, and Rust installed:

```sh
git clone --branch organization/v2 https://github.com/Sami-Mannila/t3code.git
cd t3code
vp install --frozen-lockfile
rustup target add aarch64-apple-darwin
vp run dist:desktop:artifact --platform mac --target zip --arch arm64 --build-version 0.0.46-preview.org20261005 --output-dir release/organization-macos
```

The build uses macOS native tools and cannot produce the complete Mac artifact
on the Linux VM. GitHub's standard `macos-15` runner supplies Apple Silicon;
the workflow verifies its architecture before building. See the
[GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
