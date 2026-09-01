# Production Release Cut (Happy Path)

Cutting a tag deploys to **QA only**. Production is a separate, manual step.

## 1. Cut the tag

1. Go to **GitHub Actions** in the repository.
2. Select the **Cut release** workflow.
3. Click **Run workflow** (ensure the `main` branch is selected).
4. Wait for it to finish. It computes the next `vYY.MM.SERIAL` tag and pushes it.
5. Check the **Releases** page to verify the auto-generated release notes.

## 2. QA

6. The tag push triggers **Post-merge-deploy**, which runs migrations against
   the QA database and deploys to QA. Monitor the `deploy-qa` job.
7. The job fails unless QA's `/health` reports the version it just deployed, so
   a green job already tells you the right build is live. Confirm anyway:
   ```bash
   curl -s https://fluent-server-qa.azurewebsites.net/health | jq .version
   # Expect the tag without its leading v, e.g. 26.07.1
   ```
8. Hand the tag to QA and wait for sign-off.

## 3. Production

9. Select the **Promote to Production** workflow.
10. Click **Run workflow** and enter the QA-approved tag (e.g. `v26.07.1`).
    Leave **skip_qa_check** unticked.
11. The run stops at the `Production` environment gate. A required reviewer
    approves it. It refuses tags with no successful QA deployment, so if it
    fails at the `validate` job, the tag never reached QA -- fix that rather
    than reaching for the bypass.
12. Monitor `deploy-prod`, then verify:
    ```bash
    curl -s https://fluent-server-prod.azurewebsites.net/health | jq .version
    ```
