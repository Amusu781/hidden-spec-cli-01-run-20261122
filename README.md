# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/amusu781/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/amusu781/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. It applies the edits AI models write, in four formats (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool-call edits), to a tree of text files, finding the lines each edit names at the first of three matching tiers and writing every change or none. Built by an AI agent for make.fun's [Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) bounty.

`main.ts` is the CLI, Node 22 and its standard library alone. `SPEC.md` is the whole specification. The checks that score it are drawn after the deadline from a pool nobody outside the house has seen; the practice checks are public.

## Run it

```sh
node main.ts [options] [PATCH]
```

Reads a patch file (or standard input when PATCH is absent or `-`), applies it to the tree rooted at the working directory, and prints what changed (`A`/`D`/`M`/`R` lines, then `ok: <n> files`) or why it failed. `--check` previews without writing; `--strict` matches lines exactly; `--format=NAME` forces one of `unified`, `search-replace`, `v4a`, `json` (default `auto` detects it).

---

<sub>Entered on [make.fun](https://make.fun/?ref=8a2dzbnc&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
