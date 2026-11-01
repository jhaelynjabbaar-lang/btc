# Agent CI and release workflows (ready to activate)

These two GitHub Actions workflows are the intended `.github/workflows/agent-ci.yml` and
`.github/workflows/agent-release.yml`. They live here because the token that pushed this branch lacks GitHub's
`workflow` scope, so GitHub refuses a push that creates files under `.github/workflows/`.

To activate them, someone with that permission (for example from the GitHub web UI, or a push with a `workflow`-scoped
token) moves them:

```sh
mkdir -p .github/workflows
git mv agent/ci-workflows/agent-ci.yml agent/ci-workflows/agent-release.yml .github/workflows/
git rm agent/ci-workflows/README.md
```

* `agent-ci.yml`: on pull requests touching `agent/`, runs `cargo clippy -D warnings` and `cargo test` on **ubuntu-22.04 and
  windows-latest** (Rust 1.85.1).
* `agent-release.yml`: on a pushed tag `agent-vX.Y.Z` (a tag with a suffix such as `agent-v0.1.0-pre.1` becomes a
  **pre-release**), tests on Linux and Windows, builds `btc-agent.exe` (native MSVC build, static C runtime) and
  `btc-agent-linux-x86_64`, writes `SHA256SUMS.txt` and publishes a GitHub Release. Running it by hand
  (`workflow_dispatch`) only uploads workflow artifacts.

They use only GitHub's own actions (`actions/checkout`, `actions/upload-artifact`, `actions/download-artifact`) and the
preinstalled `gh` CLI; no secrets are needed beyond the automatic `GITHUB_TOKEN`.
