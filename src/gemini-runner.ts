import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';

// 기존 container-runner.ts의 인터페이스를 유지하여 index.ts와의 호환성 보장
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

// 온톨로지 파일들이 저장될 로컬 경로 (WSL2 환경 기준)
const ONTOLOGY_DIR = path.join(process.cwd(), 'data', 'ontology');

/**
 * 1. 온톨로지 데이터 로드 (RAG)
 * 로컬 디렉토리의 제안서 템플릿과 메타데이터를 읽어옵니다.
 * (추후 용량이 커지면 Gemini File API 및 Context Caching으로 전환할 수 있도록 분리)
 */
function loadOntologyContext(): string {
  if (!fs.existsSync(ONTOLOGY_DIR)) {
    fs.mkdirSync(ONTOLOGY_DIR, { recursive: true });
    return "등록된 제안서 온톨로지가 없습니다.";
  }

  const files = fs.readdirSync(ONTOLOGY_DIR);
  let context = "다음은 회사 제안서 폼과 톤앤매너에 대한 온톨로지 데이터입니다:\n\n";
  
  for (const file of files) {
    if (file.endsWith('.md') || file.endsWith('.txt')) {
      const content = fs.readFileSync(path.join(ONTOLOGY_DIR, file), 'utf-8');
      context += `--- [문서: ${file}] ---\n${content}\n\n`;
    }
  }
  return context;
}

/**
 * 2. 이메일 발송 도구 (Function Calling)
 * Gemini가 초안을 완성한 뒤 스스로 호출할 로컬 함수입니다.
 */
async function executeSendEmail(to: string, subject: string, body: string): Promise<string> {
  console.log(`[System] 이메일 발송 트리거됨 -> To: ${to}, Subject: ${subject}`);
  // 실제 SMTP(Nodemailer 등) 또는 API 발송 로직이 들어갈 자리입니다.
  // 현재는 성공 파이프라인만 구축합니다.
  return JSON.stringify({ status: "success", message: "이메일 발송이 완료되었습니다." });
}

/**
 * 3. 메인 에이전트 실행기 (Gemini 엔진)
 * 기존 runContainerAgent를 대체합니다.
 */
export async function runGeminiAgent(
  input: ContainerInput,
  onOutput?: (output: ContainerOutput) => Promise<void>
): Promise<ContainerOutput> {
  
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { status: 'error', result: null, error: 'GEMINI_API_KEY가 설정되지 않았습니다.' };
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  
  // 온톨로지 컨텍스트 로드
  const ontologyContext = loadOntologyContext();

  // 모델 초기화 및 System Instruction 주입
  const model = genAI.getGenerativeModel({
    model: "gemini-3.0-pro",
    systemInstruction: `너는 제안서 작성을 돕는 세계 최고 수준의 AI 에이전트야. 
    사용자의 요청이 들어오면 다음 온톨로지 데이터를 반드시 참고하여 제안서 초안을 작성해.
    작성이 완료되면 반드시 'send_email' 도구를 사용해 사용자에게 발송해.
    
    [온톨로지 데이터]
    ${ontologyContext}`,
    tools: [
      {
        functionDeclarations: [
          {
            name: "send_email",
            description: "작성된 제안서 초안을 사용자의 이메일로 발송합니다.",
            parameters: {
              type: "OBJECT",
              properties: {
                to: { type: "STRING", description: "수신자 이메일 주소" },
                subject: { type: "STRING", description: "이메일 제목 (프로젝트명 포함)" },
                body: { type: "STRING", description: "제안서 초안 본문 (HTML 또는 Markdown)" }
              },
              required: ["to", "subject", "body"]
            }
          }
        ]
      }
    ]
  });

  try {
    // 텔레그램에서 들어온 프롬프트 실행
    const chat = model.startChat();
    const result = await chat.sendMessage(input.prompt);
    const response = result.response;

    // Function Calling 결과 처리
    const functionCalls = response.functionCalls();
    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      if (call.name === "send_email") {
        const { to, subject, body } = call.args as any;
        const functionResult = await executeSendEmail(to, subject, body);
        
        // 함수 실행 결과를 모델에 반환하여 최종 답변 유도
        const finalResult = await chat.sendMessage([{
          functionResponse: {
            name: "send_email",
            response: JSON.parse(functionResult)
          }
        }]);
        
        const finalOutput = finalResult.response.text();
        if (onOutput) await onOutput({ status: 'success', result: finalOutput });
        return { status: 'success', result: finalOutput };
      }
    }

    // 일반 텍스트 응답인 경우
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
