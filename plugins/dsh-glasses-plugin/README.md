# dsh-glasses-plugin (TB0-H0 read-only proof)

Minimal rc.7-compatible out-of-tree DSH plugin implementing the TB0-H0 read
projection (`GET /glasses/v1/bootstrap`, `GET /glasses/v1/stream`, 501 stubs for
draft/actions). Authenticated with a dev bearer credential, scoped only to
`/glasses/v1/*`.

- Session id: runtime env `DSH_GLASSES_TB0_SESSION_ID` (never committed).
- Token: runtime env `DSH_GLASSES_TB0_TOKEN`.
- Loaded through a disposable DSH profile/patch overlay (see TB0 evidence).
