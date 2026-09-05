```js
"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({
    server,
    path: "/ws"
});

const PORT = process.env.PORT || 10000;

const FRONTEND_ORIGIN =
    process.env.FRONTEND_ORIGIN ||
    "https://jcmr22922922-crypto.github.io";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is not configured.");
    process.exit(1);
}

/* =========================================================
   DATABASE
========================================================= */

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

/* =========================================================
   CONFIG
========================================================= */

const SESSION_DURATION_MS =
    1000 * 60 * 60 * 24 * 30; // 30 days

const PASSWORD_MIN_LENGTH = 8;

const MAX_DARE_TEXT_LENGTH = 1000;

const MAX_DURATION = 3600;

const MAX_REWARD = 100000;

const VALID_DARE_STATUSES = new Set([
    "pending",
    "accepted",
    "rejected",
    "completed",
    "failed"
]);

/* =========================================================
   EXPRESS MIDDLEWARE
========================================================= */

app.use(
    cors({
        origin: FRONTEND_ORIGIN,
        credentials: true,
        methods: [
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "OPTIONS"
        ],
        allowedHeaders: [
            "Content-Type",
            "Authorization"
        ]
    })
);

app.use(
    express.json({
        limit: "50kb"
    })
);

app.disable("x-powered-by");

/* =========================================================
   HELPERS
========================================================= */

function sendSuccess(res, data = {}) {
    return res.json({
        success: true,
        data
    });
}

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

function normalizeUsername(value) {
    return String(value || "")
        .trim()
        .replace(/^@/, "")
        .toLowerCase();
}

function normalizeEmail(value) {
    return String(value || "")
        .trim()
        .toLowerCase();
}

function cleanDisplayName(value) {
    return String(value || "")
        .trim()
        .slice(0, 255);
}

function cleanDareText(value) {
    return String(value || "")
        .trim()
        .slice(0, MAX_DARE_TEXT_LENGTH);
}

function parsePositiveInteger(value) {
    const number = Number(value);

    if (!Number.isInteger(number) || number <= 0) {
        return null;
    }

    return number;
}

function parseReward(value) {
    const number = Number(value);

    if (!Number.isFinite(number) || number < 0) {
        return null;
    }

    if (number > MAX_REWARD) {
        return null;
    }

    return Math.round(number * 100) / 100;
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidUsername(username) {
    return /^[a-zA-Z0-9_]{3,30}$/.test(username);
}

/* =========================================================
   PASSWORD HASHING
========================================================= */

function hashPassword(password) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16).toString("hex");

        crypto.scrypt(
            password,
            salt,
            64,
            {
                N: 16384,
                r: 8,
                p: 1
            },
            (error, derivedKey) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve(
                    `${salt}:${derivedKey.toString("hex")}`
                );
            }
        );
    });
}

function verifyPassword(password, storedHash) {
    return new Promise((resolve, reject) => {
        try {
            const [salt, key] = String(storedHash).split(":");

            if (!salt || !key) {
                resolve(false);
                return;
            }

            crypto.scrypt(
                password,
                salt,
                64,
                {
                    N: 16384,
                    r: 8,
                    p: 1
                },
                (error, derivedKey) => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    const storedBuffer =
                        Buffer.from(key, "hex");

                    if (
                        storedBuffer.length !==
                        derivedKey.length
                    ) {
                        resolve(false);
                        return;
                    }

                    resolve(
                        crypto.timingSafeEqual(
                            storedBuffer,
                            derivedKey
                        )
                    );
                }
            );
        } catch (error) {
            reject(error);
        }
    });
}

/* =========================================================
   SESSION HELPERS
========================================================= */

function createSessionToken() {
    return crypto.randomBytes(32).toString("hex");
}

function hashSessionToken(token) {
    return crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");
}

function getSessionToken(req) {
    const cookieHeader =
        req.headers.cookie || "";

    const cookies = {};

    cookieHeader
        .split(";")
        .forEach((part) => {
            const index = part.indexOf("=");

            if (index === -1) {
                return;
            }

            const key =
                part.slice(0, index).trim();

            const value =
                part.slice(index + 1).trim();

            cookies[key] = decodeURIComponent(value);
        });

    if (cookies.dare_session) {
        return cookies.dare_session;
    }

    const authorization =
        req.headers.authorization || "";

    if (
        authorization
            .toLowerCase()
            .startsWith("bearer ")
    ) {
        return authorization.slice(7).trim();
    }

    return null;
}

function setSessionCookie(res, token) {
    const maxAge =
        Math.floor(
            SESSION_DURATION_MS / 1000
        );

    /*
      GitHub Pages and Render are different sites.

      SameSite=None + Secure is required so the
      browser can send the session cookie.
    */

    res.setHeader(
        "Set-Cookie",
        [
            `dare_session=${encodeURIComponent(token)}`,
            "Path=/",
            `Max-Age=${maxAge}`,
            "HttpOnly",
            "Secure",
            "SameSite=None"
        ].join("; ")
    );
}

function clearSessionCookie(res) {
    res.setHeader(
        "Set-Cookie",
        [
            "dare_session=",
            "Path=/",
            "Max-Age=0",
            "HttpOnly",
            "Secure",
            "SameSite=None"
        ].join("; ")
    );
}

/* =========================================================
   AUTHENTICATION
========================================================= */

async function authenticateRequest(
    req,
    res,
    next
) {
    try {
        const token =
            getSessionToken(req);

        if (!token) {
            req.user = null;
            next();
            return;
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
                    u.created_at,
                    u.updated_at
                FROM sessions s
                JOIN users u
                    ON u.id = s.user_id
                WHERE s.token_hash = $1
                  AND s.expires_at > NOW()
                LIMIT 1
                `,
                [tokenHash]
            );

        if (result.rows.length === 0) {
            req.user = null;
            next();
            return;
        }

        req.user = result.rows[0];

        await pool.query(
            `
            UPDATE sessions
            SET last_seen_at = NOW()
            WHERE token_hash = $1
            `,
            [tokenHash]
        );

        next();
    } catch (error) {
        console.error(
            "Authentication error:",
            error
        );

        req.user = null;
        next();
    }
}

function requireAuth(req, res, next) {
    if (!req.user) {
        return sendError(
            res,
            401,
            "AUTH_REQUIRED",
            "You must be logged in."
        );
    }

    next();
}

function requireAdmin(req, res, next) {
    if (!req.user) {
        return sendError(
            res,
            401,
            "AUTH_REQUIRED",
            "You must be logged in."
        );
    }

    if (req.user.role !== "admin") {
        return sendError(
            res,
            403,
            "ADMIN_REQUIRED",
            "Administrator access required."
        );
    }

    next();
}

app.use(authenticateRequest);

/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

async function initializeDatabase() {
    const client =
        await pool.connect();

    try {
        await client.query("BEGIN");

        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id BIGSERIAL PRIMARY KEY,
                username VARCHAR(30) NOT NULL,
                email VARCHAR(255) NOT NULL,
                password_hash TEXT NOT NULL,
                role VARCHAR(30) NOT NULL DEFAULT 'streamer',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS
            users_username_lower_unique
            ON users (LOWER(username))
        `);

        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS
            users_email_lower_unique
            ON users (LOWER(email))
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL
                    REFERENCES users(id)
                    ON DELETE CASCADE,
                token_hash CHAR(64) NOT NULL UNIQUE,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS
            sessions_user_id_idx
            ON sessions(user_id)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS
            sessions_expires_at_idx
            ON sessions(expires_at)
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS streamers (
                id BIGSERIAL PRIMARY KEY,
                owner_user_id BIGINT
                    REFERENCES users(id)
                    ON DELETE SET NULL,
                username VARCHAR(255) NOT NULL,
                display_name VARCHAR(255) NOT NULL,
                source VARCHAR(50) NOT NULL
                    DEFAULT 'twitch_username',
                connected BOOLEAN NOT NULL
                    DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS
            streamers_username_lower_unique
            ON streamers (LOWER(username))
        `);

        /*
          Existing DARE table is preserved.
        */

        await client.query(`
            CREATE TABLE IF NOT EXISTS dares (
                id SERIAL PRIMARY KEY,
                streamer VARCHAR(255) NOT NULL,
                streamer_source VARCHAR(50) NOT NULL
                    DEFAULT 'twitch_username',
                viewer VARCHAR(255) NOT NULL
                    DEFAULT 'Anonymous',
                dare_text TEXT NOT NULL,
                duration INTEGER NOT NULL,
                reward NUMERIC(12,2) NOT NULL
                    DEFAULT 0,
                status VARCHAR(30) NOT NULL
                    DEFAULT 'pending',
                created_at TIMESTAMPTZ NOT NULL
                    DEFAULT NOW(),
                accepted_at TIMESTAMPTZ,
                updated_at TIMESTAMPTZ
            )
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS
            dares_streamer_status_idx
            ON dares (LOWER(streamer), status)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS
            dares_created_at_idx
            ON dares(created_at)
        `);

        /*
          Seed the existing default streamer if it doesn't exist.
        */

        await client.query(
            `
            INSERT INTO streamers
                (
                    username,
                    display_name,
                    source,
                    connected
                )
            VALUES
                ($1, $1, 'twitch_username', TRUE)
            ON CONFLICT (LOWER(username))
            DO UPDATE SET
                connected = TRUE,
                updated_at = NOW()
            `,
            ["IShowSloow_"]
        );

        await client.query("COMMIT");

        console.log(
            "Database initialized successfully."
        );
    } catch (error) {
        await client.query("ROLLBACK");

        console.error(
            "Database initialization failed:",
            error
        );

        throw error;
    } finally {
        client.release();
    }
}

/* =========================================================
   AUTH ROUTES
========================================================= */

/*
  REGISTER
*/

app.post(
    "/api/auth/register",
    async (req, res) => {
        try {
            const username =
                normalizeUsername(
                    req.body.username
                );

            const email =
                normalizeEmail(
                    req.body.email
                );

            const password =
                String(
                    req.body.password || ""
                );

            if (
                !isValidUsername(username)
            ) {
                return sendError(
                    res,
                    400,
                    "INVALID_USERNAME",
                    "Username must be 3-30 characters and contain only letters, numbers, and underscores."
                );
            }

            if (!isValidEmail(email)) {
                return sendError(
                    res,
                    400,
                    "INVALID_EMAIL",
                    "Please enter a valid email address."
                );
            }

            if (
                password.length <
                PASSWORD_MIN_LENGTH
            ) {
                return sendError(
                    res,
                    400,
                    "WEAK_PASSWORD",
                    `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`
                );
            }

            const existing =
                await pool.query(
                    `
                    SELECT id
                    FROM users
                    WHERE LOWER(username) = LOWER($1)
                       OR LOWER(email) = LOWER($2)
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
                    "An account with that username or email already exists."
                );
            }

            const passwordHash =
                await hashPassword(
                    password
                );

            const client =
                await pool.connect();

            try {
                await client.query(
                    "BEGIN"
                );

                const userResult =
                    await client.query(
                        `
                        INSERT INTO users
                            (
                                username,
                                email,
                                password_hash,
                                role
                            )
                        VALUES
                            ($1, $2, $3, 'streamer')
                        RETURNING
                            id,
                            username,
                            email,
                            role,
                            created_at,
                            updated_at
                        `,
                        [
                            username,
                            email,
                            passwordHash
                        ]
                    );

                const user =
                    userResult.rows[0];

                /*
                  Automatically claim the old default
                  streamer if it is still unowned.
                */

                await client.query(
                    `
                    UPDATE streamers
                    SET
                        owner_user_id = $1,
                        updated_at = NOW()
                    WHERE LOWER(username) =
                          LOWER('IShowSloow_')
                      AND owner_user_id IS NULL
                    `,
                    [user.id]
                );

                const token =
                    createSessionToken();

                const tokenHash =
                    hashSessionToken(token);

                await client.query(
                    `
                    INSERT INTO sessions
                        (
                            user_id,
                            token_hash,
                            expires_at
                        )
                    VALUES
                        (
                            $1,
                            $2,
                            NOW() + INTERVAL '30 days'
                        )
                    `,
                    [
                        user.id,
                        tokenHash
                    ]
                );

                await client.query(
                    "COMMIT"
                );

                setSessionCookie(
                    res,
                    token
                );

                return sendSuccess(
                    res,
                    { user }
                );
            } catch (error) {
                await client.query(
                    "ROLLBACK"
                );
                throw error;
            } finally {
                client.release();
            }
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

/*
  LOGIN
*/

app.post(
    "/api/auth/login",
    async (req, res) => {
        try {
            const email =
                normalizeEmail(
                    req.body.email
                );

            const password =
                String(
                    req.body.password || ""
                );

            if (!email || !password) {
                return sendError(
                    res,
                    400,
                    "MISSING_LOGIN",
                    "Email and password are required."
                );
            }

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        username,
                        email,
                        password_hash,
                        role,
                        created_at,
                        updated_at
                    FROM users
                    WHERE LOWER(email) = LOWER($1)
                    LIMIT 1
                    `,
                    [email]
                );

            if (result.rows.length === 0) {
                return sendError(
                    res,
                    401,
                    "INVALID_CREDENTIALS",
                    "Invalid email or password."
                );
            }

            const userRecord =
                result.rows[0];

            const valid =
                await verifyPassword(
                    password,
                    userRecord.password_hash
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

            await pool.query(
                `
                INSERT INTO sessions
                    (
                        user_id,
                        token_hash,
                        expires_at
                    )
                VALUES
                    (
                        $1,
                        $2,
                        NOW() + INTERVAL '30 days'
                    )
                `,
                [
                    userRecord.id,
                    tokenHash
                ]
            );

            const user = {
                id: userRecord.id,
                username: userRecord.username,
                email: userRecord.email,
                role: userRecord.role,
                created_at:
                    userRecord.created_at,
                updated_at:
                    userRecord.updated_at
            };

            setSessionCookie(
                res,
                token
            );

            return sendSuccess(
                res,
                { user }
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

/*
  CURRENT USER
*/

app.get(
    "/api/auth/me",
    requireAuth,
    async (req, res) => {
        return sendSuccess(
            res,
            {
                user: req.user
            }
        );
    }
);

/*
  LOGOUT
*/

app.post(
    "/api/auth/logout",
    async (req, res) => {
        try {
            const token =
                getSessionToken(req);

            if (token) {
                await pool.query(
                    `
                    DELETE FROM sessions
                    WHERE token_hash = $1
                    `,
                    [
                        hashSessionToken(
                            token
                        )
                    ]
                );
            }

            clearSessionCookie(res);

            return sendSuccess(res);
        } catch (error) {
            console.error(
                "Logout error:",
                error
            );

            clearSessionCookie(res);

            return sendSuccess(res);
        }
    }
);

/*
  LOGOUT ALL DEVICES
*/

app.post(
    "/api/auth/logout-all",
    requireAuth,
    async (req, res) => {
        try {
            await pool.query(
                `
                DELETE FROM sessions
                WHERE user_id = $1
                `,
                [req.user.id]
            );

            clearSessionCookie(res);

            return sendSuccess(res);
        } catch (error) {
            console.error(
                "Logout-all error:",
                error
            );

            return sendError(
                res,
                500,
                "LOGOUT_FAILED",
                "Unable to log out all sessions."
            );
        }
    }
);

/* =========================================================
   STREAMER ROUTES
========================================================= */

/*
  PUBLIC STREAMER LIST
*/

app.get(
    "/api/streamers",
    async (req, res) => {
        try {
            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        username,
                        display_name,
                        source,
                        connected
                    FROM streamers
                    ORDER BY
                        LOWER(display_name)
                    `
                );

            return sendSuccess(
                res,
                {
                    streamers:
                        result.rows
                }
            );
        } catch (error) {
            console.error(
                "Streamer list error:",
                error
            );

            return sendError(
                res,
                500,
                "STREAMERS_FAILED",
                "Unable to load streamers."
            );
        }
    }
);

/*
  STREAMERS OWNED BY CURRENT USER
*/

app.get(
    "/api/my-streamers",
    requireAuth,
    async (req, res) => {
        try {
            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        username,
                        display_name,
                        source,
                        connected
                    FROM streamers
                    WHERE owner_user_id = $1
                    ORDER BY
                        LOWER(display_name)
                    `,
                    [req.user.id]
                );

            return sendSuccess(
                res,
                {
                    streamers:
                        result.rows
                }
            );
        } catch (error) {
            console.error(
                "My streamers error:",
                error
            );

            return sendError(
                res,
                500,
                "MY_STREAMERS_FAILED",
                "Unable to load your streamers."
            );
        }
    }
);

/*
  CLAIM DEFAULT STREAMER
*/

app.post(
    "/api/streamers/claim-default",
    requireAuth,
    async (req, res) => {
        try {
            const result =
                await pool.query(
                    `
                    UPDATE streamers
                    SET
                        owner_user_id = $1,
                        updated_at = NOW()
                    WHERE LOWER(username) =
                          LOWER('IShowSloow_')
                      AND owner_user_id IS NULL
                    RETURNING
                        id,
                        username,
                        display_name,
                        source,
                        connected
                    `,
                    [req.user.id]
                );

            if (result.rows.length === 0) {
                return sendError(
                    res,
                    409,
                    "DEFAULT_UNAVAILABLE",
                    "The default streamer is already claimed."
                );
            }

            return sendSuccess(
                res,
                {
                    streamer:
                        result.rows[0]
                }
            );
        } catch (error) {
            console.error(
                "Claim default error:",
                error
            );

            return sendError(
                res,
                500,
                "CLAIM_FAILED",
                "Unable to claim the streamer."
            );
        }
    }
);

/* =========================================================
   STREAMER OWNERSHIP
========================================================= */

async function userOwnsStreamer(
    user,
    streamerUsername
) {
    if (!user) {
        return false;
    }

    if (user.role === "admin") {
        return true;
    }

    const result =
        await pool.query(
            `
            SELECT id
            FROM streamers
            WHERE owner_user_id = $1
              AND LOWER(username) =
                  LOWER($2)
            LIMIT 1
            `,
            [
                user.id,
                streamerUsername
            ]
        );

    return result.rows.length > 0;
}

/* =========================================================
   DARE CREATION
========================================================= */

app.post(
    "/api/dare",
    async (req, res) => {
        try {
            const streamer =
                normalizeUsername(
                    req.body.streamer
                );

            const viewer =
                String(
                    req.body.viewer ||
                    "Anonymous"
                )
                    .trim()
                    .slice(0, 255);

            const dareText =
                cleanDareText(
                    req.body.dare_text ||
                    req.body.dareText
                );

            const duration =
                parsePositiveInteger(
                    req.body.duration
                );

            const reward =
                parseReward(
                    req.body.reward
                );

            if (!streamer) {
                return sendError(
                    res,
                    400,
                    "MISSING_STREAMER",
                    "Streamer is required."
                );
            }

            if (!dareText) {
                return sendError(
                    res,
                    400,
                    "MISSING_DARE",
                    "Dare text is required."
                );
            }

            if (dareText.length > MAX_DARE_TEXT_LENGTH) {
                return sendError(
                    res,
                    400,
                    "DARE_TOO_LONG",
                    "Dare is too long."
                );
            }

            if (
                !duration ||
                duration > MAX_DURATION
            ) {
                return sendError(
                    res,
                    400,
                    "INVALID_DURATION",
                    `Duration must be between 1 and ${MAX_DURATION} seconds.`
                );
            }

            if (reward === null) {
                return sendError(
                    res,
                    400,
                    "INVALID_REWARD",
                    "Invalid reward amount."
                );
            }

            const streamerResult =
                await pool.query(
                    `
                    SELECT
                        id,
                        username,
                        display_name,
                        source,
                        connected
                    FROM streamers
                    WHERE LOWER(username) =
                          LOWER($1)
                    LIMIT 1
                    `,
                    [streamer]
                );

            if (
                streamerResult.rows.length ===
                0
            ) {
                return sendError(
                    res,
                    404,
                    "STREAMER_NOT_FOUND",
                    "Streamer does not exist."
                );
            }

            const streamerRecord =
                streamerResult.rows[0];

            if (!streamerRecord.connected) {
                return sendError(
                    res,
                    409,
                    "STREAMER_OFFLINE",
                    "This streamer is currently offline."
                );
            }

            /*
              Only the streamer owner can submit
              a dare from the controller.

              Public viewers should use the viewer
              submission flow with a future public
              endpoint if needed.
            */

            if (req.user) {
                const owner =
                    await userOwnsStreamer(
                        req.user,
                        streamer
                    );

                /*
                  If a logged-in user is submitting to
                  a streamer they don't own, treat it
                  as a public viewer submission.
                */

                if (owner) {
                    // Controller submission is allowed.
                }
            }

            const client =
                await pool.connect();

            try {
                await client.query(
                    "BEGIN"
                );

                /*
                  Advisory lock ensures that two
                  simultaneous submissions cannot both
                  become active dares.
                */

                await client.query(
                    `
                    SELECT pg_advisory_xact_lock(
                        hashtext(
                            LOWER($1)
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
                        WHERE LOWER(streamer) =
                              LOWER($1)
                          AND status = 'accepted'
                        LIMIT 1
                        `,
                        [streamer]
                    );

                const status =
                    activeResult.rows.length ===
                    0
                        ? "accepted"
                        : "pending";

                const acceptedAt =
                    status === "accepted"
                        ? "NOW()"
                        : "NULL";

                const insertResult =
                    await client.query(
                        `
                        INSERT INTO dares
                            (
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
                        VALUES
                            (
                                $1,
                                $2,
                                $3,
                                $4,
                                $5,
                                $6,
                                $7,
                                ${acceptedAt},
                                NOW()
                            )
                        RETURNING *
                        `,
                        [
                            streamer,
                            "twitch_username",
                            viewer ||
                                "Anonymous",
                            dareText,
                            duration,
                            reward,
                            status
                        ]
                    );

                await client.query(
                    "COMMIT"
                );

                const dare =
                    insertResult.rows[0];

                if (status === "accepted") {
                    broadcast({
                        type: "ACTIVE_DARE",
                        dare
                    });
                } else {
                    broadcast({
                        type: "DARE_CREATED",
                        dare
                    });

                    broadcast({
                        type: "QUEUE_UPDATED",
                        streamer
                    });
                }

                return sendSuccess(
                    res,
                    {
                        dare,
                        status
                    }
                );
            } catch (error) {
                await client.query(
                    "ROLLBACK"
                );
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            console.error(
                "Create dare error:",
                error
            );

            return sendError(
                res,
                500,
                "DARE_CREATE_FAILED",
                "Unable to create dare."
            );
        }
    }
);

/* =========================================================
   DARE GET ROUTES
========================================================= */

app.get(
    "/api/dare",
    async (req, res) => {
        try {
            const streamer =
                normalizeUsername(
                    req.query.streamer
                );

            if (!streamer) {
                return sendError(
                    res,
                    400,
                    "MISSING_STREAMER",
                    "Streamer is required."
                );
            }

            const active =
                await pool.query(
                    `
                    SELECT *
                    FROM dares
                    WHERE LOWER(streamer) =
                          LOWER($1)
                      AND status = 'accepted'
                    ORDER BY
                        accepted_at ASC,
                        id ASC
                    LIMIT 1
                    `,
                    [streamer]
                );

            const queue =
                await pool.query(
                    `
                    SELECT *
                    FROM dares
                    WHERE LOWER(streamer) =
                          LOWER($1)
                      AND status = 'pending'
                    ORDER BY
                        created_at ASC,
                        id ASC
                    `,
                    [streamer]
                );

            return sendSuccess(
                res,
                {
                    active:
                        active.rows[0] ||
                        null,
                    queue:
                        queue.rows
                }
            );
        } catch (error) {
            console.error(
                "Get dare state error:",
                error
            );

            return sendError(
                res,
                500,
                "DARE_STATE_FAILED",
                "Unable to load dare state."
            );
        }
    }
);

app.get(
    "/api/dare/queue/:streamer",
    async (req, res) => {
        try {
            const streamer =
                normalizeUsername(
                    req.params.streamer
                );

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM dares
                    WHERE LOWER(streamer) =
                          LOWER($1)
                      AND status = 'pending'
                    ORDER BY
                        created_at ASC,
                        id ASC
                    `,
                    [streamer]
                );

            return sendSuccess(
                res,
                {
                    queue:
                        result.rows
                }
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
                "Unable to load queue."
            );
        }
    }
);

app.get(
    "/api/dare/active/:streamer",
    async (req, res) => {
        try {
            const streamer =
                normalizeUsername(
                    req.params.streamer
                );

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM dares
                    WHERE LOWER(streamer) =
                          LOWER($1)
                      AND status = 'accepted'
                    ORDER BY
                        accepted_at ASC,
                        id ASC
                    LIMIT 1
                    `,
                    [streamer]
                );

            return sendSuccess(
                res,
                {
                    dare:
                        result.rows[0] ||
                        null
                }
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
                "Unable to load active dare."
            );
        }
    }
);

/* =========================================================
   DARE STATUS
========================================================= */

app.post(
    "/api/dare/:id/status",
    requireAuth,
    async (req, res) => {
        const dareId =
            Number(req.params.id);

        const newStatus =
            String(
                req.body.status || ""
            )
                .trim()
                .toLowerCase();

        if (
            !Number.isInteger(dareId) ||
            dareId <= 0
        ) {
            return sendError(
                res,
                400,
                "INVALID_DARE_ID",
                "Invalid dare ID."
            );
        }

        if (
            !VALID_DARE_STATUSES.has(
                newStatus
            )
        ) {
            return sendError(
                res,
                400,
                "INVALID_STATUS",
                "Invalid dare status."
            );
        }

        try {
            const dareResult =
                await pool.query(
                    `
                    SELECT *
                    FROM dares
                    WHERE id = $1
                    LIMIT 1
                    `,
                    [dareId]
                );

            if (
                dareResult.rows.length ===
                0
            ) {
                return sendError(
                    res,
                    404,
                    "DARE_NOT_FOUND",
                    "Dare not found."
                );
            }

            const dare =
                dareResult.rows[0];

            const owner =
                await userOwnsStreamer(
                    req.user,
                    dare.streamer
                );

            if (!owner) {
                return sendError(
                    res,
                    403,
                    "NOT_STREAMER_OWNER",
                    "You do not control this streamer."
                );
            }

            /*
              When completing or failing the active dare,
              automatically promote the next pending dare.
            */

            if (
                newStatus === "completed" ||
                newStatus === "failed"
            ) {
                const client =
                    await pool.connect();

                try {
                    await client.query(
                        "BEGIN"
                    );

                    await client.query(
                        `
                        SELECT pg_advisory_xact_lock(
                            hashtext(
                                LOWER($1)
                            )
                        )
                        `,
                        [dare.streamer]
                    );

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
                                newStatus,
                                dareId
                            ]
                        );

                    const nextResult =
                        await client.query(
                            `
                            SELECT *
                            FROM dares
                            WHERE LOWER(streamer) =
                                  LOWER($1)
                              AND status = 'pending'
                            ORDER BY
                                created_at ASC,
                                id ASC
                            LIMIT 1
                            FOR UPDATE SKIP LOCKED
                            `,
                            [dare.streamer]
                        );

                    let nextDare = null;

                    if (
                        nextResult.rows.length >
                        0
                    ) {
                        const next =
                            nextResult.rows[0];

                        const promoted =
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
                                [next.id]
                            );

                        nextDare =
                            promoted.rows[0];
                    }

                    await client.query(
                        "COMMIT"
                    );

                    const updatedDare =
                        updateResult.rows[0];

                    broadcast({
                        type:
                            newStatus ===
                            "completed"
                                ? "DARE_COMPLETED"
                                : "DARE_FAILED",
                        dare:
                            updatedDare
                    });

                    if (nextDare) {
                        broadcast({
                            type:
                                "ACTIVE_DARE",
                            dare:
                                nextDare
                        });
                    } else {
                        broadcast({
                            type:
                                "ACTIVE_DARE_CLEARED",
                            streamer:
                                dare.streamer
                        });
                    }

                    broadcast({
                        type:
                            "QUEUE_UPDATED",
                        streamer:
                            dare.streamer
                    });

                    return sendSuccess(
                        res,
                        {
                            dare:
                                updatedDare,
                            nextDare
                        }
                    );
                } catch (error) {
                    await client.query(
                        "ROLLBACK"
                    );
                    throw error;
                } finally {
                    client.release();
                }
            }

            const result =
                await pool.query(
                    `
                    UPDATE dares
                    SET
                        status = $1,
                        accepted_at =
                            CASE
                                WHEN $1 =
                                     'accepted'
                                THEN COALESCE(
                                    accepted_at,
                                    NOW()
                                )
                                ELSE accepted_at
                            END,
                        updated_at = NOW()
                    WHERE id = $2
                    RETURNING *
                    `,
                    [
                        newStatus,
                        dareId
                    ]
                );

            const updated =
                result.rows[0];

            broadcast({
                type:
                    newStatus ===
                    "accepted"
                        ? "ACTIVE_DARE"
                        : newStatus ===
                          "rejected"
                            ? "DARE_REJECTED"
                            : "DARE_CREATED",
                dare: updated
            });

            broadcast({
                type:
                    "QUEUE_UPDATED",
                streamer:
                    dare.streamer
            });

            return sendSuccess(
                res,
                {
                    dare: updated
                }
            );
        } catch (error) {
            console.error(
                "Dare status error:",
                error
            );

            return sendError(
                res,
                500,
                "STATUS_UPDATE_FAILED",
                "Unable to update dare status."
            );
        }
    }
);

/* =========================================================
   HISTORY
========================================================= */

app.get(
    "/api/dare/history",
    requireAuth,
    async (req, res) => {
        try {
            const result =
                await pool.query(
                    `
                    SELECT
                        d.*
                    FROM dares d
                    JOIN streamers s
                        ON LOWER(s.username) =
                           LOWER(d.streamer)
                    WHERE
                        s.owner_user_id = $1
                       OR $2 = 'admin'
                    ORDER BY
                        d.created_at DESC
                    LIMIT 500
                    `,
                    [
                        req.user.id,
                        req.user.role
                    ]
                );

            return sendSuccess(
                res,
                {
                    dares:
                        result.rows
                }
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
                "Unable to load dare history."
            );
        }
    }
);

/* =========================================================
   ADMIN CLEAR
========================================================= */

app.post(
    "/api/dare/clear",
    requireAdmin,
    async (req, res) => {
        try {
            await pool.query(
                `
                DELETE FROM dares
                `
            );

            broadcast({
                type: "RESET"
            });

            return sendSuccess(res);
        } catch (error) {
            console.error(
                "Clear dares error:",
                error
            );

            return sendError(
                res,
                500,
                "CLEAR_FAILED",
                "Unable to clear dares."
            );
        }
    }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
    "/health",
    async (req, res) => {
        try {
            await pool.query(
                "SELECT 1"
            );

            return res.json({
                status: "ok",
                database: "connected",
                timestamp:
                    new Date().toISOString()
            });
        } catch (error) {
            return res.status(503).json({
                status: "error",
                database: "disconnected",
                timestamp:
                    new Date().toISOString()
            });
        }
    }
);

/* =========================================================
   WEBSOCKET
========================================================= */

function broadcast(message) {
    const payload =
        JSON.stringify(message);

    wss.clients.forEach((client) => {
        if (
            client.readyState ===
            WebSocket.OPEN
        ) {
            try {
                client.send(payload);
            } catch (error) {
                console.error(
                    "WebSocket send error:",
                    error
                );
            }
        }
    });
}

async function getWebSocketState() {
    try {
        const active =
            await pool.query(
                `
                SELECT *
                FROM dares
                WHERE status = 'accepted'
                ORDER BY
                    accepted_at ASC,
                    id ASC
                `
            );

        const queue =
            await pool.query(
                `
                SELECT *
                FROM dares
                WHERE status = 'pending'
                ORDER BY
                    created_at ASC,
                    id ASC
                `
            );

        return {
            active:
                active.rows,
            queue:
                queue.rows
        };
    } catch (error) {
        console.error(
            "WebSocket state error:",
            error
        );

        return {
            active: [],
            queue: []
        };
    }
}

wss.on(
    "connection",
    async (socket) => {
        console.log(
            "WebSocket client connected."
        );

        try {
            const state =
                await getWebSocketState();

            socket.send(
                JSON.stringify({
                    type: "STATE",
                    ...state
                })
            );
        } catch (error) {
            console.error(
                "Initial WebSocket state error:",
                error
            );
        }

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
                        const state =
                            await getWebSocketState();

                        socket.send(
                            JSON.stringify({
                                type: "STATE",
                                ...state
                            })
                        );
                    }
                } catch (error) {
                    console.error(
                        "WebSocket message error:",
                        error
                    );
                }
            }
        );

        socket.on(
            "close",
            () => {
                console.log(
                    "WebSocket client disconnected."
                );
            }
        );

        socket.on(
            "error",
            (error) => {
                console.error(
                    "WebSocket error:",
                    error
                );
            }
        );
    }
);

/* =========================================================
   404 HANDLER
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
    (
        error,
        req,
        res,
        next
    ) => {
        console.error(
            "Unhandled server error:",
            error
        );

        if (res.headersSent) {
            return next(error);
        }

        return sendError(
            res,
            500,
            "SERVER_ERROR",
            "Internal server error."
        );
    }
);

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {
    try {
        await initializeDatabase();

        /*
          Remove expired sessions periodically.
        */

        setInterval(
            async () => {
                try {
                    await pool.query(
                        `
                        DELETE FROM sessions
                        WHERE expires_at < NOW()
                        `
                    );
                } catch (error) {
                    console.error(
                        "Session cleanup error:",
                        error
                    );
                }
            },
            1000 * 60 * 60
        );

        server.listen(
            PORT,
            "0.0.0.0",
            () => {
                console.log(
                    `DARE backend running on port ${PORT}`
                );

                console.log(
                    `Frontend origin: ${FRONTEND_ORIGIN}`
                );

                console.log(
                    "WebSocket endpoint: /ws"
                );
            }
        );
    } catch (error) {
        console.error(
            "Failed to start DARE backend:",
            error
        );

        process.exit(1);
    }
}

/* =========================================================
   SHUTDOWN
========================================================= */

async function shutdown(signal) {
    console.log(
        `${signal} received. Shutting down...`
    );

    try {
        await new Promise(
            (resolve) => {
                server.close(
                    () => resolve()
                );
            }
        );

        await pool.end();

        process.exit(0);
    } catch (error) {
        console.error(
            "Shutdown error:",
            error
        );

        process.exit(1);
    }
}

process.on(
    "SIGTERM",
    () => shutdown("SIGTERM")
);

process.on(
    "SIGINT",
    () => shutdown("SIGINT")
);

startServer();
```
