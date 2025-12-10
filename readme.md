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
- **Rate Limiting**: 
  - 5-minute cooldown between canvas resets (for non-admins)
  - Brute-force protection for admin authentication attempts
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
