import Database from 'better-sqlite3';
import path from 'path';

// 🚨 여기에 1단계에서 확인한 본인의 텔레그램 ID(숫자)를 적으세요!
const myChatId = "123456789"; 

const db = new Database(path.join(process.cwd(), 'data', 'messages.db'));

try {
  db.prepare(`
    INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger, added_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(myChatId, 'Master', 'main', new Date().toISOString());
  
  console.log(`✅ 텔레그램 채팅방 [${myChatId}] VIP 화이트리스트 등록 완료!`);
} catch (err) {
  console.error("❌ 등록 실패:", err.message);
}
