'use strict';

// 模拟 WorkBuddy 签到接口，用于 headless 测试。支持四种模式：
//   ok      -> 首次未签到，签到成功后状态变为已签
//   already -> 查询即返回已签到
//   expired -> 返回 401 / code=10002（token 过期）
//   error   -> 签到接口返回 500
//
// 既可作为独立进程运行（node test/mock-server.js，读取 MOCK_MODE / MOCK_PORT），
// 也可被 harness 以 createMockServer(mode) 调用。

const http = require('http');
const { STATUS_PATH, CHECKIN_PATH } = require('../src/checkin');

function createMockServer(mode = 'ok') {
  let checkedIn = false; // 'ok' 模式下，签到成功后状态接口应反映已签
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const url = req.url || '';

      if (url.includes(STATUS_PATH)) {
        if (mode === 'expired') {
          res.statusCode = 401;
          res.end(JSON.stringify({ code: 10002, msg: 'unauthorized' }));
          return;
        }
        const checked = mode === 'already' || (mode === 'ok' && checkedIn);
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              today_checked_in: checked,
              streak_days: checked ? 5 : 0,
              today_credit: checked ? 10 : 0,
              total_credits: checked ? 120 : 110,
              activity_name: '签到',
            },
          })
        );
        return;
      }

      if (url.includes(CHECKIN_PATH)) {
        if (mode === 'expired') {
          res.statusCode = 401;
          res.end(JSON.stringify({ code: 10002, msg: 'unauthorized' }));
          return;
        }
        if (mode === 'error') {
          res.statusCode = 500;
          res.end(JSON.stringify({ code: 500, msg: 'server error' }));
          return;
        }
        checkedIn = true; // 标记为已签到，使后续状态查询反映成功
        res.end(
          JSON.stringify({
            code: 0,
            data: { today_checked_in: true, streak_days: 5, today_credit: 10, total_credits: 120, activity_name: '签到' },
          })
        );
        return;
      }

      res.statusCode = 404;
      res.end('{}');
    });
  });
}

if (require.main === module) {
  const mode = process.env.MOCK_MODE || 'ok';
  const port = parseInt(process.env.MOCK_PORT || '4000', 10);
  createMockServer(mode).listen(port, () => {
    console.log(`[mock] listening on http://127.0.0.1:${port} mode=${mode}`);
  });
}

module.exports = { createMockServer };
