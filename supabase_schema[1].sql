-- ═══════════════════════════════════════════════════════════
--  ANON·BOARDS — Supabase Schema
--  Run this ONCE in your Supabase SQL Editor
--  Dashboard → SQL Editor → New Query → paste → Run
-- ═══════════════════════════════════════════════════════════

-- 1. POSTS (replies stored as JSONB array inside the row)
CREATE TABLE IF NOT EXISTS posts (
  id      BIGINT PRIMARY KEY,
  board   TEXT    NOT NULL DEFAULT '',
  title   TEXT    NOT NULL DEFAULT '',
  body    TEXT    NOT NULL DEFAULT '',
  author  TEXT    NOT NULL DEFAULT '',
  time    BIGINT  NOT NULL DEFAULT 0,
  likes   INTEGER NOT NULL DEFAULT 0,
  views   INTEGER NOT NULL DEFAULT 0,
  pinned  BOOLEAN NOT NULL DEFAULT FALSE,
  hot     BOOLEAN NOT NULL DEFAULT FALSE,
  replies JSONB   NOT NULL DEFAULT '[]'::jsonb
);

-- 2. FORUMS (moderation data: mods, bans, reports)
CREATE TABLE IF NOT EXISTS forums (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  icon          TEXT NOT NULL DEFAULT '',
  creator       TEXT,
  moderators    JSONB NOT NULL DEFAULT '[]'::jsonb,
  banned_users  JSONB NOT NULL DEFAULT '[]'::jsonb,
  post_reports  JSONB NOT NULL DEFAULT '[]'::jsonb,
  reply_reports JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- 3. USERS (accounts)
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  username       TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL DEFAULT '',
  emoji          TEXT NOT NULL DEFAULT '',
  anon_id        TEXT NOT NULL DEFAULT '',
  created_at     BIGINT NOT NULL DEFAULT 0,
  last_login     BIGINT NOT NULL DEFAULT 0,
  is_admin       BOOLEAN NOT NULL DEFAULT FALSE,
  is_super_admin BOOLEAN NOT NULL DEFAULT FALSE,
  favorites      JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- 4. METADATA (seed flags, etc.)
CREATE TABLE IF NOT EXISTS metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- ── ROW LEVEL SECURITY ──────────────────────────────────────
-- Enable RLS on all tables
ALTER TABLE posts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE forums   ENABLE ROW LEVEL SECURITY;
ALTER TABLE users    ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata ENABLE ROW LEVEL SECURITY;

-- Allow full anon access (the app handles its own auth)
CREATE POLICY "anon_all_posts"    ON posts    FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_forums"   ON forums   FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_users"    ON users    FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_metadata" ON metadata FOR ALL TO anon USING (true) WITH CHECK (true);

-- ── REALTIME ────────────────────────────────────────────────
-- Enable Realtime for posts and forums tables
-- (Go to Supabase Dashboard → Database → Replication and toggle posts + forums ON)
-- Or run:
ALTER PUBLICATION supabase_realtime ADD TABLE posts;
ALTER PUBLICATION supabase_realtime ADD TABLE forums;
