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

const FRONTEND_ORIGIN =
    (
        process.env.FRONTEND_ORIGIN ||
        "https://jcmr22922922-crypto.github.io"
    ).replace(/\/+$/, "");

const SESSION_DAYS =
    Number(process.env.SESSION_DAYS || 30);

const SESSION_TTL_MS =
    SESSION_DAYS *
    24 *
    60 *
    60 *
    1000;

const DEFAULT_STREAMER_USERNAME =
    process.env.DEFAULT_STREAMER_USERNAME ||
    "IShowSloow_";

const DEFAULT_STREAMER_DISPLAY_NAME =
    process.env.DEFAULT_STREAMER_DISPLAY_NAME ||
    DEFAULT_STREAMER_USERNAME;


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

    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/
        .test(email);

}


function isValidUsername(username) {

    return /^[A-Za-z0-9_]{3,50}$/
        .test(username);

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

    return Math.round(
        number * 100
    ) / 100;

}


function streamerKey(username) {

    return normalizeUsername(
        username
    );

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


/* =========================================================
   PASSWORD HASHING
   Uses Node's built-in scrypt.
   No extra bcrypt dependency required.
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
   COOKIE HELPER
   Cross-site GitHub Pages → Render authentication
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

        parts.push(
            "HttpOnly"
        );

    }


    if (
        options.secure !== false
    ) {

        parts.push(
            "Secure"
        );

    }


    if (
        options.sameSite
    ) {

        parts.push(
            `SameSite=${options.sameSite}`
        );

    }


    /*
     * GitHub Pages and Render are different sites.
     *
     * Partitioned allows the session cookie to work
     * as a partitioned cross-site cookie in browsers
     * that support CHIPS.
     *
     * Secure is required for Partitioned cookies.
     */

    if (
        options.partitioned
    ) {

        parts.push(
            "Partitioned"
        );

    }


    const existing =
        res.getHeader(
            "Set-Cookie"
        );


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
   AUTH MIDDLEWARE
========================================================= */

async function authenticateRequest(
    req,
    res,
    next
) {

    try {

        const cookies =
            parseCookies(req);


        const token =
            cookies.dare_session;


        if (!token) {

            req.user = null;

            next();

            return;

        }


        const tokenHash =
            hashSessionToken(
                token
            );


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

            req.user = null;

            clearSessionCookie(res);

            next();

            return;

        }


        const session =
            result.rows[0];


        req.user = {
            id: session.user_id,
            username: session.username,
            email: session.email,
            role: session.role,
            sessionId:
                session.session_id
        };


        await pool.query(
            `
            UPDATE sessions
            SET last_seen_at = NOW()
            WHERE id = $1
            `,
            [session.session_id]
        );


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
   DATABASE INITIALIZATION
========================================================= */

async function initializeDatabase() {

    const client =
        await pool.connect();


    try {

        await client.query(
            "BEGIN"
        );


        /* USERS */

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


        /* SESSIONS */

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


        /* STREAMERS */

        await client.query(`
            CREATE TABLE IF NOT EXISTS streamers (
                id BIGSERIAL PRIMARY KEY,

                owner_user_id BIGINT
                    REFERENCES users(id)
                    ON DELETE SET NULL,

                username VARCHAR(255) NOT NULL,

                display_name VARCHAR(255) NOT NULL,

                source VARCHAR(50) NOT NULL DEFAULT 'twitch_username',

                connected BOOLEAN NOT NULL DEFAULT TRUE,

                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);


        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS
            streamers_username_lower_unique
            ON streamers (
                LOWER(username)
            );
        `);


        await client.query(`
            CREATE INDEX IF NOT EXISTS
            streamers_owner_idx
            ON streamers(owner_user_id);
        `);


        /* EXISTING DARES TABLE */

        await client.query(`
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

                created_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW(),

                accepted_at TIMESTAMPTZ,

                updated_at TIMESTAMPTZ
            );
        `);


        await client.query(`
            CREATE INDEX IF NOT EXISTS
            dares_streamer_status_idx
            ON dares (
                LOWER(streamer),
                status
            );
        `);


        await client.query(`
            CREATE INDEX IF NOT EXISTS
            dares_created_at_idx
            ON dares(created_at);
        `);


        await client.query(
            "COMMIT"
        );


        /*
         * Seed the temporary development streamer.
         *
         * It starts unowned.
         *
         * The first registered account can claim
         * an unowned default streamer.
         */

        await pool.query(
            `
            INSERT INTO streamers (
                username,
                display_name,
                source,
                connected
            )
            SELECT
                $1,
                $2,
                'twitch_username',
                TRUE
            WHERE NOT EXISTS (
                SELECT 1
                FROM streamers
                WHERE LOWER(username) = LOWER($1)
            )
            `,
            [
                DEFAULT_STREAMER_USERNAME,
                DEFAULT_STREAMER_DISPLAY_NAME
            ]
        );


        console.log(
            "✅ Database initialized."
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
   CLEAN EXPIRED SESSIONS
========================================================= */

async function cleanExpiredSessions() {

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

}


setInterval(
    cleanExpiredSessions,
    60 * 60 * 1000
);


/* =========================================================
   ROOT / HEALTH
========================================================= */

app.get(
    "/",
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        COUNT(*) FILTER (
                            WHERE status = 'accepted'
                        ) AS active_count,

                        COUNT(*) FILTER (
                            WHERE status = 'pending'
                        ) AS pending_count

                    FROM dares
                    `
                );


            res.json({
                status: "online",
                service: "DARE Backend",
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


                await client.query(
                    `
                    UPDATE streamers
                    SET
                        owner_user_id = $1,
                        updated_at = NOW()
                    WHERE
                        LOWER(username) =
                            LOWER($2)
                        AND owner_user_id IS NULL
                    `,
                    [
                        user.id,
                        DEFAULT_STREAMER_USERNAME
                    ]
                );


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


            /*
             * Automatically log the new account in.
             */

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


            return res.status(201).json({
                success: true,
                data: {
                    user: {
                        id: user.id,
                        username:
                            user.username,
                        email:
                            user.email,
                        role:
                            user.role
                    }
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


            /*
             * IMPORTANT:
             *
             * The frontend is on GitHub Pages and the
             * backend is on Render, so this is a
             * cross-site session cookie.
             *
             * SameSite=None + Secure allows the cookie
             * to be sent with credentialed requests.
             *
             * Partitioned provides CHIPS support for
             * browsers that support partitioned cookies.
             */

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


            return res.json({
                success: true,
                data: {
                    user: {
                        id: user.id,
                        username:
                            user.username,
                        email:
                            user.email,
                        role:
                            user.role
                    }
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
   AUTH — LOGOUT ALL SESSIONS
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
                        username,
                        display_name,
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
                        streamer => ({
                            username:
                                streamer.username,
                            displayName:
                                streamer.display_name,
                            connected:
                                streamer.connected
                        })
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
   STREAMERS — AUTHENTICATED USER'S STREAMERS
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
                                streamer.id,
                            username:
                                streamer.username,
                            displayName:
                                streamer.display_name,
                            source:
                                streamer.source,
                            connected:
                                streamer.connected
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
   STREAMERS — CLAIM TEMPORARY STREAMER
========================================================= */

app.post(
    "/api/streamers/claim-default",
    authenticateRequest,
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
                    WHERE
                        LOWER(username) =
                            LOWER($2)
                        AND owner_user_id IS NULL
                    RETURNING
                        id,
                        username,
                        display_name,
                        source,
                        connected
                    `,
                    [
                        req.user.id,
                        DEFAULT_STREAMER_USERNAME
                    ]
                );


            if (
                result.rows.length === 0
            ) {

                const alreadyOwned =
                    await pool.query(
                        `
                        SELECT
                            owner_user_id
                        FROM streamers
                        WHERE
                            LOWER(username) =
                                LOWER($1)
                        LIMIT 1
                        `,
                        [
                            DEFAULT_STREAMER_USERNAME
                        ]
                    );


                if (
                    alreadyOwned.rows.length &&
                    String(
                        alreadyOwned
                            .rows[0]
                            .owner_user_id
                    ) ===
                    String(req.user.id)
                ) {

                    return res.json({
                        success: true,
                        message:
                            "Streamer is already connected to your account."
                    });

                }


                return sendError(
                    res,
                    409,
                    "STREAMER_UNAVAILABLE",
                    "That streamer is already connected to another account."
                );

            }


            return res.json({
                success: true,
                streamer:
                    result.rows[0]
            });

        } catch (error) {

            console.error(
                "Claim streamer error:",
                error
            );


            return sendError(
                res,
                500,
                "CLAIM_FAILED",
                "Could not claim the streamer."
            );

        }

    }
);


/* =========================================================
   STREAMER OWNERSHIP
========================================================= */

async function userOwnsStreamer(
    userId,
    streamerUsername
) {

    const normalized =
        normalizeUsername(
            streamerUsername
        );


    if (!normalized) {
        return false;
    }


    const result =
        await pool.query(
            `
            SELECT id
            FROM streamers
            WHERE
                LOWER(username) =
                    LOWER($1)
                AND owner_user_id = $2
                AND connected = TRUE
            LIMIT 1
            `,
            [
                normalized,
                userId
            ]
        );


    return result.rows.length > 0;

}


/* =========================================================
   GET ALL DARE STATE
========================================================= */

async function getAllDareState() {

    const result =
        await pool.query(
            `
            SELECT
                id,
                streamer,
                streamer_source,
                viewer,
                dare_text,
                duration,
                reward,
                status,
                created_at,
                accepted_at,
                updated_at
            FROM dares
            WHERE status IN (
                'pending',
                'accepted'
            )
            ORDER BY
                created_at ASC
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
            streamerKey(
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
   DARE FORMATTER
========================================================= */

function formatDare(row) {

    return {
        id: Number(row.id),

        streamer:
            row.streamer,

        streamer_source:
            row.streamer_source,

        streamerSource:
            row.streamer_source,

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
   BROADCAST
========================================================= */

const wss =
    new WebSocket.Server({
        server,
        path: "/ws"
    });


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
                    username,
                    display_name,
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
                        streamer => ({
                            username:
                                streamer.username,
                            displayName:
                                streamer.display_name,
                            connected:
                                streamer.connected
                        })
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
   WEBSOCKET CONNECTION
========================================================= */

wss.on(
    "connection",
    socket => {

        console.log(
            "WebSocket client connected."
        );


        sendState(
            socket
        );


        socket.on(
            "message",
            rawMessage => {

                try {

                    const message =
                        JSON.parse(
                            rawMessage.toString()
                        );


                    if (
                        message.type ===
                        "GET_STATE"
                    ) {

                        sendState(
                            socket
                        );

                    }


                    if (
                        message.type ===
                        "GET_ACTIVE_DARES"
                    ) {

                        sendState(
                            socket
                        );

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
                    "WebSocket client disconnected."
                );

            }
        );

    }
);


/* =========================================================
   CREATE DARE
   PUBLIC ENDPOINT
========================================================= */

app.post(
    "/api/dare",
    async (req, res) => {

        const client =
            await pool.connect();


        try {

            let streamer =
                req.body.streamer;

            let streamerSource =
                req.body.streamer_source ||
                req.body.streamerSource ||
                "twitch_username";

            let viewer =
                req.body.viewer;

            let dareText =
                req.body.dare_text ||
                req.body.text;


            const duration =
                Number(
                    req.body.duration
                );


            const reward =
                parseReward(
                    req.body.reward
                );


            /* =========================
               STREAMER
            ========================= */

            streamer =
                cleanDisplayUsername(
                    streamer
                );


            if (
                !streamer
            ) {

                return sendError(
                    res,
                    400,
                    "STREAMER_REQUIRED",
                    "A target streamer is required."
                );

            }


            if (
                streamer.length >
                255
            ) {

                return sendError(
                    res,
                    400,
                    "STREAMER_TOO_LONG",
                    "Streamer name is too long."
                );

            }


            /* =========================
               SOURCE
            ========================= */

            streamerSource =
                String(
                    streamerSource
                )
                .trim()
                .toLowerCase();


            const allowedSources = [
                "twitch_username",
                "connected",
                "twitch"
            ];


            if (
                !allowedSources.includes(
                    streamerSource
                )
            ) {

                return sendError(
                    res,
                    400,
                    "INVALID_STREAMER_SOURCE",
                    "Invalid streamer source."
                );

            }


            /* =========================
               VIEWER
            ========================= */

            viewer =
                cleanText(
                    viewer ||
                    "Anonymous",
                    255
                );


            if (!viewer) {
                viewer = "Anonymous";
            }


            /* =========================
               DARE TEXT
            ========================= */

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


            /* =========================
               DURATION
            ========================= */

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


            /* =========================
               REWARD
            ========================= */

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


            /* =========================
               STREAMER EXISTS
            ========================= */

            const streamerResult =
                await client.query(
                    `
                    SELECT
                        username,
                        display_name,
                        connected
                    FROM streamers
                    WHERE
                        LOWER(username) =
                            LOWER($1)
                    LIMIT 1
                    `,
                    [
                        streamer
                    ]
                );


            if (
                streamerResult.rows.length === 0
            ) {

                return sendError(
                    res,
                    404,
                    "STREAMER_NOT_FOUND",
                    "That streamer is not currently connected."
                );

            }


            const streamerRecord =
                streamerResult.rows[0];


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


            streamer =
                streamerRecord.username;


            /* =========================
               TRANSACTION
            ========================= */

            await client.query(
                "BEGIN"
            );


            /*
             * Prevent two submissions for the
             * same streamer from both becoming
             * active at the same time.
             */

            await client.query(
                `
                SELECT
                    pg_advisory_xact_lock(
                        hashtext(
                            LOWER(TRIM($1))
                        )
                    )
                `,
                [
                    streamer
                ]
            );


            const activeResult =
                await client.query(
                    `
                    SELECT id
                    FROM dares
                    WHERE
                        LOWER(streamer) =
                            LOWER($1)
                        AND status = 'accepted'
                    LIMIT 1
                    `,
                    [
                        streamer
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
                        streamer,
                        streamerSource,
                        viewer,
                        dareText,
                        duration,
                        reward,
                        status,
                        acceptedAt
                    ]
                );


            const dare =
                formatDare(
                    inserted.rows[0]
                );


            await client.query(
                "COMMIT"
            );


            /* =========================
               BROADCAST
            ========================= */

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

                    streamer:
                        dare.streamer
                });

            }


            /*
             * Always update queue state.
             */

            const queueResult =
                await pool.query(
                    `
                    SELECT *
                    FROM dares
                    WHERE
                        LOWER(streamer) =
                            LOWER($1)
                        AND status = 'pending'
                    ORDER BY
                        created_at ASC
                    `,
                    [
                        streamer
                    ]
                );


            const queue =
                queueResult.rows.map(
                    formatDare
                );


            broadcast({
                type:
                    "QUEUE_UPDATED",

                streamer,

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
========================================================= */

app.get(
    "/api/dare/queue/:streamer",
    async (req, res) => {

        try {

            const streamer =
                cleanDisplayUsername(
                    req.params.streamer
                );


            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM dares
                    WHERE
                        LOWER(streamer) =
                            LOWER($1)
                        AND status = 'pending'
                    ORDER BY
                        created_at ASC
                    `,
                    [
                        streamer
                    ]
                );


            return res.json({
                streamer,

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

            const streamer =
                cleanDisplayUsername(
                    req.params.streamer
                );


            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM dares
                    WHERE
                        LOWER(streamer) =
                            LOWER($1)
                        AND status = 'accepted'
                    ORDER BY
                        accepted_at DESC NULLS LAST
                    LIMIT 1
                    `,
                    [
                        streamer
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
   PROTECTED
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
                    SELECT *
                    FROM dares
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [
                        id
                    ]
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


            /* =========================
               OWNERSHIP
            ========================= */

            const ownershipResult =
                await client.query(
                    `
                    SELECT id
                    FROM streamers
                    WHERE
                        LOWER(username) =
                            LOWER($1)
                        AND owner_user_id = $2
                    LIMIT 1
                    `,
                    [
                        current.streamer,
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


            /* =========================
               STATE MACHINE
            ========================= */

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


                /*
                 * Prevent another active dare.
                 */

                const active =
                    await client.query(
                        `
                        SELECT id
                        FROM dares
                        WHERE
                            LOWER(streamer) =
                                LOWER($1)
                            AND status =
                                'accepted'
                            AND id <> $2
                        LIMIT 1
                        `,
                        [
                            current.streamer,
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
                        [
                            id
                        ]
                    );


                const dare =
                    formatDare(
                        updated.rows[0]
                    );


                await client.query(
                    "COMMIT"
                );


                broadcast({
                    type:
                        "ACTIVE_DARE",

                    dare,

                    streamer:
                        dare.streamer
                });


                const queueResult =
                    await pool.query(
                        `
                        SELECT *
                        FROM dares
                        WHERE
                            LOWER(streamer) =
                                LOWER($1)
                            AND status =
                                'pending'
                        ORDER BY
                            created_at ASC
                        `,
                        [
                            dare.streamer
                        ]
                    );


                broadcast({
                    type:
                        "QUEUE_UPDATED",

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
                        [
                            id
                        ]
                    );


                const dare =
                    formatDare(
                        updated.rows[0]
                    );


                await client.query(
                    "COMMIT"
                );


                broadcast({
                    type:
                        "DARE_REJECTED",

                    dare,

                    streamer:
                        dare.streamer
                });


                const queueResult =
                    await pool.query(
                        `
                        SELECT *
                        FROM dares
                        WHERE
                            LOWER(streamer) =
                                LOWER($1)
                            AND status =
                                'pending'
                        ORDER BY
                            created_at ASC
                        `,
                        [
                            dare.streamer
                        ]
                    );


                broadcast({
                    type:
                        "QUEUE_UPDATED",

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


                const dare =
                    formatDare(
                        updated.rows[0]
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

                        dare,

                        streamer:
                            dare.streamer
                    });

                } else {

                    broadcast({
                        type:
                            "DARE_FAILED",

                        dare,

                        streamer:
                            dare.streamer
                    });

                }


                broadcast({
                    type:
                        "ACTIVE_DARE_CLEARED",

                    streamer:
                        dare.streamer,

                    dare
                });


                /*
                 * Automatically activate the next
                 * pending dare.
                 */

                await activateNextDare(
                    dare.streamer
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
   ACTIVATE NEXT QUEUED DARE
========================================================= */

async function activateNextDare(
    streamer
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
                pg_advisory_xact_lock(
                    hashtext(
                        LOWER(TRIM($1))
                    )
                )
            `,
            [
                streamer
            ]
        );


        const active =
            await client.query(
                `
                SELECT id
                FROM dares
                WHERE
                    LOWER(streamer) =
                        LOWER($1)
                    AND status = 'accepted'
                LIMIT 1
                `,
                [
                    streamer
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
                    LOWER(streamer) =
                        LOWER($1)
                    AND status = 'pending'
                ORDER BY
                    created_at ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
                `,
                [
                    streamer
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


        const dare =
            formatDare(
                updated.rows[0]
            );


        await client.query(
            "COMMIT"
        );


        broadcast({
            type:
                "ACTIVE_DARE",

            dare,

            streamer:
                dare.streamer
        });


        const queue =
            await pool.query(
                `
                SELECT *
                FROM dares
                WHERE
                    LOWER(streamer) =
                        LOWER($1)
                    AND status = 'pending'
                ORDER BY
                    created_at ASC
                `,
                [
                    streamer
                ]
            );


        broadcast({
            type:
                "QUEUE_UPDATED",

            streamer,

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
   AUTHENTICATED ONLY
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
                        d.*
                    FROM dares d
                    INNER JOIN streamers s
                        ON LOWER(s.username) =
                           LOWER(d.streamer)
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
                    `🎥 Default streamer: ${DEFAULT_STREAMER_USERNAME}`
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


process.on(
    "SIGTERM",
    async () => {

        console.log(
            "SIGTERM received. Shutting down..."
        );


        server.close(
            async () => {

                await pool.end();

                process.exit(0);

            }
        );

    }
);


process.on(
    "SIGINT",
    async () => {

        console.log(
            "SIGINT received. Shutting down..."
        );


        server.close(
            async () => {

                await pool.end();

                process.exit(0);

            }
        );

    }
);


startServer();
