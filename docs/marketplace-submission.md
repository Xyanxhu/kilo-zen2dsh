# Marketplace submission — awesome-dsh-plugin

Draft for the PR that lists kilo-zen2dsh in the dsh-market catalog
([awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)).
Format verified against that repo's `contributing.md` (2026-08-29).

## The entry file

Add exactly one file: `data/plugins/Xyanxhu__kilo-zen2dsh.yml`
(filename = `<owner>__<repo>.yml`).

```yaml
url: https://github.com/Xyanxhu/kilo-zen2dsh
name: Xyanxhu/kilo-zen2dsh
category: model
description:
  en: Exposes Kilo Gateway and OpenCode Zen free models to DeepSeek Harness.
  zh: 将 Kilo Gateway 与 OpenCode Zen 免费模型接入 DeepSeek Harness。
```

Notes on the wording (their review rules):

- `description.en` is the only required field; `zh` included for convenience.
- Description states what it does, no superlatives, ends with a period.
  Quoted because it contains a colon; the `''` escapes the apostrophe in YAML.
- Category `model` (registers an LLM provider route); a maintainer may re-file.

## Pre-submission checklist (CI checks these)

- [ ] Repo public on GitHub, pushed, **older than 1 day** with **>= 10 commits**
      (we have 15+ commits; just mind the 1-day age after creating the repo).
- [ ] `dsh.bundle` manifest reachable **from the URL the entry points at**:
      the check reads the `package.json` at the entry URL. The repo ROOT now
      declares `dsh.bundle.patch: ./cordis.patch.yml` plus an npm dependency
      on `@kilo-zen2dsh/dsh-plugin` (current `master`), so the entry points at
      the repository root with no `#` suffix and the npm mapping links.
      History: the first submission pointed at the root but was bounced
      ("root package.json declares no dsh.bundle"), refiled at the
      subpackage, then the root was made installable and the entry moved
      back — root entry wins because it also links the npm package
      (repository-field substring match) and drops the `#plugin` suffix.
- [ ] Add the GitHub topic **`dsh-plugin`** to the repo (repo page → gear next to About).
- [ ] `npm publish --access public` in `packages/plugin` first — npm installs skip
      the build-approval step in the market. The published package's
      `repository` field must point back at the listed repo (already set).
- [ ] Optional: `screenshots.json` next to `packages/plugin/package.json` with
      1-8 image paths (relative, images committed to the repo) for the
      AppStore-style detail view. Without it, the market extracts images from
      the README.

## Steps

```sh
# 1. fork https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
# 2. in the fork:
npm ci
# 3. add data/plugins/Xyanxhu__kilo-zen2dsh.yml with the content above
node scripts/generate-readme.mjs
# 4. commit the YAML + both regenerated READMEs, open the PR
```

## PR title

```
Add Xyanxhu/kilo-zen2dsh (model)
```

## PR body

```markdown
Adds one entry: `data/plugins/Xyanxhu__kilo-zen2dsh.yml`.

**What it does** — registers native DSH `LlmAdapter`s for Kilo Gateway and
OpenCode Zen. Kilo discovery uses `GET /api/gateway/models` without an
Authorization header and completions use `POST /api/gateway/chat/completions`.
Zen keeps a separate `/zen/v1/models` catalog and routes its free models to
Chat Completions or Responses as documented. Each catalog refreshes
independently and has its own disk cache/health snapshot; Zen can be disabled
with `zenEnabled: false`.

**Install source** — published to npm as
[`@kilo-zen2dsh/dsh-plugin`](https://www.npmjs.com/package/@kilo-zen2dsh/dsh-plugin);
its `repository` field points back at the listed repo.

**Manifest** — `packages/plugin/package.json` declares
`dsh.bundle: { patch: "./cordis.patch.yml" }` (adapter-only; the legacy Go
sidecar lives in `legacy/` and is not shipped).

- Repo: https://github.com/Xyanxhu/kilo-zen2dsh
- License: MIT
```
