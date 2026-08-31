# Production Emergency Hotfix

If production is broken and there is no pending QA cycle, you must branch directly from the tag currently live in production.

1. Verify the current production tag (e.g. `v26.07.1`):
   ```bash
   curl -s https://fluent-server-prod.azurewebsites.net/health | jq .version
   ```
2. Identify the latest tag for the current month to determine the next serial:
   ```bash
   # Example output: v26.07.1
   git fetch --tags
   git tag -l "v<YY.MM>.*" | sort -V | tail -1
   ```
3. Create a hotfix branch locally from the tag that is live in production:
   ```bash
   # Example: git checkout -b hotfix/26.07.2 v26.07.1
   git checkout -b hotfix/<YY.MM.NEXT> v<YY.MM.CURRENT>
   ```
4. Write and commit the fix directly on this branch.
5. Push the branch and the tag:

   ```bash
   # Example: git push -u origin hotfix/26.07.2
   git push -u origin hotfix/<YY.MM.NEXT>

   # Example: git tag v26.07.2 && git push origin v26.07.2
   git tag v<YY.MM.NEXT>
   git push origin v<YY.MM.NEXT>
   ```

> [!WARNING]
> **Tag format must be exactly `vYY.MM.SERIAL`** (e.g. `v26.07.2`, not `v26.7.2`). The deploy workflow validates this with a strict regex and will reject malformed tags.

6. **The tag push deploys to QA, not production.** Watch the `deploy-qa` job in
   **Post-merge-deploy**. It takes a few minutes and it is what earns the tag
   the QA deployment record that the next step requires -- even in an
   emergency, this is the fast path, not an obstacle.

7. Run **Promote to Production** with the new tag and get the `Production`
   reviewer to approve.

> [!CAUTION]
> **`skip_qa_check` exists only for when the QA deploy itself cannot run** --
> QA is down, or its own deploy is what's broken. It logs a warning naming you,
> and it still requires the production reviewer's approval. If `deploy-qa` is
> merely slow, wait for it. Using the bypass ships code that nothing has run.

> [!IMPORTANT]
> Open a Pull Request from `hotfix/<YY.MM.NEXT>` back to `main` so the fix is recorded in the main line of development and doesn't get lost in future releases.
