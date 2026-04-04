const pool = require("../config/db");
const simpleGit = require("simple-git");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");
const { getInstallationAccessToken } = require("./githubApp");

async function generateRepoReport(params) {
  const {
    owner,
    repositoryName,
    installationId = null,
    headOwner,
    headRepo,
    headRef,
  } = params;

  const repoFullName = `${owner}/${repositoryName}`;
  const tempDir = path.join(os.tmpdir(), `repo-review-${Date.now()}`);

  try {
    console.log(`Starting report for ${repoFullName}`);

    await fs.mkdir(tempDir, { recursive: true });

    const cloneOwner = headOwner || owner;
    const cloneRepo = headRepo || repositoryName;
    const cloneRef = headRef || "main";

    let repoUrl = `https://github.com/${cloneOwner}/${cloneRepo}.git`;

    if (installationId) {
      const token = await getInstallationAccessToken(installationId);
      repoUrl = `https://x-access-token:${token}@github.com/${cloneOwner}/${cloneRepo}.git`;
      console.log(`Using GitHub App token for ${cloneOwner}/${cloneRepo}`);
    }

    const git = simpleGit({ baseDir: tempDir });

    console.log(`Cloning ${cloneOwner}/${cloneRepo}@${cloneRef} ...`);

    await git.clone(repoUrl, tempDir, [
      "--single-branch",
      "--branch",
      cloneRef,
    ]);

    console.log("Clone successful");

    const analysisResults = await runAnalysisTasks(tempDir);

    const dbStatus =
      analysisResults.status === "passed"
        ? "completed"
        : analysisResults.status;

    await pool.query(
      `INSERT INTO reports 
   (repo_full_name, owner, repository_name, status, report_data, generated_at)
   VALUES ($1, $2, $3, $4, $5, NOW())`,
      [repoFullName, owner, repositoryName, dbStatus, analysisResults],
    );

    console.log(`✅ Report saved for ${repoFullName}`);

    return analysisResults;
  } catch (error) {
    console.error(`❌ Error for ${repoFullName}:`, error.message);
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runAnalysisTasks(repoPath) {
  let issues = [];
  const envPath = path.join(repoPath, ".env");
  const hasEnvFile = await fileExists(envPath);

  issues.push({
    id: "envExposed",
    title: ".env file is committed to the repository",
    severity: hasEnvFile ? "high" : "low",
    status: hasEnvFile ? "failed" : "passed",
    fix: hasEnvFile
      ? "Remove .env from git (add it to .gitignore) and commit .env.example instead."
      : "Good! .env file is not committed.",
    location: ".env",
    description: hasEnvFile
      ? "Exposed environment file can leak secrets."
      : "No exposed .env file detected.",
  });

  const secretPatterns = [
    {
      id: "openaiKey",
      regex: /sk-[a-zA-Z0-9]{48,}/i,
      title: "OpenAI / Anthropic API Key",
    },
    {
      id: "awsAccessKey",
      regex: /AKIA[0-9A-Z]{16}/,
      title: "AWS Access Key ID",
    },
    // {
    //   id: "awsSecret",
    //   regex: /(?i)aws(.{0,20})?['"][0-9a-zA-Z\/+]{40}['"]/,
    //   title: "AWS Secret Access Key",
    // },
    {
      id: "stripeLive",
      regex: /sk_live_[0-9a-zA-Z]{24}/,
      title: "Stripe Live Secret Key",
    },
    {
      id: "githubToken",
      regex: /gh[ps]_[0-9a-zA-Z]{36}/,
      title: "GitHub Personal Access Token",
    },
    {
      id: "googleApiKey",
      regex: /AIza[0-9A-Za-z-_]{35}/,
      title: "Google API Key",
    },
    {
      id: "jwtToken",
      regex: /ey[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/,
      title: "JWT Token",
    },
    {
      id: "slackToken",
      regex: /xox[baprs]-[0-9a-zA-Z]{10,48}/,
      title: "Slack Token",
    },
  ];

  const ignoreDirs = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "coverage",
  ]);
  const ignoreFiles = new Set([
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
  ]);

  const allowedExtensions = new Set([
    ".js",
    ".ts",
    ".jsx",
    ".tsx",
    ".py",
    ".java",
    ".go",
    ".rs",
    ".env",
    ".yml",
    ".yaml",
    ".md",
  ]);

  async function scanDirectory(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(repoPath, fullPath);

      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue;
        await scanDirectory(fullPath);
      } else if (entry.isFile()) {
        const fileName = entry.name.toLowerCase();
        const ext = path.extname(entry.name).toLowerCase();

        if (ignoreFiles.has(fileName)) continue;

        if (allowedExtensions.has(ext) || fileName === ".env") {
          try {
            const content = await fs.readFile(fullPath, "utf8");

            for (const pattern of secretPatterns) {
              if (content.match(pattern.regex)) {
                issues.push({
                  id: pattern.id,
                  title: `${pattern.title} detected`,
                  severity: "critical",
                  status: "failed",
                  fix: "Remove the secret from the code and use environment variables instead.",
                  location: relativePath,
                  snippet:
                    content.match(pattern.regex)[0].length > 60
                      ? content.match(pattern.regex)[0].substring(0, 57) + "..."
                      : content.match(pattern.regex)[0],
                  description: `Hardcoded ${pattern.title} found in source code.`,
                });
              }
            }
          } catch (err) {}
        }
      }
    }
  }

  await scanDirectory(repoPath);

  const failedIssues = issues.filter((i) => i.status === "failed");
  const passedIssues = issues.filter((i) => i.status === "passed");

  const overallStatus = failedIssues.length > 0 ? "failed" : "passed";

  const summary =
    failedIssues.length > 0
      ? `${failedIssues.length} security issue(s) found`
      : "All security checks passed. Repository looks clean!";

  return {
    status: overallStatus,
    summary,
    totalChecks: issues.length,
    failedCount: failedIssues.length,
    passedCount: passedIssues.length,
    issues,
    scannedAt: new Date().toISOString(),
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

module.exports = { generateRepoReport };
