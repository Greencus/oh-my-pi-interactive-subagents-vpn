import type { VpnNamespace, WireguardConfig } from "./types.js";
import { execSync } from "node:child_process";
import {
  bringUpWireguard,
  bringDownWireguard,
  checkHandshake,
  getWireguardStatus,
} from "./wireguard.js";
import { getPublicIp, checkInternet } from "./namespace.js";

/** Extract a safe error message from an unknown catch value. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type RotationState =
  | "idle"
  | "selecting"
  | "establishing"
  | "verifying"
  | "switching"
  | "cleaning-up";

/**
 * Safely sleep inside a try/catch context.
 */
function safeSleep(seconds: number): void {
  try {
    execSync(`sleep ${seconds}`, { stdio: "pipe" });
  } catch {
    // Ignore sleep failures
  }
}

/**
 * Check how many active HTTPS connections exist in a namespace.
 * Returns the count of established TCP connections to port 443.
 */
function countActiveApiConnections(namespaceName: string): number {
  try {
    const conns = execSync(
      `ip netns exec ${namespaceName} ss -tn state established 2>/dev/null | tail -n +2 || true`,
      { encoding: "utf8", stdio: "pipe" },
    ).trim();

    if (!conns) return 0;

    return conns.split("\n").filter((line) => line.includes(":443")).length;
  } catch {
    return 0;
  }
}

/**
 * Wait for an agent to become idle (no active HTTPS connections).
 * Returns true if the agent is idle, false if timed out.
 */
export function waitForAgentIdle(
  namespaceName: string,
  _agentId: string,
  timeoutMs: number = 30_000,
): boolean {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (countActiveApiConnections(namespaceName) === 0) {
      return true;
    }
    safeSleep(1);
  }

  return false;
}

/**
 * Drain active connections in a namespace — wait for all TCP connections
 * to API endpoints (port 443) to close gracefully.
 */
export function drainConnections(
  namespaceName: string,
  timeoutMs: number = 15_000,
): boolean {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (countActiveApiConnections(namespaceName) === 0) {
      return true;
    }
    safeSleep(1);
  }

  return false;
}

/**
 * Attempt to rotate a namespace's WireGuard tunnel to a new config.
 *
 * Strategy (zero-downtime):
 *   1. Wait for the agent to finish its current API call (drain connections)
 *   2. Bring up the new tunnel on a temporary interface (old tunnel stays up!)
 *   3. Verify the new tunnel has a handshake and internet
 *   4. Atomically swap the default route (single shell command)
 *   5. Wait briefly for in-flight packets, then tear down the old interface
 *
 * The old tunnel stays up until step 5, so in-flight HTTP requests finish
 * naturally. The route swap in step 4 is the only disruption point — a
 * single exec with `del default; add default` takes ~1-2ms.
 */
export async function rotateNamespace(
  ns: VpnNamespace,
  availableConfigs: WireguardConfig[],
  namespaceName: string,
): Promise<{
  success: boolean;
  newConfig: string | null;
  newPublicIp: string | null;
  error: string | null;
  downtimeMs: number;
}> {
  const tempInterface = "wg1";
  const oldIface = ns.wireguardInterface;

  const candidates = availableConfigs.filter(
    (c) => c.path !== ns.activeConfig && !c.assigned,
  );

  if (candidates.length === 0) {
    return {
      success: false,
      newConfig: null,
      newPublicIp: null,
      error: "No available configs for rotation",
      downtimeMs: 0,
    };
  }

  const selected = candidates[Math.floor(Math.random() * candidates.length)];

  // ── Phase 1: Wait for agent to finish its current API call ──
  console.log(
    `[pi-vpn] ${namespaceName}: waiting for agent to finish current request...`,
  );
  const drained = drainConnections(namespaceName, 20_000);
  if (!drained) {
    console.warn(
      `[pi-vpn] ${namespaceName}: timed out waiting for connections to close, ` +
        `proceeding anyway (old tunnel stays up during rotation)`,
    );
  }

  // ── Phase 2: Establish new tunnel (old stays up!) ──
  try {
    bringUpWireguard(namespaceName, selected.path, tempInterface);
  } catch (err) {
    return {
      success: false,
      newConfig: null,
      newPublicIp: null,
      error: `Failed to establish new tunnel: ${errMsg(err)}`,
      downtimeMs: 0,
    };
  }

  // ── Phase 3: Verify new tunnel ──
  try {
    if (!checkHandshake(namespaceName, tempInterface)) {
      throw new Error("No recent handshake on new tunnel");
    }

    const testIp = getPublicIp(namespaceName);
    if (!testIp) {
      throw new Error("Cannot reach internet through new tunnel");
    }

    console.log(
      `[pi-vpn] ${namespaceName}: new tunnel verified (IP: ${testIp})`,
    );
  } catch (err) {
    try {
      bringDownWireguard(namespaceName, tempInterface);
    } catch {
      // Ignore cleanup errors
    }
    return {
      success: false,
      newConfig: null,
      newPublicIp: null,
      error: `Verification failed: ${errMsg(err)}`,
      downtimeMs: 0,
    };
  }

  // ── Phase 4: Atomic route swap (the critical moment) ──
  const switchStart = Date.now();
  try {
    execSync(
      `ip netns exec ${namespaceName} bash -c ` +
        `"ip route del default dev ${oldIface} 2>/dev/null; ` +
        `ip route add default dev ${tempInterface}"`,
      { stdio: "pipe" },
    );

    console.log(
      `[pi-vpn] ${namespaceName}: route swapped ${oldIface} → ${tempInterface}`,
    );
  } catch (err) {
    // Route swap failed — try to restore old route
    try {
      execSync(
        `ip netns exec ${namespaceName} ip route add default dev ${oldIface}`,
        { stdio: "pipe" },
      );
    } catch {
      try {
        bringUpWireguard(namespaceName, ns.activeConfig ?? "", oldIface);
      } catch {
        // Namespace may be in a bad state
      }
    }
    try {
      bringDownWireguard(namespaceName, tempInterface);
    } catch {
      // ignore
    }
    return {
      success: false,
      newConfig: null,
      newPublicIp: null,
      error: `Route swap failed: ${errMsg(err)}`,
      downtimeMs: Date.now() - switchStart,
    };
  }

  // ── Phase 5: Wait for in-flight packets, then tear down old tunnel ──
  safeSleep(0.5);

  try {
    bringDownWireguard(namespaceName, oldIface);
    console.log(`[pi-vpn] ${namespaceName}: old tunnel ${oldIface} torn down`);
  } catch {
    // Not critical — default route no longer points to it
  }

  // ── Phase 6: Final verification ──
  const finalIp = getPublicIp(namespaceName);
  const totalDowntime = Date.now() - switchStart;

  console.log(
    `[pi-vpn] ${namespaceName}: rotation complete. ` +
      `New IP: ${finalIp}. Route swap took ${totalDowntime}ms.`,
  );

  return {
    success: true,
    newConfig: selected.path,
    newPublicIp: finalIp,
    error: null,
    downtimeMs: totalDowntime,
  };
}

/**
 * Check if a namespace's tunnel is still healthy.
 */
export function isTunnelHealthy(
  ns: VpnNamespace,
  namespaceName: string,
): { healthy: boolean; reason: string } {
  const status = getWireguardStatus(namespaceName, ns.wireguardInterface);
  if (!status.exists) {
    return { healthy: false, reason: "WireGuard interface not found" };
  }

  if (!status.hasHandshake) {
    return { healthy: false, reason: "No recent handshake" };
  }

  if (!checkInternet(namespaceName)) {
    return { healthy: false, reason: "No internet connectivity" };
  }

  return { healthy: true, reason: "ok" };
}
