require("dotenv").config();
const express = require("express");
const http = require("http");
const bodyParser = require("body-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");
const { Server } = require("socket.io");

// Configuration
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 8000; // REST API port
const socketPort = process.env.SOCKET_PORT || 6060; // Socket.IO port
const jwtSecret = process.env.JWT_SECRET || "yoursecretkey";
const authKey = process.env.AUTH_KEY || "addauthkeyifrequired"; // WebSocket custom auth key

// Middleware
app.use(bodyParser.json());

// MySQL Database Connection
const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "shubh.vyas",
  database: process.env.DB_NAME || "chatapp",
};

let db;
(async () => {
  try {
    db = await mysql.createPool(dbConfig);
    console.log("Connected to MySQL database.");

    // Create Tables if they don't exist
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT NOT NULL,
        receiver_id INT NOT NULL,
        message TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status ENUM('pending', 'delivered') DEFAULT 'pending',
        FOREIGN KEY (sender_id) REFERENCES users(id),
        FOREIGN KEY (receiver_id) REFERENCES users(id)
      )
    `);
  } catch (err) {
    console.error("Database initialization error:", err);
  }
})();

// Socket.IO Connection Management
const onlineUsers = {};

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  // Authenticate WebSocket connection
  socket.on("authenticate", async (token) => {
    try {
      const decoded = jwt.verify(token, jwtSecret);
      const userId = decoded.id;

      // Store the user's socket connection
      onlineUsers[userId] = socket;
      console.log(`User ${userId} authenticated.`);

      // Send pending messages
      const [rows] = await db.execute(
        `SELECT * FROM messages WHERE receiver_id = ? AND status = 'pending'`,
        [userId]
      );
      rows.forEach(async (msg) => {
        const messageData = {
          msgtext: msg.message,
          userid: msg.sender_id.toString(),
          isme: false,
        };
        socket.emit("message", messageData);
        await db.execute(`UPDATE messages SET status = 'delivered' WHERE id = ?`, [
          msg.id,
        ]);
      });
    } catch (err) {
      console.error("Authentication error:", err.message);
      socket.emit("error", { message: "Invalid token" });
      socket.disconnect();
    }
  });

  // Handle incoming messages
  socket.on("send_message", async (data) => {
    try {
      const { token, receiverEmail, message } = data;
      const decoded = jwt.verify(token, jwtSecret);
      const senderId = decoded.id;

      if (!receiverEmail || !message) {
        return socket.emit("error", { message: "Invalid data" });
      }

      // Fetch receiver ID
      const [rows] = await db.execute(`SELECT id FROM users WHERE email = ?`, [
        receiverEmail,
      ]);
      if (rows.length === 0) {
        return socket.emit("error", { message: "Receiver not found" });
      }

      const receiverId = rows[0].id;

      // Save message in database
      const [result] = await db.execute(
        `INSERT INTO messages (sender_id, receiver_id, message, status) VALUES (?, ?, ?, ?)`,
        [senderId, receiverId, message, onlineUsers[receiverId] ? "delivered" : "pending"]
      );

      // Prepare message data for response
      const newMessage = {
        msgtext: message,
        userid: senderId.toString(),
        isme: senderId === decoded.id, // This will be true if the sender is the current user
      };

      // Deliver message if receiver is online
      if (onlineUsers[receiverId]) {
        onlineUsers[receiverId].emit("message", newMessage);
      }

      socket.emit("message_sent", { message: "Message sent successfully", id: result.insertId });
    } catch (err) {
      console.error("Error sending message:", err.message);
      socket.emit("error", { message: "Failed to send message" });
    }
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    for (const userId in onlineUsers) {
      if (onlineUsers[userId] === socket) {
        delete onlineUsers[userId];
        console.log(`User ${userId} disconnected.`);
        break;
      }
    }
  });
});

// REST API Endpoints

// User Registration
app.post("/register", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await db.execute(`INSERT INTO users (email, password) VALUES (?, ?)`, [email, hashedPassword]);
    res.status(201).json({ message: "User registered successfully." });
  } catch (err) {
    console.error("Error registering user:", err.message);
    res.status(500).json({ error: "Failed to register user." });
  }
});

// User Login
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  try {
    const [rows] = await db.execute(`SELECT * FROM users WHERE email = ?`, [email]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid password." });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, jwtSecret, { expiresIn: "1h" });
    res.json({ message: "Login successful", token });
  } catch (err) {
    console.error("Error logging in user:", err.message);
    res.status(500).json({ error: "Failed to log in user." });
  }
});

// Get all users - Endpoint
app.get("/users", async (req, res) => {
  const token = req.headers["authorization"];

  if (!token) {
    return res.status(401).json({ error: "No token provided." });
  }

  try {
    // Verify token
    const decoded = jwt.verify(token.split(" ")[1], jwtSecret); // "Bearer <token>"
    const userId = decoded.id;

    // Fetch users from the database
    const [rows] = await db.execute(`SELECT id, email, created_at FROM users`);
    
    res.status(200).json({ users: rows });
  } catch (err) {
    console.error("Error fetching users:", err.message);
    res.status(500).json({ error: "Failed to fetch users." });
  }
});

// Check if user exists by email - Endpoint
app.get("/user/exists", async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ error: "Email is required." });
  }

  try {
    // Query the database to check if the user exists
    const [rows] = await db.execute(`SELECT id FROM users WHERE email = ?`, [email]);

    if (rows.length > 0) {
      return res.status(200).json({ exists: true, message: "User exists." });
    } else {
      return res.status(404).json({ exists: false, message: "User not found." });
    }
  } catch (err) {
    console.error("Error checking if user exists:", err.message);
    return res.status(500).json({ error: "Failed to check if user exists." });
  }
});

// Start Servers
server.listen(port, () => {
  console.log(`REST API running on http://localhost:${port}`);
});

io.listen(socketPort);
console.log(`Socket.IO server running on http://localhost:${socketPort}`);
