/**
 * File Bridge - Central Server
 * 
 * npm install express ws
 * node server.js
 */

const express = require('express');
const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
    port: 3000,
    host: '0.0.0.0',
    password: 'changeme123',          // ← CHANGE THIS!
    clientToken: '',                  // Optional client auth token
    maxFileSize: 100 * 1024 * 1024,   // 100MB
    heartbeatTimeout: 60000,           // 60s
    uploadDir: path.join(__dirname, 'uploads'),
    cors: {
        enabled: false,
        origins: ['http://localhost:3000'],
    },
    https: {
        enabled: false,
        cert: './cert.pem',
        key: './key.pem',
    },
};

try {
    const userConfig = require('./config');
    Object.assign(CONFIG, userConfig);
} catch (err) {
    console.warn('No server config file loaded, using defaults.');
}

CONFIG.port = Number(process.env.PORT || CONFIG.port || 3000);
CONFIG.host = process.env.HOST || CONFIG.host || '0.0.0.0';
CONFIG.publicUrl = process.env.PUBLIC_URL || process.env.PUBLIC_HOST || CONFIG.publicUrl || '';
CONFIG.uploadDir = path.isAbsolute(CONFIG.uploadDir) ? CONFIG.uploadDir : path.join(__dirname, CONFIG.uploadDir);

// ============================================================
// STATE
// ============================================================
const connectedClients = new Map();   // clientId -> { ws, info, lastSeen }
const pendingRequests = new Map();    // requestId -> { resolve, timeout }
const adminConnections = new Set();   // admin ws connections

// ============================================================
// EXPRESS APP
// ============================================================
const app = express();
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

if (CONFIG.cors && CONFIG.cors.enabled) {
    app.use((req, res, next) => {
        const origin = req.headers.origin;
        const allowed = !CONFIG.cors.origins || CONFIG.cors.origins.includes('*') || (origin && CONFIG.cors.origins.includes(origin));
        if (allowed) {
            res.setHeader('Access-Control-Allow-Origin', origin || '*');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        }
        if (req.method === 'OPTIONS') {
            return res.sendStatus(204);
        }
        next();
    });
}

// Ensure upload directory exists
if (!fs.existsSync(CONFIG.uploadDir)) {
    fs.mkdirSync(CONFIG.uploadDir, { recursive: true });
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
const sessions = new Map();

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function authMiddleware(req, res, next) {
    const token = req.headers['authorization']?.replace('Bearer ', '') ||
                  req.query.token ||
                  req.cookies?.token;

    if (token && sessions.has(token)) {
        req.session = sessions.get(token);
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

// ============================================================
// AUTH ROUTES
// ============================================================
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === CONFIG.password) {
        const token = generateToken();
        sessions.set(token, { loginTime: Date.now() });
        // Clean old sessions
        if (sessions.size > 100) {
            const oldest = [...sessions.entries()]
                .sort((a, b) => a[1].loginTime - b[1].loginTime)[0];
            sessions.delete(oldest[0]);
        }
        res.json({ success: true, token });
    } else {
        res.status(403).json({ error: 'Wrong password' });
    }
});

app.post('/api/logout', (req, res) => {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (token) sessions.delete(token);
    res.json({ success: true });
});

// ============================================================
// CLIENT API ROUTES (all require auth)
// ============================================================

// Get all connected clients
app.get('/api/clients', authMiddleware, (req, res) => {
    const clients = [];
    for (const [id, client] of connectedClients) {
        clients.push({
            id,
            name: client.info?.name || 'Unknown',
            hostname: client.info?.hostname || 'Unknown',
            systemInfo: client.info?.systemInfo || {},
            lastSeen: client.lastSeen,
            online: Date.now() - client.lastSeen < CONFIG.heartbeatTimeout,
            ip: client.info?.ip || 'Unknown'
        });
    }
    res.json({ clients });
});

app.get('/api/server-info', authMiddleware, (req, res) => {
    const protocol = CONFIG.https && CONFIG.https.enabled ? 'https' : 'http';
    const baseUrl = CONFIG.publicUrl ? CONFIG.publicUrl.replace(/\/$/, '') : `${protocol}://${req.headers.host}`;
    const wsPrefix = protocol === 'https' ? 'wss' : 'ws';
    const publicWsUrl = baseUrl.replace(/^https?/, wsPrefix) + '/ws';
    const publicAdminWsUrl = baseUrl.replace(/^https?/, wsPrefix) + '/admin';
    res.json({ publicUrl: baseUrl, publicWsUrl, publicAdminWsUrl });
});

// Send command to specific client
app.post('/api/client/:id/command', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { command } = req.body;

    const client = connectedClients.get(id);
    if (!client) {
        return res.status(404).json({ error: 'Client not connected' });
    }

    try {
        const result = await sendToClient(id, {
            type: 'execute_command',
            command: command,
            requestId: generateRequestId()
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// List files on client
app.post('/api/client/:id/files', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { path: filePath } = req.body;

    const client = connectedClients.get(id);
    if (!client) {
        return res.status(404).json({ error: 'Client not connected' });
    }

    try {
        const result = await sendToClient(id, {
            type: 'list_files',
            path: filePath || '/',
            requestId: generateRequestId()
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Take screenshot
app.post('/api/client/:id/screenshot', authMiddleware, async (req, res) => {
    const { id } = req.params;

    const client = connectedClients.get(id);
    if (!client) {
        return res.status(404).json({ error: 'Client not connected' });
    }

    try {
        const result = await sendToClient(id, {
            type: 'take_screenshot',
            requestId: generateRequestId()
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Ping client
app.post('/api/client/:id/ping', authMiddleware, async (req, res) => {
    const { id } = req.params;

    const client = connectedClients.get(id);
    if (!client) {
        return res.status(404).json({ error: 'Client not connected' });
    }

    try {
        const start = Date.now();
        await sendToClient(id, {
            type: 'ping',
            id: generateRequestId()
        });
        const latency = Date.now() - start;
        res.json({ latency: `${latency}ms` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete file/folder on client
app.post('/api/client/:id/delete', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { path: filePath } = req.body;

    const client = connectedClients.get(id);
    if (!client) {
        return res.status(404).json({ error: 'Client not connected' });
    }

    try {
        const result = await sendToClient(id, {
            type: 'delete_file',
            path: filePath,
            requestId: generateRequestId()
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Rename file/folder on client
app.post('/api/client/:id/rename', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { oldPath, newName } = req.body;

    const client = connectedClients.get(id);
    if (!client) {
        return res.status(404).json({ error: 'Client not connected' });
    }

    try {
        const result = await sendToClient(id, {
            type: 'rename_file',
            oldPath: oldPath,
            newName: newName,
            requestId: generateRequestId()
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create folder on client
app.post('/api/client/:id/mkdir', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { path: dirPath } = req.body;

    const client = connectedClients.get(id);
    if (!client) {
        return res.status(404).json({ error: 'Client not connected' });
    }

    try {
        const result = await sendToClient(id, {
            type: 'create_folder',
            path: dirPath,
            requestId: generateRequestId()
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Download file from client (client sends file data)
app.post('/api/client/:id/download', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { path: filePath } = req.body;

    const client = connectedClients.get(id);
    if (!client) {
        return res.status(404).json({ error: 'Client not connected' });
    }

    try {
        const result = await sendToClient(id, {
            type: 'download_file',
            path: filePath,
            requestId: generateRequestId()
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Upload file to client
app.post('/api/client/:id/upload', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { path: destPath, content, name } = req.body;

    const client = connectedClients.get(id);
    if (!client) {
        return res.status(404).json({ error: 'Client not connected' });
    }

    try {
        const result = await sendToClient(id, {
            type: 'upload_file',
            path: destPath,
            name: name,
            content: content,  // base64 encoded
            requestId: generateRequestId()
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// HELPER: Send message to client and wait for response
// ============================================================
function generateRequestId() {
    return crypto.randomBytes(8).toString('hex');
}

function isStreamEvent(type, data) {
    if (!type) return false;
    const payload = data && data.data ? data.data : data;
    const streamTypes = [
        'command_output',
        'command_exit',
        'stream_frame',
        'stream_audio',
        'stream_error',
        'download_file_chunk',
        'download_file_error',
    ];
    if (streamTypes.includes(type)) return true;
    if (type === 'upload_file_response') {
        return payload && payload.chunk_index !== undefined && !payload.is_last;
    }
    return false;
}

function shouldKeepPending(type, data) {
    if (!type) return false;
    const payload = data && data.data ? data.data : data;
    if (type === 'download_file_response' && payload && payload.status === 'streaming') return true;
    if (type === 'command_response' && payload && payload.status === 'started') return true;
    if (type === 'upload_file_response' && payload && payload.chunk_index !== undefined && !payload.is_last) return true;
    if (isStreamEvent(type, data)) return true;
    return false;
}

function createAdminForward(type, pending, message) {
    const payload = {
        type: type,
        requestId: message.requestId,
        clientId: pending.clientId,
        originalType: pending.command || message.type,
        eventType: message.type,
        data: message,
    };
    if (message.type === 'command_response' || message.type.endsWith('_response')) {
        payload.data = message.data !== undefined ? message.data : message;
    }
    return payload;
}

function broadcastClientEvent(clientId, message) {
    broadcastToAdmins({
        type: 'command_event',
        requestId: message.requestId || message.streamId || null,
        clientId,
        originalType: message.type,
        eventType: message.type,
        data: message,
    });
}

function sendToClient(clientId, message, options = {}) {
    return new Promise((resolve, reject) => {
        const client = connectedClients.get(clientId);
        if (!client || !client.ws || client.ws.readyState !== 1) {
            return reject(new Error('Client not connected'));
        }

        const requestId = message.requestId || message.id || generateRequestId();
        message.requestId = requestId;

        const timeout = setTimeout(() => {
            const pending = pendingRequests.get(requestId);
            pendingRequests.delete(requestId);
            reject(new Error('Request timeout'));
        }, 30000);

        pendingRequests.set(requestId, {
            resolve,
            reject,
            timeout,
            adminWs: options.adminWs,
            clientId,
            command: options.command,
            keepAlive: false,
        });

        client.ws.send(JSON.stringify(message));
    });
}

// ============================================================
// BROADCAST TO ADMINS
// ============================================================
function broadcastToAdmins(data) {
    const msg = JSON.stringify(data);
    for (const ws of adminConnections) {
        if (ws.readyState === 1) {
            ws.send(msg);
        }
    }
}

// ============================================================
// HTTP / HTTPS SERVER
// ============================================================
let server;
if (CONFIG.https && CONFIG.https.enabled && CONFIG.https.key && CONFIG.https.cert) {
    try {
        const httpsOptions = {
            key: fs.readFileSync(path.resolve(__dirname, CONFIG.https.key)),
            cert: fs.readFileSync(path.resolve(__dirname, CONFIG.https.cert)),
        };
        server = https.createServer(httpsOptions, app);
    } catch (err) {
        console.error('HTTPS setup failed:', err.message);
        server = http.createServer(app);
    }
} else {
    server = http.createServer(app);
}

// ============================================================
// WEBSOCKET SERVER - Bridge Clients
// ============================================================
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
    let clientId = null;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw.toString());
            const type = data.type;

            // Client registration
            if (type === 'register') {
                if (CONFIG.clientToken && data.authToken !== CONFIG.clientToken) {
                    console.warn('[WS Client] Invalid auth token from', clientIp);
                    ws.send(JSON.stringify({ type: 'auth_failed', error: 'Invalid auth token' }));
                    ws.close();
                    return;
                }

                clientId = data.id || crypto.randomBytes(4).toString('hex');
                connectedClients.set(clientId, {
                    ws,
                    info: {
                        name: data.name || 'Unknown',
                        hostname: data.hostname || 'Unknown',
                        systemInfo: data.systemInfo || {},
                        ip: clientIp
                    },
                    lastSeen: Date.now()
                });

                console.log(`[+] Client connected: ${data.name} (${clientId})`);

                // Notify admins
                broadcastToAdmins({
                    type: 'client_connected',
                    client: {
                        id: clientId,
                        name: data.name,
                        hostname: data.hostname,
                        systemInfo: data.systemInfo,
                        ip: clientIp,
                        online: true
                    }
                });
                return;
            }

            // Heartbeat
            if (type === 'heartbeat') {
                if (clientId && connectedClients.has(clientId)) {
                    const c = connectedClients.get(clientId);
                    c.lastSeen = Date.now();
                }
                ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
                return;
            }

            // Pong response
            if (type === 'pong') {
                const reqId = data.id;
                if (pendingRequests.has(reqId)) {
                    const pending = pendingRequests.get(reqId);
                    clearTimeout(pending.timeout);
                    pendingRequests.delete(reqId);
                    pending.resolve({ success: true });
                }
                return;
            }

            if (clientId && isStreamEvent(type, data) && !data.requestId) {
                broadcastClientEvent(clientId, data);
                return;
            }

            // All other responses with requestId
            if (data.requestId && pendingRequests.has(data.requestId)) {
                const pending = pendingRequests.get(data.requestId);
                const messageType = data.type;
                const isStream = isStreamEvent(messageType, data);

                if (pending.adminWs && pending.adminWs.readyState === 1 && isStream) {
                    const eventPayload = createAdminForward('command_event', pending, data);
                    pending.adminWs.send(JSON.stringify(eventPayload));
                }

                if (isStream) {
                    const streamPayload = data.data !== undefined ? data.data : data;
                    if (messageType === 'command_exit' && pending.keepAlive) {
                        clearTimeout(pending.timeout);
                        pendingRequests.delete(data.requestId);
                    }
                    if (messageType === 'download_file_chunk' && streamPayload && streamPayload.is_last) {
                        clearTimeout(pending.timeout);
                        pendingRequests.delete(data.requestId);
                    }
                    if (messageType === 'download_file_error' || messageType === 'stream_error') {
                        clearTimeout(pending.timeout);
                        pendingRequests.delete(data.requestId);
                    }
                    return;
                }

                const finalData = data.data !== undefined ? data.data : data;
                clearTimeout(pending.timeout);

                if (shouldKeepPending(messageType, data)) {
                    pending.keepAlive = true;
                } else {
                    pendingRequests.delete(data.requestId);
                }

                pending.resolve(finalData);
                return;
            }

        } catch (err) {
            console.error('[WS Client Error]', err.message);
        }
    });

    ws.on('close', () => {
        if (clientId) {
            console.log(`[-] Client disconnected: ${clientId}`);
            connectedClients.delete(clientId);
            broadcastToAdmins({
                type: 'client_disconnected',
                clientId
            });
        }
    });

    ws.on('error', (err) => {
        console.error('[WS Client Error]', err.message);
    });
});

// ============================================================
// WEBSOCKET SERVER - Admin Dashboard
// ============================================================
const adminWss = new WebSocketServer({ noServer: true });

adminWss.on('connection', (ws, req) => {
    // Simple token auth on first message
    let authenticated = false;

    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw.toString());

            // Auth
            if (data.type === 'auth' && !authenticated) {
                if (sessions.has(data.token)) {
                    authenticated = true;
                    adminConnections.add(ws);
                    ws.send(JSON.stringify({ type: 'auth_success' }));

                    // Send current client list
                    const clients = [];
                    for (const [id, client] of connectedClients) {
                        clients.push({
                            id,
                            name: client.info?.name || 'Unknown',
                            hostname: client.info?.hostname || 'Unknown',
                            systemInfo: client.info?.systemInfo || {},
                            online: Date.now() - client.lastSeen < CONFIG.heartbeatTimeout,
                            ip: client.info?.ip || 'Unknown'
                        });
                    }
                    ws.send(JSON.stringify({ type: 'client_list', clients }));
                } else {
                    ws.send(JSON.stringify({ type: 'auth_failed' }));
                    ws.close();
                }
                return;
            }

            if (!authenticated) {
                ws.close();
                return;
            }

            // Forward commands to bridge clients
            if (data.clientId && data.command) {
                const client = connectedClients.get(data.clientId);
                if (client && client.ws.readyState === 1) {
                    const requestId = data.params?.requestId || generateRequestId();
                    data.params = data.params || {};
                    data.params.requestId = requestId;

                    sendToClient(data.clientId, {
                        type: data.command,
                        requestId,
                        ...data.params
                    }, {
                        adminWs: ws,
                        command: data.command
                    }).then((result) => {
                        if (ws.readyState === 1) {
                            ws.send(JSON.stringify({
                                type: 'command_result',
                                requestId,
                                data: result,
                                originalType: data.command
                            }));
                        }
                    }).catch((err) => {
                        if (ws.readyState === 1) {
                            ws.send(JSON.stringify({
                                type: 'command_result',
                                requestId,
                                data: { error: err.message },
                                originalType: data.command
                            }));
                        }
                    });
                }
            }

        } catch (err) {
            console.error('[WS Admin Error]', err.message);
        }
    });

    ws.on('close', () => {
        adminConnections.delete(ws);
    });
});

// ============================================================
// UPGRADE HANDLER - Route WebSocket connections
// ============================================================
server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/ws') {
        // Bridge client connection
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    } else if (url.pathname === '/admin') {
        // Admin dashboard connection
        adminWss.handleUpgrade(req, socket, head, (ws) => {
            adminWss.emit('connection', ws, req);
        });
    } else {
        socket.destroy();
    }
});

// ============================================================
// SERVE DASHBOARD
// ============================================================
app.use(express.static(path.join(__dirname, 'public')));
app.get('/favicon.ico', (_req, res) => res.sendStatus(204));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// START SERVER
// ============================================================
server.listen(CONFIG.port, CONFIG.host, () => {
    const protocol = CONFIG.https && CONFIG.https.enabled ? 'https' : 'http';
    const hostLabel = CONFIG.host === '0.0.0.0' ? 'localhost' : CONFIG.host;
    const externalBase = CONFIG.publicUrl ? CONFIG.publicUrl.replace(/\/$/, '') : `${protocol}://${hostLabel}:${CONFIG.port}`;
    const externalWs = externalBase.replace(/^https?/, protocol === 'https' ? 'wss' : 'ws') + '/ws';
    const externalAdminWs = externalBase.replace(/^https?/, protocol === 'https' ? 'wss' : 'ws') + '/admin';

    console.log('');
    console.log('  🌉 File Bridge Server');
    console.log('  ─────────────────────');
    console.log('  Dashboard: ' + externalBase);
    console.log('  Bridge WS: ' + externalWs);
    console.log('  Admin WS:  ' + externalAdminWs);
    if (CONFIG.publicUrl) {
        console.log('  Public URL: ' + CONFIG.publicUrl);
    }
    console.log('  Password:  ' + CONFIG.password);
    console.log('');
});

