# Vendored upstream skill package

Everything in this directory except this README is **vendored verbatim** from the
official Kimi release CDN:

```
https://cdn.kimi.com/webbridge/<release>/skills/kimi-webbridge.tar.gz
```

The daemon binary and the browser extension are published by Kimi; this plugin ships
their skill document unchanged so dsh agents drive the same protocol upstream
documents, and so refreshing is a copy rather than a rewrite.

## Do not hand-edit

`SKILL.md` and `references/**` are byte-exact upstream files. `skill/UPSTREAM.json`
records the release, the tarball digest, and a SHA-256 per file; editing any of them
makes `npm run check` fail.

To update:

```bash
npm run fetch-skill                 # vendor the latest release
node scripts/fetch-upstream-skill.mjs --version v2.0.23   # or pin one
node scripts/fetch-upstream-skill.mjs --check             # report upstream drift only
```

## What dsh adds

The plugin registers `SKILL.md` with its YAML frontmatter stripped and a short
`## dsh runtime notes` section appended (see `DSH_RUNTIME_SECTION` in
`lib/index.js`). That section carries only harness-specific deltas — tool names,
the `kimi_webbridge` status anchor, and how `references/` paths resolve — and this
directory is registered as the skill's `resourceBase`, which is what makes those
relative links readable.

## Attribution

Skill text © Kimi / Moonshot AI, redistributed unmodified. The upstream tarball
contains no licence file; the daemon binary and browser extension are distributed by
Kimi from <https://www.kimi.com/products/kimi-webbridge>.
