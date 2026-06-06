const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const { initDatabase } = require('./db');
const { initDemoTopology, generateHistoricalData, initSiltationDemoData, initGeoCoordinates, initDemoPatrolRoute } = require('./models/initData');
const { initState } = require('./services/stateManager');

const topologyRoutes = require('./routes/topology');
const telemetryRoutes = require('./routes/telemetry');
const gatesRoutes = require('./routes/gates');
const predictRoutes = require('./routes/predict');
const conflictsRoutes = require('./routes/conflicts');
const systemRoutes = require('./routes/system');
const siltationRoutes = require('./routes/siltation');
const patrolRoutes = require('./routes/patrol');
const waterBalanceRoutes = require('./routes/waterBalance');
const emergencyRoutes = require('./routes/emergency');
const linkMonitorRoutes = require('./routes/linkMonitor');
const dispatchRoutes = require('./routes/dispatch');
const maintenanceRoutes = require('./routes/maintenance');
const auditRoutes = require('./routes/audit');
const billingRoutes = require('./routes/billing');
const iceRoutes = require('./routes/ice');
const waterBalanceService = require('./services/waterBalanceService');
const dispatchService = require('./services/dispatchService');
const billingService = require('./services/billingService');
const iceService = require('./services/iceService');
const { initDemoEmergencyPlans, initLinkMonitorDemoData } = require('./models/initData');
const { auditMiddleware } = require('./middleware/auditMiddleware');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

app.use(express.static('public'));

app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

app.use(auditMiddleware);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    service: '水利渠道闸群联调与水位演算服务'
  });
});

app.use('/api/topology', topologyRoutes);
app.use('/api/segments', topologyRoutes);
app.use('/api/telemetry', telemetryRoutes);
app.use('/api/gates', gatesRoutes);
app.use('/api/predict', predictRoutes);
app.use('/api/conflicts', conflictsRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/siltation', siltationRoutes);
app.use('/api/patrol', patrolRoutes);
app.use('/api/water-balance', waterBalanceRoutes);
app.use('/api/emergency', emergencyRoutes);
app.use('/api/link-monitor', linkMonitorRoutes);
app.use('/api/dispatch', dispatchRoutes);
app.use('/api/maintenance', maintenanceRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/ice', iceRoutes);

app.use((req, res) => {
  res.status(404).json({
    error: '接口不存在',
    path: req.path
  });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: err.message || '服务器内部错误'
  });
});

async function startServer() {
  try {
    console.log('正在初始化数据库...');
    await initDatabase();
    
    console.log('正在加载演示拓扑...');
    initDemoTopology();
    
    console.log('正在初始化淤积演示数据...');
    initSiltationDemoData();
    
    console.log('正在生成模拟历史数据...');
    generateHistoricalData();
    
    console.log('正在初始化运行状态...');
    initState();
    
    console.log('正在初始化地理坐标映射...');
    initGeoCoordinates();
    
    console.log('正在初始化演示巡检路线...');
    initDemoPatrolRoute();
    
    console.log('正在执行初始水量平衡计算...');
    waterBalanceService.calculateWaterBalance(30);
    
    console.log('正在初始化应急预案演示数据...');
    initDemoEmergencyPlans();
    
    console.log('正在初始化链路监控数据...');
    initLinkMonitorDemoData();
    
    console.log('正在初始化灌区配水调度数据...');
    dispatchService.initDemoIrrigations();
    
    console.log('正在初始化水费计费模块数据...');
    billingService.initBillingDemoData();
    
    console.log('正在初始化冰期运行与防冻调度演示数据...');
    iceService.initIceDemoData();
    
    console.log('正在启动每小时用水量自动汇总...');
    billingService.startHourlyAggregation();
    
    app.listen(PORT, () => {
      console.log('========================================');
      console.log('  水利渠道闸群联调与水位演算服务');
      console.log('  服务已启动, 端口: ' + PORT);
      console.log('  演示拓扑: 5段渠道(8km) + 4个闸门');
      console.log('  淤积演示: seg3=0.15m, seg5=0.08m');
      console.log('  巡检服务: 已启用');
      console.log('========================================');
      console.log('');
      console.log('可用接口:');
      console.log('  GET  /api/health - 健康检查');
      console.log('  GET  /api/topology - 渠道拓扑');
      console.log('  POST /api/telemetry/batch - 批量上报水位');
      console.log('  GET  /api/telemetry/:pointId/history - 历史水位');
      console.log('  GET  /api/gates/:id - 闸门状态');
      console.log('  PUT  /api/gates/:id - 调整闸门开度');
      console.log('  POST /api/predict - 水位预测');
      console.log('  GET  /api/conflicts - 冲突检测');
      console.log('  GET  /api/system/summary - 系统摘要');
      console.log('  POST /api/siltation/simulate - 淤积模拟');
      console.log('  PUT  /api/segments/:id/siltation - 设置淤积厚度');
      console.log('  GET  /api/siltation/plan - 清淤建议');
      console.log('  POST /api/siltation/work-orders - 创建清淤工单');
      console.log('  PUT  /api/siltation/work-orders/:id/complete - 完成工单');
      console.log('  GET  /api/siltation/work-orders - 查询工单');
      console.log('');
      console.log('巡检接口:');
      console.log('  POST /api/patrol/routes - 创建巡检路线');
      console.log('  GET  /api/patrol/routes - 巡检路线列表');
      console.log('  GET  /api/patrol/routes/:id - 路线详情');
      console.log('  POST /api/patrol/tasks - 创建巡检任务');
      console.log('  GET  /api/patrol/tasks - 巡检任务列表(含超时自动检测)');
      console.log('  GET  /api/patrol/tasks/:id - 任务详情(含超时自动检测)');
      console.log('  POST /api/patrol/tracks - 上报轨迹点');
      console.log('  POST /api/patrol/anomalies - 上报异常');
      console.log('  GET  /api/patrol/anomalies - 异常列表');
      console.log('  GET  /api/patrol/anomalies/stats - 异常统计');
      console.log('');
      console.log('水量平衡接口:');
      console.log('  POST /api/water-balance/calculate - 触发水量平衡计算');
      console.log('  GET  /api/water-balance/leakage-analysis - 漏损定位分析');
      console.log('  GET  /api/water-balance/history - 渠段历史记录');
      console.log('  GET  /api/water-balance/daily-report - 当日水量平衡日报');
      console.log('  POST /api/water-balance/threshold - 设置告警阈值');
      console.log('  GET  /api/water-balance/thresholds - 查询告警阈值');
      console.log('');
      console.log('应急联动接口:');
      console.log('  POST /api/emergency/plans - 创建应急预案');
      console.log('  GET  /api/emergency/plans - 预案列表');
      console.log('  GET  /api/emergency/plans/:id - 预案详情');
      console.log('  PUT  /api/emergency/plans/:id - 修改预案');
      console.log('  DELETE /api/emergency/plans/:id - 删除预案');
      console.log('  POST /api/emergency/check - 全量预案检测');
      console.log('  POST /api/emergency/simulate/:planId - 预案演练');
      console.log('  POST /api/emergency/execute/:planId - 执行预案');
      console.log('  GET  /api/emergency/executions - 执行记录列表');
      console.log('  GET  /api/emergency/executions/:id - 执行详情');
      console.log('');
      console.log('链路监控接口:');
      console.log('  GET  /api/link-monitor/status - 所有测点链路状态');
      console.log('  GET  /api/link-monitor/status/:pointId - 单测点链路详情');
      console.log('  POST /api/link-monitor/heartbeat - 批量上报心跳包');
      console.log('  GET  /api/link-monitor/quality - 所有测点质量评分');
      console.log('  GET  /api/link-monitor/quality/:pointId - 单测点数据质量诊断');
      console.log('  GET  /api/link-monitor/report - 链路健康日报');
      console.log('  POST /api/link-monitor/simulate-outage - 模拟测点离线');
      console.log('');
      console.log('渠道配水调度接口:');
      console.log('  POST /api/dispatch/irrigations - 创建灌区');
      console.log('  GET  /api/dispatch/irrigations - 灌区列表(含当日已取水量和剩余配额)');
      console.log('  GET  /api/dispatch/irrigations/:id - 灌区详情');
      console.log('  PUT  /api/dispatch/irrigations/:id - 修改灌区参数');
      console.log('  DELETE /api/dispatch/irrigations/:id - 删除灌区');
      console.log('  POST /api/dispatch/optimize - 执行调度优化计算');
      console.log('  POST /api/dispatch/apply - 应用最近一次优化结果');
      console.log('  GET  /api/dispatch/history?days= - 最近N天调度记录');
      console.log('  GET  /api/dispatch/daily-summary - 当日配水汇总');
      console.log('');
      console.log('渠段维护与停水协调接口:');
      console.log('  POST /api/maintenance/plans - 创建维护计划');
      console.log('  GET  /api/maintenance/plans - 维护计划列表');
      console.log('  GET  /api/maintenance/plans/:id - 维护计划详情(含影响评估和替代方案)');
      console.log('  PUT  /api/maintenance/plans/:id/cancel - 取消维护计划');
      console.log('  PUT  /api/maintenance/plans/:id/start - 开始维护(联动闸门)');
      console.log('  PUT  /api/maintenance/plans/:id/complete - 完成维护(恢复闸门)');
      console.log('  GET  /api/maintenance/impact/:segmentId?durationHours= - 预评估停水影响');
      console.log('');
      console.log('操作审计接口:');
      console.log('  GET  /api/audit/logs - 分页查询审计日志');
      console.log('  GET  /api/audit/logs/:id - 单条日志详情(含状态快照)');
      console.log('  GET  /api/audit/summary - 操作统计汇总');
      console.log('  GET  /api/audit/trail/:targetId - 操作目标完整轨迹');
      console.log('  GET  /api/audit/report - 结构化审计报告');
      console.log('');
      console.log('水费计费与账单结算接口:');
      console.log('  POST /api/billing/tariffs - 创建水价方案(阶梯水价)');
      console.log('  GET  /api/billing/tariffs - 所有水价方案列表');
      console.log('  GET  /api/billing/tariffs/current - 当前生效水价方案');
      console.log('  GET  /api/billing/usage/aggregate - 手动触发用水量汇总');
      console.log('  GET  /api/billing/usage/:irrigationId?month= - 某灌区月度用水量明细');
      console.log('  GET  /api/billing/usage/summary?month= - 所有灌区月度用水量排行');
      console.log('  POST /api/billing/generate?month= - 生成指定月份所有灌区账单');
      console.log('  GET  /api/billing/bills?month=&status=&irrigationId= - 查询账单列表');
      console.log('  GET  /api/billing/bills/:id - 账单详情(含阶梯计费明细)');
      console.log('  PUT  /api/billing/bills/:id/pay - 标记账单为已付款');
      console.log('  GET  /api/billing/overdue - 所有逾期未付账单');
      console.log('  GET  /api/billing/restricted - 当前被限供的灌区列表');
      console.log('');
      console.log('渠道冰期运行与防冻调度接口:');
      console.log('  POST /api/ice/temperature - 上报气温和水温数据');
      console.log('  GET  /api/ice/status - 所有渠段冰期状态');
      console.log('  GET  /api/ice/status/:segmentId - 单渠段冰期详情(冰厚估算、有效过水比)');
      console.log('  GET  /api/ice/hydraulic-adjustment - 各渠段冰期修正系数');
      console.log('  GET  /api/ice/recommendations - 防冻调度建议');
      console.log('  POST /api/ice/apply-recommendations - 执行防冻调度建议');
      console.log('');
    });
  } catch (err) {
    console.error('服务启动失败:', err);
    process.exit(1);
  }
}

startServer();
