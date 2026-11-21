# Contributing

## Language

Everything in the repository is written in English: code, comments, CLI output, tests, documentation, commit messages, PR titles and descriptions. The only exception is end-user content inside a preset (Discord channel texts, role and channel names, bot messages configured in the preset), which uses the server's language.

## Commits

We follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/). Messages use the imperative mood and start lowercase:

```
<type>(<scope>): <description>

[optional body]

[optional footer, e.g. BREAKING CHANGE: ...]
```

Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert`.

Scopes match the packages: `setup`, `bot`, `config`, `presets`. Leave the scope out for repo-wide changes.

Examples:

- `feat(bot): add role picker feature`
- `fix(setup): skip channels that already exist in category`
- `docs: describe preset structure`
- `refactor(config)!: rename content field` (the `!` marks a breaking change)

## Branches and pull requests

- `main` is protected; changes land only through pull requests.
- Name branches after the commit type: `feat/role-picker`, `fix/channel-names`, `chore/pr-template`.
- One PR is one logical change. Split large work into several PRs.
- PR titles follow Conventional Commits too; a CI check rejects titles that do not.
- PR descriptions follow `.github/pull_request_template.md`.
- The repository owner reviews and merges.

## Pre-commit hook

`pnpm install` sets up a git pre-commit hook that runs Prettier and oxlint on the staged files. `git commit --no-verify` skips it when needed; CI runs the same checks either way.
