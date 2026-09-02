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
   WEBSOCKET
========================================================= */

const wss = new WebSocket.Server({
    server,
    path: "/ws"
});

function broadcast(message) {
    const data = JSON.stringify(message);

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

function sendState(ws, state) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(
            JSON.stringify({
                type: "STATE",
                ...state
            })
        );
    }
}

/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

async function initializeDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS dares (
            id SERIAL PRIMARY KEY,
            streamer VARCHAR(255) NOT NULL,
            streamer_source VARCHAR(50) NOT NULL DEFAULT 'twitch_username',
            viewer VARCHAR(255) NOT NULL DEFAULT 'Anonymous',
            dare_text TEXT NOT NULL,
            duration INTEGER NOT NULL,
            reward NUMERIC(12,2) NOT NULL DEFAULT 0,
            status VARCHAR(30) NOT NULL DEFAULT 'pending',
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            accepted_at TIMESTAMP WITH TIME ZONE,
            updated_at TIMESTAMP WITH TIME ZONE
        );
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_dares_streamer_status
        ON dares(streamer, status);
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_dares_created_at
        ON dares(created_at);
    `);

    console.log("PostgreSQL initialized.");
}

/* =========================================================
   HELPERS
========================================================= */

function formatDare(row) {
    if (!row) return null;

    return {
        id: row.id,
        streamer: row.streamer,
        streamer_source: row.streamer_source,
        viewer: row.viewer,
        dare_text: row.dare_text,
        duration: Number(row.duration),
        reward: Number(row.reward),
        status: row.status,
        created_at: row.created_at,
        accepted_at: row.accepted_at,
        updated_at: row.updated_at
    };
}

/* ---------------------------------------------------------
   Get all pending queues
--------------------------------------------------------- */

async function getAllQueuesFromDatabase() {
    const result = await pool.query(`
        SELECT *
        FROM dares
        WHERE status = 'pending'
        ORDER BY created_at ASC
    `);

    const queues = {};

    for (const row of result.rows) {
        const dare = formatDare(row);

        const key = dare.streamer.toLowerCase();

        if (!queues[key]) {
            queues[key] = [];
        }

        queues[key].push(dare);
    }

    return queues;
}

/* ---------------------------------------------------------
   Get all active dares
--------------------------------------------------------- */

async function getActiveDaresFromDatabase() {
    const result = await pool.query(`
        SELECT *
        FROM dares
        WHERE status = 'accepted'
        ORDER BY accepted_at ASC
    `);

    return result.rows.map(formatDare);
}

/* ---------------------------------------------------------
   Get active dare for streamer
--------------------------------------------------------- */

async function getActiveDareForStreamer(streamer) {
    const result = await pool.query(
        `
        SELECT *
        FROM dares
        WHERE LOWER(streamer) = LOWER($1)
        AND status = 'accepted'
        ORDER BY accepted_at ASC
        LIMIT 1
        `,
        [streamer]
    );

    return result.rows.length
        ? formatDare(result.rows[0])
        : null;
}

/* ---------------------------------------------------------
   Get queue for streamer
--------------------------------------------------------- */

async function getStreamerQueue(streamer) {
    const result = await pool.query(
        `
        SELECT *
        FROM dares
        WHERE LOWER(streamer) = LOWER($1)
        AND status = 'pending'
        ORDER BY created_at ASC
        `,
        [streamer]
    );

    return result.rows.map(formatDare);
}

/* ---------------------------------------------------------
   Connected streamers
--------------------------------------------------------- */

const connectedStreamers = [
    {
        username: "IShowSloow_",
        displayName: "IShowSloow_",
        connected: true
    }
];

/* ---------------------------------------------------------
   Get current state
--------------------------------------------------------- */

async function getCurrentState() {
    const activeDares = await getActiveDaresFromDatabase();
    const queues = await getAllQueuesFromDatabase();

    return {
        streamers: connectedStreamers,
        activeDares,
        queues
    };
}

/* =========================================================
   AUTOMATIC DARE ACTIVATION
========================================================= */

/*
    This is the main change.

    If a streamer has no active dare:
        oldest pending dare becomes active.

    This function is called:
        - when a new dare is submitted
        - when an active dare finishes
        - when an active dare fails
        - when the server starts
*/

async function activateNextDare(streamer) {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        /* Check if streamer already has an active dare */

        const activeResult = await client.query(
            `
            SELECT *
            FROM dares
            WHERE LOWER(streamer) = LOWER($1)
            AND status = 'accepted'
            ORDER BY accepted_at ASC
            LIMIT 1
            FOR UPDATE
            `,
            [streamer]
        );

        if (activeResult.rows.length > 0) {
            await client.query("COMMIT");

            return formatDare(activeResult.rows[0]);
        }

        /* Find oldest pending dare */

        const pendingResult = await client.query(
            `
            SELECT *
            FROM dares
            WHERE LOWER(streamer) = LOWER($1)
            AND status = 'pending'
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
            `,
            [streamer]
        );

        if (pendingResult.rows.length === 0) {
            await client.query("COMMIT");

            return null;
        }

        const dareId = pendingResult.rows[0].id;

        /* Turn pending dare into active */

        const updateResult = await client.query(
            `
            UPDATE dares
            SET
                status = 'accepted',
                accepted_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
            RETURNING *
            `,
            [dareId]
        );

        await client.query("COMMIT");

        const activeDare = formatDare(updateResult.rows[0]);

        console.log(
            `DARE ACTIVATED: #${activeDare.id} - ${activeDare.dare_text}`
        );

        /* Tell controller + overlay */

        broadcast({
            type: "ACTIVE_DARE",
            dare: activeDare
        });

        broadcast({
            type: "QUEUE_UPDATED",
            streamer: streamer,
            queue: await getStreamerQueue(streamer)
        });

        return activeDare;

    } catch (error) {
        await client.query("ROLLBACK");
        console.error("activateNextDare error:", error);

        throw error;

    } finally {
        client.release();
    }
}

/* =========================================================
   WEBSOCKET CONNECTION
========================================================= */

wss.on("connection", async (ws) => {
    console.log("WebSocket client connected.");

    try {
        const state = await getCurrentState();

        sendState(ws, state);
    } catch (error) {
        console.error("WebSocket state error:", error);
    }

    ws.on("message", async (message) => {
        try {
            const data = JSON.parse(message.toString());

            if (data.type === "GET_STATE") {
                const state = await getCurrentState();

                sendState(ws, state);
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
   HEALTH CHECK
========================================================= */

app.get("/", (req, res) => {
    res.json({
        status: "online",
        service: "dare-backend",
        websocket: "/ws"
    });
});

/* =========================================================
   STREAMERS
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
            streamer_source = "twitch_username",
            viewer = "Anonymous",
            dare_text,
            duration,
            reward = 0
        } = req.body;

        if (!streamer) {
            return res.status(400).json({
                error: "Streamer is required."
            });
        }

        if (!dare_text || !String(dare_text).trim()) {
            return res.status(400).json({
                error: "Dare text is required."
            });
        }

        const dareDuration = Number(duration);

        if (
            !Number.isFinite(dareDuration) ||
            dareDuration <= 0
        ) {
            return res.status(400).json({
                error: "Duration must be greater than 0."
            });
        }

        const dareReward = Number(reward);

        if (
            !Number.isFinite(dareReward) ||
            dareReward < 0
        ) {
            return res.status(400).json({
                error: "Reward must be 0 or greater."
            });
        }

        /*
            IMPORTANT:

            New dares start as pending.

            If there is no active dare, activateNextDare()
            immediately promotes it to accepted.
        */

        const result = await pool.query(
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
            VALUES ($1, $2, $3, $4, $5, $6, 'pending')
            RETURNING *
            `,
            [
                String(streamer).trim(),
                String(streamer_source).trim(),
                String(viewer || "Anonymous").trim(),
                String(dare_text).trim(),
                dareDuration,
                dareReward
            ]
        );

        const newDare = formatDare(result.rows[0]);

        console.log(
            `DARE CREATED: #${newDare.id} - ${newDare.dare_text}`
        );

        /*
            First tell clients that a dare was created.
        */

        broadcast({
            type: "DARE_CREATED",
            dare: newDare
        });

        /*
            Now automatically activate the next dare.

            If another dare is already active, this does nothing
            and the new dare stays in the queue.

            If there is NO active dare, the new dare becomes active.
        */

        const activeDare = await activateNextDare(
            newDare.streamer
        );

        const queue = await getStreamerQueue(
            newDare.streamer
        );

        res.status(201).json({
            success: true,
            dare: newDare,
            activeDare,
            queue
        });

    } catch (error) {
        console.error("POST /api/dare error:", error);

        res.status(500).json({
            error: "Failed to create dare."
        });
    }
});

/* =========================================================
   GET CURRENT STATE
========================================================= */

app.get("/api/dare", async (req, res) => {
    try {
        const state = await getCurrentState();

        res.json(state);

    } catch (error) {
        console.error("GET /api/dare error:", error);

        res.status(500).json({
            error: "Failed to get dare state."
        });
    }
});

/* =========================================================
   GET QUEUE
========================================================= */

app.get("/api/dare/queue/:streamer", async (req, res) => {
    try {
        const queue = await getStreamerQueue(
            req.params.streamer
        );

        res.json(queue);

    } catch (error) {
        console.error("Queue error:", error);

        res.status(500).json({
            error: "Failed to get queue."
        });
    }
});

/* =========================================================
   GET ACTIVE DARE
========================================================= */

app.get("/api/dare/active/:streamer", async (req, res) => {
    try {
        const active = await getActiveDareForStreamer(
            req.params.streamer
        );

        res.json(active);

    } catch (error) {
        console.error("Active dare error:", error);

        res.status(500).json({
            error: "Failed to get active dare."
        });
    }
});

/* =========================================================
   CHANGE DARE STATUS
========================================================= */

app.post("/api/dare/:id/status", async (req, res) => {
    const dareId = Number(req.params.id);
    const { status } = req.body;

    const allowedStatuses = [
        "accepted",
        "rejected",
        "completed",
        "failed"
    ];

    if (!Number.isInteger(dareId)) {
        return res.status(400).json({
            error: "Invalid dare ID."
        });
    }

    if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
            error: "Invalid status."
        });
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const dareResult = await client.query(
            `
            SELECT *
            FROM dares
            WHERE id = $1
            FOR UPDATE
            `,
            [dareId]
        );

        if (dareResult.rows.length === 0) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                error: "Dare not found."
            });
        }

        const dare = formatDare(dareResult.rows[0]);

        /*
            ACCEPTED

            Kept for compatibility with your controller.

            If someone manually calls ACCEPT on a pending dare,
            it will only work if there is no active dare.
        */

        if (status === "accepted") {
            const activeResult = await client.query(
                `
                SELECT id
                FROM dares
                WHERE LOWER(streamer) = LOWER($1)
                AND status = 'accepted'
                AND id <> $2
                LIMIT 1
                FOR UPDATE
                `,
                [dare.streamer, dare.id]
            );

            if (activeResult.rows.length > 0) {
                await client.query("ROLLBACK");

                return res.status(409).json({
                    error: "Another dare is already active."
                });
            }

            if (dare.status !== "pending") {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    error: "Only pending dares can be accepted."
                });
            }

            const updateResult = await client.query(
                `
                UPDATE dares
                SET
                    status = 'accepted',
                    accepted_at = NOW(),
                    updated_at = NOW()
                WHERE id = $1
                RETURNING *
                `,
                [dareId]
            );

            await client.query("COMMIT");

            const activeDare = formatDare(
                updateResult.rows[0]
            );

            broadcast({
                type: "ACTIVE_DARE",
                dare: activeDare
            });

            broadcast({
                type: "QUEUE_UPDATED",
                streamer: activeDare.streamer,
                queue: await getStreamerQueue(
                    activeDare.streamer
                )
            });

            return res.json({
                success: true,
                dare: activeDare
            });
        }

        /*
            REJECTED
        */

        if (status === "rejected") {
            await client.query(
                `
                UPDATE dares
                SET
                    status = 'rejected',
                    updated_at = NOW()
                WHERE id = $1
                `,
                [dareId]
            );

            await client.query("COMMIT");

            broadcast({
                type: "DARE_REJECTED",
                dare: dare
            });

            broadcast({
                type: "QUEUE_UPDATED",
                streamer: dare.streamer,
                queue: await getStreamerQueue(
                    dare.streamer
                )
            });

            /*
                If somehow this rejection left the streamer
                without an active dare, automatically start next.
            */

            await activateNextDare(dare.streamer);

            return res.json({
                success: true
            });
        }

        /*
            COMPLETED / FAILED

            After finishing, automatically start the next dare.
        */

        if (
            status === "completed" ||
            status === "failed"
        ) {
            await client.query(
                `
                UPDATE dares
                SET
                    status = $1,
                    updated_at = NOW()
                WHERE id = $2
                `,
                [status, dareId]
            );

            await client.query("COMMIT");

            if (status === "completed") {
                broadcast({
                    type: "DARE_COMPLETED",
                    dare: dare
                });
            } else {
                broadcast({
                    type: "DARE_FAILED",
                    dare: dare
                });
            }

            broadcast({
                type: "ACTIVE_DARE_CLEARED",
                dare: dare
            });

            /*
                THIS IS THE CONTINUOUS QUEUE.

                Automatically take the oldest waiting dare.
            */

            const nextDare = await activateNextDare(
                dare.streamer
            );

            broadcast({
                type: "QUEUE_UPDATED",
                streamer: dare.streamer,
                queue: await getStreamerQueue(
                    dare.streamer
                )
            });

            return res.json({
                success: true,
                completed: dare,
                nextDare
            });
        }

    } catch (error) {
        await client.query("ROLLBACK");

        console.error(
            "POST /api/dare/:id/status error:",
            error
        );

        res.status(500).json({
            error: "Failed to update dare status."
        });

    } finally {
        client.release();
    }
});

/* =========================================================
   HISTORY
========================================================= */

app.get("/api/dare/history", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT *
            FROM dares
            ORDER BY created_at DESC
            LIMIT 100
        `);

        res.json(
            result.rows.map(formatDare)
        );

    } catch (error) {
        console.error("History error:", error);

        res.status(500).json({
            error: "Failed to get history."
        });
    }
});

/* =========================================================
   CLEAR ALL DARes
========================================================= */

app.post("/api/dare/clear", async (req, res) => {
    try {
        const result = await pool.query(`
            UPDATE dares
            SET
                status = 'rejected',
                updated_at = NOW()
            WHERE status IN ('pending', 'accepted')
            RETURNING *
        `);

        broadcast({
            type: "RESET"
        });

        res.json({
            success: true,
            cleared: result.rows.length
        });

    } catch (error) {
        console.error("Clear dares error:", error);

        res.status(500).json({
            error: "Failed to clear dares."
        });
    }
});

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {
    try {
        await initializeDatabase();

        /*
            On startup, check every connected streamer.

            If there are pending dares and no active dare,
            automatically activate the oldest one.
        */

        for (const streamer of connectedStreamers) {
            try {
                await activateNextDare(
                    streamer.username
                );
            } catch (error) {
                console.error(
                    `Startup activation failed for ${streamer.username}:`,
                    error
                );
            }
        }

        server.listen(
            PORT,
            "0.0.0.0",
            () => {
                console.log(
                    `Dare backend running on port ${PORT}`
                );
                console.log(
                    `WebSocket available at /ws`
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
