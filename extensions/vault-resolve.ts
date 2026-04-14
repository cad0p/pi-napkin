import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Find the .napkin/ config directory for the vault.
 *
 * Resolution order:
 * 1. Walk up from cwd looking for a local project vault (.napkin/)
 * 2. Fall back to the global vault configured in ~/.pi/agent/napkin.json
 */
export function findVaultPath(cwd: string): string | null {
  // Walk up from cwd looking for a local project vault
  let dir = cwd;
  while (dir !== path.dirname(dir)) {
    const napkinDir = path.join(dir, ".napkin");
    if (fs.existsSync(napkinDir)) {
      return napkinDir;
    }
    dir = path.dirname(dir);
  }

  // Fall back to vault configured in ~/.pi/agent/napkin.json
  return getGlobalVaultPath();
}

function getGlobalVaultPath(): string | null {
  const homeDir = os.homedir();
  const configPath = path.join(homeDir, ".pi", "agent", "napkin.json");
  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!raw.vault) return null;

    const vaultPath: string = raw.vault.startsWith("~")
      ? path.join(homeDir, raw.vault.slice(1))
      : path.resolve(raw.vault);

    const napkinDir = path.join(vaultPath, ".napkin");
    if (fs.existsSync(napkinDir)) return napkinDir;
  } catch {
    // invalid config
  }

  return null;
}
