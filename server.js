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
const ADMIN_CODE = 19931993; // Fixed numeric admin code
const RESET_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes in milliseconds

// Brute-force protection configuration
const MIN_ATTEMPT_INTERVAL_MS = 5 * 1000; // 5 seconds between attempts
const MAX_FAILED_ATTEMPTS = 3; // Max failed attempts before block
const FAILED_ATTEMPTS_WINDOW_MS = 10 * 60 * 1000; // 10-minute window for tracking failures
const BLOCK_DURATION_MS = 10 * 60 * 1000; // 10-minute block after max failures

// Backoff delays after each failed attempt
const BACKOFF_DELAYS_MS = [
    5 * 1000,      // 1st failed attempt: 5 seconds
    30 * 1000,     // 2nd failed attempt: 30 seconds
    5 * 60 * 1000  // 3rd failed attempt: 5 minutes
];

// Track admin authentication attempts per client
const adminAttempts = new Map(); 
// Structure: clientId -> { 
//   lastTry: timestamp, 
//   failedAttempts: [timestamps], 
//   blockedUntil: timestamp | null 
// }

// Global lock state
let drawingLocked = false;
let resetLocked = false;

// Track client identities and their last reset times
const clientIdentities = new Map(); // socketId -> { clientId, color, isAdmin }
const lastClearByClient = new Map(); // clientId -> timestamp

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
    console.log('User connected:', socket.id);
    
    // Initialize client identity for this socket
    clientIdentities.set(socket.id, { clientId: null, color: null, isAdmin: false });
    
    // Send existing drawing data to new user
    socket.emit('loadDrawing', drawingData);
    
    // Send current lock state to new user
    socket.emit('lockStateUpdate', { drawingLocked, resetLocked });
    
    // Handle client identity
    socket.on('clientIdentity', (data) => {
        const { clientId, color } = data;
        clientIdentities.set(socket.id, { clientId, color, isAdmin: false });
        
        // Send the user their color
        socket.emit('userColor', color);
        
        console.log(`Client identified: ${clientId} with color ${color}`);
    });
    
    // Handle admin authentication with brute-force protection
    socket.on('adminAuth', (data) => {
        const { code, clientId } = data;
        const now = Date.now();
        
        // Validate input
        if (!clientId || typeof code !== 'number') {
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
            console.log(`Blocked admin attempt from ${clientId}: ${remainingSeconds}s remaining`);
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
            console.log(`Rate limit for ${clientId}: ${remainingSeconds}s remaining`);
            return;
        }
        
        // Update last try time
        attemptData.lastTry = now;
        
        // Validate admin code
        if (code === ADMIN_CODE) {
            // Success - clear failed attempts and grant admin access
            attemptData.failedAttempts = [];
            attemptData.blockedUntil = null;
            adminAttempts.set(clientId, attemptData);
            
            const clientData = clientIdentities.get(socket.id);
            if (clientData) {
                clientData.isAdmin = true;
                clientIdentities.set(socket.id, clientData);
                socket.emit('adminAuthSuccess');
                console.log(`Admin authenticated: ${clientId} (socket: ${socket.id})`);
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
                console.log(`Client ${clientId} blocked for ${blockMinutes} minutes after ${MAX_FAILED_ATTEMPTS} failed attempts`);
            }
            
            adminAttempts.set(clientId, attemptData);
            
            socket.emit('adminAuthFailed', { 
                message: 'Admin code invalid or temporarily blocked'
            });
            console.log(`Failed admin auth attempt from: ${clientId} (${attemptData.failedAttempts.length} recent failures)`);
        }
    });
    
    // Handle lock toggle (admin only)
    socket.on('toggleLock', (lockState) => {
        const clientData = clientIdentities.get(socket.id);
        
        if (!clientData || !clientData.isAdmin) {
            console.log(`Unauthorized lock toggle attempt from: ${socket.id}`);
            return;
        }
        
        // Update lock states
        drawingLocked = lockState;
        resetLocked = lockState;
        
        // Broadcast new lock state to all clients
        io.emit('lockStateUpdate', { drawingLocked, resetLocked });
        
        console.log(`Board lock toggled to: ${lockState} by admin ${socket.id}`);
    });
    
    // Handle drawing events
    socket.on('drawing', (data) => {
        const clientData = clientIdentities.get(socket.id);
        
        // Check if drawing is locked for non-admins
        if (drawingLocked && (!clientData || !clientData.isAdmin)) {
            console.log(`Drawing blocked for non-admin: ${socket.id}`);
            return;
        }
        
        // Add drawing data to memory
        drawingData.push(data);
        
        // Broadcast to all other clients
        socket.broadcast.emit('drawing', data);
    });
    
    // Handle canvas reset with rate limiting
    socket.on('resetCanvas', (data) => {
        const clientData = clientIdentities.get(socket.id);
        const clientId = data?.clientId || clientData?.clientId;
        
        if (!clientId) {
            socket.emit('resetRejected', 'Invalid client identity');
            return;
        }
        
        // Check if reset is locked for non-admins
        if (resetLocked && (!clientData || !clientData.isAdmin)) {
            socket.emit('resetRejected', 'Reset is locked by admin');
            console.log(`Reset blocked for non-admin: ${socket.id}`);
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
                    console.log(`Reset cooldown active for ${clientId}: ${remainingTime}s remaining`);
                    return;
                }
            }
            
            // Update last reset time for this client
            lastClearByClient.set(clientId, now);
        }
        
        // Reset the canvas
        drawingData = [];
        io.emit('resetCanvas');
        console.log(`Canvas reset by ${clientData?.isAdmin ? 'admin' : 'user'}: ${clientId}`);
    });
    
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        clientIdentities.delete(socket.id);
    });
});

server.listen(PORT, () => {
    console.log(`🖍️  Whiteboard server running on port ${PORT}`);
    console.log(`   Local:    http://localhost:${PORT}`);
    console.log(`   Network:  http://[your-ip]:${PORT}`);
});
