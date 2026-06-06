const { writeAuditLog } = require('../services/auditService');
const { prepare } = require('../db');
const stateManager = require('../services/stateManager');

function getOperatorFromRequest(req) {
  return req.get('X-Operator') || 'system';
}

function getSourceIp(req) {
  return req.ip || (req.connection && req.connection.remoteAddress) || null;
}

function captureGateState(gateId) {
  const gate = prepare('SELECT * FROM gates WHERE id = ?').get(gateId);
  const lockInfo = stateManager.getGateLockInfo(gateId);
  const gateState = stateManager.getGateState(gateId);
  return {
    gate,
    gateState,
    lockInfo
  };
}

function captureSegmentState(segmentId) {
  const seg = prepare('SELECT * FROM canal_segments WHERE id = ?').get(segmentId);
  return seg;
}

function captureMaintenancePlanState(planId) {
  return prepare('SELECT * FROM maintenance_plans WHERE id = ?').get(parseInt(planId));
}

function captureDispatchState() {
  const gates = prepare('SELECT * FROM gates').all();
  const gateStates = {};
  for (const g of gates) {
    gateStates[g.id] = stateManager.getGateState(g.id);
  }
  return {
    gates,
    gateStates
  };
}

function captureEmergencyExecutionState(planId) {
  return prepare('SELECT * FROM emergency_plans WHERE id = ?').get(parseInt(planId));
}

function determineAuditConfig(req) {
  const method = req.method;
  const path = req.path;

  if (method === 'PUT' && /^\/api\/gates\/[^/]+(\/target-opening)?$/.test(path)) {
    const gateId = path.split('/')[3];
    return {
      enabled: true,
      operationType: 'gate_adjust',
      targetId: gateId,
      captureBefore: () => captureGateState(gateId),
      captureAfter: () => captureGateState(gateId)
    };
  }

  if (method === 'PUT' && /^\/api\/segments\/[^/]+\/siltation$/.test(path)) {
    const segmentId = path.split('/')[3];
    return {
      enabled: true,
      operationType: 'siltation_set',
      targetId: segmentId,
      captureBefore: () => captureSegmentState(segmentId),
      captureAfter: () => captureSegmentState(segmentId)
    };
  }

  if (method === 'PUT' && /^\/api\/maintenance\/plans\/[^/]+\/start$/.test(path)) {
    const planId = path.split('/')[4];
    return {
      enabled: true,
      operationType: 'maintenance_start',
      targetId: planId,
      captureBefore: () => captureMaintenancePlanState(planId),
      captureAfter: () => captureMaintenancePlanState(planId)
    };
  }

  if (method === 'PUT' && /^\/api\/maintenance\/plans\/[^/]+\/complete$/.test(path)) {
    const planId = path.split('/')[4];
    return {
      enabled: true,
      operationType: 'maintenance_complete',
      targetId: planId,
      captureBefore: () => captureMaintenancePlanState(planId),
      captureAfter: () => captureMaintenancePlanState(planId)
    };
  }

  if (method === 'POST' && path === '/api/dispatch/apply') {
    return {
      enabled: true,
      operationType: 'dispatch_apply',
      targetId: null,
      captureBefore: () => captureDispatchState(),
      captureAfter: () => captureDispatchState()
    };
  }

  if (method === 'POST' && /^\/api\/emergency\/(execute|simulate)\/[^/]+$/.test(path)) {
    const planId = path.split('/')[4];
    return {
      enabled: true,
      operationType: 'emergency_execute',
      targetId: planId,
      captureBefore: () => captureEmergencyExecutionState(planId),
      captureAfter: () => captureEmergencyExecutionState(planId)
    };
  }

  if (method === 'POST' && path === '/api/telemetry/batch') {
    return {
      enabled: true,
      operationType: 'telemetry_batch',
      targetId: null,
      captureBefore: () => ({ batchSize: req.body && req.body.data ? req.body.data.length : 0 }),
      captureAfter: () => null
    };
  }

  return { enabled: false };
}

function auditMiddleware(req, res, next) {
  const config = determineAuditConfig(req);
  if (!config.enabled) {
    return next();
  }

  let beforeState;
  try {
    beforeState = config.captureBefore ? config.captureBefore() : null;
  } catch (err) {
    beforeState = { error: err.message };
  }

  const operator = getOperatorFromRequest(req);
  const sourceIp = getSourceIp(req);
  const requestBody = { ...req.body };

  const originalJson = res.json.bind(res);
  let responseBody = null;
  let responseStatus = null;

  res.json = function(body) {
    responseBody = body;
    responseStatus = res.statusCode;
    return originalJson(body);
  };

  res.on('finish', () => {
    try {
      let afterState;
      try {
        afterState = config.captureAfter ? config.captureAfter() : null;
      } catch (err) {
        afterState = { error: err.message };
      }

      let operationType = config.operationType;
      let deniedReason = null;

      const isDenied = responseStatus === 403 ||
        (responseStatus === 400 && responseBody && typeof responseBody.error &&
         (String(responseBody.error).includes('锁定') ||
          String(responseBody.error).includes('拒绝')));

      if (isDenied) {
        operationType = 'operation_denied';
        deniedReason = responseBody ? responseBody.error : null;
      }

      writeAuditLog({
        operationType,
        operator,
        targetId: config.targetId,
        beforeState,
        afterState,
        sourceIp,
        requestBody,
        responseStatus,
        responseBody,
        deniedReason
      });
    } catch (auditErr) {
      console.error('审计日志写入失败:', auditErr.message);
    }
  });

  next();
}

module.exports = {
  auditMiddleware,
  getOperatorFromRequest,
  getSourceIp,
  determineAuditConfig
};
