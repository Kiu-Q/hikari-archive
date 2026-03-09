import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 8082;
const ASSETS_DIR = path.join(__dirname, 'renderer', 'assets');

const server = http.createServer((req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Serve files from assets directory
  const filePath = path.join(ASSETS_DIR, req.url);
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      console.error(`Error serving ${req.url}:`, err);
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    
    // Set content type based on file extension
    const ext = path.extname(filePath);
    const contentTypes = {
      '.vrm': 'model/vrml',
      '.vrma': 'model/vrml',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.mp4': 'video/mp4'
    };
    
    const contentType = contentTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.writeHead(200);
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Asset server running on http://0.0.0.0:${PORT}`);
  console.log(`Serving files from: ${ASSETS_DIR}`);
  console.log(`\nAccess URLs:`);
  console.log(`  Local: http://localhost:${PORT}`);
  console.log(`  LAN: http://YOUR_LOCAL_IP:${PORT}`);
  console.log(`  Tailscale: http://YOUR_TAILSCALE_IP:${PORT}`);
});
