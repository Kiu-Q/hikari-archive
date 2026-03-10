const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3001;

// MIME types
const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.vrm': 'application/octet-stream',
    '.vrma': 'application/octet-stream',
    '.glb': 'model/gltf-binary'
};

const server = http.createServer((req, res) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

    // Enable CORS for LAN access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Serve from dist directory (built files)
    // Default to index.html
    let filePath = './dist' + req.url;
    if (filePath === './dist/') {
        filePath = './dist/index.html';
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

// Get local IP addresses for LAN access
const os = require('os');
const interfaces = os.networkInterfaces();
const addresses = [];

for (const k in interfaces) {
    for (const k2 in interfaces[k]) {
        const address = interfaces[k][k2];
        if (address.family === 'IPv4' && !address.internal) {
            addresses.push(address.address);
        }
    }
}

server.listen(PORT, () => {
    console.log('\n========================================');
    console.log('Web Server Started');
    console.log('========================================');
    console.log(`Local: http://localhost:${PORT}`);
    console.log('\nLAN Access:');
    addresses.forEach(addr => {
        console.log(`  http://${addr}:${PORT}`);
    });
    console.log('\nPress Ctrl+C to stop the server');
    console.log('========================================\n');
});