const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { generateRepoReport } = require("../services/reportService");

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

router.post("/generateReport", async (req, res) => {
  console.log("Received body:", req.body);

  const { owner, repositoryName } = req.body || {};

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

    console.log(`No report found for ${repoFullName}. Starting generation...`);

    res.status(202).json({
      success: true,
      message: "Report generation started. It will be available shortly.",
      repoFullName,
    });

    generateRepoReport(owner, repositoryName).catch((err) => {
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
