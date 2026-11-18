import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new Error(`Invalid stable version: ${version}`);
  return match.slice(1).map(Number);
}

function resolveVersion(current, requested) {
  const parts = parseVersion(current);
  if (["patch", "minor", "major"].includes(requested)) {
    const index = { major: 0, minor: 1, patch: 2 }[requested];
    parts[index] += 1;
    for (let next = index + 1; next < parts.length; next += 1) parts[next] = 0;
  } else {
    const next = parseVersion(requested);
    for (let index = 0; index < parts.length; index += 1) {
      if (next[index] > parts[index]) return requested;
      if (next[index] < parts[index]) throw new Error(`New version must be greater than ${current}.`);
    }
    throw new Error(`New version must be greater than ${current}.`);
  }
  return parts.join(".");
}

function main() {
  const requested = process.argv[2];
  if (!requested || requested === "--help") {
    console.log("Usage: npm run release -- <patch|minor|major|X.Y.Z>");
    return;
  }
  if (process.argv.length !== 3) {
    throw new Error("Provide exactly one version bump or explicit X.Y.Z version.");
  }

  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const version = resolveVersion(packageJson.version, requested);
  const tag = `v${version}`;

  if (git("status", "--porcelain")) throw new Error("Release requires a clean working tree.");
  if (git("branch", "--show-current") !== "main") throw new Error("Release must run from the main branch.");
  if (git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}") !== "origin/main") {
    throw new Error("Release requires main to track origin/main.");
  }

  console.log("Checking origin/main is up to date...");
  execFileSync("git", ["fetch", "origin"], { stdio: "inherit" });
  if (git("tag", "--list", tag)) throw new Error(`Tag ${tag} already exists.`);
  const [ahead, behind] = git("rev-list", "--left-right", "--count", "HEAD...origin/main").split(/\s+/).map(Number);
  if (ahead !== 0 || behind !== 0) throw new Error("main must match origin/main before releasing.");

  console.log("Running tests and build...");
  execFileSync("npm", ["test"], { stdio: "inherit" });
  execFileSync("npm", ["run", "build"], { stdio: "inherit" });

  console.log(`Updating version to ${version}...`);
  execFileSync("npm", ["version", version, "--no-git-tag-version"], { stdio: "inherit" });
  execFileSync("git", ["add", "package.json", "package-lock.json"], { stdio: "inherit" });
  execFileSync("git", ["commit", "-m", `chore(release): ${tag}`], { stdio: "inherit" });
  execFileSync("git", ["tag", "-a", tag, "-m", `Release ${tag}`], { stdio: "inherit" });

  console.log(`Pushing ${tag} and its version commit...`);
  try {
    execFileSync("git", ["push", "--atomic", "origin", "main", `refs/tags/${tag}`], { stdio: "inherit" });
  } catch (error) {
    console.error(`The local commit and tag remain. Retry with: git push --atomic origin main refs/tags/${tag}`);
    throw error;
  }
  console.log(`Released ${tag}. GitHub Actions will validate it and create the GitHub Release.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
