import { createServer } from 'node:http';
import type { Client } from 'discord.js';
import logger from './logger.js';

export function startHealthServer(client: Client): void {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const ready = client.ws.status === 0;
      const body = JSON.stringify({ status: ready ? 'ok' : 'degraded', discord: ready });
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(3001, () => {
    logger.info({}, 'Health server listening on port 3001');
  });
}
