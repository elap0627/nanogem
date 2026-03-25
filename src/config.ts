import os from 'os';
import path from 'path';
import { readEnvFile } from './env.js';

// .env 파일에서 필요한 환경 변수 로드
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'GEMINI_API_KEY',
  'TELEGRAM_BOT_TOKEN'
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';

// 텔레그램 봇은 항상 독립된 계정이므로 기본값을 true로 설정합니다.
export const ASSISTANT_HAS_OWN_NUMBER = true; 

// 메시지 폴링 및 스케줄러 간격 설정
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// 시스템 디렉토리 경로 (DB 및 온톨로지 저장용)
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

// [삭제됨] 컨테이너 구동 관련 상수 (CONTAINER_IMAGE, MAX_CONCURRENT_CONTAINERS 등)
// [삭제됨] 마운트 보안 관련 상수 (MOUNT_ALLOWLIST_PATH)

// 에이전트가 마지막 응답 후 대기하는 시간 (상태 유지용)
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
);

// 정규식 특수 문자 이스케이프
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 그룹 채팅에서 봇을 호출할 때 사용하는 트리거 패턴 (예: @Andy)
export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// 시스템 타임존
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
