const pool = require("../config/db");
const simpleGit = require("simple-git");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");

async function generateRepoReport(owner, repositoryName) {
  const repoFullName = `${owner}/${repositoryName}`;
  const tempDir = path.join(os.tmpdir(), `repo-review-${Date.now()}`);

  try {
    console.log(`Starting report for ${repoFullName}`);

    const repoUrl = `https://github.com/${repoFullName}.git`;
    await fs.mkdir(tempDir, { recursive: true });
    await simpleGit().clone(repoUrl, tempDir);

    const analysisResults = await runAnalysisTasks(tempDir);

    await pool.query(
      `INSERT INTO reports 
       (repo_full_name, owner, repository_name, status, report_data, generated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [repoFullName, owner, repositoryName, "completed", analysisResults],
    );

    console.log(`Report saved successfully for ${repoFullName}`);
  } catch (error) {
    console.error(`Error for ${repoFullName}:`, error);

    await pool.query(
      `INSERT INTO reports 
       (repo_full_name, owner, repository_name, status, error_message, generated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (repo_full_name) 
       DO UPDATE SET status = $4, error_message = $5, updated_at = NOW()`,
      [repoFullName, owner, repositoryName, "failed", error.message],
    );
  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (e) {
      console.error("Cleanup failed:", e);
    }
  }
}

async function runAnalysisTasks(repoPath) {
  const issues = [];

  // 1. Check for exposed .env file
  if (await fileExists(path.join(repoPath, ".env"))) {
    issues.push({
      id: "envExposed",
      title: ".env file is committed to the repository",
      severity: "high",
      fix: "Remove .env from git (add it to .gitignore) and commit .env.example instead.",
      location: ".env",
    });
  }

  // 2. Secret scanning patterns
  const secretPatterns = [
    {
      id: "openaiKey",
      regex: /sk-[a-zA-Z0-9]{48,}/i,
      title: "OpenAI / Anthropic API Key",
    },
    {
      id: "openaiLegacy",
      regex: /sk-[a-zA-Z0-9]{32,}/i,
      title: "Possible OpenAI-style Key",
    },
    {
      id: "awsAccessKey",
      regex: /AKIA[0-9A-Z]{16}/,
      title: "AWS Access Key ID",
    },
    {
      id: "stripeLive",
      regex: /sk_live_[0-9a-zA-Z]{24}/,
      title: "Stripe Live Secret Key",
    },
    {
      id: "stripeTest",
      regex: /sk_test_[0-9a-zA-Z]{24}/,
      title: "Stripe Test Secret Key",
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
    {
      id: "genericApiKey",
      regex:
        /(?:api|secret|key|token|auth)[\s_-]*(?:key|secret|token)?\s*[:=]\s*['"]?[A-Za-z0-9+\/=]{32,64}['"]?/i,
      title: "Generic API Key / Secret",
    },
  ];

  // Improved ignore list - exclude lock files and heavy directories
  const ignoreDirs = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "coverage",
    ".vscode",
    ".idea",
  ]);

  const ignoreFiles = new Set([
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "Cargo.lock",
    "composer.lock",
    "Gemfile.lock",
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
    ".json",
    ".md",
    ".toml",
    ".ini",
    ".cfg",
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

        // Skip lock files completely
        if (ignoreFiles.has(fileName)) {
          continue;
        }

        // Only scan allowed file types
        if (allowedExtensions.has(ext) || fileName === ".env") {
          try {
            const content = await fs.readFile(fullPath, "utf8");

            for (const pattern of secretPatterns) {
              const matches = content.match(pattern.regex);
              if (matches) {
                // Extra safety: skip very short matches in JSON files (common false positives)
                if (ext === ".json" && matches[0].length < 50) {
                  continue;
                }

                issues.push({
                  id: pattern.id,
                  title: `${pattern.title} detected`,
                  severity: "critical",
                  fix: "Remove the secret from the code and use environment variables instead.",
                  location: relativePath,
                  snippet:
                    matches[0].length > 60
                      ? matches[0].substring(0, 57) + "..."
                      : matches[0],
                });
              }
            }
          } catch (err) {
            // Skip binary or unreadable files silently
          }
        }
      }
    }
  }

  await scanDirectory(repoPath);

  return {
    issues,
    summary: `${issues.length} potential security issues found`,
    totalIssues: issues.length,
    criticalCount: issues.filter((i) => i.severity === "critical").length,
    highCount: issues.filter((i) => i.severity === "high").length,
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
