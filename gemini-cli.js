#!/usr/bin/env node
import readline from 'readline';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 대화형 CLI 인터페이스 생성
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'NanoGem > '
});

console.log("=======================================");
console.log(" NanoGem CLI (Powered by Gemini)       ");
console.log("=======================================");
console.log("명령어를 입력하세요. (초기 설치: /setup, 봇 실행: /start, 종료: exit)");
rl.prompt();

// setup/index.ts에서 유지하기로 한 핵심 스텝들
const setupSteps = ['environment', 'groups', 'register', 'service', 'verify'];

async function runSetup() {
  console.log("\n[System] 시스템 환경 스캔 및 NanoGem 초기 설정을 시작합니다...");
  
  for (const step of setupSteps) {
    console.log(`\n▶ 실행 중: ${step} 단계...`);
    await new Promise((resolve, reject) => {
      // 각 셋업 스크립트를 순차적으로 서브프로세스로 실행
      const proc = spawn('npx', ['tsx', path.join(__dirname, 'setup', 'index.ts'), '--step', step], { stdio: 'inherit' });
      
      proc.on('close', (code) => {
        if (code === 0) {
          resolve(true);
        } else {
          reject(new Error(`Step '${step}' failed with code ${code}`));
        }
      });
    });
  }
  console.log("\n[System] 초기 설정이 완료되었습니다. '/start'를 입력하여 에이전트를 실행하세요.");
}

function startBot() {
  console.log("\n[System] NanoGem 라우터 및 텔레그램 연동 프로세스를 백그라운드에서 실행합니다...");
  
  // src/index.ts (메인 라우터) 실행
  const botProc = spawn('npx', ['tsx', path.join(__dirname, 'src', 'index.ts')], { stdio: 'inherit' });
  
  botProc.on('error', (err) => {
    console.error("[Error] 에이전트 실행 실패:", err);
  });
}

rl.on('line', async (line) => {
  const input = line.trim();

  switch (input) {
    case '/setup':
      try {
        await runSetup();
      } catch (err) {
        console.error("\n[Error] 셋업 과정에서 문제가 발생했습니다 중단:", err.message);
      }
      break;

    case '/start':
      startBot();
      break;

    case 'exit':
      console.log("[System] CLI를 종료합니다.");
      process.exit(0);
      break;

    case '':
      break;

    default:
      console.log("알 수 없는 명령어입니다. 지원되는 명령어: /setup, /start, exit");
      break;
  }
  rl.prompt();
}).on('close', () => {
  process.exit(0);
});
