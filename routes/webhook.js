const express = require("express");
const router = express.Router();
const { generateRepoReport } = require("../services/reportService");
const { Octokit } = require("@octokit/rest");
const { getInstallationAccessToken } = require("../services/githubApp");
const pool = require("../config/db");

const {
  uniqueNamesGenerator,
  adjectives,
  animals,
  NumberDictionary,
} = require("unique-names-generator");

const nameConfig = {
  dictionaries: [adjectives, animals],
  separator: "-",
  style: "lower",
  length: 2,
};

function generateSlug() {
  const name = uniqueNamesGenerator(nameConfig);
  const numConfig = {
    dictionaries: [NumberDictionary.generate({ min: 100, max: 999 })],
  };
  const number = uniqueNamesGenerator(numConfig);
  return `${name}-${number}`;
}

async function createReportShare(reportId) {
  if (!reportId) {
    throw new Error("reportId is required to create share link");
  }

  let slug;
  let attempts = 0;

  while (attempts < 8) {
    slug = generateSlug();
    attempts++;

    const { rows } = await pool.query(
      "SELECT 1 FROM report_shares WHERE slug = $1",
      [slug],
    );
    if (rows.length === 0) break;
  }

  if (attempts >= 8) {
    slug = "vc-" + Math.random().toString(36).substring(2, 12);
  }

  const result = await pool.query(
    `INSERT INTO report_shares (slug, report_id, expires_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '30 days')
     RETURNING slug`,
    [slug, reportId],
  );

  return result.rows[0].slug;
}

// Get existing report
async function getReportByRepo(repoFullName) {
  const result = await pool.query(
    `SELECT * FROM reports WHERE repo_full_name = $1`,
    [repoFullName],
  );
  return result.rows[0] || null;
}

router.post("/github-webhook", async (req, res) => {
  const event = req.headers["x-github-event"];
  const payload = req.body;

  if (
    event === "pull_request" &&
    (payload.action === "opened" || payload.action === "synchronize")
  ) {
    const pr = payload.pull_request;
    const installationId = payload.installation?.id;

    const baseRepoFullName = pr.base.repo.full_name;
    const isFromFork = pr.head.repo.full_name !== pr.base.repo.full_name;

    console.log(`PR #${pr.number} ${payload.action} in ${baseRepoFullName}`);
    if (isFromFork)
      console.log(`→ From fork: ${pr.head.repo.full_name}:${pr.head.ref}`);

    try {
      let report = await getReportByRepo(baseRepoFullName);

      if (!report) {
        console.log(`No existing report found. Generating new one...`);

        // IMPORTANT: generateRepoReport must return the full report with .id
        report = await generateRepoReport({
          owner: pr.base.repo.owner.login,
          repositoryName: pr.base.repo.name,
          installationId,
          headOwner: pr.head.repo.owner.login,
          headRepo: pr.head.repo.name,
          headRef: pr.head.ref,
        });

        if (!report || !report.id) {
          throw new Error(
            "generateRepoReport did not return a valid report with id",
          );
        }
      } else {
        console.log(`Reusing existing report for ${baseRepoFullName}`);
      }

      // Create fresh share link
      const slug = await createReportShare(report.id);
      const shareUrl = `https://vc.opensourcenitj.com/reports/${slug}`;

      const token = await getInstallationAccessToken(installationId);
      const octokit = new Octokit({ auth: token });

      const summary =
        report.status === "passed"
          ? "✅ **All security checks passed!** No secrets or exposed files found."
          : `⚠️ **${report.failedCount || 0} security issue(s) found**\n\n${report.summary || ""}`;

      const commentBody = `## Vibe Caliper Security Report

${summary}

🔗 **View full detailed report:**  
[${shareUrl}](${shareUrl})

---

*Report generated for PR #${pr.number} • Scanning \`${pr.head.ref}\` from ${isFromFork ? "fork" : "branch"}*`;

      await octokit.issues.createComment({
        owner: pr.base.repo.owner.login,
        repo: pr.base.repo.name,
        issue_number: pr.number,
        body: commentBody,
      });

      console.log(`✅ Comment posted on PR #${pr.number} | Slug: ${slug}`);
    } catch (err) {
      console.error("PR bot error:", err);
    }
  }

  res.status(200).send("ok");
});

module.exports = router;
