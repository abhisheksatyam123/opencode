# Web Surface

This directory is the single home for Web UI implementation code.

## Layout

- `official/` is the unified Web UI. The fork-specific Tasks, Stats, and Notes integrations are implemented here behind ports/adapters (`packages/app/src/surface/*`) and rendered in session tabs (`packages/app/src/pages/session/surface-tabs/*`).
- `notes-ui/` contains the standalone notes renderer assets used by `/notes` and by the integrated Notes tab.

## Boundary (DIP)

- UI components should depend on surface-owned ports and providers, not directly on custom backend endpoints.
- Adapter implementations are responsible for endpoint normalization and cache behavior.
- Server route files and generated asset maps may live under `src/surface/server`, but Web UI rendering and interaction logic should stay under `src/surface/web`.
