const bcrypt = require('bcrypt');
const fs = require('fs');
const hash = bcrypt.hashSync('LSIVJO$uhgsU#WHF3s2', 10);
fs.writeFileSync('.password_state', hash);
console.log('Hash saved:', hash);
