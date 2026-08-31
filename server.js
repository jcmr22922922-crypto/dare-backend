const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();

app.use(express.json());

const server = http.createServer(app);

const wss = new WebSocket.Server({
  server,
  path: "/ws"
});

const PORT = process.env.PORT || 3000;

let currentDare = null;

function broadcast(message) {
  const data = JSON.stringify(message);

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "Dare Backend"
  });
});

app.get("/api/dare", (req, res) => {
  res.json({
    dare: currentDare
  });
});

app.post("/api/dare", (req, res) => {
  const {
    viewer = "Viewer",
    text = "Test dare",
    duration = 30
  } = req.body;

  currentDare = {
    id: Date.now().toString(),
    viewer,
    text,
    duration: Number(duration),
    status: "pending"
  };

  broadcast({
    type: "NEW_DARE",
    dare: currentDare
  });

  res.json({
    success: true,
    dare: currentDare
  });
});

app.post("/api/dare/:id/status", (req, res) => {
  if (!currentDare || currentDare.id !== req.params.id) {
    return res.status(404).json({
      error: "Dare not found"
    });
  }

  const allowed = [
    "accepted",
    "rejected",
    "completed",
    "failed"
  ];

  if (!allowed.includes(req.body.status)) {
    return res.status(400).json({
      error: "Invalid status"
    });
  }

  currentDare.status = req.body.status;

  broadcast({
    type: "DARE_STATUS",
    dare: currentDare
  });

  if (
    currentDare.status === "rejected" ||
    currentDare.status === "completed" ||
    currentDare.status === "failed"
  ) {
    setTimeout(() => {
      currentDare = null;

      broadcast({
        type: "DARE_CLEARED"
      });
    }, 3000);
  }

  res.json({
    success: true,
    dare: currentDare
  });
});

wss.on("connection", (socket) => {
  console.log("WebSocket client connected");

  socket.send(JSON.stringify({
    type: "CONNECTED"
  }));

  if (currentDare) {
    socket.send(JSON.stringify({
      type: "NEW_DARE",
      dare: currentDare
    }));
  }

  socket.on("close", () => {
    console.log("WebSocket client disconnected");
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});