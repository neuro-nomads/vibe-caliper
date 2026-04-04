const express = require("express");
const router = express.Router();
const { generateRepoReport } = require("../services/reportService");
const { Octokit } = require("@octokit/rest");
const { getInstallationAccessToken } = require("../services/githubApp");

router.post("/github-webhook", async (req, res) => {
  const event = req.headers["x-github-event"];
  const payload = req.body;

  if (
    event === "pull_request" &&
    (payload.action === "opened" || payload.action === "synchronize")
  ) {
    const pr = payload.pull_request;
    const installationId = payload.installation?.id;

    console.log(`PR #${pr.number} opened in ${pr.base.repo.full_name}`);

    try {
      const report = await generateRepoReport({
        owner: pr.base.repo.owner.login,
        repositoryName: pr.base.repo.name,
        installationId,
        headOwner: pr.head.repo.owner.login,
        headRepo: pr.head.repo.name,
        headRef: pr.head.ref,
      });

      const token = await getInstallationAccessToken(installationId);
      const octokit = new Octokit({ auth: token });

      const summary =
        report.status === "passed"
          ? "✅ **All security checks passed!** No secrets or exposed files found."
          : `⚠️ **${report.failedCount} security issue(s) found**\n\n${report.summary}`;

      await octokit.issues.createComment({
        owner: pr.base.repo.owner.login,
        repo: pr.base.repo.name,
        issue_number: pr.number,
        body: `## Vibe Caliper Security Report\n\n${summary}`,
      });

      console.log(`Comment posted on PR #${pr.number}`);
    } catch (err) {
      console.error("PR bot error:", err);
    }
  }

  res.status(200).send("ok");
});

module.exports = router;
