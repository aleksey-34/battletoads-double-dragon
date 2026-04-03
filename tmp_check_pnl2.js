// Must be run inside the API context - add a temp debug endpoint
const http = require('http');
const options = { hostname: 'localhost', port: 3001, path: '/api/saas/synctrade/47949/live-pnl/3', method: 'GET' };
const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => console.log(data));
});
req.end();
