import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import fs from 'fs';
import path from 'path';

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

export async function runGeminiAgent(
  input: ContainerInput,
  onOutput?: (output: ContainerOutput) => Promise<void>
): Promise<ContainerOutput> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { status: 'error', result: null, error: 'GEMINI_API_KEY가 설정되지 않았습니다.' };

  const genAI = new GoogleGenerativeAI(apiKey);
  const fileManager = new GoogleAIFileManager(apiKey);
  const uploadedFiles = await uploadOntologyFiles(fileManager);

  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction: `너는 제안서 작성을 돕는 최고 수준의 AI 에이전트야. 
    사용자의 요청이 들어오면 첨부된 제안서 온톨로지 파일들의 폼, 레이아웃, 톤앤매너를 반드시 분석하여 제안서 초안을 작성해.
    작성이 완료되면 반드시 'send_email' 도구를 사용해 사용자에게 발송해.`,
    tools: [{
      functionDeclarations: [{
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
      }]
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
