import { execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { WireguardConfig } from "./types.js";

/** Extract a safe error message from an unknown catch value. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Check if an execSync error's stderr contains a substring. */
function stderrContains(err: unknown, needle: string): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
  return e.stderr?.toString()?.includes(needle) ?? false;
}

/**
 * Scan a directory for WireGuard .conf files.
 * ProtonVPN configs typically follow: proton-<country>-<number>.conf
 */
export function scanConfigs(directory: string): WireguardConfig[] {
  const resolved = directory.replace(/^~/, process.env.HOME ?? "/root");
  if (!existsSync(resolved)) return [];

  return readdirSync(resolved)
    .filter((f) => f.endsWith(".conf"))
    .map((filename) => ({
      path: join(resolved, filename),
      filename,
      country: parseCountryFromFilename(filename),
      assigned: false,
      assignedTo: null,
    }));
}

/**
 * Parse a country code from a ProtonVPN-style filename.
 */
function parseCountryFromFilename(filename: string): string | null {
  const base = filename.replace(/\.conf$/, "");
  const match = base.match(/(?:proton-|wg-)?([a-z]{2})(?:-\d+)?$/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Bring up a WireGuard interface inside a network namespace.
 *
 * This does NOT use wg-quick. Instead it uses the lower-level `wg` and `ip`
 * commands for fine-grained control over what happens inside the namespace.
 */
export function bringUpWireguard(
  namespaceName: string,
  configPath: string,
  interfaceName: string = "wg0",
): void {
  const resolvedConfig = configPath.replace(/^~/, process.env.HOME ?? "/root");

  if (!existsSync(resolvedConfig)) {
    throw new Error(`WireGuard config not found: ${resolvedConfig}`);
  }

  const config = parseWireguardConfig(resolvedConfig);

  // Create the WireGuard interface in the namespace
  try {
    execSync(
      `ip netns exec ${namespaceName} ip link add ${interfaceName} type wireguard`,
      { stdio: "pipe" },
    );
  } catch (err) {
    if (!stderrContains(err, "File exists")) {
      throw new Error(`Failed to create WireGuard interface: ${errMsg(err)}`);
    }
  }

  // Apply the configuration
  try {
    execSync(
      `ip netns exec ${namespaceName} wg setconf ${interfaceName} < ${resolvedConfig}`,
      { stdio: "pipe" },
    );
  } catch (err) {
    // Clean up the interface we just created
    try {
      execSync(
        `ip netns exec ${namespaceName} ip link delete ${interfaceName}`,
        { stdio: "pipe" },
      );
    } catch {
      // Ignore cleanup errors
    }
    throw new Error(`Failed to apply WireGuard config: ${errMsg(err)}`);
  }

  // Assign the tunnel address
  if (config.address) {
    try {
      execSync(
        `ip netns exec ${namespaceName} ip addr add ${config.address} dev ${interfaceName}`,
        { stdio: "pipe" },
      );
    } catch (err) {
      if (!stderrContains(err, "File exists")) {
        throw new Error(`Failed to assign tunnel address: ${errMsg(err)}`);
      }
    }
  }

  // Bring up the interface
  try {
    execSync(`ip netns exec ${namespaceName} ip link set ${interfaceName} up`, {
      stdio: "pipe",
    });
  } catch (err) {
    throw new Error(`Failed to bring up WireGuard interface: ${errMsg(err)}`);
  }

  // Set up routing: default route through WireGuard
  if (config.allowedIPs?.includes("0.0.0.0/0")) {
    try {
      execSync(
        `ip netns exec ${namespaceName} ip route del default 2>/dev/null || true`,
        { stdio: "pipe" },
      );
      execSync(
        `ip netns exec ${namespaceName} ip route add default dev ${interfaceName}`,
        { stdio: "pipe" },
      );
    } catch (err) {
      throw new Error(`Failed to set default route: ${errMsg(err)}`);
    }
  }

  // Configure DNS if specified
  if (config.dns) {
    try {
      const resolvConf = `nameserver ${config.dns}\n`;
      execSync(
        `ip netns exec ${namespaceName} bash -c 'cat > /etc/resolv.conf'`,
        { input: resolvConf, stdio: "pipe" },
      );
    } catch {
      // DNS config is best-effort
    }
  }
}

/**
 * Bring down a WireGuard interface inside a namespace.
 */
export function bringDownWireguard(
  namespaceName: string,
  interfaceName: string = "wg0",
): void {
  try {
    execSync(
      `ip netns exec ${namespaceName} ip link set ${interfaceName} down`,
      { stdio: "pipe" },
    );
    execSync(`ip netns exec ${namespaceName} ip link delete ${interfaceName}`, {
      stdio: "pipe",
    });
  } catch {
    // Interface may already be gone
  }
}

/**
 * Check WireGuard handshake status inside a namespace.
 * Returns true if a recent handshake exists.
 */
export function checkHandshake(
  namespaceName: string,
  interfaceName: string = "wg0",
): boolean {
  try {
    const output = execSync(
      `ip netns exec ${namespaceName} wg show ${interfaceName} latest-handshakes`,
      { encoding: "utf8", stdio: "pipe" },
    ).trim();

    if (!output) return false;

    const parts = output.split(/\s+/);
    if (parts.length < 2) return false;

    const timestamp = parseInt(parts[1], 10);
    if (isNaN(timestamp)) return false;

    // Handshake within the last 3 minutes is considered fresh
    const threeMinutesAgo = Math.floor(Date.now() / 1000) - 180;
    return timestamp > threeMinutesAgo;
  } catch {
    return false;
  }
}

/**
 * Get the current WireGuard status inside a namespace.
 */
export function getWireguardStatus(
  namespaceName: string,
  interfaceName: string = "wg0",
): {
  exists: boolean;
  hasHandshake: boolean;
  peerCount: number;
  transferRx: number;
  transferTx: number;
} {
  try {
    const output = execSync(
      `ip netns exec ${namespaceName} wg show ${interfaceName}`,
      { encoding: "utf8", stdio: "pipe" },
    );

    const hasInterface = output.includes(`${interfaceName}:`);
    const peerMatches = output.match(/peer:/g);
    const peerCount = peerMatches ? peerMatches.length : 0;

    let transferRx = 0;
    let transferTx = 0;
    const rxMatch = output.match(/transfer:\s+(\d+)\s+\d+/);
    const txMatch = output.match(/transfer:\s+\d+\s+(\d+)/);
    if (rxMatch) transferRx = parseInt(rxMatch[1], 10);
    if (txMatch) transferTx = parseInt(txMatch[1], 10);

    return {
      exists: hasInterface,
      hasHandshake: checkHandshake(namespaceName, interfaceName),
      peerCount,
      transferRx,
      transferTx,
    };
  } catch {
    return {
      exists: false,
      hasHandshake: false,
      peerCount: 0,
      transferRx: 0,
      transferTx: 0,
    };
  }
}

/**
 * Parse a minimal WireGuard config file.
 */
function parseWireguardConfig(path: string): {
  address: string | null;
  dns: string | null;
  privateKey: string | null;
  allowedIPs: string[];
  endpoint: string | null;
} {
  const content = readFileSync(path, "utf8");
  const result = {
    address: null as string | null,
    dns: null as string | null,
    privateKey: null as string | null,
    allowedIPs: [] as string[],
    endpoint: null as string | null,
  };

  let inInterface = false;
  let inPeer = false;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "[Interface]") {
      inInterface = true;
      inPeer = false;
      continue;
    }
    if (trimmed === "[Peer]") {
      inInterface = false;
      inPeer = true;
      continue;
    }

    const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (!kvMatch) continue;

    const [, key, value] = kvMatch;
    const normalizedKey = key.toLowerCase();

    if (inInterface) {
      if (normalizedKey === "address") result.address = value.trim();
      if (normalizedKey === "dns") result.dns = value.trim();
      if (normalizedKey === "privatekey") result.privateKey = value.trim();
    }
    if (inPeer) {
      if (normalizedKey === "allowedips") {
        result.allowedIPs = value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      if (normalizedKey === "endpoint") result.endpoint = value.trim();
    }
  }

  return result;
}
