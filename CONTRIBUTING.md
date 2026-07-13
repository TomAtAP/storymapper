# Contributing to Storymapper

Thanks for your interest. This is a small, deliberately-constrained codebase —
please read [ARCHITECTURE.md](ARCHITECTURE.md) first, then keep these rules.

## Running it

```sh
npm install
npm start          # browser UI at http://localhost:8770/
npm test           # full test suite (plain Node, no framework)
```

`npm test` must be green before you open a PR. CI runs it on Node 18, 20 and 22.

## The hard constraints

These are load-bearing. A PR that breaks one will be asked to change:

- **No build step, no bundler, no TypeScript.**
- **No frontend framework and no ES modules in the browser** — classical
  `<script src>` UMD modules on the `window.STORYMAP` namespace only.
- **No HTTP framework** — raw `http.createServer` stays.
- **Edit pure logic in `shared/` only.** `server/core.js` is a re-export shim and
  `frontend/js/core.js` is a symlink to `shared/core.js` — never edit those.
- **No magic numbers.** Configuration values go in a named constants block at the
  top of the module; tests reference the constant.
- **Tests only use `os.tmpdir()`.** Never let a test or script touch a real data
  directory (`.storymap-data` or a user's `--data-dir`).

## Workflow

1. Write the test first (red).
2. Make it green.
3. For any UI change, add or extend an end-to-end test (`tests/test-e2e.js`) —
   isolated module tests prove pieces work in vitro; only the E2E test proves they
   compose.
4. When you fix a bug, add a regression test before the fix.
5. Keep commits focused; describe the behaviour change in the message.

## Reporting bugs / requesting features

Open an issue with steps to reproduce (for bugs) or the problem you're trying to
solve (for features). Because the project is single-user and local-first, please
note your OS, Node version, and whether you hit it via the browser or the MCP
server.

## License

By contributing you agree that your contributions are licensed under the
project's [Apache License 2.0](LICENSE).
