const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { generateRepoReport } = require("../services/reportService");

// Get report by repo_full_name (unchanged)
async function getReportByRepo(repoFullName) {
  const result = await pool.query(
    `SELECT 
       id, 
       repo_full_name, 
       owner, 
       repository_name, 
       status, 
       report_data, 
       error_message,
       generated_at,
       created_at,
       updated_at
     FROM reports 
     WHERE repo_full_name = $1`,
    [repoFullName],
  );

  return result.rows[0] || null;
}

// FIXED: More robust getReportBySlug
async function getReportBySlug(slug) {
  try {
    const result = await pool.query(
      `SELECT 
         r.id,
         r.repo_full_name,
         r.owner,
         r.repository_name,
         r.status,
         r.report_data,
         r.generated_at,
         r.created_at,
         r.updated_at,
         rs.slug,
         rs.expires_at
       FROM report_shares rs
       JOIN reports r ON r.id = rs.report_id
       WHERE rs.slug = $1 
         AND (rs.expires_at IS NULL OR rs.expires_at > NOW())`,
      [slug],
    );
    console.log(`DB query for slug ${slug} returned ${result.rowCount} rows`);

    return result.rows[0] || null;
  } catch (error) {
    console.error("Database error in getReportBySlug:", error.message);
    return null;
  }
}

router.get("/reviewSlug/report/share/:slug", async (req, res) => {
  const { slug } = req.params;

  console.log(`Fetching shared report for slug: ${slug}`);

  try {
    const report = await getReportBySlug(slug);

    if (!report) {
      console.log(`Report not found for slug: ${slug}`);
      return res.status(404).json({
        success: false,
        message: "Report not found or link has expired",
      });
    }

    console.log(`Report found for slug: ${slug} (report_id: ${report.id})`);

    res.status(200).json({
      success: true,
      data: {
        id: report.id,
        repo_full_name: report.repo_full_name,
        owner: report.owner,
        repository_name: report.repository_name,
        status: report.status,
        report_data: report.report_data,
        generated_at: report.generated_at,
        created_at: report.created_at,
        slug: report.slug,
      },
    });
  } catch (error) {
    console.error("Error fetching shared report:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

router.post("/generateReport", async (req, res) => {
  console.log("Received body:", req.body);

  const { owner, repositoryName, installationId } = req.body || {};

  if (!owner || !repositoryName) {
    return res.status(400).json({
      success: false,
      message: "owner and repositoryName are required",
      received: req.body,
    });
  }

  const repoFullName = `${owner}/${repositoryName}`;

  try {
    const existingReport = await getReportByRepo(repoFullName);

    if (existingReport) {
      console.log(`Report found for ${repoFullName}, returning existing data`);
      return res.status(200).json({
        success: true,
        message: "Report already exists",
        data: existingReport,
        source: "cache",
      });
    }

    console.log(
      `No report found for ${repoFullName}. Starting background generation...`,
    );

    res.status(202).json({
      success: true,
      message: "Report generation started. It will be available shortly.",
      repoFullName,
    });

    generateRepoReport({
      owner,
      repositoryName,
      installationId,
    }).catch((err) => {
      console.error(`Background error for ${repoFullName}:`, err);
    });
  } catch (error) {
    console.error("Error in /generateReport:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

router.get("/report/:owner/:repositoryName", async (req, res) => {
  const { owner, repositoryName } = req.params;
  const repoFullName = `${owner}/${repositoryName}`;

  try {
    const report = await getReportByRepo(repoFullName);

    if (!report) {
      return res.status(404).json({
        success: false,
        message: "Report not found",
      });
    }

    res.status(200).json({
      success: true,
      data: report,
    });
  } catch (error) {
    console.error("Error fetching report:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

module.exports = router;
