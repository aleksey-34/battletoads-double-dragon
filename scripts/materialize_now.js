#!/usr/bin/env node
const { propagatePublishToClients } = require('/opt/battletoads-double-dragon/backend/dist/saas/service.js');
const systemName = 'ALGOFUND_MASTER::BTDD_D1::balanced-portfolio-v2';
console.log('Calling propagatePublishToClients with', systemName);
propagatePublishToClients(systemName)
  .then(function(result) {
    console.log('SUCCESS:', JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch(function(err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  });
