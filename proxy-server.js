// Simple proxy server to mimic Vercel's routing locally
// Routes /api/* requests to FastAPI backend on port 8000
// Serves static files from root directory

const http = require('http');
const httpProxy = require('http-proxy');
const fs = require('fs');
const path = require('path');

const proxy = httpProxy.createProxyServer({});
const PORT = 3000;
const API_PORT = 8000;

// MIME types for static files
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'font/otf',
};

const server = http.createServer((req, res) => {
  // Route /projects/persona requests to FastAPI backend
  if (req.url.startsWith('/projects/persona')) {
    console.log(`[PROXY] ${req.method} ${req.url} -> http://localhost:${API_PORT}`);
    // Rewrite the URL to remove /projects/persona prefix
    const apiUrl = req.url.replace('/projects/persona', '');
    req.url = apiUrl || '/';
    proxy.web(req, res, { 
      target: `http://localhost:${API_PORT}`,
      changeOrigin: true
    });
    return;
  }

  // Serve static files
  let filePath = '.' + req.url;
  if (filePath === './') {
    filePath = './index.html';
  }

  // Handle clean URLs (e.g., /about -> /about.html)
  if (!path.extname(filePath) && !fs.existsSync(filePath)) {
    const htmlPath = filePath + '.html';
    if (fs.existsSync(htmlPath)) {
      filePath = htmlPath;
    }
  }

  const extname = String(path.extname(filePath)).toLowerCase();
  const contentType = mimeTypes[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>', 'utf-8');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${error.code}`, 'utf-8');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

proxy.on('error', (err, req, res) => {
  console.error('[PROXY ERROR]', err.message);
  res.writeHead(502, { 'Content-Type': 'text/plain' });
  res.end('Bad Gateway - Is the FastAPI server running on port 8000?');
});

server.listen(PORT, () => {
  console.log(`\n🚀 Development server running:`);
  console.log(`   Static site: http://localhost:${PORT}`);
  console.log(`   API proxied from: http://localhost:${API_PORT}`);
  console.log(`\n   Access persona generator: http://localhost:${PORT}/projects/persona\n`);
});
