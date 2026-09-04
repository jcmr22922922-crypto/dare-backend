const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 3000);

const FRONTEND_ORIGIN =
    process.env.FRONTEND_ORIGIN ||
    "https://jcmr22922922-crypto.github.io";

const SESSION_DAYS =
    Number(process.env.SESSION_DAYS || 30);

const NODE_ENV =
    process.env.NODE_ENV || "development";

const IS_PRODUCTION =
    NODE_ENV === "production";

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
    },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

pool.on("error", error => {
    console.error("Unexpected PostgreSQL error:", error);
});

/* =========================================================
   EXPRESS
========================================================= */

app.disable("x-powered-by");

app.use(
    cors({
        origin: FRONTEND_ORIGIN,
        credentials: true,
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: [
            "Content-Type",
            "Authorization"
        ]
    })
);

app.use(
    express.json({
        limit: "16kb"
    })
);

/* =========================================================
   SECURITY HEADERS
========================================================= */

app.use((req, res, next) => {
    res.setHeader(
        "X-Content-Type-Options",
        "nosniff"
    );

    res.setHeader(
        "X-Frame-Options",
        "SAMEORIGIN"
    );

    res.setHeader(
        "Referrer-Policy",
        "strict-origin-when-cross-origin"
    );

    res.setHeader(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=()"
    );

    next();
});

/* =========================================================
   SIMPLE RATE LIMITER
========================================================= */

const rateBuckets = new Map();

function rateLimit({
    windowMs = 60 * 1000,
    max = 60
} = {}) {
    return (req, res, next) => {

        const key =
            `${req.ip}:${req.path}`;

        const now = Date.now();

        let bucket =
            rateBuckets.get(key);

        if (
            !bucket ||
            now - bucket.startedAt > windowMs
        ) {
            bucket = {
                startedAt: now,
                count: 0
            };

            rateBuckets.set(
                key,
                bucket
            );
        }

        bucket.count++;

        if (bucket.count > max) {
            return sendError(
                res,
                429,
                "RATE_LIMITED",
                "Too many requests. Please try again later."
            );
        }

        next();
    };
}

/* Prevent memory growth from old rate-limit keys. */
setInterval(() => {

    const cutoff =
        Date.now() - (15 * 60 * 1000);

    for (const [key, bucket] of rateBuckets) {

        if (
            bucket.startedAt < cutoff
        ) {
            rateBuckets.delete(key);
        }

    }

}, 10 * 60 * 1000).unref();

/* =========================================================
   API RESPONSE HELPERS
========================================================= */

function sendError(
    res,
    status,
    code,
    message
) {
    return res.status(status).json({
        success: false,
        error: {
            code,
            message
        }
    });
}

function sendSuccess(
    res,
    data = {},
    status = 200
) {
    return res.status(status).json({
        success: true,
        data
    });
}

/* =========================================================
   COOKIE HELPERS
========================================================= */

function parseCookies(req) {

    const header =
        req.headers.cookie;

    if (!header) {
        return {};
    }

    const cookies = {};

    for (
        const part of header.split(";")
    ) {

        const index =
            part.indexOf("=");

        if (index === -1) {
            continue;
        }

        const name =
            part.slice(0, index).trim();

        const value =
            part.slice(index + 1).trim();

        cookies[name] =
            decodeURIComponent(value);
    }

    return cookies;
}

function setSessionCookie(
    res,
    token
) {

    const maxAge =
        SESSION_DAYS *
        24 *
        60 *
        60 *
        1000;

    const parts = [
        `dare_session=${encodeURIComponent(token)}`,
        `Max-Age=${Math.floor(maxAge / 1000)}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax"
    ];

    if (IS_PRODUCTION) {
        parts.push("Secure");
    }

    res.setHeader(
        "Set-Cookie",
        parts.join("; ")
    );
}

function clearSessionCookie(res) {

    const parts = [
        "dare_session=",
        "Max-Age=0",
        "Path=/",
        "HttpOnly",
        "SameSite=Lax"
    ];

    if (IS_PRODUCTION) {
        parts.push("Secure");
    }

    res.setHeader(
        "Set-Cookie",
        parts.join("; ")
    );
}

/* =========================================================
   AUTH TOKEN HELPERS
========================================================= */

function createSessionToken() {

    return crypto
        .randomBytes(32)
        .toString("hex");

}

function hashSessionToken(token) {

    return crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");

}

/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

async function initializeDatabase() {

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,

            username VARCHAR(50)
                NOT NULL
                UNIQUE,

            email VARCHAR(320)
                NOT NULL
                UNIQUE,

            password_hash TEXT
                NOT NULL,

            role VARCHAR(30)
                NOT NULL
                DEFAULT 'viewer',

            created_at TIMESTAMPTZ
                NOT NULL
                DEFAULT NOW(),

            updated_at TIMESTAMPTZ
                NOT NULL
                DEFAULT NOW()
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS sessions (
            id SERIAL PRIMARY KEY,

            user_id INTEGER
                NOT NULL
                REFERENCES users(id)
                ON DELETE CASCADE,

            token_hash CHAR(64)
                NOT NULL
                UNIQUE,

            expires_at TIMESTAMPTZ
                NOT NULL,

            created_at TIMESTAMPTZ
                NOT NULL
                DEFAULT NOW()
        );
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        idx_sessions_token_hash
        ON sessions(token_hash);
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        idx_sessions_user_id
        ON sessions(user_id);
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS streamers (
            id SERIAL PRIMARY KEY,

            user_id INTEGER
                REFERENCES users(id)
                ON DELETE SET NULL,

            username VARCHAR(255)
                NOT NULL
                UNIQUE,

            display_name VARCHAR(255)
                NOT NULL,

            source VARCHAR(50)
                NOT NULL
                DEFAULT 'twitch_username',

            connected BOOLEAN
                NOT NULL
                DEFAULT FALSE,

            created_at TIMESTAMPTZ
                NOT NULL
                DEFAULT NOW(),

            updated_at TIMESTAMPTZ
                NOT NULL
                DEFAULT NOW()
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS dares (
            id SERIAL PRIMARY KEY,

            streamer VARCHAR(255)
                NOT NULL,

            streamer_source VARCHAR(50)
                NOT NULL
                DEFAULT 'twitch_username',

            viewer VARCHAR(255)
                NOT NULL
                DEFAULT 'Anonymous',

            dare_text TEXT
                NOT NULL,

            duration INTEGER
                NOT NULL,

            reward NUMERIC(12,2)
                NOT NULL
                DEFAULT 0,

            status VARCHAR(30)
                NOT NULL
                DEFAULT 'pending',

            created_at TIMESTAMPTZ
                NOT NULL
                DEFAULT NOW(),

            accepted_at TIMESTAMPTZ,

            updated_at TIMESTAMPTZ
                NOT NULL
                DEFAULT NOW()
        );
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        idx_dares_streamer_status
        ON dares(streamer, status);
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        idx_dares_created_at
        ON dares(created_at);
    `);

    await pool.query(`
        INSERT INTO streamers (
            username,
            display_name,
            source,
            connected
        )
        VALUES (
            'IShowSloow_',
            'IShowSloow_',
            'twitch_username',
            TRUE
        )
        ON CONFLICT (username)
        DO NOTHING;
    `);

    console.log(
        "Database initialized."
    );
}

/* =========================================================
   AUTHENTICATION
========================================================= */

async function authenticate(req, res, next) {

    try {

        const cookies =
            parseCookies(req);

        let token =
            cookies.dare_session;

        /*
         * Temporary compatibility:
         * allow Authorization Bearer tokens.
         *
         * The frontend will eventually use
         * the HttpOnly cookie exclusively.
         */
        if (!token) {

            const header =
                req.headers.authorization;

            if (
                header &&
                header.startsWith("Bearer ")
            ) {
                token =
                    header.slice(7).trim();
            }

        }

        if (!token) {
            return sendError(
                res,
                401,
                "UNAUTHORIZED",
                "Authentication required."
            );
        }

        const tokenHash =
            hashSessionToken(token);

        const result =
            await pool.query(
                `
                SELECT
                    u.id,
                    u.username,
                    u.email,
                    u.role,
                    s.id AS session_id
                FROM sessions s
                JOIN users u
                    ON u.id = s.user_id
                WHERE s.token_hash = $1
                  AND s.expires_at > NOW()
                LIMIT 1
                `,
                [tokenHash]
            );

        if (!result.rows.length) {

            clearSessionCookie(res);

            return sendError(
                res,
                401,
                "INVALID_SESSION",
                "Your session is invalid or expired."
            );
        }

        req.user =
            result.rows[0];

        req.user.id =
            Number(req.user.id);

        req.user.sessionId =
            Number(req.user.session_id);

        next();

    } catch (error) {

        console.error(
            "Authentication error:",
            error
        );

        return sendError(
            res,
            500,
            "AUTH_ERROR",
            "Authentication service unavailable."
        );
    }
}

/* =========================================================
   ROLE MIDDLEWARE
========================================================= */

function requireRole(...roles) {

    return (req, res, next) => {

        if (!req.user) {
            return sendError(
                res,
                401,
                "UNAUTHORIZED",
                "Authentication required."
            );
        }

        if (
            !roles.includes(req.user.role)
        ) {
            return sendError(
                res,
                403,
                "FORBIDDEN",
                "You do not have permission to perform this action."
            );
        }

        next();
    };
}

/* =========================================================
   STREAMER AUTHORIZATION
========================================================= */

async function requireStreamerAccess(
    req,
    res,
    next
) {

    try {

        const streamer =
            String(
                req.params.streamer ||
                req.body.streamer ||
                ""
            )
                .trim();

        if (!streamer) {

            return sendError(
                res,
                400,
                "INVALID_STREAMER",
                "Streamer is required."
            );
        }

        /*
         * Admins can access all streamers.
         */
        if (
            req.user.role === "admin"
        ) {
            return next();
        }

        const result =
            await pool.query(
                `
                SELECT id
                FROM streamers
                WHERE LOWER(TRIM(username))
                    = LOWER(TRIM($1::VARCHAR))
                  AND user_id = $2
                LIMIT 1
                `,
                [
                    streamer,
                    req.user.id
                ]
            );

        if (!result.rows.length) {

            return sendError(
                res,
                403,
                "STREAMER_ACCESS_DENIED",
                "You do not control this streamer."
            );
        }

        next();

    } catch (error) {

        console.error(
            "Streamer authorization error:",
            error
        );

        return sendError(
            res,
            500,
            "AUTHORIZATION_ERROR",
            "Unable to verify streamer access."
        );
    }
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/", async (req, res) => {

    let database =
        "unknown";

    try {

        await pool.query(
            "SELECT 1"
        );

        database =
            "connected";

    } catch (_) {

        database =
            "error";
    }

    res.json({
        success: true,
        status: "online",
        service: "dare-backend",
        version: "2.0.0",
        database,
        websocket: "/ws",
        time: new Date().toISOString()
    });

});

/* =========================================================
   AUTH REGISTER
========================================================= */

app.post(
    "/api/auth/register",
    rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 10
    }),
    async (req, res) => {

        const username =
            String(
                req.body.username || ""
            ).trim();

        const email =
            String(
                req.body.email || ""
            ).trim()
            .toLowerCase();

        const password =
            String(
                req.body.password || ""
            );

        if (
            !/^[A-Za-z0-9_]{3,50}$/.test(
                username
            )
        ) {
            return sendError(
                res,
                400,
                "INVALID_USERNAME",
                "Username must be 3-50 characters and contain only letters, numbers, and underscores."
            );
        }

        if (
            email.length < 5 ||
            email.length > 320 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
                email
            )
        ) {
            return sendError(
                res,
                400,
                "INVALID_EMAIL",
                "Enter a valid email address."
            );
        }

        if (
            password.length < 8 ||
            password.length > 128
        ) {
            return sendError(
                res,
                400,
                "INVALID_PASSWORD",
                "Password must be between 8 and 128 characters."
            );
        }

        try {

            const existing =
                await pool.query(
                    `
                    SELECT id
                    FROM users
                    WHERE LOWER(username)
                        = LOWER($1)
                       OR LOWER(email)
                        = LOWER($2)
                    LIMIT 1
                    `,
                    [
                        username,
                        email
                    ]
                );

            if (existing.rows.length) {

                return sendError(
                    res,
                    409,
                    "ACCOUNT_EXISTS",
                    "That username or email is already registered."
                );
            }

            const passwordHash =
                await bcrypt.hash(
                    password,
                    12
                );

            const result =
                await pool.query(
                    `
                    INSERT INTO users (
                        username,
                        email,
                        password_hash
                    )
                    VALUES ($1, $2, $3)
                    RETURNING
                        id,
                        username,
                        email,
                        role,
                        created_at
                    `,
                    [
                        username,
                        email,
                        passwordHash
                    ]
                );

            const user =
                result.rows[0];

            return sendSuccess(
                res,
                {
                    user
                },
                201
            );

        } catch (error) {

            console.error(
                "Registration error:",
                error
            );

            return sendError(
                res,
                500,
                "REGISTER_FAILED",
                "Unable to create your account."
            );
        }
    }
);

/* =========================================================
   AUTH LOGIN
========================================================= */

app.post(
    "/api/auth/login",
    rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 10
    }),
    async (req, res) => {

        const email =
            String(
                req.body.email || ""
            )
                .trim()
                .toLowerCase();

        const password =
            String(
                req.body.password || ""
            );

        if (!email || !password) {

            return sendError(
                res,
                400,
                "MISSING_CREDENTIALS",
                "Email and password are required."
            );
        }

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        username,
                        email,
                        password_hash,
                        role
                    FROM users
                    WHERE LOWER(email) = LOWER($1)
                    LIMIT 1
                    `,
                    [email]
                );

            if (!result.rows.length) {

                return sendError(
                    res,
                    401,
                    "INVALID_CREDENTIALS",
                    "Invalid email or password."
                );
            }

            const user =
                result.rows[0];

            const valid =
                await bcrypt.compare(
                    password,
                    user.password_hash
                );

            if (!valid) {

                return sendError(
                    res,
                    401,
                    "INVALID_CREDENTIALS",
                    "Invalid email or password."
                );
            }

            const token =
                createSessionToken();

            const tokenHash =
                hashSessionToken(token);

            const expiresAt =
                new Date(
                    Date.now() +
                    SESSION_DAYS *
                    24 *
                    60 *
                    60 *
                    1000
                );

            await pool.query(
                `
                INSERT INTO sessions (
                    user_id,
                    token_hash,
                    expires_at
                )
                VALUES ($1, $2, $3)
                `,
                [
                    user.id,
                    tokenHash,
                    expiresAt
                ]
            );

            setSessionCookie(
                res,
                token
            );

            delete user.password_hash;

            return sendSuccess(
                res,
                {
                    user
                }
            );

        } catch (error) {

            console.error(
                "Login error:",
                error
            );

            return sendError(
                res,
                500,
                "LOGIN_FAILED",
                "Unable to log in."
            );
        }
    }
);

/* =========================================================
   AUTH ME
========================================================= */

app.get(
    "/api/auth/me",
    authenticate,
    async (req, res) => {

        return sendSuccess(
            res,
            {
                user: {
                    id: req.user.id,
                    username: req.user.username,
                    email: req.user.email,
                    role: req.user.role
                }
            }
        );
    }
);

/* =========================================================
   AUTH LOGOUT
========================================================= */

app.post(
    "/api/auth/logout",
    authenticate,
    async (req, res) => {

        try {

            await pool.query(
                `
                DELETE FROM sessions
                WHERE id = $1
                `,
                [req.user.sessionId]
            );

            clearSessionCookie(res);

            return sendSuccess(
                res,
                {
                    loggedOut: true
                }
            );

        } catch (error) {

            console.error(
                "Logout error:",
                error
            );

            return sendError(
                res,
                500,
                "LOGOUT_FAILED",
                "Unable to log out."
            );
        }
    }
);

/* =========================================================
   CLEAN EXPIRED SESSIONS
========================================================= */

setInterval(async () => {

    try {

        await pool.query(
            `
            DELETE FROM sessions
            WHERE expires_at <= NOW()
            `
        );

    } catch (error) {

        console.error(
            "Session cleanup error:",
            error
        );
    }

}, 60 * 60 * 1000).unref();

/* =========================================================
   STREAMERS
========================================================= */

app.get(
    "/api/streamers",
    rateLimit({
        max: 120
    }),
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        username,
                        display_name AS "displayName",
                        source,
                        connected
                    FROM streamers
                    WHERE connected = TRUE
                    ORDER BY display_name ASC
                    `
                );

            return res.json(
                result.rows
            );

        } catch (error) {

            console.error(
                "Streamer lookup error:",
                error
            );

            return sendError(
                res,
                500,
                "STREAMER_LOOKUP_FAILED",
                "Failed to load streamers."
            );
        }
    }
);

/* =========================================================
   DARE HELPERS
========================================================= */

function formatDare(row) {

    if (!row) {
        return null;
    }

    return {
        id: Number(row.id),

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

async function getActiveDareForStreamer(
    streamer
) {

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

async function getStreamerQueue(
    streamer
) {

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
   WEBSOCKET
========================================================= */

const wss =
    new WebSocket.Server({
        server,
        path: "/ws"
    });

function broadcast(message) {

    const data =
        JSON.stringify(message);

    wss.clients.forEach(client => {

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

async function sendState(ws) {

    try {

        const active =
            await getActiveDaresFromDatabase();

        const queues =
            await getAllQueuesFromDatabase();

        if (
            ws.readyState ===
            WebSocket.OPEN
        ) {

            ws.send(
                JSON.stringify({
                    type: "STATE",
                    active,
                    queues
                })
            );
        }

    } catch (error) {

        console.error(
            "WebSocket state error:",
            error
        );
    }
}

/*
 * Pass 1 keeps the socket read-only.
 *
 * State is public.
 * Mutations MUST happen through
 * authenticated REST endpoints.
 */
wss.on(
    "connection",
    async ws => {

        console.log(
            "WebSocket client connected."
        );

        await sendState(ws);

        ws.on(
            "message",
            async rawMessage => {

                try {

                    const message =
                        JSON.parse(
                            rawMessage.toString()
                        );

                    if (
                        message.type ===
                        "GET_STATE"
                    ) {
                        await sendState(ws);
                    }

                } catch (error) {

                    console.error(
                        "WebSocket message error:",
                        error
                    );
                }
            }
        );

        ws.on(
            "close",
            () => {
                console.log(
                    "WebSocket client disconnected."
                );
            }
        );

        ws.on(
            "error",
            error => {
                console.error(
                    "WebSocket client error:",
                    error
                );
            }
        );
    }
);

/* =========================================================
   CREATE DARE
========================================================= */

app.post(
    "/api/dare",
    rateLimit({
        windowMs: 60 * 1000,
        max: 20
    }),
    async (req, res) => {

        const streamer =
            String(
                req.body.streamer || ""
            ).trim();

        const streamerSource =
            String(
                req.body.streamer_source ||
                "twitch_username"
            ).trim();

        const viewer =
            String(
                req.body.viewer ||
                "Anonymous"
            ).trim() ||
            "Anonymous";

        const dareText =
            String(
                req.body.dare_text || ""
            ).trim();

        const durationNumber =
            Number(
                req.body.duration
            );

        const rewardNumber =
            Number(
                req.body.reward || 0
            );

        if (
            !streamer ||
            streamer.length > 255
        ) {
            return sendError(
                res,
                400,
                "INVALID_STREAMER",
                "A valid streamer is required."
            );
        }

        if (
            viewer.length > 255
        ) {
            return sendError(
                res,
                400,
                "INVALID_VIEWER",
                "Viewer name is too long."
            );
        }

        if (
            !dareText ||
            dareText.length > 1000
        ) {
            return sendError(
                res,
                400,
                "INVALID_DARE",
                "Dare text must be between 1 and 1000 characters."
            );
        }

        if (
            !Number.isInteger(
                durationNumber
            ) ||
            durationNumber < 5 ||
            durationNumber > 300
        ) {
            return sendError(
                res,
                400,
                "INVALID_DURATION",
                "Duration must be between 5 and 300 seconds."
            );
        }

        if (
            !Number.isFinite(
                rewardNumber
            ) ||
            rewardNumber < 0 ||
            rewardNumber > 1000000
        ) {
            return sendError(
                res,
                400,
                "INVALID_REWARD",
                "Reward is invalid."
            );
        }

        const client =
            await pool.connect();

        try {

            await client.query(
                "BEGIN"
            );

            await client.query(
                `
                SELECT
                    pg_advisory_xact_lock(
                        hashtext(
                            LOWER(TRIM($1::VARCHAR))
                        )
                    )
                `,
                [streamer]
            );

            const activeResult =
                await client.query(
                    `
                    SELECT id
                    FROM dares
                    WHERE LOWER(TRIM(streamer))
                        = LOWER(TRIM($1::VARCHAR))
                      AND status = 'accepted'
                    LIMIT 1
                    `,
                    [streamer]
                );

            const hasActive =
                activeResult.rows.length > 0;

            const newStatus =
                hasActive
                    ? "pending"
                    : "accepted";

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
                        streamer,
                        streamerSource,
                        viewer,
                        dareText,
                        durationNumber,
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

            if (
                newStatus === "accepted"
            ) {

                broadcast({
                    type: "ACTIVE_DARE",
                    dare
                });

                return sendSuccess(
                    res,
                    {
                        message:
                            "Dare is now LIVE.",
                        dare
                    },
                    201
                );
            }

            const queue =
                await getStreamerQueue(
                    streamer
                );

            broadcast({
                type: "QUEUE_UPDATED",
                streamer,
                queue
            });

            return sendSuccess(
                res,
                {
                    message:
                        "Dare added to pending queue.",
                    dare
                },
                201
            );

        } catch (error) {

            try {
                await client.query(
                    "ROLLBACK"
                );
            } catch (_) {}

            console.error(
                "CREATE DARE ERROR:",
                error
            );

            return sendError(
                res,
                500,
                "DARE_CREATE_FAILED",
                "Failed to create dare."
            );

        } finally {

            client.release();
        }
    }
);

/* =========================================================
   PUBLIC STATE
========================================================= */

app.get(
    "/api/dare",
    rateLimit({
        max: 120
    }),
    async (req, res) => {

        try {

            const active =
                await getActiveDaresFromDatabase();

            const queues =
                await getAllQueuesFromDatabase();

            return res.json({
                success: true,
                active,
                queues
            });

        } catch (error) {

            console.error(
                "State error:",
                error
            );

            return sendError(
                res,
                500,
                "STATE_FAILED",
                "Failed to get dare state."
            );
        }
    }
);

/* =========================================================
   PUBLIC QUEUE
========================================================= */

app.get(
    "/api/dare/queue/:streamer",
    rateLimit({
        max: 120
    }),
    async (req, res) => {

        try {

            const queue =
                await getStreamerQueue(
                    req.params.streamer
                );

            return res.json(
                queue
            );

        } catch (error) {

            console.error(
                "Queue error:",
                error
            );

            return sendError(
                res,
                500,
                "QUEUE_FAILED",
                "Failed to get queue."
            );
        }
    }
);

/* =========================================================
   PUBLIC ACTIVE DARE
========================================================= */

app.get(
    "/api/dare/active/:streamer",
    rateLimit({
        max: 120
    }),
    async (req, res) => {

        try {

            const dare =
                await getActiveDareForStreamer(
                    req.params.streamer
                );

            return res.json(
                dare
            );

        } catch (error) {

            console.error(
                "Active dare error:",
                error
            );

            return sendError(
                res,
                500,
                "ACTIVE_DARE_FAILED",
                "Failed to get active dare."
            );
        }
    }
);

/* =========================================================
   GET SINGLE DARE
========================================================= */

app.get(
    "/api/dare/:id",
    rateLimit({
        max: 120
    }),
    async (req, res) => {

        const id =
            Number(req.params.id);

        if (
            !Number.isInteger(id) ||
            id <= 0
        ) {
            return sendError(
                res,
                400,
                "INVALID_ID",
                "Invalid dare ID."
            );
        }

        try {

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM dares
                    WHERE id = $1::INTEGER
                    LIMIT 1
                    `,
                    [id]
                );

            if (!result.rows.length) {

                return sendError(
                    res,
                    404,
                    "NOT_FOUND",
                    "Dare not found."
                );
            }

            return sendSuccess(
                res,
                {
                    dare:
                        formatDare(
                            result.rows[0]
                        )
                }
            );

        } catch (error) {

            console.error(
                "Single dare error:",
                error
            );

            return sendError(
                res,
                500,
                "DARE_LOOKUP_FAILED",
                "Failed to get dare."
            );
        }
    }
);

/* =========================================================
   DARE STATUS UPDATE
========================================================= */

app.post(
    "/api/dare/:id/status",
    authenticate,
    requireRole(
        "streamer",
        "admin"
    ),
    rateLimit({
        windowMs: 60 * 1000,
        max: 60
    }),
    async (req, res) => {

        const id =
            Number(req.params.id);

        const status =
            String(
                req.body.status || ""
            )
                .trim()
                .toLowerCase();

        const allowedStatuses = [
            "accepted",
            "rejected",
            "completed",
            "failed"
        ];

        if (
            !Number.isInteger(id) ||
            id <= 0
        ) {
            return sendError(
                res,
                400,
                "INVALID_ID",
                "Invalid dare ID."
            );
        }

        if (
            !allowedStatuses.includes(
                status
            )
        ) {
            return sendError(
                res,
                400,
                "INVALID_STATUS",
                "Invalid status."
            );
        }

        const client =
            await pool.connect();

        try {

            await client.query(
                "BEGIN"
            );

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

                return sendError(
                    res,
                    404,
                    "NOT_FOUND",
                    "Dare not found."
                );
            }

            const existing =
                dareResult.rows[0];

            const streamer =
                existing.streamer;

            /*
             * IMPORTANT:
             * Authorization is performed while the
             * dare is locked, but using the same
             * database transaction.
             */

            if (
                req.user.role !== "admin"
            ) {

                const ownership =
                    await client.query(
                        `
                        SELECT id
                        FROM streamers
                        WHERE LOWER(TRIM(username))
                            = LOWER(TRIM($1::VARCHAR))
                          AND user_id = $2
                        LIMIT 1
                        `,
                        [
                            streamer,
                            req.user.id
                        ]
                    );

                if (
                    !ownership.rows.length
                ) {

                    await client.query(
                        "ROLLBACK"
                    );

                    return sendError(
                        res,
                        403,
                        "STREAMER_ACCESS_DENIED",
                        "You do not control this streamer."
                    );
                }
            }

            if (
                status === "accepted"
            ) {

                if (
                    existing.status !==
                    "pending"
                ) {

                    await client.query(
                        "ROLLBACK"
                    );

                    return sendError(
                        res,
                        409,
                        "INVALID_TRANSITION",
                        "Only a pending dare can be accepted."
                    );
                }

                const activeResult =
                    await client.query(
                        `
                        SELECT id
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

                if (
                    activeResult.rows.length
                ) {

                    await client.query(
                        "ROLLBACK"
                    );

                    return sendError(
                        res,
                        409,
                        "ACTIVE_DARE_EXISTS",
                        "Another dare is already active for this streamer."
                    );
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
                            updated_at = NOW()
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
                    type: "ACTIVE_DARE",
                    dare
                });

                return sendSuccess(
                    res,
                    {
                        dare
                    }
                );
            }

            if (
                status === "rejected"
            ) {

                if (
                    existing.status !==
                    "pending"
                ) {

                    await client.query(
                        "ROLLBACK"
                    );

                    return sendError(
                        res,
                        409,
                        "INVALID_TRANSITION",
                        "Only a pending dare can be rejected."
                    );
                }

                const result =
                    await client.query(
                        `
                        UPDATE dares
                        SET
                            status = 'rejected',
                            updated_at = NOW()
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
                    type: "DARE_REJECTED",
                    dare
                });

                broadcast({
                    type: "QUEUE_UPDATED",
                    streamer,
                    queue
                });

                return sendSuccess(
                    res,
                    {
                        dare
                    }
                );
            }

            if (
                status === "completed" ||
                status === "failed"
            ) {

                if (
                    existing.status !==
                    "accepted"
                ) {

                    await client.query(
                        "ROLLBACK"
                    );

                    return sendError(
                        res,
                        409,
                        "INVALID_TRANSITION",
                        "Only an active dare can be completed or failed."
                    );
                }

                const result =
                    await client.query(
                        `
                        UPDATE dares
                        SET
                            status = $1::VARCHAR,
                            updated_at = NOW()
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

                if (
                    status === "completed"
                ) {

                    broadcast({
                        type:
                            "DARE_COMPLETED",
                        dare
                    });

                } else {

                    broadcast({
                        type:
                            "DARE_FAILED",
                        dare
                    });
                }

                broadcast({
                    type:
                        "ACTIVE_DARE_CLEARED",
                    streamer
                });

                const queue =
                    await getStreamerQueue(
                        streamer
                    );

                broadcast({
                    type:
                        "QUEUE_UPDATED",
                    streamer,
                    queue
                });

                return sendSuccess(
                    res,
                    {
                        dare,
                        queue
                    }
                );
            }

        } catch (error) {

            try {
                await client.query(
                    "ROLLBACK"
                );
            } catch (_) {}

            console.error(
                "STATUS UPDATE ERROR:",
                error
            );

            return sendError(
                res,
                500,
                "STATUS_UPDATE_FAILED",
                "Failed to update dare status."
            );

        } finally {

            client.release();
        }
    }
);

/* =========================================================
   STREAMER HISTORY
========================================================= */

app.get(
    "/api/dare/history",
    authenticate,
    requireRole(
        "streamer",
        "admin"
    ),
    rateLimit({
        max: 60
    }),
    async (req, res) => {

        const streamer =
            String(
                req.query.streamer || ""
            ).trim();

        if (!streamer) {

            return sendError(
                res,
                400,
                "STREAMER_REQUIRED",
                "Streamer is required."
            );
        }

        try {

            if (
                req.user.role !== "admin"
            ) {

                const ownership =
                    await pool.query(
                        `
                        SELECT id
                        FROM streamers
                        WHERE LOWER(TRIM(username))
                            = LOWER(TRIM($1::VARCHAR))
                          AND user_id = $2
                        LIMIT 1
                        `,
                        [
                            streamer,
                            req.user.id
                        ]
                    );

                if (
                    !ownership.rows.length
                ) {

                    return sendError(
                        res,
                        403,
                        "STREAMER_ACCESS_DENIED",
                        "You do not control this streamer."
                    );
                }
            }

            let limit =
                Number(
                    req.query.limit || 100
                );

            if (
                !Number.isInteger(limit)
            ) {
                limit = 100;
            }

            limit =
                Math.max(
                    1,
                    Math.min(
                        limit,
                        500
                    )
                );

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM dares
                    WHERE LOWER(TRIM(streamer))
                        = LOWER(TRIM($1::VARCHAR))
                    ORDER BY created_at DESC
                    LIMIT $2::INTEGER
                    `,
                    [
                        streamer,
                        limit
                    ]
                );

            return res.json(
                result.rows.map(
                    formatDare
                )
            );

        } catch (error) {

            console.error(
                "History error:",
                error
            );

            return sendError(
                res,
                500,
                "HISTORY_FAILED",
                "Failed to get history."
            );
        }
    }
);

/* =========================================================
   CLEAR ALL DARES
   ADMIN ONLY
========================================================= */

app.post(
    "/api/dare/clear",
    authenticate,
    requireRole("admin"),
    rateLimit({
        windowMs: 60 * 1000,
        max: 5
    }),
    async (req, res) => {

        try {

            await pool.query(
                "DELETE FROM dares"
            );

            broadcast({
                type: "RESET"
            });

            return sendSuccess(
                res,
                {
                    message:
                        "All dares cleared."
                }
            );

        } catch (error) {

            console.error(
                "Clear error:",
                error
            );

            return sendError(
                res,
                500,
                "CLEAR_FAILED",
                "Failed to clear dares."
            );
        }
    }
);

/* =========================================================
   404
========================================================= */

app.use(
    (req, res) => {

        return sendError(
            res,
            404,
            "NOT_FOUND",
            "Endpoint not found."
        );
    }
);

/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use(
    (error, req, res, next) => {

        console.error(
            "Unhandled server error:",
            error
        );

        if (
            res.headersSent
        ) {
            return next(error);
        }

        return sendError(
            res,
            500,
            "INTERNAL_ERROR",
            "An unexpected server error occurred."
        );
    }
);

/* =========================================================
   SHUTDOWN
========================================================= */

async function shutdown(
    signal
) {

    console.log(
        `${signal} received. Shutting down...`
    );

    wss.clients.forEach(
        client => {
            try {
                client.close();
            } catch (_) {}
        }
    );

    server.close(
        async () => {

            try {

                await pool.end();

                console.log(
                    "Server shut down cleanly."
                );

                process.exit(0);

            } catch (error) {

                console.error(
                    "Shutdown error:",
                    error
                );

                process.exit(1);
            }
        }
    );
}

process.on(
    "SIGTERM",
    () => shutdown("SIGTERM")
);

process.on(
    "SIGINT",
    () => shutdown("SIGINT")
);

/* =========================================================
   START
========================================================= */

async function startServer() {

    try {

        await initializeDatabase();

        server.listen(
            PORT,
            () => {

                console.log(
                    "================================"
                );

                console.log(
                    "DARE BACKEND ONLINE"
                );

                console.log(
                    `HTTP: http://localhost:${PORT}`
                );

                console.log(
                    `WebSocket: ws://localhost:${PORT}/ws`
                );

                console.log(
                    `CORS: ${FRONTEND_ORIGIN}`
                );

                console.log(
                    "================================"
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
