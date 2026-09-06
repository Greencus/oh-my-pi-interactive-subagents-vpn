import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { VpnManager } from "./manager.js";

/**
 * Pi extension: per-subagent VPN isolation.
 *
 * Registers an agent spawn middleware that wraps every subagent command
 * with `ip netns exec <namespace>` so each agent runs inside its own
 * network namespace with a rotating WireGuard tunnel.
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
  });

  pi.on("session_shutdown", async () => {
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

      const lines = status.map((ns) => {
        const elapsed = ns.connectedAt
          ? formatElapsed(Math.floor((Date.now() - ns.connectedAt) / 1000))
          : "?";
        const ip = ns.publicIp ?? "unknown";
        const country = ns.country ?? "??";
        const busy = ns.busy ? ` → ${ns.agentId}` : "";
        const healthy = ns.healthy ? "✓" : "✗";
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

        return `  ${flag} ${ns.name}  ${ip}  ${country.toUpperCase()}  ${elapsed}  ${healthy}${busy}`;
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
