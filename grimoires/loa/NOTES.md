# cycle-001 Notes — BREATH v0.1.0 PurpleAir MVP

## Rollback Plan (Multi-Model Adversarial Review Upgrade)

### Full Rollback

Single-commit revert restores all previous defaults:

```bash
git revert <commit-hash>
```

### Partial Rollback — Disable Tertiary Only

```yaml
# .loa.config.yaml — remove or comment out:
hounfour:
  # flatline_tertiary_model: gemini-2.5-pro
```

Flatline reverts to 2-model mode (Opus + GPT-5.3-codex). No code changes needed.

### Partial Rollback — Revert Secondary to GPT-5.2

```yaml
# .loa.config.yaml
flatline_protocol:
  models:
    secondary: gpt-5.2

red_team:
  models:
    attacker_secondary: gpt-5.2
    defender_secondary: gpt-5.2
```

Also revert in:
- `.claude/defaults/model-config.yaml`: `reviewer` and `reasoning` aliases back to `openai:gpt-5.2`
- `.claude/scripts/gpt-review-api.sh`: `DEFAULT_MODELS` prd/sdd/sprint back to `gpt-5.2`
- `.claude/scripts/flatline-orchestrator.sh`: `get_model_secondary()` default back to `gpt-5.2`

## Decisions

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-26 | Cache: result stored [key: integrit...] | Source: cache |
| 2026-02-26 | Cache: result stored [key: clear-te...] | Source: cache |
| 2026-02-26 | Cache: result stored [key: clear-te...] | Source: cache |
| 2026-02-26 | Cache: result stored [key: stats-te...] | Source: cache |
| 2026-02-26 | Cache: result stored [key: stats-te...] | Source: cache |
| 2026-02-26 | Cache: result stored [key: test-sec...] | Source: cache |
| 2026-02-26 | Cache: result stored [key: test-key...] | Source: cache |
| 2026-02-26 | Cache: PASS [key: test-key...] | Source: cache |
| 2026-02-26 | Cache: PASS [key: test-key...] | Source: cache |
| 2026-02-26 | Cache: result stored [key: integrit...] | Source: cache |
| 2026-02-26 | Cache: result stored [key: clear-te...] | Source: cache |
| 2026-02-26 | Cache: result stored [key: clear-te...] | Source: cache |
| 2026-02-26 | Cache: result stored [key: stats-te...] | Source: cache |
| 2026-02-26 | Cache: result stored [key: stats-te...] | Source: cache |
| 2026-02-26 | Cache: result stored [key: test-sec...] | Source: cache |
| 2026-02-26 | Cache: result stored [key: test-key...] | Source: cache |
| 2026-02-26 | Cache: PASS [key: test-key...] | Source: cache |
| 2026-02-26 | Cache: PASS [key: test-key...] | Source: cache |
## Known Risks

- AQI NowCast algorithm is the highest-risk module. Breakpoint boundary bugs will cause Theatre position update errors. Explicit test coverage mandatory.
- PurpleAir CF correction factor: verify from PurpleAir API docs whether CF=1 is already applied in their API response or must be applied by BREATH.
- EPA AirNow settlement delay: hourly update cadence means Theatres under 4h window will have thin settlement data. Market freeze tier handles this.

## Key Decisions

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-19 | Settlement authority: EPA AirNow NowCast | Clean ground truth equivalent to USGS 'reviewed'. PurpleAir = signal layer. |
| 2026-03-19 | ThingSpeak deferred to Phase 2 | Incentive economics depend on Echelon on-chain settlement (not yet finalized). |
| 2026-03-19 | 3 Theatre templates in MVP | Mirrors TREMOR's strongest patterns. T1/T2/T3 cover binary, paradox-native, and multi-class. |
| 2026-03-19 | OpenAQ deferred to Phase 2 | Corroboration value but not settlement-critical. API key overhead not justified for MVP. |

## Open Questions

- ThingSpeak recruitment incentive mechanics → blocked on Echelon on-chain settlement design (Tobias)
- PurpleAir CF=1 correction factor → verify in API docs before implementing aqi.js
- Sensor tier divergence Theatre threshold (Phase 2) → EPA vs PurpleAir ±30%? ±50%?

## Blockers

None.
