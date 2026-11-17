import type { Db } from './db.js'

function migrateToSchema12(db: Db): void {
  const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
  const tables = new Set(tableRows.map(r => r.name))

  // 1. projects.first_pull_run_id
  const projectCols = (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map(c => c.name)
  if (!projectCols.includes('first_pull_run_id')) {
    db.exec('ALTER TABLE projects ADD COLUMN first_pull_run_id TEXT;')
  }

  // 2. project_facts_norm
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_facts_norm (
      project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      budget_min REAL,
      budget_max REAL,
      budget_currency TEXT,
      duration_days INTEGER,
      fetched_at INTEGER NOT NULL
    );
  `)

  // 3. taxonomy_nodes
  if (tables.has('taxonomy_nodes')) {
    const nodeCols = (db.prepare('PRAGMA table_info(taxonomy_nodes)').all() as { name: string }[]).map(c => c.name)
    if (!nodeCols.includes('is_active')) {
      db.exec('ALTER TABLE taxonomy_nodes ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;')
    }
    if (!nodeCols.includes('sort_order')) {
      db.exec('ALTER TABLE taxonomy_nodes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;')
    }
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS taxonomy_nodes (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES taxonomy_nodes(id) ON DELETE CASCADE,
        dimension TEXT NOT NULL,
        name_ar TEXT NOT NULL,
        name_en TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
    `)
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_taxonomy_parent ON taxonomy_nodes(parent_id);
    CREATE INDEX IF NOT EXISTS idx_taxonomy_dim ON taxonomy_nodes(dimension, is_active);
  `)

  // 4. taxonomy_keywords
  if (tables.has('taxonomy_keywords')) {
    const kwCols = (db.prepare('PRAGMA table_info(taxonomy_keywords)').all() as { name: string }[]).map(c => c.name)
    if (!kwCols.includes('keyword')) {
      db.exec(`
        CREATE TABLE taxonomy_keywords_v12 (
          id TEXT PRIMARY KEY,
          node_id TEXT NOT NULL REFERENCES taxonomy_nodes(id) ON DELETE CASCADE,
          keyword TEXT NOT NULL,
          weight REAL NOT NULL DEFAULT 1.0,
          match_mode TEXT NOT NULL DEFAULT 'word',
          case_sensitive INTEGER NOT NULL DEFAULT 0,
          requires_context TEXT,
          is_exclusion INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO taxonomy_keywords_v12 (id, node_id, keyword, weight, is_exclusion)
          SELECT CAST(id AS TEXT), node_id, raw_phrase, weight, is_exclusion FROM taxonomy_keywords;
        DROP TABLE taxonomy_keywords;
        ALTER TABLE taxonomy_keywords_v12 RENAME TO taxonomy_keywords;
      `)
    }
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS taxonomy_keywords (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES taxonomy_nodes(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        match_mode TEXT NOT NULL DEFAULT 'word',
        case_sensitive INTEGER NOT NULL DEFAULT 0,
        requires_context TEXT,
        is_exclusion INTEGER NOT NULL DEFAULT 0
      );
    `)
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_taxonomy_kw_node ON taxonomy_keywords(node_id);
    CREATE INDEX IF NOT EXISTS idx_taxonomy_kw_lookup ON taxonomy_keywords(keyword);
  `)

  // 5. taxonomy_inferences
  if (tables.has('taxonomy_inferences')) {
    const infCols = (db.prepare('PRAGMA table_info(taxonomy_inferences)').all() as { name: string }[]).map(c => c.name)
    if (!infCols.includes('target_node_id')) {
      db.exec(`
        CREATE TABLE taxonomy_inferences_v12 (
          source_node_id TEXT NOT NULL REFERENCES taxonomy_nodes(id) ON DELETE CASCADE,
          target_node_id TEXT NOT NULL REFERENCES taxonomy_nodes(id) ON DELETE CASCADE,
          confidence REAL NOT NULL DEFAULT 1.0,
          PRIMARY KEY (source_node_id, target_node_id)
        );
        INSERT INTO taxonomy_inferences_v12 (source_node_id, target_node_id, confidence)
          SELECT source_node_id, inferred_node_id, confidence_weight FROM taxonomy_inferences;
        DROP TABLE taxonomy_inferences;
        ALTER TABLE taxonomy_inferences_v12 RENAME TO taxonomy_inferences;
      `)
    }
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS taxonomy_inferences (
        source_node_id TEXT NOT NULL REFERENCES taxonomy_nodes(id) ON DELETE CASCADE,
        target_node_id TEXT NOT NULL REFERENCES taxonomy_nodes(id) ON DELETE CASCADE,
        confidence REAL NOT NULL DEFAULT 1.0,
        PRIMARY KEY (source_node_id, target_node_id)
      );
    `)
  }

  // 6. Old prototype pull tables cleanup
  if (tables.has('pull_run_projects')) {
    db.exec('DROP TABLE IF EXISTS pull_run_projects;')
  }
  if (tables.has('pull_runs')) {
    const cols = (db.prepare('PRAGMA table_info(pull_runs)').all() as { name: string }[]).map(c => c.name)
    if (!cols.includes('platform')) {
      db.exec('DROP TABLE IF EXISTS pull_runs;')
    }
  }
  if (tables.has('pull_schedules')) {
    const cols = (db.prepare('PRAGMA table_info(pull_schedules)').all() as { name: string }[]).map(c => c.name)
    if (!cols.includes('grace_minutes')) {
      db.exec('DROP TABLE IF EXISTS pull_schedules;')
    }
  }

  // 7. Create remaining tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_labels (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL REFERENCES taxonomy_nodes(id) ON DELETE CASCADE,
      dimension TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      score REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      PRIMARY KEY (project_id, node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_labels_node ON project_labels(node_id, project_id);
    CREATE INDEX IF NOT EXISTS idx_labels_dim ON project_labels(dimension, project_id);

    CREATE TABLE IF NOT EXISTS project_nlp_state (
      project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      text_hash TEXT NOT NULL,
      taxonomy_version INTEGER NOT NULL,
      confidence REAL NOT NULL,
      status TEXT NOT NULL,
      dup_group_id TEXT,
      classified_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nlp_status ON project_nlp_state(status, confidence);
    CREATE INDEX IF NOT EXISTS idx_nlp_dup ON project_nlp_state(dup_group_id);

    CREATE TABLE IF NOT EXISTS daily_stats (
      day TEXT NOT NULL,
      platform TEXT NOT NULL,
      node_id TEXT NOT NULL REFERENCES taxonomy_nodes(id) ON DELETE CASCADE,
      jobs INTEGER NOT NULL,
      PRIMARY KEY (day, platform, node_id)
    );

    CREATE TABLE IF NOT EXISTS daily_coverage (
      day TEXT NOT NULL,
      platform TEXT NOT NULL,
      covered_minutes INTEGER NOT NULL,
      deep_synced INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, platform)
    );

    CREATE TABLE IF NOT EXISTS term_stats_daily (
      day TEXT NOT NULL,
      term TEXT NOT NULL,
      df INTEGER NOT NULL,
      PRIMARY KEY (day, term)
    );

    CREATE TABLE IF NOT EXISTS emerging_topics (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      top_terms_json TEXT NOT NULL,
      first_seen_day TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      mapped_node_id TEXT REFERENCES taxonomy_nodes(id) ON DELETE SET NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS analytics_presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      filter_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pull_policy (
      platform TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'interval',
      interval_seconds INTEGER NOT NULL DEFAULT 300,
      active_from TEXT,
      active_to TEXT,
      off_hours_interval_seconds INTEGER,
      adaptive INTEGER NOT NULL DEFAULT 0,
      adaptive_max_seconds INTEGER NOT NULL DEFAULT 1800,
      jitter_pct INTEGER NOT NULL DEFAULT 10,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pull_schedules (
      id TEXT PRIMARY KEY,
      label TEXT,
      time_of_day TEXT NOT NULL,
      days_of_week TEXT NOT NULL DEFAULT '*',
      platforms_json TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      grace_minutes INTEGER NOT NULL DEFAULT 30,
      next_due_at INTEGER,
      last_triggered_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pull_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT REFERENCES pull_schedules(id) ON DELETE SET NULL,
      platform TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT NOT NULL,
      total_fetched INTEGER NOT NULL DEFAULT 0,
      new_projects_count INTEGER NOT NULL DEFAULT 0,
      error_summary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pull_runs_started ON pull_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS pull_stats_hourly (
      hour_start INTEGER NOT NULL,
      platform TEXT NOT NULL,
      pulls INTEGER NOT NULL DEFAULT 0,
      new_projects INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (hour_start, platform)
    );

    CREATE TABLE IF NOT EXISTS project_status (
      project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'unknown',
      status_raw TEXT,
      first_status TEXT,
      changed_at INTEGER,
      proposals_count INTEGER,
      last_checked_at INTEGER,
      next_check_at INTEGER,
      checks_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_status_value ON project_status(status);
    CREATE INDEX IF NOT EXISTS idx_status_next ON project_status(next_check_at);

    CREATE TABLE IF NOT EXISTS project_status_log (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      checked_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      status_raw TEXT,
      PRIMARY KEY (project_id, checked_at)
    );

    CREATE TABLE IF NOT EXISTS status_label_map (
      platform TEXT NOT NULL,
      raw_label TEXT NOT NULL,
      canonical TEXT NOT NULL,
      PRIMARY KEY (platform, raw_label)
    );

    CREATE TABLE IF NOT EXISTS sync_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      platforms_json TEXT NOT NULL,
      range_from INTEGER,
      range_to INTEGER,
      include_details INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL,
      checkpoint_json TEXT,
      progress_json TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      error_summary TEXT
    );
  `)
}

export type MigrationStep = string | ((db: Db) => void)

const MIGRATIONS: MigrationStep[] = [
  /* 1 */ `
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL DEFAULT 'mostaql',
    external_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    description_excerpt TEXT NOT NULL DEFAULT '',
    published_at TEXT NULL,
    published_raw TEXT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    discovery_kind TEXT NOT NULL,
    read_at TEXT NULL,
    category_slug TEXT NULL,
    category_name TEXT NULL,
    category_confirmed INTEGER NOT NULL DEFAULT 0,
    skills_json TEXT NULL,
    budget_min REAL NULL,
    budget_max REAL NULL,
    currency TEXT NULL,
    budget_raw TEXT NULL,
    enrichment_status TEXT NOT NULL DEFAULT 'not_requested',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(source, external_id)
  );
  CREATE INDEX IF NOT EXISTS idx_projects_seen ON projects(first_seen_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_projects_unread ON projects(read_at);
  CREATE INDEX IF NOT EXISTS idx_projects_category ON projects(category_slug);
  CREATE TABLE IF NOT EXISTS source_state (
    source TEXT PRIMARY KEY,
    baseline_complete INTEGER NOT NULL DEFAULT 0,
    last_success_at TEXT NULL,
    last_attempt_at TEXT NULL,
    last_error TEXT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    backoff_until TEXT NULL,
    transport_kind TEXT NOT NULL DEFAULT 'rss',
    run_id TEXT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notification_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'new_project',
    status TEXT NOT NULL DEFAULT 'pending',
    session_id TEXT NULL,
    attempted_at TEXT NULL,
    batch_key TEXT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, kind)
  );
  CREATE INDEX IF NOT EXISTS idx_notify_status ON notification_events(status);
  CREATE TABLE IF NOT EXISTS notification_batches (
    batch_key TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    event_count INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS diagnostics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    endpoint_kind TEXT NOT NULL,
    status TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    item_count INTEGER NULL,
    error_category TEXT NULL,
    detail TEXT NULL
  );
  `,
  /* 2 */ `
  CREATE TABLE IF NOT EXISTS pending_classifications (
    project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    deadline_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_classification_deadline ON pending_classifications(deadline_at);
  `,
  /* 3 */ `
  CREATE TABLE IF NOT EXISTS project_user_state (
    project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    saved_at TEXT NULL,
    hidden_at TEXT NULL,
    personal_status TEXT NOT NULL DEFAULT 'none',
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS project_details (
    project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    description_text TEXT NULL,
    provenance TEXT NULL,
    fetched_at TEXT NULL,
    status TEXT NOT NULL DEFAULT 'not_requested',
    error_code TEXT NULL
  );
  CREATE TABLE IF NOT EXISTS saved_filters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tombstones (
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    deleted_at TEXT NOT NULL,
    PRIMARY KEY (source, external_id)
  );
  `,
  /* 4 */ `
  CREATE TABLE IF NOT EXISTS proposal_drafts (
    project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    proposal TEXT NOT NULL,
    assumptions_json TEXT NOT NULL DEFAULT '[]',
    questions_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );
  `,
  /* 5 */ `
  CREATE TABLE IF NOT EXISTS quick_apply_tickets (
    ticket TEXT PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER NULL
  );
  CREATE INDEX IF NOT EXISTS idx_quick_ticket_expiry ON quick_apply_tickets(expires_at);
  `
  ,/* 6 */ `
  CREATE TABLE IF NOT EXISTS extension_jobs (
    ticket TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    phase TEXT NOT NULL DEFAULT 'issued',
    expires_at INTEGER NOT NULL,
    activated_at INTEGER,
    client_id TEXT,
    tab_id INTEGER,
    error TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_extension_jobs_expiry ON extension_jobs(expires_at);
  `
  ,/* 7 */ `
  ALTER TABLE proposal_drafts ADD COLUMN provider TEXT NULL;
  ALTER TABLE proposal_drafts ADD COLUMN model TEXT NULL;
  ALTER TABLE proposal_drafts ADD COLUMN prompt_version TEXT NULL;
  ALTER TABLE proposal_drafts ADD COLUMN generated_at TEXT NULL;
  `,/* 8 */ `
  ALTER TABLE projects ADD COLUMN platform_status TEXT NULL;
  ALTER TABLE projects ADD COLUMN duration_days INTEGER NULL;
  ALTER TABLE projects ADD COLUMN duration_raw TEXT NULL;
  `,/* 9 */ `
  CREATE TABLE IF NOT EXISTS notification_activations (
    token_hash TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    project_id INTEGER NULL,
    expires_at INTEGER NOT NULL,
    last_attempt_at INTEGER NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notification_activation_expiry ON notification_activations(expires_at);
  `
  ,/* 10 */ `
  CREATE TABLE project_search_cache (
    project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    normalization_version INTEGER NOT NULL,
    published_sort_ms REAL NULL,
    title_norm TEXT NOT NULL,
    excerpt_norm TEXT NOT NULL,
    skills_norm TEXT NOT NULL,
    keywords_norm TEXT NOT NULL,
    body_short TEXT NOT NULL
  );
  CREATE TABLE project_search_body (project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, body_norm TEXT NOT NULL);
  CREATE VIRTUAL TABLE project_search_fts USING fts5(text,content='',contentless_delete=1,detail=none,tokenize='trigram case_sensitive 1');
  CREATE TABLE project_search_dirty (project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE);
  CREATE TABLE project_search_state (id INTEGER PRIMARY KEY CHECK(id=1), normalization_version INTEGER NOT NULL, backfill_complete INTEGER NOT NULL);
  INSERT INTO project_search_state VALUES(1,1,0);
  INSERT INTO project_search_dirty SELECT id FROM projects;
  CREATE INDEX idx_projects_source_seen ON projects(source,first_seen_at DESC,id DESC);
  CREATE TRIGGER search_project_insert AFTER INSERT ON projects BEGIN
    INSERT INTO project_search_dirty VALUES(NEW.id) ON CONFLICT DO NOTHING;
    UPDATE project_search_state SET backfill_complete=0;
  END;
  CREATE TRIGGER search_project_update AFTER UPDATE OF title,description_excerpt,skills_json,published_at ON projects
  WHEN OLD.title IS NOT NEW.title OR OLD.description_excerpt IS NOT NEW.description_excerpt OR OLD.skills_json IS NOT NEW.skills_json OR OLD.published_at IS NOT NEW.published_at BEGIN
    DELETE FROM project_search_cache WHERE project_id=NEW.id;
    DELETE FROM project_search_body WHERE project_id=NEW.id;
    DELETE FROM project_search_fts WHERE rowid=NEW.id;
    INSERT INTO project_search_dirty VALUES(NEW.id) ON CONFLICT DO NOTHING;
    UPDATE project_search_state SET backfill_complete=0;
  END;
  CREATE TRIGGER search_project_delete AFTER DELETE ON projects BEGIN
    DELETE FROM project_search_body WHERE project_id=OLD.id;
    DELETE FROM project_search_fts WHERE rowid=OLD.id;
    DELETE FROM project_search_cache WHERE project_id=OLD.id;
    DELETE FROM project_search_dirty WHERE project_id=OLD.id;
  END;
  CREATE TRIGGER search_details_insert AFTER INSERT ON project_details BEGIN
    DELETE FROM project_search_body WHERE project_id=NEW.project_id;
    DELETE FROM project_search_fts WHERE rowid=NEW.project_id;
    DELETE FROM project_search_cache WHERE project_id=NEW.project_id;
    INSERT INTO project_search_dirty SELECT NEW.project_id WHERE EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id) ON CONFLICT DO NOTHING;
    UPDATE project_search_state SET backfill_complete=0;
  END;
  CREATE TRIGGER search_details_update AFTER UPDATE OF description_text,project_id ON project_details
  WHEN OLD.description_text IS NOT NEW.description_text OR OLD.project_id IS NOT NEW.project_id BEGIN
    DELETE FROM project_search_body WHERE project_id IN (OLD.project_id,NEW.project_id);
    DELETE FROM project_search_fts WHERE rowid IN (OLD.project_id,NEW.project_id);
    DELETE FROM project_search_cache WHERE project_id IN (OLD.project_id,NEW.project_id);
    INSERT INTO project_search_dirty SELECT id FROM projects WHERE id IN (OLD.project_id,NEW.project_id) ON CONFLICT DO NOTHING;
    UPDATE project_search_state SET backfill_complete=0;
  END;
  CREATE TRIGGER search_details_delete AFTER DELETE ON project_details BEGIN
    DELETE FROM project_search_body WHERE project_id=OLD.project_id;
    DELETE FROM project_search_fts WHERE rowid=OLD.project_id;
    DELETE FROM project_search_cache WHERE project_id=OLD.project_id;
    INSERT INTO project_search_dirty SELECT OLD.project_id WHERE EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) ON CONFLICT DO NOTHING;
    UPDATE project_search_state SET backfill_complete=0;
  END;
  `
  ,/* 11 */ `
  CREATE TABLE project_watch (
    project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('active','waiting','stopped')),
    origin TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    generation INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0,
    waiting_since TEXT NULL,
    started_at TEXT NULL,
    stopped_at TEXT NULL,
    stop_reason TEXT NULL,
    auto_start_blocked INTEGER NOT NULL DEFAULT 0,
    status TEXT NULL,
    offers INTEGER NULL,
    offers_capped INTEGER NOT NULL DEFAULT 0,
    contacts INTEGER NULL,
    client_open INTEGER NULL,
    client_in_progress INTEGER NULL,
    status_seen_at TEXT NULL,
    detail_seen_at TEXT NULL,
    last_attempt_at TEXT NULL,
    last_changed_at TEXT NULL,
    next_due_at TEXT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NULL
  );
  CREATE INDEX idx_project_watch_state ON project_watch(state, waiting_since, project_id);
  CREATE TABLE watch_source_state (
    source TEXT PRIMARY KEY,
    slot_ms INTEGER NOT NULL,
    success_streak INTEGER NOT NULL DEFAULT 0,
    paused_until TEXT NULL,
    blocked_at TEXT NULL,
    needs_poll_success INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE watch_episode (
    id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL,
    deadline_at TEXT NOT NULL,
    summary_state TEXT NOT NULL DEFAULT 'open' CHECK (summary_state IN ('open','reserved','done'))
  );
  CREATE TABLE watch_episode_member (
    episode_id INTEGER NOT NULL REFERENCES watch_episode(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL,
    observed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (episode_id, project_id)
  );
  CREATE TABLE notification_events_v11 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'new_project',
    status TEXT NOT NULL DEFAULT 'pending',
    session_id TEXT NULL,
    attempted_at TEXT NULL,
    batch_key TEXT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    dedupe_key TEXT NOT NULL DEFAULT '',
    payload TEXT NULL,
    episode_id INTEGER NULL,
    UNIQUE(project_id, kind, dedupe_key)
  );
  INSERT INTO notification_events_v11 (
    id, project_id, kind, status, session_id, attempted_at, batch_key, created_at, updated_at
  )
  SELECT
    id, project_id, kind, status, session_id, attempted_at, batch_key, created_at, updated_at
  FROM notification_events
  ORDER BY id;
  UPDATE sqlite_sequence
    SET seq = (SELECT seq FROM sqlite_sequence WHERE name = 'notification_events')
    WHERE name = 'notification_events_v11'
      AND (SELECT seq FROM sqlite_sequence WHERE name = 'notification_events') > seq;
  INSERT INTO sqlite_sequence (name, seq)
    SELECT 'notification_events_v11', seq
    FROM sqlite_sequence
    WHERE name = 'notification_events'
      AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'notification_events_v11');
  DROP TABLE notification_events;
  ALTER TABLE notification_events_v11 RENAME TO notification_events;
  CREATE INDEX idx_notify_status ON notification_events(status);
  ALTER TABLE notification_activations ADD COLUMN origin TEXT NOT NULL DEFAULT 'notification';
  `,
  /* 12 */ migrateToSchema12
]

export const SCHEMA_VERSION = MIGRATIONS.length

export function applyMigrations(db: Db): void {
  const row = db.prepare('PRAGMA user_version;').get() as { user_version: number }
  const current = row.user_version ?? 0
  if (current > SCHEMA_VERSION) throw Error('newer-schema')
  for (let i = current; i < MIGRATIONS.length; i++) {
    const step = MIGRATIONS[i]
    if (!step) continue
    db.exec('BEGIN;')
    try {
      if (typeof step === 'function') {
        step(db)
      } else {
        db.exec(step)
      }
      db.exec(`PRAGMA user_version = ${i + 1};`)
      db.exec('COMMIT;')
    } catch (err) {
      try {
        db.exec('ROLLBACK;')
      } catch {
        /* already rolled back */
      }
      throw err
    }
  }
}
