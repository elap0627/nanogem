import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const ONTOLOGY_DIR = path.join(process.cwd(), 'data', 'ontology');

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf': return 'application/pdf';
    case '.txt': return 'text/plain';
    case '.md': return 'text/markdown';
    case '.csv': return 'text/csv';
    default: return 'application/octet-stream';
  }
}

// 기존 방식 (과도기 유지용)
async function uploadOntologyFiles(fileManager: GoogleAIFileManager): Promise<any[]> {
  if (!fs.existsSync(ONTOLOGY_DIR)) {
    fs.mkdirSync(ONTOLOGY_DIR, { recursive: true });
    return [];
  }
  const files = fs.readdirSync(ONTOLOGY_DIR);
  const fileParts = [];
  for (const file of files) {
    const filePath = path.join(ONTOLOGY_DIR, file);
    const mimeType = getMimeType(filePath);
    if (mimeType === 'application/octet-stream') continue;
    console.log(`[System] 온톨로지 파일 업로드 중: ${file}`);
    const uploadResult = await fileManager.uploadFile(filePath, { mimeType, displayName: file });
    fileParts.push({ fileData: { fileUri: uploadResult.file.uri, mimeType: uploadResult.file.mimeType } });
  }
  return fileParts;
}

async function executeSendEmail(to: string, subject: string, body: string): Promise<string> {
  console.log(`[System] 이메일 발송 트리거됨 -> To: ${to}, Subject: ${subject}`);
  return JSON.stringify({ status: "success", message: "이메일 발송이 완료되었습니다." });
}

// 🚀 새롭게 추가된 로컬 파일 탐색 및 자동 학습 기능
async function executeSearchAndLearn(searchPath: string, keyword: string): Promise<string> {
  console.log(`[System] 로컬 탐색 지시 수신 -> 경로: ${searchPath}, 키워드: ${keyword}`);
  if (!fs.existsSync(ONTOLOGY_DIR)) fs.mkdirSync(ONTOLOGY_DIR, { recursive: true });

  try {
    if (!fs.existsSync(searchPath)) {
      return JSON.stringify({ status: "error", message: `경로를 찾을 수 없습니다: ${searchPath}` });
    }

    const files = fs.readdirSync(searchPath);
    const matchedFiles = files.filter(file =>
      file.toLowerCase().includes(keyword.toLowerCase()) &&
      (file.endsWith('.pdf') || file.endsWith('.txt') || file.endsWith('.md') || file.endsWith('.csv') || file.endsWith('.pptx') || file.endsWith('.docx') || file.endsWith('.jpg') || file.endsWith('.jpeg') || file.endsWith('.png'))
    );

    if (matchedFiles.length === 0) {
      return JSON.stringify({ status: "error", message: `해당 경로에 '${keyword}' 키워드가 포함된 학습 가능 문서가 없습니다.` });
    }

    let copiedCount = 0;
    for (const file of matchedFiles) {
      fs.copyFileSync(path.join(searchPath, file), path.join(ONTOLOGY_DIR, file));
      copiedCount++;
    }

    console.log(`[System] ${copiedCount}개 파일 복사 완료. 벡터 DB 학습(ontology-builder.ts)을 시작합니다...`);

    const { stdout, stderr } = await execPromise('node --env-file=.env --experimental-strip-types src/ontology-builder.ts');
    console.log(`[Builder] ${stdout}`);
    if (stderr) console.error(`[Builder Error Logs]\n${stderr}`); 

    return JSON.stringify({
      status: "success",
      message: `총 ${copiedCount}개의 파일을 찾아 복사한 뒤, 로컬 벡터 DB(LanceDB)에 학습을 완료했습니다!`,
      files: matchedFiles
    });
  } catch (err: any) {
    return JSON.stringify({ status: "error", message: `탐색/학습 중 오류 발생: ${err.message}` });
  }
}

export async function runGeminiAgent(
  input: ContainerInput,
  onOutput?: (output: ContainerOutput) => Promise<void>
): Promise<ContainerOutput> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { status: 'error', result: null, error: 'GEMINI_API_KEY가 설정되지 않았습니다.' };

  const genAI = new GoogleGenerativeAI(apiKey);
  const fileManager = new GoogleAIFileManager(apiKey);
  
  // 지금은 수집 테스트를 위해 임시로 기존 업로드 로직을 살려둡니다.
  const uploadedFiles = await uploadOntologyFiles(fileManager);

  const model = genAI.getGenerativeModel({
    model: "gemini-3-pro-preview",
    systemInstruction: `너는 제안서 작성을 돕는 최고 수준의 AI 에이전트야.
사용자의 윈도우 환경 파일 경로는 '/mnt/c/Users/wongi/' 로 시작해.
사용자가 '바탕화면'을 언급하면 '/mnt/c/Users/wongi/Desktop', '문서' 폴더를 언급하면 '/mnt/c/Users/wongi/Documents'를 탐색 경로로 추론해서 사용해.
새로운 파일을 찾아 학습하라고 지시받으면 'search_and_learn_files' 도구를 사용해.`,
    tools: [{
      functionDeclarations: [
        {
          name: "send_email",
          description: "작성된 제안서 초안을 사용자의 이메일로 발송합니다.",
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              to: { type: SchemaType.STRING, description: "수신자 이메일 주소" },
              subject: { type: SchemaType.STRING, description: "이메일 제목 (프로젝트명 포함)" },
              body: { type: SchemaType.STRING, description: "제안서 초안 본문 (HTML 또는 Markdown)" }
            },
            required: ["to", "subject", "body"]
          }
        },
        {
          name: "search_and_learn_files",
          description: "사용자의 윈도우 로컬 폴더를 탐색하여 특정 키워드가 포함된 문서를 찾아 지식창고에 복사하고 로컬 벡터 DB(LanceDB)에 학습시킵니다.",
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              search_path: { type: SchemaType.STRING, description: "탐색할 로컬 절대 경로 (예: /mnt/c/Users/wongi/Desktop)" },
              keyword: { type: SchemaType.STRING, description: "검색할 파일명 키워드 (예: 제안서, 규정 등)" }
            },
            required: ["search_path", "keyword"]
          }
        }
      ]
    }]
  });

  try {
    const chat = model.startChat();
    const requestParts = [...uploadedFiles, { text: input.prompt }];
    const result = await chat.sendMessage(requestParts);
    const response = result.response;

    const functionCalls = response.functionCalls();
    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      
      if (call.name === "send_email") {
        const { to, subject, body } = call.args as any;
        const functionResult = await executeSendEmail(to, subject, body);
        const finalResult = await chat.sendMessage([{
          functionResponse: { name: "send_email", response: JSON.parse(functionResult) }
        }]);
        const finalOutput = finalResult.response.text();
        if (onOutput) await onOutput({ status: 'success', result: finalOutput });
        return { status: 'success', result: finalOutput };
      } 
      
      else if (call.name === "search_and_learn_files") {
        const { search_path, keyword } = call.args as any;
        const functionResult = await executeSearchAndLearn(search_path, keyword);
        const finalResult = await chat.sendMessage([{
          functionResponse: { name: "search_and_learn_files", response: JSON.parse(functionResult) }
        }]);
        const finalOutput = finalResult.response.text();
        if (onOutput) await onOutput({ status: 'success', result: finalOutput });
        return { status: 'success', result: finalOutput };
      }
    }

    const textOutput = response.text();
    if (onOutput) await onOutput({ status: 'success', result: textOutput });
    return { status: 'success', result: textOutput };

  } catch (err: any) {
    console.error('[Gemini Error]', err);
    const errorMsg = `Gemini API 호출 중 오류 발생: ${err.message}`;
    if (onOutput) await onOutput({ status: 'error', result: null, error: errorMsg });
    return { status: 'error', result: null, error: errorMsg };
  }
}
