const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

/* =========================================================
   MIDDLEWARE
========================================================= */

app.use(cors());
app.use(express.json());

/* =========================================================
   DATABASE
========================================================= */

if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL is missing.");
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

/* =========================================================
   WEBSOCKET
========================================================= */

const wss = new WebSocket.Server({
    server: server,
    path: "/ws"
});

/* =========================================================
   CONNECTED CLIENTS
========================================================= */

wss.on("connection", function(ws) {

    console.log("🟢 WebSocket client connected.");

    sendState(ws);

    ws.on("message", async function(rawMessage) {

        try {

            const message =
                JSON.parse(rawMessage.toString());

            if (message.type === "GET_STATE") {
                await sendState(ws);
            }

        } catch (error) {

            console.error(
                "❌ WebSocket message error:",
                error
            );

        }

    });

    ws.on("close", function() {

        console.log(
            "🔴 WebSocket client disconnected."
        );

    });

    ws.on("error", function(error) {

        console.error(
            "❌ WebSocket client error:",
            error
        );

    });

});

/* =========================================================
   WEBSOCKET HELPERS
========================================================= */

function broadcast(message) {

    const data =
        JSON.stringify(message);

    wss.clients.forEach(client => {

        if (client.readyState === WebSocket.OPEN) {

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

/* =========================================================
   FORMAT DARE
========================================================= */

function formatDare(row) {

    if (!row) {
        return null;
    }

    return {

        id:
            Number(row.id),

        streamer:
            row.streamer,

        streamerSource:
            row.streamer_source,

        viewer:
            row.viewer,

        dareText:
            row.dare_text,

        duration:
            Number(row.duration),

        reward:
            Number(row.reward || 0),

        status:
            row.status,

        createdAt:
            row.created_at,

        acceptedAt:
            row.accepted_at,

        updatedAt:
            row.updated_at

    };

}

/* =========================================================
   GET ACTIVE DARES
========================================================= */

async function getActiveDaresFromDatabase() {

    const result =
        await pool.query(`

            SELECT *

            FROM dares

            WHERE status = 'accepted'

            ORDER BY accepted_at ASC, id ASC

        `);

    const active = {};

    result.rows.forEach(row => {

        const key =
            String(row.streamer)
                .trim()
                .toLowerCase();

        active[key] =
            formatDare(row);

    });

    return active;

}

/* =========================================================
   GET QUEUES
========================================================= */

async function getAllQueuesFromDatabase() {

    const result =
        await pool.query(`

            SELECT *

            FROM dares

            WHERE status = 'pending'

            ORDER BY created_at ASC, id ASC

        `);

    const queues = {};

    result.rows.forEach(row => {

        const key =
            String(row.streamer)
                .trim()
                .toLowerCase();

        if (!queues[key]) {
            queues[key] = [];
        }

        queues[key].push(
            formatDare(row)
        );

    });

    return queues;

}

/* =========================================================
   SEND STATE
========================================================= */

async function sendState(ws) {

    try {

        const active =
            await getActiveDaresFromDatabase();

        const queues =
            await getAllQueuesFromDatabase();

        if (ws.readyState === WebSocket.OPEN) {

            ws.send(
                JSON.stringify({

                    type:
                        "STATE",

                    active:
                        active,

                    queues:
                        queues

                })
            );

        }

    } catch (error) {

        console.error(
            "❌ Failed to send state:",
            error
        );

    }

}

/* =========================================================
   GET ACTIVE DARE FOR STREAMER
========================================================= */

async function getActiveDareForStreamer(streamer) {

    const result =
        await pool.query(

            `

            SELECT *

            FROM dares

            WHERE LOWER(TRIM(streamer))
                = LOWER(TRIM($1::VARCHAR))

            AND status = 'accepted'

            ORDER BY accepted_at ASC, id ASC

            LIMIT 1

            `,

            [streamer]

        );

    if (!result.rows.length) {
        return null;
    }

    return formatDare(
        result.rows[0]
    );

}

/* =========================================================
   GET STREAMER QUEUE
========================================================= */

async function getStreamerQueue(streamer) {

    const result =
        await pool.query(

            `

            SELECT *

            FROM dares

            WHERE LOWER(TRIM(streamer))
                = LOWER(TRIM($1::VARCHAR))

            AND status = 'pending'

            ORDER BY created_at ASC, id ASC

            `,

            [streamer]

        );

    return result.rows.map(
        formatDare
    );

}

/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

async function initializeDatabase() {

    await pool.query(`

        CREATE TABLE IF NOT EXISTS dares (

            id SERIAL PRIMARY KEY,

            streamer VARCHAR(255) NOT NULL,

            streamer_source VARCHAR(50)
                NOT NULL
                DEFAULT 'twitch_username',

            viewer VARCHAR(255)
                NOT NULL
                DEFAULT 'Anonymous',

            dare_text TEXT NOT NULL,

            duration INTEGER NOT NULL,

            reward NUMERIC(12,2)
                NOT NULL
                DEFAULT 0,

            status VARCHAR(30)
                NOT NULL
                DEFAULT 'pending',

            created_at TIMESTAMP WITH TIME ZONE
                NOT NULL
                DEFAULT NOW(),

            accepted_at TIMESTAMP WITH TIME ZONE,

            updated_at TIMESTAMP WITH TIME ZONE

        );

    `);

    await pool.query(`

        CREATE INDEX IF NOT EXISTS
        idx_dares_streamer_status

        ON dares (
            streamer,
            status
        );

    `);

    await pool.query(`

        CREATE INDEX IF NOT EXISTS
        idx_dares_created_at

        ON dares (
            created_at
        );

    `);

    console.log(
        "✅ Database initialized."
    );

}

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/", function(req, res) {

    res.json({

        status:
            "online",

        service:
            "dare-backend",

        websocket:
            "/ws",

        time:
            new Date().toISOString()

    });

});

/* =========================================================
   STREAMERS
========================================================= */

const connectedStreamers = [

    {

        username:
            "IShowSloow_",

        displayName:
            "IShowSloow_",

        connected:
            true

    }

];

app.get(
    "/api/streamers",
    function(req, res) {

        res.json(
            connectedStreamers
        );

    }
);

/* =========================================================
   CREATE DARE
=========================================================

   NO ACTIVE DARE:

       submission
          ↓
       ACCEPTED
          ↓
       ACTIVE_DARE
          ↓
       OVERLAY

   ACTIVE DARE EXISTS:

       submission
          ↓
       PENDING
          ↓
       QUEUE

========================================================= */

app.post(
    "/api/dare",
    async function(req, res) {

        const {

            streamer,

            streamer_source,

            viewer,

            dare_text,

            duration,

            reward

        } = req.body;

        /* -------------------------------------------------
           VALIDATION
        ------------------------------------------------- */

        if (
            !streamer ||
            typeof streamer !== "string"
        ) {

            return res.status(400).json({

                error:
                    "Streamer is required."

            });

        }

        if (
            !dare_text ||
            typeof dare_text !== "string"
        ) {

            return res.status(400).json({

                error:
                    "Dare text is required."

            });

        }

        const cleanDareText =
            dare_text.trim();

        if (!cleanDareText) {

            return res.status(400).json({

                error:
                    "Dare text cannot be empty."

            });

        }

        const durationNumber =
            Number(duration);

        if (
            !Number.isFinite(durationNumber) ||
            durationNumber < 5 ||
            durationNumber > 300
        ) {

            return res.status(400).json({

                error:
                    "Duration must be between 5 and 300 seconds."

            });

        }

        const rewardNumber =
            Number(reward || 0);

        if (
            !Number.isFinite(rewardNumber) ||
            rewardNumber < 0
        ) {

            return res.status(400).json({

                error:
                    "Reward cannot be negative."

            });

        }

        const cleanStreamer =
            streamer.trim();

        const cleanViewer =
            String(
                viewer || "Anonymous"
            ).trim() ||
            "Anonymous";

        const cleanSource =
            String(
                streamer_source ||
                "twitch_username"
            ).trim();

        const client =
            await pool.connect();

        try {

            await client.query(
                "BEGIN"
            );

            /* -------------------------------------------------
               LOCK STREAMER
            ------------------------------------------------- */

            await client.query(

                `

                SELECT
                    pg_advisory_xact_lock(
                        hashtext(
                            LOWER(TRIM($1::VARCHAR))
                        )
                    )

                `,

                [cleanStreamer]

            );

            /* -------------------------------------------------
               CHECK ACTIVE DARE
            ------------------------------------------------- */

            const activeResult =
                await client.query(

                    `

                    SELECT *

                    FROM dares

                    WHERE LOWER(TRIM(streamer))
                        = LOWER(TRIM($1::VARCHAR))

                    AND status = 'accepted'

                    LIMIT 1

                    `,

                    [cleanStreamer]

                );

            const hasActiveDare =
                activeResult.rows.length > 0;

            /* -------------------------------------------------
               DETERMINE STATUS
            ------------------------------------------------- */

            const newStatus =
                hasActiveDare
                    ? "pending"
                    : "accepted";

            /* -------------------------------------------------
               INSERT DARE

               IMPORTANT FIX:
               Every parameter has an explicit PostgreSQL type.

               $1 = VARCHAR
               $2 = VARCHAR
               $3 = VARCHAR
               $4 = TEXT
               $5 = INTEGER
               $6 = NUMERIC
               $7 = VARCHAR
            ------------------------------------------------- */

            const insertResult =
                await client.query(

                    `

                    INSERT INTO dares (

                        streamer,

                        streamer_source,

                        viewer,

                        dare_text,

                        duration,

                        reward,

                        status,

                        accepted_at,

                        updated_at

                    )

                    VALUES (

                        $1::VARCHAR,
                        $2::VARCHAR,
                        $3::VARCHAR,
                        $4::TEXT,
                        $5::INTEGER,
                        $6::NUMERIC,
                        $7::VARCHAR,

                        CASE
                            WHEN $7::VARCHAR = 'accepted'
                            THEN NOW()
                            ELSE NULL
                        END,

                        NOW()

                    )

                    RETURNING *

                    `,

                    [

                        cleanStreamer,

                        cleanSource,

                        cleanViewer,

                        cleanDareText,

                        Math.floor(
                            durationNumber
                        ),

                        rewardNumber,

                        newStatus

                    ]

                );

            const dare =
                formatDare(
                    insertResult.rows[0]
                );

            await client.query(
                "COMMIT"
            );

            /* -------------------------------------------------
               IMMEDIATELY ACTIVE
            ------------------------------------------------- */

            if (
                newStatus === "accepted"
            ) {

                console.log(
                    "🔥 DARE IMMEDIATELY ACTIVE:",
                    dare
                );

                broadcast({

                    type:
                        "ACTIVE_DARE",

                    dare:
                        dare

                });

                return res.status(201).json({

                    success:
                        true,

                    message:
                        "Dare is now LIVE.",

                    dare:
                        dare

                });

            }

            /* -------------------------------------------------
               PENDING
            ------------------------------------------------- */

            console.log(
                "🟡 DARE ADDED TO QUEUE:",
                dare
            );

            const queue =
                await getStreamerQueue(
                    cleanStreamer
                );

            broadcast({

                type:
                    "QUEUE_UPDATED",

                streamer:
                    cleanStreamer,

                queue:
                    queue

            });

            return res.status(201).json({

                success:
                    true,

                message:
                    "Dare added to pending queue.",

                dare:
                    dare

            });

        } catch (error) {

            try {

                await client.query(
                    "ROLLBACK"
                );

            } catch (_) {}

            console.error(
                "❌ CREATE DARE ERROR:",
                error
            );

            return res.status(500).json({

                error:
                    "Failed to create dare."

            });

        } finally {

            client.release();

        }

    }
);

/* =========================================================
   GET ALL DARE STATE
========================================================= */

app.get(
    "/api/dare",
    async function(req, res) {

        try {

            const active =
                await getActiveDaresFromDatabase();

            const queues =
                await getAllQueuesFromDatabase();

            res.json({

                active:
                    active,

                queues:
                    queues

            });

        } catch (error) {

            console.error(
                error
            );

            res.status(500).json({

                error:
                    "Failed to get dare state."

            });

        }

    }
);

/* =========================================================
   GET STREAMER QUEUE
========================================================= */

app.get(
    "/api/dare/queue/:streamer",
    async function(req, res) {

        try {

            const queue =
                await getStreamerQueue(
                    req.params.streamer
                );

            res.json(
                queue
            );

        } catch (error) {

            console.error(
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
    async function(req, res) {

        try {

            const dare =
                await getActiveDareForStreamer(
                    req.params.streamer
                );

            res.json(
                dare
            );

        } catch (error) {

            console.error(
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
   UPDATE DARE STATUS
========================================================= */

app.post(
    "/api/dare/:id/status",
    async function(req, res) {

        const id =
            Number(
                req.params.id
            );

        const status =
            String(
                req.body.status || ""
            ).trim().toLowerCase();

        const allowedStatuses = [

            "accepted",
            "rejected",
            "completed",
            "failed"

        ];

        if (!Number.isInteger(id)) {

            return res.status(400).json({

                error:
                    "Invalid dare ID."

            });

        }

        if (
            !allowedStatuses.includes(status)
        ) {

            return res.status(400).json({

                error:
                    "Invalid status."

            });

        }

        const client =
            await pool.connect();

        try {

            await client.query(
                "BEGIN"
            );

            /* -------------------------------------------------
               LOCK DARE
            ------------------------------------------------- */

            const dareResult =
                await client.query(

                    `

                    SELECT *

                    FROM dares

                    WHERE id = $1::INTEGER

                    FOR UPDATE

                    `,

                    [id]

                );

            if (!dareResult.rows.length) {

                await client.query(
                    "ROLLBACK"
                );

                return res.status(404).json({

                    error:
                        "Dare not found."

                });

            }

            const existing =
                dareResult.rows[0];

            const streamer =
                existing.streamer;

            /* -------------------------------------------------
               ACCEPT
            ------------------------------------------------- */

            if (status === "accepted") {

                const activeResult =
                    await client.query(

                        `

                        SELECT *

                        FROM dares

                        WHERE LOWER(TRIM(streamer))
                            = LOWER(TRIM($1::VARCHAR))

                        AND status = 'accepted'

                        AND id <> $2::INTEGER

                        LIMIT 1

                        `,

                        [
                            streamer,
                            id
                        ]

                    );

                if (activeResult.rows.length) {

                    await client.query(
                        "ROLLBACK"
                    );

                    return res.status(409).json({

                        error:
                            "Another dare is already active for this streamer."

                    });

                }

                const result =
                    await client.query(

                        `

                        UPDATE dares

                        SET

                            status = 'accepted',

                            accepted_at =
                                COALESCE(
                                    accepted_at,
                                    NOW()
                                ),

                            updated_at =
                                NOW()

                        WHERE id = $1::INTEGER

                        RETURNING *

                        `,

                        [id]

                    );

                const dare =
                    formatDare(
                        result.rows[0]
                    );

                await client.query(
                    "COMMIT"
                );

                broadcast({

                    type:
                        "ACTIVE_DARE",

                    dare:
                        dare

                });

                return res.json({

                    success:
                        true,

                    dare:
                        dare

                });

            }

            /* -------------------------------------------------
               REJECT
            ------------------------------------------------- */

            if (status === "rejected") {

                const result =
                    await client.query(

                        `

                        UPDATE dares

                        SET

                            status = 'rejected',

                            updated_at =
                                NOW()

                        WHERE id = $1::INTEGER

                        RETURNING *

                        `,

                        [id]

                    );

                const dare =
                    formatDare(
                        result.rows[0]
                    );

                await client.query(
                    "COMMIT"
                );

                const queue =
                    await getStreamerQueue(
                        streamer
                    );

                broadcast({

                    type:
                        "DARE_REJECTED",

                    dare:
                        dare

                });

                broadcast({

                    type:
                        "QUEUE_UPDATED",

                    streamer:
                        streamer,

                    queue:
                        queue

                });

                return res.json({

                    success:
                        true,

                    dare:
                        dare

                });

            }

            /* -------------------------------------------------
               COMPLETED / FAILED
            ------------------------------------------------- */

            if (
                status === "completed" ||
                status === "failed"
            ) {

                if (
                    existing.status !== "accepted"
                ) {

                    await client.query(
                        "ROLLBACK"
                    );

                    return res.status(409).json({

                        error:
                            "Only an active dare can be completed or failed."

                    });

                }

                const result =
                    await client.query(

                        `

                        UPDATE dares

                        SET

                            status = $1::VARCHAR,

                            updated_at =
                                NOW()

                        WHERE id = $2::INTEGER

                        RETURNING *

                        `,

                        [
                            status,
                            id
                        ]

                    );

                const dare =
                    formatDare(
                        result.rows[0]
                    );

                await client.query(
                    "COMMIT"
                );

                if (status === "completed") {

                    broadcast({

                        type:
                            "DARE_COMPLETED",

                        dare:
                            dare

                    });

                } else {

                    broadcast({

                        type:
                            "DARE_FAILED",

                        dare:
                            dare

                    });

                }

                broadcast({

                    type:
                        "ACTIVE_DARE_CLEARED",

                    streamer:
                        streamer

                });

                const queue =
                    await getStreamerQueue(
                        streamer
                    );

                broadcast({

                    type:
                        "QUEUE_UPDATED",

                    streamer:
                        streamer,

                    queue:
                        queue

                });

                return res.json({

                    success:
                        true,

                    dare:
                        dare,

                    queue:
                        queue

                });

            }

        } catch (error) {

            try {

                await client.query(
                    "ROLLBACK"
                );

            } catch (_) {}

            console.error(
                "❌ STATUS UPDATE ERROR:",
                error
            );

            return res.status(500).json({

                error:
                    "Failed to update dare status."

            });

        } finally {

            client.release();

        }

    }
);

/* =========================================================
   HISTORY
========================================================= */

app.get(
    "/api/dare/history",
    async function(req, res) {

        try {

            const limit =
                Math.min(
                    Number(
                        req.query.limit || 100
                    ),
                    500
                );

            const result =
                await pool.query(

                    `

                    SELECT *

                    FROM dares

                    ORDER BY created_at DESC

                    LIMIT $1::INTEGER

                    `,

                    [limit]

                );

            res.json(
                result.rows.map(
                    formatDare
                )
            );

        } catch (error) {

            console.error(
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
    async function(req, res) {

        try {

            await pool.query(
                "DELETE FROM dares"
            );

            broadcast({

                type:
                    "RESET"

            });

            res.json({

                success:
                    true,

                message:
                    "All dares cleared."

            });

        } catch (error) {

            console.error(
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

    try {

        await initializeDatabase();

        server.listen(
            PORT,
            function() {

                console.log("");
                console.log(
                    "================================"
                );

                console.log(
                    "🎯 DARE BACKEND ONLINE"
                );

                console.log(
                    "================================"
                );

                console.log(
                    "HTTP:",
                    `http://localhost:${PORT}`
                );

                console.log(
                    "WebSocket:",
                    `ws://localhost:${PORT}/ws`
                );

                console.log(
                    "================================"
                );

            }
        );

    } catch (error) {

        console.error(
            "❌ Failed to start server:",
            error
        );

        process.exit(1);

    }

}

startServer();
