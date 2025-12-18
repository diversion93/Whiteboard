# 🖍️ Realtime Multiplayer Whiteboard

A lightweight, web-based collaborative drawing application with real-time synchronization, mouse and touch support, and advanced admin controls.

## 🌟 Features

- **Real-time Drawing**: Draw simultaneously with multiple users - everyone sees your strokes instantly
- **Persistent Client Identity**: Each user gets a unique color that persists across sessions
- **Touch & Mouse Support**: Works seamlessly on desktop and mobile devices
- **Admin Controls**:
  - Secure PIN-based authentication with brute-force protection
  - Lock/unlock board to prevent drawing
  - Bypass cooldown restrictions
- **Advanced Rate Limiting**: 
  - **Drawing Speed Control**: Balanced protection that allows natural drawing
    - Maximum 25 events per second
    - Initial burst allowance: 15 events in first 500ms (allows a few quick strokes)
    - Warning threshold at 20 events/second
  - **Gentle First Warning**: Informative blue notification without pausing
  - **Escalating Consequences**: Progressive violations tracking
    - 1st violation: Gentle informational warning (no pause)
    - 2nd violation: 5-second drawing pause
    - 3-4 violations: 15-second drawing pause
    - 5+ violations: 30-second drawing pause
  - **Visual Feedback**: Progressive warnings with emoji-based severity indicators
  - **Canvas Reset Cooldown**: 5-minute cooldown between resets (non-admins)
  - **Brute-force Protection**: Admin authentication attempts are rate-limited
- **Auto-sync**: New users automatically receive the current drawing state

## 🚀 Quick Start

### Prerequisites
- Node.js (v14 or later)
- npm

### Installation

```bash
# Install dependencies
npm install
```

### Running the Application

```bash
# Start the server
npm start
```

The server will start on `http://localhost:3000` (or the port specified in the PORT environment variable)

## 🎨 Usage

### For Regular Users
1. Open the application in your browser
2. Start drawing with your mouse or finger
3. Your unique color is displayed in the top-left corner
4. Click "Reset Whiteboard" to clear the canvas (5-minute cooldown applies)

### For Admins
1. Enter the admin PIN in the admin controls section
2. Click "Authenticate" to gain admin privileges
3. Once authenticated, you can:
   - Lock/unlock the board for all users
   - Reset the canvas without cooldown restrictions
   - Draw even when the board is locked

## 🔧 Technologies

- **Frontend**: HTML5 Canvas, Vanilla JavaScript
- **Backend**: Node.js, Express
- **Real-time Communication**: Socket.IO
- **Storage**: In-memory (drawing data and client state)

## 🔒 Security Features

- Admin PIN protection with rate limiting
- Brute-force protection (3 failed attempts = 10-minute block)
- Progressive backoff delays after failed authentication attempts
- Persistent client identity using localStorage

## 📱 Compatibility

- ✅ Modern browsers (Chrome, Firefox, Safari, Edge)
- ✅ Mobile devices (iOS, Android)
- ✅ Touch and mouse input
- ✅ Responsive canvas design

## ⚙️ Configuration

You can modify these settings in `server.js`:

- `PORT`: Server port (default: 3000)
- `ADMIN_CODE`: Admin PIN 
- `RESET_COOLDOWN_MS`: Time between canvas resets (default: 5 minutes)
- `BLOCK_DURATION_MS`: Admin auth block duration (default: 10 minutes)

## 📄 License

MIT License
