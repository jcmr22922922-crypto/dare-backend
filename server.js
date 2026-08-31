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
   DATA
========================================== */

/*
   QUEUES ARE NOW SEPARATED BY STREAMER

   Example:

   streamerA:
      [ dare1, dare2 ]

   streamerB:
      [ dare3, dare4 ]
*/

const streamerQueues = {};


/*
   ACTIVE DARES

   Multiple streamers can have active dares
   at the same time.

   Example:

   [
      {
        id: "1",
        streamer: "streamerA",
        status: "accepted"
      },

      {
        id: "2",
        streamer: "streamerB",
        status: "accepted"
      }
   ]
*/

const activeDares = [];


/*
   Completed / failed / rejected dares
*/

const dareHistory = [];


/*
   ID counter
*/

let dareCounter = 0;


/* ==========================================
   BASIC SERVER
========================================== */

app.get("/", (req, res) => {

  res.json({

    status: "online",

    service: "Dare Backend",

    activeDares:
      activeDares.length,

    streamers:
      Object.keys(streamerQueues).length,

    queues:
      streamerQueues

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


/* ==========================================
   BROADCAST
========================================== */

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
   SEND STATE TO CLIENT
========================================== */

function sendState(socket) {

  socket.send(

    JSON.stringify({

      type:
        "ACTIVE_DARES_STATE",

      activeDares:
        activeDares,

      queues:
        streamerQueues,

      history:
        dareHistory

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


    /*
       IMPORTANT:

       When a website/controller connects,
       immediately send the current state.

       This means refreshing the homepage
       does NOT destroy the live dare list.
    */

    sendState(socket);


    socket.on(
      "message",
      (message) => {

        try {

          const data =
            JSON.parse(message);


          /*
             Client can explicitly request
             the current state.
          */

          if (
            data.type ===
            "GET_ACTIVE_DARES"
          ) {

            sendState(socket);

          }

        }

        catch (error) {

          console.error(
            "Invalid WebSocket message:",
            error
          );

        }

      }
    );


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
   CREATE STREAMER QUEUE
========================================== */

function ensureStreamerQueue(streamer) {

  if (
    !streamerQueues[streamer]
  ) {

    streamerQueues[streamer] = [];

  }

}


/* ==========================================
   GET ACTIVE DARE FOR STREAMER
========================================== */

function getActiveDareForStreamer(streamer) {

  return activeDares.find(
    (dare) =>
      dare.streamer === streamer
  );

}


/* ==========================================
   PROCESS NEXT DARE
========================================== */

function processNextDare(streamer) {

  ensureStreamerQueue(streamer);


  /*
     A streamer can only have ONE
     currently running dare.

     Other streamers can simultaneously
     have their own active dare.
  */

  if (
    getActiveDareForStreamer(streamer)
  ) {

    return;

  }


  if (
    streamerQueues[streamer].length === 0
  ) {

    return;

  }


  const dare =
    streamerQueues[streamer].shift();


  /*
     The dare is now waiting for
     streamer acceptance.

     It is NOT added to activeDares yet.
  */

  dare.status =
    "pending";


  console.log(
    "New dare ready for streamer:",
    streamer,
    dare
  );


  broadcast({

    type:
      "NEW_DARE",

    dare:
      dare,

    queue:
      streamerQueues[streamer],

    streamer:
      streamer

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
          "Streamer is required."

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


    const cleanStreamer =
      streamer.trim()
        .replace(/^@/, "")
        .toLowerCase();


    const cleanViewer =
      viewer &&
      viewer.trim()

        ? viewer.trim()

        : "Anonymous";


    const cleanText =
      text.trim();


    const cleanDuration =
      Number(duration) || 30;


    const cleanReward =
      Number(reward) || 0;


    if (
      cleanDuration < 5 ||
      cleanDuration > 300
    ) {

      return res.status(400).json({

        error:
          "Duration must be between 5 and 300 seconds."

      });

    }


    if (
      cleanReward < 0
    ) {

      return res.status(400).json({

        error:
          "Reward cannot be negative."

      });

    }


    /* =========================
       CREATE DARE
    ========================= */

    dareCounter++;


    const dare = {

      id:
        String(dareCounter),

      streamer:
        cleanStreamer,

      viewer:
        cleanViewer,

      text:
        cleanText,

      duration:
        cleanDuration,

      reward:
        cleanReward,

      status:
        "pending",

      createdAt:
        new Date().toISOString()

    };


    /* =========================
       ADD TO STREAMER QUEUE
    ========================= */

    ensureStreamerQueue(
      cleanStreamer
    );


    streamerQueues[
      cleanStreamer
    ].push(dare);


    console.log(
      "Dare added:",
      dare
    );


    /* =========================
       PROCESS STREAMER QUEUE
    ========================= */

    processNextDare(
      cleanStreamer
    );


    /* =========================
       BROADCAST
    ========================= */

    broadcast({

      type:
        "QUEUE_UPDATED",

      streamer:
        cleanStreamer,

      queue:
        streamerQueues[
          cleanStreamer
        ],

      activeDares:
        activeDares

    });


    /* =========================
       RESPONSE
    ========================= */

    res.status(201).json({

      success:
        true,

      dare:
        dare,

      queuePosition:
        streamerQueues[
          cleanStreamer
        ].length

    });

  }
);


/* ==========================================
   GET ALL STATE
========================================== */

app.get(
  "/api/dare",
  (req, res) => {

    res.json({

      activeDares:
        activeDares,

      queues:
        streamerQueues,

      history:
        dareHistory

    });

  }
);


/* ==========================================
   GET STREAMER STATE
========================================== */

app.get(
  "/api/dare/streamer/:streamer",
  (req, res) => {

    const streamer =
      req.params.streamer
        .replace(/^@/, "")
        .toLowerCase();


    ensureStreamerQueue(
      streamer
    );


    const activeDare =
      getActiveDareForStreamer(
        streamer
      );


    res.json({

      streamer:
        streamer,

      currentDare:
        activeDare,

      queue:
        streamerQueues[
          streamer
        ]

    });

  }
);


/* ==========================================
   ACCEPT DARE
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


    /*
       Search the streamer queues
       for the dare.

       This is necessary because pending
       dares are stored in streamer queues.
    */

    let dare = null;

    let streamer = null;


    for (
      const streamerName
      of Object.keys(streamerQueues)
    ) {

      const queue =
        streamerQueues[
          streamerName
        ];


      const index =
        queue.findIndex(
          (item) =>
            item.id === id
        );


      if (
        index !== -1
      ) {

        dare =
          queue[index];


        streamer =
          streamerName;


        /*
           Remove from queue.
        */

        queue.splice(
          index,
          1
        );


        break;

      }

    }


    /*
       If not found in queue,
       check active dares.
    */

    if (!dare) {

      dare =
        activeDares.find(
          (item) =>
            item.id === id
        );


      if (dare) {

        streamer =
          dare.streamer;

      }

    }


    if (!dare) {

      return res.status(404).json({

        error:
          "Dare not found."

      });

    }


    /* ========================================
       ACCEPTED
    ======================================== */

    if (
      status === "accepted"
    ) {

      /*
         Prevent multiple active dares
         for the same streamer.
      */

      if (
        getActiveDareForStreamer(
          streamer
        )
      ) {

        /*
           Put dare back in queue.
        */

        streamerQueues[
          streamer
        ].unshift(dare);


        return res.status(409).json({

          error:
            "This streamer already has an active dare."

        });

      }


      dare.status =
        "accepted";


      dare.acceptedAt =
        new Date().toISOString();


      activeDares.push(
        dare
      );


      console.log(
        "DARE ACCEPTED:",
        dare
      );


      /*
         THIS IS THE EVENT THE HOMEPAGE
         WILL USE TO SHOW THE TWITCH STREAM.
      */

      broadcast({

        type:
          "ACTIVE_DARE",

        dare:
          dare,

        activeDares:
          activeDares

      });


      /*
         Also tell controllers
         that the queue changed.
      */

      broadcast({

        type:
          "QUEUE_UPDATED",

        streamer:
          streamer,

        queue:
          streamerQueues[
            streamer
          ],

        activeDares:
          activeDares

      });


      return res.json({

        success:
          true,

        dare:
          dare,

        activeDares:
          activeDares

      });

    }


    /* ========================================
       REJECTED
    ======================================== */

    if (
      status === "rejected"
    ) {

      dare.status =
        "rejected";


      dare.updatedAt =
        new Date().toISOString();


      dareHistory.push(
        dare
      );


      console.log(
        "DARE REJECTED:",
        dare
      );


      broadcast({

        type:
          "DARE_REJECTED",

        dare:
          dare,

        activeDares:
          activeDares

      });


      /*
         Move to next dare
         for this streamer.
      */

      processNextDare(
        streamer
      );


      broadcast({

        type:
          "QUEUE_UPDATED",

        streamer:
          streamer,

        queue:
          streamerQueues[
            streamer
          ],

        activeDares:
          activeDares

      });


      return res.json({

        success:
          true,

        dare:
          dare,

        activeDares:
          activeDares

      });

    }


    /* ========================================
       COMPLETED / FAILED
    ======================================== */

    if (

      status === "completed" ||

      status === "failed"

    ) {

      /*
         Find the active dare.
      */

      const activeIndex =
        activeDares.findIndex(
          (item) =>
            item.id === id
        );


      if (
        activeIndex === -1
      ) {

        return res.status(404).json({

          error:
            "Active dare not found."

        });

      }


      const activeDare =
        activeDares[
          activeIndex
        ];


      activeDare.status =
        status;


      activeDare.updatedAt =
        new Date().toISOString();


      activeDare.completedAt =
        new Date().toISOString();


      /*
         Save to history.
      */

      dareHistory.push(
        activeDare
      );


      /*
         Remove from active list.
      */

      activeDares.splice(
        activeIndex,
        1
      );


      console.log(
        "DARE FINISHED:",
        activeDare
      );


      /*
         Tell homepage to remove
         Twitch stream.
      */

      broadcast({

        type:
          status === "completed"

            ? "DARE_COMPLETED"

            : "DARE_FAILED",

        dare:
          activeDare,

        activeDares:
          activeDares

      });


      /*
         Process next dare
         for this streamer.
      */

      processNextDare(
        streamer
      );


      broadcast({

        type:
          "QUEUE_UPDATED",

        streamer:
          streamer,

        queue:
          streamerQueues[
            streamer
          ],

        activeDares:
          activeDares

      });


      return res.json({

        success:
          true,

        dare:
          activeDare,

        activeDares:
          activeDares

      });

    }

  }
);


/* ==========================================
   GET ACTIVE DARES
========================================== */

app.get(
  "/api/active-dares",
  (req, res) => {

    res.json({

      activeDares:
        activeDares

    });

  }
);


/* ==========================================
   GET DARE HISTORY
========================================== */

app.get(
  "/api/dare/history",
  (req, res) => {

    res.json({

      history:
        dareHistory

    });

  }
);


/* ==========================================
   CLEAR EVERYTHING
========================================== */

app.post(
  "/api/dare/clear",
  (req, res) => {

    /*
       Clear queues.
    */

    Object.keys(
      streamerQueues
    ).forEach(
      (streamer) => {

        streamerQueues[
          streamer
        ] = [];

      }
    );


    /*
       Clear active dares.
    */

    activeDares.length = 0;


    /*
       Clear history.
    */

    dareHistory.length = 0;


    broadcast({

      type:
        "RESET",

      activeDares:
        [],

      queues:
        {}

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
