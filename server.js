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
const waterBalanceService = require('./services/waterBalanceService');

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
    });
  } catch (err) {
    console.error('服务启动失败:', err);
    process.exit(1);
  }
}

startServer();
