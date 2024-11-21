
require("dotenv").config();
const WebSocket = require("ws");
const express = require("express");
const moment = require("moment");

const app = express();
const port = process.env.PORT || 8000; // HTTP port
const wsPort = process.env.WS_PORT || 6060; // WebSocket port
const authKey = process.env.AUTH_KEY || "addauthkeyifrequired"; // Auth key

// In-memory storage for messages
const messages = []; // Array to store chat messages

// Basic route
app.get("/", (req, res) => {
  res.send("Express server is running");
});

// Start the Express server
app.listen(port, () => {
  console.log(`Example app listening at http://127.0.0.1:${port}`);
});

// Store WebSocket connections
var webSockets = {};

// Create a WebSocket server
const wss = new WebSocket.Server({ port: wsPort }); // Run WebSocket server on wsPort
wss.on("connection", function (ws, req) {
  const userID = req.url.substr(1); // Get userID from URL (ip:6060/userid)
  webSockets[userID] = ws; // Add new user to the connection list

  console.log("User " + userID + " Connected");

  // Send previous messages to the newly connected user
  ws.send(JSON.stringify({ type: "history", messages }));

  ws.on("message", (message) => {
    try {
      let datastring = message.toString();
      if (datastring.charAt(0) === "{") {
        datastring = datastring.replace(/'/g, '"');
        const data = JSON.parse(datastring);

        if (data.auth === authKey) {
          if (data.cmd === "send") {
            const receiverWS = webSockets[data.userid]; // Check if there is a receiver connection
            if (receiverWS) {
              const cdata = JSON.stringify({
                cmd: data.cmd,
                userid: data.userid,
                msgtext: data.msgtext,
                timestamp: moment().format(),
              });
              receiverWS.send(cdata); // Send message to receiver
              ws.send(data.cmd + ":success");

              // Store message in memory
              messages.push({
                cmd: data.cmd,
                userid: data.userid,
                msgtext: data.msgtext,
                timestamp: moment().format(),
              });
            } else {
              console.log("No receiver user found.");
              ws.send(JSON.stringify({ error: "No receiver user found" }));
            }
          } else {
            console.log("No send command");
            ws.send(JSON.stringify({ error: "No send command" }));
          }
        } else {
          console.log("App Authentication error");
          ws.send(JSON.stringify({ error: "App Authentication error" }));
        }
      } else {
        console.log("Non-JSON type data");
        ws.send(JSON.stringify({ error: "Non-JSON data received" }));
      }
    } catch (error) {
      console.error("JSON parsing error:", error);
      ws.send(JSON.stringify({ error: "Invalid JSON format" }));
    }
  });

  ws.on("close", function () {
    delete webSockets[userID]; // On connection close, remove user from connection list
    console.log("User Disconnected: " + userID);
  });

  ws.send("connected"); // Initial connection return message
});
