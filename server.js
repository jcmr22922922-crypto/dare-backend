const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error("❌ DATABASE_URL is missing.");
    process.exit(1);
}

/* =========================================================
   CONFIG
========================================================= */

const FRONTEND_ORIGIN = (
    process.env.FRONTEND_ORIGIN ||
    "https://jcmr22922922-crypto.github.io"
).replace(/\/+$/, "");

const SESSION_DAYS_RAW =
    Number(process.env.SESSION_DAYS || 30);

const SESSION_DAYS =
    Number.isFinite(SESSION_DAYS_RAW) &&
    SESSION_DAYS_RAW > 0
        ? SESSION_DAYS_RAW
        : 30;

const SESSION_TTL_MS =
    SESSION_DAYS *
    24 *
    60 *
    60 *
    1000;

/*
 * IMPORTANT:
 * Twitch is NOT the identity of a streamer anymore.
 *
 * A Nerve account owns a streamer profile.
 * Streaming platform information is optional metadata.
 */

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

pool.on("error", error => {
    console.error(
        "Unexpected PostgreSQL pool error:",
        error
    );
});

/* =========================================================
   MIDDLEWARE
========================================================= */

app.disable("x-powered-by");

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

/* =========================================================
   GENERAL HELPERS
========================================================= */

function normalizeUsername(value) {
    return String(value || "")
        .trim()
        .replace(/^@/, "")
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
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidUsername(username) {
    return /^[A-Za-z0-9_]{3,50}$/.test(username);
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
        .slice(0, maxLength);
}

function parsePositiveInteger(value) {
    const number = Number(value);

    if (
        !Number.isInteger(number) ||
        number < 0
    ) {
        return null;
    }

    return number;
}

function parseReward(value) {
    const number = Number(value);

    if (
        !Number.isFinite(number) ||
        number < 0
    ) {
        return null;
    }

    return Math.round(number * 100) / 100;
}

function sendError(
    res,
    status,
    code,
    message
) {
    return res.status(status).json({
        error: {
            code,
            message
        }
    });
}

function normalizePlatform(value) {
    const platform =
        String(value || "")
            .trim()
            .toLowerCase();

    if (!platform) {
        return null;
    }

    const allowed = [
        "twitch",
        "youtube",
        "kick",
        "other"
    ];

    return allowed.includes(platform)
        ? platform
        : null;
}

/* =========================================================
   PASSWORD HASHING
========================================================= */

const SCRYPT_KEY_LENGTH = 64;

function hashPassword(password) {
    return new Promise(
        (resolve, reject) => {

            const salt =
                crypto.randomBytes(16);

            crypto.scrypt(
                password,
                salt,
                SCRYPT_KEY_LENGTH,
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

                const expected =
                    Buffer.from(
                        parts[2],
                        "hex"
                    );

                crypto.scrypt(
                    password,
                    salt,
                    expected.length,
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

                        if (
                            derivedKey.length !==
                            expected.length
                        ) {
                            resolve(false);
                            return;
                        }

                        resolve(
                            crypto.timingSafeEqual(
                                derivedKey,
                                expected
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

/* =========================================================
   SESSION HELPERS
========================================================= */

function generateSessionToken() {
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

function parseCookies(req) {
    const header =
        req.headers.cookie;

    if (!header) {
        return {};
    }

    const cookies = {};

    header
        .split(";")
        .forEach(part => {

            const index =
                part.indexOf("=");

            if (index === -1) {
                return;
            }

            const name =
                part
                    .slice(0, index)
                    .trim();

            const value =
                part
                    .slice(index + 1)
                    .trim();

            if (!name) {
                return;
            }

            try {
                cookies[name] =
                    decodeURIComponent(
                        value
                    );
            } catch (_) {
                cookies[name] = value;
            }
        });

    return cookies;
}

/* =========================================================
   COOKIE
========================================================= */

function appendCookie(
    res,
    name,
    value,
    options = {}
) {
    const parts = [
        `${name}=${encodeURIComponent(value)}`
    ];

    parts.push(
        `Path=${options.path || "/"}`
    );

    if (
        options.maxAge !== undefined
    ) {
        parts.push(
            `Max-Age=${Math.floor(
                options.maxAge
            )}`
        );
    }

    if (
        options.httpOnly !== false
    ) {
        parts.push("HttpOnly");
    }

    if (
        options.secure !== false
    ) {
        parts.push("Secure");
    }

    if (
        options.sameSite
    ) {
        parts.push(
            `SameSite=${options.sameSite}`
        );
    }

    if (
        options.partitioned
    ) {
        parts.push("Partitioned");
    }

    const existing =
        res.getHeader("Set-Cookie");

    const cookie =
        parts.join("; ");

    if (!existing) {
        res.setHeader(
            "Set-Cookie",
            [cookie]
        );
    } else {
        res.setHeader(
            "Set-Cookie",
            [
                ...existing,
                cookie
            ]
        );
    }
}

function setSessionCookie(
    res,
    token
) {
    appendCookie(
        res,
        "dare_session",
        token,
        {
            maxAge:
                SESSION_TTL_MS / 1000,
            httpOnly: true,
            secure: true,
            sameSite: "None",
            partitioned: true,
            path: "/"
        }
    );
}

function clearSessionCookie(res) {
    appendCookie(
        res,
        "dare_session",
        "",
        {
            maxAge: 0,
            httpOnly: true,
            secure: true,
            sameSite: "None",
            partitioned: true,
            path: "/"
        }
    );
}

/* =========================================================
   AUTHENTICATION
========================================================= */

async function getUserFromToken(token) {

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
                s.user_id,
                s.expires_at,
                u.username,
                u.email,
                u.role
            FROM sessions s
            INNER JOIN users u
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

    const session =
        result.rows[0];

    await pool.query(
        `
        UPDATE sessions
        SET last_seen_at = NOW()
        WHERE id = $1
        `,
        [session.session_id]
    );

    return {
        id: session.user_id,
        username: session.username,
        email: session.email,
        role: session.role,
        sessionId: session.session_id
    };
}

async function authenticateRequest(
    req,
    res,
    next
) {
    try {

        const cookies =
            parseCookies(req);

        const authorization =
            req.headers.authorization || "";

        let token = null;
        let usedCookie = false;

        if (
            authorization.startsWith(
                "Bearer "
            )
        ) {

            token =
                authorization
                    .slice(7)
                    .trim();

        } else if (
            cookies.dare_session
        ) {

            token =
                cookies.dare_session;

            usedCookie = true;
        }

        if (!token) {
            req.user = null;
            next();
            return;
        }

        const user =
            await getUserFromToken(
                token
            );

        if (!user) {

            req.user = null;

            if (usedCookie) {
                clearSessionCookie(res);
            }

            next();
            return;
        }

        req.user = user;

        next();

    } catch (error) {

        console.error(
            "Authentication error:",
            error
        );

        next(error);
    }
}

function requireAuth(
    req,
    res,
    next
) {
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

/* =========================================================
   DATABASE INITIALIZATION / MIGRATION
========================================================= */

async function initializeDatabase() {

    const client =
        await pool.connect();

    try {

        await client.query("BEGIN");

        /* =========================
           USERS
        ========================= */

        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id BIGSERIAL PRIMARY KEY,

                username VARCHAR(50) NOT NULL,

                email VARCHAR(255) NOT NULL,

                password_hash TEXT NOT NULL,

                role VARCHAR(30) NOT NULL DEFAULT 'streamer',

                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

                CONSTRAINT users_username_length
                    CHECK (
                        char_length(username)
                        BETWEEN 3 AND 50
                    ),

                CONSTRAINT users_role_check
                    CHECK (
                        role IN (
                            'viewer',
                            'streamer',
                            'admin'
                        )
                    )
            );
        `);

        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS
            users_username_lower_unique
            ON users (
                LOWER(username)
            );
        `);

        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS
            users_email_lower_unique
            ON users (
                LOWER(email)
            );
        `);

        /* =========================
           SESSIONS
        ========================= */

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
            );
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS
            sessions_user_id_idx
            ON sessions(user_id);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS
            sessions_expires_at_idx
            ON sessions(expires_at);
        `);

        /* =========================
           STREAMERS
        ========================= */

        await client.query(`
            CREATE TABLE IF NOT EXISTS streamers (
                id BIGSERIAL PRIMARY KEY,

                owner_user_id BIGINT
                    REFERENCES users(id)
                    ON DELETE SET NULL,

                username VARCHAR(255) NOT NULL,

                display_name VARCHAR(255) NOT NULL,

                source VARCHAR(50)
                    NOT NULL DEFAULT 'nerve_account',

                platform VARCHAR(50),

                platform_username VARCHAR(255),

                connected BOOLEAN
                    NOT NULL DEFAULT FALSE,

                created_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW(),

                updated_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW()
            );
        `);

        await client.query(`
            ALTER TABLE streamers
            ADD COLUMN IF NOT EXISTS
            owner_user_id BIGINT
            REFERENCES users(id)
            ON DELETE SET NULL
        `);

        await client.query(`
            ALTER TABLE streamers
            ADD COLUMN IF NOT EXISTS
            platform VARCHAR(50)
        `);

        await client.query(`
            ALTER TABLE streamers
            ADD COLUMN IF NOT EXISTS
            platform_username VARCHAR(255)
        `);

        await client.query(`
            ALTER TABLE streamers
            ADD COLUMN IF NOT EXISTS
            connected BOOLEAN
            NOT NULL DEFAULT FALSE
        `);

        /*
         * Old streamer rows must NOT remain
         * permanently "connected".
         *
         * Connection now means an active
         * controller WebSocket session.
         */

        await client.query(`
            UPDATE streamers
            SET connected = FALSE
        `);

        /*
         * Existing owner foreign key.
         */

        await client.query(`
            DO $$
            BEGIN

                IF NOT EXISTS (
                    SELECT 1
                    FROM pg_constraint
                    WHERE conname =
                        'streamers_owner_user_fk'
                ) THEN

                    ALTER TABLE streamers
                    ADD CONSTRAINT
                        streamers_owner_user_fk
                    FOREIGN KEY (owner_user_id)
                    REFERENCES users(id)
                    ON DELETE SET NULL;

                END IF;

            END
            $$;
        `);

        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS
            streamers_username_lower_unique
            ON streamers (
                LOWER(username)
            );
        `);

        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS
            streamers_owner_user_unique
            ON streamers(owner_user_id)
            WHERE owner_user_id IS NOT NULL;
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS
            streamers_owner_idx
            ON streamers(owner_user_id);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS
            streamers_connected_idx
            ON streamers(connected);
        `);

        /* =========================
           DARES
        ========================= */

        await client.query(`
            CREATE TABLE IF NOT EXISTS dares (
                id SERIAL PRIMARY KEY,

                streamer VARCHAR(255) NOT NULL,

                streamer_source VARCHAR(50)
                    NOT NULL DEFAULT 'nerve_account',

                streamer_id BIGINT
                    REFERENCES streamers(id)
                    ON DELETE CASCADE,

                viewer VARCHAR(255)
                    NOT NULL DEFAULT 'Anonymous',

                dare_text TEXT NOT NULL,

                duration INTEGER NOT NULL,

                reward NUMERIC(12,2)
                    NOT NULL DEFAULT 0,

                status VARCHAR(30)
                    NOT NULL DEFAULT 'pending',

                created_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW(),

                accepted_at TIMESTAMPTZ,

                updated_at TIMESTAMPTZ
            );
        `);

        await client.query(`
            ALTER TABLE dares
            ADD COLUMN IF NOT EXISTS
            streamer_id BIGINT
            REFERENCES streamers(id)
            ON DELETE CASCADE
        `);

        /*
         * Backfill old dares using the old
         * streamer username relationship.
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

        await client.query(`
            CREATE INDEX IF NOT EXISTS
            dares_streamer_id_status_idx
            ON dares (
                streamer_id,
                status
            );
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS
            dares_created_at_idx
            ON dares(created_at);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS
            dares_legacy_streamer_status_idx
            ON dares (
                LOWER(streamer),
                status
            );
        `);

        /*
         * Give every existing user a Nerve
         * streamer profile if they don't have one.
         *
         * Existing streamer rows are preserved.
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

        /*
         * Mark old streamer records that have
         * owners as Nerve-account profiles.
         */

        await client.query(`
            UPDATE streamers
            SET
                source = 'nerve_account',
                updated_at = NOW()
            WHERE owner_user_id IS NOT NULL
        `);

        await client.query("COMMIT");

        console.log(
            "✅ Database initialized."
        );

        console.log(
            "✅ Nerve streamer migration checked."
        );

    } catch (error) {

        try {
            await client.query(
                "ROLLBACK"
            );
        } catch (_) {}

        throw error;

    } finally {

        client.release();
    }
}

/* =========================================================
   EXPIRED SESSION CLEANUP
========================================================= */

async function cleanExpiredSessions() {

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
}

setInterval(
    cleanExpiredSessions,
    60 * 60 * 1000
);

/* =========================================================
   STREAMER HELPERS
========================================================= */

async function getStreamerForUser(
    userId
) {

    const result =
        await pool.query(
            `
            SELECT
                id,
                owner_user_id,
                username,
                display_name,
                source,
                platform,
                platform_username,
                connected,
                created_at,
                updated_at
            FROM streamers
            WHERE owner_user_id = $1
            LIMIT 1
            `,
            [userId]
        );

    return result.rows[0] || null;
}

async function getStreamerById(
    streamerId
) {

    const id =
        parsePositiveInteger(
            streamerId
        );

    if (
        id === null ||
        id === 0
    ) {
        return null;
    }

    const result =
        await pool.query(
            `
            SELECT
                id,
                owner_user_id,
                username,
                display_name,
                source,
                platform,
                platform_username,
                connected,
                created_at,
                updated_at
            FROM streamers
            WHERE id = $1
            LIMIT 1
            `,
            [id]
        );

    return result.rows[0] || null;
}

async function getStreamerByLegacyUsername(
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
            SELECT
                id,
                owner_user_id,
                username,
                display_name,
                source,
                platform,
                platform_username,
                connected,
                created_at,
                updated_at
            FROM streamers
            WHERE LOWER(username) = LOWER($1)
            LIMIT 1
            `,
            [normalized]
        );

    return result.rows[0] || null;
}

function publicStreamer(
    streamer
) {

    return {
        id: Number(streamer.id),

        username:
            streamer.username,

        displayName:
            streamer.display_name,

        platform:
            streamer.platform || null,

        platformUsername:
            streamer.platform_username || null,

        connected:
            Boolean(
                streamer.connected
            )
    };
}

/* =========================================================
   ROOT / HEALTH
========================================================= */

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

            res.json({
                status: "online",
                service: "DARE Backend",
                identity: "Nerve Account",
                database: "connected",

                activeDares:
                    Number(
                        result.rows[0]
                            .active_count || 0
                    ),

                pendingDares:
                    Number(
                        result.rows[0]
                            .pending_count || 0
                    )
            });

        } catch (error) {

            console.error(
                "Root health error:",
                error
            );

            res.status(503).json({
                status: "degraded",
                service: "DARE Backend",
                database: "error"
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

            res.json({
                status: "ok",
                database: "ok"
            });

        } catch (error) {

            res.status(503).json({
                status: "error",
                database: "error"
            });
        }
    }
);

/* =========================================================
   AUTH — REGISTER
========================================================= */

app.post(
    "/api/auth/register",
    async (req, res) => {

        try {

            const username =
                cleanDisplayUsername(
                    req.body.username
                );

            const email =
                normalizeEmail(
                    req.body.email
                );

            const password =
                req.body.password;

            if (
                !isValidUsername(
                    username
                )
            ) {

                return sendError(
                    res,
                    400,
                    "INVALID_USERNAME",
                    "Username must be 3–50 characters and contain only letters, numbers, and underscores."
                );
            }

            if (
                !isValidEmail(
                    email
                )
            ) {

                return sendError(
                    res,
                    400,
                    "INVALID_EMAIL",
                    "Please enter a valid email address."
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
                    "INVALID_PASSWORD",
                    "Password must be between 8 and 128 characters."
                );
            }

            const existing =
                await pool.query(
                    `
                    SELECT
                        id,
                        username,
                        email
                    FROM users
                    WHERE
                        LOWER(username) =
                            LOWER($1)
                        OR
                        LOWER(email) =
                            LOWER($2)
                    LIMIT 1
                    `,
                    [
                        username,
                        email
                    ]
                );

            if (
                existing.rows.length
            ) {

                const row =
                    existing.rows[0];

                if (
                    row.username
                        .toLowerCase() ===
                    username.toLowerCase()
                ) {

                    return sendError(
                        res,
                        409,
                        "USERNAME_TAKEN",
                        "That username is already taken."
                    );
                }

                return sendError(
                    res,
                    409,
                    "EMAIL_TAKEN",
                    "That email is already registered."
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
                            role,
                            created_at
                        `,
                        [
                            username,
                            email,
                            passwordHash
                        ]
                    );

                user =
                    userResult.rows[0];

                /*
                 * Every Nerve account automatically
                 * gets its own streamer profile.
                 */

                const streamerResult =
                    await client.query(
                        `
                        INSERT INTO streamers (
                            owner_user_id,
                            username,
                            display_name,
                            source,
                            platform,
                            platform_username,
                            connected
                        )
                        VALUES (
                            $1,
                            $2,
                            $2,
                            'nerve_account',
                            NULL,
                            NULL,
                            FALSE
                        )
                        RETURNING
                            id,
                            username,
                            display_name,
                            source,
                            platform,
                            platform_username,
                            connected
                        `,
                        [
                            user.id,
                            username
                        ]
                    );

                streamer =
                    streamerResult.rows[0];

                await client.query(
                    "COMMIT"
                );

            } catch (error) {

                try {
                    await client.query(
                        "ROLLBACK"
                    );
                } catch (_) {}

                throw error;

            } finally {

                client.release();
            }

            /* =========================
               AUTO LOGIN
            ========================= */

            const token =
                generateSessionToken();

            const tokenHash =
                hashSessionToken(
                    token
                );

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
                    NOW() + ($3 * INTERVAL '1 day')
                )
                `,
                [
                    user.id,
                    tokenHash,
                    SESSION_DAYS
                ]
            );

            setSessionCookie(
                res,
                token
            );

            return res.status(201).json({
                success: true,

                data: {

                    user: {
                        id:
                            user.id,

                        username:
                            user.username,

                        email:
                            user.email,

                        role:
                            user.role
                    },

                    streamer: {
                        id:
                            Number(
                                streamer.id
                            ),

                        username:
                            streamer.username,

                        displayName:
                            streamer.display_name,

                        platform:
                            streamer.platform,

                        platformUsername:
                            streamer.platform_username,

                        connected:
                            streamer.connected
                    },

                    sessionToken:
                        token
                }
            });

        } catch (error) {

            console.error(
                "Registration error:",
                error
            );

            if (
                error.code ===
                "23505"
            ) {

                return sendError(
                    res,
                    409,
                    "ACCOUNT_EXISTS",
                    "An account with that username or email already exists."
                );
            }

            return sendError(
                res,
                500,
                "REGISTER_FAILED",
                "Could not create your account."
            );
        }
    }
);

/* =========================================================
   AUTH — LOGIN
========================================================= */

app.post(
    "/api/auth/login",
    async (req, res) => {

        try {

            const email =
                normalizeEmail(
                    req.body.email
                );

            const password =
                req.body.password;

            if (
                !email ||
                !password
            ) {

                return sendError(
                    res,
                    400,
                    "MISSING_CREDENTIALS",
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
                        role
                    FROM users
                    WHERE LOWER(email) =
                        LOWER($1)
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
                    "INVALID_CREDENTIALS",
                    "Invalid email or password."
                );
            }

            const user =
                result.rows[0];

            const valid =
                await verifyPassword(
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

            /*
             * Ensure older accounts have a
             * Nerve streamer profile.
             */

            let streamer =
                await getStreamerForUser(
                    user.id
                );

            if (!streamer) {

                const streamerResult =
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
                            $2,
                            'nerve_account',
                            FALSE
                        )
                        ON CONFLICT DO NOTHING
                        RETURNING *
                        `,
                        [
                            user.id,
                            user.username
                        ]
                    );

                streamer =
                    streamerResult.rows[0] ||
                    await getStreamerForUser(
                        user.id
                    );
            }

            const token =
                generateSessionToken();

            const tokenHash =
                hashSessionToken(
                    token
                );

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
                    NOW() + ($3 * INTERVAL '1 day')
                )
                `,
                [
                    user.id,
                    tokenHash,
                    SESSION_DAYS
                ]
            );

            setSessionCookie(
                res,
                token
            );

            return res.json({
                success: true,

                data: {

                    user: {
                        id:
                            user.id,

                        username:
                            user.username,

                        email:
                            user.email,

                        role:
                            user.role
                    },

                    streamer:
                        streamer
                            ? {
                                id:
                                    Number(
                                        streamer.id
                                    ),

                                username:
                                    streamer.username,

                                displayName:
                                    streamer.display_name,

                                platform:
                                    streamer.platform ||
                                    null,

                                platformUsername:
                                    streamer.platform_username ||
                                    null,

                                connected:
                                    Boolean(
                                        streamer.connected
                                    )
                            }
                            : null,

                    sessionToken:
                        token
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
                "LOGIN_FAILED",
                "Could not log you in."
            );
        }
    }
);

/* =========================================================
   AUTH — CURRENT USER
========================================================= */

app.get(
    "/api/auth/me",
    authenticateRequest,
    (req, res) => {

        if (!req.user) {

            return sendError(
                res,
                401,
                "AUTH_REQUIRED",
                "You are not logged in."
            );
        }

        return res.json({
            success: true,

            data: {

                user: {
                    id:
                        req.user.id,

                    username:
                        req.user.username,

                    email:
                        req.user.email,

                    role:
                        req.user.role
                }
            }
        });
    }
);

/* =========================================================
   AUTH — LOGOUT
========================================================= */

app.post(
    "/api/auth/logout",
    authenticateRequest,
    async (req, res) => {

        try {

            if (
                req.user?.sessionId
            ) {

                await pool.query(
                    `
                    DELETE FROM sessions
                    WHERE id = $1
                    `,
                    [
                        req.user.sessionId
                    ]
                );
            }

            clearSessionCookie(
                res
            );

            return res.json({
                success: true
            });

        } catch (error) {

            console.error(
                "Logout error:",
                error
            );

            clearSessionCookie(
                res
            );

            return res.json({
                success: true
            });
        }
    }
);

/* =========================================================
   AUTH — LOGOUT ALL
========================================================= */

app.post(
    "/api/auth/logout-all",
    authenticateRequest,
    requireAuth,
    async (req, res) => {

        try {

            await pool.query(
                `
                DELETE FROM sessions
                WHERE user_id = $1
                `,
                [
                    req.user.id
                ]
            );

            clearSessionCookie(
                res
            );

            return res.json({
                success: true
            });

        } catch (error) {

            console.error(
                "Logout-all error:",
                error
            );

            return sendError(
                res,
                500,
                "LOGOUT_FAILED",
                "Could not log out all sessions."
            );
        }
    }
);

/* =========================================================
   STREAMERS — PUBLIC
========================================================= */

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
                        platform,
                        platform_username,
                        connected
                    FROM streamers
                    WHERE connected = TRUE
                    ORDER BY
                        LOWER(display_name)
                    `
                );

            return res.json({
                streamers:
                    result.rows.map(
                        publicStreamer
                    )
            });

        } catch (error) {

            console.error(
                "Streamer lookup error:",
                error
            );

            return sendError(
                res,
                500,
                "STREAMERS_FAILED",
                "Could not load streamers."
            );
        }
    }
);

/* =========================================================
   STREAMER — MY STREAMER
========================================================= */

app.get(
    "/api/my-streamer",
    authenticateRequest,
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
                    "STREAMER_NOT_FOUND",
                    "Your streamer profile was not found."
                );
            }

            return res.json({
                success: true,
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
                "STREAMER_FAILED",
                "Could not load your streamer profile."
            );
        }
    }
);

/* =========================================================
   STREAMER — MY STREAMERS
   KEPT FOR FRONTEND COMPATIBILITY
========================================================= */

app.get(
    "/api/my-streamers",
    authenticateRequest,
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
                        platform,
                        platform_username,
                        connected
                    FROM streamers
                    WHERE owner_user_id = $1
                    ORDER BY
                        LOWER(display_name)
                    `,
                    [
                        req.user.id
                    ]
                );

            return res.json({
                streamers:
                    result.rows.map(
                        streamer => ({
                            id:
                                Number(
                                    streamer.id
                                ),

                            username:
                                streamer.username,

                            displayName:
                                streamer.display_name,

                            source:
                                streamer.source,

                            platform:
                                streamer.platform ||
                                null,

                            platformUsername:
                                streamer.platform_username ||
                                null,

                            connected:
                                Boolean(
                                    streamer.connected
                                )
                        })
                    )
            });

        } catch (error) {

            console.error(
                "My streamers error:",
                error
            );

            return sendError(
                res,
                500,
                "STREAMERS_FAILED",
                "Could not load your streamers."
            );
        }
    }
);

/* =========================================================
   STREAMER — UPDATE PLATFORM
========================================================= */

app.post(
    "/api/my-streamer/platform",
    authenticateRequest,
    requireAuth,
    async (req, res) => {

        try {

            const platform =
                normalizePlatform(
                    req.body.platform
                );

            const platformUsername =
                cleanText(
                    req.body.platformUsername ||
                    req.body.platform_username ||
                    "",
                    255
                ) || null;

            if (
                req.body.platform &&
                !platform
            ) {

                return sendError(
                    res,
                    400,
                    "INVALID_PLATFORM",
                    "Invalid streaming platform."
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
                    WHERE owner_user_id = $3
                    RETURNING
                        *
                    `,
                    [
                        platform,
                        platformUsername,
                        req.user.id
                    ]
                );

            if (
                result.rows.length === 0
            ) {

                return sendError(
                    res,
                    404,
                    "STREAMER_NOT_FOUND",
                    "Your streamer profile was not found."
                );
            }

            return res.json({
                success: true,

                streamer:
                    publicStreamer(
                        result.rows[0]
                    )
            });

        } catch (error) {

            console.error(
                "Platform update error:",
                error
            );

            return sendError(
                res,
                500,
                "PLATFORM_UPDATE_FAILED",
                "Could not update your streaming platform."
            );
        }
    }
);

/* =========================================================
   STREAMER OWNERSHIP
========================================================= */

async function userOwnsStreamerId(
    userId,
    streamerId
) {

    const id =
        parsePositiveInteger(
            streamerId
        );

    if (
        id === null ||
        id === 0
    ) {
        return false;
    }

    const result =
        await pool.query(
            `
            SELECT id
            FROM streamers
            WHERE
                id = $1
                AND owner_user_id = $2
            LIMIT 1
            `,
            [
                id,
                userId
            ]
        );

    return result.rows.length > 0;
}

/* =========================================================
   DARE FORMATTER
========================================================= */

function formatDare(row) {

    return {
        id:
            Number(row.id),

        streamerId:
            row.streamer_id !== null &&
            row.streamer_id !== undefined
                ? Number(
                    row.streamer_id
                )
                : null,

        streamer:
            row.streamer,

        streamerDisplayName:
            row.streamer_display_name ||
            row.streamer,

        streamer_source:
            row.streamer_source,

        streamerSource:
            row.streamer_source,

        platform:
            row.platform ||
            null,

        platformUsername:
            row.platform_username ||
            null,

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
            Number(row.reward),

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
            row.updated_at
    };
}

/* =========================================================
   GET DARE STATE
========================================================= */

async function getAllDareState() {

    const result =
        await pool.query(
            `
            SELECT
                d.id,
                d.streamer_id,
                d.streamer,
                d.streamer_source,
                d.viewer,
                d.dare_text,
                d.duration,
                d.reward,
                d.status,
                d.created_at,
                d.accepted_at,
                d.updated_at,

                s.display_name AS streamer_display_name,
                s.platform,
                s.platform_username

            FROM dares d

            LEFT JOIN streamers s
                ON s.id = d.streamer_id

            WHERE d.status IN (
                'pending',
                'accepted'
            )

            ORDER BY
                d.created_at ASC
            `
        );

    const activeDares = {};
    const queues = {};

    for (
        const row of result.rows
    ) {

        const dare =
            formatDare(row);

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

            activeDares[key] =
                dare;
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
        activeDares,
        queues
    };
}

/* =========================================================
   WEBSOCKET
========================================================= */

const wss =
    new WebSocket.Server({
        server,
        path: "/ws"
    });

/*
 * Number of active controller connections
 * for each Nerve streamer.
 *
 * Multiple tabs/devices can control the
 * same account without incorrectly marking
 * the streamer offline.
 */

const controllerConnections =
    new Map();

function getConnectionCount(
    streamerId
) {
    return (
        controllerConnections.get(
            String(streamerId)
        ) || 0
    );
}

async function setStreamerConnected(
    streamerId,
    connected
) {

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
}

async function addControllerConnection(
    streamerId
) {

    const key =
        String(streamerId);

    const current =
        getConnectionCount(
            streamerId
        );

    controllerConnections.set(
        key,
        current + 1
    );

    if (current === 0) {

        await setStreamerConnected(
            streamerId,
            true
        );

        broadcast({
            type:
                "STREAMER_CONNECTED",

            streamerId:
                Number(streamerId)
        });
    }
}

async function removeControllerConnection(
    streamerId
) {

    if (
        streamerId === null ||
        streamerId === undefined
    ) {
        return;
    }

    const key =
        String(streamerId);

    const current =
        getConnectionCount(
            streamerId
        );

    if (current <= 1) {

        controllerConnections.delete(
            key
        );

        await setStreamerConnected(
            streamerId,
            false
        );

        broadcast({
            type:
                "STREAMER_DISCONNECTED",

            streamerId:
                Number(streamerId)
        });

        return;
    }

    controllerConnections.set(
        key,
        current - 1
    );
}

/* =========================================================
   BROADCAST
========================================================= */

function broadcast(message) {

    const data =
        JSON.stringify(message);

    wss.clients.forEach(
        client => {

            if (
                client.readyState ===
                WebSocket.OPEN
            ) {

                try {

                    client.send(
                        data
                    );

                } catch (error) {

                    console.error(
                        "WebSocket send error:",
                        error
                    );
                }
            }
        }
    );
}

/* =========================================================
   SEND CURRENT STATE
========================================================= */

async function sendState(
    socket
) {

    try {

        const state =
            await getAllDareState();

        const streamers =
            await pool.query(
                `
                SELECT
                    id,
                    username,
                    display_name,
                    platform,
                    platform_username,
                    connected
                FROM streamers
                WHERE connected = TRUE
                ORDER BY
                    LOWER(display_name)
                `
            );

        if (
            socket.readyState !==
            WebSocket.OPEN
        ) {
            return;
        }

        socket.send(
            JSON.stringify({
                type: "STATE",

                active:
                    state.activeDares,

                activeDares:
                    Object.values(
                        state.activeDares
                    ),

                queues:
                    state.queues,

                streamers:
                    streamers.rows.map(
                        publicStreamer
                    )
            })
        );

    } catch (error) {

        console.error(
            "WebSocket state error:",
            error
        );
    }
}

/* =========================================================
   WEBSOCKET AUTH
========================================================= */

async function authenticateWebSocket(
    socket,
    token
) {

    if (
        typeof token !==
        "string" ||
        !token.trim()
    ) {

        socket.send(
            JSON.stringify({
                type: "AUTH_ERROR",
                error: {
                    code:
                        "AUTH_REQUIRED",
                    message:
                        "Authentication token is required."
                }
            })
        );

        return false;
    }

    try {

        const user =
            await getUserFromToken(
                token.trim()
            );

        if (!user) {

            socket.send(
                JSON.stringify({
                    type: "AUTH_ERROR",
                    error: {
                        code:
                            "INVALID_SESSION",
                        message:
                            "Your session is invalid or expired."
                    }
                })
            );

            return false;
        }

        const streamer =
            await getStreamerForUser(
                user.id
            );

        if (!streamer) {

            socket.send(
                JSON.stringify({
                    type: "AUTH_ERROR",
                    error: {
                        code:
                            "STREAMER_NOT_FOUND",
                        message:
                            "Your Nerve streamer profile was not found."
                    }
                })
            );

            return false;
        }

        socket.user = user;

        socket.streamerId =
            Number(
                streamer.id
            );

        socket.authenticated =
            true;

        socket.connectionRole =
            "controller";

        await addControllerConnection(
            socket.streamerId
        );

        socket.send(
            JSON.stringify({
                type: "AUTH_SUCCESS",

                user: {
                    id:
                        user.id,

                    username:
                        user.username,

                    role:
                        user.role
                },

                streamer:
                    publicStreamer(
                        {
                            ...streamer,
                            connected: true
                        }
                    )
            })
        );

        await sendState(
            socket
        );

        return true;

    } catch (error) {

        console.error(
            "WebSocket authentication error:",
            error
        );

        socket.send(
            JSON.stringify({
                type: "AUTH_ERROR",
                error: {
                    code:
                        "AUTH_FAILED",
                    message:
                        "Could not authenticate the connection."
                }
            })
        );

        return false;
    }
}

/* =========================================================
   WEBSOCKET CONNECTION
========================================================= */

wss.on(
    "connection",
    socket => {

        console.log(
            "WebSocket client connected."
        );

        socket.authenticated =
            false;

        socket.user =
            null;

        socket.streamerId =
            null;

        socket.connectionRole =
            null;

        /*
         * We intentionally DO NOT send
         * private controller state before
         * authentication.
         */

        socket.send(
            JSON.stringify({
                type:
                    "CONNECTED",
                message:
                    "WebSocket connected. Authenticate to control your Nerve account."
            })
        );

        socket.on(
            "message",
            async rawMessage => {

                try {

                    const message =
                        JSON.parse(
                            rawMessage.toString()
                        );

                    /* =========================
                       AUTH
                    ========================= */

                    if (
                        message.type ===
                        "AUTH"
                    ) {

                        if (
                            socket.authenticated
                        ) {
                            return;
                        }

                        await authenticateWebSocket(
                            socket,
                            message.token
                        );

                        return;
                    }

                    /*
                     * Everything below this point
                     * requires authenticated controller
                     * access.
                     */

                    if (
                        !socket.authenticated
                    ) {

                        socket.send(
                            JSON.stringify({
                                type:
                                    "AUTH_REQUIRED",
                                error: {
                                    code:
                                        "AUTH_REQUIRED",
                                    message:
                                        "Authenticate this WebSocket connection first."
                                }
                            })
                        );

                        return;
                    }

                    if (
                        message.type ===
                        "GET_STATE"
                    ) {

                        await sendState(
                            socket
                        );

                        return;
                    }

                    if (
                        message.type ===
                        "GET_ACTIVE_DARES"
                    ) {

                        await sendState(
                            socket
                        );

                        return;
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
            async () => {

                console.log(
                    "WebSocket client disconnected."
                );

                if (
                    socket.authenticated &&
                    socket.streamerId !== null
                ) {

                    try {

                        await removeControllerConnection(
                            socket.streamerId
                        );

                    } catch (error) {

                        console.error(
                            "Streamer disconnect error:",
                            error
                        );
                    }
                }
            }
        );

        socket.on(
            "error",
            error => {

                console.error(
                    "WebSocket error:",
                    error
                );
            }
        );
    }
);

/* =========================================================
   CREATE DARE
   PUBLIC
========================================================= */

app.post(
    "/api/dare",
    async (req, res) => {

        const client =
            await pool.connect();

        try {

            /*
             * NEW:
             *
             * streamerId is the authoritative
             * target.
             *
             * Legacy streamer username remains
             * temporarily supported.
             */

            let streamerId =
                parsePositiveInteger(
                    req.body.streamerId
                );

            let streamer =
                cleanDisplayUsername(
                    req.body.streamer
                );

            let viewer =
                req.body.viewer;

            let dareText =
                req.body.dare_text ||
                req.body.dareText ||
                req.body.text;

            const duration =
                Number(
                    req.body.duration
                );

            const reward =
                parseReward(
                    req.body.reward
                );

            let streamerRecord = null;

            /*
             * Preferred:
             * streamerId
             */

            if (
                streamerId !== null &&
                streamerId !== 0
            ) {

                streamerRecord =
                    await getStreamerById(
                        streamerId
                    );

            /*
             * Temporary legacy fallback.
             */

            } else if (
                streamer
            ) {

                streamerRecord =
                    await getStreamerByLegacyUsername(
                        streamer
                    );
            }

            if (!streamerRecord) {

                return sendError(
                    res,
                    404,
                    "STREAMER_NOT_FOUND",
                    "That Nerve streamer is not currently connected."
                );
            }

            streamerId =
                Number(
                    streamerRecord.id
                );

            if (
                !streamerRecord.connected
            ) {

                return sendError(
                    res,
                    409,
                    "STREAMER_OFFLINE",
                    "That streamer is not currently connected."
                );
            }

            viewer =
                cleanText(
                    viewer ||
                    "Anonymous",
                    255
                );

            if (!viewer) {
                viewer =
                    "Anonymous";
            }

            dareText =
                cleanText(
                    dareText,
                    1000
                );

            if (!dareText) {

                return sendError(
                    res,
                    400,
                    "DARE_REQUIRED",
                    "Dare text is required."
                );
            }

            if (
                !Number.isInteger(
                    duration
                ) ||
                duration < 5 ||
                duration > 300
            ) {

                return sendError(
                    res,
                    400,
                    "INVALID_DURATION",
                    "Duration must be between 5 and 300 seconds."
                );
            }

            if (
                reward === null
            ) {

                return sendError(
                    res,
                    400,
                    "INVALID_REWARD",
                    "Reward must be a valid non-negative number."
                );
            }

            await client.query(
                "BEGIN"
            );

            /*
             * Lock by permanent streamer ID.
             */

            await client.query(
                `
                SELECT
                    pg_advisory_xact_lock($1::bigint)
                `,
                [
                    streamerId
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
                    [
                        streamerId
                    ]
                );

            const status =
                activeResult.rows.length
                    ? "pending"
                    : "accepted";

            const acceptedAt =
                status === "accepted"
                    ? new Date()
                    : null;

            const inserted =
                await client.query(
                    `
                    INSERT INTO dares (
                        streamer_id,
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
                        $1,
                        $2,
                        'nerve_account',
                        $3,
                        $4,
                        $5,
                        $6,
                        $7,
                        $8,
                        NOW()
                    )
                    RETURNING
                        *
                    `,
                    [
                        streamerId,

                        streamerRecord.username,

                        viewer,

                        dareText,

                        duration,

                        reward,

                        status,

                        acceptedAt
                    ]
                );

            const rawDare =
                inserted.rows[0];

            /*
             * Fetch the streamer metadata
             * for the response.
             */

            const formattedResult =
                await client.query(
                    `
                    SELECT
                        d.*,
                        s.display_name
                            AS streamer_display_name,
                        s.platform,
                        s.platform_username
                    FROM dares d
                    LEFT JOIN streamers s
                        ON s.id = d.streamer_id
                    WHERE d.id = $1
                    `,
                    [
                        rawDare.id
                    ]
                );

            const dare =
                formatDare(
                    formattedResult.rows[0]
                );

            await client.query(
                "COMMIT"
            );

            broadcast({
                type:
                    "DARE_CREATED",

                dare
            });

            if (
                status === "accepted"
            ) {

                broadcast({
                    type:
                        "ACTIVE_DARE",

                    dare,

                    streamerId:
                        dare.streamerId,

                    streamer:
                        dare.streamer
                });
            }

            const queueResult =
                await pool.query(
                    `
                    SELECT
                        d.*,
                        s.display_name
                            AS streamer_display_name,
                        s.platform,
                        s.platform_username
                    FROM dares d
                    LEFT JOIN streamers s
                        ON s.id = d.streamer_id
                    WHERE
                        d.streamer_id = $1
                        AND d.status = 'pending'
                    ORDER BY
                        d.created_at ASC
                    `,
                    [
                        streamerId
                    ]
                );

            const queue =
                queueResult.rows.map(
                    formatDare
                );

            broadcast({
                type:
                    "QUEUE_UPDATED",

                streamerId,

                streamer:
                    dare.streamer,

                queue
            });

            return res.status(201).json({
                success: true,

                dare,

                queuePosition:
                    status === "pending"
                        ? queue.findIndex(
                            item =>
                                item.id ===
                                dare.id
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
                "DARE_CREATE_FAILED",
                "Could not create the dare."
            );

        } finally {

            client.release();
        }
    }
);

/* =========================================================
   GET CURRENT DARE STATE
========================================================= */

app.get(
    "/api/dare",
    async (req, res) => {

        try {

            const state =
                await getAllDareState();

            return res.json({
                activeDares:
                    Object.values(
                        state.activeDares
                    ),

                queues:
                    state.queues,

                streamers:
                    []
            });

        } catch (error) {

            console.error(
                "Dare state error:",
                error
            );

            return sendError(
                res,
                500,
                "STATE_FAILED",
                "Could not load dare state."
            );
        }
    }
);

/* =========================================================
   GET STREAMER QUEUE
   SUPPORTS STREAMER ID
========================================================= */

app.get(
    "/api/dare/queue/:streamer",
    async (req, res) => {

        try {

            const identifier =
                req.params.streamer;

            let streamerRecord =
                null;

            if (
                /^\d+$/.test(
                    identifier
                )
            ) {

                streamerRecord =
                    await getStreamerById(
                        identifier
                    );

            } else {

                streamerRecord =
                    await getStreamerByLegacyUsername(
                        identifier
                    );
            }

            if (!streamerRecord) {

                return sendError(
                    res,
                    404,
                    "STREAMER_NOT_FOUND",
                    "Streamer not found."
                );
            }

            const result =
                await pool.query(
                    `
                    SELECT
                        d.*,
                        s.display_name
                            AS streamer_display_name,
                        s.platform,
                        s.platform_username
                    FROM dares d
                    LEFT JOIN streamers s
                        ON s.id = d.streamer_id
                    WHERE
                        d.streamer_id = $1
                        AND d.status = 'pending'
                    ORDER BY
                        d.created_at ASC
                    `,
                    [
                        streamerRecord.id
                    ]
                );

            return res.json({
                streamerId:
                    Number(
                        streamerRecord.id
                    ),

                streamer:
                    streamerRecord.username,

                queue:
                    result.rows.map(
                        formatDare
                    )
            });

        } catch (error) {

            console.error(
                "Queue error:",
                error
            );

            return sendError(
                res,
                500,
                "QUEUE_FAILED",
                "Could not load the queue."
            );
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

            const identifier =
                req.params.streamer;

            let streamerRecord =
                null;

            if (
                /^\d+$/.test(
                    identifier
                )
            ) {

                streamerRecord =
                    await getStreamerById(
                        identifier
                    );

            } else {

                streamerRecord =
                    await getStreamerByLegacyUsername(
                        identifier
                    );
            }

            if (!streamerRecord) {

                return res.json({
                    activeDare: null
                });
            }

            const result =
                await pool.query(
                    `
                    SELECT
                        d.*,
                        s.display_name
                            AS streamer_display_name,
                        s.platform,
                        s.platform_username
                    FROM dares d
                    LEFT JOIN streamers s
                        ON s.id = d.streamer_id
                    WHERE
                        d.streamer_id = $1
                        AND d.status = 'accepted'
                    ORDER BY
                        d.accepted_at DESC NULLS LAST
                    LIMIT 1
                    `,
                    [
                        streamerRecord.id
                    ]
                );

            return res.json({
                activeDare:
                    result.rows.length
                        ? formatDare(
                            result.rows[0]
                        )
                        : null
            });

        } catch (error) {

            console.error(
                "Active dare error:",
                error
            );

            return sendError(
                res,
                500,
                "ACTIVE_FAILED",
                "Could not load the active dare."
            );
        }
    }
);

/* =========================================================
   UPDATE DARE STATUS
========================================================= */

app.post(
    "/api/dare/:id/status",
    authenticateRequest,
    requireAuth,
    async (req, res) => {

        const client =
            await pool.connect();

        try {

            const id =
                parsePositiveInteger(
                    req.params.id
                );

            const status =
                String(
                    req.body.status ||
                    ""
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
                id === null ||
                id === 0
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
                    "Invalid dare status."
                );
            }

            await client.query(
                "BEGIN"
            );

            const dareResult =
                await client.query(
                    `
                    SELECT
                        *
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

                return sendError(
                    res,
                    404,
                    "DARE_NOT_FOUND",
                    "Dare not found."
                );
            }

            const current =
                dareResult.rows[0];

            /*
             * Ownership is now based on
             * streamer_id.
             */

            const ownershipResult =
                await client.query(
                    `
                    SELECT id
                    FROM streamers
                    WHERE
                        id = $1
                        AND owner_user_id = $2
                    LIMIT 1
                    `,
                    [
                        current.streamer_id,
                        req.user.id
                    ]
                );

            if (
                ownershipResult.rows.length === 0 &&
                req.user.role !== "admin"
            ) {

                await client.query(
                    "ROLLBACK"
                );

                return sendError(
                    res,
                    403,
                    "STREAMER_NOT_OWNED",
                    "You do not control this streamer."
                );
            }

            /*
             * Lock this streamer's queue
             * while changing its active dare.
             */

            await client.query(
                `
                SELECT
                    pg_advisory_xact_lock($1::bigint)
                `,
                [
                    current.streamer_id
                ]
            );

            if (
                status === "accepted"
            ) {

                if (
                    current.status !==
                    "pending"
                ) {

                    await client.query(
                        "ROLLBACK"
                    );

                    return sendError(
                        res,
                        409,
                        "INVALID_TRANSITION",
                        "Only pending dares can be accepted."
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
                            AND id <> $2
                        LIMIT 1
                        `,
                        [
                            current.streamer_id,
                            id
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
                        "ACTIVE_DARE_EXISTS",
                        "Another dare is already active for this streamer."
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
                        [id]
                    );

                const metadata =
                    await client.query(
                        `
                        SELECT
                            d.*,
                            s.display_name
                                AS streamer_display_name,
                            s.platform,
                            s.platform_username
                        FROM dares d
                        LEFT JOIN streamers s
                            ON s.id = d.streamer_id
                        WHERE d.id = $1
                        `,
                        [id]
                    );

                const dare =
                    formatDare(
                        metadata.rows[0] ||
                        updated.rows[0]
                    );

                await client.query(
                    "COMMIT"
                );

                broadcast({
                    type:
                        "ACTIVE_DARE",

                    dare,

                    streamerId:
                        dare.streamerId,

                    streamer:
                        dare.streamer
                });

                const queueResult =
                    await pool.query(
                        `
                        SELECT
                            d.*,
                            s.display_name
                                AS streamer_display_name,
                            s.platform,
                            s.platform_username
                        FROM dares d
                        LEFT JOIN streamers s
                            ON s.id = d.streamer_id
                        WHERE
                            d.streamer_id = $1
                            AND d.status = 'pending'
                        ORDER BY
                            d.created_at ASC
                        `,
                        [
                            dare.streamerId
                        ]
                    );

                broadcast({
                    type:
                        "QUEUE_UPDATED",

                    streamerId:
                        dare.streamerId,

                    streamer:
                        dare.streamer,

                    queue:
                        queueResult.rows.map(
                            formatDare
                        )
                });

                return res.json({
                    success: true,
                    dare
                });
            }

            if (
                status === "rejected"
            ) {

                if (
                    current.status !==
                    "pending"
                ) {

                    await client.query(
                        "ROLLBACK"
                    );

                    return sendError(
                        res,
                        409,
                        "INVALID_TRANSITION",
                        "Only pending dares can be rejected."
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
                        [id]
                    );

                const metadata =
                    await client.query(
                        `
                        SELECT
                            d.*,
                            s.display_name
                                AS streamer_display_name,
                            s.platform,
                            s.platform_username
                        FROM dares d
                        LEFT JOIN streamers s
                            ON s.id = d.streamer_id
                        WHERE d.id = $1
                        `,
                        [id]
                    );

                const dare =
                    formatDare(
                        metadata.rows[0] ||
                        updated.rows[0]
                    );

                await client.query(
                    "COMMIT"
                );

                broadcast({
                    type:
                        "DARE_REJECTED",

                    dare,

                    streamerId:
                        dare.streamerId,

                    streamer:
                        dare.streamer
                });

                const queueResult =
                    await pool.query(
                        `
                        SELECT
                            d.*,
                            s.display_name
                                AS streamer_display_name,
                            s.platform,
                            s.platform_username
                        FROM dares d
                        LEFT JOIN streamers s
                            ON s.id = d.streamer_id
                        WHERE
                            d.streamer_id = $1
                            AND d.status = 'pending'
                        ORDER BY
                            d.created_at ASC
                        `,
                        [
                            dare.streamerId
                        ]
                    );

                broadcast({
                    type:
                        "QUEUE_UPDATED",

                    streamerId:
                        dare.streamerId,

                    streamer:
                        dare.streamer,

                    queue:
                        queueResult.rows.map(
                            formatDare
                        )
                });

                return res.json({
                    success: true,
                    dare
                });
            }

            if (
                status === "completed" ||
                status === "failed"
            ) {

                if (
                    current.status !==
                    "accepted"
                ) {

                    await client.query(
                        "ROLLBACK"
                    );

                    return sendError(
                        res,
                        409,
                        "INVALID_TRANSITION",
                        "Only active dares can be completed or failed."
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
                            id
                        ]
                    );

                const metadata =
                    await client.query(
                        `
                        SELECT
                            d.*,
                            s.display_name
                                AS streamer_display_name,
                            s.platform,
                            s.platform_username
                        FROM dares d
                        LEFT JOIN streamers s
                            ON s.id = d.streamer_id
                        WHERE d.id = $1
                        `,
                        [id]
                    );

                const dare =
                    formatDare(
                        metadata.rows[0] ||
                        updated.rows[0]
                    );

                await client.query(
                    "COMMIT"
                );

                broadcast({
                    type:
                        status === "completed"
                            ? "DARE_COMPLETED"
                            : "DARE_FAILED",

                    dare,

                    streamerId:
                        dare.streamerId,

                    streamer:
                        dare.streamer
                });

                broadcast({
                    type:
                        "ACTIVE_DARE_CLEARED",

                    streamerId:
                        dare.streamerId,

                    streamer:
                        dare.streamer,

                    dare
                });

                await activateNextDare(
                    dare.streamerId
                );

                return res.json({
                    success: true,
                    dare
                });
            }

        } catch (error) {

            try {
                await client.query(
                    "ROLLBACK"
                );
            } catch (_) {}

            console.error(
                "Status update error:",
                error
            );

            return sendError(
                res,
                500,
                "STATUS_UPDATE_FAILED",
                "Could not update the dare."
            );

        } finally {

            client.release();
        }
    }
);

/* =========================================================
   ACTIVATE NEXT DARE
========================================================= */

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
            SELECT
                pg_advisory_xact_lock($1::bigint)
            `,
            [
                streamerId
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
                [
                    streamerId
                ]
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
                SELECT *
                FROM dares
                WHERE
                    streamer_id = $1
                    AND status = 'pending'
                ORDER BY
                    created_at ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
                `,
                [
                    streamerId
                ]
            );

        if (
            next.rows.length === 0
        ) {

            await client.query(
                "COMMIT"
            );

            return null;
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
                [
                    next.rows[0].id
                ]
            );

        const metadata =
            await client.query(
                `
                SELECT
                    d.*,
                    s.display_name
                        AS streamer_display_name,
                    s.platform,
                    s.platform_username
                FROM dares d
                LEFT JOIN streamers s
                    ON s.id = d.streamer_id
                WHERE d.id = $1
                `,
                [
                    updated.rows[0].id
                ]
            );

        const dare =
            formatDare(
                metadata.rows[0] ||
                updated.rows[0]
            );

        await client.query(
            "COMMIT"
        );

        broadcast({
            type:
                "ACTIVE_DARE",

            dare,

            streamerId:
                dare.streamerId,

            streamer:
                dare.streamer
        });

        const queue =
            await pool.query(
                `
                SELECT
                    d.*,
                    s.display_name
                        AS streamer_display_name,
                    s.platform,
                    s.platform_username
                FROM dares d
                LEFT JOIN streamers s
                    ON s.id = d.streamer_id
                WHERE
                    d.streamer_id = $1
                    AND d.status = 'pending'
                ORDER BY
                    d.created_at ASC
                `,
                [
                    streamerId
                ]
            );

        broadcast({
            type:
                "QUEUE_UPDATED",

            streamerId:
                Number(streamerId),

            streamer:
                dare.streamer,

            queue:
                queue.rows.map(
                    formatDare
                )
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

/* =========================================================
   DARE HISTORY
========================================================= */

app.get(
    "/api/dare/history",
    authenticateRequest,
    requireAuth,
    async (req, res) => {

        try {

            let limit =
                Number(
                    req.query.limit || 100
                );

            if (
                !Number.isInteger(limit) ||
                limit < 1
            ) {
                limit = 100;
            }

            limit =
                Math.min(
                    limit,
                    500
                );

            const result =
                await pool.query(
                    `
                    SELECT
                        d.*,
                        s.display_name
                            AS streamer_display_name,
                        s.platform,
                        s.platform_username
                    FROM dares d

                    INNER JOIN streamers s
                        ON s.id = d.streamer_id

                    WHERE
                        s.owner_user_id = $1

                    ORDER BY
                        d.created_at DESC

                    LIMIT $2
                    `,
                    [
                        req.user.id,
                        limit
                    ]
                );

            return res.json({
                history:
                    result.rows.map(
                        formatDare
                    )
            });

        } catch (error) {

            console.error(
                "History error:",
                error
            );

            return sendError(
                res,
                500,
                "HISTORY_FAILED",
                "Could not load dare history."
            );
        }
    }
);

/* =========================================================
   CLEAR DARES
   ADMIN ONLY
========================================================= */

app.post(
    "/api/dare/clear",
    authenticateRequest,
    requireAuth,
    async (req, res) => {

        if (
            req.user.role !==
            "admin"
        ) {

            return sendError(
                res,
                403,
                "ADMIN_REQUIRED",
                "Administrator access is required."
            );
        }

        try {

            const result =
                await pool.query(
                    `
                    DELETE FROM dares
                    RETURNING id
                    `
                );

            broadcast({
                type:
                    "RESET"
            });

            return res.json({
                success: true,

                deleted:
                    result.rows.length
            });

        } catch (error) {

            console.error(
                "Clear dares error:",
                error
            );

            return sendError(
                res,
                500,
                "CLEAR_FAILED",
                "Could not clear dares."
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
   ERROR HANDLER
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
         * After a Render restart, no controller
         * WebSocket sessions exist yet.
         *
         * Therefore all streamers should begin offline.
         */

        await pool.query(`
            UPDATE streamers
            SET connected = FALSE
        `);

        server.listen(
            PORT,
            () => {

                console.log(
                    `🚀 DARE Backend running on port ${PORT}`
                );

                console.log(
                    `🌐 Frontend origin: ${FRONTEND_ORIGIN}`
                );

                console.log(
                    `🧠 Identity: Nerve Account`
                );

                console.log(
                    `🔐 Authentication: enabled`
                );

                console.log(
                    `🗄️ PostgreSQL: connected`
                );

                console.log(
                    `🔌 WebSocket: /ws`
                );

                console.log(
                    `🎥 Platform identity: optional`
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

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

async function shutdown(
    signal
) {

    console.log(
        `${signal} received. Shutting down...`
    );

    try {

        /*
         * Nobody is connected once this
         * process is shutting down.
         */

        await pool.query(`
            UPDATE streamers
            SET connected = FALSE
        `);

    } catch (error) {

        console.error(
            "Shutdown database update error:",
            error
        );
    }

    server.close(
        async () => {

            try {

                await pool.end();

            } catch (error) {

                console.error(
                    "Pool shutdown error:",
                    error
                );
            }

            process.exit(0);
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

startServer();
