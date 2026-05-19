#!/usr/bin/env python3
import subprocess, os

BASE = "/opt/battletoads-double-dragon"
SERVICE_JS = os.path.join(BASE, "backend/dist/saas/service.js")

# 1. Patch service.js
with open(SERVICE_JS, "r") as f:
    content = f.read()
if "exports.propagatePublishToClients" not in content:
    content += "\nexports.propagatePublishToClients = propagatePublishToClients;\n"
    with open(SERVICE_JS, "w") as f:
        f.write(content)
    print("Patched service.js")

# 2. Run materialization
JS_CODE = "const { propagatePublishToClients } = require('/opt/battletoads-double-dragon/backend/dist/saas/service.js');\nconst systemName = 'ALGOFUND_MASTER::BTDD_D1::balanced-portfolio-v2';\nconsole.log('Calling propagatePublishToClients with', systemName);\npropagatePublishToClients(systemName).then(function(result) {\n  console.log('SUCCESS:', JSON.stringify(result, null, 2));\n  process.exit(0);\n}).catch(function(err) {\n  console.error('ERROR:', err.message);\n  process.exit(1);\n});"

node_path = "/tmp/materialize.js"
with open(node_path, "w") as f:
    f.write(JS_CODE)

os.chdir(BASE)
r = subprocess.run(["node", node_path], capture_output=True, text=True, timeout=60)
print("STDOUT:", r.stdout)
print("STDERR:", r.stderr)
print("Exit:", r.returncode)