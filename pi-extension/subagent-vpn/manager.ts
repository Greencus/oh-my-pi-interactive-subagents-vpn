import { join } from "node:path";
import { homedir } from "node:os";
import type { VpnConfig, VpnNamespace, WireguardConfig } from "./types.js";
import { DEFAULT_VPN_CONFIG } from "./types.js";
import {
  initializeNamespace,
  destroyNamespace,
  getPublicIp,
} from "./namespace.js";
import { scanConfigs, bringUpWireguard } from "./wireguard.js";
import { rotateNamespace, isTunnelHealthy } from "./rotation.js";

/** Extract a safe error message from an unknown catch value. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve the Pi agent config directory, respecting PI_CODING_AGENT_DIR.
 * This is the same logic the subagents plugin uses.
 */
function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * The VPN manager owns the lifecycle of all network namespaces and
 * WireGuard tunnels. It is designed to be a long-lived singleton that
 * survives Pi restarts.
 *
 * Supports two modes:
 *   - Fixed pool: namespaceCount > 0 creates that many at startup
 *   - Dynamic: namespaceCount = 0 creates namespaces on-demand per agent,
 *     up to maxNamespaces (or available configs, whichever is smaller)
 *
 * Communication with Pi happens through the middleware registration
 * on __pi_interactive_subagents — no direct import coupling.
 */
export class VpnManager {
  private config: VpnConfig;
  private namespaces: Map<string, VpnNamespace> = new Map();
  private configs: WireguardConfig[] = [];
  private rotationTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private roundRobinIndex = 0;
  private initialized = false;
  private nextNamespaceIndex = 0;

  constructor(configOverrides: Partial<VpnConfig> = {}) {
    this.config = { ...DEFAULT_VPN_CONFIG, ...configOverrides };
  }

  /** Whether we're in dynamic (on-demand) mode. */
  private get isDynamic(): boolean {
    return this.config.namespaceCount === 0;
  }

  /**
   * Maximum namespaces allowed. In dynamic mode this is capped by:
   *   min(maxNamespaces, available configs, system safety limit)
   * In fixed mode it's just namespaceCount.
   */
  private get capacity(): number {
    if (!this.isDynamic) return this.config.namespaceCount;
    const configCap =
      this.config.maxNamespaces > 0
        ? this.config.maxNamespaces
        : this.configs.length;
    const SYSTEM_LIMIT = 256;
    return Math.min(configCap, this.configs.length, SYSTEM_LIMIT);
  }

  /**
   * Initialize the VPN manager.
   *
   * In fixed mode: creates all namespaces upfront.
   * In dynamic mode: scans configs but creates nothing — namespaces are
   * created on first allocate() call.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.config.enabled) return;

    // Resolve configs directory: use explicit path if given,
    // otherwise default to <agent-config-dir>/subagent-vpn/configs
    let configsDir: string;
    if (this.config.configsDirectory === DEFAULT_VPN_CONFIG.configsDirectory) {
      // Default: use the Pi agent config directory
      const agentDir = getAgentConfigDir();
      configsDir = join(agentDir, "subagent-vpn", "configs");
    } else {
      // User explicitly set a configs directory
      configsDir = this.config.configsDirectory.replace(
        /^~/,
        process.env.HOME ?? "/root",
      );
    }

    this.configs = scanConfigs(configsDir);

    if (this.configs.length === 0) {
      console.warn(
        `[pi-vpn] No WireGuard configs found in ${configsDir}. VPN isolation disabled.`,
      );
      this.config.enabled = false;
      return;
    }

    if (this.isDynamic) {
      console.log(
        `[pi-vpn] Dynamic mode: ${this.configs.length} configs available, ` +
          `up to ${this.capacity} concurrent namespaces.`,
      );
    } else {
      console.log(
        `[pi-vpn] Fixed pool: creating ${this.config.namespaceCount} namespaces ` +
          `from ${this.configs.length} configs...`,
      );

      for (let i = 0; i < this.config.namespaceCount; i++) {
        await this.createNamespace(i);
      }
    }

    if (this.config.rotationIntervalMinutes > 0) {
      this.rotationTimer = setInterval(
        () => this.rotateAll(),
        this.config.rotationIntervalMinutes * 60 * 1000,
      );
    }

    this.healthTimer = setInterval(() => this.healthCheck(), 5 * 60 * 1000);

    this.initialized = true;
    console.log(
      `[pi-vpn] VPN manager initialized. ${this.namespaces.size} namespaces active.`,
    );
  }

  /**
   * Allocate a namespace for a subagent.
   *
   * Fixed mode: picks from the pre-created pool.
   * Dynamic mode: creates a new namespace on-demand if one isn't available.
   *
   * Returns the namespace to use, or null if VPN is disabled or capacity is reached.
   */
  allocate(
    agentId: string,
  ): { namespace: string; publicIp: string | null } | null {
    if (!this.config.enabled) return null;

    if (this.isDynamic) {
      return this.allocateDynamic(agentId);
    }

    return this.allocateFixed(agentId);
  }

  /**
   * Fixed-mode allocation: pick from the pre-created pool.
   */
  private allocateFixed(
    agentId: string,
  ): { namespace: string; publicIp: string | null } | null {
    const idle = Array.from(this.namespaces.values()).filter(
      (ns) => !ns.busy && ns.healthy,
    );

    if (idle.length > 0) {
      const ns = this.selectFromList(idle);
      ns.busy = true;
      ns.agentId = agentId;
      return { namespace: ns.name, publicIp: ns.publicIp };
    }

    const healthy = Array.from(this.namespaces.values()).filter(
      (ns) => ns.healthy,
    );

    if (healthy.length > 0) {
      const ns = this.selectFromList(healthy);
      ns.busy = true;
      ns.agentId = agentId;
      return { namespace: ns.name, publicIp: ns.publicIp };
    }

    return null;
  }

  /**
   * Dynamic-mode allocation: create a new namespace on-demand.
   */
  private allocateDynamic(
    agentId: string,
  ): { namespace: string; publicIp: string | null } | null {
    const idle = Array.from(this.namespaces.values()).filter(
      (ns) => !ns.busy && ns.healthy,
    );

    if (idle.length > 0) {
      const ns = this.selectFromList(idle);
      ns.busy = true;
      ns.agentId = agentId;
      return { namespace: ns.name, publicIp: ns.publicIp };
    }

    if (this.namespaces.size >= this.capacity) {
      console.warn(
        `[pi-vpn] Dynamic capacity reached (${this.capacity}). ` +
          `Agent ${agentId} will share an existing namespace.`,
      );
      const all = Array.from(this.namespaces.values()).filter(
        (ns) => ns.healthy,
      );
      if (all.length > 0) {
        const ns = this.selectFromList(all);
        ns.busy = true;
        ns.agentId = agentId;
        return { namespace: ns.name, publicIp: ns.publicIp };
      }
      return null;
    }

    const index = this.nextNamespaceIndex++;
    const ns = this.createNamespaceSync(index);
    if (!ns) return null;

    ns.busy = true;
    ns.agentId = agentId;
    return { namespace: ns.name, publicIp: ns.publicIp };
  }

  /**
   * Release a namespace when a subagent terminates.
   */
  release(agentId: string): void {
    for (const ns of this.namespaces.values()) {
      if (ns.agentId === agentId) {
        ns.busy = false;
        ns.agentId = null;
        break;
      }
    }
  }

  /**
   * Get the current status of all namespaces.
   */
  getStatus(): VpnNamespace[] {
    return Array.from(this.namespaces.values());
  }

  /**
   * Manually trigger rotation of a specific namespace.
   */
  async rotateOne(namespaceName: string): Promise<{
    success: boolean;
    error: string | null;
  }> {
    const ns = this.namespaces.get(namespaceName);
    if (!ns)
      return { success: false, error: `Namespace ${namespaceName} not found` };

    if (this.config.rotateOnlyIdle && ns.busy) {
      return { success: false, error: `Namespace ${namespaceName} is busy` };
    }

    const result = await rotateNamespace(ns, this.configs, namespaceName);

    if (result.success) {
      ns.activeConfig = result.newConfig;
      ns.publicIp = result.newPublicIp;
      ns.connectedAt = Date.now();
      ns.lastError = null;

      for (const c of this.configs) {
        if (c.assignedTo === namespaceName) {
          c.assigned = false;
          c.assignedTo = null;
        }
      }
      const newConfig = this.configs.find((c) => c.path === result.newConfig);
      if (newConfig) {
        newConfig.assigned = true;
        newConfig.assignedTo = namespaceName;
        ns.country = newConfig.country;
      }
    } else {
      ns.lastError = result.error;
    }

    return { success: result.success, error: result.error };
  }

  /**
   * Rotate all namespaces.
   */
  async rotateAll(): Promise<void> {
    console.log(`[pi-vpn] Starting rotation of all namespaces...`);

    for (const [name, ns] of this.namespaces) {
      if (this.config.rotateOnlyIdle && ns.busy) {
        console.log(`[pi-vpn] Skipping ${name} (busy)`);
        continue;
      }

      const result = await this.rotateOne(name);
      if (result.success) {
        console.log(`[pi-vpn] ${name}: rotated successfully`);
      } else {
        console.warn(`[pi-vpn] ${name}: rotation failed — ${result.error}`);
      }
    }

    console.log(`[pi-vpn] Rotation complete.`);
  }

  /**
   * Run health checks on all namespaces.
   */
  private healthCheck(): void {
    for (const [name, ns] of this.namespaces) {
      const { healthy, reason } = isTunnelHealthy(ns, name);
      ns.healthy = healthy;
      ns.lastHealthCheck = Date.now();

      if (!healthy) {
        ns.lastError = reason;
        console.warn(`[pi-vpn] ${name}: unhealthy — ${reason}`);

        if (ns.activeConfig) {
          try {
            bringUpWireguard(name, ns.activeConfig, "wg0");
            ns.healthy = true;
            ns.lastError = null;
            console.log(`[pi-vpn] ${name}: recovered`);
          } catch (err) {
            const msg = errMsg(err);
            ns.lastError = `Recovery failed: ${msg}`;
            console.error(`[pi-vpn] ${name}: recovery failed — ${msg}`);
          }
        }
      }
    }
  }

  /**
   * Select a namespace from a list using the configured strategy.
   */
  private selectFromList(list: VpnNamespace[]): VpnNamespace {
    switch (this.config.allocation) {
      case "round-robin": {
        const ns = list[this.roundRobinIndex % list.length];
        this.roundRobinIndex++;
        return ns;
      }
      case "random": {
        return list[Math.floor(Math.random() * list.length)];
      }
      case "least-used": {
        return list.find((ns) => !ns.busy) ?? list[0];
      }
      default:
        return list[0];
    }
  }

  /**
   * Create a namespace by index (used by both fixed and dynamic modes).
   */
  private async createNamespace(index: number): Promise<VpnNamespace | null> {
    return this.createNamespaceSync(index);
  }

  /**
   * Synchronous namespace creation (for dynamic mode at allocation time).
   */
  private createNamespaceSync(index: number): VpnNamespace | null {
    const name = `pi-vpn-${index}`;

    if (this.namespaces.has(name)) return this.namespaces.get(name)!;

    const ns: VpnNamespace = {
      name,
      activeConfig: null,
      wireguardInterface: "wg0",
      busy: false,
      agentId: null,
      publicIp: null,
      country: null,
      connectedAt: null,
      lastHealthCheck: null,
      healthy: false,
      lastError: null,
    };

    try {
      initializeNamespace(name);

      const config = this.assignConfig(name);
      if (config) {
        bringUpWireguard(name, config.path, "wg0");
        ns.activeConfig = config.path;
        ns.country = config.country;
        ns.connectedAt = Date.now();

        const ip = getPublicIp(name);
        ns.publicIp = ip;
        ns.healthy = true;

        console.log(
          `[pi-vpn] ${name}: created + connected via ${config.filename} → ${ip ?? "unknown IP"}`,
        );
      }

      this.namespaces.set(name, ns);
      return ns;
    } catch (err) {
      const msg = errMsg(err);
      ns.lastError = msg;
      this.namespaces.set(name, ns);
      console.error(`[pi-vpn] Failed to create ${name}: ${msg}`);
      return ns;
    }
  }

  /**
   * Assign the next unassigned config to a namespace.
   */
  private assignConfig(namespaceName: string): WireguardConfig | null {
    const unassigned = this.configs.find((c) => !c.assigned);
    if (!unassigned) return null;

    unassigned.assigned = true;
    unassigned.assignedTo = namespaceName;
    return unassigned;
  }

  /**
   * Shut down the manager: tear down all namespaces and stop timers.
   */
  async shutdown(): Promise<void> {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }

    for (const [name] of this.namespaces) {
      try {
        destroyNamespace(name);
        console.log(`[pi-vpn] Destroyed namespace ${name}`);
      } catch (err) {
        console.error(`[pi-vpn] Failed to destroy ${name}: ${errMsg(err)}`);
      }
    }

    this.namespaces.clear();
    this.initialized = false;
    console.log(`[pi-vpn] VPN manager shut down.`);
  }
}
