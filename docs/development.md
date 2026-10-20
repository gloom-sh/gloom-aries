# Development

```sh
bun install
bun run typecheck
bun run test
```

Tests use synthetic fixtures and local mock servers; they never call Aries. CI type-checks and tests against the Gloom revision pinned in `.github/workflows/ci.yml`.
