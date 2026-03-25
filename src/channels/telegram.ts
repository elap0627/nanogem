import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../logger.js';
import { NewMessage, RegisteredGroup } from '../types.js';

export interface ChannelOpts {
  onMessage: (chatJid: string, msg: NewMessage) => void;
  onChatMetadata: (chatJid: string, timestamp: string, name?: string, channelName?: string, isGroup?: boolean) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel {
  public name = 'telegram'; // 추가됨: 메인 라우터 인터페이스 호환용
  private bot: TelegramBot;
  private opts: ChannelOpts;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN 환경 변수가 누락되었습니다.');
    }
    this.bot = new TelegramBot(token, { polling: false });
  }

  public async connect(): Promise<void> {
    logger.info('Telegram Bot API 연결을 시작합니다...');

    this.bot.on('message', (msg: any) => { // any 타입 추가
      if (!msg.text) return; 

      const chatJid = msg.chat.id.toString();
      const senderJid = msg.from?.id.toString() || 'unknown';
      const senderName = msg.from?.username || msg.from?.first_name || 'User';
      const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
      const chatName = msg.chat.title || senderName;
      const timestamp = new Date(msg.date * 1000).toISOString();

      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);

      const newMessage: any = { // any 타입 추가
        chat_jid: chatJid,
        sender_jid: senderJid,
        sender_name: senderName,
        timestamp: timestamp,
        content: msg.text,
        message_id: msg.message_id.toString(),
        from_me: false,
      };

      this.opts.onMessage(chatJid, newMessage);
    });

    this.bot.on('polling_error', (error: any) => { // any 타입 추가
      logger.error({ err: error }, 'Telegram Polling 오류 발생');
    });

    await this.bot.startPolling();
    logger.info('✅ Telegram Bot 연결 완료 및 수신 대기 중');
  }

  public async disconnect(): Promise<void> {
    logger.info('Telegram Bot 연결을 해제합니다...');
    await this.bot.stopPolling();
  }

  public ownsJid(jid: string): boolean {
    return /^-?\d+$/.test(jid);
  }

  public isConnected(): boolean {
    return this.bot.isPolling();
  }

  public async sendMessage(jid: string, text: string): Promise<void> {
    try {
      await this.bot.sendMessage(jid, text, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error({ jid, error }, 'Telegram 메시지 전송 실패');
    }
  }

  public async setTyping(jid: string, typing: boolean): Promise<void> {
    if (!typing) return;
    try {
      await this.bot.sendChatAction(jid, 'typing');
    } catch (error) {
      logger.warn({ jid, error }, 'Telegram 타이핑 설정 실패');
    }
  }

  public async syncGroupMetadata(force: boolean): Promise<void> {
    logger.debug('Telegram syncGroupMetadata 호출됨');
  }
}
