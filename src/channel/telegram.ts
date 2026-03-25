import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../logger.js';
import { NewMessage, RegisteredGroup } from '../types.js';

// index.ts에서 주입할 채널 콜백 인터페이스
export interface ChannelOpts {
  onMessage: (chatJid: string, msg: NewMessage) => void;
  onChatMetadata: (chatJid: string, timestamp: string, name?: string, channelName?: string, isGroup?: boolean) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel {
  private bot: TelegramBot;
  private opts: ChannelOpts;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
    
    // 환경 변수에서 텔레그램 봇 토큰 로드
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN 환경 변수가 누락되었습니다. BotFather에게 발급받은 토큰을 설정하세요.');
    }
    
    // 로컬 환경 구동에 최적화된 Polling 방식으로 봇 초기화
    this.bot = new TelegramBot(token, { polling: false });
  }

  public async connect(): Promise<void> {
    logger.info('Telegram Bot API 연결을 시작합니다...');

    // 메시지 수신 이벤트 핸들러
    this.bot.on('message', (msg) => {
      // 텍스트 메시지만 우선 처리 (추후 파일 전송 등 확장 가능)
      if (!msg.text) return; 

      // 텔레그램의 고유 ID 체계를 NanoGem의 JID(Jabber ID) 규격으로 매핑
      const chatJid = msg.chat.id.toString();
      const senderJid = msg.from?.id.toString() || 'unknown';
      const senderName = msg.from?.username || msg.from?.first_name || 'User';
      const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
      const chatName = msg.chat.title || senderName;
      const timestamp = new Date(msg.date * 1000).toISOString();

      // 1. 메인 라우터에 채팅방 메타데이터 업데이트 (DB 저장용)
      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);

      // 2. 메시지 규격 표준화
      const newMessage: NewMessage = {
        chat_jid: chatJid,
        sender_jid: senderJid,
        sender_name: senderName,
        timestamp: timestamp,
        content: msg.text,
        message_id: msg.message_id.toString(),
        from_me: false,
      };

      // 3. 메인 프로세스(index.ts)로 메시지 전달
      this.opts.onMessage(chatJid, newMessage);
    });

    this.bot.on('polling_error', (error) => {
      logger.error({ err: error }, 'Telegram Polling 오류 발생');
    });

    // 봇 폴링 시작
    await this.bot.startPolling();
    logger.info('✅ Telegram Bot 연결 완료 및 수신 대기 중');
  }

  public async disconnect(): Promise<void> {
    logger.info('Telegram Bot 연결을 해제합니다...');
    await this.bot.stopPolling();
  }

  // 메인 라우터에서 이 채널이 해당 JID(채팅방)를 소유하는지 판별하는 함수
  public ownsJid(jid: string): boolean {
    // 텔레그램 ID는 숫자(음수 포함)로 구성됨
    return /^-?\d+$/.test(jid);
  }

  public isConnected(): boolean {
    return this.bot.isPolling();
  }

  // Gemini가 생성한 답변을 텔레그램으로 전송
  public async sendMessage(jid: string, text: string): Promise<void> {
    try {
      // 제안서 폼 등을 예쁘게 렌더링하기 위해 Markdown 지원
      await this.bot.sendMessage(jid, text, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error({ jid, error }, 'Telegram 메시지 전송 실패');
    }
  }

  // 에이전트가 생각 중일 때 텔레그램에 '타이핑 중...' 상태 표시
  public async setTyping(jid: string, typing: boolean): Promise<void> {
    if (!typing) return; // 텔레그램은 타이핑 상태가 자동 만료되므로 cancel 구현 불필요
    try {
      await this.bot.sendChatAction(jid, 'typing');
    } catch (error) {
      logger.warn({ jid, error }, 'Telegram 타이핑 인디케이터 설정 실패');
    }
  }

  public async syncGroupMetadata(force: boolean): Promise<void> {
    // 그룹 메타데이터 강제 동기화 로직 (필요시 구현)
    logger.debug('Telegram syncGroupMetadata 호출됨');
  }
}
