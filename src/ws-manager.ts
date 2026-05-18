/**
 * WebSocket manager for broadcasting pi events to connected clients
 */

export interface WsClient {
  send: (data: string) => void;
  close: () => void;
}

export interface WsMessage {
  type: string;
  data: any;
}

export function createWsManager() {
  const clients = new Set<WsClient>();
  let messageId = 0;

  function addClient(client: WsClient): () => void {
    clients.add(client);
    return () => {
      clients.delete(client);
    };
  }

  function broadcast(message: WsMessage) {
    const payload = JSON.stringify({ ...message, id: messageId++ });
    for (const client of clients) {
      try {
        client.send(payload);
      } catch {
        clients.delete(client);
      }
    }
  }

  function closeAll() {
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    clients.clear();
  }

  function getClientCount() {
    return clients.size;
  }

  return {
    addClient,
    broadcast,
    closeAll,
    getClientCount,
  };
}

export type WsManager = ReturnType<typeof createWsManager>;