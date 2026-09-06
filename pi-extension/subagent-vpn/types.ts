/**
 * Configuration for the subagent VPN isolation system.
 */
export interface VpnConfig {
 /** Master enable/disable switch. */
 enabled: boolean;
 /**
  * Fixed pool of pre-created namespaces. Set to 0 for dynamic mode
  * (namespaces created on-demand per agent, 1:1 mapping).
  */
 namespaceCount: number;
 /**
  * Maximum concurrent namespaces in dynamic mode. Each agent gets its own
  * namespace with a unique WireGuard tunnel. Set to 0 to use the config
  * count as the ceiling (min of configs available, this cap, and system limits).
  */
 maxNamespaces: number;
 /** Rotation interval in minutes. Default: 60. */
 rotationIntervalMinutes: number;
 /** Absolute path to directory containing ProtonVPN WireGuard .conf files. */
 configsDirectory: string;
 /** Allocation strategy: round-robin, random, or least-used. */
 allocation: "round-robin" | "random" | "least-used";
 /** If true, only rotate tunnels when no agents are actively using the namespace. */
 rotateOnlyIdle: boolean;
 /** Kill switch: if WireGuard goes down, block all internet in the namespace. */
 killSwitch: boolean;
 /** If true, allocate a namespace for the main pi agent session on startup. */
 mainAgentEnabled: boolean;
}

/**
 * A namespace allocation record persisted to disk for cross-instance tracking.
 */
export interface NamespaceAllocation {
 /** Namespace name (e.g. pi-vpn-0). */
 namespace: string;
 /** The process ID that owns this allocation. */
 pid: number;
 /** 'main' for the pi session, 'subagent' for spawned agents. */
 role: "main" | "subagent";
 /** Agent name (e.g. 'orchestrator', 'worker'). */
 agentName: string | null;
 /** Timestamp when allocated. */
 allocatedAt: number;
 /** Optional human-readable session identifier. */
 sessionId: string | null;
}

export const DEFAULT_VPN_CONFIG: VpnConfig = {
 enabled: false,
 namespaceCount: 4,
 maxNamespaces: 0,
 rotationIntervalMinutes: 60,
 configsDirectory: "~/.pi/agent/subagent-vpn/configs",
 allocation: "round-robin",
 rotateOnlyIdle: false,
 killSwitch: true,
 mainAgentEnabled: true,
};

/**
 * Represents a single network namespace with its current WireGuard tunnel.
 */
export interface VpnNamespace {
 /** Persistent namespace name (e.g. pi-vpn-0). */
 name: string;
 /** Path to the currently active WireGuard .conf file. */
 activeConfig: string | null;
 /** WireGuard interface name inside the namespace (e.g. wg0). */
 wireguardInterface: string;
 /** Whether this namespace is currently assigned to an agent. */
 busy: boolean;
 /** Agent ID currently using this namespace, if any. */
 agentId: string | null;
 /** Public IP observed inside this namespace, if known. */
 publicIp: string | null;
 /** Country code from the WireGuard config filename, if parseable. */
 country: string | null;
 /** Timestamp when the current tunnel was established. */
 connectedAt: number | null;
 /** Timestamp of the last successful health check. */
 lastHealthCheck: number | null;
 /** Whether the namespace is currently healthy. */
 healthy: boolean;
 /** Any error message from the last operation. */
 lastError: string | null;
}

/**
 * A WireGuard configuration file parsed from the configs directory.
 */
export interface WireguardConfig {
 /** Absolute path to the .conf file. */
 path: string;
 /** Filename (e.g. proton-de-01.conf). */
 filename: string;
 /** Parsed country code from filename, if available. */
 country: string | null;
 /** Whether this config is currently assigned to a namespace. */
 assigned: boolean;
 /** Which namespace it's assigned to, if any. */
 assignedTo: string | null;
}
