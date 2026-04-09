# Contributing to BREATH

## Development Setup

```bash
# Clone the repository
git clone <repo-url>
cd breath

# No npm install needed — zero production dependencies
# Requires Node.js >= 20

# Run tests
node --test test/breath.test.js
```

## Code Style

- ES modules (`import`/`export`)
- Pure functions preferred — side effects isolated to oracle and construct layers
- JSDoc on all exported functions
- Immutable state: spread copies, never mutate in place
- `Math.trunc()` for AQI (not `Math.round()`) — per EPA specification

## Testing

All changes must include tests. The test suite uses Node.js built-in test runner:

```bash
node --test test/breath.test.js
```

- No live API calls — all oracle responses are mocked
- Breakpoint boundary tests are mandatory for AQI changes
- Theatre state transition tests required for any theatre logic changes

## Pull Request Process

1. Fork the repository
2. Create a feature branch from `main`
3. Write code + tests
4. Ensure all 104+ tests pass
5. Submit a PR with a clear description

## Architecture Constraints

- **Zero dependencies**: Do not add `node_modules`. Use built-in `fetch` only.
- **EPA spec compliance**: AQI breakpoints and NowCast must match EPA documentation exactly.
- **Settlement hierarchy**: EPA AirNow is always ground truth. PurpleAir is signal layer only.
- **Immutable theatres**: Process functions return new objects, never mutate.

## Hardcoded Parameters

Parameters marked `// TBD: empirical calibration needed` are engineering estimates.
If you have empirical data to justify a value, update both the code and the annotation.

## License

By contributing, you agree that your contributions will be licensed under AGPL-3.0.
