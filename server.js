#!/usr/bin/env node
/**
 * Simple HTTP server for serving the active suspension web interface.
 * Listens on 0.0.0.0:8080 to be accessible from all computers on the network.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 8080;
const BIND_ADDRESS = '0.0.0.0';
const HTML_DIR = path.join(__dirname, 'html');

// MIME types mapping
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.woff': 'application/font-woff',
  '.ttf': 'application/font-ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'application/font-otf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json'
};

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  let pathname = parsedUrl.pathname;

  // Default to index.html for root path
  if (pathname === '/') {
    pathname = '/index.html';
  }

  // Resolve the file path
  const filePath = path.join(HTML_DIR, pathname);
  
  // Security: prevent directory traversal
  if (!filePath.startsWith(HTML_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  // Try to serve the file
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // If it's a directory, look for index.html
      if (err.code === 'EISDIR') {
        const indexPath = path.join(filePath, 'index.html');
        fs.readFile(indexPath, (indexErr, indexData) => {
          if (indexErr) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            console.log(`[404] ${req.method} ${req.url}`);
          } else {
            res.writeHead(200, { 
              'Content-Type': 'text/html',
              'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
            });
            res.end(indexData);
            console.log(`[200] ${req.method} ${req.url}`);
          }
        });
      } else if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        console.log(`[404] ${req.method} ${req.url}`);
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
        console.log(`[500] ${req.method} ${req.url}: ${err.message}`);
      }
    } else {
      // Determine content type
      const ext = path.extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      res.writeHead(200, { 
        'Content-Type': contentType,
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
      });
      res.end(data);
      console.log(`[200] ${req.method} ${req.url}`);
    }
  });
});

server.listen(PORT, BIND_ADDRESS, () => {
  console.log('\n' + '='.repeat(60));
  console.log('Active Suspension Web Server');
  console.log('='.repeat(60));
  console.log(`Serving files from: ${HTML_DIR}`);
  console.log(`Listening on: http://0.0.0.0:${PORT}`);
  console.log(`Access from this computer: http://localhost:${PORT}`);
  console.log(`Access from network: http://<your-computer-ip>:${PORT}`);
  console.log('='.repeat(60));
  console.log('Press Ctrl+C to stop the server\n');
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n\nServer stopped.');
  process.exit(0);
});
