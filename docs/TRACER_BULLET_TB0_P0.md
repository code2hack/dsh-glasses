# TRACER_BULLET_TB0_P0 — physical input qualification

**Status:** **ELIMINATED from the MVP by code2hack on 2026-08-19.**  
**Base when eliminated:** `97dbec9f759efd4581dbb19c355aa5328f45793b` (D1 merge).

P0 previously planned qualification of physical COMMAND, PRIMARY, SECONDARY,
and head-motion interactions. That qualification is no longer an MVP gate.

For the MVP:

- no human button, touchpad, swipe, hold, or head-motion interaction is required;
- no physical row is claimed qualified;
- no >=3-genuine-PHYSICAL-trials requirement applies;
- no physical-input mapping implementation is required;
- interactive verification is driven through ADB-accessible synthetic debug
  controls and is explicitly non-hardware-qualifying.

Synthetic verification may use `GlassesBridge.debugSemanticControl` and, when
needed for diagnostics, ADB-derived injected input. Every such event remains
`SYNTHETIC_*`; it must never be upgraded into a physical-hardware claim.

The abandoned `tb0/physical-input-qualification` branch preserves the
observation-only P0 tracer work for future investigation. That tooling is not
part of MVP acceptance and is intentionally not merged through this tombstone.
