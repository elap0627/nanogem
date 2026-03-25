import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * .env 파일을 파싱하여 프로세스 환경 변수에 병합하거나 
 * 요청된 키만 레코드 형태로 반환합니다.
 * (Gemini 엔진은 컨테이너를 띄우지 않으므로 보다 직관적으로 관리합니다.)
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env 파일을 찾을 수 없어 시스템 환경 변수를 사용합니다.');
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
