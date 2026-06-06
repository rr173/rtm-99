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

    CREATE TABLE IF NOT EXISTS patrol_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL UNIQUE,
      inspector_name TEXT NOT NULL,
      route_name TEXT NOT NULL,
      route_id INTEGER NOT NULL,
      start_time INTEGER,
      end_time INTEGER,
      duration_minutes REAL,
      total_distance_meters REAL NOT NULL DEFAULT 0,
      total_checkpoints INTEGER NOT NULL DEFAULT 0,
      signed_checkpoints INTEGER NOT NULL DEFAULT 0,
      completion_rate REAL NOT NULL DEFAULT 0,
      quality_score REAL NOT NULL DEFAULT 0,
      completion_score REAL NOT NULL DEFAULT 0,
      speed_score REAL NOT NULL DEFAULT 0,
      anomaly_score REAL NOT NULL DEFAULT 0,
      timeliness_score REAL NOT NULL DEFAULT 0,
      anomaly_total INTEGER NOT NULL DEFAULT 0,
      anomaly_by_type TEXT,
      anomaly_by_severity TEXT,
      checkpoints_detail TEXT,
      generated_at INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES patrol_tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_patrol_reports_task
      ON patrol_reports(task_id);
    CREATE INDEX IF NOT EXISTS idx_patrol_reports_inspector
      ON patrol_reports(inspector_name);
    CREATE INDEX IF NOT EXISTS idx_patrol_reports_score
      ON patrol_reports(quality_score);
    CREATE INDEX IF NOT EXISTS idx_patrol_reports_generated
      ON patrol_reports(generated_at);

    CREATE TABLE IF NOT EXISTS water_balance_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      calculation_time INTEGER NOT NULL,
      segment_id TEXT NOT NULL,
      segment_name TEXT NOT NULL,
      window_minutes INTEGER NOT NULL,
      inflow_volume REAL NOT NULL DEFAULT 0,
      outflow_volume REAL NOT NULL DEFAULT 0,
      storage_change REAL NOT NULL DEFAULT 0,
      imbalance_volume REAL NOT NULL DEFAULT 0,
      imbalance_rate REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'normal',
      warning_threshold REAL NOT NULL DEFAULT 5,
      alarm_threshold REAL NOT NULL DEFAULT 15
    );

    CREATE INDEX IF NOT EXISTS idx_water_balance_records_time
      ON water_balance_records(calculation_time);
    CREATE INDEX IF NOT EXISTS idx_water_balance_records_segment
      ON water_balance_records(segment_id);
    CREATE INDEX IF NOT EXISTS idx_water_balance_records_seg_time
      ON water_balance_records(segment_id, calculation_time);

    CREATE TABLE IF NOT EXISTS water_balance_thresholds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      segment_id TEXT NOT NULL UNIQUE,
      warning_threshold REAL NOT NULL DEFAULT 5,
      alarm_threshold REAL NOT NULL DEFAULT 15,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_water_balance_thresholds_segment
      ON water_balance_thresholds(segment_id);

    CREATE TABLE IF NOT EXISTS emergency_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 3 CHECK(priority BETWEEN 1 AND 5),
      enabled INTEGER NOT NULL DEFAULT 1,
      effective_start_time TEXT,
      effective_end_time TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_emergency_plans_enabled ON emergency_plans(enabled);
    CREATE INDEX IF NOT EXISTS idx_emergency_plans_priority ON emergency_plans(priority);

    CREATE TABLE IF NOT EXISTS emergency_plan_conditions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('water_level', 'gate_fault', 'flow_change')),
      target_id TEXT NOT NULL,
      operator TEXT NOT NULL,
      threshold REAL NOT NULL,
      tolerance REAL,
      duration_seconds INTEGER,
      FOREIGN KEY (plan_id) REFERENCES emergency_plans(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_emergency_conditions_plan ON emergency_plan_conditions(plan_id);

    CREATE TABLE IF NOT EXISTS emergency_plan_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      order_index INTEGER NOT NULL,
      gate_id TEXT NOT NULL,
      target_opening REAL NOT NULL,
      adjustment_type TEXT NOT NULL CHECK(adjustment_type IN ('absolute', 'relative')),
      FOREIGN KEY (plan_id) REFERENCES emergency_plans(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_emergency_actions_plan ON emergency_plan_actions(plan_id);
    CREATE INDEX IF NOT EXISTS idx_emergency_actions_order ON emergency_plan_actions(plan_id, order_index);

    CREATE TABLE IF NOT EXISTS emergency_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      plan_name TEXT NOT NULL,
      trigger_reason TEXT NOT NULL,
      execution_type TEXT NOT NULL CHECK(execution_type IN ('simulate', 'real')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed')),
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      initial_state TEXT,
      final_state TEXT,
      risk_assessment TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_emergency_executions_time ON emergency_executions(started_at);
    CREATE INDEX IF NOT EXISTS idx_emergency_executions_status ON emergency_executions(status);

    CREATE TABLE IF NOT EXISTS emergency_execution_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id INTEGER NOT NULL,
      order_index INTEGER NOT NULL,
      gate_id TEXT NOT NULL,
      target_opening REAL NOT NULL,
      previous_opening REAL,
      actual_opening REAL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'success', 'failed', 'skipped')),
      error_message TEXT,
      executed_at INTEGER,
      FOREIGN KEY (execution_id) REFERENCES emergency_executions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_emergency_exec_actions_exec ON emergency_execution_actions(execution_id);

    CREATE TABLE IF NOT EXISTS link_monitor_heartbeats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      point_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'rtu' CHECK(source IN ('rtu', 'heartbeat', 'simulated'))
    );

    CREATE INDEX IF NOT EXISTS idx_link_monitor_heartbeats_point ON link_monitor_heartbeats(point_id);
    CREATE INDEX IF NOT EXISTS idx_link_monitor_heartbeats_time ON link_monitor_heartbeats(timestamp);
    CREATE INDEX IF NOT EXISTS idx_link_monitor_heartbeats_point_time ON link_monitor_heartbeats(point_id, timestamp);

    CREATE TABLE IF NOT EXISTS link_monitor_diagnostics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      point_id TEXT NOT NULL,
      diagnosis_time INTEGER NOT NULL,
      window_hours INTEGER NOT NULL DEFAULT 6,
      packet_loss_rate REAL NOT NULL DEFAULT 0,
      jump_count INTEGER NOT NULL DEFAULT 0,
      jump_details TEXT,
      stuck_duration_seconds INTEGER NOT NULL DEFAULT 0,
      stuck_periods TEXT,
      out_of_bounds_count INTEGER NOT NULL DEFAULT 0,
      out_of_bounds_details TEXT,
      std_dev REAL NOT NULL DEFAULT 0,
      noise_level TEXT NOT NULL DEFAULT 'normal',
      quality_score REAL NOT NULL DEFAULT 0,
      link_status TEXT NOT NULL DEFAULT 'unknown'
    );

    CREATE INDEX IF NOT EXISTS idx_link_monitor_diagnostics_point ON link_monitor_diagnostics(point_id);
    CREATE INDEX IF NOT EXISTS idx_link_monitor_diagnostics_time ON link_monitor_diagnostics(diagnosis_time);

    CREATE TABLE IF NOT EXISTS dispatch_irrigations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      gate_id TEXT NOT NULL,
      daily_quota REAL NOT NULL,
      priority INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 5),
      min_flow REAL NOT NULL,
      max_flow REAL NOT NULL,
      daily_taken REAL NOT NULL DEFAULT 0,
      last_calc_time INTEGER,
      quota_date TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_dispatch_irrigations_priority ON dispatch_irrigations(priority);
    CREATE INDEX IF NOT EXISTS idx_dispatch_irrigations_gate ON dispatch_irrigations(gate_id);

    CREATE TABLE IF NOT EXISTS dispatch_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      inflow_rate REAL NOT NULL,
      total_allocated REAL NOT NULL DEFAULT 0,
      maintenance_flow REAL NOT NULL DEFAULT 0,
      allocation_efficiency REAL NOT NULL DEFAULT 0,
      is_applied INTEGER NOT NULL DEFAULT 0,
      allocations_json TEXT NOT NULL,
      under_provisioned_json TEXT,
      warnings_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_dispatch_records_time ON dispatch_records(timestamp);

    CREATE TABLE IF NOT EXISTS dispatch_daily_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      total_supply REAL NOT NULL DEFAULT 0,
      total_taken REAL NOT NULL DEFAULT 0,
      total_loss REAL NOT NULL DEFAULT 0,
      irrigations_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_dispatch_daily_summary_date ON dispatch_daily_summary(date);

    CREATE TABLE IF NOT EXISTS patrol_work_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL UNIQUE,
      anomaly_id INTEGER NOT NULL,
      anomaly_type TEXT NOT NULL,
      anomaly_severity TEXT NOT NULL CHECK(anomaly_severity IN ('low', 'medium', 'high')),
      segment_id TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'assigned', 'processing', 'verifying', 'closed', 'rejected')),
      created_at INTEGER NOT NULL,
      assigned_at INTEGER,
      assigned_by TEXT,
      handler_name TEXT,
      deadline INTEGER,
      process_description TEXT,
      process_measures TEXT,
      processed_at INTEGER,
      verify_result TEXT,
      verify_opinion TEXT,
      verified_at INTEGER,
      closed_at INTEGER,
      escalation_count INTEGER NOT NULL DEFAULT 0,
      last_escalated_at INTEGER,
      notes TEXT,
      FOREIGN KEY (anomaly_id) REFERENCES patrol_anomalies(id),
      FOREIGN KEY (segment_id) REFERENCES canal_segments(id)
    );

    CREATE INDEX IF NOT EXISTS idx_patrol_work_orders_status ON patrol_work_orders(status);
    CREATE INDEX IF NOT EXISTS idx_patrol_work_orders_anomaly ON patrol_work_orders(anomaly_id);
    CREATE INDEX IF NOT EXISTS idx_patrol_work_orders_segment ON patrol_work_orders(segment_id);
    CREATE INDEX IF NOT EXISTS idx_patrol_work_orders_handler ON patrol_work_orders(handler_name);
    CREATE INDEX IF NOT EXISTS idx_patrol_work_orders_created ON patrol_work_orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_patrol_work_orders_deadline ON patrol_work_orders(deadline);

    CREATE TABLE IF NOT EXISTS patrol_work_order_timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL,
      status_from TEXT,
      status_to TEXT NOT NULL,
      operator TEXT,
      remark TEXT,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (work_order_id) REFERENCES patrol_work_orders(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_patrol_work_order_timeline_wo ON patrol_work_order_timeline(work_order_id, timestamp);
  `);
  
  saveDatabase();
  
  try {
    db.exec(`ALTER TABLE canal_segments ADD COLUMN siltation_depth REAL NOT NULL DEFAULT 0`);
    saveDatabase();
  } catch (e) {}

  try {
    db.exec(`ALTER TABLE patrol_work_orders ADD COLUMN last_escalated_at INTEGER`);
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
