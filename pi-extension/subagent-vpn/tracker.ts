import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { NamespaceAllocation } from "./types.js";

/**
 * Cross-instance namespace tracker.
 *
 * Persists active namespace allocations to a JSON file so that multiple
 * pi instances (each running their own VpnManager) don't assign the
 * same namespace to different agents.
 *
 * File: ~/.pi/agent/subagent-vpn/active-namespaces.json
 */

const LOCK_DIR = join(homedir(), ".pi", "agent", "subagent-vpn");
const LOCK_FILE = join(LOCK_DIR, "active-namespaces.json");

/** How stale an entry can be before we consider it orphaned (5 minutes). */
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

function ensureDir(): void {
  if (!existsSync(LOCK_DIR)) {
    mkdirSync(LOCK_DIR, { recursive: true });
  }
}

/**
 * Read the current allocations from disk, filtering out stale entries
 * (dead processes).
 */
export function readAllocations(): Map<string, NamespaceAllocation> {
  const map = new Map<string, NamespaceAllocation>();
  if (!existsSync(LOCK_FILE)) return map;

  try {
    const raw = JSON.parse(readFileSync(LOCK_FILE, "utf8")) as Record<
      string,
      NamespaceAllocation
    >;
    const now = Date.now();

    for (const [ns, alloc] of Object.entries(raw)) {
      // Filter out stale entries (process no longer running)
      if (now - alloc.allocatedAt > STALE_THRESHOLD_MS) {
        try {
          process.kill(alloc.pid, 0); // signal 0 = existence check
          // Process exists and entry is recent enough — keep it
          map.set(ns, alloc);
        } catch {
          // Process is dead — skip this entry
        }
      } else {
        // Entry is recent — trust it without killing
        map.set(ns, alloc);
      }
    }
  } catch {
    // Corrupted file — start fresh
  }

  return map;
}

/**
 * Write allocations to disk atomically.
 */
function writeAllocations(map: Map<string, NamespaceAllocation>): void {
  ensureDir();
  const obj: Record<string, NamespaceAllocation> = {};
  for (const [ns, alloc] of map) {
    obj[ns] = alloc;
  }
  writeFileSync(LOCK_FILE, JSON.stringify(obj, null, 2), "utf8");
}

/**
 * Claim a namespace for a given role. Returns the allocation if successful,
 * or null if the namespace is already taken by another process.
 */
export function claimNamespace(
  namespace: string,
  role: "main" | "subagent",
  agentName: string | null,
  sessionId: string | null,
): NamespaceAllocation | null {
  const allocations = readAllocations();

  // Check if this namespace is already claimed by a live process
  const existing = allocations.get(namespace);
  if (existing) {
    try {
      process.kill(existing.pid, 0);
      // Process is alive — namespace is taken
      if (existing.pid === process.pid) {
        // We already own it — update and return
        const alloc: NamespaceAllocation = {
          namespace,
          pid: process.pid,
          role,
          agentName,
          allocatedAt: Date.now(),
          sessionId,
        };
        allocations.set(namespace, alloc);
        writeAllocations(allocations);
        return alloc;
      }
      return null;
    } catch {
      // Dead process — we can take it
    }
  }

  // Claim it
  const alloc: NamespaceAllocation = {
    namespace,
    pid: process.pid,
    role,
    agentName,
    allocatedAt: Date.now(),
    sessionId,
  };
  allocations.set(namespace, alloc);
  writeAllocations(allocations);
  return alloc;
}

/**
 * Release a namespace allocation (called on shutdown).
 */
export function releaseNamespace(namespace: string): void {
  const allocations = readAllocations();
  const existing = allocations.get(namespace);
  if (existing && existing.pid === process.pid) {
    allocations.delete(namespace);
    writeAllocations(allocations);
  }
}

/**
 * Release all allocations owned by the current process.
 */
export function releaseAllForCurrentProcess(): void {
  const allocations = readAllocations();
  let changed = false;
  for (const [ns, alloc] of allocations) {
    if (alloc.pid === process.pid) {
      allocations.delete(ns);
      changed = true;
    }
  }
  if (changed) {
    writeAllocations(allocations);
  }
}

/**
 * Find all namespaces currently in use (by any process).
 */
export function getUsedNamespaces(): Map<string, NamespaceAllocation> {
  return readAllocations();
}

/**
 * Find the next available namespace index, skipping any that are claimed.
 */
export function findAvailableIndex(maxIndex: number): number | null {
  const allocations = readAllocations();
  const usedIndices = new Set<number>();

  for (const ns of allocations.keys()) {
    const match = ns.match(/^pi-vpn-(\d+)$/);
    if (match) {
      usedIndices.add(parseInt(match[1], 10));
    }
  }

  for (let i = 0; i < maxIndex; i++) {
    if (!usedIndices.has(i)) return i;
  }

  return null;
}

/**
 * Cleanup the lock file if it's empty.
 */
export function cleanupLockFile(): void {
  const allocations = readAllocations();
  if (allocations.size === 0 && existsSync(LOCK_FILE)) {
    try {
      unlinkSync(LOCK_FILE);
    } catch {
      // Ignore
    }
  }
}
