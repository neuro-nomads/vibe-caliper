const { createAppAuth } = require("@octokit/auth-app");
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

module.exports = { getInstallationAccessToken };
