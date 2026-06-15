/**
 * File Bridge - Server Configuration
 * 
 * Edit this file to customize your server.
 * All values here are used by server.js on startup.
 */

module.exports = {

    // ─── NETWORK ──────────────────────────────────────────────
    port: 3000,                          // HTTP + WebSocket port
    host: '0.0.0.0',                     // 0.0.0.0 = all interfaces
    publicUrl: '',                       // Optional public URL that clients should use

    // ─── AUTH ─────────────────────────────────────────────────
    password: 'changeme123',             // ← CHANGE THIS IMMEDIATELY
    sessionTimeout: 86400000,            // 24 hours (ms)
    maxSessions: 50,                     // Max concurrent admin sessions

    // ─── SECURITY ─────────────────────────────────────────────
    rateLimit: {
        windowMs: 60000,                 // 1 minute window
        maxRequests: 100,                // Max requests per window
    },

    // ─── FILE TRANSFER ────────────────────────────────────────
    maxFileSize: 104857600,              // 100 MB max upload/download
    uploadDir: './uploads',              // Temp directory for uploads

    // ─── BRIDGE CLIENTS ───────────────────────────────────────
    heartbeatTimeout: 60000,             // 60s — mark offline if no pulse
    clientReconnectGrace: 120000,        // 2min — keep info after disconnect

    // ─── WEBSOCKET ────────────────────────────────────────────
    ws: {
        pingInterval: 45000,             // 45s — server→client ping
        pingTimeout: 20000,              // 20s — no pong = dead
        maxPayload: 150 * 1024 * 1024,   // 150 MB max WS message
    },

    // ─── LOGGING ──────────────────────────────────────────────
    log: {
        level: 'info',                   // debug | info | warn | error
        file: './server.log',            // null = no file logging
        console: true,                   // Print to terminal
    },

    // ─── HTTPS (optional) ─────────────────────────────────────
    // Uncomment and fill to enable HTTPS
    https: {
        enabled: false,
        cert: './cert.pem',              // Path to SSL certificate
        key: './key.pem',               // Path to SSL private key
    },

    // ─── CORS ─────────────────────────────────────────────────
    cors: {
        enabled: false,
        origins: ['http://localhost:3000'],
    },

    // ─── CUSTOM BRANDING ──────────────────────────────────────
    branding: {
        title: '🌉 File Bridge',
        subtitle: 'Your personal remote control center',
    },

    // ─── STREAMING DEFAULTS (low bandwidth) ───────────────────
    streaming: {
        defaultQuality: 35,            // Eco mode default (10-100)
        defaultFps: 8,                 // Low FPS for bandwidth savings
        defaultResolution: 0.5,        // 50% scale
        audioEnabled: false,           // Audio disabled by default
    },

    // ─── SCREENSHOT DEFAULTS (low bandwidth) ───────────────────
    screenshot: {
        defaultQuality: 30,            // Eco quality for screenshots
    },
};