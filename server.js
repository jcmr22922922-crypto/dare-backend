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


  /*
  ==========================================
  ACTIVE DARE RECOVERY

  If someone refreshes the homepage while
  a dare is already accepted, immediately
  tell the new client about it.
  ==========================================
  */

  if (
    currentDare &&
    currentDare.status === "accepted"
  ) {

    socket.send(

      JSON.stringify({

        type:
          "ACTIVE_DARE",

        dare:
          currentDare

      })

    );

  }

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


    /*
    Send current queue/current dare
    immediately after connection.
    */

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

      streamer,

      viewer,

      text,

      duration,

      reward

    } = req.body;


    /* =========================
       VALIDATION
    ========================= */

    if (
      !streamer ||
      !streamer.trim()
    ) {

      return res.status(400).json({

        error:
          "Streamer username is required."

      });

    }


    if (
      !text ||
      !text.trim()
    ) {

      return res.status(400).json({

        error:
          "Dare text is required."

      });

    }


    /* =========================
       CREATE DARE
    ========================= */

    dareCounter++;


    const dare = {

      id:
        String(dareCounter),


      /*
      Twitch streamer username
      */

      streamer:
        streamer.trim(),


      /*
      Viewer name
      */

      viewer:
        viewer
          ? viewer.trim()
          : "Anonymous",


      /*
      Dare text
      */

      text:
        text.trim(),


      /*
      Duration
      */

      duration:
        Number(duration) || 30,


      /*
      Reward
      */

      reward:
        Number(reward) || 0,


      /*
      Initial status
      */

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


    /*
    Process queue if no dare
    is currently active.
    */

    processNextDare();


    /*
    Tell connected clients that
    the queue changed.
    */

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


    /* =========================
       VALIDATE STATUS
    ========================= */

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


    /* =========================
       CHECK CURRENT DARE
    ========================= */

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


    /* =========================
       UPDATE STATUS
    ========================= */

    currentDare.status =
      status;


    currentDare.updatedAt =
      new Date().toISOString();


    console.log(
      "Dare status changed:",
      currentDare
    );


    /* =========================
       BROADCAST STATUS
    ========================= */

    broadcast({

      type:
        "DARE_STATUS",

      dare:
        currentDare,

      queue:
        dareQueue

    });


    /* =====================================
       ACCEPTED
       
       This is what activates the
       LIVE DARE Twitch section.
    ===================================== */

    if (
      status === "accepted"
    ) {

      console.log(
        "ACTIVE DARE:",
        currentDare
      );


      broadcast({

        type:
          "ACTIVE_DARE",

        dare:
          currentDare

      });

    }


    /* =====================================
       FINISHED DARE
    ===================================== */

    if (

      status === "completed" ||

      status === "failed" ||

      status === "rejected"

    ) {


      /*
      Tell the website immediately
      that the active dare is ending.
      */

      broadcast({

        type:
          "DARE_ENDED",

        status:
          status,

        dare:
          currentDare

      });


      /*
      Wait briefly so the controller
      and overlay can display the
      final result.
      */

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


            /*
            Tell all connected
            clients the active
            dare is gone.
            */

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


            /*
            Update queue state.
            */

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


    /* =========================
       RESPONSE
    ========================= */

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
