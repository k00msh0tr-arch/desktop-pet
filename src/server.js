'use strict';
// Tiny loopback HTTP server. Claude Code's HTTP hooks POST each event here.
// Nothing leaves the machine; browsers are refused (they send an Origin header).

const http = require('http');

const PORT = Number(process.env.PET_PORT) || 47821;
const MAX_BODY = 1024 * 1024;

function startServer(pet, { port = PORT, inspect = null } = {}) {
  const recent = []; // last few hook events, for GET /events when something doesn't react
  const server = http.createServer((req, res) => {
    if (req.headers.origin) return void res.writeHead(403).end();
    if (req.method === 'GET' && req.url === '/health') return void res.writeHead(200).end('ok');
    if (req.method === 'GET' && req.url === '/actor' && inspect) { // what she is doing right now
      return void inspect().then(
        (json) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(json || 'null'),
        () => res.writeHead(500).end(),
      );
    }
    if (req.method === 'GET' && req.url === '/events') {
      return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(recent));
    }

    const isHook = req.url === '/hook';
    if (req.method !== 'POST' || (!isHook && req.url !== '/debug')) return void res.writeHead(404).end();

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        if (isHook) {
          recent.push({ at: new Date().toISOString(), event: data.hook_event_name, tool: data.tool_name, session: data.session_id });
          if (recent.length > 20) recent.shift();
          pet.handleHook(data);
        } else pet.debug(data.state, data.text || null, !!data.confetti);
      } catch (err) {
        console.error('[pet] bad request body:', err.message);
      }
      // an empty JSON object means "no decision", so the tool call carries on untouched
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    });
  });

  server.on('error', (err) => console.error(`[pet] server error on ${port}:`, err.message));
  server.listen(port, '127.0.0.1');
  return server;
}

module.exports = { startServer, PORT };
