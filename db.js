const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let db = null;
let SQL = null;

const dbPath = path.join(__dirname, 'data', 'water_system.db');

function ensureDataDir() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadDatabase() {
  ensureDataDir();
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    return new SQL.Database(fileBuffer);
  }
  return new SQL.Database();
}

function saveDatabase() {
  if (db) {
    ensureDataDir();
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }
}

function escapeString(str) {
  if (str === null || str === undefined) return 'NULL';
  if (typeof str === 'number') return str.toString();
  return "'" + str.toString().replace(/'/g, "''") + "'";
}

function prepare(sql) {
  if (!db) throw new Error('Database not initialized');
  
  return {
    run: function(...params) {
      const stmt = db.prepare(sql);
      stmt.reset();
      if (params.length > 0) {
        stmt.bind(params);
      }
      stmt.step();
      const lastId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
      const changes = db.getRowsModified();
      stmt.free();
      saveDatabase();
      return {
        changes: changes,
        lastInsertRowid: lastId
      };
    },
    get: function(...params) {
      const stmt = db.prepare(sql);
      if (params.length > 0) {
        stmt.bind(params);
      }
      let result = undefined;
      if (stmt.step()) {
        result = stmt.getAsObject();
      }
      stmt.free();
      return result;
    },
    all: function(...params) {
      const stmt = db.prepare(sql);
      if (params.length > 0) {
        stmt.bind(params);
      }
      const result = [];
      while (stmt.step()) {
        result.push(stmt.getAsObject());
      }
      stmt.free();
      return result;
    }
  };
}

function exec(sql) {
  if (!db) throw new Error('Database not initialized');
  db.exec(sql);
  saveDatabase();
}

function pragma(sql) {
  if (!db) throw new Error('Database not initialized');
  db.exec(`PRAGMA ${sql}`);
}

async function initDatabase() {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  
  if (!db) {
    db = loadDatabase();
  }
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS canal_segments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      length REAL NOT NULL,
      bottom_width REAL NOT NULL,
      side_slope REAL NOT NULL,
      manning_n REAL NOT NULL,
      bed_slope REAL NOT NULL,
      design_water_level REAL NOT NULL,
      bottom_elevation REAL NOT NULL,
      upstream_node_id TEXT,
      downstream_node_id TEXT,
      order_index INTEGER NOT NULL,
      siltation_depth REAL NOT NULL DEFAULT 0,
      start_latitude REAL,
      start_longitude REAL,
      end_latitude REAL,
      end_longitude REAL
    );

    CREATE TABLE IF NOT EXISTS gates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('regulator', 'diversion')),
      max_opening REAL NOT NULL,
      current_opening REAL NOT NULL,
      gate_width REAL NOT NULL,
      discharge_coeff REAL NOT NULL DEFAULT 0.62,
      canal_segment_id TEXT,
      position_on_segment REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('junction', 'boundary')),
      upstream_segment_id TEXT,
      downstream_segment_id TEXT,
      gate_id TEXT
    );

    CREATE TABLE IF NOT EXISTS measurement_points (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      canal_segment_id TEXT NOT NULL,
      distance_from_upstream REAL NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('upstream_gate', 'downstream_gate', 'intermediate')),
      gate_id TEXT,
      latitude REAL,
      longitude REAL
    );

    CREATE TABLE IF NOT EXISTS water_level_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      point_id TEXT NOT NULL,
      water_level REAL NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_water_level_history_point_time 
      ON water_level_history(point_id, timestamp);

    CREATE TABLE IF NOT EXISTS system_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS siltation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      segment_id TEXT NOT NULL,
      siltation_depth REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_siltation_history_seg_time
      ON siltation_history(segment_id, timestamp);

    CREATE TABLE IF NOT EXISTS work_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL UNIQUE,
      segment_id TEXT NOT NULL,
      current_siltation REAL NOT NULL,
      target_siltation REAL NOT NULL DEFAULT 0,
      planned_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed')),
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_work_orders_status
      ON work_orders(status);
    CREATE INDEX IF NOT EXISTS idx_work_orders_segment
      ON work_orders(segment_id);

    CREATE TABLE IF NOT EXISTS patrol_routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      estimated_duration_minutes INTEGER NOT NULL,
      total_length REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS patrol_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id INTEGER NOT NULL,
      order_index INTEGER NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      canal_segment_id TEXT NOT NULL,
      description TEXT,
      FOREIGN KEY (route_id) REFERENCES patrol_routes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_patrol_checkpoints_route
      ON patrol_checkpoints(route_id, order_index);

    CREATE TABLE IF NOT EXISTS patrol_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id INTEGER NOT NULL,
      inspector_name TEXT NOT NULL,
      planned_start_time INTEGER NOT NULL,
      start_time INTEGER,
      end_time INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'timeout')),
      created_at INTEGER NOT NULL,
      FOREIGN KEY (route_id) REFERENCES patrol_routes(id)
    );

    CREATE INDEX IF NOT EXISTS idx_patrol_tasks_route
      ON patrol_tasks(route_id);
    CREATE INDEX IF NOT EXISTS idx_patrol_tasks_status
      ON patrol_tasks(status);

    CREATE TABLE IF NOT EXISTS patrol_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      checkpoint_id INTEGER,
      FOREIGN KEY (task_id) REFERENCES patrol_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (checkpoint_id) REFERENCES patrol_checkpoints(id)
    );

    CREATE INDEX IF NOT EXISTS idx_patrol_tracks_task
      ON patrol_tracks(task_id, timestamp);

    CREATE TABLE IF NOT EXISTS patrol_anomalies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('crack', 'leak', 'blockage', 'erosion', 'other')),
      description TEXT,
      severity TEXT NOT NULL CHECK(severity IN ('low', 'medium', 'high')),
      segment_id TEXT NOT NULL,
      distance_to_segment REAL NOT NULL,
      measurement_point_id TEXT,
      distance_to_point REAL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES patrol_tasks(id),
      FOREIGN KEY (segment_id) REFERENCES canal_segments(id),
      FOREIGN KEY (measurement_point_id) REFERENCES measurement_points(id)
    );

    CREATE INDEX IF NOT EXISTS idx_patrol_anomalies_task
      ON patrol_anomalies(task_id);
    CREATE INDEX IF NOT EXISTS idx_patrol_anomalies_segment
      ON patrol_anomalies(segment_id);
    CREATE INDEX IF NOT EXISTS idx_patrol_anomalies_type
      ON patrol_anomalies(type);
    CREATE INDEX IF NOT EXISTS idx_patrol_anomalies_severity
      ON patrol_anomalies(severity);
    CREATE INDEX IF NOT EXISTS idx_patrol_anomalies_time
      ON patrol_anomalies(timestamp);
  `);
  
  saveDatabase();
  
  try {
    db.exec(`ALTER TABLE canal_segments ADD COLUMN siltation_depth REAL NOT NULL DEFAULT 0`);
    saveDatabase();
  } catch (e) {}
}

module.exports = {
  initDatabase,
  prepare,
  exec,
  pragma,
  getDb: () => db,
  saveDatabase,
  escapeString
};
