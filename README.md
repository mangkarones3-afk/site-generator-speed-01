# site-generator-speed-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/mangkarones3-afk/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/mangkarones3-afk/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A static site generator that reproduces the reference program makefun-site 1.0.0 byte for byte, built to run as fast as possible. The whole build — file reading, JSON parsing, Markdown and template rendering, and answer serialization — runs inside a native C engine (`engine.node`, an N-API addon) behind a thin `main.ts` loader. The native text scans dispatch at runtime between AVX2, SSE2 and scalar paths; template includes are inlined once at parse time; inline rendering copies plain spans without entering the parser. If the addon cannot load (for example on a non-x86-64 machine), the entry falls back first to a per-case native route and then to a complete pure-JavaScript implementation in `solve.js`, with identical output.

Verified locally on the competition practice set: output identical to the reference on all 3 cases (1,135 of 1,135 output paths, and the end-to-end `answers.json` byte-identical), at roughly 4.2–4.3× the CPU speed of the makefun-site 1.0.0 baseline measured on the same machine.

## Run it

```sh
node main.ts
# reads /input/cases.json and writes /output/answers.json
# outside the sandbox: MAKEFUN_INPUT_DIR=<dir holding cases.json> MAKEFUN_OUTPUT_DIR=<output dir> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=ram1fzcx&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
