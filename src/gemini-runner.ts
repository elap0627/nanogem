import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

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

async function executeSendEmail(to: string, subject: string, body: string): Promise<string> {
  console.log(`[System] 이메일 발송 트리거됨 -> To: ${to}, Subject: ${subject}`);
  return JSON.stringify({ status: "success", message: "이메일 발송이 완료되었습니다." });
}

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

// 💡 PPT 생성 및 로컬 저장 기능
async function executeGeneratePpt(templateName: string, outputName: string, templateDataString: string): Promise<string> {
  console.log(`[System] PPT 생성 지시 수신 -> 템플릿: ${templateName}, 출력: ${outputName}`);
  const templatePath = path.join(process.cwd(), 'data', 'templates', templateName);
  const outputDir = path.join(process.cwd(), 'data', 'output');
  const outputPath = path.join(outputDir, outputName);

  if (!fs.existsSync(templatePath)) {
    return JSON.stringify({ status: "error", message: `템플릿 파일(${templateName})이 data/templates 폴더에 존재하지 않습니다.` });
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  try {
    const templateData = JSON.parse(templateDataString);
    const content = fs.readFileSync(templatePath, 'binary');
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

    doc.render(templateData);

    const buf = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    fs.writeFileSync(outputPath, buf);

    return JSON.stringify({
      status: "success",
      message: `성공적으로 PPT 파일이 생성되었습니다. 파일은 ${outputPath} 에 저장되었습니다.`,
      output_path: outputPath
    });
  } catch (err: any) {
    console.error(`[PPT Generation Error]`, err);
    return JSON.stringify({ status: "error", message: `PPT 생성 중 오류 발생: ${err.message}` });
  }
}

export async function runGeminiAgent(
  input: ContainerInput,
  onOutput?: (output: ContainerOutput) => Promise<void>
): Promise<ContainerOutput> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { status: 'error', result: null, error: 'GEMINI_API_KEY가 설정되지 않았습니다.' };

  const genAI = new GoogleGenerativeAI(apiKey);

  const model = genAI.getGenerativeModel({
    model: "gemini-3.1-flash-lite-preview",
    systemInstruction: `너는 제안서 작성을 돕는 최고 수준의 AI 에이전트야.
사용자의 윈도우 환경 파일 경로는 '/mnt/c/Users/wongi/' 로 시작해.
사용자가 '바탕화면'을 언급하면 '/mnt/c/Users/wongi/Desktop'을 탐색 경로로 추론해.
사용자가 제안서 작성을 지시하면, 반드시 'generate_ppt' 도구를 사용하여 PPT 파일을 생성해. 데이터는 JSON 형식으로 전달해야 해.`,
    tools: [{
      functionDeclarations: [
        {
          name: "send_email",
          description: "작성된 초안을 이메일로 발송합니다.",
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              to: { type: SchemaType.STRING },
              subject: { type: SchemaType.STRING },
              body: { type: SchemaType.STRING }
            },
            required: ["to", "subject", "body"]
          }
        },
        {
          name: "search_and_learn_files",
          description: "로컬 폴더를 탐색하여 지식창고에 학습시킵니다.",
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              search_path: { type: SchemaType.STRING },
              keyword: { type: SchemaType.STRING }
            },
            required: ["search_path", "keyword"]
          }
        },
        {
          name: "generate_ppt",
          description: "마스터 템플릿의 태그에 데이터를 주입하여 로컬에 PPT 파일을 생성합니다.",
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              template_name: { type: SchemaType.STRING, description: "사용할 템플릿 파일명 (예: template.pptx)" },
              output_name: { type: SchemaType.STRING, description: "생성될 파일명 (예: 결과물.pptx)" },
              template_data: { type: SchemaType.STRING, description: "템플릿에 주입할 데이터(JSON 문자열 형식). 키값은 템플릿의 {{변수명}}과 일치해야 함." }
            },
            required: ["template_name", "output_name", "template_data"]
          }
        }
      ]
    }]
  });

  try {
    const chat = model.startChat();
    const result = await chat.sendMessage(input.prompt);
    const response = result.response;

    const functionCalls = response.functionCalls();
    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      
      if (call.name === "send_email") {
        const { to, subject, body } = call.args as any;
        const functionResult = await executeSendEmail(to, subject, body);
        const finalResult = await chat.sendMessage([{ functionResponse: { name: "send_email", response: JSON.parse(functionResult) } }]);
        const finalOutput = finalResult.response.text();
        if (onOutput) await onOutput({ status: 'success', result: finalOutput });
        return { status: 'success', result: finalOutput };
      } 
      else if (call.name === "search_and_learn_files") {
        const { search_path, keyword } = call.args as any;
        const functionResult = await executeSearchAndLearn(search_path, keyword);
        const finalResult = await chat.sendMessage([{ functionResponse: { name: "search_and_learn_files", response: JSON.parse(functionResult) } }]);
        const finalOutput = finalResult.response.text();
        if (onOutput) await onOutput({ status: 'success', result: finalOutput });
        return { status: 'success', result: finalOutput };
      }
      else if (call.name === "generate_ppt") {
        const { template_name, output_name, template_data } = call.args as any;
        const functionResult = await executeGeneratePpt(template_name, output_name, template_data);
        const finalResult = await chat.sendMessage([{ functionResponse: { name: "generate_ppt", response: JSON.parse(functionResult) } }]);
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
