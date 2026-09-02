const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

/* ==========================================
   MIDDLEWARE
========================================== */

app.use(cors());
app.use(express.json());

/* ==========================================
   POSTGRESQL
========================================== */

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL error:", error);
});

/* ==========================================
   DATABASE INITIALIZATION
========================================== */

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

        reward NUMERIC(12, 2)
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

    console.log("PostgreSQL database initialized.");
  } catch (error) {
    console.error(
      "Failed to initialize PostgreSQL:",
      error
    );

    process.exit(1);
  }
}

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
   WEBSOCKET
========================================== */

const wss = new WebSocket.Server({
  server: server,
  path: "/ws"
});

/* ==========================================
   DATABASE HELPERS
========================================== */

/*
Convert a PostgreSQL dare row into the
same format your frontend already expects.
*/

function formatDare(row) {
  if (!row) {
    return null;
  }

  return {
    id: String(row.id),

    streamer: row.streamer,

    streamerSource: row.streamer_source,

    viewer: row.viewer,

    text: row.dare_text,

    duration: Number(row.duration),

    reward: Number(row.reward),

    status: row.status,

    createdAt: row.created_at
      ? new Date(row.created_at).toISOString()
      : null,

    acceptedAt: row.accepted_at
      ? new Date(row.accepted_at).toISOString()
      : undefined,

    updatedAt: row.updated_at
      ? new Date(row.updated_at).toISOString()
      : undefined
  };
}

/* ==========================================
   GET QUEUES FROM DATABASE
========================================== */

async function getAllQueuesFromDatabase() {
  const result = await pool.query(`
    SELECT *
    FROM dares
    WHERE status = 'pending'
    ORDER BY created_at ASC, id ASC
  `);

  const queues = {};

  for (const row of result.rows) {
    const key = row.streamer.toLowerCase();

    if (!queues[key]) {
      queues[key] = [];
    }

    queues[key].push(
      formatDare(row)
    );
  }

  return queues;
}

/* ==========================================
   GET ACTIVE DARES FROM DATABASE
========================================== */

async function getActiveDaresFromDatabase() {
  const result = await pool.query(`
    SELECT *
    FROM dares
    WHERE status = 'accepted'
    ORDER BY accepted_at ASC, id ASC
  `);

  return result.rows.map(formatDare);
}

/* ==========================================
   GET ACTIVE DARE FOR STREAMER
========================================== */

async function getActiveDareForStreamer(
  streamer
) {
  const result = await pool.query(
    `
      SELECT *
      FROM dares
      WHERE LOWER(streamer) = LOWER($1)
      AND status = 'accepted'
      ORDER BY accepted_at DESC
      LIMIT 1
    `,
    [streamer]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return formatDare(
    result.rows[0]
  );
}

/* ==========================================
   GET STREAMER QUEUE
========================================== */

async function getStreamerQueue(
  streamer
) {
  const result = await pool.query(
    `
      SELECT *
      FROM dares
      WHERE LOWER(streamer) = LOWER($1)
      AND status = 'pending'
      ORDER BY created_at ASC, id ASC
    `,
    [streamer]
  );

  return result.rows.map(formatDare);
}

/* ==========================================
   GET CURRENT STATE
========================================== */

async function getCurrentState() {
  const queues =
    await getAllQueuesFromDatabase();

  const activeDares =
    await getActiveDaresFromDatabase();

  return {
    activeDares: activeDares,
    queues: queues,
    streamers: connectedStreamers
  };
}

/* ==========================================
   BROADCAST
========================================== */

function broadcast(message) {
  const data =
    JSON.stringify(message);

  wss.clients.forEach((client) => {
    if (
      client.readyState ===
      WebSocket.OPEN
    ) {
      try {
        client.send(data);
      } catch (error) {
        console.error(
          "WebSocket send error:",
          error
        );
      }
    }
  });
}

/* ==========================================
   SEND CURRENT STATE
========================================== */

async function sendState(socket) {
  try {
    const state =
      await getCurrentState();

    socket.send(
      JSON.stringify({
        type: "STATE",

        activeDares:
          state.activeDares,

        queues:
          state.queues,

        streamers:
          state.streamers
      })
    );
  } catch (error) {
    console.error(
      "Failed to send state:",
      error
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

    sendState(socket);

    socket.on(
      "message",
      async (rawMessage) => {
        try {
          const message =
            JSON.parse(
              rawMessage.toString()
            );

          if (
            message.type ===
            "GET_STATE"
          ) {
            await sendState(socket);
          }
        } catch (error) {
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
   BASIC SERVER
========================================== */

app.get(
  "/",
  async (req, res) => {
    try {
      const active =
        await getActiveDaresFromDatabase();

      const result =
        await pool.query(
          `
            SELECT COUNT(*) AS count
            FROM dares
          `
        );

      res.json({
        status: "online",

        service:
          "Dare Backend",

        database:
          "connected",

        connectedStreamers:
          connectedStreamers.length,

        activeDares:
          active.length,

        totalDares:
          Number(
            result.rows[0].count
          )
      });
    } catch (error) {
      console.error(
        "Status endpoint error:",
        error
      );

      res.status(500).json({
        status: "error",
        database: "error"
      });
    }
  }
);

/* ==========================================
   STREAMER LOOKUP
========================================== */

function findStreamer(
  username
) {
  if (!username) {
    return null;
  }

  const normalized =
    username
      .trim()
      .replace(/^@/, "")
      .toLowerCase();

  return connectedStreamers.find(
    (streamer) =>
      streamer.username
        .toLowerCase() ===
      normalized
  );
}

/* ==========================================
   GET /api/streamers
========================================== */

app.get(
  "/api/streamers",
  (req, res) => {
    const streamers =
      connectedStreamers
        .filter(
          (streamer) =>
            streamer.connected === true
        )
        .map(
          (streamer) => ({
            username:
              streamer.username,

            displayName:
              streamer.displayName,

            connected:
              true
          })
        );

    res.json({
      streamers:
        streamers
    });
  }
);

/* ==========================================
   CREATE DARE
========================================== */

app.post(
  "/api/dare",
  async (req, res) => {
    try {
      const {
        viewer,
        text,
        duration,
        reward,
        streamer,
        streamerSource
      } = req.body;

      /* VALIDATE TEXT */

      if (
        !text ||
        !text.trim()
      ) {
        return res.status(400).json({
          error:
            "Dare text is required."
        });
      }

      /* VALIDATE STREAMER */

      if (
        !streamer ||
        !streamer.trim()
      ) {
        return res.status(400).json({
          error:
            "A target streamer is required."
        });
      }

      const cleanStreamer =
        streamer
          .trim()
          .replace(/^@/, "");

      /* VALIDATE CONNECTED STREAMER */

      if (
        streamerSource ===
        "connected"
      ) {
        const registeredStreamer =
          findStreamer(
            cleanStreamer
          );

        if (!registeredStreamer) {
          return res.status(400).json({
            error:
              "That streamer is not currently connected."
          });
        }
      }

      /* VALIDATE DURATION */

      const dareDuration =
        Number(duration);

      if (
        !Number.isFinite(
          dareDuration
        ) ||
        dareDuration < 5 ||
        dareDuration > 300
      ) {
        return res.status(400).json({
          error:
            "Duration must be between 5 and 300 seconds."
        });
      }

      /* VALIDATE REWARD */

      const dareReward =
        Number(reward);

      if (
        !Number.isFinite(
          dareReward
        ) ||
        dareReward < 0
      ) {
        return res.status(400).json({
          error:
            "Reward must be a valid number."
        });
      }

      /* INSERT INTO DATABASE */

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

            streamerSource ||
              "twitch_username",

            viewer
              ? String(viewer).trim()
              : "Anonymous",

            text.trim(),

            dareDuration,

            dareReward
          ]
        );

      const dare =
        formatDare(
          result.rows[0]
        );

      const streamerKey =
        cleanStreamer.toLowerCase();

      /* GET UPDATED QUEUE */

      const queue =
        await getStreamerQueue(
          cleanStreamer
        );

      console.log(
        "Dare added to PostgreSQL:",
        dare
      );

      /* BROADCAST */

      broadcast({
        type:
          "DARE_CREATED",

        dare:
          dare,

        queue:
          queue
      });

      broadcast({
        type:
          "QUEUE_UPDATED",

        streamer:
          cleanStreamer,

        queue:
          queue
      });

      /* RESPONSE */

      res.status(201).json({
        success:
          true,

        dare:
          dare,

        queuePosition:
          queue.length,

        streamer:
          streamerKey
      });
    } catch (error) {
      console.error(
        "Create dare error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to create dare."
      });
    }
  }
);

/* ==========================================
   GET CURRENT STATE
========================================== */

app.get(
  "/api/dare",
  async (req, res) => {
    try {
      const state =
        await getCurrentState();

      res.json(state);
    } catch (error) {
      console.error(
        "Get state error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to get current state."
      });
    }
  }
);

/* ==========================================
   GET STREAMER QUEUE
========================================== */

app.get(
  "/api/dare/queue/:streamer",
  async (req, res) => {
    try {
      const streamer =
        req.params.streamer
          .trim()
          .replace(/^@/, "")
          .toLowerCase();

      const queue =
        await getStreamerQueue(
          streamer
        );

      res.json({
        streamer:
          streamer,

        queue:
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

/* ==========================================
   GET ACTIVE DARE
========================================== */

app.get(
  "/api/dare/active/:streamer",
  async (req, res) => {
    try {
      const streamer =
        req.params.streamer
          .trim()
          .replace(/^@/, "")
          .toLowerCase();

      const activeDare =
        await getActiveDareForStreamer(
          streamer
        );

      res.json({
        activeDare:
          activeDare
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

/* ==========================================
   ACCEPT DARE
========================================== */

app.post(
  "/api/dare/:id/status",
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const { id } =
        req.params;

      const { status } =
        req.body;

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
        client.release();

        return res.status(400).json({
          error:
            "Invalid dare status."
        });
      }

      await client.query(
        "BEGIN"
      );

      /* ==================================
         FIND DARE
      ================================== */

      const dareResult =
        await client.query(
          `
            SELECT *
            FROM dares
            WHERE id = $1
            FOR UPDATE
          `,
          [id]
        );

      if (
        dareResult.rows.length === 0
      ) {
        await client.query(
          "ROLLBACK"
        );

        client.release();

        return res.status(404).json({
          error:
            "Dare not found."
        });
      }

      const row =
        dareResult.rows[0];

      const dare =
        formatDare(row);

      const streamerKey =
        row.streamer.toLowerCase();

      /* ==================================
         ACCEPT
      ================================== */

      if (
        status === "accepted"
      ) {
        /* Check existing active dare */

        const activeResult =
          await client.query(
            `
              SELECT id
              FROM dares
              WHERE LOWER(streamer) =
                    LOWER($1)
              AND status = 'accepted'
              LIMIT 1
              FOR UPDATE
            `,
            [row.streamer]
          );

        if (
          activeResult.rows.length > 0
        ) {
          await client.query(
            "ROLLBACK"
          );

          client.release();

          return res.status(409).json({
            error:
              "This streamer already has an active dare."
          });
        }

        /* Make sure this dare is pending */

        if (
          row.status !== "pending"
        ) {
          await client.query(
            "ROLLBACK"
          );

          client.release();

          return res.status(409).json({
            error:
              "This dare is no longer pending."
          });
        }

        /* Accept */

        const updateResult =
          await client.query(
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

        await client.query(
          "COMMIT"
        );

        client.release();

        const acceptedDare =
          formatDare(
            updateResult.rows[0]
          );

        const queue =
          await getStreamerQueue(
            streamerKey
          );

        console.log(
          "ACTIVE DARE:",
          acceptedDare
        );

        broadcast({
          type:
            "ACTIVE_DARE",

          dare:
            acceptedDare,

          streamer:
            acceptedDare.streamer,

          queue:
            queue
        });

        broadcast({
          type:
            "QUEUE_UPDATED",

          streamer:
            acceptedDare.streamer,

          queue:
            queue
        });

        return res.json({
          success:
            true,

          dare:
            acceptedDare,

          queue:
            queue
        });
      }

      /* ==================================
         REJECT
      ================================== */

      if (
        status === "rejected"
      ) {
        if (
          row.status !==
          "pending"
        ) {
          await client.query(
            "ROLLBACK"
          );

          client.release();

          return res.status(409).json({
            error:
              "Only pending dares can be rejected."
          });
        }

        const updateResult =
          await client.query(
            `
              UPDATE dares

              SET
                status = 'rejected',
                updated_at = NOW()

              WHERE id = $1

              RETURNING *
            `,
            [id]
          );

        await client.query(
          "COMMIT"
        );

        client.release();

        const rejectedDare =
          formatDare(
            updateResult.rows[0]
          );

        const queue =
          await getStreamerQueue(
            streamerKey
          );

        broadcast({
          type:
            "DARE_REJECTED",

          dare:
            rejectedDare,

          streamer:
            rejectedDare.streamer
        });

        broadcast({
          type:
            "QUEUE_UPDATED",

          streamer:
            rejectedDare.streamer,

          queue:
            queue
        });

        return res.json({
          success:
            true,

          dare:
            rejectedDare,

          queue:
            queue
        });
      }

      /* ==================================
         COMPLETED / FAILED
      ================================== */

      if (
        status === "completed" ||
        status === "failed"
      ) {
        if (
          row.status !==
          "accepted"
        ) {
          await client.query(
            "ROLLBACK"
          );

          client.release();

          return res.status(409).json({
            error:
              "Only active dares can be completed or failed."
          });
        }

        const updateResult =
          await client.query(
            `
              UPDATE dares

              SET
                status = $1,
                updated_at = NOW()

              WHERE id = $2

              RETURNING *
            `,
            [
              status,
              id
            ]
          );

        await client.query(
          "COMMIT"
        );

        client.release();

        const finishedDare =
          formatDare(
            updateResult.rows[0]
          );

        const queue =
          await getStreamerQueue(
            streamerKey
          );

        broadcast({
          type:
            status ===
            "completed"
              ? "DARE_COMPLETED"
              : "DARE_FAILED",

          dare:
            finishedDare,

          streamer:
            finishedDare.streamer
        });

        broadcast({
          type:
            "ACTIVE_DARE_CLEARED",

          streamer:
            finishedDare.streamer
        });

        broadcast({
          type:
            "QUEUE_UPDATED",

          streamer:
            finishedDare.streamer,

          queue:
            queue
        });

        return res.json({
          success:
            true,

          dare:
            finishedDare,

          queue:
            queue
        });
      }

      await client.query(
        "ROLLBACK"
      );

      client.release();

      return res.status(400).json({
        error:
          "Unsupported status."
      });

    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (_) {}

      client.release();

      console.error(
        "Update dare status error:",
        error
      );

      return res.status(500).json({
        error:
          "Failed to update dare status."
      });
    }
  }
);

/* ==========================================
   GET DARE HISTORY
========================================== */

app.get(
  "/api/dare/history",
  async (req, res) => {
    try {
      const result =
        await pool.query(`
          SELECT *
          FROM dares

          WHERE status IN (
            'completed',
            'failed',
            'rejected'
          )

          ORDER BY
            updated_at DESC,
            id DESC
        `);

      res.json({
        history:
          result.rows.map(
            formatDare
          )
      });
    } catch (error) {
      console.error(
        "Get history error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to get dare history."
      });
    }
  }
);

/* ==========================================
   CLEAR EVERYTHING
========================================== */

app.post(
  "/api/dare/clear",
  async (req, res) => {
    try {
      await pool.query(`
        UPDATE dares

        SET
          status = 'rejected',
          updated_at = NOW()

        WHERE status IN (
          'pending',
          'accepted'
        )
      `);

      broadcast({
        type:
          "RESET"
      });

      res.json({
        success:
          true
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

/* ==========================================
   START SERVER
========================================== */

async function startServer() {
  try {
    await initializeDatabase();

    server.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `Dare Backend running on port ${PORT}`
        );

        console.log(
          "PostgreSQL: connected"
        );

        console.log(
          "WebSocket: /ws"
        );
      }
    );
  } catch (error) {
    console.error(
      "Failed to start server:",
      error
    );

    process.exit(1);
  }
}

startServer();
