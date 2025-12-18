// Generate or retrieve persistent client ID
function getOrCreateClientId() {
    let clientId = localStorage.getItem('whiteboardClientId');
    if (!clientId) {
        clientId = 'client_' + Math.random().toString(36).substr(2, 9) + Date.now();
        localStorage.setItem('whiteboardClientId', clientId);
    }
    return clientId;
}

// Generate or retrieve persistent color
function getOrCreateUserColor() {
    let color = localStorage.getItem('whiteboardUserColor');
    if (!color) {
        const colors = [
            '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
            '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
            '#F8C471', '#82E0AA', '#F1948A', '#85C1E9', '#D7BDE2'
        ];
        color = colors[Math.floor(Math.random() * colors.length)];
        localStorage.setItem('whiteboardUserColor', color);
    }
    return color;
}

// Initialize socket connection
const socket = io();

// Canvas setup
const canvas = document.getElementById('whiteboard');
const ctx = canvas.getContext('2d');
const resetBtn = document.getElementById('resetBtn');
const userColorDisplay = document.getElementById('userColorDisplay');
const connectionStatus = document.getElementById('connectionStatus');
const adminPinInput = document.getElementById('adminPinInput');
const adminAuthBtn = document.getElementById('adminAuthBtn');
const lockToggleBtn = document.getElementById('lockToggleBtn');
const lockNotice = document.getElementById('lockNotice');
const cooldownNotice = document.getElementById('cooldownNotice');

// Client identity
const clientId = getOrCreateClientId();
let userColor = getOrCreateUserColor();

// Drawing state
let isDrawing = false;
let lastX = 0;
let lastY = 0;

// Admin state
let isAdmin = false;
let drawingLocked = false;
let resetLocked = false;

// Drawing settings
const BRUSH_SIZE = 3;
const UPDATE_RATE = 33; // ~30fps (1000ms / 30fps = 33ms)

// Throttle drawing updates
let lastDrawTime = 0;

// Client-side rate limiting for immediate throttling (BALANCED LIMITS)
const CLIENT_RATE_LIMIT_WINDOW = 1000; // 1 second window
const CLIENT_RATE_LIMIT_MAX_EVENTS = 25; // Max 25 events per second
const CLIENT_RATE_LIMIT_THROTTLE_THRESHOLD = 20; // Start throttling at 20/sec

// Initial burst protection (allows a few quick strokes at the start)
const CLIENT_INITIAL_BURST_WINDOW = 500; // 500ms initial window - allows initial drawing freedom
const CLIENT_INITIAL_BURST_MAX = 15; // Max 15 events in first 500ms - enough for a few quick strokes
const CLIENT_INITIAL_BURST_WARN = 12; // Warn at 12 events in first 500ms

// Escalating violation tracking
const VIOLATION_MEMORY_DURATION = 30000; // Remember violations for 30 seconds
let violationHistory = [];
let isDrawingPaused = false;
let drawingPauseTimeout = null;
let hasReceivedFirstWarning = false; // Track if user has received their first warning

let clientDrawEvents = [];
let isClientThrottled = false;
let throttleWarningTimeout = null;
let drawingSessionStartTime = null; // Track when drawing session starts

// Initialize canvas
function initCanvas() {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = BRUSH_SIZE;
}

// Get mouse/touch position relative to canvas
function getEventPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    
    let clientX, clientY;
    
    if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    } else {
        clientX = e.clientX;
        clientY = e.clientY;
    }
    
    return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY
    };
}

// Draw line on canvas
function drawLine(x0, y0, x1, y1, color) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
}

// Track violations and add to history
function recordViolation() {
    const now = Date.now();
    violationHistory.push(now);
    
    // Clean up old violations
    violationHistory = violationHistory.filter(
        timestamp => now - timestamp < VIOLATION_MEMORY_DURATION
    );
    
    const recentViolations = violationHistory.length;
    console.log(`[Violation] Recorded - Total in last 30s: ${recentViolations}`);
    
    // First violation is just a gentle warning - no pause
    if (recentViolations === 1 && !hasReceivedFirstWarning) {
        hasReceivedFirstWarning = true;
        showGentleWarning();
        return;
    }
    
    // Escalating consequences for subsequent violations
    if (recentViolations >= 5) {
        // 5+ violations: 30 second pause
        pauseDrawing(30, recentViolations);
    } else if (recentViolations >= 3) {
        // 3-4 violations: 15 second pause
        pauseDrawing(15, recentViolations);
    } else if (recentViolations >= 2) {
        // 2 violations: 5 second pause
        pauseDrawing(5, recentViolations);
    }
}

// Show a gentle first-time warning
function showGentleWarning() {
    // Remove any existing warning
    let existingWarning = document.getElementById('gentleWarning');
    if (existingWarning) {
        existingWarning.remove();
    }
    
    const warningDiv = document.createElement('div');
    warningDiv.id = 'gentleWarning';
    warningDiv.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(52, 152, 219, 0.95);
        color: white;
        padding: 15px 25px;
        border-radius: 8px;
        font-size: 16px;
        font-weight: bold;
        z-index: 10000;
        box-shadow: 0 4px 8px rgba(0,0,0,0.3);
        text-align: center;
        animation: slideDown 0.3s ease-out;
    `;
    
    warningDiv.innerHTML = `
        <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 20px;">ℹ️</span>
            <div>
                <div>Drawing quickly! Try to pace yourself</div>
                <div style="font-size: 12px; opacity: 0.9; margin-top: 4px;">
                    Continued rapid drawing will trigger pauses
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(warningDiv);
    
    // Auto-remove after 3 seconds
    setTimeout(() => {
        warningDiv.style.transition = 'opacity 0.3s, transform 0.3s';
        warningDiv.style.opacity = '0';
        warningDiv.style.transform = 'translateX(-50%) translateY(-20px)';
        setTimeout(() => {
            if (warningDiv.parentNode) {
                warningDiv.remove();
            }
        }, 300);
    }, 3000);
}

// Pause drawing for a specified duration
function pauseDrawing(seconds, violations) {
    if (isDrawingPaused) return; // Already paused
    
    isDrawingPaused = true;
    canvas.style.cursor = 'not-allowed';
    canvas.style.opacity = '0.5';
    
    console.log(`[Drawing Paused] ${seconds} seconds - Violations: ${violations}`);
    
    showDrawingPauseNotification(seconds, violations);
    
    // Clear any existing timeout
    if (drawingPauseTimeout) {
        clearTimeout(drawingPauseTimeout);
    }
    
    // Resume drawing after timeout
    drawingPauseTimeout = setTimeout(() => {
        isDrawingPaused = false;
        canvas.style.cursor = 'crosshair';
        canvas.style.opacity = '1';
        console.log('[Drawing Resumed] Pause period ended');
    }, seconds * 1000);
}

// Show drawing pause notification
function showDrawingPauseNotification(duration, violations) {
    // Remove any existing notification
    let existingNotification = document.getElementById('drawingPauseNotification');
    if (existingNotification) {
        existingNotification.remove();
    }
    
    const notification = document.createElement('div');
    notification.id = 'drawingPauseNotification';
    notification.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: linear-gradient(135deg, rgba(220, 20, 60, 0.95), rgba(178, 34, 34, 0.95));
        color: white;
        padding: 30px 40px;
        border-radius: 15px;
        font-size: 18px;
        font-weight: bold;
        z-index: 10001;
        box-shadow: 0 8px 16px rgba(0,0,0,0.5);
        text-align: center;
        min-width: 350px;
        animation: popIn 0.3s ease-out;
        border: 3px solid rgba(255, 255, 255, 0.3);
    `;
    
    let remainingTime = duration;
    
    const updateNotification = () => {
        notification.innerHTML = `
            <div style="font-size: 48px; margin-bottom: 15px;">🛑</div>
            <div style="font-size: 22px; margin-bottom: 10px;">DRAWING PAUSED</div>
            <div style="font-size: 14px; opacity: 0.9; margin-bottom: 15px;">
                You were drawing too quickly
            </div>
            <div style="font-size: 36px; font-weight: bold; color: #FFD700; margin: 20px 0; text-shadow: 2px 2px 4px rgba(0,0,0,0.3);">
                ${remainingTime}s
            </div>
            <div style="font-size: 13px; opacity: 0.85; margin-top: 10px;">
                Recent violations: ${violations}
            </div>
            <div style="font-size: 12px; opacity: 0.75; margin-top: 8px;">
                Please draw more slowly to avoid longer pauses
            </div>
        `;
    };
    
    // Add pop-in animation
    const style = document.createElement('style');
    style.textContent = `
        @keyframes popIn {
            0% {
                opacity: 0;
                transform: translate(-50%, -50%) scale(0.8);
            }
            50% {
                transform: translate(-50%, -50%) scale(1.05);
            }
            100% {
                opacity: 1;
                transform: translate(-50%, -50%) scale(1);
            }
        }
    `;
    if (!document.head.querySelector('#pauseAnimation')) {
        style.id = 'pauseAnimation';
        document.head.appendChild(style);
    }
    
    updateNotification();
    document.body.appendChild(notification);
    
    // Countdown
    const countdown = setInterval(() => {
        remainingTime--;
        if (remainingTime > 0) {
            updateNotification();
        } else {
            clearInterval(countdown);
            notification.style.transition = 'opacity 0.5s, transform 0.5s';
            notification.style.opacity = '0';
            notification.style.transform = 'translate(-50%, -50%) scale(0.8)';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.remove();
                }
            }, 500);
        }
    }, 1000);
}

// Check if client is drawing too fast and should be throttled
function checkClientRateLimit() {
    const now = Date.now();
    
    // If drawing is paused, block all events
    if (isDrawingPaused) {
        console.log('[checkClientRateLimit] Drawing paused - blocking event');
        return true;
    }
    
    // Check if we're in the initial burst window
    const isInInitialBurst = drawingSessionStartTime && 
                             (now - drawingSessionStartTime) < CLIENT_INITIAL_BURST_WINDOW;
    
    if (isInInitialBurst) {
        // Apply stricter initial burst protection
        const initialBurstEvents = clientDrawEvents.filter(
            timestamp => timestamp >= drawingSessionStartTime
        ).length;
        
        if (initialBurstEvents >= CLIENT_INITIAL_BURST_MAX) {
            // Hard block during initial burst - record violation
            if (!isClientThrottled) {
                showThrottleWarning('🚨 STOP! Drawing too fast!', initialBurstEvents * 2);
                recordViolation();
                isClientThrottled = true;
            }
            console.log(`[Initial Burst] Blocking - ${initialBurstEvents} events in ${now - drawingSessionStartTime}ms`);
            return true; // Block this event
        } else if (initialBurstEvents >= CLIENT_INITIAL_BURST_WARN) {
            // Warning during initial burst
            if (!isClientThrottled) {
                showThrottleWarning('⚠️ Slow down!', initialBurstEvents * 2);
                isClientThrottled = true;
            }
            // Allow but with warning
        }
    }
    
    // Clean up old events outside the window
    clientDrawEvents = clientDrawEvents.filter(
        timestamp => now - timestamp < CLIENT_RATE_LIMIT_WINDOW
    );
    
    // Add current event
    clientDrawEvents.push(now);
    
    const eventsPerSecond = clientDrawEvents.length;
    
    // Standard rate limiting (after initial burst or for longer sessions)
    if (eventsPerSecond > CLIENT_RATE_LIMIT_MAX_EVENTS) {
        // Immediate throttle - block this event and record violation
        if (!isClientThrottled) {
            showThrottleWarning('🚨 TOO FAST! Blocking...', eventsPerSecond);
            recordViolation();
            isClientThrottled = true;
        }
        return true; // Block this event
    } else if (eventsPerSecond > CLIENT_RATE_LIMIT_THROTTLE_THRESHOLD) {
        // Approaching limit - show warning but allow
        if (!isClientThrottled) {
            showThrottleWarning('⚠️ Please slow down!', eventsPerSecond);
            isClientThrottled = true;
        }
        return false; // Allow but warn
    } else {
        // Good behavior - reset throttle state
        if (isClientThrottled) {
            isClientThrottled = false;
        }
        return false; // Allow
    }
}

// Show immediate throttle warning
function showThrottleWarning(message, eventsPerSecond) {
    // Clear any existing warning timeout
    if (throttleWarningTimeout) {
        clearTimeout(throttleWarningTimeout);
    }
    
    // Remove any existing warning
    let existingWarning = document.getElementById('clientThrottleWarning');
    if (existingWarning) {
        existingWarning.remove();
    }
    
    // Create warning element
    const warningDiv = document.createElement('div');
    warningDiv.id = 'clientThrottleWarning';
    warningDiv.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(255, 87, 34, 0.95);
        color: white;
        padding: 15px 25px;
        border-radius: 8px;
        font-size: 16px;
        font-weight: bold;
        z-index: 10000;
        box-shadow: 0 4px 8px rgba(0,0,0,0.3);
        text-align: center;
        animation: slideDown 0.3s ease-out;
    `;
    
    warningDiv.innerHTML = `
        <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 20px;">🐌</span>
            <div>
                <div>${message}</div>
                <div style="font-size: 12px; opacity: 0.9; margin-top: 4px;">
                    ${eventsPerSecond} events/sec
                </div>
            </div>
        </div>
    `;
    
    // Add animation
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideDown {
            from {
                opacity: 0;
                transform: translateX(-50%) translateY(-20px);
            }
            to {
                opacity: 1;
                transform: translateX(-50%) translateY(0);
            }
        }
    `;
    document.head.appendChild(style);
    
    document.body.appendChild(warningDiv);
    
    // Auto-remove after 2 seconds
    throttleWarningTimeout = setTimeout(() => {
        warningDiv.style.transition = 'opacity 0.3s, transform 0.3s';
        warningDiv.style.opacity = '0';
        warningDiv.style.transform = 'translateX(-50%) translateY(-20px)';
        setTimeout(() => {
            if (warningDiv.parentNode) {
                warningDiv.remove();
            }
        }, 300);
    }, 2000);
}

// Start drawing
function startDrawing(e) {
    e.preventDefault();
    
    // Prevent drawing if locked for non-admins
    if (drawingLocked && !isAdmin) {
        return;
    }
    
    isDrawing = true;
    
    // Initialize drawing session start time for burst protection
    if (!drawingSessionStartTime) {
        drawingSessionStartTime = Date.now();
        console.log('[startDrawing] New drawing session started - burst protection active');
    }
    
    const pos = getEventPos(e);
    lastX = pos.x;
    lastY = pos.y;
}

// Draw and emit data
function draw(e) {
    if (!isDrawing) return;
    e.preventDefault();
    
    // Check if drawing is locked for non-admins
    if (drawingLocked && !isAdmin) {
        isDrawing = false;
        return;
    }
    
    const now = Date.now();
    if (now - lastDrawTime < UPDATE_RATE) return;
    lastDrawTime = now;
    
    // Check client-side rate limiting for non-admins
    if (!isAdmin && checkClientRateLimit()) {
        // Drawing is being throttled - skip this event
        console.log('[draw] Client-side throttle active - skipping event');
        return;
    }
    
    const pos = getEventPos(e);
    
    // Draw locally
    drawLine(lastX, lastY, pos.x, pos.y, userColor);
    
    // Emit drawing data
    const drawingData = {
        x0: lastX,
        y0: lastY,
        x1: pos.x,
        y1: pos.y,
        color: userColor,
        timestamp: now
    };
    
    socket.emit('drawing', drawingData);
    
    lastX = pos.x;
    lastY = pos.y;
}

// Stop drawing
function stopDrawing(e) {
    if (!isDrawing) return;
    e.preventDefault();
    isDrawing = false;
    
    // Reset drawing session timer after a short delay
    // This allows a new session to start with fresh burst protection
    setTimeout(() => {
        if (!isDrawing) {
            drawingSessionStartTime = null;
            console.log('[stopDrawing] Drawing session reset - burst protection will restart on next draw');
        }
    }, 1000); // 1 second delay to allow for continuous strokes
}

// Mouse events
canvas.addEventListener('mousedown', startDrawing);
canvas.addEventListener('mousemove', draw);
canvas.addEventListener('mouseup', stopDrawing);
canvas.addEventListener('mouseout', stopDrawing);

// Touch events
canvas.addEventListener('touchstart', startDrawing);
canvas.addEventListener('touchmove', draw);
canvas.addEventListener('touchend', stopDrawing);
canvas.addEventListener('touchcancel', stopDrawing);

// Reset button
resetBtn.addEventListener('click', () => {
    if (resetLocked && !isAdmin) {
        alert('Reset is currently locked by admin');
        return;
    }
    if (confirm('Are you sure you want to reset the whiteboard for everyone?')) {
        console.log(`[resetCanvas] Sending reset request - clientId: ${clientId}`);
        socket.emit('resetCanvas', { clientId });
    }
});

// Admin authentication
adminAuthBtn.addEventListener('click', () => {
    const pin = adminPinInput.value.trim();
    if (pin) {
        const code = parseInt(pin, 10);
        if (isNaN(code)) {
            alert('Please enter a valid numeric admin code');
            return;
        }
        console.log(`[adminAuth] Sending auth request - code: ${code}, clientId: ${clientId}`);
        socket.emit('admin-auth', { code, clientId });
    }
});

// Admin lock toggle
lockToggleBtn.addEventListener('click', () => {
    const newLockState = !drawingLocked;
    socket.emit('toggleLock', newLockState);
});

// Socket event handlers
socket.on('connect', () => {
    console.log(`[connect] Connected to server - clientId: ${clientId}`);
    connectionStatus.textContent = 'Connected';
    connectionStatus.className = 'status connected';
    
    // Send client identity to server
    socket.emit('clientIdentity', { clientId, color: userColor });
});

socket.on('disconnect', () => {
    console.log('[disconnect] Disconnected from server');
    connectionStatus.textContent = 'Disconnected';
    connectionStatus.className = 'status disconnected';
});

socket.on('userColor', (color) => {
    userColor = color;
    userColorDisplay.style.backgroundColor = color;
    console.log('Assigned color:', color);
});

socket.on('drawing', (data) => {
    drawLine(data.x0, data.y0, data.x1, data.y1, data.color);
});

socket.on('loadDrawing', (drawingData) => {
    console.log('Loading existing drawing data:', drawingData.length, 'strokes');
    drawingData.forEach(data => {
        drawLine(data.x0, data.y0, data.x1, data.y1, data.color);
    });
});

socket.on('resetCanvas', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    console.log('[resetCanvas] Canvas reset received');
});

// Admin authentication response
socket.on('adminAuthSuccess', () => {
    isAdmin = true;
    adminPinInput.style.display = 'none';
    adminAuthBtn.style.display = 'none';
    lockToggleBtn.style.display = 'inline-block';
    
    // Update lock toggle button text based on current state
    lockToggleBtn.textContent = drawingLocked ? 'Unlock Board' : 'Lock Board';
    
    alert('Admin authentication successful!');
    console.log('[adminAuthSuccess] Admin authenticated');
});

socket.on('adminAuthFailed', (data) => {
    if (data && data.remainingSeconds) {
        const minutes = Math.floor(data.remainingSeconds / 60);
        const seconds = data.remainingSeconds % 60;
        let timeMessage = '';
        if (minutes > 0) {
            timeMessage = `${minutes} minute${minutes > 1 ? 's' : ''}`;
            if (seconds > 0) {
                timeMessage += ` and ${seconds} second${seconds > 1 ? 's' : ''}`;
            }
        } else {
            timeMessage = `${seconds} second${seconds > 1 ? 's' : ''}`;
        }
        alert(`${data.message}\nPlease wait ${timeMessage} before trying again.`);
    } else {
        alert(data?.message || 'Invalid admin code');
    }
    adminPinInput.value = '';
});

// Lock state updates
socket.on('lockStateUpdate', (lockState) => {
    drawingLocked = lockState.drawingLocked;
    resetLocked = lockState.resetLocked;
    
    console.log(`[lockStateUpdate] Lock state updated - drawingLocked: ${drawingLocked}, resetLocked: ${resetLocked}`);
    
    // Update UI
    if (drawingLocked) {
        lockNotice.style.display = 'block';
        canvas.style.cursor = isAdmin ? 'crosshair' : 'not-allowed';
        if (isAdmin) {
            lockToggleBtn.textContent = 'Unlock Board';
        }
    } else {
        lockNotice.style.display = 'none';
        canvas.style.cursor = 'crosshair';
        if (isAdmin) {
            lockToggleBtn.textContent = 'Lock Board';
        }
    }
    
    // Update reset button state
    if (resetLocked && !isAdmin) {
        resetBtn.disabled = true;
        resetBtn.style.opacity = '0.5';
        resetBtn.style.cursor = 'not-allowed';
    } else {
        resetBtn.disabled = false;
        resetBtn.style.opacity = '1';
        resetBtn.style.cursor = 'pointer';
    }
});

// Reset cooldown notification
socket.on('resetCooldown', (data) => {
    const minutes = Math.ceil(data.remainingTime / 60);
    console.log(`[resetCooldown] Reset on cooldown - ${data.remainingTime}s remaining`);
    cooldownNotice.textContent = `⏰ You can reset the board again in ${minutes} minute(s)`;
    cooldownNotice.style.display = 'block';
    setTimeout(() => {
        cooldownNotice.style.display = 'none';
    }, 5000);
});

// Reset rejected notification
socket.on('resetRejected', (message) => {
    console.log(`[resetRejected] Reset rejected - ${message}`);
    alert(message || 'Reset action is currently disabled');
});

// Rate limit warning handler
socket.on('rateLimitWarning', (data) => {
    console.warn('[rateLimitWarning]', data);
    const warningDiv = document.createElement('div');
    warningDiv.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(255, 152, 0, 0.95); color: white; padding: 25px 35px; border-radius: 12px; font-size: 20px; font-weight: bold; z-index: 10000; box-shadow: 0 6px 12px rgba(0,0,0,0.4); text-align: center; min-width: 300px;';
    
    const pauseDuration = data.pauseDuration || 5;
    let remainingTime = pauseDuration;
    
    const updateMessage = () => {
        warningDiv.innerHTML = `
            <div style="font-size: 32px; margin-bottom: 10px;">⚠️</div>
            <div style="margin-bottom: 10px;">${data.message.split('!')[0]}</div>
            <div style="font-size: 28px; font-weight: bold; color: #fff; margin: 15px 0;">
                ${remainingTime}s
            </div>
            <div style="font-size: 14px; opacity: 0.9;">
                Violations: ${data.violations}/${data.maxViolations}
            </div>
            <div style="font-size: 12px; opacity: 0.8; margin-top: 8px;">
                Drawing will resume automatically
            </div>
        `;
    };
    
    updateMessage();
    document.body.appendChild(warningDiv);
    
    const countdown = setInterval(() => {
        remainingTime--;
        if (remainingTime > 0) {
            updateMessage();
        } else {
            clearInterval(countdown);
            warningDiv.style.transition = 'opacity 0.5s';
            warningDiv.style.opacity = '0';
            setTimeout(() => warningDiv.remove(), 500);
        }
    }, 1000);
});

// Rate limit disconnect handler
socket.on('rateLimitDisconnect', (data) => {
    console.error('[rateLimitDisconnect]', data);
    alert(`🚫 ${data.message}\n\nYou were drawing too fast (${data.violations} violations). Please refresh the page to reconnect.`);
});

// Initialize
initCanvas();

// Prevent scrolling when touching the canvas
document.body.addEventListener('touchstart', (e) => {
    if (e.target === canvas) {
        e.preventDefault();
    }
}, { passive: false });

document.body.addEventListener('touchend', (e) => {
    if (e.target === canvas) {
        e.preventDefault();
    }
}, { passive: false });

document.body.addEventListener('touchmove', (e) => {
    if (e.target === canvas) {
        e.preventDefault();
    }
}, { passive: false });

console.log('🖍️ Whiteboard initialized');
