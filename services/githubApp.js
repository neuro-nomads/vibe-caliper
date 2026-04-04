const { createAppAuth } = require("@octokit/auth-app");
const { Octokit } = require("@octokit/rest");
const fs = require("fs").promises;
const path = require("path");

const APP_ID = process.env.GITHUB_APP_ID;
const PRIVATE_KEY_PATH = path.join(
  __dirname,
  "../keys/vibe-caliper.private-key.pem",
);
let privateKey = null;

async function getPrivateKey() {
  if (!privateKey) {
    privateKey = await fs.readFile(PRIVATE_KEY_PATH, "utf8");
  }
  return privateKey;
}

async function getRepoInfo(owner, repo, installationId = null) {
  let octokit;

  if (installationId) {
    const auth = createAppAuth({
      appId: process.env.GITHUB_APP_ID,
      privateKey: await getPrivateKey(),
    });

    const { token } = await auth({
      type: "installation",
      installationId,
    });

    octokit = new Octokit({ auth: token });
  } else {
    octokit = new Octokit();
  }

  const { data } = await octokit.repos.get({
    owner,
    repo,
  });

  return {
    defaultBranch: data.default_branch,
    isPrivate: data.private,
  };
}

async function getInstallationAccessToken(installationId) {
  if (!installationId) {
    throw new Error("installationId is required for private repo access");
  }

  const auth = createAppAuth({
    appId: APP_ID,
    privateKey: await getPrivateKey(),
  });

  const { token } = await auth({
    type: "installation",
    installationId,
  });

  return token;
}

module.exports = { getInstallationAccessToken, getRepoInfo };
