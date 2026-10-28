import type * as ServerActions from "./actions";

// The static desktop bundle cannot host Node.js MCP subprocesses.
async function unavailable(): Promise<never> {
  throw new Error(
    "MCP requires a server deployment and is unavailable in the desktop app.",
  );
}

export const isMcpEnabled: typeof ServerActions.isMcpEnabled = async () =>
  false;
export const getClientsStatus: typeof ServerActions.getClientsStatus =
  unavailable;
export const getClientTools: typeof ServerActions.getClientTools = unavailable;
export const getAvailableClientsCount: typeof ServerActions.getAvailableClientsCount =
  unavailable;
export const getAllTools: typeof ServerActions.getAllTools = unavailable;
export const initializeMcpSystem: typeof ServerActions.initializeMcpSystem =
  unavailable;
export const addMcpServer: typeof ServerActions.addMcpServer = unavailable;
export const pauseMcpServer: typeof ServerActions.pauseMcpServer = unavailable;
export const resumeMcpServer: typeof ServerActions.resumeMcpServer =
  unavailable;
export const removeMcpServer: typeof ServerActions.removeMcpServer =
  unavailable;
export const restartAllClients: typeof ServerActions.restartAllClients =
  unavailable;
export const executeMcpAction: typeof ServerActions.executeMcpAction =
  unavailable;
export const getMcpConfigFromFile: typeof ServerActions.getMcpConfigFromFile =
  unavailable;
