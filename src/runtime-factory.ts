/**
 * Factory for creating AgentSessionRuntime instances.
 *
 * This is the core of the standalone pi-web app — instead of receiving
 * ExtensionContext from pi events (which can go stale), we create and
 * own the runtime directly using the pi SDK.
 */

import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  type AgentSessionRuntime,
  type AgentSessionServices,
  SessionManager,
  ModelRegistry,
  AuthStorage,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

export interface RuntimeOptions {
  cwd: string;
  agentDir?: string;
  sessionManager?: SessionManager;
  sessionStartEvent?: any;
}

export interface RuntimeResult {
  runtime: AgentSessionRuntime;
  services: AgentSessionServices;
}

/**
 * Create an AgentSessionRuntime for the given cwd.
 *
 * This replaces the pi extension's ExtensionContext. The runtime gives us:
 * - Direct session management (newSession, switchSession, fork)
 * - Direct model/thinking control
 * - Direct event subscriptions
 * - No stale context issues
 */
export async function createRuntime(options: RuntimeOptions): Promise<RuntimeResult> {
  const { cwd } = options;
  const agentDir = options.agentDir || getAgentDir();

  const sessionManager = options.sessionManager ?? (await SessionManager.create(cwd));

  // Factory that creates a new runtime for session replacement operations.
  // Each time the session is replaced (new/switch/fork), this factory is called
  // to create fresh cwd-bound services and a new AgentSession.
  const createRuntimeFactory: import("@earendil-works/pi-coding-agent").CreateAgentSessionRuntimeFactory =
    async ({ cwd: sessionCwd, agentDir: sessionAgentDir, sessionManager: sm }) => {
      const authStorage = AuthStorage.create(sessionAgentDir + "/auth.json");
      const modelRegistry = ModelRegistry.create(authStorage, sessionAgentDir + "/models.json");
      const settingsManager = SettingsManager.create(sessionCwd, sessionAgentDir);

      const services = await createAgentSessionServices({
        cwd: sessionCwd,
        agentDir: sessionAgentDir,
        modelRegistry,
        settingsManager,
        authStorage,
      });

      // Import createAgentSession dynamically to use the services we just created
      const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
      const result = await createAgentSession({
        cwd: sessionCwd,
        agentDir: sessionAgentDir,
        modelRegistry,
        settingsManager,
        authStorage,
        sessionManager: sm,
        resourceLoader: services.resourceLoader,
      });

      return {
        ...result,
        services,
        diagnostics: [],
      };
    };

  const runtime = await createAgentSessionRuntime(createRuntimeFactory, {
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent: options.sessionStartEvent,
  });

  return {
    runtime,
    services: runtime.services,
  };
}