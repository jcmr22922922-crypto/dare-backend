const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

/* ==========================================
   MIDDLEWARE
========================================== */

app.use(cors());
app.use(express.json());

/* ==========================================
   CONNECTED STREAMERS
========================================== */

const connectedStreamers = [
  {
    username: "YourTwitchUsername",
    displayName: "YourTwitchUsername",
    connected: true
  }
];

/* ==========================================
   DARE STORAGE
========================================== */

const streamerQueues = {};
const activeDares = {};
const dareHistory = [];

let dareCounter = 0;

/* ==========================================
   BASIC SERVER
========================================== */

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "Dare Backend",
    connectedStreamers: connectedStreamers.length,
    activeDares: Object.keys(activeDares).length,
    historyLength: dareHistory.length
  });
});

/* ==========================================
   WEBSOCKET
========================================== */

const wss = new WebSocket.Server({
  server: server,
  path: "/ws"
});

/* ==========================================
   BROADCAST
========================================== */

function broadcast(message) {
  const data = JSON.stringify(message);

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(data);
      } catch (error) {
        console.error("WebSocket send error:", error);
      }
    }
  });
}

/* ==========================================
   GET ALL QUEUES
========================================== */

function getAllQueues() {
  const queues = {};

  Object.keys(streamerQueues).forEach((streamer) => {
    queues[streamer] = streamerQueues[streamer];
  });

  return queues;
}

/* ==========================================
   GET ACTIVE DARES
========================================== */

function getActiveDares() {
  return Object.values(activeDares);
}

/* ==========================================
   SEND CURRENT STATE
========================================== */

function sendState(socket) {
  socket.send(
    JSON.stringify({
      type: "STATE",
      activeDares: getActiveDares(),
      queues: getAllQueues(),
      streamers: connectedStreamers
    })
  );
}

/* ==========================================
   WEBSOCKET CONNECTION
========================================== */

wss.on("connection", (socket) => {
  console.log("WebSocket client connected");

  // Send current state immediately
  sendState(socket);

  socket.on("message", (rawMessage) => {
    try {
      const message = JSON.parse(rawMessage.toString());

      if (message.type === "GET_STATE") {
        sendState(socket);
      }
    } catch (error) {
      console.error("Invalid WebSocket message:", error);
    }
  });

  socket.on("close", () => {
    console.log("WebSocket client disconnected");
  });
});

/* ==========================================
   STREAMER LOOKUP
========================================== */

function findStreamer(username) {
  if (!username) {
    return null;
  }

  const normalized = username
    .trim()
    .replace(/^@/, "")
    .toLowerCase();

  return connectedStreamers.find(
    (streamer) =>
      streamer.username.toLowerCase() === normalized
  );
}

/* ==========================================
   GET /api/streamers
========================================== */

app.get("/api/streamers", (req, res) => {
  const streamers = connectedStreamers
    .filter((streamer) => streamer.connected === true)
    .map((streamer) => ({
      username: streamer.username,
      displayName: streamer.displayName,
      connected: true
    }));

  res.json({
    streamers: streamers
  });
});

/* ==========================================
   CREATE DARE
========================================== */

app.post("/api/dare", (req, res) => {
  const {
    viewer,
    text,
    duration,
    reward,
    streamer,
    streamerSource
  } = req.body;

  /* VALIDATE DARE TEXT */

  if (!text || !text.trim()) {
    return res.status(400).json({
      error: "Dare text is required."
    });
  }

  /* VALIDATE STREAMER */

  if (!streamer || !streamer.trim()) {
    return res.status(400).json({
      error: "A target streamer is required."
    });
  }

  const cleanStreamer = streamer
    .trim()
    .replace(/^@/, "");

  /* VALIDATE CONNECTED STREAMER */

  if (streamerSource === "connected") {
    const registeredStreamer = findStreamer(cleanStreamer);

    if (!registeredStreamer) {
      return res.status(400).json({
        error: "That streamer is not currently connected."
      });
    }
  }

  /* VALIDATE DURATION */

  const dareDuration = Number(duration);

  if (
    !Number.isFinite(dareDuration) ||
    dareDuration < 5 ||
    dareDuration > 300
  ) {
    return res.status(400).json({
      error: "Duration must be between 5 and 300 seconds."
    });
  }

  /* VALIDATE REWARD */

  const dareReward = Number(reward);

  if (
    !Number.isFinite(dareReward) ||
    dareReward < 0
  ) {
    return res.status(400).json({
      error: "Reward must be a valid number."
    });
  }

  /* CREATE DARE */

  dareCounter++;

  const dare = {
    id: String(dareCounter),

    streamer: cleanStreamer,

    streamerSource:
      streamerSource || "twitch_username",

    viewer: viewer
      ? String(viewer).trim()
      : "Anonymous",

    text: text.trim(),

    duration: dareDuration,

    reward: dareReward,

    status: "pending",

    createdAt: new Date().toISOString()
  };

  /* CREATE STREAMER QUEUE */

  const streamerKey = cleanStreamer.toLowerCase();

  if (!streamerQueues[streamerKey]) {
    streamerQueues[streamerKey] = [];
  }

  streamerQueues[streamerKey].push(dare);

  console.log("Dare added:", dare);

  /* BROADCAST DARE */

  broadcast({
    type: "DARE_CREATED",
    dare: dare,
    queue: streamerQueues[streamerKey]
  });

  /* BROADCAST QUEUE UPDATE */

  broadcast({
    type: "QUEUE_UPDATED",
    streamer: cleanStreamer,
    queue: streamerQueues[streamerKey]
  });

  /* RESPONSE */

  res.status(201).json({
    success: true,
    dare: dare,
    queuePosition: streamerQueues[streamerKey].length
  });
});

/* ==========================================
   GET CURRENT STATE
========================================== */

app.get("/api/dare", (req, res) => {
  res.json({
    activeDares: getActiveDares(),
    queues: getAllQueues(),
    streamers: connectedStreamers
  });
});

/* ==========================================
   GET STREAMER QUEUE
========================================== */

app.get("/api/dare/queue/:streamer", (req, res) => {
  const streamer = req.params.streamer
    .trim()
    .replace(/^@/, "")
    .toLowerCase();

  res.json({
    streamer: streamer,
    queue: streamerQueues[streamer] || []
  });
});

/* ==========================================
   GET ACTIVE DARE FOR STREAMER
========================================== */

app.get("/api/dare/active/:streamer", (req, res) => {
  const streamer = req.params.streamer
    .trim()
    .replace(/^@/, "")
    .toLowerCase();

  res.json({
    activeDare: activeDares[streamer] || null
  });
});

/* ==========================================
   ACCEPT DARE
========================================== */

function acceptDare(dare) {
  const streamerKey = dare.streamer.toLowerCase();

  const queue = streamerQueues[streamerKey] || [];

  const index = queue.findIndex(
    (item) => item.id === dare.id
  );

  if (index !== -1) {
    queue.splice(index, 1);
  }

  dare.status = "accepted";
  dare.acceptedAt = new Date().toISOString();

  activeDares[streamerKey] = dare;

  console.log("ACTIVE DARE:", dare);

  /* BROADCAST ACTIVE DARE */

  broadcast({
    type: "ACTIVE_DARE",
    dare: dare,
    streamer: dare.streamer,
    queue: queue
  });

  /* BROADCAST QUEUE */

  broadcast({
    type: "QUEUE_UPDATED",
    streamer: dare.streamer,
    queue: queue
  });
}

/* ==========================================
   UPDATE DARE STATUS
========================================== */

app.post("/api/dare/:id/status", (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const allowedStatuses = [
    "accepted",
    "rejected",
    "completed",
    "failed"
  ];

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({
      error: "Invalid dare status."
    });
  }

  /* FIND DARE */

  let foundDare = null;
  let streamerKey = null;

  /* SEARCH ACTIVE DARES */

  for (const key of Object.keys(activeDares)) {
    if (
      activeDares[key] &&
      activeDares[key].id === id
    ) {
      foundDare = activeDares[key];
      streamerKey = key;
      break;
    }
  }

  /* SEARCH QUEUES */

  if (!foundDare) {
    for (const key of Object.keys(streamerQueues)) {
      const queue = streamerQueues[key];

      const dare = queue.find(
        (item) => item.id === id
      );

      if (dare) {
        foundDare = dare;
        streamerKey = key;
        break;
      }
    }
  }

  if (!foundDare) {
    return res.status(404).json({
      error: "Dare not found."
    });
  }

  /* ======================================
     ACCEPT
  ====================================== */

  if (status === "accepted") {
    if (activeDares[streamerKey]) {
      return res.status(409).json({
        error:
          "This streamer already has an active dare."
      });
    }

    acceptDare(foundDare);

    return res.json({
      success: true,
      dare: activeDares[streamerKey],
      queue: streamerQueues[streamerKey] || []
    });
  }

  /* ======================================
     REJECT
  ====================================== */

  if (status === "rejected") {
    const queue =
      streamerQueues[streamerKey] || [];

    const index = queue.findIndex(
      (item) => item.id === id
    );

    if (index !== -1) {
      queue.splice(index, 1);
    }

    foundDare.status = "rejected";
    foundDare.updatedAt =
      new Date().toISOString();

    dareHistory.push({
      ...foundDare
    });

    broadcast({
      type: "DARE_REJECTED",
      dare: foundDare,
      streamer: foundDare.streamer
    });

    broadcast({
      type: "QUEUE_UPDATED",
      streamer: foundDare.streamer,
      queue: queue
    });

    return res.json({
      success: true,
      dare: foundDare,
      queue: queue
    });
  }

  /* ======================================
     COMPLETED / FAILED
  ====================================== */

  if (
    status === "completed" ||
    status === "failed"
  ) {
    foundDare.status = status;

    foundDare.updatedAt =
      new Date().toISOString();

    dareHistory.push({
      ...foundDare
    });

    /* REMOVE ACTIVE DARE */

    if (activeDares[streamerKey]) {
      delete activeDares[streamerKey];
    }

    /* TELL CLIENT DARE ENDED */

    broadcast({
      type:
        status === "completed"
          ? "DARE_COMPLETED"
          : "DARE_FAILED",

      dare: foundDare,

      streamer: foundDare.streamer
    });

    /* CLEAR ACTIVE DARE */

    broadcast({
      type: "ACTIVE_DARE_CLEARED",
      streamer: foundDare.streamer
    });

    /* UPDATE QUEUE */

    broadcast({
      type: "QUEUE_UPDATED",
      streamer: foundDare.streamer,
      queue:
        streamerQueues[streamerKey] || []
    });

    return res.json({
      success: true,
      dare: foundDare,
      queue:
        streamerQueues[streamerKey] || []
    });
  }
});

/* ==========================================
   GET DARE HISTORY
========================================== */

app.get("/api/dare/history", (req, res) => {
  res.json({
    history: dareHistory
  });
});

/* ==========================================
   CLEAR EVERYTHING
========================================== */

app.post("/api/dare/clear", (req, res) => {
  /* CLEAR QUEUES */

  Object.keys(streamerQueues).forEach((key) => {
    streamerQueues[key] = [];
  });

  /* CLEAR ACTIVE DARES */

  Object.keys(activeDares).forEach((key) => {
    delete activeDares[key];
  });

  broadcast({
    type: "RESET"
  });

  res.json({
    success: true
  });
});

/* ==========================================
   START SERVER
========================================== */

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Dare Backend running on port ${PORT}`
    );
  }
);
