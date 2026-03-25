import { GoogleGenerativeAI } from '@google/generative-ai';
import * as lancedb from '@lancedb/lancedb';
import fs from 'fs';
import path from 'path';

import * as _pdfParse from 'pdf-parse';
const pdfParse = (_pdfParse as any).default || _pdfParse;

import * as officeParser from 'officeparser';
const parseOfficeAsync = (officeParser as any).parseOfficeAsync || (officeParser as any).default?.parseOfficeAsync;

const ONTOLOGY_DIR = path.join(process.cwd(), 'data', 'ontology');
const DB_DIR = path.join(process.cwd(), 'data', 'vectorstore');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('GEMINI_API_KEY가 없습니다.');
const genAI = new GoogleGenerativeAI(apiKey);

function chunkText(text: string, chunkSize = 1000, overlap = 200): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + chunkSize));
    i += chunkSize - overlap;
  }
  return chunks;
}

async function getEmbedding(text: string): Promise<number[]> {
  const model = genAI.getGenerativeModel({ model: 'text-embedding-004' });
  const result = await model.embedContent(text);
  return result.embedding.values;
}

async function buildOntology() {
  console.log('🚀 온톨로지 로컬 DB 빌드를 시작합니다...');
  if (!fs.existsSync(ONTOLOGY_DIR)) fs.mkdirSync(ONTOLOGY_DIR, { recursive: true });
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

  const db = await lancedb.connect(DB_DIR);
  const files = fs.readdirSync(ONTOLOGY_DIR);

  if (files.length === 0) return;

  const dataToInsert: any[] = [];

  for (const file of files) {
    const filePath = path.join(ONTOLOGY_DIR, file);
    const ext = path.extname(file).toLowerCase();
    let text = '';

    console.log(`📄 파일 파싱 중: ${file}`);
    try {
      if (ext === '.txt' || ext === '.md' || ext === '.csv') {
        text = fs.readFileSync(filePath, 'utf-8');
      } else if (ext === '.pdf') {
        const dataBuffer = fs.readFileSync(filePath);
        const pdfData = await pdfParse(dataBuffer);
        text = pdfData.text;
      } else if (ext === '.pptx' || ext === '.docx') {
        // PPT, DOCX 파싱 (v5 전용)
        text = await parseOfficeAsync(filePath);
      } else {
        console.log(`건너뜀 (지원하지 않는 확장자): ${file}`);
        continue;
      }

      const chunks = chunkText(text);
      for (let i = 0; i < chunks.length; i++) {
        const vector = await getEmbedding(chunks[i]);
        dataToInsert.push({ vector, text: chunks[i], source: file });
      }
    } catch (err) {
      console.error(`❌ ${file} 처리 중 오류:`, err);
    }
  }

  if (dataToInsert.length > 0) {
    const tableNames = await db.tableNames();
    if (tableNames.includes('knowledge_base')) await db.dropTable('knowledge_base');
    await db.createTable('knowledge_base', dataToInsert);
    console.log(`✅ ${dataToInsert.length}개의 데이터 블록 벡터 DB 저장 완료!`);
  }
}

buildOntology().catch(console.error);
