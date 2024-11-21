require("dotenv").config();
const WebSocket = require("ws");
const express = require("express");
const bodyParser = require("body-parser");
const sqlite3 = require("sqlite3").verbose();
const moment = require("moment");
const { parse } = require("url");

const app = express();
const port = process.env.PORT || 8000; // HTTP port for REST API
const wsPort = process.env.WS_PORT || 6060; // WebSocket port
const authKey = process.env.AUTH_KEY || "addauthkeyifrequired"; // Authentication key

// Middleware
app.use(bodyParser.json());

// SQLite Database Initialization
const db = new sqlite3.Database("./chat.db", (err) => {
  if (err) {
    console.error("Database connection error:", err.message);
  } else {
    console.log("Connected to SQLite database.");
  }
});

// Create Users Table
db.run(
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL
  )`
);

// Create Messages Table
db.run(
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT,
    receiver TEXT,
    message TEXT,
    timestamp TEXT,
    status TEXT DEFAULT 'pending'
  )`
);

// WebSocket Connections
const webSockets = {};

// REST API: User Registration
app.post("/register", (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  db.run(`INSERT OR IGNORE INTO users (email) VALUES (?)`, [email], function (err) {
    if (err) {
      console.error("Error registering user:", err);
      return res.status(500).json({ error: "Failed to register user" });
    }
    res.json({ message: "User registered successfully", email });
  });
});

// REST API: Get All Users
app.get("/users", (req, res) => {
  db.all(`SELECT id, email FROM users`, [], (err, rows) => {
    if (err) {
      console.error("Error fetching users:", err);
      return res.status(500).json({ error: "Failed to fetch users" });
    }
    res.json(rows);
  });
});

// Start REST API Server
app.listen(port, () => {
  console.log(`REST API server running on port ${port}`);
});

// WebSocket Server
const wss = new WebSocket.Server({ port: wsPort });

wss.on("connection", (ws, req) => {
  console.log(`New WebSocket connection: ${req.url}`); // Log the connection URL

  // Parsing email from the WebSocket connection URL
  const parsedUrl = parse(req.url, true);
 // const email = decodeURIComponent(parsedUrl.pathname?.split("/")[1]); // Extract email from `/email`
  const email = decodeURIComponent(parsedUrl.pathname?.split("/")[1] || "").trim();

  if (!email) {
    console.log("Invalid WebSocket connection URL");
    ws.send(JSON.stringify({ error: "Invalid connection URL" }));
    ws.close();
    return;
  }

  // Check if email exists in the database before allowing the connection
  db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, row) => {
    if (err || !row) {
      console.log(`Authentication failed for user: ${email}`);
      ws.send(JSON.stringify({ error: "User not found or not authenticated" }));
      ws.close(); // Close the connection
      return;
    }

    // If user exists, proceed with connection
    webSockets[email] = ws; // Add user connection to WebSocket pool
    console.log(`User connected: ${email}`);

    // Send pending messages to the connected user
    db.all(
      `SELECT * FROM messages WHERE receiver = ? AND status = 'pending'`,
      [email],
      (err, rows) => {
        if (err) {
          console.error("Error fetching messages:", err);
        } else {
          rows.forEach((msg) => {
            ws.send(JSON.stringify(msg));
            db.run(`UPDATE messages SET status = 'delivered' WHERE id = ?`, [msg.id]);
          });
        }
      }
    );

    // Handle incoming messages from the client
    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message);
        console.log("Received message:", data); // Debugging incoming data

        if (data.auth === authKey) {
          if (data.cmd === "send") {
            const { sender, receiver, msgtext } = data;

            if (!sender || !receiver || !msgtext) {
              ws.send(JSON.stringify({ error: "Missing required fields" }));
              return;
            }

            const timestamp = moment().format();
            const receiverWS = webSockets[receiver]; // Check if the receiver is online

            db.run(
              `INSERT INTO messages (sender, receiver, message, timestamp, status) VALUES (?, ?, ?, ?, ?)`,
              [sender, receiver, msgtext, timestamp, receiverWS ? "delivered" : "pending"],
              function (err) {
                if (err) {
                  console.error("Error saving message:", err);
                  ws.send(JSON.stringify({ error: "Failed to save message to the database" }));
                } else {
                  const messageData = {
                    id: this.lastID,
                    sender,
                    receiver,
                    message: msgtext,
                    timestamp,
                    status: receiverWS ? "delivered" : "pending",
                  };

                  if (receiverWS) {
                    try {
                      receiverWS.send(JSON.stringify(messageData)); // Deliver message to receiver
                    } catch (err) {
                      console.error("Failed to send message to receiver:", err);
                      db.run(`UPDATE messages SET status = 'pending' WHERE id = ?`, [this.lastID]);
                    }
                  }

                  ws.send(JSON.stringify({ status: "Message sent", messageId: this.lastID }));
                }
              }
            );
          } else {
            ws.send(JSON.stringify({ error: "Invalid command" }));
          }
        } else {
          ws.send(JSON.stringify({ error: "Authentication failed" }));
        }
      } catch (err) {
        console.error("Error processing message:", err);
        ws.send(JSON.stringify({ error: "Invalid message format" }));
      }
    });

    ws.on("close", () => {
      if (webSockets[email] === ws) {
        delete webSockets[email]; // Clean up stale WebSocket reference
      }
      console.log(`User disconnected: ${email}`);
    });
  });
});

console.log(`WebSocket server running on port ${wsPort}`);
