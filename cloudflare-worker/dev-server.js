#!/usr/bin/env node

/**
 * Local development server for Cloudflare Worker
 * Serves the worker demo and static assets
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.gpx': 'application/gpx+xml',
  '.xml': 'application/xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'demo.html');

  if (req.url === '/') {
    filePath = path.join(__dirname, 'demo.html');
  } else if (req.url === '/worker.js') {
    filePath = path.join(__dirname, 'worker.js');
  } else if (req.url.startsWith('/api')) {
    // Proxy to real worker (if deployed)
    filePath = null;
  }

  if (filePath) {
    const extname = String(path.extname(filePath)).toLowerCase();
    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        } else {
          res.writeHead(500);
          res.end('Server Error');
        }
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      }
    });
  } else {
    // For API calls, forward to deployed worker
    const workerUrl = 'https://hike-worker.your-worker-name.workers.dev';
    const apiPath = req.url;

    fetch(`${workerUrl}${apiPath}`, {
      method: req.method,
      headers: req.headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req : undefined,
    })
      .then(response => {
        const headers = new Headers();
        response.headers.forEach((value, key) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      })
      .then(response => response.text())
      .then(text => res.end(text))
      .catch(err => {
        res.writeHead(502);
        res.end(`Error proxying to worker: ${err.message}`);
      });
  }
});

server.listen(PORT, () => {
  console.log(`🥾 Hike Worker dev server running on http://localhost:${PORT}`);
  console.log(`Demo: http://localhost:${PORT}`);
  console.log('\nTo deploy, run: npm run deploy');
});