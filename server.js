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

// Progressive rate limiting stages
const RATE_LIMIT_MAX_EVENTS_PER_SECOND = 25;  // Normal drawing limit
const RATE_LIMIT_MAX_EVENTS_PER_10_SECONDS = 100;  // 10 second window limit
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_WINDOW_10S_MS = 10000;

// Progressive thresholds (events per second)
const RATE_LIMIT_WARNING_THRESHOLD = 35;   // Start warning at 45/sec
const RATE_LIMIT_THROTTLE_THRESHOLD = 45;  // Throttle at 55/sec
const RATE_LIMIT_PAUSE_THRESHOLD = 60;     // Pause at 70/sec

// Violation tracking for disconnection
const RATE_LIMIT_MAX_VIOLATIONS = 5;  // Need 5 serious violations before disconnect
const RATE_LIMIT_VIOLATION_WINDOW_MS = 10000;  // 10 second window (reduced from 30s)
const RATE_LIMIT_VIOLATION_DECAY_MS = 3000;  // Violations decay after 3 seconds of good behavior

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
        drawingEventTimestamps10s: [],
        rateLimitViolations: 0,
        violationTimestamps: [],
        isPaused: false,
        pausedUntil: 0
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
        
        // Admin users bypass all rate limiting
        if (clientData && clientData.isAdmin) {
            drawingData.push(data);
            socket.broadcast.emit('drawing', data);
            return;
        }
        
        // Check if user is currently paused
        if (session.isPaused && now < session.pausedUntil) {
            const remainingMs = session.pausedUntil - now;
            console.log(`[drawing] User ${socket.id} is paused for ${Math.ceil(remainingMs / 1000)}s more`);
            return;
        } else if (session.isPaused && now >= session.pausedUntil) {
            // Unpause user
            session.isPaused = false;
            session.pausedUntil = 0;
            console.log(`[drawing] User ${socket.id} unpause period expired, drawing allowed again`);
        }
        
        // Track drawing events
        session.drawingEventTimestamps.push(now);
        session.drawingEventTimestamps10s.push(now);
        
        // Clean up old timestamps
        session.drawingEventTimestamps = session.drawingEventTimestamps.filter(
            timestamp => now - timestamp < RATE_LIMIT_WINDOW_MS
        );
        
        session.drawingEventTimestamps10s = session.drawingEventTimestamps10s.filter(
            timestamp => now - timestamp < RATE_LIMIT_WINDOW_10S_MS
        );
        
        const eventsPerSecond = session.drawingEventTimestamps.length;
        const eventsPer10Seconds = session.drawingEventTimestamps10s.length;
        
        // Clean up old violations (fast decay)
        session.violationTimestamps = session.violationTimestamps.filter(
            timestamp => now - timestamp < RATE_LIMIT_VIOLATION_WINDOW_MS
        );
        
        // Stage 1: Normal operation
        if (eventsPerSecond <= RATE_LIMIT_MAX_EVENTS_PER_SECOND && 
            eventsPer10Seconds <= RATE_LIMIT_MAX_EVENTS_PER_10_SECONDS) {
            // Good behavior - allow drawing
            drawingData.push(data);
            socket.broadcast.emit('drawing', data);
            return;
        }
        
        // Stage 2: Slightly over limit (35-45/sec) - Warning only
        if (eventsPerSecond <= RATE_LIMIT_WARNING_THRESHOLD) {
            // Still allow drawing, just log warning
            console.log(`[drawing] ⚠️  Approaching limit for ${socket.id} - ${eventsPerSecond}/sec`);
            drawingData.push(data);
            socket.broadcast.emit('drawing', data);
            return;
        }
        
        // Stage 3: Moderate excess (45-55/sec) - Throttle
        if (eventsPerSecond <= RATE_LIMIT_THROTTLE_THRESHOLD) {
            // Allow every other event through
            const shouldAllow = eventsPerSecond % 2 === 0;
            if (shouldAllow) {
                console.log(`[drawing] 🐌 Throttling ${socket.id} - ${eventsPerSecond}/sec`);
                drawingData.push(data);
                socket.broadcast.emit('drawing', data);
            }
            return;
        }
        
        // Stage 4: High excess (55-70/sec) - Start tracking violations, temp pause
        if (eventsPerSecond <= RATE_LIMIT_PAUSE_THRESHOLD) {
            session.violationTimestamps.push(now);
            const violationCount = session.violationTimestamps.length;
            
            if (violationCount >= 2) {
                // Pause after 2 violations
                session.isPaused = true;
                session.pausedUntil = now + 3000; // 3 second pause
                console.log(`[drawing] ⏸️  Pausing ${socket.id} for 3s - violations: ${violationCount}/${RATE_LIMIT_MAX_VIOLATIONS}`);
                socket.emit('rateLimitWarning', {
                    message: 'Please slow down! Paused for 3 seconds.',
                    violations: violationCount,
                    maxViolations: RATE_LIMIT_MAX_VIOLATIONS,
                    pauseDuration: 3
                });
            } else {
                console.log(`[drawing] ⚠️  High rate for ${socket.id} - ${eventsPerSecond}/sec (violation ${violationCount}/${RATE_LIMIT_MAX_VIOLATIONS})`);
            }
            return;
        }
        
        // Stage 5: Extreme excess (>70/sec) - Serious violation
        session.violationTimestamps.push(now);
        const violationCount = session.violationTimestamps.length;
        
        if (violationCount >= RATE_LIMIT_MAX_VIOLATIONS) {
            // Disconnect after max violations
            console.log(`[drawing] 🚫 Disconnecting ${socket.id} - ${violationCount} serious violations in 10s window`);
            socket.emit('rateLimitDisconnect', {
                message: 'Disconnected: Too many rate limit violations',
                violations: violationCount
            });
            socket.disconnect(true);
            return;
        }
        
        // Long pause for extreme rate
        session.isPaused = true;
        session.pausedUntil = now + 5000; // 5 second pause
        console.log(`[drawing] ⏸️  Pausing ${socket.id} for 5s (extreme rate: ${eventsPerSecond}/sec) - violations: ${violationCount}/${RATE_LIMIT_MAX_VIOLATIONS}`);
        socket.emit('rateLimitWarning', {
            message: 'Excessive drawing speed! Paused for 5 seconds.',
            violations: violationCount,
            maxViolations: RATE_LIMIT_MAX_VIOLATIONS,
            pauseDuration: 5
        });
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
    
    // Admin users bypass all rate limiting
    if (clientData && clientData.isAdmin) {
        socket.broadcast.emit(eventName, data);
        return;
    }
    
    // Check if user is currently paused
    if (session.isPaused && now < session.pausedUntil) {
        const remainingMs = session.pausedUntil - now;
        console.log(`[${eventName}] User ${socket.id} is paused for ${Math.ceil(remainingMs / 1000)}s more`);
        return;
    } else if (session.isPaused && now >= session.pausedUntil) {
        // Unpause user
        session.isPaused = false;
        session.pausedUntil = 0;
        console.log(`[${eventName}] User ${socket.id} unpause period expired, drawing allowed again`);
    }
    
    // Track drawing events
    session.drawingEventTimestamps.push(now);
    session.drawingEventTimestamps10s.push(now);
    
    // Clean up old timestamps
    session.drawingEventTimestamps = session.drawingEventTimestamps.filter(
        timestamp => now - timestamp < RATE_LIMIT_WINDOW_MS
    );
    
    session.drawingEventTimestamps10s = session.drawingEventTimestamps10s.filter(
        timestamp => now - timestamp < RATE_LIMIT_WINDOW_10S_MS
    );
    
    const eventsPerSecond = session.drawingEventTimestamps.length;
    const eventsPer10Seconds = session.drawingEventTimestamps10s.length;
    
    // Clean up old violations (fast decay)
    session.violationTimestamps = session.violationTimestamps.filter(
        timestamp => now - timestamp < RATE_LIMIT_VIOLATION_WINDOW_MS
    );
    
    // Stage 1: Normal operation
    if (eventsPerSecond <= RATE_LIMIT_MAX_EVENTS_PER_SECOND && 
        eventsPer10Seconds <= RATE_LIMIT_MAX_EVENTS_PER_10_SECONDS) {
        // Good behavior - allow drawing
        socket.broadcast.emit(eventName, data);
        return;
    }
    
    // Stage 2: Slightly over limit (35-45/sec) - Warning only
    if (eventsPerSecond <= RATE_LIMIT_WARNING_THRESHOLD) {
        // Still allow drawing, just log warning
        console.log(`[${eventName}] ⚠️  Approaching limit for ${socket.id} - ${eventsPerSecond}/sec`);
        socket.broadcast.emit(eventName, data);
        return;
    }
    
    // Stage 3: Moderate excess (45-55/sec) - Throttle
    if (eventsPerSecond <= RATE_LIMIT_THROTTLE_THRESHOLD) {
        // Allow every other event through
        const shouldAllow = eventsPerSecond % 2 === 0;
        if (shouldAllow) {
            console.log(`[${eventName}] 🐌 Throttling ${socket.id} - ${eventsPerSecond}/sec`);
            socket.broadcast.emit(eventName, data);
        }
        return;
    }
    
    // Stage 4: High excess (55-70/sec) - Start tracking violations, temp pause
    if (eventsPerSecond <= RATE_LIMIT_PAUSE_THRESHOLD) {
        session.violationTimestamps.push(now);
        const violationCount = session.violationTimestamps.length;
        
        if (violationCount >= 2) {
            // Pause after 2 violations
            session.isPaused = true;
            session.pausedUntil = now + 3000; // 3 second pause
            console.log(`[${eventName}] ⏸️  Pausing ${socket.id} for 3s - violations: ${violationCount}/${RATE_LIMIT_MAX_VIOLATIONS}`);
            socket.emit('rateLimitWarning', {
                message: 'Please slow down! Paused for 3 seconds.',
                violations: violationCount,
                maxViolations: RATE_LIMIT_MAX_VIOLATIONS,
                pauseDuration: 3
            });
        } else {
            console.log(`[${eventName}] ⚠️  High rate for ${socket.id} - ${eventsPerSecond}/sec (violation ${violationCount}/${RATE_LIMIT_MAX_VIOLATIONS})`);
        }
        return;
    }
    
    // Stage 5: Extreme excess (>70/sec) - Serious violation
    session.violationTimestamps.push(now);
    const violationCount = session.violationTimestamps.length;
    
    if (violationCount >= RATE_LIMIT_MAX_VIOLATIONS) {
        // Disconnect after max violations
        console.log(`[${eventName}] 🚫 Disconnecting ${socket.id} - ${violationCount} serious violations in 10s window`);
        socket.emit('rateLimitDisconnect', {
            message: 'Disconnected: Too many rate limit violations',
            violations: violationCount
        });
        socket.disconnect(true);
        return;
    }
    
    // Long pause for extreme rate
    session.isPaused = true;
    session.pausedUntil = now + 5000; // 5 second pause
    console.log(`[${eventName}] ⏸️  Pausing ${socket.id} for 5s (extreme rate: ${eventsPerSecond}/sec) - violations: ${violationCount}/${RATE_LIMIT_MAX_VIOLATIONS}`);
    socket.emit('rateLimitWarning', {
        message: 'Excessive drawing speed! Paused for 5 seconds.',
        violations: violationCount,
        maxViolations: RATE_LIMIT_MAX_VIOLATIONS,
        pauseDuration: 5
    });
}

server.listen(PORT, () => {
    console.log(`🖍️  Whiteboard server running on port ${PORT}`);
    console.log(`   Local:    http://localhost:${PORT}`);
    console.log(`   Network:  http://[your-ip]:${PORT}`);
});
