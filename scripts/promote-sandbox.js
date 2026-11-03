'use strict';
const { execSync } = require('child_process');

function run(cmd) {
    console.log('>', cmd);
    execSync(cmd, { stdio: 'inherit', cwd: require('path').join(__dirname, '..') });
}

run('git checkout main');
run('git merge sandbox -m "Promote sandbox tests to production"');
run('git push origin main');
console.log('Sandbox promossa su main.');
