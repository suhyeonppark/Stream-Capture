// Electron 런처. 사용자 셸에 ELECTRON_RUN_AS_NODE=1이 설정돼 있어도
// Electron이 GUI 모드로 뜨도록 해당 변수를 제거한 채 spawn한다.
const { spawn } = require('child_process');
const path = require('path');
const electronBin = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const projectRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const child = spawn(electronBin, [projectRoot, ...args], {
  stdio: 'inherit',
  env,
  windowsHide: false,
});

child.on('close', (code) => process.exit(code ?? 0));
