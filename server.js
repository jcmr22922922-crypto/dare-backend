const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;


// ==========================================
// MIDDLEWARE
// ==========================================

app.use(cors());

app.use(express.json());


// ==========================================
// DATA
// ==========================================

let currentDare = null;

let dareCounter = 0;


// ==========================================
// BASIC SERVER TEST
// ==========================================

app.get("/", (req, res) => {

  res.json({
    status: "online",
    service: "Dare Backend"
  });

});


// ==========================================
// WEBSOCKET SERVER
// ==========================================

const wss = new WebSocket.Server({
  server: server,
  path: "/ws"
});


function broadcast(message) {

  const data =
    JSON.stringify(message);

  wss.clients.forEach((client) => {

    if (
      client.readyState ===
      WebSocket.OPEN
    ) {

      client.send(data);

    }

  });

}


wss.on("connection", (socket) => {

  console.log(
    "WebSocket client connected"
  );


  // Send the current dare
  // to a newly connected client.

  if (currentDare) {

    socket.send(
      JSON.stringify({
        type: "NEW_DARE",
        dare: currentDare
      })
    );

  }


  socket.on("close", () => {

    console.log(
      "WebSocket client disconnected"
    );

  });

});


// ==========================================
// CREATE DARE
// ==========================================

app.post("/api/dare", (req, res) => {

  const {
    viewer,
    text,
    duration
  } = req.body;


  if (!text || !text.trim()) {

    return res.status(400).json({

      error: "Dare text is required."

    });

  }


  dareCounter++;


  currentDare = {

    id: String(dareCounter),

    viewer:
      viewer ||
      "Anonymous",

    text:
      text.trim(),

    duration:
      Number(duration) || 30,

    status:
      "pending",

    createdAt:
      new Date().toISOString()

  };


  console.log(
    "New dare:",
    currentDare
  );


  broadcast({

    type: "NEW_DARE",

    dare: currentDare

  });


  res.status(201).json({

    success: true,

    dare: currentDare

  });

});


// ==========================================
// UPDATE DARE STATUS
// ==========================================

app.post(
  "/api/dare/:id/status",
  (req, res) => {

    const {
      id
    } = req.params;


    const {
      status
    } = req.body;


    const allowedStatuses = [

      "accepted",

      "rejected",

      "completed",

      "failed"

    ];


    if (
      !allowedStatuses.includes(status)
    ) {

      return res.status(400).json({

        error:
          "Invalid dare status."

      });

    }


    if (!currentDare) {

      return res.status(404).json({

        error:
          "No active dare."

      });

    }


    if (
      currentDare.id !== id
    ) {

      return res.status(404).json({

        error:
          "Dare not found."

      });

    }


    currentDare.status =
      status;


    currentDare.updatedAt =
      new Date().toISOString();


    console.log(
      "Dare status:",
      currentDare
    );


    broadcast({

      type:
        "DARE_STATUS",

      dare:
        currentDare

    });


    // Clear the dare after
    // it has finished.

    if (
      status === "completed" ||
      status === "failed" ||
      status === "rejected"
    ) {

      setTimeout(() => {

        if (
          currentDare &&
          currentDare.id === id
        ) {

          currentDare = null;


          broadcast({

            type:
              "DARE_CLEARED"

          });

        }

      }, 1500);

    }


    res.json({

      success: true,

      dare:
        currentDare

    });

  }
);


// ==========================================
// GET CURRENT DARE
// ==========================================

app.get(
  "/api/dare",
  (req, res) => {

    res.json({

      dare:
        currentDare

    });

  }
);


// ==========================================
// START SERVER
// ==========================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Dare Backend running on port ${PORT}`
    );

  }
);

