const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Store drawing data in memory
let drawingData = [];

// Admin configuration
const ADMIN_CODE = 19931993;
const RESET_COOLDOWN_MS = 5 * 60 * 1000;

const RATE_LIMIT_MAX_EVENTS = 60;
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_DISCONNECT_THRESHOLD = 3;

const MIN_ATTEMPT_INTERVAL_MS = 5 * 1000;
const MAX_FAILED_ATTEMPTS = 3;
const FAILED_ATTEMPTS_WINDOW_MS = 10 * 60 * 1000;
const BLOCK_DURATION_MS = 10 * 60 * 1000;

const BACKOFF_DELAYS_MS = [
    5 * 1000,
    30 * 1000,
    5 * 60 * 1000
];

const adminAttempts = new Map();

let drawingLocked = false;
let resetLocked = false;

const clientIdentities = new Map();
const sessionData = new Map();
const lastClearByClient = new Map();

// Generate random colors for users
const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
    '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
    '#F8C471', '#82E0AA', '#F1948A', '#85C1E9', '#D7BDE2'
];

function getRandomColor() {
    return colors[Math.floor(Math.random() * colors.length)];
}

io.on('connection', (socket) => {
    console.log(`[connection] User connected: ${socket.id}`);
    
    const now = Date.now();
    clientIdentities.set(socket.id, { clientId: null, color: null, isAdmin: false });
    sessionData.set(socket.id, {
        sessionId: socket.id,
        connectedAt: now,
        lastActivity: now,
        drawingEventTimestamps: [],
        rateLimitViolations: 0
    });
    
    socket.emit('loadDrawing', drawingData);
    socket.emit('lockStateUpdate', { drawingLocked, resetLocked });
    socket.emit('drawing-lock-state', { locked: drawingLocked });
    
    // Handle client identity
    socket.on('clientIdentity', (data) => {
        const { clientId, color } = data;
        clientIdentities.set(socket.id, { clientId, color, isAdmin: false });
        
        // Send the user their color
        socket.emit('userColor', color);
        
        console.log(`[clientIdentity] Client identified: ${clientId} with color ${color} (socket: ${socket.id})`);
    });
    
    socket.on('admin-auth', (data) => {
        const { code, clientId } = data;
        const now = Date.now();
        
        console.log(`[adminAuth] Received auth attempt - code: ${code}, clientId: ${clientId}`);
        
        // Convert code to number and validate
        const numericCode = Number(code);
        
        // Validate input
        if (!clientId || Number.isNaN(numericCode)) {
            console.log(`[adminAuth] Rejected - Invalid clientId or NaN code`);
            socket.emit('adminAuthFailed', { 
                message: 'Admin code invalid or temporarily blocked' 
            });
            return;
        }
        
        // Get or initialize attempt tracking for this client
        if (!adminAttempts.has(clientId)) {
            adminAttempts.set(clientId, {
                lastTry: 0,
                failedAttempts: [],
                blockedUntil: null
            });
        }
        
        const attemptData = adminAttempts.get(clientId);
        
        // Check if client is currently blocked
        if (attemptData.blockedUntil && now < attemptData.blockedUntil) {
            const remainingSeconds = Math.ceil((attemptData.blockedUntil - now) / 1000);
            socket.emit('adminAuthFailed', { 
                message: 'Admin code invalid or temporarily blocked',
                remainingSeconds // For client-side UI feedback
            });
            console.log(`[adminAuth] Blocked admin attempt from ${clientId}: ${remainingSeconds}s remaining`);
            return;
        }
        
        // Clear block if expired
        if (attemptData.blockedUntil && now >= attemptData.blockedUntil) {
            attemptData.blockedUntil = null;
            attemptData.failedAttempts = [];
        }
        
        // Check minimum time between attempts (rate limiting)
        const timeSinceLastTry = now - attemptData.lastTry;
        
        // Calculate required delay based on backoff
        const failedCount = attemptData.failedAttempts.filter(
            timestamp => now - timestamp < FAILED_ATTEMPTS_WINDOW_MS
        ).length;
        const requiredDelay = failedCount > 0 && failedCount <= BACKOFF_DELAYS_MS.length
            ? BACKOFF_DELAYS_MS[failedCount - 1]
            : MIN_ATTEMPT_INTERVAL_MS;
        
        if (timeSinceLastTry < requiredDelay) {
            const remainingSeconds = Math.ceil((requiredDelay - timeSinceLastTry) / 1000);
            socket.emit('adminAuthFailed', { 
                message: 'Admin code invalid or temporarily blocked',
                remainingSeconds
            });
            console.log(`[adminAuth] Rate limit for ${clientId}: ${remainingSeconds}s remaining`);
            return;
        }
        
        // Update last try time
        attemptData.lastTry = now;
        
        // Validate admin code
        if (numericCode === ADMIN_CODE) {
            // Success - clear failed attempts and grant admin access
            attemptData.failedAttempts = [];
            attemptData.blockedUntil = null;
            adminAttempts.set(clientId, attemptData);
            
            const clientData = clientIdentities.get(socket.id);
            if (clientData) {
                clientData.isAdmin = true;
                clientIdentities.set(socket.id, clientData);
                socket.emit('adminAuthSuccess');
                socket.emit('admin-auth-success');
                console.log(`[adminAuth] Admin authenticated: ${clientId} (socket: ${socket.id})`);
            }
        } else {
            // Failed attempt - track it
            attemptData.failedAttempts.push(now);
            
            // Clean up old failed attempts outside the window
            attemptData.failedAttempts = attemptData.failedAttempts.filter(
                timestamp => now - timestamp < FAILED_ATTEMPTS_WINDOW_MS
            );
            
            // Check if max failed attempts reached
            if (attemptData.failedAttempts.length >= MAX_FAILED_ATTEMPTS) {
                attemptData.blockedUntil = now + BLOCK_DURATION_MS;
                const blockMinutes = Math.ceil(BLOCK_DURATION_MS / 60000);
                console.log(`[adminAuth] Client ${clientId} blocked for ${blockMinutes} minutes after ${MAX_FAILED_ATTEMPTS} failed attempts`);
            }
            
            adminAttempts.set(clientId, attemptData);
            
            socket.emit('adminAuthFailed', { 
                message: 'Admin code invalid or temporarily blocked'
            });
            console.log(`[adminAuth] Failed admin auth attempt from: ${clientId} (${attemptData.failedAttempts.length} recent failures)`);
        }
    });
    
    socket.on('admin-set-drawing-lock', (data) => {
        const clientData = clientIdentities.get(socket.id);
        
        if (!clientData || !clientData.isAdmin) {
            console.log(`[admin-set-drawing-lock] Unauthorized attempt from: ${socket.id}`);
            return;
        }
        
        const locked = data.locked;
        drawingLocked = locked;
        resetLocked = locked;
        
        io.emit('lockStateUpdate', { drawingLocked, resetLocked });
        io.emit('drawing-lock-state', { locked: drawingLocked });
        
        console.log(`[admin-set-drawing-lock] Drawing lock set to: ${locked} by admin ${socket.id}`);
    });
    
    socket.on('admin-list-clients', () => {
        const clientData = clientIdentities.get(socket.id);
        
        if (!clientData || !clientData.isAdmin) {
            console.log(`[admin-list-clients] Unauthorized attempt from: ${socket.id}`);
            return;
        }
        
        const clients = [];
        for (const [socketId, session] of sessionData.entries()) {
            const identity = clientIdentities.get(socketId);
            clients.push({
                sessionId: session.sessionId,
                socketId: socketId,
                connectedAt: session.connectedAt,
                isAdmin: identity ? identity.isAdmin : false,
                rateLimited: session.rateLimitViolations > 0
            });
        }
        
        socket.emit('admin-clients', clients);
        console.log(`[admin-list-clients] Sent client list to admin ${socket.id}`);
    });
    
    socket.on('admin-kick-client', (data) => {
        const clientData = clientIdentities.get(socket.id);
        
        if (!clientData || !clientData.isAdmin) {
            console.log(`[admin-kick-client] Unauthorized attempt from: ${socket.id}`);
            socket.emit('admin-kick-result', { success: false, message: 'Unauthorized' });
            return;
        }
        
        const targetSocketId = data.socketId || data.sessionId;
        
        if (!targetSocketId) {
            socket.emit('admin-kick-result', { success: false, message: 'No socketId provided' });
            return;
        }
        
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
            targetSocket.disconnect(true);
            socket.emit('admin-kick-result', { success: true, socketId: targetSocketId });
            console.log(`[admin-kick-client] Admin ${socket.id} kicked client ${targetSocketId}`);
        } else {
            socket.emit('admin-kick-result', { success: false, message: 'Client not found' });
        }
    });
    
    socket.on('toggleLock', (lockState) => {
        const clientData = clientIdentities.get(socket.id);
        
        if (!clientData || !clientData.isAdmin) {
            return;
        }
        
        drawingLocked = lockState;
        resetLocked = lockState;
        
        io.emit('lockStateUpdate', { drawingLocked, resetLocked });
        io.emit('drawing-lock-state', { locked: drawingLocked });
    });
    
    socket.on('drawing', (data) => {
        const clientData = clientIdentities.get(socket.id);
        const session = sessionData.get(socket.id);
        
        if (drawingLocked && (!clientData || !clientData.isAdmin)) {
            return;
        }
        
        if (!session) {
            return;
        }
        
        const now = Date.now();
        session.lastActivity = now;
        
        if (!clientData || !clientData.isAdmin) {
            session.drawingEventTimestamps.push(now);
            
            session.drawingEventTimestamps = session.drawingEventTimestamps.filter(
                timestamp => now - timestamp < RATE_LIMIT_WINDOW_MS
            );
            
            if (session.drawingEventTimestamps.length > RATE_LIMIT_MAX_EVENTS) {
                session.rateLimitViolations++;
                
                if (session.rateLimitViolations >= RATE_LIMIT_DISCONNECT_THRESHOLD) {
                    console.log(`[drawing] Rate limit exceeded, disconnecting: ${socket.id}`);
                    socket.disconnect(true);
                    return;
                }
                
                console.log(`[drawing] Rate limit exceeded for: ${socket.id}`);
                return;
            } else {
                session.rateLimitViolations = 0;
            }
        }
        
        drawingData.push(data);
        socket.broadcast.emit('drawing', data);
    });
    
    socket.on('draw-start', (data) => {
        handleDrawingEvent(socket, data, 'draw-start');
    });
    
    socket.on('draw-move', (data) => {
        handleDrawingEvent(socket, data, 'draw-move');
    });
    
    socket.on('draw-end', (data) => {
        handleDrawingEvent(socket, data, 'draw-end');
    });
    
    // Handle canvas reset with rate limiting
    socket.on('resetCanvas', (data) => {
        const clientData = clientIdentities.get(socket.id);
        const clientId = data?.clientId || clientData?.clientId || socket.id;
        
        console.log(`[resetCanvas] Reset request from clientId: ${clientId}, socket: ${socket.id}, isAdmin: ${clientData?.isAdmin || false}`);
        
        if (!clientId) {
            console.log(`[resetCanvas] Rejected - Invalid client identity`);
            socket.emit('resetRejected', 'Invalid client identity');
            return;
        }
        
        // Check if reset is locked for non-admins
        if (resetLocked && (!clientData || !clientData.isAdmin)) {
            socket.emit('resetRejected', 'Reset is locked by admin');
            console.log(`[resetCanvas] Reset blocked for non-admin: ${socket.id}`);
            return;
        }
        
        // Check rate limiting for non-admins
        if (!clientData?.isAdmin) {
            const lastResetTime = lastClearByClient.get(clientId);
            const now = Date.now();
            
            if (lastResetTime) {
                const timeSinceLastReset = now - lastResetTime;
                
                if (timeSinceLastReset < RESET_COOLDOWN_MS) {
                    const remainingTime = Math.ceil((RESET_COOLDOWN_MS - timeSinceLastReset) / 1000);
                    socket.emit('resetCooldown', { remainingTime });
                    console.log(`[resetCanvas] Reset cooldown active for ${clientId}: ${remainingTime}s remaining`);
                    return;
                }
            }
            
            // Update last reset time for this client
            lastClearByClient.set(clientId, now);
        }
        
        // Reset the canvas
        drawingData = [];
        io.emit('resetCanvas');
        console.log(`[resetCanvas] Canvas reset by ${clientData?.isAdmin ? 'admin' : 'user'}: ${clientId}`);
    });
    
    socket.on('disconnect', () => {
        console.log(`[disconnect] User disconnected: ${socket.id}`);
        clientIdentities.delete(socket.id);
        sessionData.delete(socket.id);
    });
});

function handleDrawingEvent(socket, data, eventName) {
    const clientData = clientIdentities.get(socket.id);
    const session = sessionData.get(socket.id);
    
    if (drawingLocked && (!clientData || !clientData.isAdmin)) {
        return;
    }
    
    if (!session) {
        return;
    }
    
    const now = Date.now();
    session.lastActivity = now;
    
    if (!clientData || !clientData.isAdmin) {
        session.drawingEventTimestamps.push(now);
        
        session.drawingEventTimestamps = session.drawingEventTimestamps.filter(
            timestamp => now - timestamp < RATE_LIMIT_WINDOW_MS
        );
        
        if (session.drawingEventTimestamps.length > RATE_LIMIT_MAX_EVENTS) {
            session.rateLimitViolations++;
            
            if (session.rateLimitViolations >= RATE_LIMIT_DISCONNECT_THRESHOLD) {
                console.log(`[${eventName}] Rate limit exceeded, disconnecting: ${socket.id}`);
                socket.disconnect(true);
                return;
            }
            
            console.log(`[${eventName}] Rate limit exceeded for: ${socket.id}`);
            return;
        } else {
            session.rateLimitViolations = 0;
        }
    }
    
    socket.broadcast.emit(eventName, data);
}

server.listen(PORT, () => {
    console.log(`🖍️  Whiteboard server running on port ${PORT}`);
    console.log(`   Local:    http://localhost:${PORT}`);
    console.log(`   Network:  http://[your-ip]:${PORT}`);
});
