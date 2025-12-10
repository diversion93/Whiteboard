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

// Start drawing
function startDrawing(e) {
    e.preventDefault();
    
    // Prevent drawing if locked for non-admins
    if (drawingLocked && !isAdmin) {
        return;
    }
    
    isDrawing = true;
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
        socket.emit('adminAuth', { code, clientId });
    }
});

// Admin lock toggle
lockToggleBtn.addEventListener('click', () => {
    const newLockState = !drawingLocked;
    socket.emit('toggleLock', newLockState);
});

// Socket event handlers
socket.on('connect', () => {
    console.log('Connected to server');
    connectionStatus.textContent = 'Connected';
    connectionStatus.className = 'status connected';
    
    // Send client identity to server
    socket.emit('clientIdentity', { clientId, color: userColor });
});

socket.on('disconnect', () => {
    console.log('Disconnected from server');
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
    console.log('Canvas reset');
});

// Admin authentication response
socket.on('adminAuthSuccess', () => {
    isAdmin = true;
    adminPinInput.style.display = 'none';
    adminAuthBtn.style.display = 'none';
    lockToggleBtn.style.display = 'inline-block';
    alert('Admin authentication successful!');
    console.log('Admin authenticated');
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
    cooldownNotice.textContent = `⏰ You can reset the board again in ${minutes} minute(s)`;
    cooldownNotice.style.display = 'block';
    setTimeout(() => {
        cooldownNotice.style.display = 'none';
    }, 5000);
});

// Reset rejected notification
socket.on('resetRejected', (message) => {
    alert(message || 'Reset action is currently disabled');
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
