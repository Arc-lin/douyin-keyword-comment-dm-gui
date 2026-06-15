import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CONFIG, normalizeConfig, resultsToCsv } from "./core.mjs";

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

export class Storage {
  constructor(rootDir, dataDir = path.join(rootDir, "data")) {
    this.rootDir = rootDir;
    this.dataDir = dataDir;
    this.configPath = path.join(this.dataDir, "config.json");
    this.contactedPath = path.join(this.dataDir, "contacted-users.jsonl");
    this.runsDir = path.join(this.dataDir, "runs");
    this.profileDir = path.join(this.dataDir, "browser-profile");
  }

  async initialize() {
    await Promise.all([
      fs.mkdir(this.dataDir, { recursive: true }),
      fs.mkdir(this.runsDir, { recursive: true }),
      fs.mkdir(this.profileDir, { recursive: true })
    ]);
  }

  async readConfig() {
    if (!(await exists(this.configPath))) return { ...DEFAULT_CONFIG };
    try {
      const raw = JSON.parse(await fs.readFile(this.configPath, "utf8"));
      return normalizeConfig({ ...DEFAULT_CONFIG, ...raw });
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  async saveConfig(config) {
    const { keywordList: _keywordList, ...persisted } = config;
    await writeJsonAtomic(this.configPath, normalizeConfig(persisted));
  }

  async loadContactedUsers() {
    const users = new Map();
    if (!(await exists(this.contactedPath))) return users;
    const content = await fs.readFile(this.contactedPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.userId) users.set(item.userId, item);
      } catch {
        // Preserve valid history even if one manually edited line is malformed.
      }
    }
    return users;
  }

  async appendContactedUser(record) {
    await fs.appendFile(this.contactedPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  runLogPath(runId) {
    return path.join(this.runsDir, `${runId}.jsonl`);
  }

  runArtifactsDir(runId) {
    return path.join(this.runsDir, runId);
  }

  async prepareRun(runId) {
    await fs.mkdir(this.runArtifactsDir(runId), { recursive: true });
  }

  async appendRunEvent(runId, event) {
    await fs.appendFile(this.runLogPath(runId), `${JSON.stringify(event)}\n`, "utf8");
  }

  async writeRunResults(runId, results) {
    const artifactDir = this.runArtifactsDir(runId);
    await fs.mkdir(artifactDir, { recursive: true });
    await Promise.all([
      writeJsonAtomic(path.join(artifactDir, "results.json"), results),
      fs.writeFile(path.join(artifactDir, "results.csv"), resultsToCsv(results), "utf8")
    ]);
  }

  async saveScreenshot(runId, page, label) {
    const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80);
    const filePath = path.join(
      this.runArtifactsDir(runId),
      `${Date.now()}-${safeLabel || "error"}.png`
    );
    await page.screenshot({ path: filePath, fullPage: false }).catch(() => {});
    return filePath;
  }
}
