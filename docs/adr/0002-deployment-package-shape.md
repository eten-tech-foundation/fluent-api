# Deployment package: shared node_modules + run-from-package

The deployment package previously carried `node_modules` twice — once for the
API at the package root and a second verbatim copy inside
`App_Data/jobs/continuous/worker/` — roughly doubling a ~177 MB package. The
extraction of that package on a single-core B1 plan was the bulk of the CPU peg
observed during the 2026-10-01 incident.

**Decision:** the WebJob ships only `dist/` + `package.json` + the run scripts.
Node resolves bare specifiers by walking up the directory tree, so
`worker/dist/...` reaches `wwwroot/node_modules` through
`worker → continuous → jobs → App_Data → wwwroot`. Combined with
`WEBSITE_RUN_FROM_PACKAGE=1` (zip mounted directly, no extraction), deploys
become upload + swap instead of upload + extract + swap.

**Consequences:** `wwwroot` is read-only under run-from-package — nothing in the
API or worker may write beneath it (verified: exports stream to R2, no temp
files). A future change that _does_ need local scratch space must use
`/tmp`/`$HOME`, not `wwwroot`. Do not "fix" the WebJob by copying node_modules
back — the upward resolution is the design, and the copy is what made the
package heavy.
