import { execSync } from "node:child_process";
import type { VpnNamespace } from "./types.js";

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
 * Create a persistent Linux network namespace.
 * Uses `ip netns add`. Idempotent if it already exists.
 */
export function createNamespace(name: string): void {
  try {
    execSync(`ip netns add ${name}`, { stdio: "pipe" });
  } catch (err) {
    if (!stderrContains(err, "File exists")) {
      throw new Error(`Failed to create namespace ${name}: ${errMsg(err)}`);
    }
  }
}

/**
 * Delete a network namespace and all its interfaces.
 */
export function deleteNamespace(name: string): void {
  try {
    const ifaces = listInterfacesInNamespace(name);
    for (const iface of ifaces) {
      if (iface === "lo") continue;
      try {
        execSync(`ip link set ${iface} netns 1 2>/dev/null || true`, {
          stdio: "pipe",
        });
      } catch {
        // Interface may already be gone
      }
    }
    execSync(`ip netns delete ${name}`, { stdio: "pipe" });
  } catch (err) {
    if (!stderrContains(err, "No such file or directory")) {
      throw new Error(`Failed to delete namespace ${name}: ${errMsg(err)}`);
    }
  }
}

/**
 * List interfaces inside a namespace.
 */
export function listInterfacesInNamespace(name: string): string[] {
  try {
    const output = execSync(`ip netns exec ${name} ip -o link show`, {
      encoding: "utf8",
      stdio: "pipe",
    });
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^\d+:\s+(\S+)/);
        return match ? match[1] : null;
      })
      .filter((x): x is string => x !== null);
  } catch {
    return [];
  }
}

/**
 * Set up a veth pair connecting the host to a namespace.
 */
export function createVethPair(namespaceName: string): void {
  const hostIface = `veth-${namespaceName}-host`;
  const nsIface = `veth-${namespaceName}-ns`;

  try {
    execSync(`ip link add ${hostIface} type veth peer name ${nsIface}`, {
      stdio: "pipe",
    });
  } catch (err) {
    if (!stderrContains(err, "File exists")) {
      throw new Error(`Failed to create veth pair: ${errMsg(err)}`);
    }
    return;
  }

  try {
    execSync(`ip link set ${nsIface} netns ${namespaceName}`, {
      stdio: "pipe",
    });
  } catch (err) {
    throw new Error(`Failed to move interface into namespace: ${errMsg(err)}`);
  }

  try {
    execSync(`ip addr add 169.254.1.1/31 dev ${hostIface}`, { stdio: "pipe" });
    execSync(`ip link set ${hostIface} up`, { stdio: "pipe" });
  } catch (err) {
    throw new Error(`Failed to configure host-side veth: ${errMsg(err)}`);
  }

  try {
    execSync(
      `ip netns exec ${namespaceName} ip addr add 169.254.1.0/31 dev ${nsIface}`,
      { stdio: "pipe" },
    );
    execSync(`ip netns exec ${namespaceName} ip link set ${nsIface} up`, {
      stdio: "pipe",
    });
    execSync(`ip netns exec ${namespaceName} ip link set lo up`, {
      stdio: "pipe",
    });
  } catch (err) {
    throw new Error(`Failed to configure namespace-side veth: ${errMsg(err)}`);
  }
}

/**
 * Remove a veth pair (host side; namespace side goes with it).
 */
export function removeVethPair(namespaceName: string): void {
  const hostIface = `veth-${namespaceName}-host`;
  try {
    execSync(`ip link delete ${hostIface}`, { stdio: "pipe" });
  } catch {
    // Already gone
  }
}

/**
 * Get the public IP from inside a namespace by curling an IP service.
 */
export function getPublicIp(namespaceName: string): string | null {
  try {
    const ip = execSync(
      `ip netns exec ${namespaceName} curl -s --max-time 10 https://api.ipify.org`,
      { encoding: "utf8", stdio: "pipe" },
    ).trim();
    return ip || null;
  } catch {
    return null;
  }
}

/**
 * Check if internet is reachable from inside a namespace.
 */
export function checkInternet(namespaceName: string): boolean {
  try {
    execSync(`ip netns exec ${namespaceName} ping -c 1 -W 5 1.1.1.1`, {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize a namespace with a veth pair and default route.
 */
export function initializeNamespace(name: string): void {
  createNamespace(name);
  createVethPair(name);

  try {
    execSync(`ip netns exec ${name} ip route add default via 169.254.1.1`, {
      stdio: "pipe",
    });
  } catch {
    // Route may already exist
  }
}

/**
 * Tear down a namespace completely.
 */
export function destroyNamespace(name: string): void {
  removeVethPair(name);
  deleteNamespace(name);
}
