# Contributing to Hive

Development, issues, pull requests, and releases are maintained in `tt-a1i/hive`.
The default branch includes unreleased work; use npm for the latest release.

## Before you file something

- **Bug?** Open a [bug report](.github/ISSUE_TEMPLATE/bug_report.yml).
  Search existing issues first.
- **Feature idea?** Open a
  [feature request](.github/ISSUE_TEMPLATE/feature_request.yml). For larger
  ideas, please align on scope in an issue before writing a PR.
- **Security issue?** See [SECURITY.md](./SECURITY.md). Please do not file a
  public issue for security reports.

## Development setup

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Dev mode runs the runtime on `127.0.0.1:4010` and Vite on `127.0.0.1:5180`.
See the **Development** section of [README.md](./README.md) for a
production-style local run. Node.js `^22.18.0 || >=24.0.0` is required (see `package.json`).

## Before you open a PR

```bash
pnpm check    # Biome lint + format
pnpm build    # TypeScript build + Vite web build
```

Run tests for the affected core behavior. Follow the risk gates in [AGENTS.md](AGENTS.md):
UI-only changes use static checks and browser/device verification; shared runtime,
protocol, schema, security, or packaging changes require the corresponding integration
checks and, for broad changes, the full suite. CI selects checks by changed paths;
the nightly/manual workflow runs the extended platform matrix.

Gateway changes also need `pnpm -C gateway exec tsc --noEmit` and
`pnpm -C gateway test` after installing its dependencies. See
[the deployment runbook](docs/deploy-runbook.md) for self-hosting.

## PR style

- Keep commits focused: one logical change per commit, imperative subjects
  (`fix worker card spacing on long names`), no trailing period.
- Squash review fixups before merge.
- PR body: 1–2 sentences on the why, plus testing notes if non-obvious.

## Test discipline

The full rules live in [AGENTS.md §3](./AGENTS.md). Two hard rules worth
calling out:

1. **Integration tests under `tests/server/*` and `tests/cli/*` may not mock
   `node-pty`.** Use the real PTY through `tests/helpers/`. Pure logic tests
   go under `tests/unit/`.
2. **Every assertion must fail if the production code is implemented
   backwards.** Patterns like `expect(x).not.toThrow()` chains,
   tautological array checks, and assertions on self-fed mocks count as
   fake tests and will be removed during review.

## Code style

- TypeScript everywhere. Avoid `any` unless documented.
- Let `pnpm check` (Biome) decide formatting; do not hand-format.
- Prefer editing existing files over creating new ones.
- Add a comment only when the *why* is non-obvious. Don't restate what the
  code already says.

## License

By contributing you agree your contributions will be licensed under the
project's [Business Source License 1.1](./LICENSE.BSL), as described in [LICENSE](./LICENSE).
