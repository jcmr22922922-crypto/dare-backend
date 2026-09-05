"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");
try { require("dotenv").config(); } catch (_) {}
let helmet, compression, morgan, rateLimit;
try { helmet = require("helmet"); } catch (_) {}
try { compression = require("compression"); } catch (_) {}
try { morgan = require("morgan"); } catch (_) {}
try { rateLimit = require("express-rate-limit"); } catch (_) {}

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 3000);

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error("âŒ DATABASE_URL is missing.");
    process.exit(1);
}

/* ============================================================
   CONFIG
============================================================ */

const FRONTEND_ORIGINS = (
    process.env.FRONTEND_ORIGINS ||
    process.env.FRONTEND_ORIGIN ||
    "https://jcmr22922922-crypto.github.io"
).split(",").map(s=>s.trim().replace(/\/$/, "")).filter(Boolean);
const FRONTEND_ORIGIN = FRONTEND_ORIGINS[0];
function isAllowedOrigin(origin){ if(!origin) return true; return FRONTEND_ORIGINS.includes(origin); }

const SESSION_DAYS = Math.max(
    1,
    Number(process.env.SESSION_DAYS || 30)
);

const SESSION_TTL_MS =
    SESSION_DAYS *
    24 *
    60 *
    60 *
    1000;

const SESSION_COOKIE = "dare_session";

const MAX_DARE_LENGTH = 1000;
const MIN_DARE_DURATION = 5;
const MAX_DARE_DURATION = 300;
const MAX_REWARD = 100000;
const MAX_QUEUE_PER_STREAMER = Math.max(1, Number(process.env.MAX_QUEUE_PER_STREAMER || 20));
const DARE_RATE_WINDOW_MS = 60 * 1000;
const DARE_RATE_MAX = Math.max(1, Number(process.env.DARE_RATE_MAX || 5));

/* ============================================================
   DATABASE
============================================================ */

const pool = new Pool({
    connectionString: DATABASE_URL,

    ssl: {
        rejectUnauthorized: false
    },

    max: 10,

    idleTimeoutMillis: 30000,

    connectionTimeoutMillis: 10000
});

pool.on("error", (error) => {
    console.error(
        "Unexpected PostgreSQL pool error:",
        error
    );
});

/* ============================================================
   EXPRESS
============================================================ */

app.disable("x-powered-by");
app.set("trust proxy", 1);
if (helmet) app.use(helmet({ contentSecurityPolicy:false, crossOriginEmbedderPolicy:false }));
if (compression) app.use(compression());
if (morgan) app.use(morgan(process.env.NODE_ENV==="production" ? "combined" : "dev"));

app.use(
    cors({
        origin: FRONTEND_ORIGIN,
        credentials: true,
        methods: [
            "GET",
            "POST",
            "PATCH",
            "PUT",
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
// ---------- rate limiters ----------
let globalLimiter = (req,res,next)=>next();
let dareLimiter = (req,res,next)=>next();
if (rateLimit) {
  globalLimiter = rateLimit({ windowMs: 15*60*1000, max: 300, standardHeaders:true, legacyHeaders:false, message:{error:"Too many requests, slow down.", code:"RATE_LIMITED"}});
  dareLimiter = rateLimit({ windowMs: DARE_RATE_WINDOW_MS, max: DARE_RATE_MAX, standardHeaders:true, legacyHeaders:false, keyGenerator: (req)=> req.ip + "|" + String(req.body?.streamer || req.body?.streamerId || "").toLowerCase(), message:{error:"You are sending dares too fast. Try again in a minute.", code:"DARE_RATE_LIMITED"}});
  app.use(globalLimiter);
}
app.use("/api/dare", (req,res,next)=>{ if(req.method==="POST" && req.path==="/" ) return dareLimiter(req,res,next); next(); });

/* ============================================================
   HELPERS
============================================================ */

function sendError(
    res,
    status,
    message,
    code = null
) {
    return res.status(status).json({
        error: message,
        ...(code
            ? {
                code
            }
            : {})
    });
}

function normalizeUsername(value) {
    return String(value || "")
        .trim()
        .toLowerCase();
}

function cleanDisplayUsername(value) {
    return String(value || "")
        .trim()
        .replace(/^@/, "");
}

function normalizeEmail(value) {
    return String(value || "")
        .trim()
        .toLowerCase();
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        email
    );
}

function isValidUsername(username) {
    return /^[a-z0-9_]{3,50}$/.test(
        username
    );
}

function isValidPassword(password) {
    return (
        typeof password === "string" &&
        password.length >= 8 &&
        password.length <= 128
    );
}

function cleanText(value, maxLength) {
    return String(value || "")
        .trim()
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
        .slice(0, maxLength);
}
function sanitizeDareText(value){
    return String(value||"").replace(/<[^>]*>/g, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim().replace(/\s+/g, " ").slice(0, MAX_DARE_LENGTH);
}
const BLOCKED_WORDS = (process.env.BLOCKED_WORDS||"").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
function containsBlocked(text){ if(!BLOCKED_WORDS.length) return false; const low=text.toLowerCase(); return BLOCKED_WORDS.some(w=> low.includes(w)); }

function parsePositiveInteger(value) {
    const number = Number(value);

    if (
        !Number.isInteger(number) ||
        number < 1
    ) {
        return null;
    }

    return number;
}

function parseReward(value) {
    const number = Number(value);

    if (
        !Number.isFinite(number) ||
        number < 0 ||
        number > MAX_REWARD
    ) {
        return null;
    }

    return Math.round(number * 100) / 100;
}

function normalizePlatform(value) {
    const platform = String(
        value || ""
    )
        .trim()
        .toLowerCase();

    if (
        [
            "twitch",
            "youtube",
            "kick",
            "other"
        ].includes(platform)
    ) {
        return platform;
    }

    return null;
}

/* ============================================================
   PASSWORD HASHING
============================================================ */

function hashPassword(password) {
    return new Promise(
        (resolve, reject) => {
            const salt =
                crypto.randomBytes(16);

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
                        [
                            "scrypt",
                            salt.toString("hex"),
                            derivedKey.toString("hex")
                        ].join("$")
                    );
                }
            );
        }
    );
}

function verifyPassword(
    password,
    storedHash
) {
    return new Promise(
        (resolve, reject) => {
            try {
                const parts =
                    String(
                        storedHash || ""
                    ).split("$");

                if (
                    parts.length !== 3 ||
                    parts[0] !== "scrypt"
                ) {
                    resolve(false);
                    return;
                }

                const salt =
                    Buffer.from(
                        parts[1],
                        "hex"
                    );

                const storedKey =
                    Buffer.from(
                        parts[2],
                        "hex"
                    );

                crypto.scrypt(
                    password,
                    salt,
                    storedKey.length,
                    {
                        N: 16384,
                        r: 8,
                        p: 1
                    },
                    (
                        error,
                        derivedKey
                    ) => {
                        if (error) {
                            reject(error);
                            return;
                        }

                        if (
                            derivedKey.length !==
                            storedKey.length
                        ) {
                            resolve(false);
                            return;
                        }

                        resolve(
                            crypto.timingSafeEqual(
                                derivedKey,
                                storedKey
                            )
                        );
                    }
                );
            } catch (error) {
                reject(error);
            }
        }
    );
}

/* ============================================================
   SESSION HELPERS
============================================================ */

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

function parseCookies(
    cookieHeader
) {
    const cookies = {};

    if (!cookieHeader) {
        return cookies;
    }

    for (
        const part of cookieHeader.split(";")
    ) {
        const index =
            part.indexOf("=");

        if (index === -1) {
            continue;
        }

        const key =
            part.slice(0, index).trim();

        const value =
            part
                .slice(index + 1)
                .trim();

        if (key) {
            cookies[key] =
                decodeURIComponent(
                    value
                );
        }
    }

    return cookies;
}

function appendSessionCookie(
    res,
    token,
    maxAgeSeconds
) {
    const cookie =
        [
            `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
            "Path=/",
            `Max-Age=${maxAgeSeconds}`,
            "HttpOnly",
            "Secure",
            "SameSite=None",
            "Partitioned"
        ].join("; ");

    res.append(
        "Set-Cookie",
        cookie
    );
}

function clearSessionCookie(res) {
    const cookie =
        [
            `${SESSION_COOKIE}=`,
            "Path=/",
            "Max-Age=0",
            "HttpOnly",
            "Secure",
            "SameSite=None",
            "Partitioned"
        ].join("; ");

    res.append(
        "Set-Cookie",
        cookie
    );
}

async function createSession(
    userId
) {
    const token =
        createSessionToken();

    const tokenHash =
        hashSessionToken(token);

    await pool.query(
        `
        INSERT INTO sessions (
            user_id,
            token_hash,
            expires_at
        )
        VALUES (
            $1,
            $2,
            NOW() + ($3 * INTERVAL '1 millisecond')
        )
        `,
        [
            userId,
            tokenHash,
            SESSION_TTL_MS
        ]
    );

    return token;
}

async function getUserFromToken(
    token
) {
    if (!token) {
        return null;
    }

    const tokenHash =
        hashSessionToken(token);

    const result =
        await pool.query(
            `
            SELECT
                s.id AS session_id,
                u.id,
                u.username,
                u.email,
                u.role
            FROM sessions s
            JOIN users u
                ON u.id = s.user_id
            WHERE
                s.token_hash = $1
                AND s.expires_at > NOW()
            LIMIT 1
            `,
            [tokenHash]
        );

    if (
        result.rows.length === 0
    ) {
        return null;
    }

    const row =
        result.rows[0];

    await pool.query(
        `
        UPDATE sessions
        SET last_seen_at = NOW()
        WHERE id = $1
        `,
        [row.session_id]
    );

    return {
        id: row.id,
        username: row.username,
        email: row.email,
        role: row.role,
        sessionId: row.session_id
    };
}

async function authenticateRequest(
    req,
    res = null
) {
    let token = null;

    const authorization =
        req.headers.authorization;

    if (
        authorization &&
        authorization.startsWith(
            "Bearer "
        )
    ) {
        token =
            authorization
                .slice(7)
                .trim();
    }

    if (!token) {
        const cookies =
            parseCookies(
                req.headers.cookie
            );

        token =
            cookies[
                SESSION_COOKIE
            ];
    }

    if (!token) {
        return null;
    }

    const user =
        await getUserFromToken(
            token
        );

    if (
        !user &&
        res
    ) {
        clearSessionCookie(res);
    }

    return user;
}

async function requireAuth(
    req,
    res,
    next
) {
    try {
        const user =
            await authenticateRequest(
                req,
                res
            );

        if (!user) {
            return sendError(
                res,
                401,
                "Authentication required.",
                "AUTH_REQUIRED"
            );
        }

        req.user = user;

        next();
    } catch (error) {
        console.error(
            "Authentication error:",
            error
        );

        return sendError(
            res,
            500,
            "Authentication service error."
        );
    }
}

/* ============================================================
   DATABASE INITIALIZATION
============================================================ */

async function initializeDatabase() {
    const client =
        await pool.connect();

    try {
        await client.query(
            "BEGIN"
        );

        /*
         * USERS
         */

        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id BIGSERIAL PRIMARY KEY,
                username TEXT NOT NULL,
                email TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'streamer',
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

        /*
         * SESSIONS
         */

        await client.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL
                    REFERENCES users(id)
                    ON DELETE CASCADE,
                token_hash TEXT NOT NULL UNIQUE,
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

        /*
         * STREAMERS
         */

        await client.query(`
            CREATE TABLE IF NOT EXISTS streamers (
                id BIGSERIAL PRIMARY KEY,
                owner_user_id BIGINT,
                username TEXT NOT NULL,
                display_name TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'nerve_account',
                platform TEXT,
                platform_username TEXT,
                connected BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        /*
         * Upgrade older databases.
         */

        await client.query(`
            ALTER TABLE streamers
            ADD COLUMN IF NOT EXISTS owner_user_id BIGINT
        `);

        await client.query(`
            ALTER TABLE streamers
            ADD COLUMN IF NOT EXISTS display_name TEXT
        `);

        await client.query(`
            ALTER TABLE streamers
            ADD COLUMN IF NOT EXISTS source TEXT
        `);

        await client.query(`
            ALTER TABLE streamers
            ADD COLUMN IF NOT EXISTS platform TEXT
        `);

        await client.query(`
            ALTER TABLE streamers
            ADD COLUMN IF NOT EXISTS platform_username TEXT
        `);

        await client.query(`
            ALTER TABLE streamers
            ADD COLUMN IF NOT EXISTS connected BOOLEAN
        `);

        await client.query(`
            UPDATE streamers
            SET display_name = username
            WHERE display_name IS NULL
        `);

        await client.query(`
            UPDATE streamers
            SET source = 'nerve_account'
            WHERE source IS NULL
        `);

        await client.query(`
            UPDATE streamers
            SET connected = FALSE
            WHERE connected IS NULL
        `);

        /*
         * Add FK if it doesn't already exist.
         */

        const fkCheck =
            await client.query(`
                SELECT 1
                FROM pg_constraint
                WHERE conname =
                    'streamers_owner_user_fk'
                LIMIT 1
            `);

        if (
            fkCheck.rows.length === 0
        ) {
            await client.query(`
                ALTER TABLE streamers
                ADD CONSTRAINT
                streamers_owner_user_fk
                FOREIGN KEY (owner_user_id)
                REFERENCES users(id)
                ON DELETE SET NULL
            `);
        }

        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS
            streamers_username_lower_unique
            ON streamers (LOWER(username))
        `);

        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS
            streamers_owner_unique
            ON streamers(owner_user_id)
            WHERE owner_user_id IS NOT NULL
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS
            streamers_connected_idx
            ON streamers(connected)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS
            streamers_owner_user_idx
            ON streamers(owner_user_id)
        `);

        /*
         * DARES
         */

        await client.query(`
            CREATE TABLE IF NOT EXISTS dares (
                id BIGSERIAL PRIMARY KEY,
                streamer TEXT NOT NULL,
                streamer_source TEXT NOT NULL DEFAULT 'nerve_account',
                streamer_id BIGINT,
                viewer TEXT NOT NULL,
                dare_text TEXT NOT NULL,
                duration INTEGER NOT NULL,
                reward NUMERIC(12,2) NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                accepted_at TIMESTAMPTZ,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await client.query(`
            ALTER TABLE dares
            ADD COLUMN IF NOT EXISTS streamer_id BIGINT
        `);

        await client.query(`
            ALTER TABLE dares
            ADD COLUMN IF NOT EXISTS streamer_source TEXT
        `);

        await client.query(`
            UPDATE dares
            SET streamer_source = 'nerve_account'
            WHERE streamer_source IS NULL
        `);

        /*
         * Backfill old dares where possible.
         */

        await client.query(`
            UPDATE dares d
            SET streamer_id = s.id
            FROM streamers s
            WHERE
                d.streamer_id IS NULL
                AND LOWER(d.streamer) =
                    LOWER(s.username)
        `);

        /*
         * Add dare FK if missing.
         */

        const dareFkCheck =
            await client.query(`
                SELECT 1
                FROM pg_constraint
                WHERE conname =
                    'dares_streamer_fk'
                LIMIT 1
            `);

        if (
            dareFkCheck.rows.length === 0
        ) {
            await client.query(`
                ALTER TABLE dares
                ADD CONSTRAINT dares_streamer_fk
                FOREIGN KEY (streamer_id)
                REFERENCES streamers(id)
                ON DELETE CASCADE
            `);
        }

        await client.query(`
            CREATE INDEX IF NOT EXISTS
            dares_streamer_id_idx
            ON dares(streamer_id)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS
            dares_status_idx
            ON dares(status)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS
            dares_streamer_status_created_idx
            ON dares(
                streamer_id,
                status,
                created_at
            )
        `);

        /*
         * Only one accepted dare per streamer.
         *
         * This index can fail if an old database
         * already contains duplicate accepted dares.
         *
         * We clean those duplicates first.
         */

        await client.query(`
            WITH ranked AS (
                SELECT
                    id,
                    ROW_NUMBER() OVER (
                        PARTITION BY streamer_id
                        ORDER BY
                            accepted_at ASC NULLS LAST,
                            created_at ASC,
                            id ASC
                    ) AS rn
                FROM dares
                WHERE
                    status = 'accepted'
                    AND streamer_id IS NOT NULL
            )
            UPDATE dares d
            SET
                status = 'pending',
                accepted_at = NULL,
                updated_at = NOW()
            FROM ranked r
            WHERE
                d.id = r.id
                AND r.rn > 1
        `);

        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS
            dares_one_active_per_streamer
            ON dares(streamer_id)
            WHERE status = 'accepted'
        `);

        /*
         * Give every existing user one Nerve
         * streamer profile.
         */

        await client.query(`
            INSERT INTO streamers (
                owner_user_id,
                username,
                display_name,
                source,
                connected
            )
            SELECT
                u.id,
                u.username,
                u.username,
                'nerve_account',
                FALSE
            FROM users u
            WHERE NOT EXISTS (
                SELECT 1
                FROM streamers s
                WHERE s.owner_user_id = u.id
            )
            AND NOT EXISTS (
                SELECT 1
                FROM streamers s
                WHERE LOWER(s.username) =
                    LOWER(u.username)
            )
        `);

        await client.query(`
            UPDATE streamers
            SET source = 'nerve_account'
            WHERE owner_user_id IS NOT NULL
        `);

        /*
         * On startup nobody should remain
         * marked as connected.
         */

        await client.query(`
            UPDATE streamers
            SET
                connected = FALSE,
                updated_at = NOW()
        `);

        /*
         * Clean expired sessions.
         */

        await client.query(`
            DELETE FROM sessions
            WHERE expires_at <= NOW()
        `);

        await client.query(
            "COMMIT"
        );

        console.log(
            "âœ… PostgreSQL database initialized."
        );
    } catch (error) {
        await client.query(
            "ROLLBACK"
        );

        console.error(
            "âŒ Database initialization failed:",
            error
        );

        throw error;
    } finally {
        client.release();
    }
}

/* ============================================================
   SESSION CLEANUP
============================================================ */

const sessionCleanup =
    setInterval(
        async () => {
            try {
                await pool.query(`
                    DELETE FROM sessions
                    WHERE expires_at <= NOW()
                `);
            } catch (error) {
                console.error(
                    "Session cleanup error:",
                    error
                );
            }
        },
        60 * 60 * 1000
    );

if (
    sessionCleanup.unref
) {
    sessionCleanup.unref();
}

/* ============================================================
   STREAMER HELPERS
============================================================ */

async function getStreamerForUser(
    userId
) {
    const result =
        await pool.query(
            `
            SELECT *
            FROM streamers
            WHERE owner_user_id = $1
            ORDER BY id ASC
            LIMIT 1
            `,
            [userId]
        );

    return (
        result.rows[0] ||
        null
    );
}

async function getStreamerById(
    streamerId
) {
    const id =
        Number(streamerId);

    if (
        !Number.isInteger(id) ||
        id < 1
    ) {
        return null;
    }

    const result =
        await pool.query(
            `
            SELECT *
            FROM streamers
            WHERE id = $1
            LIMIT 1
            `,
            [id]
        );

    return (
        result.rows[0] ||
        null
    );
}

async function getStreamerByUsername(
    username
) {
    const normalized =
        normalizeUsername(
            username
        );

    if (!normalized) {
        return null;
    }

    const result =
        await pool.query(
            `
            SELECT *
            FROM streamers
            WHERE LOWER(username) = $1
            LIMIT 1
            `,
            [normalized]
        );

    return (
        result.rows[0] ||
        null
    );
}

function publicStreamer(
    streamer
) {
    if (!streamer) {
        return null;
    }

    return {
        id: streamer.id,

        username:
            streamer.username,

        displayName:
            streamer.display_name,

        display_name:
            streamer.display_name,

        source:
            streamer.source,

        platform:
            streamer.platform,

        platformUsername:
            streamer.platform_username,

        platform_username:
            streamer.platform_username,

        connected:
            Boolean(
                streamer.connected
            )
    };
}

function publicUser(user) {
    if (!user) {
        return null;
    }

    return {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
    };
}

/* ============================================================
   ROOT / HEALTH
============================================================ */

app.get(
    "/",
    async (req, res) => {
        try {
            const result =
                await pool.query(`
                    SELECT
                        COUNT(*) FILTER (
                            WHERE status = 'accepted'
                        ) AS active_count,

                        COUNT(*) FILTER (
                            WHERE status = 'pending'
                        ) AS pending_count
                    FROM dares
                `);

            return res.json({
                service: "Nerve DARE Backend",
                status: "online",
                database: "connected",
                frontend: FRONTEND_ORIGIN,

                activeDares:
                    Number(
                        result.rows[0]
                            .active_count
                    ),

                pendingDares:
                    Number(
                        result.rows[0]
                            .pending_count
                    )
            });
        } catch (error) {
            console.error(
                "Root endpoint error:",
                error
            );

            return res.status(503).json({
                service:
                    "Nerve DARE Backend",

                status:
                    "degraded",

                database:
                    "unavailable"
            });
        }
    }
);

app.get(
    "/health",
    async (req, res) => {
        try {
            await pool.query(
                "SELECT 1"
            );

            return res.json({
                status: "ok",
                database: "ok"
            });
        } catch (error) {
            return res.status(503).json({
                status: "error",
                database: "error"
            });
        }
    }
);

/* ============================================================
   AUTH â€” REGISTER
============================================================ */

app.post(
    "/api/auth/register",
    async (req, res) => {
        const username =
            normalizeUsername(
                req.body?.username
            );

        const email =
            normalizeEmail(
                req.body?.email
            );

        const password =
            req.body?.password;

        if (
            !isValidUsername(
                username
            )
        ) {
            return sendError(
                res,
                400,
                "Username must be 3-50 characters and use only letters, numbers, and underscores.",
                "INVALID_USERNAME"
            );
        }

        if (
            !isValidEmail(email)
        ) {
            return sendError(
                res,
                400,
                "Please enter a valid email address.",
                "INVALID_EMAIL"
            );
        }

        if (
            !isValidPassword(
                password
            )
        ) {
            return sendError(
                res,
                400,
                "Password must be between 8 and 128 characters.",
                "INVALID_PASSWORD"
            );
        }

        try {
            const existing =
                await pool.query(
                    `
                    SELECT
                        EXISTS (
                            SELECT 1
                            FROM users
                            WHERE LOWER(username) = $1
                        ) AS username_exists,

                        EXISTS (
                            SELECT 1
                            FROM users
                            WHERE LOWER(email) = $2
                        ) AS email_exists
                    `,
                    [
                        username,
                        email
                    ]
                );

            if (
                existing.rows[0]
                    .username_exists
            ) {
                return sendError(
                    res,
                    409,
                    "That username is already taken.",
                    "USERNAME_EXISTS"
                );
            }

            if (
                existing.rows[0]
                    .email_exists
            ) {
                return sendError(
                    res,
                    409,
                    "An account with that email already exists.",
                    "EMAIL_EXISTS"
                );
            }

            const passwordHash =
                await hashPassword(
                    password
                );

            const client =
                await pool.connect();

            let user;

            let streamer;

            try {
                await client.query(
                    "BEGIN"
                );

                const userResult =
                    await client.query(
                        `
                        INSERT INTO users (
                            username,
                            email,
                            password_hash,
                            role
                        )
                        VALUES (
                            $1,
                            $2,
                            $3,
                            'streamer'
                        )
                        RETURNING
                            id,
                            username,
                            email,
                            role
                        `,
                        [
                            username,
                            email,
                            passwordHash
                        ]
                    );

                user =
                    userResult.rows[0];

                const streamerResult =
                    await client.query(
                        `
                        INSERT INTO streamers (
                            owner_user_id,
                            username,
                            display_name,
                            source,
                            connected
                        )
                        VALUES (
                            $1,
                            $2,
                            $3,
                            'nerve_account',
                            FALSE
                        )
                        RETURNING *
                        `,
                        [
                            user.id,
                            username,
                            cleanDisplayUsername(
                                req.body
                                    ?.displayName ||
                                username
                            )
                        ]
                    );

                streamer =
                    streamerResult.rows[0];

                await client.query(
                    "COMMIT"
                );
            } catch (error) {
                await client.query(
                    "ROLLBACK"
                );

                throw error;
            } finally {
                client.release();
            }

            const sessionToken =
                await createSession(
                    user.id
                );

            appendSessionCookie(
                res,
                sessionToken,
                Math.floor(
                    SESSION_TTL_MS /
                    1000
                )
            );

            return res.status(201).json({
                success: true,

                data: {
                    user:
                        publicUser(
                            user
                        ),

                    streamer:
                        publicStreamer(
                            streamer
                        ),

                    /*
                     * The current frontend stores
                     * this in localStorage and uses it
                     * for WebSocket AUTH.
                     */
                    sessionToken
                }
            });
        } catch (error) {
            console.error(
                "Register error:",
                error
            );

            if (
                error.code ===
                "23505"
            ) {
                return sendError(
                    res,
                    409,
                    "Username or email is already in use.",
                    "ACCOUNT_EXISTS"
                );
            }

            return sendError(
                res,
                500,
                "Unable to create your account."
            );
        }
    }
);

/* ============================================================
   AUTH â€” LOGIN
============================================================ */

app.post(
    "/api/auth/login",
    async (req, res) => {
        const email =
            normalizeEmail(
                req.body?.email
            );

        const password =
            req.body?.password;

        if (
            !isValidEmail(email)
        ) {
            return sendError(
                res,
                400,
                "Please enter a valid email address.",
                "INVALID_EMAIL"
            );
        }

        if (
            typeof password !==
                "string" ||
            password.length < 1
        ) {
            return sendError(
                res,
                400,
                "Password is required.",
                "PASSWORD_REQUIRED"
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
                    WHERE LOWER(email) = $1
                    LIMIT 1
                    `,
                    [email]
                );

            if (
                result.rows.length === 0
            ) {
                return sendError(
                    res,
                    401,
                    "Invalid email or password.",
                    "INVALID_LOGIN"
                );
            }

            const user =
                result.rows[0];

            const passwordCorrect =
                await verifyPassword(
                    password,
                    user.password_hash
                );

            if (!passwordCorrect) {
                return sendError(
                    res,
                    401,
                    "Invalid email or password.",
                    "INVALID_LOGIN"
                );
            }

            let streamer =
                await getStreamerForUser(
                    user.id
                );

            /*
             * Repair accounts created before
             * automatic streamer profiles existed.
             */

            if (!streamer) {
                try {
                    const insert =
                        await pool.query(
                            `
                            INSERT INTO streamers (
                                owner_user_id,
                                username,
                                display_name,
                                source,
                                connected
                            )
                            VALUES (
                                $1,
                                $2,
                                $3,
                                'nerve_account',
                                FALSE
                            )
                            ON CONFLICT DO NOTHING
                            RETURNING *
                            `,
                            [
                                user.id,
                                user.username,
                                user.username
                            ]
                        );

                    streamer =
                        insert.rows[0] ||
                        await getStreamerForUser(
                            user.id
                        );
                } catch (error) {
                    console.error(
                        "Streamer profile repair error:",
                        error
                    );
                }
            }

            const sessionToken =
                await createSession(
                    user.id
                );

            appendSessionCookie(
                res,
                sessionToken,
                Math.floor(
                    SESSION_TTL_MS /
                    1000
                )
            );

            return res.json({
                success: true,

                data: {
                    user:
                        publicUser(
                            user
                        ),

                    streamer:
                        publicStreamer(
                            streamer
                        ),

                    sessionToken
                }
            });
        } catch (error) {
            console.error(
                "Login error:",
                error
            );

            return sendError(
                res,
                500,
                "Unable to log in."
            );
        }
    }
);

/* ============================================================
   AUTH â€” ME
============================================================ */

app.get(
    "/api/auth/me",
    async (req, res) => {
        try {
            const user =
                await authenticateRequest(
                    req,
                    res
                );

            if (!user) {
                return sendError(
                    res,
                    401,
                    "Not authenticated.",
                    "NOT_AUTHENTICATED"
                );
            }

            return res.json({
                success: true,

                data: {
                    user:
                        publicUser(
                            user
                        )
                }
            });
        } catch (error) {
            console.error(
                "Auth me error:",
                error
            );

            return sendError(
                res,
                500,
                "Unable to check authentication."
            );
        }
    }
);

/* ============================================================
   AUTH â€” LOGOUT
============================================================ */

app.post(
    "/api/auth/logout",
    async (req, res) => {
        try {
            const user =
                await authenticateRequest(
                    req,
                    res
                );

            if (user?.sessionId) {
                await pool.query(
                    `
                    DELETE FROM sessions
                    WHERE id = $1
                    `,
                    [user.sessionId]
                );
            }
        } catch (error) {
            console.warn(
                "Logout cleanup error:",
                error
            );
        }

        clearSessionCookie(res);

        return res.json({
            success: true
        });
    }
);

/* ============================================================
   AUTH â€” LOGOUT ALL
============================================================ */

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

            return res.json({
                success: true
            });
        } catch (error) {
            console.error(
                "Logout all error:",
                error
            );

            return sendError(
                res,
                500,
                "Unable to log out all sessions."
            );
        }
    }
);

/* ============================================================
   PUBLIC STREAMERS
============================================================ */

app.get(
    "/api/streamers",
    async (req, res) => {
        try {
            const result =
                await pool.query(`
                    SELECT
                        id,
                        username,
                        display_name,
                        source,
                        platform,
                        platform_username,
                        connected
                    FROM streamers
                    ORDER BY
                        LOWER(display_name),
                        id
                `);

            return res.json({
                success: true,

                data: {
                    streamers:
                        result.rows.map(
                            publicStreamer
                        )
                },

                streamers:
                    result.rows.map(
                        publicStreamer
                    )
            });
        } catch (error) {
            console.error(
                "Public streamers error:",
                error
            );

            return sendError(
                res,
                500,
                "Unable to load streamers."
            );
        }
    }
);

/* ============================================================
   MY STREAMER
============================================================ */

app.get(
    "/api/my-streamer",
    requireAuth,
    async (req, res) => {
        try {
            const streamer =
                await getStreamerForUser(
                    req.user.id
                );

            return res.json({
                success: true,

                data: {
                    streamer:
                        publicStreamer(
                            streamer
                        )
                },

                streamer:
                    publicStreamer(
                        streamer
                    )
            });
        } catch (error) {
            console.error(
                "My streamer error:",
                error
            );

            return sendError(
                res,
                500,
                "Unable to load your streamer profile."
            );
        }
    }
);

/* ============================================================
   MY STREAMERS
============================================================ */

app.get(
    "/api/my-streamers",
    requireAuth,
    async (req, res) => {
        try {
            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM streamers
                    WHERE owner_user_id = $1
                    ORDER BY id ASC
                    `,
                    [req.user.id]
                );

            const streamers =
                result.rows.map(
                    publicStreamer
                );

            return res.json({
                success: true,

                data: {
                    streamers
                },

                streamers
            });
        } catch (error) {
            console.error(
                "My streamers error:",
                error
            );

            return sendError(
                res,
                500,
                "Unable to load your streamer profiles."
            );
        }
    }
);

/* ============================================================
   UPDATE MY STREAMER
   PATCH /api/my-streamer
============================================================ */

app.patch(
    "/api/my-streamer",
    requireAuth,
    async (req, res) => {
        try {
            const streamer =
                await getStreamerForUser(
                    req.user.id
                );

            if (!streamer) {
                return sendError(
                    res,
                    404,
                    "Streamer profile not found.",
                    "STREAMER_NOT_FOUND"
                );
            }

            const body =
                req.body || {};

            /*
             * Existing frontend may send any
             * of these forms.
             */

            let displayName =
                body.displayName ??
                body.display_name;

            let platform =
                body.platform;

            let platformUsername =
                body.platformUsername ??
                body.platform_username;

            let username =
                body.username;

            /*
             * Only update values actually supplied.
             */

            displayName =
                displayName !==
                undefined
                    ? cleanDisplayUsername(
                        displayName
                    )
                    : streamer.display_name;

            if (
                !displayName
            ) {
                displayName =
                    streamer.username;
            }

            if (
                platform !==
                undefined
            ) {
                platform =
                    normalizePlatform(
                        platform
                    );

                if (
                    body.platform &&
                    !platform
                ) {
                    return sendError(
                        res,
                        400,
                        "Invalid platform.",
                        "INVALID_PLATFORM"
                    );
                }
            } else {
                platform =
                    streamer.platform;
            }

            if (
                platformUsername !==
                undefined
            ) {
                platformUsername =
                    cleanText(
                        platformUsername,
                        100
                    );

                if (
                    !platformUsername
                ) {
                    platformUsername =
                        null;
                }
            } else {
                platformUsername =
                    streamer.platform_username;
            }

            /*
             * Username is the Nerve streamer username.
             * Keep it tied to the Nerve account unless
             * the frontend explicitly requests a change.
             */

            if (
                username !==
                undefined
            ) {
                username =
                    normalizeUsername(
                        username
                    );

                if (
                    !isValidUsername(
                        username
                    )
                ) {
                    return sendError(
                        res,
                        400,
                        "Invalid streamer username.",
                        "INVALID_USERNAME"
                    );
                }

                const conflict =
                    await pool.query(
                        `
                        SELECT id
                        FROM streamers
                        WHERE
                            LOWER(username) = $1
                            AND id <> $2
                        LIMIT 1
                        `,
                        [
                            username,
                            streamer.id
                        ]
                    );

                if (
                    conflict.rows.length
                ) {
                    return sendError(
                        res,
                        409,
                        "That streamer username is already in use.",
                        "STREAMER_USERNAME_EXISTS"
                    );
                }
            } else {
                username =
                    streamer.username;
            }

            const result =
                await pool.query(
                    `
                    UPDATE streamers
                    SET
                        username = $1,
                        display_name = $2,
                        platform = $3,
                        platform_username = $4,
                        updated_at = NOW()
                    WHERE
                        id = $5
                        AND owner_user_id = $6
                    RETURNING *
                    `,
                    [
                        username,
                        displayName,
                        platform,
                        platformUsername,
                        streamer.id,
                        req.user.id
                    ]
                );

            const updated =
                result.rows[0];

            return res.json({
                success: true,

                data: {
                    streamer:
                        publicStreamer(
                            updated
                        )
                },

                streamer:
                    publicStreamer(
                        updated
                    )
            });
        } catch (error) {
            console.error(
                "Update streamer error:",
                error
            );

            if (
                error.code ===
                "23505"
            ) {
                return sendError(
                    res,
                    409,
                    "That streamer username is already in use.",
                    "STREAMER_USERNAME_EXISTS"
                );
            }

            return sendError(
                res,
                500,
                "Unable to update streamer profile."
            );
        }
    }
);

/* ============================================================
   UPDATE PLATFORM
============================================================ */

app.post(
    "/api/my-streamer/platform",
    requireAuth,
    async (req, res) => {
        try {
            const platform =
                normalizePlatform(
                    req.body?.platform
                );

            const platformUsername =
                cleanText(
                    req.body?.platformUsername ??
                    req.body?.platform_username,
                    100
                );

            if (!platform) {
                return sendError(
                    res,
                    400,
                    "Invalid platform.",
                    "INVALID_PLATFORM"
                );
            }

            const streamer =
                await getStreamerForUser(
                    req.user.id
                );

            if (!streamer) {
                return sendError(
                    res,
                    404,
                    "Streamer profile not found.",
                    "STREAMER_NOT_FOUND"
                );
            }

            const result =
                await pool.query(
                    `
                    UPDATE streamers
                    SET
                        platform = $1,
                        platform_username = $2,
                        updated_at = NOW()
                    WHERE
                        id = $3
                        AND owner_user_id = $4
                    RETURNING *
                    `,
                    [
                        platform,
                        platformUsername ||
                            null,
                        streamer.id,
                        req.user.id
                    ]
                );

            return res.json({
                success: true,

                data: {
                    streamer:
                        publicStreamer(
                            result.rows[0]
                        )
                }
            });
        } catch (error) {
            console.error(
                "Platform update error:",
                error
            );

            return sendError(
                res,
                500,
                "Unable to update platform."
            );
        }
    }
);

/* ============================================================
   DARE FORMATTER
============================================================ */

function formatDare(
    row
) {
    if (!row) {
        return null;
    }

    const streamerId =
        row.streamer_id ??
        row.streamerId ??
        null;

    const streamerUsername =
        row.streamer ||
        row.streamer_username ||
        "";

    const streamerDisplayName =
        row.streamer_display_name ||
        row.streamer_displayName ||
        streamerUsername;

    const platform =
        row.platform ||
        null;

    const platformUsername =
        row.platform_username ||
        null;

    return {
        id: row.id,

        streamerId,

        streamer_id:
            streamerId,

        streamer:
            streamerUsername,

        streamerUsername,

        streamerDisplayName,

        streamer_source:
            row.streamer_source ||
            "nerve_account",

        streamerSource:
            row.streamer_source ||
            "nerve_account",

        platform,

        platformUsername,

        platform_username:
            platformUsername,

        viewer:
            row.viewer,

        dare_text:
            row.dare_text,

        dareText:
            row.dare_text,

        text:
            row.dare_text,

        duration:
            Number(row.duration),

        reward:
            Number(row.reward || 0),

        status:
            row.status,

        created_at:
            row.created_at,

        createdAt:
            row.created_at,

        accepted_at:
            row.accepted_at,

        acceptedAt:
            row.accepted_at,

        updated_at:
            row.updated_at,

        updatedAt:
            row.updated_at
    };
}

/* ============================================================
   GET ALL DARE STATE
============================================================ */

async function getAllDareState() {
    const result =
        await pool.query(`
            SELECT
                d.*,

                s.username
                    AS streamer_username,

                s.display_name
                    AS streamer_display_name,

                s.platform,

                s.platform_username,

                s.connected
                    AS streamer_connected

            FROM dares d

            LEFT JOIN streamers s
                ON s.id = d.streamer_id

            WHERE
                d.status IN (
                    'pending',
                    'accepted'
                )

            ORDER BY
                d.created_at ASC,
                d.id ASC
        `);

    const active = {};

    const activeDares = [];

    const queues = {};

    for (
        const row of result.rows
    ) {
        const dare =
            formatDare({
                ...row,

                streamer:
                    row.streamer_username ||
                    row.streamer,

                streamer_display_name:
                    row.streamer_display_name
            });

        const key =
            row.streamer_id !== null &&
            row.streamer_id !== undefined
                ? String(
                    row.streamer_id
                )
                : normalizeUsername(
                    row.streamer
                );

        if (
            row.status ===
            "accepted"
        ) {
            active[key] =
                dare;

            activeDares.push(
                dare
            );
        }

        if (
            row.status ===
            "pending"
        ) {
            if (!queues[key]) {
                queues[key] = [];
            }

            queues[key].push(
                dare
            );
        }
    }

    return {
        active,
        activeDares,
        queues
    };
}

/* ============================================================
   BROADCAST
============================================================ */

const wss =
    new WebSocket.Server({
        noServer: true,
        perMessageDeflate: { zlibDeflateOptions:{chunkSize:1024, memLevel:7, level:3}, threshold:1024 },
        maxPayload: 16*1024
    });
function heartbeat(){ this.isAlive=true; }
const wsHeartbeat = setInterval(()=>{
  wss.clients.forEach(ws=>{
    if(ws.isAlive===false) return ws.terminate();
    ws.isAlive=false; try{ ws.ping(()=>{}); }catch(_){}
  });
}, 25000);
if(wsHeartbeat.unref) wsHeartbeat.unref();

function broadcast(
    message
) {
    const payload =
        JSON.stringify(message);

    for (
        const socket of wss.clients
    ) {
        if (
            socket.readyState ===
            WebSocket.OPEN
        ) {
            try {
                socket.send(
                    payload
                );
            } catch (error) {
                console.warn(
                    "WebSocket send error:",
                    error
                );
            }
        }
    }
}

async function sendState(
    socket
) {
    try {
        const state =
            await getAllDareState();

        const streamersResult =
            await pool.query(`
                SELECT
                    id,
                    username,
                    display_name,
                    source,
                    platform,
                    platform_username,
                    connected
                FROM streamers
                ORDER BY
                    LOWER(display_name),
                    id
            `);

        const streamers =
            streamersResult.rows.map(
                publicStreamer
            );

        const message = {
            type: "STATE",

            active:
                state.active,

            activeDares:
                state.activeDares,

            queues:
                state.queues,

            streamers
        };

        if (
            socket.readyState ===
            WebSocket.OPEN
        ) {
            socket.send(
                JSON.stringify(
                    message
                )
            );
        }
    } catch (error) {
        console.error(
            "sendState error:",
            error
        );
    }
}

/* ============================================================
   STREAMER CONNECTION STATUS
============================================================ */

const controllerConnections =
    new Map();

async function setStreamerConnected(
    streamerId,
    connected
) {
    try {
        await pool.query(
            `
            UPDATE streamers
            SET
                connected = $1,
                updated_at = NOW()
            WHERE id = $2
            `,
            [
                connected,
                streamerId
            ]
        );

        broadcast({
            type:
                connected
                    ? "STREAMER_CONNECTED"
                    : "STREAMER_DISCONNECTED",

            streamerId
        });
    } catch (error) {
        console.error(
            "Streamer connection update error:",
            error
        );
    }
}

async function addControllerConnection(
    streamerId
) {
    const key =
        String(streamerId);

    const count =
        controllerConnections.get(
            key
        ) || 0;

    controllerConnections.set(
        key,
        count + 1
    );

    if (count === 0) {
        await setStreamerConnected(
            streamerId,
            true
        );
    }
}

async function removeControllerConnection(
    streamerId
) {
    const key =
        String(streamerId);

    const count =
        controllerConnections.get(
            key
        ) || 0;

    if (count <= 1) {
        controllerConnections.delete(
            key
        );

        await setStreamerConnected(
            streamerId,
            false
        );

        return;
    }

    controllerConnections.set(
        key,
        count - 1
    );
}

/* ============================================================
   WEBSOCKET
============================================================ */

server.on(
    "upgrade",
    (request, socket, head) => {
        const origin =
            request.headers.origin;

        /*
         * Allow the configured frontend.
         *
         * Some OBS/browser overlay environments
         * may omit Origin, so only reject when
         * an Origin is actually supplied.
         */

        if (
            origin &&
            origin !== FRONTEND_ORIGIN
        ) {
            socket.write(
                "HTTP/1.1 403 Forbidden\r\n\r\n"
            );

            socket.destroy();

            return;
        }

        const pathname =
            new URL(
                request.url,
                `http://${request.headers.host}`
            ).pathname;

        if (
            pathname !== "/ws"
        ) {
            socket.write(
                "HTTP/1.1 404 Not Found\r\n\r\n"
            );

            socket.destroy();

            return;
        }

        wss.handleUpgrade(
            request,
            socket,
            head,
            (ws) => {
                wss.emit(
                    "connection",
                    ws,
                    request
                );
            }
        );
    }
);

wss.on(
    "connection",
    (socket) => {
        socket.isAlive=true; socket.on("pong", heartbeat);
        socket.authenticated =
            false;

        socket.connectionRole =
            null;

        socket.user =
            null;

        socket.streamerId =
            null;

        socket.controllerRegistered =
            false;

        /*
         * Public pages are allowed to connect.
         *
         * They can request STATE but cannot
         * control dares.
         */

        try {
            socket.send(
                JSON.stringify({
                    type:
                        "CONNECTED"
                })
            );
        } catch (_) {}

        socket.on(
            "message",
            async (raw) => {
                let message;

                try {
                    message =
                        JSON.parse(
                            raw.toString()
                        );
                } catch (_) {
                    try {
                        socket.send(
                            JSON.stringify({
                                type:
                                    "ERROR",

                                error:
                                    "Invalid JSON."
                            })
                        );
                    } catch (_) {}

                    return;
                }

                if (
                    !message ||
                    typeof message.type !==
                        "string"
                ) {
                    return;
                }

                /*
                 * ==========================================
                 * AUTH
                 * ==========================================
                 */

                if (
                    message.type ===
                    "AUTH"
                ) {
                    if (
                        socket.authenticated
                    ) {
                        return;
                    }

                    const token =
                        typeof message.token ===
                            "string"
                            ? message.token.trim()
                            : "";

                    if (!token) {
                        try {
                            socket.send(
                                JSON.stringify({
                                    type:
                                        "AUTH_ERROR",

                                    error:
                                        "Authentication token required."
                                })
                            );
                        } catch (_) {}

                        return;
                    }

                    try {
                        const user =
                            await getUserFromToken(
                                token
                            );

                        if (!user) {
                            try {
                                socket.send(
                                    JSON.stringify({
                                        type:
                                            "AUTH_FAILED",

                                        error:
                                            "Invalid or expired session."
                                    })
                                );
                            } catch (_) {}

                            return;
                        }

                        const streamer =
                            await getStreamerForUser(
                                user.id
                            );

                        if (!streamer) {
                            try {
                                socket.send(
                                    JSON.stringify({
                                        type:
                                            "AUTH_ERROR",

                                        error:
                                            "No streamer profile exists for this account."
                                    })
                                );
                            } catch (_) {}

                            return;
                        }

                        /*
                         * Only controller role is supported
                         * by the current frontend.
                         */

                        const role =
                            message.role ||
                            "controller";

                        if (
                            role !==
                            "controller"
                        ) {
                            try {
                                socket.send(
                                    JSON.stringify({
                                        type:
                                            "AUTH_ERROR",

                                        error:
                                            "Unsupported WebSocket role."
                                    })
                                );
                            } catch (_) {}

                            return;
                        }

                        socket.authenticated =
                            true;

                        socket.connectionRole =
                            "controller";

                        socket.user =
                            user;

                        socket.streamerId =
                            streamer.id;

                        socket.controllerRegistered =
                            true;

                        await addControllerConnection(
                            streamer.id
                        );

                        try {
                            socket.send(
                                JSON.stringify({
                                    type:
                                        "AUTH_OK",

                                    user:
                                        publicUser(
                                            user
                                        ),

                                    streamer:
                                        publicStreamer(
                                            streamer
                                        )
                                })
                            );
                        } catch (_) {}

                        await sendState(
                            socket
                        );

                        return;
                    } catch (error) {
                        console.error(
                            "WebSocket AUTH error:",
                            error
                        );

                        try {
                            socket.send(
                                JSON.stringify({
                                    type:
                                        "AUTH_ERROR",

                                    error:
                                        "Authentication service error."
                                })
                            );
                        } catch (_) {}

                        return;
                    }
                }

                /*
                 * ==========================================
                 * GET STATE
                 * ==========================================
                 *
                 * Public.
                 *
                 * Needed by:
                 * - index.html
                 * - overlay.html
                 *
                 * Controller can also use it after AUTH_OK.
                 */

                if (
                    message.type ===
                    "GET_STATE"
                ) {
                    await sendState(
                        socket
                    );

                    return;
                }

                /*
                 * ==========================================
                 * GET ACTIVE DARES
                 * ==========================================
                 *
                 * Public.
                 *
                 * index.html currently sends this
                 * immediately after WebSocket connection.
                 */

                if (
                    message.type ===
                    "GET_ACTIVE_DARES"
                ) {
                    try {
                        const state =
                            await getAllDareState();

                        socket.send(
                            JSON.stringify({
                                type:
                                    "ACTIVE_DARE_STATE",

                                activeDares:
                                    state.activeDares
                            })
                        );
                    } catch (error) {
                        console.error(
                            "GET_ACTIVE_DARES error:",
                            error
                        );
                    }

                    return;
                }

                /*
                 * ==========================================
                 * CONTROLLER-ONLY ACTIONS
                 * ==========================================
                 */

                if (
                    message.type ===
                        "CONTROLLER_ACTION" ||
                    message.type ===
                        "UPDATE_DARE"
                ) {
                    if (
                        !socket.authenticated
                    ) {
                        try {
                            socket.send(
                                JSON.stringify({
                                    type:
                                        "AUTH_REQUIRED",

                                    error:
                                        "Controller authentication required."
                                })
                            );
                        } catch (_) {}

                        return;
                    }

                    /*
                     * The current controller frontend
                     * performs dare mutations through
                     * REST, so there is no direct WS
                     * mutation endpoint here.
                     */

                    try {
                        socket.send(
                            JSON.stringify({
                                type:
                                    "ERROR",

                                error:
                                    "Use the REST API for controller actions."
                            })
                        );
                    } catch (_) {}

                    return;
                }

                /*
                 * Unknown messages are harmless.
                 */

                if (
                    message.type !==
                        "PING"
                ) {
                    try {
                        socket.send(
                            JSON.stringify({
                                type:
                                    "ERROR",

                                error:
                                    "Unknown WebSocket message."
                            })
                        );
                    } catch (_) {}
                } else {
                    try {
                        socket.send(
                            JSON.stringify({
                                type:
                                    "PONG"
                            })
                        );
                    } catch (_) {}
                }
            }
        );

        socket.on(
            "close",
            async () => {
                if (
                    socket.controllerRegistered &&
                    socket.streamerId
                ) {
                    socket.controllerRegistered =
                        false;

                    await removeControllerConnection(
                        socket.streamerId
                    );
                }
            }
        );

        socket.on(
            "error",
            (error) => {
                console.warn(
                    "WebSocket error:",
                    error.message
                );
            }
        );
    }
);

/* ============================================================
   CREATE DARE
============================================================ */

app.post(
    "/api/dare",
    async (req, res) => {
        const body =
            req.body || {};

        /*
         * Current submit.html sends:
         *
         * streamer
         * streamer_source
         * viewer
         * dare_text
         * duration
         * reward
         *
         * It does not currently send streamerId,
         * so support both ID and legacy username.
         */

        let streamer = null;

        if (
            body.streamerId !==
                undefined &&
            body.streamerId !==
                null &&
            body.streamerId !== ""
        ) {
            streamer =
                await getStreamerById(
                    body.streamerId
                );
        }

        if (!streamer) {
            streamer =
                await getStreamerByUsername(
                    body.streamer
                );
        }

        if (!streamer) {
            // AUTO-CREATE: allow dares to any valid username even if streamer never registered
            const candidate = normalizeUsername(body.streamer);
            if (candidate && isValidUsername(candidate)) {
                try {
                    const created = await pool.query(`
                        INSERT INTO streamers (username, display_name, source, connected)
                        VALUES ($1, $2, 'auto', FALSE)
                        ON CONFLICT ON CONSTRAINT streamers_username_lower_unique DO UPDATE SET updated_at=NOW()
                        RETURNING *
                    `, [candidate, cleanDisplayUsername(body.streamer)]);
                    streamer = created.rows[0];
                } catch (e) {
                    console.warn("Auto-create streamer failed:", e.message);
                    return sendError(res, 404, "Streamer not found.", "STREAMER_NOT_FOUND");
                }
            } else {
                return sendError(res, 404, "Streamer not found.", "STREAMER_NOT_FOUND");
            }
        }

        const viewer =
            cleanText(
                body.viewer ||
                    "Anonymous",
                100
            );

        const dareText =
            sanitizeDareText(
                body.dare_text ??
                    body.dareText ??
                    body.text
            );
        if (containsBlocked(dareText)) {
            return sendError(res, 400, "Dare contains blocked language.", "BLOCKED_CONTENT");
        }

        const duration =
            parsePositiveInteger(
                body.duration
            );

        const reward =
            parseReward(
                body.reward
            );

        if (!viewer) {
            return sendError(
                res,
                400,
                "Viewer name is required.",
                "VIEWER_REQUIRED"
            );
        }

        if (!dareText) {
            return sendError(
                res,
                400,
                "Dare text is required.",
                "DARE_REQUIRED"
            );
        }

        if (
            !duration ||
            duration <
                MIN_DARE_DURATION ||
            duration >
                MAX_DARE_DURATION
        ) {
            return sendError(
                res,
                400,
                `Time limit must be between ${MIN_DARE_DURATION} and ${MAX_DARE_DURATION} seconds.`,
                "INVALID_DURATION"
            );
        }

        if (
            reward === null
        ) {
            return sendError(
                res,
                400,
                `Reward must be between â‚±0 and â‚±${MAX_REWARD.toLocaleString()}.`,
                "INVALID_REWARD"
            );
        }

        const client =
            await pool.connect();

        try {
            await client.query(
                "BEGIN"
            );

            /*
             * Serialize dare creation/status changes
             * for this streamer.
             */

            await client.query(
                `
                SELECT pg_advisory_xact_lock($1)
                `,
                [
                    Number(
                        streamer.id
                    )
                ]
            );

            const activeResult =
                await client.query(
                    `
                    SELECT id
                    FROM dares
                    WHERE
                        streamer_id = $1
                        AND status = 'accepted'
                    LIMIT 1
                    `,
                    [streamer.id]
                );

            const pendingCountRes = await client.query(
                "SELECT COUNT(*)::int AS c FROM dares WHERE streamer_id=$1 AND status='pending'",
                [streamer.id]
            );
            if (pendingCountRes.rows[0].c >= MAX_QUEUE_PER_STREAMER) {
                await client.query("ROLLBACK");
                return sendError(res, 429, "This streamer's queue is full. Try again later.", "QUEUE_FULL");
            }
            const status =
                activeResult.rows
                    .length === 0
                    ? "accepted"
                    : "pending";

            const inserted =
                await client.query(
                    `
                    INSERT INTO dares (
                        streamer,
                        streamer_source,
                        streamer_id,
                        viewer,
                        dare_text,
                        duration,
                        reward,
                        status,
                        accepted_at
                    )
                    VALUES (
                        $1,
                        'nerve_account',
                        $2,
                        $3,
                        $4,
                        $5,
                        $6,
                        $7,
                        $8
                    )
                    RETURNING *
                    `,
                    [
                        streamer.username,
                        streamer.id,
                        viewer,
                        dareText,
                        duration,
                        reward,
                        status === "accepted" ? new Date() : null
                    ]
                );

            const dare =
                formatDare({
                    ...inserted.rows[0],

                    streamer_username:
                        streamer.username,

                    streamer_display_name:
                        streamer.display_name,

                    platform:
                        streamer.platform,

                    platform_username:
                        streamer.platform_username
                });

            await client.query(
                "COMMIT"
            );

            /*
             * Notify every connected frontend.
             */

            broadcast({
                type:
                    "DARE_CREATED",

                dare
            });

            if (
                status ===
                "accepted"
            ) {
                broadcast({
                    type:
                        "ACTIVE_DARE",

                    dare
                });
            }

            const queueResult =
                await pool.query(
                    `
                    SELECT
                        d.*,

                        s.username
                            AS streamer_username,

                        s.display_name
                            AS streamer_display_name,

                        s.platform,

                        s.platform_username

                    FROM dares d

                    LEFT JOIN streamers s
                        ON s.id =
                            d.streamer_id

                    WHERE
                        d.streamer_id = $1
                        AND d.status = 'pending'

                    ORDER BY
                        d.created_at ASC,
                        d.id ASC
                    `,
                    [streamer.id]
                );

            const queue =
                queueResult.rows.map(
                    (row) =>
                        formatDare({
                            ...row,

                            streamer:
                                row.streamer_username ||
                                row.streamer,

                            streamer_display_name:
                                row.streamer_display_name
                        })
                );

            broadcast({
                type:
                    "QUEUE_UPDATED",

                streamerId:
                    streamer.id,

                streamer_id:
                    streamer.id,

                queue
            });

            return res.status(201).json({
                success: true,

                dare,

                /*
                 * Current submit.html checks
                 * this exact property.
                 */

                activeDare:
                    status ===
                    "accepted"
                        ? dare
                        : null,

                queuePosition:
                    status ===
                    "pending"
                        ? queue.findIndex(
                            (item) =>
                                String(
                                    item.id
                                ) ===
                                String(
                                    dare.id
                                )
                        ) + 1
                        : 0
            });
        } catch (error) {
            try {
                await client.query(
                    "ROLLBACK"
                );
            } catch (_) {}

            console.error(
                "Create dare error:",
                error
            );

            return sendError(
                res,
                500,
                "Unable to submit the dare."
            );
        } finally {
            client.release();
        }
    }
);

/* ============================================================
   GET ALL DARES
============================================================ */

app.get(
    "/api/dare",
    async (req, res) => {
        try {
            const state =
                await getAllDareState();

            return res.json({
                success: true,

                active:
                    state.active,

                activeDares:
                    state.activeDares,

                queues:
                    state.queues,

                data: state
            });
        } catch (error) {
            console.error(
                "Get dare state error:",
                error
            );

            return sendError(
                res,
                500,
                "Unable to load dare state."
            );
        }
    }
);

/* ============================================================
   GET QUEUE
============================================================ */

app.get(
    "/api/dare/queue/:streamer",
    async (req, res) => {
        try {
            const value =
                req.params.streamer;

            const streamer =
                /^\d+$/.test(value)
                    ? await getStreamerById(
                        value
                    )
                    : await getStreamerByUsername(
                        value
                    );

            if (!streamer) {
                return sendError(
                    res,
                    404,
                    "Streamer not found."
                );
            }

            const result =
                await pool.query(
                    `
                    SELECT
                        d.*,

                        s.username
                            AS streamer_username,

                        s.display_name
                            AS streamer_display_name,

                        s.platform,

                        s.platform_username

                    FROM dares d

                    LEFT JOIN streamers s
                        ON s.id =
                            d.streamer_id

                    WHERE
                        d.streamer_id = $1
                        AND d.status = 'pending'

                    ORDER BY
                        d.created_at ASC,
                        d.id ASC
                    `,
                    [streamer.id]
                );

            const queue =
                result.rows.map(
                    (row) =>
                        formatDare({
                            ...row,

                            streamer:
                                row.streamer_username ||
                                row.streamer,

                            streamer_display_name:
                                row.streamer_display_name
                        })
                );

            return res.json({
                success: true,

                streamer:
                    publicStreamer(
                        streamer
                    ),

                queue
            });
        } catch (error) {
            console.error(
                "Queue error:",
                error
            );

            return sendError(
                res,
                500,
                "Unable to load dare queue."
            );
        }
    }
);

/* ============================================================
   GET ACTIVE DARE
============================================================ */

app.get(
    "/api/dare/active/:streamer",
    async (req, res) => {
        try {
            const value =
                req.params.streamer;

            const streamer =
                /^\d+$/.test(value)
                    ? await getStreamerById(
                        value
                    )
                    : await getStreamerByUsername(
                        value
                    );

            if (!streamer) {
                return sendError(
                    res,
                    404,
                    "Streamer not found."
                );
            }

            const result =
                await pool.query(
                    `
                    SELECT
                        d.*,

                        s.username
                            AS streamer_username,

                        s.display_name
                            AS streamer_display_name,

                        s.platform,

                        s.platform_username

                    FROM dares d

                    LEFT JOIN streamers s
                        ON s.id =
                            d.streamer_id

                    WHERE
                        d.streamer_id = $1
                        AND d.status = 'accepted'

                    ORDER BY
                        d.accepted_at ASC NULLS LAST,
                        d.id ASC

                    LIMIT 1
                    `,
                    [streamer.id]
                );

            const dare =
                result.rows.length
                    ? formatDare({
                        ...result.rows[0],

                        streamer:
                            result.rows[0]
                                .streamer_username ||
                            result.rows[0]
                                .streamer,

                        streamer_display_name:
                            result.rows[0]
                                .streamer_display_name
                    })
                    : null;

            return res.json({
                success: true,

                activeDare:
                    dare
            });
        } catch (error) {
            console.error(
                "Active dare error:",
                error
            );

            return sendError(
                res,
                500,
                "Unable to load active dare."
            );
        }
    }
);

/* ============================================================
   ACTIVATE NEXT DARE
============================================================ */

async function activateNextDare(
    streamerId
) {
    const client =
        await pool.connect();

    try {
        await client.query(
            "BEGIN"
        );

        await client.query(
            `
            SELECT pg_advisory_xact_lock($1)
            `,
            [
                Number(
                    streamerId
                )
            ]
        );

        const active =
            await client.query(
                `
                SELECT id
                FROM dares
                WHERE
                    streamer_id = $1
                    AND status = 'accepted'
                LIMIT 1
                `,
                [streamerId]
            );

        if (
            active.rows.length
        ) {
            await client.query(
                "COMMIT"
            );

            return null;
        }

        const next =
            await client.query(
                `
                SELECT
                    d.*,

                    s.username
                        AS streamer_username,

                    s.display_name
                        AS streamer_display_name,

                    s.platform,

                    s.platform_username

                FROM dares d

                LEFT JOIN streamers s
                    ON s.id =
                        d.streamer_id

                WHERE
                    d.streamer_id = $1
                    AND d.status = 'pending'

                ORDER BY
                    d.created_at ASC,
                    d.id ASC

                LIMIT 1

                FOR UPDATE OF d SKIP LOCKED
                `,
                [streamerId]
            );

        if (
            next.rows.length === 0
        ) {
            await client.query(
                "COMMIT"
            );

            return null;
        }

        const row =
            next.rows[0];

        const updated =
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
                [row.id]
            );

        const dare =
            formatDare({
                ...updated.rows[0],

                streamer:
                    row.streamer_username ||
                    row.streamer,

                streamer_display_name:
                    row.streamer_display_name,

                platform:
                    row.platform,

                platform_username:
                    row.platform_username
            });

        await client.query(
            "COMMIT"
        );

        broadcast({
            type:
                "ACTIVE_DARE",

            dare
        });

        const queueResult =
            await pool.query(
                `
                SELECT
                    d.*,

                    s.username
                        AS streamer_username,

                    s.display_name
                        AS streamer_display_name,

                    s.platform,

                    s.platform_username

                FROM dares d

                LEFT JOIN streamers s
                    ON s.id =
                        d.streamer_id

                WHERE
                    d.streamer_id = $1
                    AND d.status = 'pending'

                ORDER BY
                    d.created_at ASC,
                    d.id ASC
                `,
                [streamerId]
            );

        const queue =
            queueResult.rows.map(
                (queueRow) =>
                    formatDare({
                        ...queueRow,

                        streamer:
                            queueRow.streamer_username ||
                            queueRow.streamer,

                        streamer_display_name:
                            queueRow.streamer_display_name
                    })
            );

        broadcast({
            type:
                "QUEUE_UPDATED",

            streamerId:
                streamerId,

            streamer_id:
                streamerId,

            queue
        });

        return dare;
    } catch (error) {
        try {
            await client.query(
                "ROLLBACK"
            );
        } catch (_) {}

        console.error(
            "Activate next dare error:",
            error
        );

        return null;
    } finally {
        client.release();
    }
}

/* ============================================================
   DARE STATUS
============================================================ */

app.post(
    "/api/dare/:id/status",
    requireAuth,
    async (req, res) => {
        const dareId =
            Number(
                req.params.id
            );

        const status =
            String(
                req.body?.status ||
                    ""
            )
                .trim()
                .toLowerCase();

        const validStatuses = [
            "accepted",
            "rejected",
            "completed",
            "failed"
        ];

        if (
            !Number.isInteger(
                dareId
            ) ||
            dareId < 1
        ) {
            return sendError(
                res,
                400,
                "Invalid dare ID.",
                "INVALID_DARE_ID"
            );
        }

        if (
            !validStatuses.includes(
                status
            )
        ) {
            return sendError(
                res,
                400,
                "Invalid dare status.",
                "INVALID_STATUS"
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
                    SELECT
                        d.*,

                        s.owner_user_id,
                        s.username
                            AS streamer_username,

                        s.display_name
                            AS streamer_display_name,

                        s.platform,

                        s.platform_username

                    FROM dares d

                    JOIN streamers s
                        ON s.id =
                            d.streamer_id

                    WHERE d.id = $1

                    FOR UPDATE OF d
                    `,
                    [dareId]
                );

            if (
                dareResult.rows.length ===
                0
            ) {
                await client.query(
                    "ROLLBACK"
                );

                return sendError(
                    res,
                    404,
                    "Dare not found.",
                    "DARE_NOT_FOUND"
                );
            }

            const row =
                dareResult.rows[0];

            const isOwner =
                Number(
                    row.owner_user_id
                ) ===
                Number(
                    req.user.id
                );

            const isAdmin =
                req.user.role ===
                "admin";

            if (
                !isOwner &&
                !isAdmin
            ) {
                await client.query(
                    "ROLLBACK"
                );

                return sendError(
                    res,
                    403,
                    "You do not control this streamer.",
                    "FORBIDDEN"
                );
            }

            await client.query(
                `
                SELECT pg_advisory_xact_lock($1)
                `,
                [
                    Number(
                        row.streamer_id
                    )
                ]
            );

            /*
             * ACCEPT
             */

            if (
                status ===
                "accepted"
            ) {
                if (
                    row.status !==
                    "pending"
                ) {
                    await client.query(
                        "ROLLBACK"
                    );

                    return sendError(
                        res,
                        409,
                        "Only pending dares can be accepted.",
                        "INVALID_TRANSITION"
                    );
                }

                const active =
                    await client.query(
                        `
                        SELECT id
                        FROM dares
                        WHERE
                            streamer_id = $1
                            AND status = 'accepted'
                        LIMIT 1
                        `,
                        [
                            row.streamer_id
                        ]
                    );

                if (
                    active.rows.length
                ) {
                    await client.query(
                        "ROLLBACK"
                    );

                    return sendError(
                        res,
                        409,
                        "This streamer already has an active dare.",
                        "ACTIVE_DARE_EXISTS"
                    );
                }

                const updated =
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
                        [dareId]
                    );

                const dare =
                    formatDare({
                        ...updated.rows[0],

                        streamer:
                            row.streamer_username,

                        streamer_display_name:
                            row.streamer_display_name,

                        platform:
                            row.platform,

                        platform_username:
                            row.platform_username
                    });

                await client.query(
                    "COMMIT"
                );

                broadcast({
                    type:
                        "ACTIVE_DARE",

                    dare
                });

                await broadcastQueue(
                    row.streamer_id
                );

                return res.json({
                    success: true,

                    dare
                });
            }

            /*
             * REJECT
             */

            if (
                status ===
                "rejected"
            ) {
                if (
                    row.status !==
                    "pending"
                ) {
                    await client.query(
                        "ROLLBACK"
                    );

                    return sendError(
                        res,
                        409,
                        "Only pending dares can be rejected.",
                        "INVALID_TRANSITION"
                    );
                }

                const updated =
                    await client.query(
                        `
                        UPDATE dares
                        SET
                            status = 'rejected',
                            updated_at = NOW()
                        WHERE id = $1
                        RETURNING *
                        `,
                        [dareId]
                    );

                const dare =
                    formatDare({
                        ...updated.rows[0],

                        streamer:
                            row.streamer_username,

                        streamer_display_name:
                            row.streamer_display_name,

                        platform:
                            row.platform,

                        platform_username:
                            row.platform_username
                    });

                await client.query(
                    "COMMIT"
                );

                broadcast({
                    type:
                        "DARE_REJECTED",

                    dare
                });

                await broadcastQueue(
                    row.streamer_id
                );

                return res.json({
                    success: true,

                    dare
                });
            }

            /*
             * COMPLETE / FAIL
             */

            if (
                status ===
                    "completed" ||
                status ===
                    "failed"
            ) {
                if (
                    row.status !==
                    "accepted"
                ) {
                    await client.query(
                        "ROLLBACK"
                    );

                    return sendError(
                        res,
                        409,
                        "Only active dares can be completed or failed.",
                        "INVALID_TRANSITION"
                    );
                }

                const updated =
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
                            dareId
                        ]
                    );

                const dare =
                    formatDare({
                        ...updated.rows[0],

                        streamer:
                            row.streamer_username,

                        streamer_display_name:
                            row.streamer_display_name,

                        platform:
                            row.platform,

                        platform_username:
                            row.platform_username
                    });

                await client.query(
                    "COMMIT"
                );

                broadcast({
                    type:
                        status ===
                        "completed"
                            ? "DARE_COMPLETED"
                            : "DARE_FAILED",

                    dare
                });

                broadcast({
                    type:
                        "ACTIVE_DARE_CLEARED",

                    streamerId:
                        row.streamer_id,

                    streamer_id:
                        row.streamer_id,

                    streamer:
                        row.streamer_username,

                    dare
                });

                /*
                 * Automatically promote the next
                 * waiting dare.
                 */

                await activateNextDare(
                    row.streamer_id
                );

                return res.json({
                    success: true,

                    dare
                });
            }

            await client.query(
                "ROLLBACK"
            );

            return sendError(
                res,
                400,
                "Unsupported status."
            );
        } catch (error) {
            try {
                await client.query(
                    "ROLLBACK"
                );
            } catch (_) {}

            console.error(
                "Dare status error:",
                error
            );

            /*
             * Unique active-dare constraint.
             */

            if (
                error.code ===
                "23505"
            ) {
                return sendError(
                    res,
                    409,
                    "This streamer already has an active dare.",
                    "ACTIVE_DARE_EXISTS"
                );
            }

            return sendError(
                res,
                500,
                "Unable to update dare status."
            );
        } finally {
            client.release();
        }
    }
);

/* ============================================================
   BROADCAST QUEUE
============================================================ */

async function broadcastQueue(
    streamerId
) {
    try {
        const result =
            await pool.query(
                `
                SELECT
                    d.*,

                    s.username
                        AS streamer_username,

                    s.display_name
                        AS streamer_display_name,

                    s.platform,

                    s.platform_username

                FROM dares d

                LEFT JOIN streamers s
                    ON s.id =
                        d.streamer_id

                WHERE
                    d.streamer_id = $1
                    AND d.status = 'pending'

                ORDER BY
                    d.created_at ASC,
                    d.id ASC
                `,
                [streamerId]
            );

        const queue =
            result.rows.map(
                (row) =>
                    formatDare({
                        ...row,

                        streamer:
                            row.streamer_username ||
                            row.streamer,

                        streamer_display_name:
                            row.streamer_display_name
                    })
            );

        broadcast({
            type:
                "QUEUE_UPDATED",

            streamerId,

            streamer_id:
                streamerId,

            queue
        });
    } catch (error) {
        console.error(
            "Broadcast queue error:",
            error
        );
    }
}

/* ============================================================
   DARE HISTORY
============================================================ */

app.get(
    "/api/dare/history",
    requireAuth,
    async (req, res) => {
        try {
            const result =
                await pool.query(
                    `
                    SELECT
                        d.*,

                        s.username
                            AS streamer_username,

                        s.display_name
                            AS streamer_display_name,

                        s.platform,

                        s.platform_username

                    FROM dares d

                    JOIN streamers s
                        ON s.id =
                            d.streamer_id

                    WHERE
                        s.owner_user_id = $1

                    ORDER BY
                        d.created_at DESC,
                        d.id DESC

                    LIMIT 500
                    `,
                    [req.user.id]
                );

            const dares =
                result.rows.map(
                    (row) =>
                        formatDare({
                            ...row,

                            streamer:
                                row.streamer_username ||
                                row.streamer,

                            streamer_display_name:
                                row.streamer_display_name
                        })
                );

            return res.json({
                success: true,

                data: {
                    dares
                },

                dares
            });
        } catch (error) {
            console.error(
                "History error:",
                error
            );

            return sendError(
                res,
                500,
                "Unable to load dare history."
            );
        }
    }
);

/* ============================================================
   ADMIN RESET
============================================================ */

app.post(
    "/api/dare/clear",
    requireAuth,
    async (req, res) => {
        const isAdmin = req.user.role === "admin";
        try {
            if (isAdmin) {
            await pool.query(`
                DELETE FROM dares
                `);
            } else {
                const own = await getStreamerForUser(req.user.id);
                if (!own) return sendError(res, 404, "Streamer profile not found.", "STREAMER_NOT_FOUND");
                await pool.query(`DELETE FROM dares WHERE streamer_id=$1`, [own.id]);
                await broadcastQueue(own.id);
            }

            broadcast({
                type:
                    "RESET"
            });

            return res.json({
                success: true
            });
        } catch (error) {
            console.error(
                "Clear dares error:",
                error
            );

            return sendError(
                res,
                500,
                "Unable to clear dares."
            );
        }
    }
);

/* ============================================================
   404
============================================================ */

app.use(
    (req, res) => {
        return sendError(
            res,
            404,
            "Endpoint not found.",
            "NOT_FOUND"
        );
    }
);

/* ============================================================
   ERROR HANDLER
============================================================ */

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

        if (
            res.headersSent
        ) {
            return next(error);
        }

        return sendError(
            res,
            500,
            "Internal server error."
        );
    }
);

/* ============================================================
   START SERVER
============================================================ */

async function startServer() {
    try {
        await initializeDatabase();

        /*
         * Make sure no streamer is accidentally
         * left online after a Render restart.
         */

        await pool.query(`
            UPDATE streamers
            SET
                connected = FALSE,
                updated_at = NOW()
        `);

        server.listen(
            PORT,
            () => {
                console.log(
                    "========================================"
                );

                console.log(
                    "ðŸš€ Nerve DARE Backend"
                );

                console.log(
                    `ðŸŒ HTTP: listening on ${PORT}`
                );

                console.log(
                    `ðŸ”Œ WebSocket: /ws`
                );

                console.log(
                    `ðŸŽ¨ Frontend: ${FRONTEND_ORIGIN}`
                );

                console.log(
                    "ðŸ—„ï¸ PostgreSQL: connected"
                );

                console.log(
                    "========================================"
                );
            }
        );
    } catch (error) {
        console.error(
            "âŒ Server startup failed:",
            error
        );

        process.exit(1);
    }
}

/* ============================================================
   GRACEFUL SHUTDOWN
============================================================ */

async function shutdown(
    signal
) {
    console.log(
        `${signal} received. Shutting down...`
    );

    try {
        await pool.query(`
            UPDATE streamers
            SET
                connected = FALSE,
                updated_at = NOW()
        `);
    } catch (error) {
        console.warn(
            "Could not reset streamer status:",
            error.message
        );
    }

    /*
     * Close WebSocket clients first.
     */

    for (
        const socket of wss.clients
    ) {
        try {
            socket.close(
                1001,
                "Server shutting down"
            );
        } catch (_) {}
    }

    wss.close(
        () => {}
    );

    server.close(
        async () => {
            try {
                await pool.end();
            } catch (_) {}

            console.log(
                "Server stopped."
            );

            process.exit(0);
        }
    );

    setTimeout(
        () => {
            process.exit(1);
        },
        10000
    ).unref();
}

process.on(
    "SIGTERM",
    () => shutdown("SIGTERM")
);

process.on(
    "SIGINT",
    () => shutdown("SIGINT")
);

process.on(
    "uncaughtException",
    (error) => {
        console.error(
            "UNCAUGHT EXCEPTION:",
            error
        );
    }
);

process.on(
    "unhandledRejection",
    (error) => {
        console.error(
            "UNHANDLED REJECTION:",
            error
        );
    }
);

startServer();


