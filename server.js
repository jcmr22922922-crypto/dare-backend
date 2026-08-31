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
   DARE QUEUE
========================================== */

const dareQueue = [];

let currentDare = null;

let dareCounter = 0;


/* ==========================================
   BASIC SERVER
========================================== */

app.get("/", (req, res) => {

  res.json({

    status: "online",

    service: "Dare Backend",

    queueLength:
      dareQueue.length,

    currentDare:
      currentDare

  });

});


/* ==========================================
   WEBSOCKET
========================================== */

const wss =
  new WebSocket.Server({

    server: server,

    path: "/ws"

  });


function broadcast(message) {

  const data =
    JSON.stringify(message);


  wss.clients.forEach(
    (client) => {

      if (
        client.readyState ===
        WebSocket.OPEN
      ) {

        client.send(data);

      }

    }
  );

}


/* ==========================================
   SEND CURRENT STATE
========================================== */

function sendState(socket) {

  socket.send(

    JSON.stringify({

      type:
        "STATE",

      currentDare:
        currentDare,

      queue:
        dareQueue

    })

  );

}


/* ==========================================
   WEBSOCKET CONNECTION
========================================== */

wss.on(
  "connection",
  (socket) => {

    console.log(
      "WebSocket client connected"
    );


    sendState(socket);


    socket.on(
      "close",
      () => {

        console.log(
          "WebSocket client disconnected"
        );

      }
    );

  }
);


/* ==========================================
   MOVE NEXT DARE INTO CURRENT
========================================== */

function processNextDare() {

  if (currentDare) {

    return;

  }


  if (
    dareQueue.length === 0
  ) {

    return;

  }


  currentDare =
    dareQueue.shift();


  console.log(
    "Now processing dare:",
    currentDare
  );


  broadcast({

    type:
      "NEW_DARE",

    dare:
      currentDare,

    queue:
      dareQueue

  });

}


/* ==========================================
   CREATE DARE
========================================== */

app.post(
  "/api/dare",
  (req, res) => {

    const {
      viewer,
      text,
      duration,
      reward
    } = req.body;


    if (
      !text ||
      !text.trim()
    ) {

      return res.status(400).json({

        error:
          "Dare text is required."

      });

    }


    dareCounter++;


    const dare = {

      id:
        String(dareCounter),

      viewer:
        viewer ||
        "Anonymous",

      text:
        text.trim(),

      duration:
        Number(duration) || 30,

      reward:
        Number(reward) || 0,

      status:
        "pending",

      createdAt:
        new Date().toISOString()

    };


    dareQueue.push(dare);


    console.log(
      "Dare added to queue:",
      dare
    );


    processNextDare();


    broadcast({

      type:
        "QUEUE_UPDATED",

      queue:
        dareQueue,

      currentDare:
        currentDare

    });


    res.status(201).json({

      success:
        true,

      dare:
        dare,

      queuePosition:
        dareQueue.length

    });

  }
);


/* ==========================================
   GET CURRENT STATE
========================================== */

app.get(
  "/api/dare",
  (req, res) => {

    res.json({

      currentDare:
        currentDare,

      queue:
        dareQueue

    });

  }
);


/* ==========================================
   UPDATE DARE STATUS
========================================== */

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
      !allowedStatuses.includes(
        status
      )
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
      "Dare status changed:",
      currentDare
    );


    broadcast({

      type:
        "DARE_STATUS",

      dare:
        currentDare,

      queue:
        dareQueue

    });


    /*
    ========================================
    FINISHED DARE
    ========================================
    */

    if (

      status === "completed" ||

      status === "failed" ||

      status === "rejected"

    ) {


      setTimeout(
        () => {

          /*
          Only clear if this is
          still the same dare.
          */

          if (

            currentDare &&

            currentDare.id === id

          ) {

            currentDare =
              null;


            broadcast({

              type:
                "DARE_CLEARED",

              queue:
                dareQueue

            });


            /*
            Automatically process
            the next queued dare.
            */

            processNextDare();


            broadcast({

              type:
                "QUEUE_UPDATED",

              queue:
                dareQueue,

              currentDare:
                currentDare

            });

          }

        },

        1500

      );

    }


    res.json({

      success:
        true,

      dare:
        currentDare,

      queue:
        dareQueue

    });

  }
);


/* ==========================================
   CLEAR EVERYTHING
   ========================================== */

app.post(
  "/api/dare/clear",
  (req, res) => {

    dareQueue.length = 0;

    currentDare =
      null;


    broadcast({

      type:
        "RESET"

    });


    res.json({

      success:
        true

    });

  }
);


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

