import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { VpnManager } from "./manager.js";
import { readAllocations, releaseNamespace } from "./tracker.js";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Pi extension: per-subagent VPN isolation with optional main-agent support.
 *
 * Registers an agent spawn middleware that wraps every subagent command
 * with `ip netns exec <namespace>` so each agent runs inside its own
 * network namespace with a rotating WireGuard tunnel.
 *
 * When mainAgentEnabled is true, the main pi session also gets a namespace.
 * Use `pi-vpn-launch` to generate a wrapper script that starts pi inside
 * a namespace, or start pi directly — the extension will allocate a
 * namespace on session_start and set PI_VPN_NAMESPACE.
 */

const CONFIG_FILENAME = "config.json";

/**
 * Resolve the config path using the same directory the manager uses:
 * PI_CODING_AGENT_DIR/subagent-vpn/config.json, falling back to ~/.pi/agent/subagent-vpn/config.json
 */
function resolveConfigPath(): string {
  const agentDir =
    process.env.PI_CODING_AGENT_DIR ??
    require("node:os").homedir() + "/.pi/agent";
  return require("node:path").join(agentDir, "subagent-vpn", CONFIG_FILENAME);
}

const CONFIG_PATH = process.env.PI_VPN_CONFIG ?? resolveConfigPath();

let manager: VpnManager | null = null;

function loadConfig(): Record<string, unknown> {
  const fs = require("node:fs");
  const os = require("node:os");

  const resolved = CONFIG_PATH.replace(/^~/, os.homedir());
  if (!fs.existsSync(resolved)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch {
    return {};
  }
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

export default function subagentVpnExtension(pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    const configOverrides = loadConfig();
    manager = new VpnManager(configOverrides);

    if (manager) {
      try {
        await manager.initialize();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        console.error(`[pi-vpn] Failed to initialize: ${msg}`);
        manager = null;
      }
    }

    // Allocate a namespace for the main agent if enabled
    if (manager) {
      const sessionId =
        process.env.PI_SESSION_ID ?? `main-${Date.now().toString(36)}`;
      const allocation = manager.allocateMainAgent(sessionId);

      if (allocation) {
        // Set env vars so the main agent is aware of its network context
        process.env.PI_VPN_NAMESPACE = allocation.namespace;
        if (allocation.publicIp) {
          process.env.PI_VPN_PUBLIC_IP = allocation.publicIp;
        }
        process.env.PI_AGENT_ROLE = "main";

        console.log(
          `[pi-vpn] Main agent → ${allocation.namespace}` +
            (allocation.publicIp ? ` (${allocation.publicIp})` : ""),
        );
        console.log(
          `[pi-vpn] To launch pi inside this namespace, use: pi-vpn-launch`,
        );
      }
    }
  });

  pi.on("session_shutdown", async () => {
    // Release main agent namespace if we allocated one
    const mainNs = process.env.PI_VPN_NAMESPACE;
    if (mainNs && process.env.PI_AGENT_ROLE === "main") {
      releaseNamespace(mainNs);
      console.log(`[pi-vpn] Released main namespace ${mainNs}`);
    }

    if (manager) {
      await manager.shutdown();
      manager = null;
    }
  });

  // Register the spawn middleware if the global API is available
  const globals = (globalThis as any).__pi_interactive_subagents;
  if (globals?.registerAgentSpawnMiddleware) {
    globals.registerAgentSpawnMiddleware(
      (command: string, ctx: { id: string; name: string; mode: string }) => {
        if (!manager || !manager.getStatus().length) return command;

        const allocation = manager.allocate(ctx.id);
        if (!allocation) return command;

        console.log(
          `[pi-vpn] Agent "${ctx.name}" (${ctx.id}) → ${allocation.namespace}` +
            (allocation.publicIp ? ` (${allocation.publicIp})` : ""),
        );

        // Wrap the command to run inside the network namespace
        // The env vars give the agent awareness of its network context
        const envPrefix = [
          `PI_AGENT_ID=${ctx.id}`,
          `PI_VPN_NAMESPACE=${allocation.namespace}`,
          allocation.publicIp ? `PI_VPN_PUBLIC_IP=${allocation.publicIp}` : "",
        ]
          .filter(Boolean)
          .join(" ");

        return `${envPrefix} ip netns exec ${allocation.namespace} bash -c ${JSON.stringify(command)}`;
      },
    );
  }

  // Register vpn-launch command: generates a wrapper script that starts pi
  // inside a VPN namespace so the main session's traffic is routed through
  // the tunnel.
  pi.registerCommand("vpn-launch", {
    description:
      "Generate a launcher script that runs pi inside a VPN namespace",
    handler: async (_args: string, ctx: any) => {
      const agentDir =
        process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
      const scriptsDir = join(agentDir, "subagent-vpn", "scripts");

      if (!existsSync(scriptsDir)) {
        const fs = require("node:fs");
        fs.mkdirSync(scriptsDir, { recursive: true });
      }

      // Find a namespace not currently in use
      const allocations = readAllocations();
      const usedNames = new Set(allocations.keys());

      // Try to find a free namespace
      let freeNs: string | null = null;
      for (let i = 0; i < 256; i++) {
        const name = `pi-vpn-${i}`;
        if (!usedNames.has(name)) {
          freeNs = name;
          break;
        }
      }

      if (!freeNs) {
        ctx.ui.notify(
          "All VPN namespaces are in use. Stop an existing pi session first.",
          "warning",
        );
        return;
      }

      const scriptPath = join(scriptsDir, "launch-pi-vpn.sh");
      const script = `#!/usr/bin/env bash
# Auto-generated VPN launcher for pi
# Namespace: ${freeNs}
# Generated: ${new Date().toISOString()}

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Check if namespace exists
if ! ip netns list | grep -qw "${freeNs}"; then
  echo "[vpn-launch] Namespace ${freeNs} not found. Creating..."
  ip netns add ${freeNs}
fi

echo "[vpn-launch] Launching pi in namespace ${freeNs}..."
echo "[vpn-launch] Use 'vpn-status' inside pi to check VPN state."

exec ip netns exec ${freeNs} pi "$@"
`;

      writeFileSync(scriptPath, script, { mode: 0o755 });

      ctx.ui.notify(
        `VPN launcher script written to:\n${scriptPath}\n\n` +
          `Usage:\n  ${scriptPath} [pi args]\n\n` +
          `Or run pi directly — the extension will allocate a namespace on startup.`,
        "info",
      );
    },
  });

  // Register status command
  pi.registerCommand("vpn-status", {
    description: "Show VPN namespace status",
    handler: async (_args: string, ctx: any) => {
      if (!manager) {
        ctx.ui.notify("VPN manager not initialized", "warning");
        return;
      }

      const status = manager.getStatus();
      if (status.length === 0) {
        ctx.ui.notify("No VPN namespaces active", "info");
        return;
      }

      const mainNs = process.env.PI_VPN_NAMESPACE;
      const lines = status.map((ns) => {
        const elapsed = ns.connectedAt
          ? formatElapsed(Math.floor((Date.now() - ns.connectedAt) / 1000))
          : "?";
        const ip = ns.publicIp ?? "unknown";
        const country = ns.country ?? "??";
        const busy = ns.busy ? ` → ${ns.agentId}` : "";
        const healthy = ns.healthy ? "✓" : "✗";
        const isMain = ns.name === mainNs ? " ★" : "";
        const flag =
          country === "us"
            ? "🇺🇸"
            : country === "de"
              ? "🇩🇪"
              : country === "nl"
                ? "🇳🇱"
                : country === "jp"
                  ? "🇯🇵"
                  : country === "ca"
                    ? "🇨🇦"
                    : country === "uk"
                      ? "🇬🇧"
                      : "🌐";

        return `  ${flag} ${ns.name}${isMain}  ${ip}  ${country.toUpperCase()}  ${elapsed}  ${healthy}${busy}`;
      });

      ctx.ui.notify(`VPN Namespaces:\n${lines.join("\n")}`, "info");
    },
  });

  // Register rotate command
  pi.registerCommand("vpn-rotate", {
    description: "Rotate VPN tunnels (all or specific namespace)",
    handler: async (args, ctx) => {
      if (!manager) {
        ctx.ui.notify("VPN manager not initialized", "warning");
        return;
      }

      const target = args.trim();
      if (target) {
        ctx.ui.notify(`Rotating ${target}...`, "info");
        const result = await manager.rotateOne(target);
        if (result.success) {
          ctx.ui.notify(`${target} rotated successfully`, "info");
        } else {
          ctx.ui.notify(`${target} rotation failed: ${result.error}`, "error");
        }
      } else {
        ctx.ui.notify("Rotating all namespaces...", "info");
        await manager.rotateAll();
        ctx.ui.notify("Rotation complete", "info");
      }
    },
  });
}
