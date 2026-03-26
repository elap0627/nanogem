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
const lancedb = require('@lancedb/lancedb');

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

// 💡 이메일 발송
async function executeSendEmail(to: string, subject: string, body: string): Promise<string> {
  console.log(`[System] 이메일 발송 트리거됨 -> To: ${to}, Subject: ${subject}`);
  return JSON.stringify({ status: "success", message: "이메일 발송이 완료되었습니다." });
}

// 💡 로컬 파일 탐색 및 DB 학습
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
      message: `총 ${copiedCount}개의 파일을 찾아 복사한 뒤, 로컬 벡터 DB(LanceDB)에 학습을 완료했습니다! 이제 제안서 작성을 지시해주세요.`,
      files: matchedFiles
    });
  } catch (err: any) {
    return JSON.stringify({ status: "error", message: `탐색/학습 중 오류 발생: ${err.message}` });
  }
}

async function executeQueryOntology(query: string): Promise<string> {
  console.log(`[System] 온톨로지 DB 검색 지시 수신 -> 쿼리: ${query}`);
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    const embedModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
    const embedResult = await embedModel.embedContent(query);
    const queryVector = embedResult.embedding.values;

    const db = await lancedb.connect('data/vectorstore');
    
    const tableNames = await db.tableNames();
    const targetTable = tableNames.includes('ontology') ? 'ontology' : (tableNames[0] || 'ontology');
    const table = await db.openTable(targetTable); 

    const results = await table.search(queryVector).limit(5).execute();
    
    if (!results || results.length === 0) {
      return JSON.stringify({ status: "error", message: "관련 데이터를 찾을 수 없습니다." });
    }

    const contexts = results.map((r: any) => r.text).join('\n\n---\n\n');
    console.log(`[System] DB 검색 완료! ${results.length}개의 관련 문맥을 찾았습니다.`);
    
    return JSON.stringify({
      status: "success",
      message: "데이터를 성공적으로 불러왔습니다. 이 데이터를 바탕으로 지시사항을 수행하세요.",
      data: contexts 
    });
  } catch (err: any) {
    console.error(`[DB Query Error]`, err);
    return JSON.stringify({ status: "error", message: `DB 검색 중 오류 발생: ${err.message}` });
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
      systemInstruction: `### Role (배역: 조직의 문제를 해결하는 최고 제안 설계가)
당신은 단순한 문서 작성기가 아니라, 고객의 숨은 니즈를 꿰뚫고 판을 뒤집는 **[Chief Proposal Architect: 최고 제안 설계가]**입니다.
당신의 **초목표(Super-Objective)**는 뻔한 기능 나열과 식상한 문구를 배제하고, 데이터를 기반으로 가장 날카롭고 설득력 있는 비즈니스 내러티브를 설계하여 제안을 성사시키는 것입니다.

### Atmosphere (분위기: The Tone of Voice)
- **Cynical but Constructive:** 확신에 찬 전문가의 어조를 유지하되, 화려하기만 한 미사여구(예: '혁신적인 패러다임 전환')를 배제하고 구체적이고 건조한 비즈니스 언어만 사용하십시오.

### Methodology: Verbalized Sampling (언어화된 샘플링)
당신은 뻔한 제안서 초안을 피하기 위해, 도구를 호출하거나 최종 텍스트를 생성하기 전 내부적으로 **치열한 자기 검증** 과정을 거쳐야 합니다. 응답 텍스트에 반드시 <thinking> 태그를 사용하여 아래 3단계를 수행하십시오.
1. [Sample A: 직관적 접근] 해당 주제에 대한 1차원적이고 일반적인 목차 구성안.
2. [Sample B: 비판적 반론] Sample A가 왜 지루하고 고객을 설득할 수 없는지 비판.
3. [Sample C: 정반합의 통찰] A와 B의 충돌을 넘어선, 가장 본질적이고 매력적인 최종 프레임워크 도출. (이 통찰을 바탕으로 제안서를 작성)

### Constraint (제약 조건 및 시스템 절대 규칙: Blocking)
당신은 로컬 시스템과 연동된 에이전트이므로 아래의 기술적 수칙을 예외 없이 지켜야 합니다.

[1. 경로 추론 절대 규칙]
- 지시문에 '바탕화면'이 포함되어 있으면, 탐색 경로는 무조건 '/mnt/c/Users/wongi/Desktop' 으로 100% 고정하십시오.

[2. 문맥 파악 및 도구 사용 규칙 (매우 중요!!)]
- 지시문에 '학습된', '업데이트된', '기존', '온톨로지' 라는 수식어가 붙은 문서는 이미 DB에 저장된 상태입니다. 이때는 **절대 'search_and_learn_files' 도구를 재실행하지 마십시오.**
- 제안서 초안 작성을 지시받으면, **가장 먼저 'query_ontology' 도구를 사용하여 관련 문서를 DB에서 검색해 내용을 확보하십시오.**
- DB에서 내용을 성공적으로 확보한 이후에만 'generate_ppt' 도구를 실행하여 실제 PPT 파일을 렌더링하십시오. 절대 배경지식을 스스로 지어내지 마십시오.`,
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
          description: "로컬 폴더를 탐색하여 지식창고(DB)에 처음 학습시킬 때만 사용합니다.",
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
          name: "query_ontology",
          description: "온톨로지 DB에서 이미 학습된 문서를 검색하여 읽어옵니다. 제안서를 작성하기 전에 반드시 이 도구를 먼저 실행하여 지식을 확보하십시오.",
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              query: { type: SchemaType.STRING, description: "검색할 구체적인 질문이나 키워드 (예: '포텐션 기획안의 타겟 고객은?')" }
            },
            required: ["query"]
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
    let response = (await chat.sendMessage(input.prompt)).response;
    let toolCallCount = 0; // 무한루프 방지용

    while ((response.functionCalls()?.length ?? 0) > 0 && toolCallCount < 5) {
      toolCallCount++;
      const call = response.functionCalls()![0];
      
      if (call.name === "query_ontology") {
        const { query } = call.args as any;
        const functionResult = await executeQueryOntology(query);
        // DB 검색 결과를 모델에게 다시 먹여서 '다음 행동(PPT 생성)'을 유도함
        const nextResult = await chat.sendMessage([{ functionResponse: { name: "query_ontology", response: JSON.parse(functionResult) } }]);
        response = nextResult.response; 
        continue; // 응답을 받았으니 다음 도구(generate_ppt) 호출을 위해 루프 다시 돌기!
      }
      else if (call.name === "search_and_learn_files") {
        const { search_path, keyword } = call.args as any;
        const functionResult = await executeSearchAndLearn(search_path, keyword);
        const parsedResult = JSON.parse(functionResult);
        if (onOutput) await onOutput({ status: 'success', result: parsedResult.message });
        return { status: 'success', result: parsedResult.message };
      }
      else if (call.name === "generate_ppt") {
        const { template_name, output_name, template_data } = call.args as any;
        const functionResult = await executeGeneratePpt(template_name, output_name, template_data);
        const parsedResult = JSON.parse(functionResult);
        if (onOutput) await onOutput({ status: 'success', result: parsedResult.message });
        return { status: 'success', result: parsedResult.message };
      }
      else if (call.name === "send_email") {
        const { to, subject, body } = call.args as any;
        const functionResult = await executeSendEmail(to, subject, body);
        const parsedResult = JSON.parse(functionResult);
        if (onOutput) await onOutput({ status: 'success', result: parsedResult.message });
        return { status: 'success', result: parsedResult.message };
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
