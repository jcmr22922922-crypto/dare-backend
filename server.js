const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* =========================================================
   DATABASE
========================================================= */

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});


/* =========================================================
   DATABASE SETUP
========================================================= */

async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dares (
        id SERIAL PRIMARY KEY,

        streamer VARCHAR(255) NOT NULL,

        streamer_source VARCHAR(50)
          NOT NULL DEFAULT 'twitch_username',

        viewer VARCHAR(255)
          NOT NULL DEFAULT 'Anonymous',

        dare_text TEXT NOT NULL,

        duration INTEGER NOT NULL,

        reward NUMERIC(12,2)
          NOT NULL DEFAULT 0,

        status VARCHAR(30)
          NOT NULL DEFAULT 'pending',

        created_at TIMESTAMP WITH TIME ZONE
          NOT NULL DEFAULT NOW(),

        accepted_at TIMESTAMP WITH TIME ZONE,

        updated_at TIMESTAMP WITH TIME ZONE
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_dares_streamer
      ON dares(streamer);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_dares_status
      ON dares(status);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_dares_created_at
      ON dares(created_at);
    `);

    console.log("PostgreSQL initialized.");
  } catch (error) {
    console.error("Database initialization error:", error);
  }
}


/* =========================================================
   WEBSOCKET
========================================================= */

const wss = new WebSocket.Server({
  server,
  path: "/ws"
});


function broadcast(message) {
  const payload = JSON.stringify(message);

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}


async function sendState(ws) {
  try {
    const state = await getCurrentState();

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "STATE",
          ...state
        })
      );
    }
  } catch (error) {
    console.error("sendState error:", error);
  }
}


wss.on("connection", async (ws) => {
  console.log("WebSocket client connected.");

  await sendState(ws);

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "GET_STATE") {
        await sendState(ws);
      }
    } catch (error) {
      console.error("WebSocket message error:", error);
    }
  });

  ws.on("close", () => {
    console.log("WebSocket client disconnected.");
  });
});


/* =========================================================
   FORMAT DARE
========================================================= */

function formatDare(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,

    streamer: row.streamer,

    streamerSource: row.streamer_source,

    viewer: row.viewer,

    dareText: row.dare_text,

    duration: Number(row.duration),

    reward: Number(row.reward),

    status: row.status,

    createdAt: row.created_at,

    acceptedAt: row.accepted_at,

    updatedAt: row.updated_at
  };
}


/* =========================================================
   GET ALL QUEUES
========================================================= */

async function getAllQueuesFromDatabase() {
  const result = await pool.query(`
    SELECT *
    FROM dares
    WHERE status = 'pending'
    ORDER BY created_at ASC, id ASC
  `);

  const queues = {};

  for (const row of result.rows) {
    const streamer = row.streamer;

    if (!queues[streamer]) {
      queues[streamer] = [];
    }

    queues[streamer].push(
      formatDare(row)
    );
  }

  return queues;
}


/* =========================================================
   GET ACTIVE DARES
========================================================= */

async function getActiveDaresFromDatabase() {
  const result = await pool.query(`
    SELECT *
    FROM dares
    WHERE status = 'accepted'
    ORDER BY accepted_at ASC, id ASC
  `);

  const active = {};

  for (const row of result.rows) {
    active[row.streamer] =
      formatDare(row);
  }

  return active;
}


/* =========================================================
   GET ACTIVE DARE FOR STREAMER
========================================================= */

async function getActiveDareForStreamer(streamer) {
  const result = await pool.query(
    `
      SELECT *
      FROM dares
      WHERE streamer = $1
        AND status = 'accepted'
      ORDER BY accepted_at ASC, id ASC
      LIMIT 1
    `,
    [streamer]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return formatDare(result.rows[0]);
}


/* =========================================================
   GET STREAMER QUEUE
========================================================= */

async function getStreamerQueue(streamer) {
  const result = await pool.query(
    `
      SELECT *
      FROM dares
      WHERE streamer = $1
        AND status = 'pending'
      ORDER BY created_at ASC, id ASC
    `,
    [streamer]
  );

  return result.rows.map(formatDare);
}


/* =========================================================
   CURRENT STATE
========================================================= */

async function getCurrentState() {
  const [queues, active] =
    await Promise.all([
      getAllQueuesFromDatabase(),
      getActiveDaresFromDatabase()
    ]);

  return {
    active,
    queues
  };
}


/* =========================================================
   STREAMERS
========================================================= */

const connectedStreamers = [
  {
    username: "IShowSloow_",
    displayName: "IShowSloow_",
    connected: true
  }
];


/* =========================================================
   ROOT
========================================================= */

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "dare-backend",
    websocket: "/ws"
  });
});


/* =========================================================
   GET STREAMERS
========================================================= */

app.get("/api/streamers", (req, res) => {
  res.json(connectedStreamers);
});


/* =========================================================
   CREATE DARE
========================================================= */

app.post("/api/dare", async (req, res) => {
  try {
    const {
      streamer,
      streamer_source,
      viewer,
      dare_text,
      duration,
      reward
    } = req.body;

    /* -----------------------------------------
       VALIDATION
    ----------------------------------------- */

    if (!streamer || !String(streamer).trim()) {
      return res.status(400).json({
        error: "Streamer is required."
      });
    }

    if (!dare_text || !String(dare_text).trim()) {
      return res.status(400).json({
        error: "Dare text is required."
      });
    }

    const cleanStreamer =
      String(streamer).trim();

    const cleanViewer =
      viewer && String(viewer).trim()
        ? String(viewer).trim()
        : "Anonymous";

    const cleanDare =
      String(dare_text).trim();

    const cleanDuration =
      Number(duration);

    const cleanReward =
      Number(reward || 0);

    if (
      !Number.isFinite(cleanDuration) ||
      cleanDuration < 5 ||
      cleanDuration > 300
    ) {
      return res.status(400).json({
        error:
          "Duration must be between 5 and 300 seconds."
      });
    }

    if (
      !Number.isFinite(cleanReward) ||
      cleanReward < 0
    ) {
      return res.status(400).json({
        error:
          "Reward must be 0 or greater."
      });
    }


    /* -----------------------------------------
       CHECK IF STREAMER ALREADY HAS ACTIVE DARE
    ----------------------------------------- */

    const activeDare =
      await getActiveDareForStreamer(
        cleanStreamer
      );


    /* -----------------------------------------
       CREATE AS PENDING
       
       IMPORTANT:
       NEVER automatically activate it.
    ----------------------------------------- */

    const result =
      await pool.query(
        `
          INSERT INTO dares (
            streamer,
            streamer_source,
            viewer,
            dare_text,
            duration,
            reward,
            status
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            'pending'
          )
          RETURNING *
        `,
        [
          cleanStreamer,
          streamer_source || "twitch_username",
          cleanViewer,
          cleanDare,
          cleanDuration,
          cleanReward
        ]
      );


    const dare =
      formatDare(result.rows[0]);


    /* -----------------------------------------
       BROADCAST NEW DARE
    ----------------------------------------- */

    broadcast({
      type: "DARE_CREATED",
      dare
    });


    /* -----------------------------------------
       UPDATE QUEUE
    ----------------------------------------- */

    const queue =
      await getStreamerQueue(
        cleanStreamer
      );

    broadcast({
      type: "QUEUE_UPDATED",
      streamer: cleanStreamer,
      queue
    });


    /* -----------------------------------------
       RESPONSE
    ----------------------------------------- */

    return res.status(201).json({
      success: true,
      dare,
      activeDare
    });

  } catch (error) {
    console.error(
      "Create dare error:",
      error
    );

    return res.status(500).json({
      error:
        "Failed to create dare."
    });
  }
});


/* =========================================================
   GET ALL DARE STATE
========================================================= */

app.get("/api/dare", async (req, res) => {
  try {
    const state =
      await getCurrentState();

    res.json(state);

  } catch (error) {
    console.error(
      "Get dare state error:",
      error
    );

    res.status(500).json({
      error:
        "Failed to get dare state."
    });
  }
});


/* =========================================================
   GET STREAMER QUEUE
========================================================= */

app.get(
  "/api/dare/queue/:streamer",
  async (req, res) => {

    try {
      const streamer =
        req.params.streamer;

      const queue =
        await getStreamerQueue(
          streamer
        );

      res.json({
        streamer,
        queue
      });

    } catch (error) {
      console.error(
        "Get queue error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to get queue."
      });
    }

  }
);


/* =========================================================
   GET ACTIVE DARE
========================================================= */

app.get(
  "/api/dare/active/:streamer",
  async (req, res) => {

    try {
      const streamer =
        req.params.streamer;

      const active =
        await getActiveDareForStreamer(
          streamer
        );

      res.json({
        streamer,
        activeDare: active
      });

    } catch (error) {
      console.error(
        "Get active dare error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to get active dare."
      });
    }

  }
);


/* =========================================================
   ACCEPT / REJECT / COMPLETE / FAIL
========================================================= */

app.post(
  "/api/dare/:id/status",
  async (req, res) => {

    try {

      const id =
        Number(req.params.id);

      const {
        status
      } = req.body;


      if (!Number.isInteger(id)) {
        return res.status(400).json({
          error:
            "Invalid dare ID."
        });
      }


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
            "Invalid status."
        });

      }


      /* =====================================================
         ACCEPT
      ===================================================== */

      if (status === "accepted") {

        /* -----------------------------------------
           Get requested dare
        ----------------------------------------- */

        const dareResult =
          await pool.query(
            `
              SELECT *
              FROM dares
              WHERE id = $1
              LIMIT 1
            `,
            [id]
          );


        if (dareResult.rows.length === 0) {

          return res.status(404).json({
            error:
              "Dare not found."
          });

        }


        const dare =
          dareResult.rows[0];


        /* -----------------------------------------
           Only pending dares can be accepted
        ----------------------------------------- */

        if (dare.status !== "pending") {

          return res.status(400).json({
            error:
              `Dare cannot be accepted because its current status is "${dare.status}".`
          });

        }


        /* -----------------------------------------
           CHECK ACTIVE DARE
        ----------------------------------------- */

        const active =
          await getActiveDareForStreamer(
            dare.streamer
          );


        if (active) {

          return res.status(409).json({
            error:
              "This streamer already has an active dare.",
            activeDare: active
          });

        }


        /* -----------------------------------------
           ACCEPT MANUALLY
        ----------------------------------------- */

        const result =
          await pool.query(
            `
              UPDATE dares

              SET
                status = 'accepted',
                accepted_at = NOW(),
                updated_at = NOW()

              WHERE id = $1

              RETURNING *
            `,
            [id]
          );


        const acceptedDare =
          formatDare(
            result.rows[0]
          );


        /* -----------------------------------------
           BROADCAST ACTIVE DARE
        ----------------------------------------- */

        broadcast({
          type: "ACTIVE_DARE",
          dare: acceptedDare
        });


        /* -----------------------------------------
           UPDATE QUEUE
        ----------------------------------------- */

        const queue =
          await getStreamerQueue(
            dare.streamer
          );


        broadcast({
          type: "QUEUE_UPDATED",
          streamer: dare.streamer,
          queue
        });


        return res.json({
          success: true,
          dare: acceptedDare
        });

      }


      /* =====================================================
         REJECT
      ===================================================== */

      if (status === "rejected") {

        const result =
          await pool.query(
            `
              UPDATE dares

              SET
                status = 'rejected',
                updated_at = NOW()

              WHERE id = $1
                AND status = 'pending'

              RETURNING *
            `,
            [id]
          );


        if (result.rows.length === 0) {

          return res.status(404).json({
            error:
              "Pending dare not found."
          });

        }


        const rejectedDare =
          formatDare(
            result.rows[0]
          );


        broadcast({
          type: "DARE_REJECTED",
          dare: rejectedDare
        });


        const queue =
          await getStreamerQueue(
            rejectedDare.streamer
          );


        broadcast({
          type: "QUEUE_UPDATED",
          streamer:
            rejectedDare.streamer,
          queue
        });


        return res.json({
          success: true,
          dare: rejectedDare
        });

      }


      /* =====================================================
         COMPLETE / FAIL
      ===================================================== */

      if (
        status === "completed" ||
        status === "failed"
      ) {

        const result =
          await pool.query(
            `
              UPDATE dares

              SET
                status = $1,
                updated_at = NOW()

              WHERE id = $2
                AND status = 'accepted'

              RETURNING *
            `,
            [
              status,
              id
            ]
          );


        if (result.rows.length === 0) {

          return res.status(404).json({
            error:
              "Active dare not found."
          });

        }


        const finishedDare =
          formatDare(
            result.rows[0]
          );


        /* -----------------------------------------
           BROADCAST FINISH
        ----------------------------------------- */

        broadcast({
          type:
            status === "completed"
              ? "DARE_COMPLETED"
              : "DARE_FAILED",

          dare: finishedDare
        });


        /* -----------------------------------------
           CLEAR ACTIVE DARE
           
           IMPORTANT:
           DO NOT ACTIVATE NEXT QUEUE ITEM.
        ----------------------------------------- */

        broadcast({
          type: "ACTIVE_DARE_CLEARED",
          streamer:
            finishedDare.streamer
        });


        /* -----------------------------------------
           SEND UPDATED QUEUE
        ----------------------------------------- */

        const queue =
          await getStreamerQueue(
            finishedDare.streamer
          );


        broadcast({
          type: "QUEUE_UPDATED",
          streamer:
            finishedDare.streamer,
          queue
        });


        return res.json({
          success: true,
          dare: finishedDare,
          activeDare: null,
          queue
        });

      }


    } catch (error) {

      console.error(
        "Dare status error:",
        error
      );

      return res.status(500).json({
        error:
          "Failed to update dare status."
      });

    }

  }
);


/* =========================================================
   HISTORY
========================================================= */

app.get(
  "/api/dare/history",
  async (req, res) => {

    try {

      const result =
        await pool.query(`
          SELECT *
          FROM dares
          ORDER BY created_at DESC
          LIMIT 200
        `);


      res.json(
        result.rows.map(formatDare)
      );

    } catch (error) {

      console.error(
        "History error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to get history."
      });

    }

  }
);


/* =========================================================
   CLEAR ALL DARES
========================================================= */

app.post(
  "/api/dare/clear",
  async (req, res) => {

    try {

      await pool.query(`
        DELETE FROM dares
      `);


      broadcast({
        type: "RESET"
      });


      res.json({
        success: true
      });

    } catch (error) {

      console.error(
        "Clear dares error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to clear dares."
      });

    }

  }
);


/* =========================================================
   START SERVER
========================================================= */

async function startServer() {

  await initializeDatabase();


  server.listen(
    PORT,
    () => {

      console.log(
        `Dare backend running on port ${PORT}`
      );

      console.log(
        `WebSocket running at /ws`
      );

    }
  );

}


startServer();
