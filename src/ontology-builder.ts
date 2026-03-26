import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import * as lancedb from '@lancedb/lancedb';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
import { extractText } from 'unpdf';
const officeParser = require('officeparser');

const ONTOLOGY_DIR = path.join(process.cwd(), 'data', 'ontology');
const DB_DIR = path.join(process.cwd(), 'data', 'vectorstore');
const TRACK_FILE = path.join(process.cwd(), 'data', 'processed_files.json');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('GEMINI_API_KEY가 없습니다.');

const genAI = new GoogleGenerativeAI(apiKey);
const fileManager = new GoogleAIFileManager(apiKey);

function chunkText(text: string, chunkSize = 1000, overlap = 200): string[] {
  if (!text || typeof text !== 'string') return [];
  const cleanText = text.replace(/\0/g, '').trim();
  if (cleanText.length === 0) return [];
  
  const chunks: string[] = [];
  let i = 0;
  while (i < cleanText.length) {
    chunks.push(cleanText.slice(i, i + chunkSize));
    i += chunkSize - overlap;
  }
  return chunks;
}

async function getEmbedding(text: string): Promise<number[]> {
  const model = genAI.getGenerativeModel({ model: 'text-embedding-004' });
  const result = await model.embedContent(text);
  return result.embedding.values;
}

async function extractTextWithVision(filePath: string, mimeType: string): Promise<string> {
  let uploadResult;
  try {
    uploadResult = await fileManager.uploadFile(filePath, { 
      mimeType, 
      displayName: path.basename(filePath) 
    });
    
    const model = genAI.getGenerativeModel({ model: 'gemini-3.0-flash-preview' });
    const result = await model.generateContent([
      { fileData: { fileUri: uploadResult.file.uri, mimeType: uploadResult.file.mimeType } },
      { text: "이 문서 또는 이미지에 포함된 모든 텍스트를 있는 그대로 빠짐없이 추출해. 부가적인 설명은 절대 하지 마." }
    ]);
    
    return result.response.text() || '';
  } catch (error) {
    console.error(`OCR 추출 중 오류 발생:`, error);
    return '';
  } finally {
    if (uploadResult) {
      try { await fileManager.deleteFile(uploadResult.file.name); } catch (e) {}
    }
  }
}

async function buildOntology() {
  console.log('🚀 온톨로지 로컬 DB 빌드를 시작합니다...');
  if (!fs.existsSync(ONTOLOGY_DIR)) fs.mkdirSync(ONTOLOGY_DIR, { recursive: true });
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

  let processedFiles: string[] = [];
  if (fs.existsSync(TRACK_FILE)) {
    processedFiles = JSON.parse(fs.readFileSync(TRACK_FILE, 'utf-8'));
  }

  const db = await lancedb.connect(DB_DIR);
  const files = fs.readdirSync(ONTOLOGY_DIR);

  if (files.length === 0) return;

  const dataToInsert: any[] = [];
  const newlyProcessed: string[] = [];

  for (const file of files) {
    if (processedFiles.includes(file)) {
      continue;
    }

    const filePath = path.join(ONTOLOGY_DIR, file);
    const ext = path.extname(file).toLowerCase();
    let text = '';

    console.log(`📄 새 파일 파싱 중: ${file}`);
    try {
      if (ext === '.txt' || ext === '.md' || ext === '.csv') {
        text = fs.readFileSync(filePath, 'utf-8');
      } else if (ext === '.pptx' || ext === '.docx') {
        text = await officeParser.parseOfficeAsync(filePath);
        text = text || '';
        
        if (text.trim().length < 50) {
          console.log(`  └ ⚠️ [경고] 텍스트가 없는 통짜 이미지 문서입니다! Gemini OCR은 PPT 파일을 직접 읽을 수 없으니, PDF로 변환해서 다시 지시해 주세요.`);
          text = '';
        }
      } else if (ext === '.pdf') {
        const dataBuffer = new Uint8Array(fs.readFileSync(filePath));
        const pdfData = await extractText(dataBuffer);
        text = pdfData.text || '';
        
        if (text.trim().length < 50) {
          console.log(`  └ ⚠️ 텍스트 레이어 부족 (스캔본 추정). 비전 OCR을 실행합니다...`);
          text = await extractTextWithVision(filePath, 'application/pdf');
        }
      } else if (ext === '.jpg' || ext === '.jpeg' || ext === '.png') {
        console.log(`  └ 🖼️ 이미지 파일 감지. 비전 OCR을 실행합니다...`);
        const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
        text = await extractTextWithVision(filePath, mimeType);
      } else {
        console.log(`건너뜀 (지원하지 않는 확장자): ${file}`);
        continue;
      }

      console.log(`  └ 💡 추출된 텍스트 길이: ${text.length} 자`);

      const chunks = chunkText(text);
      if (chunks.length > 0) {
          for (let i = 0; i < chunks.length; i++) {
            const vector = await getEmbedding(chunks[i]);
            dataToInsert.push({ vector, text: chunks[i], source: file });
          }
          console.log(`  └ 🧩 ${chunks.length}개 조각으로 벡터 변환 완료.`);
      } else {
          console.log(`  └ ⚠️ 추출된 텍스트가 없습니다.`);
      }
      
      newlyProcessed.push(file);
    } catch (err) {
      console.error(`❌ ${file} 처리 중 오류:`, err);
    }
  }

  if (dataToInsert.length > 0) {
    const tableNames = await db.tableNames();
    if (tableNames.includes('knowledge_base')) {
      const table = await db.openTable('knowledge_base');
      await table.add(dataToInsert);
      console.log(`✅ 기존 DB에 ${dataToInsert.length}개의 데이터 블록 추가 완료!`);
    } else {
      await db.createTable('knowledge_base', dataToInsert);
      console.log(`✅ 새 벡터 DB 생성 및 ${dataToInsert.length}개의 데이터 블록 저장 완료!`);
    }
  } else {
    console.log('✨ 새로 DB에 넣을 의미 있는 텍스트 데이터가 없습니다.');
  }

  if (newlyProcessed.length > 0) {
      fs.writeFileSync(TRACK_FILE, JSON.stringify([...processedFiles, ...newlyProcessed], null, 2));
      console.log(`📝 학습 명부에 ${newlyProcessed.length}개 파일 업데이트 완료.`);
  }
}

buildOntology().catch(console.error);
