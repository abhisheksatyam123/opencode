# Foundation vendor SDK

`bun run sdk:build` regenerates the web SDK v2 under
`src/surface/web/official/packages/sdk/js/src/v2/gen` from the server OpenAPI
schema.

This `src/foundation/vendor/sdk` tree is intentionally checked in as an
internal compatibility surface. It is not currently a byte-for-byte copy of the
web SDK output: blind-copying the regenerated web SDK into this directory breaks
root typecheck because existing runtime callers still depend on legacy exports
and looser request/response shapes.

When migrating it, update the internal callers and compatibility exports in the
same change, then verify with:

```sh
bun run sdk:build
bun run typecheck
cd src/surface/web/official/packages/sdk/js && bun run typecheck
```
